'use strict';

/**
 * HrisSyncService — HRIS synchronisation (connectors in src/integrations/hris).
 *
 *   configure ─ one row per connector (hris_connectors); credentials are
 *               secretBox ciphertext, write-only (never read back to a page);
 *   dry run  ── fetch → normalise → map → PLAN (joiners, movers, leavers,
 *               unmapped values, errors). Stored in hris_sync_runs with the
 *               normalised records, so what was reviewed is what is applied;
 *   apply ───── recompute the plan from the stored records against the
 *               database as it is NOW, re-check the mass-leaver guard, then
 *               apply through the existing paths: employee creation with the
 *               placement rules of the employee form, LifecycleService for
 *               joiners / movers, LifecycleService.deprovision for leavers
 *               (accounts, sessions, linked admin accounts and API keys);
 *   idempotent  hris_links pins external id ↔ employee: a second apply of the
 *               same export changes nothing;
 *   logged ──── every run is a row (counts, errors, trigger, actor) and every
 *               action an audit entry (LogService).
 *
 * The planner (mapping + plan + guard) is pure: src/integrations/hris/planner.js.
 */
const db = require('../config/database');
const secretBox = require('../utils/secretBox');
const hris = require('../integrations/hris');
const planner = require('../integrations/hris/planner');

const PROVIDERS = ['csv', 'personio', 'lucca'];
const CREDENTIAL_KEYS = {
    csv: [],
    personio: ['client_id', 'client_secret'],
    lucca: ['api_key'],
};
const MAPPING_KINDS = ['site', 'department', 'service', 'role'];
/** A dry run older than this cannot be applied: run it again. */
const PLAN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SYSTEM_ACTOR = { userType: 'admin', role: 'superadmin', id: null };

function code(c, message, status = 400) {
    const e = new Error(message || c);
    e.code = c;
    e.status = status;
    return e;
}

async function audit(action, details, { actorRef = null, entityId = null, severity } = {}) {
    try {
        await require('./LogService').log({
            action,
            entityType: 'hris_sync',
            entityId,
            details,
            actorRef,
            ...(severity ? { severity } : {}),
        });
    } catch (_) {
        /* audit is best effort, never blocks a sync */
    }
}

function parseJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch {
        return fallback;
    }
}

class HrisSyncService {
    // ------------------------------------------------------------------
    // connectors
    // ------------------------------------------------------------------

    static providers() {
        return PROVIDERS.slice();
    }

    static credentialKeys(provider) {
        return (CREDENTIAL_KEYS[provider] || []).slice();
    }

    static async getRow(provider) {
        return db.get('SELECT * FROM hris_connectors WHERE provider = ?', [provider]);
    }

    static async enabledRow() {
        return db.get('SELECT * FROM hris_connectors WHERE enabled = true LIMIT 1');
    }

    /** Page-safe shape: never the credentials, only which keys are stored. */
    static mask(row, provider) {
        const p = (row && row.provider) || provider;
        const creds = row ? this.decryptCredentials(row) : {};
        const stored = {};
        for (const k of CREDENTIAL_KEYS[p] || []) stored[k] = Boolean(creds[k]);
        return {
            provider: p,
            exists: Boolean(row),
            enabled: Boolean(row && row.enabled),
            autoApply: Boolean(row && row.autoApply),
            leaverGuardPct: row ? Number(row.leaverGuardPct) : 10,
            scheduleHour: row ? Number(row.scheduleHour) : 2,
            config: row ? parseJson(row.config, {}) : {},
            credentialsStored: stored,
            lastSuccessAt: row ? row.lastSuccessAt || null : null,
            lastScheduledOn: row ? row.lastScheduledOn || null : null,
            updatedAt: row ? row.updatedAt || null : null,
        };
    }

    static decryptCredentials(row) {
        if (!row || !row.credentials) return {};
        try {
            return parseJson(secretBox.decrypt(row.credentials), {}) || {};
        } catch (_) {
            return {}; // key rotated / wrong APP_KEY: treated as not configured
        }
    }

    static cleanConfig(provider, input = {}) {
        const cfg = {};
        const s = (v, max = 500) =>
            v == null || String(v).trim() === '' ? undefined : String(v).trim().slice(0, max);
        if (provider === 'csv') {
            cfg.folder_path = s(input.folder_path, 1000);
            cfg.delimiter = ['auto', ',', ';', 'tab', '|'].includes(input.delimiter)
                ? input.delimiter
                : 'auto';
            const cols = {};
            for (const f of Object.keys(hris.REGISTRY.csv.DEFAULT_COLUMNS)) {
                const v = s(input.columns && input.columns[f], 120);
                if (v) cols[f] = v;
            }
            cfg.columns = cols;
        } else {
            cfg.base_url = s(input.base_url, 300);
            if (cfg.base_url) require('../integrations/hris/http').assertSafeHrisUrl(cfg.base_url);
            if (provider === 'personio') {
                const at = {};
                for (const f of Object.keys(hris.REGISTRY.personio.DEFAULT_ATTRIBUTES)) {
                    const v = s(input.attributes && input.attributes[f], 120);
                    if (v) at[f] = v;
                }
                cfg.attributes = at;
            }
            if (provider === 'lucca') {
                cfg.site_source =
                    input.site_source === 'establishment' ? 'establishment' : 'legal_entity';
            }
        }
        const mode = input.mode === 'delta' ? 'delta' : 'full';
        cfg.mode = mode;
        cfg.match_by_name = !(input.match_by_name === false || input.match_by_name === 'false');
        return JSON.parse(JSON.stringify(cfg)); // drop undefined
    }

