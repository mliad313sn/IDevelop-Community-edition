'use strict';

/**
 * HrisConnector — abstract base every HRIS adapter implements, the HRIS twin of
 * src/integrations/lms/LmsConnector. HrisSyncService only talks to this
 * contract, so a new HRIS = a new subclass + one line in ./index.js.
 *
 * Normalised person (every field a string or null):
 *   { externalId, employeeNumber, firstName, lastName, email, jobTitle,
 *     department, site, service, managerExternalId, startDate, endDate, status }
 *   startDate / endDate  'YYYY-MM-DD'
 *   status               'active' | 'inactive'
 *
 * The connector only READS: it never writes back to the HRIS.
 */
const http = require('./http');

const FIELDS = [
    'externalId',
    'employeeNumber',
    'firstName',
    'lastName',
    'email',
    'jobTitle',
    'department',
    'site',
    'service',
    'managerExternalId',
    'startDate',
    'endDate',
    'status',
];

const INACTIVE_WORDS = new Set([
    'inactive',
    'terminated',
    'left',
    'leaver',
    'former',
    'false',
    'no',
    '0',
    'inactif',
    'parti',
    'sorti',
    'non',
    'faux',
]);

function str(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/** 'YYYY-MM-DD' from an ISO string, a date, or a dd/mm/yyyy French export. */
function isoDate(v) {
    const s = str(v);
    if (!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function todayIso(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

/**
 * The one place a raw status becomes 'active' | 'inactive'. An end date in the
 * past makes a person inactive whatever the status column says.
 */
function normaliseStatus(raw, endDate, now = new Date()) {
    const s = str(raw);
    if (endDate && endDate < todayIso(now)) return 'inactive';
    if (s && INACTIVE_WORDS.has(s.toLowerCase())) return 'inactive';
    return 'active';
}

/** Fill the full shape: every FIELD present, strings trimmed, dates ISO. */
function normalise(p, now = new Date()) {
    const out = {};
    for (const f of FIELDS) out[f] = str(p && p[f]);
    out.email = out.email ? out.email.toLowerCase() : null;
    out.startDate = isoDate(p && p.startDate);
    out.endDate = isoDate(p && p.endDate);
    out.status = normaliseStatus(p && p.status, out.endDate, now);
    return out;
}

class HrisConnector {
    constructor(config = {}, credentials = {}, opts = {}) {
        this.config = config || {};
        this.credentials = credentials || {};
        // Test seams (mocked HTTP): { transport, lookup, now }.
        this.opts = opts || {};
    }

    /** Stable provider key — overridden by each adapter. */
    get provider() {
        return 'base';
    }

    /** @returns {Promise<{ok:boolean, error?:string, code?:string, sample?:number}>} */
    async testConnection() {
        try {
            const people = await this.listPeople({ since: null, limit: 1 });
            return { ok: true, sample: people.length };
        } catch (e) {
            return { ok: false, error: e.message, code: e.code || null };
        }
    }

    /**
     * @param {{since?: Date|string|null}} [opts]
     * @returns {Promise<Array<object>>} normalised people
     */
    async listPeople(/* { since } */) {
        throw new Error('listPeople not implemented');
    }

    get timeoutMs() {
        return Number(this.config.timeout_ms) || http.DEFAULT_TIMEOUT_MS;
    }

    get maxPages() {
        return Math.max(1, Number(this.config.max_pages) || 500);
    }

    now() {
        return this.opts.now ? new Date(this.opts.now) : new Date();
    }

    /** JSON through the SSRF guard, with this connector's timeout and seams. */
    async httpJson(url, reqOpts = {}) {
        return http.requestJson(url, {
            ...reqOpts,
            timeoutMs: this.timeoutMs,
            transport: this.opts.transport,
            lookup: this.opts.lookup,
        });
    }

    base(defaultUrl = '') {
        return String(this.config.base_url || defaultUrl || '').replace(/\/+$/, '');
    }
}

HrisConnector.FIELDS = FIELDS;
HrisConnector.normalise = normalise;
HrisConnector.isoDate = isoDate;
HrisConnector.str = str;
HrisConnector.todayIso = todayIso;

module.exports = HrisConnector;
