'use strict';
/**
 * ModuleService — which optional modules are switched on, and the adoption
 * stage that decides them.
 *
 * Resolution, in order:
 *   1. V2_FEATURES=1 in the environment (legacy) → every staged module is ON,
 *      whatever the database says. Kept for backward compatibility: an install
 *      configured with the old flag keeps everything it had.
 *   2. `adoption.stage` = 1 | 2 | 3 → the stage preset (src/config/modules.js).
 *   3. `adoption.stage` = custom → each `modules.<name>` switch.
 *   No stored stage → stage 1 (fresh install) or stage 3 (V2_FEATURES=1).
 * `localContent` is never forced by the stage or by V2_FEATURES: it keeps its
 * own switch (`featureLocalContent`), as before.
 *
 * Settings reads go through AppSettingsModel.getValue (TTL-cached); every
 * AppSettingsModel.setValue busts that cache, so a change made on
 * /admin/modules applies on the next request — no restart.
 */
const AppSettingsModel = require('../models/AppSettingsModel');
const M = require('../config/modules');

/** Same parse as AppSettingsModel.toBool: only true/1/'true'/'1'/'on'/'yes' are ON
 *  (never truthiness — the string 'false' must read OFF). */
function truthy(v) {
    if (typeof v === 'string') return ['true', '1', 'on', 'yes'].includes(v.trim().toLowerCase());
    return v === true || v === 1;
}

/** True when the legacy environment flag forces every module on. */
function legacyForced() {
    return process.env.V2_FEATURES === '1';
}

/** A valid stage string, or null. */
function normStage(v) {
    const s = v == null ? '' : String(v).trim().toLowerCase();
    return M.STAGES.includes(s) ? s : null;
}

/** Stage preset → { module: boolean } for the staged modules. */
function presetFor(stage) {
    const on = M.PRESETS[stage] || M.PRESETS[M.DEFAULT_STAGE];
    const out = {};
    for (const k of M.STAGED_MODULES) out[k] = on.includes(k);
    return out;
}

/** The state before any database read: what the environment alone implies. */
function envDefaults() {
    const legacy = legacyForced();
    const configured = { ...presetFor(M.DEFAULT_STAGE), localContent: false };
    const modules = { ...configured };
    if (legacy) for (const k of M.STAGED_MODULES) modules[k] = true;
    return {
        stage: legacy ? M.LEGACY_STAGE : M.DEFAULT_STAGE,
        stored: false,
        legacy,
        modules,
        configured,
    };
}

let _snapshot = envDefaults();

class ModuleService {
    constructor() {
        this.M = M;
    }

    legacyForced() {
        return legacyForced();
    }

    presetFor(stage) {
        return presetFor(normStage(stage) || M.DEFAULT_STAGE);
    }

    normStage(v) {
        return normStage(v);
    }

    /**
     * The effective state: { stage, stored, legacy, modules }. `stored` says
     * whether an administrator (or the upgrade step) has recorded a stage.
     * Never throws — an unreadable database falls back to the environment.
     */
    async resolve() {
        let state;
        try {
            const raw = await AppSettingsModel.getValue(M.STAGE_KEY, null);
            const storedStage = normStage(raw);
            const legacy = legacyForced();
            // `configured`: what the database says — what applies once the
            // legacy variable is gone. `modules`: what applies now.
            const configuredStage = storedStage || M.DEFAULT_STAGE;
            let configured;
            if (configuredStage === 'custom') {
                const base = presetFor(M.DEFAULT_STAGE);
                configured = {};
                for (const k of M.STAGED_MODULES) {
                    const v = await AppSettingsModel.getValue(M.SETTING_KEYS[k], null);
                    configured[k] = v == null ? base[k] : truthy(v);
                }
            } else {
                configured = presetFor(configuredStage);
            }
            const lc = await AppSettingsModel.getValue(M.SETTING_KEYS.localContent, false);
            configured.localContent = truthy(lc);
            const modules = { ...configured };
            if (legacy) for (const k of M.STAGED_MODULES) modules[k] = true;
            const stage = storedStage || (legacy ? M.LEGACY_STAGE : M.DEFAULT_STAGE);
            state = { stage, stored: Boolean(storedStage), legacy, modules, configured };
        } catch (_) {
            state = envDefaults();
        }
        _snapshot = state;
        return state;
    }

    /** { module: boolean } — the flags the views and the sidebar read. */
    async flags() {
        return (await this.resolve()).modules;
    }

    async isOn(key) {
        const s = await this.resolve();
        return Boolean(s.modules[key]);
    }

    /**
     * Synchronous read of the last resolved state (refreshed on every request
     * by server.js). For synchronous callers such as the companion's
     * knowledge filter; the legacy flag is honoured directly.
     */
    isOnSync(key) {
        if (legacyForced() && M.STAGED_MODULES.includes(key)) return true;
        return Boolean(_snapshot.configured[key]);
    }

