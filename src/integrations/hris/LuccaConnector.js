'use strict';

/**
 * LuccaConnector — Lucca API v3 (READ only).
 *
 * IMPLEMENTED FROM PUBLIC API DOCUMENTATION, NOT YET VALIDATED AGAINST A LIVE
 * TENANT. Tested with mocked HTTP only (tests/unit/hrisConnectors.test.js).
 *
 * Auth: an API key created in Lucca (Administration → API keys), sent as
 *   Authorization: lucca application=<key>
 * Base URL: the tenant, e.g. https://acme.ilucca.net (config.base_url, required).
 *
 * People: GET {base}/api/v3/users?fields=…&formerEmployees=true&paging=<offset>,<limit>
 *   { data: { items: [ { id, firstName, lastName, mail, employeeNumber, jobTitle,
 *       dtContractStart, dtContractEnd, department: { id, name },
 *       legalEntity: { id, name }, manager: { id } } ] } }
 *   formerEmployees=true so that a departure is SEEN (an end date in the
 *   past), not inferred from an absence.
 *
 * Departments and legal entities: when a user item carries only an id,
 * the name is looked up once in {base}/api/v3/departments and in the legal
 * entities endpoint (config.legal_entities_path, default
 * /api/v3/legal-entities). Both lookups are best effort: a tenant that does
 * not expose them still syncs on the names the users endpoint returns.
 *
 * Mapping to the normalised person: department → department, legal entity →
 * site (config.site_source 'establishment' reads the establishment instead),
 * no service (map the department to a service in the value mappings, or let
 * a department with a single service take it).
 */
const HrisConnector = require('./HrisConnector');

const USER_FIELDS = [
    'id',
    'firstName',
    'lastName',
    'mail',
    'employeeNumber',
    'jobTitle',
    'dtContractStart',
    'dtContractEnd',
    'department[id,name]',
    'legalEntity[id,name]',
    'establishment[id,name]',
    'manager[id]',
];

function items(json) {
    if (!json) return [];
    if (json.data && Array.isArray(json.data.items)) return json.data.items;
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.items)) return json.items;
    return [];
}

function idOf(v, flatId) {
    if (v && typeof v === 'object' && v.id != null) return String(v.id);
    return flatId != null && flatId !== '' ? String(flatId) : null;
}

class LuccaConnector extends HrisConnector {
    get provider() {
        return 'lucca';
    }

    authHeaders() {
        const key = this.credentials.api_key;
        if (!key) {
            const e = new Error('The Lucca API key is not configured');
            e.code = 'hris_missing_credentials';
            throw e;
        }
        return { Authorization: `lucca application=${key}` };
    }

    requireBase() {
        const b = this.base();
        if (!b) {
            const e = new Error('The Lucca tenant URL (https://<tenant>.ilucca.net) is required');
            e.code = 'hris_missing_base_url';
            throw e;
        }
        return b;
    }

    /** id → name for one reference list; {} when the endpoint is unavailable. */
    async lookup(pathName) {
        try {
            const json = await this.httpJson(
                `${this.requireBase()}${pathName}?fields=id,name&paging=0,1000`,
                { headers: this.authHeaders() }
            );
            const map = {};
            for (const it of items(json)) if (it && it.id != null) map[String(it.id)] = it.name;
            return map;
        } catch (e) {
            if (e && e.code === 'hris_url_private') throw e; // never swallow an SSRF refusal
            return {};
        }
    }

    normaliseUser(u, refs = {}) {
        const depId = idOf(u.department, u.departmentID ?? u.departmentId);
        const leId = idOf(u.legalEntity, u.legalEntityID ?? u.legalEntityId);
        const estId = idOf(u.establishment, u.establishmentID ?? u.establishmentId);
        const name = (obj, id, dict) =>
            (obj && typeof obj === 'object' && obj.name) || (id && dict && dict[id]) || id || null;
        const siteFromEstablishment = String(this.config.site_source || '') === 'establishment';
        return HrisConnector.normalise(
            {
                externalId: u.id,
                employeeNumber: u.employeeNumber,
                firstName: u.firstName,
                lastName: u.lastName,
                email: u.mail || u.email,
                jobTitle: u.jobTitle,
                department: name(u.department, depId, refs.departments),
                site: siteFromEstablishment
                    ? name(u.establishment, estId, null)
                    : name(u.legalEntity, leId, refs.legalEntities),
                service: null,
                managerExternalId: idOf(u.manager, u.managerID ?? u.managerId),
                startDate: u.dtContractStart,
                endDate: u.dtContractEnd,
                status: null, // derived from dtContractEnd
            },
            this.now()
        );
    }

    async listPeople({ limit = null } = {}) {
        const base = this.requireBase();
        const headers = this.authHeaders();
        const pageSize = Math.min(1000, Math.max(1, Number(this.config.page_size) || 100));
        const raw = [];
        for (let page = 0, offset = 0; page < this.maxPages; page++) {
            const url =
                `${base}/api/v3/users?fields=${USER_FIELDS.join(',')}` +
                `&formerEmployees=true&paging=${offset},${pageSize}`;
            const got = items(await this.httpJson(url, { headers }));
            raw.push(...got);
            if (limit && raw.length >= limit) break;
            offset += got.length;
            if (got.length < pageSize) break;
        }
        // Names for ids the users endpoint did not expand.
        const needDept = raw.some((u) => !(u.department && u.department.name) && u.departmentID);
        const needLe = raw.some((u) => !(u.legalEntity && u.legalEntity.name) && u.legalEntityID);
        const refs = {
            departments: needDept
                ? await this.lookup(this.config.departments_path || '/api/v3/departments')
                : {},
            legalEntities: needLe
                ? await this.lookup(this.config.legal_entities_path || '/api/v3/legal-entities')
                : {},
        };
        const seen = new Set();
        const out = [];
        for (const u of raw) {
            const p = this.normaliseUser(u, refs);
            if (!p.externalId || seen.has(p.externalId)) continue;
            seen.add(p.externalId);
            out.push(p);
        }
        return limit ? out.slice(0, limit) : out;
    }
}

LuccaConnector.USER_FIELDS = USER_FIELDS;

module.exports = LuccaConnector;
