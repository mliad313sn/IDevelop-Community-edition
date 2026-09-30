'use strict';

/**
 * PersonioConnector — Personio Public API v1 (READ only).
 *
 * IMPLEMENTED FROM PUBLIC API DOCUMENTATION, NOT YET VALIDATED AGAINST A LIVE
 * TENANT. Tested with mocked HTTP only (tests/unit/hrisConnectors.test.js).
 *
 * Auth: client credentials (Settings → Integrations → API credentials).
 *   POST {base}/v1/auth  { client_id, client_secret }  →  { success, data: { token } }
 *   then  Authorization: Bearer <token>. When a response carries a fresh token
 *   in its Authorization header (Personio's historical token rotation), the
 *   next request uses it.
 *
 * People: GET {base}/v1/company/employees?limit=&offset=[&updated_since=]
 *   { success, metadata: { total_elements, current_page, total_pages },
 *     data: [ { type: 'Employee', attributes: { id: { value }, first_name: { value }, … } } ] }
 *   Paginated by offset until a short page, the announced total, or max_pages.
 *
 * Attribute names are configurable (config.attributes) because the API only
 * returns what the credential's attribute whitelist allows, and employee
 * numbers usually live in a custom attribute ("dynamic_123456"):
 *   employeeNumber (default: none)   jobTitle (position)   department (department)
 *   site (office)   service (team)   manager (supervisor)
 *   startDate (hire_date)   endDate (termination_date)   status (status)
 */
const HrisConnector = require('./HrisConnector');

const DEFAULT_BASE = 'https://api.personio.de';
const DEFAULT_ATTRIBUTES = {
    employeeNumber: null,
    jobTitle: 'position',
    department: 'department',
    site: 'office',
    service: 'team',
    manager: 'supervisor',
    startDate: 'hire_date',
    endDate: 'termination_date',
    status: 'status',
};

/** A Personio attribute's value: { label, value, type } or a bare value. */
function attrValue(attrs, name) {
    if (!name || !attrs) return null;
    const a = attrs[name];
    if (a == null) return null;
    return typeof a === 'object' && !Array.isArray(a) && 'value' in a ? a.value : a;
}

/** Name (or id) of a nested object value: { type, attributes: { id, name } }. */
function objectLabel(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) return v.length ? objectLabel(v[0]) : null;
    const at = v.attributes || v;
    const name = at.name != null ? attrValue({ n: at.name }, 'n') : null;
    if (name != null && name !== '') return String(name);
    const id = at.id != null ? attrValue({ n: at.id }, 'n') : null;
    return id == null ? null : String(id);
}

/** The id of a nested Employee value (the supervisor). */
function objectId(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'object') return String(v);
    const at = v.attributes || v;
    const id = at.id != null ? attrValue({ n: at.id }, 'n') : null;
    return id == null ? null : String(id);
}

class PersonioConnector extends HrisConnector {
    get provider() {
        return 'personio';
    }

    get attributes() {
        return { ...DEFAULT_ATTRIBUTES, ...(this.config.attributes || {}) };
    }

    headers(extra = {}) {
        const h = { ...extra };
        if (this.config.app_id !== '') h['X-Personio-App-ID'] = this.config.app_id || 'IDEVELOP_CE';
        if (this.config.partner_id) h['X-Personio-Partner-ID'] = String(this.config.partner_id);
        return h;
    }

    async token() {
        if (this._token) return this._token;
        const { client_id: id, client_secret: secret } = this.credentials;
        if (!id || !secret) {
            const e = new Error('Personio client_id / client_secret are not configured');
            e.code = 'hris_missing_credentials';
            throw e;
        }
        const json = await this.httpJson(this.base(DEFAULT_BASE) + '/v1/auth', {
            method: 'POST',
            headers: this.headers(),
            json: { client_id: id, client_secret: secret },
        });
        const t = json && json.data && json.data.token;
        if (!t) {
            const e = new Error('Personio auth answered without a token');
            e.code = 'hris_auth_failed';
            throw e;
        }
        this._token = t;
        return t;
    }

    /** Keep a rotated token when Personio hands one back. */
    _rotate(headers) {
        const a = headers && (headers.authorization || headers.Authorization);
        const m = a && /^Bearer\s+(.+)$/i.exec(String(a));
        if (m) this._token = m[1];
    }

    normalisePerson(item) {
        const at = (item && item.attributes) || {};
        const A = this.attributes;
        return HrisConnector.normalise(
            {
                externalId: attrValue(at, 'id'),
                employeeNumber: A.employeeNumber ? attrValue(at, A.employeeNumber) : null,
                firstName: attrValue(at, 'first_name'),
                lastName: attrValue(at, 'last_name'),
                email: attrValue(at, 'email'),
                jobTitle: objectLabel(attrValue(at, A.jobTitle)),
                department: objectLabel(attrValue(at, A.department)),
                site: objectLabel(attrValue(at, A.site)),
                service: objectLabel(attrValue(at, A.service)),
                managerExternalId: objectId(attrValue(at, A.manager)),
                startDate: attrValue(at, A.startDate),
                endDate: attrValue(at, A.endDate),
                // Personio: active | onboarding | leave (still employed) | inactive.
                status: attrValue(at, A.status),
            },
            this.now()
        );
    }

    async listPeople({ since = null, limit = null } = {}) {
        const pageSize = Math.min(200, Math.max(1, Number(this.config.page_size) || 200));
        const out = [];
        const seen = new Set();
        let offset = 0;
        for (let page = 0; page < this.maxPages; page++) {
            const q = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
            if (since) q.set('updated_since', new Date(since).toISOString());
            const token = await this.token();
            const json = await this.httpJson(
                `${this.base(DEFAULT_BASE)}/v1/company/employees?${q.toString()}`,
                {
                    headers: this.headers({ Authorization: `Bearer ${token}` }),
                    onHeaders: (h) => this._rotate(h),
                }
            );
            if (json && json.success === false) {
                const e = new Error(
                    `Personio: ${(json.error && json.error.message) || 'request refused'}`
                );
                e.code = 'hris_http_error';
                throw e;
            }
            const items = (json && Array.isArray(json.data) && json.data) || [];
            for (const it of items) {
                const p = this.normalisePerson(it);
                if (!p.externalId || seen.has(p.externalId)) continue;
                seen.add(p.externalId);
                out.push(p);
            }
            if (limit && out.length >= limit) return out.slice(0, limit);
            const total = json && json.metadata && Number(json.metadata.total_elements);
            offset += items.length;
            if (items.length < pageSize || !items.length) break;
            if (Number.isFinite(total) && offset >= total) break;
        }
        return out;
    }
}

PersonioConnector.DEFAULT_BASE = DEFAULT_BASE;
PersonioConnector.DEFAULT_ATTRIBUTES = DEFAULT_ATTRIBUTES;

module.exports = PersonioConnector;
