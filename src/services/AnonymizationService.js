'use strict';

/**
 * AnonymizationService — the cipher/decipher engine between talent data and
 * ANY AI model (internal and external).
 *
 * WHAT IT PROTECTS
 *   Personal data:  every scoped employee's full name and name parts.
 *   Company data:   site, department, service and role names, and the
 *                   organization's identity (branded app/company name).
 *   Optionally (strict mode): skill names — hides the capability map too.
 *
 * HOW
 *   1. A per-request CIPHER SESSION builds a dictionary of protected strings
 *      from the database (org entities) + the caller's scoped roster.
 *   2. Every protected string is replaced by a class-prefixed token with a
 *      RANDOM per-request id — e.g. EMP-7F3A, SITE-92C1, DEPT-0B44 — so the
 *      SAME person gets the SAME token within one request (the model can
 *      reason consistently) but a DIFFERENT token on the next request
 *      (a provider can never correlate answers across requests to build a
 *      profile). Replacement is applied to every string in the outbound
 *      context AND to the user's question, longest-match-first,
 *      case-insensitive.
 *   3. The DECIPHER pass swaps tokens in the model's answer back to the real
 *      values, so the user experience is unchanged.
 *
 * MODES (App Setting `copilotAnonymizationMode`)
 *   'always'        (default) cipher for internal AND external targets.
 *   'external-only' internal/trusted AI servers receive full data.
 *   External targets are ALWAYS ciphered — no configuration can disable that.
 */

const PRODUCT = require('../config/product');
const crypto = require('crypto');
const db = require('../config/database');

const CLASS_PREFIX = {
    person: 'EMP',
    site: 'SITE',
    department: 'DEPT',
    service: 'SVC',
    role: 'ROLE',
    org: 'ORG',
    skill: 'SKILL',
};

// Any token this service can emit — used by decipher and by tests.
// Case-insensitive: models occasionally lowercase tokens ("emp-7f3a") and the
// decipher must still restore them.
const TOKEN_RE = /\b(?:EMP|SITE|DEPT|SVC|ROLE|ORG|SKILL)-[0-9A-Fa-f]{4}\b/gi;

class CipherSession {
    constructor() {
        this.forward = new Map(); // protected string (lowercased) → token
        this.reverse = new Map(); // token → original string
        this.entries = []; // [{ text, cls }] sorted longest-first at seal
        this.stats = {}; // per-class token counts
        this._used = new Set();
    }

    _newToken(cls) {
        const prefix = CLASS_PREFIX[cls] || 'ITEM';
        let t;
        do {
            t = `${prefix}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        } while (this._used.has(t));
        this._used.add(t);
        return t;
    }

    /** Register a protected string under an entity class. */
    add(text, cls) {
        const k = String(text || '').trim();
        if (k.length < 2) return;
        const key = k.toLowerCase();
        if (this.forward.has(key)) return;
        const token = this._newToken(cls);
        this.forward.set(key, token);
        this.reverse.set(token, k);
        this.entries.push({ text: k, token });
        this.stats[cls] = (this.stats[cls] || 0) + 1;
    }

    /**
     * Compile the dictionary for single-pass replacement:
     *  - longest-first ordering so "Mine A Nord" wins over "Mine A",
     *  - accent-aware WORD BOUNDARIES so a short org name like "IT" can only
     *    match standalone — never inside "with" or "criticité" (JS \b is
     *    ASCII-only and breaks on accented names, hence the custom classes),
     *  - CHUNKED ALTERNATIONS (~400 entries per regex) instead of one regex
     *    per entry: a superadmin-scope dictionary (thousands of names + org
     *    entities) costs a handful of scans over the text, not thousands.
     */
    seal() {
        this.entries.sort((a, b) => b.text.length - a.text.length);
        const BL = '(?<![A-Za-z0-9\\u00C0-\\u024F])';
        const BR = '(?![A-Za-z0-9\\u00C0-\\u024F])';
        const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        this._chunks = [];
        for (let i = 0; i < this.entries.length; i += 400) {
            const slice = this.entries.slice(i, i + 400);
            this._chunks.push(
                new RegExp(BL + '(?:' + slice.map((e) => escRe(e.text)).join('|') + ')' + BR, 'gi')
            );
        }
    }

    cipherText(s) {
        let out = String(s == null ? '' : s);
        for (const re of this._chunks) {
            out = out.replace(re, (m) => this.forward.get(m.toLowerCase()) || m);
        }
        return out;
    }

    /** Deep-copy an object/array ciphering EVERY string value. */
    cipherObject(v) {
        if (typeof v === 'string') return this.cipherText(v);
        if (Array.isArray(v)) return v.map((x) => this.cipherObject(x));
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) out[k] = this.cipherObject(val);
            return out;
        }
        return v;
    }

    /** Swap tokens in the model's answer back to the protected originals.
     *  Case-normalized: "emp-7f3a" restores as reliably as "EMP-7F3A". */
    decipher(s) {
        return String(s == null ? '' : s).replace(
            TOKEN_RE,
            (t) => this.reverse.get(t.toUpperCase()) || t
        );
    }
}

class AnonymizationService {
    /**
     * Effective mode from settings; external targets are always ciphered
     * regardless (enforced by the caller passing internal=false → active).
     */
    async mode() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const m = String(
                (await AppSettingsModel.getValue('copilotAnonymizationMode', 'always')) || 'always'
            )
                .toLowerCase()
                .trim();
            return m === 'external-only' ? 'external-only' : 'always';
        } catch (_) {
            return 'always'; // fail-closed: settings unavailable → cipher everything
        }
    }

    async _strictSkills() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = await AppSettingsModel.getValue('copilotAnonymizeSkills', '0');
            return v === true || v === 1 || v === '1' || v === 'true';
        } catch (_) {
            return false;
        }
    }

    /**
     * Build a cipher session for one AI request.
     * @param roster  scoped employees' full names (personal data)
     * Company entities (sites/departments/services/roles + org identity) come
     * from the database; skills join in strict mode. Every lookup is
     * best-effort — a failed source never disables the rest of the cipher.
     */
    async createSession(roster = []) {
        const s = new CipherSession();

        // Personal data: full names first (longest-first sorting handles
        // overlap), then individual name parts ≥ 4 chars.
        const parts = new Set();
        for (const full of roster) {
            const f = String(full || '').trim();
            if (!f) continue;
            s.add(f, 'person');
            for (const part of f.split(/\s+/)) if (part.length >= 4) parts.add(part);
        }
        for (const p of parts) s.add(p, 'person');

        // Company data: org units + roles + the organization's identity.
        const safe = async (sql, cls) => {
            try {
                for (const r of await db.all(sql)) s.add(r.name, cls);
            } catch (_) {
                /* source optional */
            }
        };
        await safe('SELECT name FROM sites', 'site');
        await safe('SELECT name FROM departments', 'department');
        await safe('SELECT name FROM services', 'service');
        await safe('SELECT name FROM roles', 'role');
        try {
            const branding = await require('../utils/branding').getBranding();
            if (branding && branding.appName && branding.appName !== PRODUCT.name)
                s.add(branding.appName, 'org');
        } catch (_) {
            /* stock identity */
        }
        if (process.env.COMPANY_NAME) s.add(process.env.COMPANY_NAME, 'org');

        if (await this._strictSkills()) await safe('SELECT name FROM skills', 'skill');

        s.seal();
        return s;
    }
}

module.exports = new AnonymizationService();
module.exports.CipherSession = CipherSession;
module.exports.TOKEN_RE = TOKEN_RE;