    /**
     * Save a connector. Credentials: only NON-EMPTY values overwrite (the form
     * never shows them back, so an empty box means "keep"). Enabling one
     * connector disables the others.
     */
    static async saveConnector(provider, input = {}, { actorRef = null } = {}) {
        if (!PROVIDERS.includes(provider)) throw code('hris_unknown_provider');
        const config = this.cleanConfig(provider, input.config || {});
        const pct = Number(input.leaverGuardPct);
        const guard = Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : 10;
        const hour = Number.isInteger(Number(input.scheduleHour))
            ? Math.min(23, Math.max(0, Number(input.scheduleHour)))
            : 2;
        const enabled =
            input.enabled === true || input.enabled === 'true' || input.enabled === 'on';
        const autoApply =
            input.autoApply === true || input.autoApply === 'true' || input.autoApply === 'on';

        const existing = await this.getRow(provider);
        const creds = this.decryptCredentials(existing);
        const changedKeys = [];
        for (const k of CREDENTIAL_KEYS[provider]) {
            const v = input.credentials && input.credentials[k];
            if (v != null && String(v).trim() !== '') {
                creds[k] = String(v).trim();
                changedKeys.push(k);
            }
        }
        const encrypted = Object.keys(creds).length
            ? secretBox.encrypt(JSON.stringify(creds))
            : null;

        await db.runTransaction(async () => {
            if (enabled)
                await db.run(
                    'UPDATE hris_connectors SET enabled = false, updated_at = now() WHERE provider <> ? AND enabled = true',
                    [provider]
                );
            await db.run(
                `INSERT INTO hris_connectors (provider, enabled, config, credentials, auto_apply,
                                              leaver_guard_pct, schedule_hour, updated_by)
                 VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?)
                 ON CONFLICT (provider) DO UPDATE SET
                    enabled = EXCLUDED.enabled, config = EXCLUDED.config,
                    credentials = EXCLUDED.credentials, auto_apply = EXCLUDED.auto_apply,
                    leaver_guard_pct = EXCLUDED.leaver_guard_pct,
                    schedule_hour = EXCLUDED.schedule_hour, updated_by = EXCLUDED.updated_by,
                    updated_at = now()`,
                [
                    provider,
                    enabled,
                    JSON.stringify(config),
                    encrypted,
                    autoApply,
                    guard,
                    hour,
                    actorRef,
                ]
            );
        });
        await audit(
            'HRIS_CONNECTOR_SAVED',
            `HRIS connector ${provider} saved: enabled=${enabled}, autoApply=${autoApply}, guard=${guard}%, hour=${hour}, mode=${config.mode}` +
                (changedKeys.length ? `; credentials updated (${changedKeys.join(', ')})` : ''),
            { actorRef }
        );
        return { changedCredentials: changedKeys };
    }

    static async connectorFor(provider, opts = {}) {
        const row = await this.getRow(provider);
        if (!row) throw code('hris_not_configured', 'This connector is not configured');
        const config = parseJson(row.config, {});
        return {
            row,
            config,
            connector: hris.getConnector(provider, config, this.decryptCredentials(row), opts),
        };
    }

    static async testConnection(provider, { actorRef = null, opts = {} } = {}) {
        let out;
        try {
            const { connector } = await this.connectorFor(provider, opts);
            out = await connector.testConnection();
        } catch (e) {
            out = { ok: false, error: e.message, code: e.code || null };
        }
        await audit(
            'HRIS_CONNECTION_TESTED',
            `HRIS ${provider} connection test: ${out.ok ? 'ok' : 'failed'}${out.ok ? '' : ' — ' + String(out.error || '').slice(0, 200)}`,
            { actorRef, severity: out.ok ? 'info' : 'warn' }
        );
        return out;
    }

    // ------------------------------------------------------------------
    // value mappings
    // ------------------------------------------------------------------