    snapshot() {
        return {
            ..._snapshot,
            modules: { ..._snapshot.modules },
            configured: { ..._snapshot.configured },
        };
    }

    /**
     * Express middleware: the request goes on while ANY of `keys` is on;
     * otherwise it gets the app's normal 404 — the page simply does not exist
     * for this organisation. Read per request, so a switch needs no restart.
     */
    requireModule(...keys) {
        const { notFoundHandler } = require('../middleware/errorHandler');
        // Named, and tagged with its modules, so the route tree can be audited
        // (tests: no core route ever carries a moduleGuard).
        const moduleGuard = async (req, res, next) => {
            try {
                const s = await this.resolve();
                if (keys.some((k) => s.modules[k])) return next();
            } catch (_) {
                return next();
            }
            return notFoundHandler(req, res);
        };
        moduleGuard.modules = keys;
        return moduleGuard;
    }

    /** Guard for the /v2/cap router: each sub-path belongs to one module. */
    capGuard() {
        const { notFoundHandler } = require('../middleware/errorHandler');
        const moduleGuard = async (req, res, next) => {
            let s;
            try {
                s = await this.resolve();
            } catch (_) {
                return next();
            }
            const p = req.path || '/';
            if (p === '/' || p === '') {
                return M.CAP_HUB_MODULES.some((k) => s.modules[k])
                    ? next()
                    : notFoundHandler(req, res);
            }
            const hit = M.CAP_PATHS.find(([prefix]) => p.startsWith(prefix));
            if (!hit || s.modules[hit[1]]) return next();
            return notFoundHandler(req, res);
        };
        moduleGuard.modules = M.CAP_HUB_MODULES;
        moduleGuard.capPaths = M.CAP_PATHS;
        return moduleGuard;
    }

    /**
     * Save a stage (and, for `custom`, the switches). Writes every staged
     * module's effective value too, so switching to `custom` later starts from
     * what the organisation has now. Returns { before, after } states.
     */
    async save({ stage, toggles = {}, localContent, actorId = null }) {
        const st = normStage(stage);
        if (!st) throw new Error('invalid stage');
        const before = await this.resolve();
        const values = st === 'custom' ? {} : presetFor(st);
        if (st === 'custom') {
            for (const k of M.STAGED_MODULES) values[k] = truthy(toggles[k]);
        }
        await AppSettingsModel.setValue(
            M.STAGE_KEY,
            st,
            'string',
            'Adoption stage: 1, 2, 3 or custom (Administration → Modules)',
            'adoption',
            actorId
        );
        for (const k of M.STAGED_MODULES) {
            await AppSettingsModel.setValue(
                M.SETTING_KEYS[k],
                values[k] ? 'true' : 'false',
                'boolean',
                `Optional module "${k}" (Administration → Modules)`,
                'adoption',
                actorId
            );
        }
        if (localContent !== undefined) {
            const existing = await AppSettingsModel.findByKey(M.SETTING_KEYS.localContent);
            await AppSettingsModel.setValue(
                M.SETTING_KEYS.localContent,
                truthy(localContent) ? 'true' : 'false',
                'boolean',
                (existing && existing.description) || 'Enable the local-content module',
                (existing && existing.category) || 'general',
                actorId
            );
        }
        const after = await this.resolve();
        return { before, after };
    }

    /**
     * Upgrade step, run once at boot: an install started with V2_FEATURES=1
     * and no recorded stage is recorded at stage 3, so removing the variable
     * later does not take anything away. A fresh install records nothing (it
     * reads as stage 1 until an administrator chooses).
     */
    async ensureLegacyStage() {
        if (!legacyForced()) return false;
        const row = await AppSettingsModel.findByKey(M.STAGE_KEY);
        if (row) return false;
        await AppSettingsModel.setValue(
            M.STAGE_KEY,
            M.LEGACY_STAGE,
            'string',
            'Adoption stage: 1, 2, 3 or custom (Administration → Modules)',
            'adoption',
            null
        );
        await this.resolve();
        return true;
    }

    /** Menu entries that appear / disappear between two module maps. */
    impact(beforeModules, afterModules) {
        const menus = (mods) => {
            const set = new Set();
            for (const k of M.MODULE_KEYS)
                if (mods[k]) M.MODULE_MENUS[k].forEach((x) => set.add(x));
            return set;
        };
        const b = menus(beforeModules || {});
        const a = menus(afterModules || {});
        return {
            appear: [...a].filter((x) => !b.has(x)),
            disappear: [...b].filter((x) => !a.has(x)),
        };
    }

    /** Test helper: reset the synchronous snapshot to the environment defaults. */
    _resetSnapshot() {
        _snapshot = envDefaults();
    }
}

module.exports = new ModuleService();