    static async listMappings() {
        return db.all(
            `SELECT m.id, m.kind, m.external_value, m.target_id, m.created_at,
                    COALESCE(s.name, d.name, sv.name, r.name) AS target_name,
                    ds.name AS target_site_name, dd.name AS target_department_name
               FROM hris_value_mappings m
               LEFT JOIN sites s ON m.kind = 'site' AND s.id = m.target_id
               LEFT JOIN departments d ON m.kind = 'department' AND d.id = m.target_id
               LEFT JOIN services sv ON m.kind = 'service' AND sv.id = m.target_id
               LEFT JOIN departments dd ON m.kind = 'service' AND dd.id = sv.department_id
               LEFT JOIN sites ds ON ds.id = COALESCE(d.site_id, dd.site_id)
               LEFT JOIN roles r ON m.kind = 'role' AND r.id = m.target_id
              ORDER BY m.kind, lower(m.external_value)`
        );
    }

    static async addMapping(kind, externalValue, targetId, { actorRef = null } = {}) {
        if (!MAPPING_KINDS.includes(kind)) throw code('hris_bad_mapping_kind');
        const value = String(externalValue == null ? '' : externalValue)
            .trim()
            .slice(0, 300);
        if (!value) throw code('hris_mapping_value_required');
        const id = Number(targetId);
        const table = {
            site: 'sites',
            department: 'departments',
            service: 'services',
            role: 'roles',
        }[kind];
        const target =
            Number.isInteger(id) && id > 0
                ? await db.get(`SELECT id, name FROM ${table} WHERE id = ? AND is_active = true`, [
                      id,
                  ])
                : null;
        if (!target) throw code('hris_mapping_target_invalid');
        await db.run(
            `INSERT INTO hris_value_mappings (kind, external_value, external_key, target_id, created_by)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (kind, external_key) DO UPDATE SET
                external_value = EXCLUDED.external_value, target_id = EXCLUDED.target_id,
                created_by = EXCLUDED.created_by, created_at = now()`,
            [kind, value, planner.norm(value), id, actorRef]
        );
        await audit(
            'HRIS_MAPPING_SAVED',
            `HRIS mapping ${kind} "${value}" → #${id} (${target.name})`,
            {
                actorRef,
            }
        );
        return { kind, value, targetId: id };
    }

    static async deleteMapping(id, { actorRef = null } = {}) {
        const row = await db.get('SELECT * FROM hris_value_mappings WHERE id = ?', [Number(id)]);
        if (!row) return false;
        await db.run('DELETE FROM hris_value_mappings WHERE id = ?', [Number(id)]);
        await audit(
            'HRIS_MAPPING_DELETED',
            `HRIS mapping ${row.kind} "${row.externalValue}" → #${row.targetId} removed`,
            { actorRef }
        );
        return true;
    }

    // ------------------------------------------------------------------
    // context + plan
    // ------------------------------------------------------------------

    static async loadContext(provider, options = {}) {
        const [sites, departments, services, roles, mappings, employees, links] = await Promise.all(
            [
                db.all('SELECT id, name, code, is_active FROM sites'),
                db.all('SELECT id, site_id, name, code, is_active FROM departments'),
                db.all('SELECT id, department_id, name, code, is_active FROM services'),
                db.all('SELECT id, name, is_active FROM roles'),
                db.all(
                    'SELECT kind, external_value, external_key, target_id FROM hris_value_mappings'
                ),
                db.all(
                    `SELECT id, employee_number, first_name, last_name, email, site_id, department_id,
                        service_id, role_id, supervisor_id, is_active, cancelled_at, erased_at
                   FROM employees`
                ),
                db.all('SELECT external_id, employee_id FROM hris_links WHERE provider = ?', [
                    provider,
                ]),
            ]
        );
        return planner.buildContext({
            provider,
            sites,
            departments,
            services,
            roles,
            mappings,
            employees,
            links,
            options,
        });
    }

    static planOptions(row, config, now = new Date()) {
        return {
            mode: config.mode === 'delta' ? 'delta' : 'full',
            matchByName: config.match_by_name !== false,
            guardPct: row ? Number(row.leaverGuardPct) || 10 : 10,
            now,
        };
    }

    /** Trim a plan for storage/display (names and ids only, bounded lists). */
    static summarisePlan(plan) {
        const cap = (l) => (l || []).slice(0, 2000);
        return {
            counts: plan.counts,
            guard: plan.guard,
            joiners: cap(plan.joiners),
            movers: cap(plan.movers),
            updates: cap(plan.updates),
            leavers: cap(plan.leavers),
            links: cap(plan.links),
            blocked: cap(plan.blocked),
            upcoming: cap(plan.upcoming),
            review: cap(plan.review),
            unmapped: cap(plan.unmapped),
            errors: cap(plan.errors),
        };
    }

    /**
     * DRY RUN: fetch (or take the uploaded records), compute and store the
     * plan. Never writes to employees. Returns the run row id and the plan.
     */
    static async dryRun(
        provider,
        {
            trigger = 'manual',
            actorRef = null,
            text = null,
            fileName = null,
            opts = {},
            now = new Date(),
        } = {}
    ) {
        if (!PROVIDERS.includes(provider)) throw code('hris_unknown_provider');
        const row = await this.getRow(provider);
        const config = row ? parseJson(row.config, {}) : {};
        if (!row && !(provider === 'csv' && text != null))
            throw code('hris_not_configured', 'This connector is not configured');

        const run = await db.get(
            `INSERT INTO hris_sync_runs (provider, mode, status, trigger, actor_ref, source_label)
             VALUES (?, 'dry_run', 'running', ?, ?, ?) RETURNING id`,
            [provider, trigger, actorRef, fileName ? String(fileName).slice(0, 200) : null]
        );
        const runId = Number(run.id);
        let records;
        let sourceLabel = fileName || null;
        try {
            const connector = hris.getConnector(provider, config, this.decryptCredentials(row), {
                ...opts,
                text,
                fileName,
                now,
            });
            records = await connector.listPeople({ since: null });
            sourceLabel = connector.sourceLabel || sourceLabel || provider;
        } catch (e) {
            await db.run(
                `UPDATE hris_sync_runs SET status = 'failed', finished_at = now(),
                        errors = ?::jsonb, source_label = COALESCE(source_label, ?) WHERE id = ?`,
                [
                    JSON.stringify([
                        {
                            code: e.code || 'hris_fetch_failed',
                            message: String(e.message).slice(0, 300),
                        },
                    ]),
                    sourceLabel,
                    runId,
                ]
            );
            await audit(
                'HRIS_SYNC_FAILED',
                `HRIS ${provider} run #${runId} failed to fetch: ${String(e.message).slice(0, 200)}`,
                {
                    actorRef,
                    entityId: runId,
                    severity: 'warn',
                }
            );
            return {
                runId,
                status: 'failed',
                error: e.message,
                code: e.code || 'hris_fetch_failed',
            };
        }

        const ctx = await this.loadContext(provider, this.planOptions(row, config, now));
        const plan = planner.computePlan(records, ctx);
        const status = plan.guard.tripped ? 'aborted' : 'planned';
        // Older plans of this provider can no longer be applied: one reviewable plan at a time.
        await db.run(
            `UPDATE hris_sync_runs SET status = 'superseded', records = NULL
              WHERE provider = ? AND status = 'planned' AND id <> ?`,
            [provider, runId]
        );
        await db.run(
            `UPDATE hris_sync_runs SET status = ?, finished_at = now(), counts = ?::jsonb,
                    plan = ?::jsonb, records = ?::jsonb, errors = ?::jsonb, source_label = ?
              WHERE id = ?`,
            [
                status,
                JSON.stringify(plan.counts),
                JSON.stringify(this.summarisePlan(plan)),
                status === 'planned' ? JSON.stringify(records) : null,
                JSON.stringify(plan.errors.slice(0, 500)),
                sourceLabel,
                runId,
            ]
        );
        await audit(
            plan.guard.tripped ? 'HRIS_SYNC_ABORTED' : 'HRIS_SYNC_DRY_RUN',
            `HRIS ${provider} dry run #${runId} (${trigger}): ` +
                `${plan.counts.joiners} joiners, ${plan.counts.movers} movers, ${plan.counts.leavers} leavers, ` +
                `${plan.counts.unmapped} unmapped values, ${plan.counts.errors} errors` +
                (plan.guard.tripped
                    ? ` — GUARD TRIPPED (${plan.guard.reason}: ${plan.guard.pct}% > ${plan.guard.limitPct}%)`
                    : ''),
            { actorRef, entityId: runId, severity: plan.guard.tripped ? 'warn' : 'info' }
        );
        return { runId, status, plan };
    }

    static async listRuns(limit = 20) {
        return db.all(
            `SELECT id, provider, mode, status, trigger, actor_ref, source_label, started_at,
                    finished_at, counts, errors, applied_from
               FROM hris_sync_runs ORDER BY id DESC LIMIT ?`,
            [Math.min(200, Math.max(1, Number(limit) || 20))]
        );
    }

    static async getRun(id) {
        const r = await db.get(
            `SELECT id, provider, mode, status, trigger, actor_ref, source_label, started_at,
                    finished_at, counts, plan, errors, applied_from,
                    (records IS NOT NULL) AS has_records
               FROM hris_sync_runs WHERE id = ?`,
            [Number(id)]
        );
        return r || null;
    }

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------

    /**
     * Apply a PLANNED dry run. The plan is recomputed from the stored records
     * (the database may have moved since the review) and the guard re-checked.
     */
    static async apply(runId, { actorRef = null, trigger = 'manual', now = new Date() } = {}) {
        const src = await db.get('SELECT * FROM hris_sync_runs WHERE id = ?', [Number(runId)]);
        if (!src) throw code('hris_run_not_found', 'Run not found', 404);
        if (src.status !== 'planned' || src.records == null)
            throw code('hris_run_not_applicable', 'Only a planned dry run can be applied', 409);
        if (now.getTime() - new Date(src.startedAt).getTime() > PLAN_MAX_AGE_MS)
            throw code('hris_run_too_old', 'This dry run is too old: run it again', 409);

        const provider = src.provider;
        const row = await this.getRow(provider);
        const config = row ? parseJson(row.config, {}) : {};
        const records = parseJson(src.records, []);
        const ctx = await this.loadContext(provider, this.planOptions(row, config, now));
        const plan = planner.computePlan(records, ctx);

        // Claim the dry run: two clicks, two schedulers → one apply.
        const claim = await db.run(
            `UPDATE hris_sync_runs SET status = 'applied', records = NULL
              WHERE id = ? AND status = 'planned'`,
            [Number(runId)]
        );
        if (!claim || !claim.changes)
            throw code('hris_run_not_applicable', 'Only a planned dry run can be applied', 409);

        const applyRow = await db.get(
            `INSERT INTO hris_sync_runs (provider, mode, status, trigger, actor_ref, source_label, applied_from, plan)
             VALUES (?, 'apply', 'running', ?, ?, ?, ?, ?::jsonb) RETURNING id`,
            [
                provider,
                trigger,
                actorRef,
                src.sourceLabel,
                Number(runId),
                JSON.stringify(this.summarisePlan(plan)),
            ]
        );
        const applyId = Number(applyRow.id);

        if (plan.guard.tripped) {
            await db.run(
                `UPDATE hris_sync_runs SET status = 'aborted', finished_at = now(), counts = ?::jsonb,
                        errors = ?::jsonb WHERE id = ?`,
                [
                    JSON.stringify(plan.counts),
                    JSON.stringify([{ code: 'hris_guard_tripped', message: plan.guard.reason }]),
                    applyId,
                ]
            );
            await audit(
                'HRIS_SYNC_ABORTED',
                `HRIS ${provider} apply #${applyId} aborted by the mass-leaver guard (${plan.guard.reason}: ${plan.guard.leavers}/${plan.guard.population} = ${plan.guard.pct}% > ${plan.guard.limitPct}%)`,
                { actorRef, entityId: applyId, severity: 'warn' }
            );
            await this.alert('ops.hris_sync_alert', `hris-abort:${applyId}`, provider);
            return { runId: applyId, status: 'aborted', guard: plan.guard, counts: plan.counts };
        }

        const result = await this.applyPlan(plan, { provider, actorRef });
        const status = result.errors.length && !result.appliedTotal ? 'failed' : 'applied';
        await db.run(
            `UPDATE hris_sync_runs SET status = ?, finished_at = now(), counts = ?::jsonb,
                    errors = ?::jsonb WHERE id = ?`,
            [
                status,
                JSON.stringify({ ...plan.counts, applied: result.applied }),
                JSON.stringify([...plan.errors, ...result.errors].slice(0, 500)),
                applyId,
            ]
        );
        if (row)
            await db.run('UPDATE hris_connectors SET last_success_at = now() WHERE id = ?', [
                row.id,
            ]);
        await audit(
            'HRIS_SYNC_APPLIED',
            `HRIS ${provider} apply #${applyId} (from dry run #${runId}, ${trigger}): ` +
                `${result.applied.joiners} joiners created, ${result.applied.movers} movers, ` +
                `${result.applied.updates} updates, ${result.applied.leavers} leavers, ` +
                `${result.applied.links} links, ${result.errors.length} errors`,
            { actorRef, entityId: applyId, severity: result.errors.length ? 'warn' : 'info' }
        );
        return { runId: applyId, status, applied: result.applied, errors: result.errors };
    }

    /** One person's writes, isolated: a failure rolls back that person only. */
    static async _isolated(actorRef, fn) {
        return db.withActor(actorRef || 'system:hris', () => db.runInSavepoint(fn));
    }

    static async _usernameTaken(u) {
        const r = await db.get(
            `SELECT 1 AS x FROM employees WHERE lower(username::text) = lower(?)
              UNION ALL SELECT 1 FROM admins WHERE lower(username::text) = lower(?) LIMIT 1`,
            [u, u]
        );
        return Boolean(r);
    }

    static async _validSupervisor(employeeId, supervisorId) {
        if (!supervisorId || Number(supervisorId) === Number(employeeId)) return false;
        const EmployeeModel = require('../models/EmployeeModel');
        const s = await db.get('SELECT id, is_active, cancelled_at FROM employees WHERE id = ?', [
            Number(supervisorId),
        ]);
        if (!s || !s.isActive || s.cancelledAt) return false;
        if (employeeId && (await EmployeeModel.wouldCreateReportingCycle(employeeId, supervisorId)))
            return false;
        return true;
    }

    /**
     * Create ONE employee from a joiner item — the employee-form rules: nested
     * placement (service → department → site), seat limit, unique employee
     * number, unique username (employees AND admins), active supervisor.
     * Used by apply and by SCIM placement. Returns the new employee id.
     */
    static async createJoiner(j, { provider, actorRef, source = 'hris' }) {
        const { destinationPlacementError } = require('../controllers/EmployeeController');
        const EmployeeModel = require('../models/EmployeeModel');
        const { baseUsername, uniqueUsername } = require('../utils/credentialGenerator');

        const seat = await require('./EntitlementService').canAddEmployee();
        if (!seat.ok) throw code('seat_limit');
        const placeErr = await destinationPlacementError(SYSTEM_ACTOR, j, null);
        if (placeErr) throw code('placement_inconsistent');
        let employeeNumber = j.employeeNumber
            ? String(j.employeeNumber).slice(0, 60)
            : `HRIS-${String(j.externalId).slice(0, 50)}`;
        if (await EmployeeModel.findByEmployeeNumber(employeeNumber)) {
            if (j.employeeNumber) throw code('employee_number_taken');
            employeeNumber = `${employeeNumber}-${provider}`;
            if (await EmployeeModel.findByEmployeeNumber(employeeNumber))
                throw code('employee_number_taken');
        }
        const username = await uniqueUsername(
            baseUsername({ firstName: j.firstName, lastName: j.lastName, employeeNumber }),
            (u) => this._usernameTaken(u)
        );
        const supervisorId =
            j.supervisorId && (await this._validSupervisor(null, j.supervisorId))
                ? Number(j.supervisorId)
                : null;
        const emp = await EmployeeModel.create({
            employeeNumber,
            firstName: String(j.firstName).slice(0, 120),
            lastName: String(j.lastName).slice(0, 120),
            email: j.email || null,
            siteId: Number(j.siteId),
            departmentId: Number(j.departmentId),
            serviceId: Number(j.serviceId),
            roleId: Number(j.roleId),
            supervisorId,
            username,
            passwordHash: null, // signs in through SSO or an invitation
            isAccountActive: true,
            isActive: true,
            forcePasswordChange: false,
        });
        const id = Number(emp.id);
        if (j.externalId)
            await db.run(
                `INSERT INTO hris_links (provider, external_id, employee_id, last_seen_at)
                 VALUES (?, ?, ?, now())
                 ON CONFLICT (provider, external_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, last_seen_at = now()`,
                [provider, String(j.externalId), id]
            );
        await require('./LifecycleService').record('joiner', id, {
            payload: { source, provider },
            actorRef,
        });
        await audit(
            'HRIS_JOINER_CREATED',
            `Employee #${id} (${employeeNumber}) created from ${provider} ${j.externalId || ''}`.trim(),
            { actorRef, entityId: id }
        );
        return id;
    }

    static async applyPlan(plan, { provider, actorRef }) {
        const EmployeeModel = require('../models/EmployeeModel');
        const Lifecycle = require('./LifecycleService');
        const applied = { joiners: 0, movers: 0, updates: 0, leavers: 0, links: 0 };
        const errors = [];
        const fail = (item, e) =>
            errors.push({
                externalId: item.externalId,
                employeeId: item.employeeId || null,
                name: item.name,
                code: (e && e.code) || 'apply_failed',
                message: String((e && e.message) || e).slice(0, 200),
            });
        const created = new Map(); // externalId -> new employee id

        // 1) links to existing employees (matched on number / e-mail).
        for (const l of plan.links) {
            try {
                await this._isolated(actorRef, () =>
                    db.run(
                        `INSERT INTO hris_links (provider, external_id, employee_id, last_seen_at)
                         VALUES (?, ?, ?, now()) ON CONFLICT DO NOTHING`,
                        [provider, String(l.externalId), Number(l.employeeId)]
                    )
                );
                applied.links++;
            } catch (e) {
                fail(l, e);
            }
        }

        // 2) joiners.
        for (const j of plan.joiners) {
            try {
                const id = await this._isolated(actorRef, () =>
                    this.createJoiner(j, { provider, actorRef })
                );
                created.set(j.externalId, id);
                applied.joiners++;
            } catch (e) {
                fail(j, e);
            }
        }
        // Joiners whose manager is another joiner of the batch.
        for (const j of plan.joiners) {
            const id = created.get(j.externalId);
            const mgr = j.managerPendingExternalId && created.get(j.managerPendingExternalId);
            if (!id || !mgr) continue;
            try {
                await this._isolated(actorRef, async () => {
                    if (await this._validSupervisor(id, mgr))
                        await EmployeeModel.update(id, { supervisorId: mgr });
                });
            } catch (e) {
                fail(j, e);
            }
        }

        // 3) movers (org / role through the lifecycle, supervisor, profile).
        for (const m of plan.movers) {
            try {
                await this._isolated(actorRef, async () => {
                    const before = await db.get(
                        'SELECT site_id, department_id, service_id, role_id, supervisor_id FROM employees WHERE id = ?',
                        [m.employeeId]
                    );
                    if (!before) throw code('employee_not_found');
                    const patch = {};
                    for (const f of ['siteId', 'departmentId', 'serviceId', 'roleId'])
                        if (m.changes[f]) patch[f] = m.changes[f].to;
                    if (patch.siteId || patch.departmentId || patch.serviceId) {
                        const target = {
                            siteId: patch.siteId || before.siteId,
                            departmentId: patch.departmentId || before.departmentId,
                            serviceId: patch.serviceId || before.serviceId,
                        };
                        const {
                            destinationPlacementError,
                        } = require('../controllers/EmployeeController');
                        if (await destinationPlacementError(SYSTEM_ACTOR, target, null))
                            throw code('placement_inconsistent');
                    }
                    let sup = m.changes.supervisorId ? m.changes.supervisorId.to : null;
                    if (!sup && m.managerPendingExternalId)
                        sup = created.get(m.managerPendingExternalId) || null;
                    if (sup && (await this._validSupervisor(m.employeeId, sup)))
                        patch.supervisorId = sup;
                    Object.assign(patch, m.profile || {});
                    if (!Object.keys(patch).length) return;
                    await EmployeeModel.update(m.employeeId, patch);
                    await Lifecycle.moverFromChanges(
                        m.employeeId,
                        {
                            siteId: before.siteId,
                            departmentId: before.departmentId,
                            serviceId: before.serviceId,
                            roleId: before.roleId,
                        },
                        {
                            siteId: patch.siteId || before.siteId,
                            departmentId: patch.departmentId || before.departmentId,
                            serviceId: patch.serviceId || before.serviceId,
                            roleId: patch.roleId || before.roleId,
                        },
                        { actorRef, reason: `HRIS sync (${provider})`, source: 'hris' }
                    );
                    await audit(
                        'HRIS_MOVER_APPLIED',
                        `Employee #${m.employeeId} updated from ${provider}: ${Object.keys(patch).join(', ')}`,
                        { actorRef, entityId: m.employeeId }
                    );
                });
                applied.movers++;
            } catch (e) {
                fail(m, e);
            }
        }

        // 4) profile-only updates (name, e-mail).
        for (const u of plan.updates) {
            try {
                await this._isolated(actorRef, async () => {
                    await EmployeeModel.update(u.employeeId, u.profile);
                    await audit(
                        'HRIS_PROFILE_UPDATED',
                        `Employee #${u.employeeId} profile updated from ${provider}: ${Object.keys(u.profile).join(', ')}`,
                        { actorRef, entityId: u.employeeId }
                    );
                });
                applied.updates++;
            } catch (e) {
                fail(u, e);
            }
        }

        // 5) leavers → the SAME deprovisioning as SCIM and the JML screen.
        for (const l of plan.leavers) {
            try {
                await this._isolated(actorRef, async () => {
                    const cur = await db.get('SELECT is_active FROM employees WHERE id = ?', [
                        l.employeeId,
                    ]);
                    if (!cur || !cur.isActive) return;
                    await Lifecycle.deprovision(l.employeeId, {
                        source: 'hris',
                        actorRef,
                        departure: true,
                    });
                    await audit(
                        'HRIS_LEAVER_APPLIED',
                        `Employee #${l.employeeId} deprovisioned from ${provider} (${l.reason}${l.endDate ? ', ended ' + l.endDate : ''})`,
                        { actorRef, entityId: l.employeeId }
                    );
                });
                applied.leavers++;
            } catch (e) {
                fail(l, e);
            }
        }

        const appliedTotal = Object.values(applied).reduce((a, b) => a + b, 0);
        return { applied, appliedTotal, errors };
    }

    // ------------------------------------------------------------------
    // schedule
    // ------------------------------------------------------------------

    static async alert(kind, dedupKey, provider, extra = {}) {
        try {
            await require('./JobRunService').alert(kind, dedupKey, {
                link: '/admin/integrations/hris',
                provider,
                ...extra,
            });
        } catch (_) {
            /* best effort */
        }
    }

    /**
     * The nightly pass (src/jobs/hris-sync.js): nothing until a connector is
     * enabled; once a day at or after its hour. Dry run always; apply only when
     * the admin ticked "apply automatically" — otherwise the SuperAdmins are
     * told a plan waits for review. A tripped guard alerts and applies nothing.
     */
    static async runScheduled({ now = new Date(), force = false, opts = {} } = {}) {
        const row = await this.enabledRow();
        if (!row) return { skipped: 'no_connector' };
        const today = now.toISOString().slice(0, 10);
        const last = row.lastScheduledOn
            ? new Date(row.lastScheduledOn).toISOString().slice(0, 10)
            : null;
        if (!force) {
            if (last === today) return { skipped: 'already_today' };
            if (now.getHours() < Number(row.scheduleHour)) return { skipped: 'not_yet' };
        }
        // Claim the day first: two instances never both run it.
        const claim = await db.run(
            `UPDATE hris_connectors SET last_scheduled_on = ?::date
              WHERE id = ? AND (last_scheduled_on IS DISTINCT FROM ?::date)`,
            [today, row.id, today]
        );
        if (!force && (!claim || !claim.changes)) return { skipped: 'claimed_elsewhere' };

        const provider = row.provider;
        const dry = await this.dryRun(provider, {
            trigger: 'schedule',
            actorRef: 'system:hris',
            opts,
            now,
        });
        if (dry.status === 'failed') {
            await this.alert('ops.hris_sync_alert', `hris-failed:${dry.runId}`, provider);
            return { done: true, provider, dryRun: dry.runId, status: 'failed' };
        }
        if (dry.status === 'aborted') {
            await this.alert('ops.hris_sync_alert', `hris-abort:${dry.runId}`, provider);
            return { done: true, provider, dryRun: dry.runId, status: 'aborted' };
        }
        const c = dry.plan.counts;
        const nothing = !c.joiners && !c.movers && !c.updates && !c.leavers && !c.links;
        if (row.autoApply && !nothing) {
            const res = await this.apply(dry.runId, {
                actorRef: 'system:hris',
                trigger: 'schedule',
                now,
            });
            if (res.status !== 'applied')
                await this.alert('ops.hris_sync_alert', `hris-apply:${res.runId}`, provider);
            return {
                done: true,
                provider,
                dryRun: dry.runId,
                apply: res.runId,
                status: res.status,
            };
        }
        if (!nothing || c.unmapped || c.blocked)
            await this.alert('ops.hris_plan_ready', `hris-plan:${dry.runId}`, provider, {
                runId: dry.runId,
                link: `/admin/integrations/hris?run=${dry.runId}`,
            });
        return { done: true, provider, dryRun: dry.runId, status: 'planned' };
    }

    // ------------------------------------------------------------------
    // SCIM placement
    // ------------------------------------------------------------------

    static async scimAutoPlaceEnabled() {
        try {
            return Boolean(
                await require('../models/AppSettingsModel').getValue('hris.scimAutoPlace', false)
            );
        } catch (_) {
            return false;
        }
    }

    /**
     * SCIM enterprise extension → the same mapping rules. Returns
     * { placed: true, employeeId } when every value maps (department → site /
     * service, title → role, manager → an active employee), otherwise
     * { placed: false, reasons } and the caller falls back to the onboarding
     * queue.
     */
    static async scimPlace(body, { actorRef = null } = {}) {
        if (!(await this.scimAutoPlaceEnabled())) return { placed: false, reasons: ['disabled'] };
        const b = body || {};
        const ext = b['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] || {};
        const name = b.name || {};
        const email = String(b.userName || (b.emails && b.emails[0] && b.emails[0].value) || '')
            .trim()
            .toLowerCase();
        const rec = hris.HrisConnector.normalise({
            externalId: b.externalId || email,
            employeeNumber: ext.employeeNumber,
            firstName: name.givenName,
            lastName: name.familyName,
            email,
            jobTitle: b.title,
            department: ext.department,
            status: 'active',
        });
        const ctx = await this.loadContext('scim', { matchByName: true });
        const pl = planner.resolvePlacement(rec, ctx);
        const reasons = [...pl.errors, ...pl.unmapped.map((u) => `unmapped_${u.field}`)];
        if (!rec.firstName || !rec.lastName) reasons.push('name_missing');
        let supervisorId = null;
        const mgrRef = ext.manager && (ext.manager.value || ext.manager.id);
        if (mgrRef) {
            const asId = /^\d+$/.test(String(mgrRef)) ? Number(mgrRef) : null;
            const linked = ctx.linkByExt.get(String(mgrRef));
            const cand = linked != null ? linked : asId;
            const e = cand != null ? ctx.employees.get(Number(cand)) : null;
            if (e && e.isActive && !e.cancelledAt && !e.erasedAt) supervisorId = Number(e.id);
            else reasons.push('unmapped_manager');
        }
        if (!pl.complete || reasons.length)
            return { placed: false, reasons: [...new Set(reasons)] };
        if (rec.employeeNumber) {
            const clash = await db.get('SELECT id FROM employees WHERE employee_number = ?', [
                rec.employeeNumber,
            ]);
            if (clash) return { placed: false, reasons: ['employee_number_taken'] };
        }
        try {
            const employeeId = await this._isolated(actorRef, () =>
                this.createJoiner(
                    {
                        externalId: b.externalId ? String(b.externalId) : null,
                        employeeNumber: rec.employeeNumber,
                        firstName: rec.firstName,
                        lastName: rec.lastName,
                        email: rec.email && planner.EMAIL_RE.test(rec.email) ? rec.email : null,
                        siteId: pl.siteId,
                        departmentId: pl.departmentId,
                        serviceId: pl.serviceId,
                        roleId: pl.roleId,
                        supervisorId,
                    },
                    { provider: 'scim', actorRef, source: 'scim' }
                )
            );
            return { placed: true, employeeId };
        } catch (e) {
            return { placed: false, reasons: [(e && e.code) || 'create_failed'] };
        }
    }
}

HrisSyncService.PROVIDERS = PROVIDERS;
HrisSyncService.MAPPING_KINDS = MAPPING_KINDS;
HrisSyncService.CREDENTIAL_KEYS = CREDENTIAL_KEYS;

module.exports = HrisSyncService;
