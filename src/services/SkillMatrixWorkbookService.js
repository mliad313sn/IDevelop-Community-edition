'use strict';

/**
 * SkillMatrixWorkbookService
 *
 * Single-file ("Skill Matrix") import/export for one-shot org provisioning,
 * available in multiple interchange formats — Excel (.xlsx), JSON (.json),
 * XML (.xml) and CSV (.csv) — all carrying the SAME data model, modelled on
 * the customer-supplied `IA_Skill_Matrix_Import.xlsx`:
 *
 *   Domains · Skills · Roles · Role_Requirements · Employees · Assessment
 *   (+ README / Competency_Scale reference)
 *
 * Sheets/sections are cross-linked by workbook-local stable keys (DOM-xx,
 * SKL-xxx, ROL-xx). Those IDs are NOT stored in the DB (domains/skills/roles
 * have no code column) — they only join sections in memory. `Employee ID`
 * (EMP-###) maps to the real `employees.employee_number`.
 *
 * Architecture: one canonical "model" (plain arrays keyed by camelCase fields)
 * sits in the middle. Exporters serialize model -> {excel|json|xml|csv};
 * importers parse {excel|json|xml|csv} -> model -> internal (name-resolved)
 * shape that the DB upsert consumes. Adding a new format = one serializer +
 * one deserializer; the DB logic never changes.
 *
 * DB access uses the SQLite-compat PostgreSQL layer (PostgresDatabase.js):
 * `?` placeholders + camelCase identifiers + datetime('now') are translated.
 * NOTE: `manager_id` is written in snake_case — it is absent from the compat
 * COLUMN_MAP (added by 09_hierarchy.sql after the base schema).
 */

const path = require('path');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const YAML = require('yaml');
const db = require('../config/database');
const { generatePassword, baseUsername, uniqueUsername } = require('../utils/credentialGenerator');
// Deterministic, active-only skill resolution — shared with the three other
// importers so every path writes to the same row for the same name.
const { resolveActiveSkillByName, isRetiredOnly } = require('../utils/importSkillResolver');
// assessed_by is an admins.id: exported as a stable label, resolved back on import.
const { buildAdminMaps, labelForAssessor, resolveAssessorId } = require('../utils/assessorRef');

const SUPPORTED_FORMATS = ['excel', 'json', 'xml', 'csv', 'yaml'];

const COMPETENCY_SCALE = [
    { level: 0, definition: 'None' },
    { level: 1, definition: 'Basic' },
    { level: 2, definition: 'Intermediate' },
    { level: 3, definition: 'Advanced' },
    { level: 4, definition: 'Expert' },
];

// ---------------------------------------------------------------------------
// Section schema — the single source of truth for every format.
//   key   : canonical (camelCase) field name used in the model & JSON
//   labels: header text for Excel/CSV (labels[0] is written; all are accepted
//           when reading)
//   xml   : XML element tag
// ---------------------------------------------------------------------------
const SECTIONS = {
    domains: {
        json: 'domains',
        sheet: 'Domains',
        csv: 'DOMAINS',
        xmlGroup: 'Domains',
        xmlItem: 'Domain',
        fields: [
            { key: 'domainId', labels: ['Domain ID'], xml: 'DomainID' },
            { key: 'domainName', labels: ['Domain Name', 'Domain'], xml: 'DomainName' },
        ],
    },
    // The framework is Pillar (domain) -> Sub-Domain -> Skill, and skill names are
    // only unique WITHIN a sub-domain (uq_skill_subdomain_name): the same name is
    // legitimately used by two sub-domains of one domain ('fatigue' twice, 10 such
    // pairs). A workbook that carried skills as (name, domain) only could not tell
    // them apart: restoring it into a fresh install merged those 10 department-
    // designed skills, left every sub_domain_id NULL and lost all 56 role families.
    // Sub-domains and role families are therefore sections of their own, and every
    // skill reference carries its sub-domain.
    subDomains: {
        json: 'subDomains',
        sheet: 'Sub_Domains',
        csv: 'SUB_DOMAINS',
        xmlGroup: 'SubDomains',
        xmlItem: 'SubDomain',
        fields: [
            { key: 'domainId', labels: ['Domain ID'], xml: 'DomainID' },
            { key: 'domainName', labels: ['Domain Name', 'Domain'], xml: 'DomainName' },
            {
                key: 'subDomainName',
                labels: ['Sub-Domain Name', 'Sub-Domain', 'Sub Domain'],
                xml: 'SubDomainName',
            },
            { key: 'definition', labels: ['Definition'], xml: 'Definition' },
            { key: 'position', labels: ['Position'], xml: 'Position' },
        ],
    },
    skills: {
        json: 'skills',
        sheet: 'Skills',
        csv: 'SKILLS',
        xmlGroup: 'Skills',
        xmlItem: 'Skill',
        fields: [
            { key: 'skillId', labels: ['Skill ID'], xml: 'SkillID' },
            { key: 'skillName', labels: ['Skill Name', 'Skill'], xml: 'SkillName' },
            { key: 'domainId', labels: ['Domain ID'], xml: 'DomainID' },
            { key: 'domainName', labels: ['Domain Name'], xml: 'DomainName' },
            {
                key: 'subDomainName',
                labels: ['Sub-Domain', 'Sub-Domain Name', 'Sub Domain'],
                xml: 'SubDomainName',
            },
        ],
    },
    roleFamilies: {
        json: 'roleFamilies',
        sheet: 'Role_Families',
        csv: 'ROLE_FAMILIES',
        xmlGroup: 'RoleFamilies',
        xmlItem: 'RoleFamily',
        fields: [
            {
                key: 'roleFamilyName',
                labels: ['Role Family', 'Role Family Name', 'Family'],
                xml: 'RoleFamilyName',
            },
            { key: 'description', labels: ['Description'], xml: 'Description' },
        ],
    },
    roles: {
        json: 'roles',
        sheet: 'Roles',
        csv: 'ROLES',
        xmlGroup: 'Roles',
        xmlItem: 'Role',
        fields: [
            { key: 'roleId', labels: ['Role ID'], xml: 'RoleID' },
            // 'Name' / 'Description' accepted for the roles_template_IA layout.
            { key: 'roleName', labels: ['Role Name', 'Role', 'Name'], xml: 'RoleName' },
            { key: 'careerLevel', labels: ['Career Level', 'Description'], xml: 'CareerLevel' },
            { key: 'roleFamily', labels: ['Role Family', 'Family'], xml: 'RoleFamily' },
        ],
    },
    roleRequirements: {
        json: 'roleRequirements',
        sheet: 'Role_Requirements',
        csv: 'ROLE_REQUIREMENTS',
        // Also accept a name-based "Skill Requirements" sheet (roles_template_IA).
        sheetAliases: ['Skill Requirements', 'SkillRequirements'],
        xmlGroup: 'RoleRequirements',
        xmlItem: 'RoleRequirement',
        fields: [
            { key: 'roleId', labels: ['Role ID'], xml: 'RoleID' },
            { key: 'roleName', labels: ['Role Name'], xml: 'RoleName' },
            { key: 'skillId', labels: ['Skill ID'], xml: 'SkillID' },
            { key: 'skillName', labels: ['Skill Name'], xml: 'SkillName' },
            { key: 'domainId', labels: ['Domain ID'], xml: 'DomainID' },
            {
                key: 'subDomainName',
                labels: ['Sub-Domain', 'Sub-Domain Name'],
                xml: 'SubDomainName',
            },
            {
                key: 'requiredLevel',
                labels: ['Required Level (0-4)', 'Required Level'],
                xml: 'RequiredLevel',
            },
            { key: 'isCritical', labels: ['Is Critical', 'Critical'], xml: 'IsCritical' },
        ],
    },
    // Organization units are exported in their own right. Deriving them from the
    // employees who occupy them meant a unit with no occupant never round-tripped
    // (services 17 -> 16 on a restore).
    organization: {
        json: 'organization',
        sheet: 'Organization',
        csv: 'ORGANIZATION',
        xmlGroup: 'Organization',
        xmlItem: 'Unit',
        fields: [
            { key: 'site', labels: ['Site'], xml: 'Site' },
            { key: 'department', labels: ['Department'], xml: 'Department' },
            { key: 'service', labels: ['Service'], xml: 'Service' },
        ],
    },
    employees: {
        json: 'employees',
        sheet: 'Employees',
        csv: 'EMPLOYEES',
        xmlGroup: 'Employees',
        xmlItem: 'Employee',
        fields: [
            { key: 'employeeId', labels: ['Employee ID'], xml: 'EmployeeID' },
            { key: 'employeeName', labels: ['Employee Name'], xml: 'EmployeeName' },
            { key: 'site', labels: ['Site'], xml: 'Site' },
            { key: 'department', labels: ['Department'], xml: 'Department' },
            { key: 'service', labels: ['Service'], xml: 'Service' },
            { key: 'roleId', labels: ['Role ID'], xml: 'RoleID' },
            {
                key: 'roleOriginal',
                labels: ['Role (original)', 'Role original'],
                xml: 'RoleOriginal',
            },
            { key: 'manager', labels: ['Manager'], xml: 'Manager' },
            { key: 'supervisor', labels: ['Supervisor'], xml: 'Supervisor' },
        ],
    },
    assessments: {
        json: 'assessments',
        sheet: 'Assessment',
        csv: 'ASSESSMENT',
        xmlGroup: 'Assessments',
        xmlItem: 'Assessment',
        fields: [
            { key: 'employeeId', labels: ['Employee ID'], xml: 'EmployeeID' },
            { key: 'employeeName', labels: ['Employee Name'], xml: 'EmployeeName' },
            { key: 'roleId', labels: ['Role ID'], xml: 'RoleID' },
            { key: 'skillId', labels: ['Skill ID'], xml: 'SkillID' },
            { key: 'skillName', labels: ['Skill Name'], xml: 'SkillName' },
            { key: 'domainId', labels: ['Domain ID'], xml: 'DomainID' },
            {
                key: 'subDomainName',
                labels: ['Sub-Domain', 'Sub-Domain Name'],
                xml: 'SubDomainName',
            },
            {
                key: 'requiredLevel',
                labels: ['Required Level', 'Required Level (0-4)'],
                xml: 'RequiredLevel',
            },
            { key: 'currentLevel', labels: ['Current Level'], xml: 'CurrentLevel' },
            { key: 'gap', labels: ['Gap'], xml: 'Gap' },
            { key: 'priority', labels: ['Priority'], xml: 'Priority' },
            { key: 'developmentAction', labels: ['Development Action'], xml: 'DevelopmentAction' },
            { key: 'targetDate', labels: ['Target Date'], xml: 'TargetDate' },
            { key: 'evidenceReference', labels: ['Evidence Reference'], xml: 'EvidenceReference' },
            // Without this the date was exported by the sibling CSV export but had
            // nowhere to land on the way back, so every re-import restamped the whole
            // history with today's date and nothing appeared stale any more.
            { key: 'assessedAt', labels: ['Assessed At', 'Date'], xml: 'AssessedAt' },
            // Who assessed, and their note. Without these every re-import attributed
            // ALL assessments to the importing admin (68 x 2 712 -> 1 x 2 714) and the
            // "unchanged" test on the assessor could never hold.
            { key: 'assessedBy', labels: ['Assessed By', 'Assessor'], xml: 'AssessedBy' },
            { key: 'notes', labels: ['Notes', 'Note'], xml: 'Notes' },
        ],
    },
};
const SECTION_ORDER = Object.keys(SECTIONS);

const CONTENT_TYPE = {
    excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    json: 'application/json',
    xml: 'application/xml',
    csv: 'text/csv',
    yaml: 'application/x-yaml',
};
const EXT = { excel: 'xlsx', json: 'json', xml: 'xml', csv: 'csv', yaml: 'yaml' };

// ---------------------------------------------------------------------------
// Pure helpers (no DB) — exported for unit testing
// ---------------------------------------------------------------------------

function normalizeHeader(value) {
    return String(value == null ? '' : value)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function cellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        if (Array.isArray(value.richText))
            return value.richText
                .map((r) => r.text)
                .join('')
                .trim();
        if (value.text !== undefined) return String(value.text).trim();
        if (value.result !== undefined) return String(value.result).trim();
        if (value.hyperlink !== undefined) return String(value.hyperlink).trim();
        return String(value).trim();
    }
    return String(value).trim();
}

function normalizeLevel(value) {
    const t = cellText(value);
    if (t === '') return null;
    const n = parseInt(t, 10);
    if (Number.isNaN(n) || n < 0 || n > 4) return null;
    return n;
}

/**
 * Accept a "yes" written by a human, in either language of a French-FIRST product.
 *
 * This accepted only yes/y/true/1/critical, and the workbook ships with ENGLISH
 * headers — so a department head typing `Oui` or `VRAI` in "Is Critical" got
 * `false`, with no warning. Every critical requirement they marked became
 * non-critical, which raises "critical compliance" (a KPI with a 95% threshold)
 * and quietly removes those skills from the critical-gap alerts they were declared
 * for. The machine round-trip passed because the exporter writes 'Yes'/'No'; only
 * human entry was affected, which is exactly the case the template invites.
 *
 * Accents are stripped so `Vrai`, `VRAI` and `vrai` all read the same.
 */
function parseBoolish(value) {
    const t = cellText(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    return [
        'yes',
        'y',
        'true',
        '1',
        'critical', // English / machine
        'oui',
        'o',
        'vrai',
        'critique', // French
        'x', // a ticked cell
    ].includes(t);
}

function parseEmployeeName(fullName) {
    const t = cellText(fullName).replace(/\s+/g, ' ').trim();
    if (!t) return { firstName: '', lastName: '' };
    const parts = t.split(' ');
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

function buildHeaderIndex(sheet) {
    const idx = {};
    sheet.getRow(1).eachCell((cell, colNumber) => {
        const key = normalizeHeader(cell.value);
        if (key && idx[key] === undefined) idx[key] = colNumber;
    });
    return idx;
}

function pickCol(headerIdx, labels) {
    for (const l of labels) {
        const k = normalizeHeader(l);
        if (headerIdx[k] !== undefined) return headerIdx[k];
    }
    return undefined;
}

function csvEscape(v) {
    // Neutralize spreadsheet formula injection (leading = + - @ / TAB / CR) before quoting.
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) || s.charAt(0) === "'" ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Parse CSV text into an array of row-arrays (RFC-4180-ish: quotes, escaped
// quotes, embedded commas/newlines).
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cur += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(cur);
            cur = '';
        } else if (c === '\n') {
            row.push(cur);
            rows.push(row);
            row = [];
            cur = '';
        } else {
            cur += c;
        }
    }
    if (cur !== '' || row.length) {
        row.push(cur);
        rows.push(row);
    }
    return rows;
}

function detectFormat(filepathOrName, explicit) {
    if (explicit && SUPPORTED_FORMATS.includes(explicit)) return explicit;
    const ext = path.extname(String(filepathOrName || '')).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return 'excel';
    if (ext === '.json') return 'json';
    if (ext === '.xml') return 'xml';
    if (ext === '.csv') return 'csv';
    if (ext === '.yaml' || ext === '.yml') return 'yaml';
    return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SkillMatrixWorkbookService {
    get supportedFormats() {
        return [...SUPPORTED_FORMATS];
    }

    // ===================== EXPORT / TEMPLATE =====================

    // Returns { buffer, contentType, ext, format } for an HTTP download.
    // `user` is REQUIRED for any export containing live employees: the workbook
    // carries names, org placement, managers and every assessed level, and this
    // export used to apply no clearance at all. Passing no user fails closed.
    async exportData(format = 'excel', user = null) {
        return this._serialize(
            await this._collectModel({ includeLiveEmployees: true, user }),
            format
        );
    }

    // The blank template holds no employee rows, so it needs no clearance.
    async buildTemplateData(format = 'excel') {
        return this._serialize(await this._collectModel({ includeLiveEmployees: false }), format);
    }

    // Back-compat: callers that want the raw ExcelJS workbook object.
    async exportWorkbook(user = null) {
        return this._modelToWorkbook(
            await this._collectModel({ includeLiveEmployees: true, user })
        );
    }
    async buildTemplate() {
        return this._modelToWorkbook(await this._collectModel({ includeLiveEmployees: false }));
    }

    async _serialize(model, format) {
        const fmt = SUPPORTED_FORMATS.includes(format) ? format : 'excel';
        let buffer;
        if (fmt === 'excel') {
            const wb = this._modelToWorkbook(model);
            buffer = await wb.xlsx.writeBuffer();
        } else if (fmt === 'json') {
            buffer = Buffer.from(this._modelToJson(model), 'utf8');
        } else if (fmt === 'xml') {
            buffer = Buffer.from(this._modelToXml(model), 'utf8');
        } else if (fmt === 'yaml') {
            buffer = Buffer.from(this._modelToYaml(model), 'utf8');
        } else {
            buffer = Buffer.from(this._modelToCsv(model), 'utf8');
        }
        return { buffer, contentType: CONTENT_TYPE[fmt], ext: EXT[fmt], format: fmt };
    }

    // Collect the canonical model from the DB (with synthesized DOM/SKL/ROL IDs).
    async _collectModel({ includeLiveEmployees, user = null }) {
        // Personal data must never leave the caller's clearance. Verified before
        // the fix: an admin scoped to ONE employee downloaded all 77, with names,
        // site, department, service, role, manager, supervisor and every assessed
        // level. `scopeClause` emits " AND 1 = 0" on an empty scope, so this fails
        // closed rather than falling through to the whole organisation.
        //
        // The referential sections below (domains, skills, roles and their
        // required levels) stay org-wide on purpose: that is the framework each
        // department designed, not personal data. No skill count is reduced.
        const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');
        const empParams = [];
        const empScope = includeLiveEmployees
            ? scopeClause(await scopedEmployeeIds(user), empParams, 'e.id')
            : '';

        const domains = await db.all('SELECT id, name FROM domains WHERE isActive = 1 ORDER BY id');
        const subDomains = await db.all(`
            SELECT sd.id, sd.name, sd.definition, sd.position, sd.domainId
            FROM subDomains sd JOIN domains d ON d.id = sd.domainId
            WHERE sd.isActive = 1 AND d.isActive = 1 ORDER BY sd.domainId, sd.position, sd.id
        `);
        const skills = await db.all(`
            SELECT s.id, s.name, s.domainId, d.name AS domainName, sd.name AS subDomainName
            FROM skills s JOIN domains d ON s.domainId = d.id
            LEFT JOIN subDomains sd ON sd.id = s.subDomainId
            WHERE s.isActive = 1 AND d.isActive = 1 ORDER BY s.id
        `);
        // Every family, referenced by a role or not: the taxonomy is department-designed.
        const roleFamilies = await db.all(
            'SELECT id, name, description FROM role_families WHERE isActive = 1 ORDER BY id'
        );
        const roles = await db.all(`
            SELECT r.id, r.name, r.description, rf.name AS roleFamily
            FROM roles r LEFT JOIN role_families rf ON rf.id = r.role_family_id
            WHERE r.isActive = 1 ORDER BY r.id
        `);
        // Every ACTIVE unit, occupied or not (see SECTIONS.organization).
        const orgUnits = await db.all(`
            SELECT st.name AS site, dp.name AS department, sv.name AS service
            FROM services sv
            JOIN departments dp ON dp.id = sv.departmentId
            JOIN sites st ON st.id = dp.siteId
            WHERE sv.isActive = 1 AND dp.isActive = 1 AND st.isActive = 1
            UNION ALL
            SELECT st.name, dp.name, NULL
            FROM departments dp JOIN sites st ON st.id = dp.siteId
            WHERE dp.isActive = 1 AND st.isActive = 1
              AND NOT EXISTS (SELECT 1 FROM services sv WHERE sv.departmentId = dp.id AND sv.isActive = 1)
            UNION ALL
            SELECT st.name, NULL, NULL
            FROM sites st
            WHERE st.isActive = 1
              AND NOT EXISTS (SELECT 1 FROM departments dp WHERE dp.siteId = st.id AND dp.isActive = 1)
            ORDER BY 1, 2, 3
        `);

        const domainCode = new Map();
        domains.forEach((d, i) => domainCode.set(d.id, `DOM-${String(i + 1).padStart(2, '0')}`));
        const domainName = new Map(domains.map((d) => [d.id, d.name]));
        const skillCode = new Map();
        skills.forEach((s, i) => skillCode.set(s.id, `SKL-${String(i + 1).padStart(3, '0')}`));
        const roleCode = new Map();
        roles.forEach((r, i) => roleCode.set(r.id, `ROL-${String(i).padStart(2, '0')}`));

        const model = {
            meta: { format: 'idevelop-skill-matrix', version: 2 },
            competencyScale: COMPETENCY_SCALE.map((c) => ({ ...c })),
            domains: domains.map((d) => ({ domainId: domainCode.get(d.id), domainName: d.name })),
            subDomains: subDomains.map((sd) => ({
                domainId: domainCode.get(sd.domainId) || '',
                domainName: domainName.get(sd.domainId) || '',
                subDomainName: sd.name,
                definition: sd.definition || '',
                position: sd.position == null ? '' : sd.position,
            })),
            skills: skills.map((s) => ({
                skillId: skillCode.get(s.id),
                skillName: s.name,
                domainId: domainCode.get(s.domainId),
                domainName: s.domainName,
                subDomainName: s.subDomainName || '',
            })),
            roleFamilies: roleFamilies.map((f) => ({
                roleFamilyName: f.name,
                description: f.description || '',
            })),
            roles: roles.map((r) => ({
                roleId: roleCode.get(r.id),
                roleName: r.name,
                careerLevel: r.description || '',
                roleFamily: r.roleFamily || '',
            })),
            roleRequirements: [],
            organization: orgUnits.map((u) => ({
                site: u.site || '',
                department: u.department || '',
                service: u.service || '',
            })),
            employees: [],
            assessments: [],
        };

        const skillById = new Map(skills.map((s) => [s.id, s]));
        for (const role of roles) {
            const reqs = await db.all(
                'SELECT skillId, requiredLevel, isCritical FROM roleSkillRequirements WHERE roleId = ? ORDER BY skillId',
                [role.id]
            );
            for (const req of reqs) {
                const sk = skillById.get(req.skillId);
                if (!sk) continue;
                model.roleRequirements.push({
                    roleId: roleCode.get(role.id),
                    roleName: role.name,
                    skillId: skillCode.get(sk.id),
                    skillName: sk.name,
                    domainId: domainCode.get(sk.domainId),
                    subDomainName: sk.subDomainName || '',
                    requiredLevel: req.requiredLevel,
                    isCritical: req.isCritical ? 'Yes' : 'No',
                });
            }
        }

        if (includeLiveEmployees) {
            const joinName = (f, l) => [f, l].filter(Boolean).join(' ').trim();
            const { byId: adminById } = await buildAdminMaps();
            const employees = await db.all(
                `
                SELECT e.id, e.employeeNumber, e.firstName, e.lastName, e.roleId,
                       st.name AS siteName, dp.name AS deptName, sv.name AS serviceName, r.name AS roleName,
                       mgr.firstName AS mgrFirst, mgr.lastName AS mgrLast,
                       sup.firstName AS supFirst, sup.lastName AS supLast
                FROM employees e
                LEFT JOIN sites st ON e.siteId = st.id
                LEFT JOIN departments dp ON e.departmentId = dp.id
                LEFT JOIN services sv ON e.serviceId = sv.id
                LEFT JOIN roles r ON e.roleId = r.id
                -- manager_id is only an EMPLOYEE id when manager_type says so. Without
                -- this guard the join silently found nothing for admin-managed people
                -- and exported a BLANK Manager cell (which the importer then read as
                -- "detach the manager"), and would have named the WRONG PERSON had an
                -- employee happened to share the numeric id of the managing admin.
                LEFT JOIN employees mgr ON e.manager_id = mgr.id AND e.manager_type = 'employee'
                LEFT JOIN employees sup ON e.supervisorId = sup.id
                WHERE e.isActive = 1${empScope} ORDER BY e.lastName, e.firstName
            `,
                empParams
            );
            for (const e of employees) {
                model.employees.push({
                    employeeId: e.employeeNumber,
                    employeeName: joinName(e.firstName, e.lastName),
                    site: e.siteName || '',
                    department: e.deptName || '',
                    service: e.serviceName || '',
                    roleId: roleCode.get(e.roleId) || '',
                    roleOriginal: e.roleName || '',
                    manager: joinName(e.mgrFirst, e.mgrLast),
                    supervisor: joinName(e.supFirst, e.supLast),
                });
            }

            // The Assessment section is SCAFFOLDED, not merely dumped: one row per
            // active employee × each skill their role requires, whether or not it has
            // ever been assessed. Exporting only existing rows made the sheet come out
            // EMPTY on an instance that has never assessed anybody — handing the
            // supervisor a blank page instead of a ready-to-fill worksheet. Existing
            // levels are pre-filled; unassessed skills leave Current Level blank for
            // the supervisor to complete offline, and the round-trip importer writes
            // them back as real assessments.
            //
            // FULL OUTER-style union so nothing is lost either way:
            //   - role-required skills (the scaffold), plus
            //   - any assessment already recorded for a skill the role does NOT
            //     require (kept so an export/import cycle never drops data).
            const assessments = await db.all(
                `
                SELECT e.employeeNumber, e.firstName, e.lastName, e.roleId,
                       s.id AS skillId, s.name AS skillName, s.domainId,
                       rsr.requiredLevel AS reqLevel,
                       sa.currentLevel AS currentLevel,
                       sa.assessedAt AS assessedAt,
                       sa.assessedBy AS assessedBy, sa.notes AS notes
                FROM employees e
                JOIN roleSkillRequirements rsr ON rsr.roleId = e.roleId
                JOIN skills s ON s.id = rsr.skillId
                LEFT JOIN skillAssessments sa ON sa.employeeId = e.id AND sa.skillId = s.id
                WHERE e.isActive = 1${empScope}

                UNION ALL

                SELECT e.employeeNumber, e.firstName, e.lastName, e.roleId,
                       s.id AS skillId, s.name AS skillName, s.domainId,
                       NULL AS requiredLevel,
                       sa.currentLevel AS currentLevel,
                       sa.assessedAt AS assessedAt,
                       sa.assessedBy AS assessedBy, sa.notes AS notes
                FROM skillAssessments sa
                JOIN employees e ON e.id = sa.employeeId
                JOIN skills s ON s.id = sa.skillId
                WHERE e.isActive = 1${empScope}
                  AND NOT EXISTS (
                      SELECT 1 FROM roleSkillRequirements r2
                      WHERE r2.roleId = e.roleId AND r2.skillId = sa.skillId)

                ORDER BY 1, 5
            `,
                [...empParams, ...empParams]
            );
            for (const a of assessments) {
                const hasLevel = a.currentLevel != null;
                const required = a.reqLevel == null ? '' : a.reqLevel;
                // Gap and priority only mean something once a level exists; a blank
                // row is a task to do, not a zero-gap result.
                const gap =
                    a.reqLevel == null || !hasLevel ? '' : Math.max(0, a.reqLevel - a.currentLevel);
                const priority =
                    a.reqLevel == null || !hasLevel
                        ? ''
                        : gap >= 2
                          ? 'High'
                          : gap === 1
                            ? 'Medium'
                            : 'None';
                const sk = skillById.get(a.skillId);
                model.assessments.push({
                    employeeId: a.employeeNumber,
                    employeeName: joinName(a.firstName, a.lastName),
                    roleId: roleCode.get(a.roleId) || '',
                    skillId: skillCode.get(a.skillId) || '',
                    skillName: a.skillName,
                    domainId: domainCode.get(a.domainId) || '',
                    subDomainName: (sk && sk.subDomainName) || '',
                    requiredLevel: required,
                    currentLevel: hasLevel ? a.currentLevel : '',
                    gap,
                    priority,
                    developmentAction: '',
                    targetDate: '',
                    evidenceReference: '',
                    // Only a real assessment has a date; a blank scaffold row must
                    // not carry one, or the re-import would invent an assessment date.
                    assessedAt:
                        hasLevel && a.assessedAt ? new Date(a.assessedAt).toISOString() : '',
                    // Same rule for the assessor and the note: a scaffold row has none.
                    assessedBy: hasLevel ? labelForAssessor(a.assessedBy, adminById) : '',
                    notes: hasLevel && a.notes != null ? String(a.notes) : '',
                });
            }
        }

        return model;
    }

    // ---------- serializers ----------

    _modelToWorkbook(model) {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'IDevelop Skill Matrix';
        wb.created = new Date();
        this._addReadmeSheet(wb, model);

        const palette = {
            domains: 'FF2980B9',
            subDomains: 'FF2980B9',
            skills: 'FF2980B9',
            roleFamilies: 'FF8E44AD',
            roles: 'FF8E44AD',
            roleRequirements: 'FF8E44AD',
            organization: 'FF16A085',
            employees: 'FF27AE60',
            assessments: 'FFE67E22',
        };
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            const sheet = wb.addWorksheet(sec.sheet);
            const headers = sec.fields.map((f) => f.labels[0]);
            const headerRow = sheet.addRow(headers);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: palette[name] || 'FF34495E' },
            };
            sheet.columns.forEach((c, i) => {
                c.width = Math.min(45, String(headers[i] || '').length + 6);
            });
            sheet.views = [{ state: 'frozen', ySplit: 1 }];
            for (const row of model[name] || []) {
                sheet.addRow(sec.fields.map((f) => row[f.key] ?? ''));
            }
        }

        const cs = wb.addWorksheet('Competency_Scale');
        const csHeader = cs.addRow(['Level', 'Definition']);
        csHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        csHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF34495E' } };
        model.competencyScale.forEach((c) => cs.addRow([c.level, c.definition]));
        return wb;
    }

    _addReadmeSheet(wb, model) {
        const sheet = wb.addWorksheet('README');
        sheet.columns = [{ width: 22 }, { width: 80 }];
        const live = model.employees.length > 0;
        sheet.addRow([
            live ? 'IDEVELOP — SKILL MATRIX EXPORT' : 'IDEVELOP — SKILL MATRIX IMPORT TEMPLATE',
        ]);
        sheet.getRow(1).font = { bold: true, size: 14 };
        sheet.addRow([]);
        sheet.addRow(['Sheet', 'Purpose']);
        sheet.getRow(3).font = { bold: true };
        [
            ['Domains', 'Competency domains (pillars). Domain ID (DOM-xx) links the other sheets.'],
            ['Sub_Domains', 'Sub-domains of each domain, with definition and position.'],
            [
                'Skills',
                'Skills with their Domain ID and Sub-Domain (names are unique per sub-domain). Skill ID (SKL-xxx) links Role_Requirements & Assessment.',
            ],
            ['Role_Families', 'Role families (the department/section dimension) with description.'],
            [
                'Roles',
                'Roles. Role ID (ROL-xx); Career Level is stored as the role description; Role Family by name.',
            ],
            ['Role_Requirements', 'Required level (0-4) per Role x Skill.'],
            ['Organization', 'Site > Department > Service units, occupied or not.'],
            ['Employees', 'Employee ID = employee number. Manager/Supervisor by full name.'],
            [
                'Assessment',
                'Current level (0-4) per Employee x Skill, with Assessed At / Assessed By / Notes. Derived columns are ignored on import.',
            ],
            ['Competency_Scale', '0=None,1=Basic,2=Intermediate,3=Advanced,4=Expert.'],
        ].forEach((r) => sheet.addRow(r));
        sheet.addRow([]);
        sheet.addRow(['Formats', 'The same data imports/exports as Excel, JSON, XML or CSV.']);
        sheet.addRow([
            'Import',
            'Additive merge: missing entities created; existing matched by name/ID.',
        ]);
    }

    _modelToPlainObject(model) {
        const out = { meta: model.meta, competencyScale: model.competencyScale };
        for (const name of SECTION_ORDER) out[name] = model[name] || [];
        return out;
    }

    _modelToJson(model) {
        return JSON.stringify(this._modelToPlainObject(model), null, 2);
    }

    _modelToYaml(model) {
        return YAML.stringify(this._modelToPlainObject(model));
    }

    _modelToXml(model) {
        const root = { SkillMatrix: {} };
        root.SkillMatrix.CompetencyScale = {
            Level: model.competencyScale.map((c) => ({
                '@_value': c.level,
                '#text': c.definition,
            })),
        };
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            root.SkillMatrix[sec.xmlGroup] = {
                [sec.xmlItem]: (model[name] || []).map((row) => {
                    const o = {};
                    for (const f of sec.fields) o[f.xml] = row[f.key] ?? '';
                    return o;
                }),
            };
        }
        const builder = new XMLBuilder({
            format: true,
            indentBy: '  ',
            ignoreAttributes: false,
            suppressEmptyNode: false,
        });
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(root);
    }

    _modelToCsv(model) {
        const lines = [];
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            lines.push(`### ${sec.csv} ###`);
            lines.push(sec.fields.map((f) => csvEscape(f.labels[0])).join(','));
            for (const row of model[name] || []) {
                lines.push(sec.fields.map((f) => csvEscape(row[f.key] ?? '')).join(','));
            }
            lines.push('');
        }
        lines.push('### COMPETENCY_SCALE ###');
        lines.push('Level,Definition');
        model.competencyScale.forEach((c) => lines.push(`${c.level},${csvEscape(c.definition)}`));
        return lines.join('\r\n');
    }

    // ===================== PARSE (any format -> internal shape) =====================

    async parse(filepath, format) {
        const fmt = detectFormat(filepath, format);
        if (!fmt) throw new Error('Unsupported file type. Use .xlsx, .json, .xml or .csv');
        let model;
        if (fmt === 'excel') {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(filepath);
            model = this._workbookToModel(wb);
        } else {
            const fs = require('fs');
            const text = fs.readFileSync(filepath, 'utf8');
            if (fmt === 'json') model = this._jsonToModel(text);
            else if (fmt === 'yaml') model = this._yamlToModel(text);
            else if (fmt === 'xml') model = this._xmlToModel(text);
            else model = this._csvToModel(text);
        }
        return this._modelToInternal(model);
    }

    // ---------- deserializers (-> canonical model) ----------

    _workbookToModel(wb) {
        const model = {};
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            const sheet = this._getSheet(wb, [
                sec.sheet,
                sec.sheet.replace(/_/g, ' '),
                sec.xmlGroup,
                ...(sec.sheetAliases || []),
            ]);
            model[name] = [];
            if (!sheet) continue;
            const headerIdx = buildHeaderIndex(sheet);
            const colByKey = {};
            for (const f of sec.fields) colByKey[f.key] = pickCol(headerIdx, f.labels);
            sheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return;
                const obj = {};
                for (const f of sec.fields) {
                    const c = colByKey[f.key];
                    obj[f.key] = c ? cellText(row.getCell(c).value) : '';
                }
                model[name].push(obj);
            });
        }
        return model;
    }

    _getSheet(wb, aliases) {
        for (const a of aliases) {
            const s = wb.getWorksheet(a);
            if (s) return s;
        }
        const want = aliases.map(normalizeHeader);
        for (const ws of wb.worksheets) if (want.includes(normalizeHeader(ws.name))) return ws;
        return null;
    }

    _jsonToModel(text) {
        return this._objectToModel(JSON.parse(text));
    }

    _yamlToModel(text) {
        return this._objectToModel(YAML.parse(text) || {});
    }

    _objectToModel(data) {
        const model = {};
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            const arr = Array.isArray(data[name])
                ? data[name]
                : Array.isArray(data[sec.json])
                  ? data[sec.json]
                  : [];
            model[name] = arr.map((row) => {
                const obj = {};
                for (const f of sec.fields)
                    obj[f.key] =
                        row[f.key] === undefined || row[f.key] === null
                            ? ''
                            : String(row[f.key]).trim();
                return obj;
            });
        }
        return model;
    }

    _xmlToModel(text) {
        // An item tag is a list ONLY directly under its own group tag. The
        // roleFamilies section's item tag, <RoleFamily>, is also the roles
        // section's FIELD tag (<Role><RoleFamily>Mining</RoleFamily></Role>).
        // A name-only isArray turned that field into ['Mining'], which the
        // scalar guard below blanked: every role lost its family on an XML
        // round-trip while JSON / CSV / Excel kept it.
        const groupOfItem = new Map(
            SECTION_ORDER.map((n) => [SECTIONS[n].xmlItem, SECTIONS[n].xmlGroup])
        );
        const parser = new XMLParser({
            ignoreAttributes: true,
            parseTagValue: false,
            trimValues: true,
            isArray: (name, jpath) => {
                const group = groupOfItem.get(name);
                if (!group) return false;
                const parts = String(jpath || '').split('.');
                return parts[parts.length - 2] === group;
            },
        });
        const parsed = parser.parse(text);
        const root = parsed.SkillMatrix || parsed.skillMatrix || parsed;
        const model = {};
        for (const name of SECTION_ORDER) {
            const sec = SECTIONS[name];
            const group = root[sec.xmlGroup] || {};
            const items = group[sec.xmlItem] || [];
            model[name] = (Array.isArray(items) ? items : [items]).map((row) => {
                const obj = {};
                for (const f of sec.fields) {
                    const v = row[f.xml];
                    obj[f.key] =
                        v === undefined || v === null || typeof v === 'object'
                            ? ''
                            : String(v).trim();
                }
                return obj;
            });
        }
        return model;
    }

    _csvToModel(text) {
        const model = {};
        for (const name of SECTION_ORDER) model[name] = [];
        const rows = parseCsv(text);
        const csvToSection = {};
        for (const name of SECTION_ORDER) csvToSection[normalizeHeader(SECTIONS[name].csv)] = name;

        let current = null;
        let fieldByCol = null;
        for (const cells of rows) {
            const first = (cells[0] || '').trim();
            const m = first.match(/^#+\s*(.+?)\s*#+$/);
            if (m) {
                const sectionName = csvToSection[normalizeHeader(m[1])];
                current = sectionName || null;
                fieldByCol = null; // next non-empty row in this section is its header
                continue;
            }
            if (!current) continue;
            if (cells.every((c) => (c || '').trim() === '')) continue;
            if (!fieldByCol) {
                // header row: map each column index -> field key
                const sec = SECTIONS[current];
                fieldByCol = {};
                cells.forEach((label, i) => {
                    const key = normalizeHeader(label);
                    const f = sec.fields.find((fl) =>
                        fl.labels.some((l) => normalizeHeader(l) === key)
                    );
                    if (f) fieldByCol[i] = f.key;
                });
                continue;
            }
            const sec = SECTIONS[current];
            const obj = {};
            for (const f of sec.fields) obj[f.key] = '';
            cells.forEach((val, i) => {
                if (fieldByCol[i]) obj[fieldByCol[i]] = (val || '').trim();
            });
            model[current].push(obj);
        }
        return model;
    }

    // ---------- canonical model -> internal (name-resolved) shape ----------

    _modelToInternal(model) {
        const out = {
            domains: [],
            skills: [],
            roles: [],
            requirements: [],
            employees: [],
            assessments: [],
            errors: [],
            // Scaffold rows left blank on purpose — reported as a count, not as errors.
            notRated: 0,
        };

        const domainIdToName = new Map();
        const skillIdToInfo = new Map();
        const roleIdToName = new Map();
        // Optional keys are attached only when the file carries a value, so a file
        // in the older layout (no sub-domain / family / assessor columns) parses to
        // exactly the shape it always did.
        const withOpt = (base, extras) => {
            for (const [k, v] of Object.entries(extras)) if (v) base[k] = v;
            return base;
        };

        for (const d of model.domains || []) {
            const id = cellText(d.domainId),
                name = cellText(d.domainName);
            if (!name) continue;
            if (id) domainIdToName.set(id, name);
            out.domains.push({ name });
        }
        const subDomains = [];
        for (const sd of model.subDomains || []) {
            const name = cellText(sd.subDomainName);
            const domainName =
                cellText(sd.domainName) || domainIdToName.get(cellText(sd.domainId)) || '';
            if (!name || !domainName) continue;
            const pos = parseInt(cellText(sd.position), 10);
            subDomains.push({
                domainName,
                name,
                definition: cellText(sd.definition),
                position: Number.isNaN(pos) ? null : pos,
            });
        }
        if (subDomains.length) out.subDomains = subDomains;
        for (const s of model.skills || []) {
            const id = cellText(s.skillId),
                name = cellText(s.skillName);
            let domainName = cellText(s.domainName);
            if (!domainName) domainName = domainIdToName.get(cellText(s.domainId)) || '';
            const subDomainName = cellText(s.subDomainName);
            if (!name) continue;
            if (id) skillIdToInfo.set(id, { name, domainName, subDomainName });
            out.skills.push(withOpt({ name, domainName }, { subDomainName }));
        }
        const roleFamilies = [];
        for (const f of model.roleFamilies || []) {
            const name = cellText(f.roleFamilyName);
            if (!name) continue;
            roleFamilies.push({ name, description: cellText(f.description) });
        }
        if (roleFamilies.length) out.roleFamilies = roleFamilies;
        for (const r of model.roles || []) {
            const id = cellText(r.roleId),
                name = cellText(r.roleName);
            if (!name) continue;
            if (id) roleIdToName.set(id, name);
            out.roles.push(
                withOpt(
                    { name, careerLevel: cellText(r.careerLevel) },
                    { roleFamily: cellText(r.roleFamily) }
                )
            );
        }
        (model.roleRequirements || []).forEach((r, i) => {
            const roleName = roleIdToName.get(cellText(r.roleId)) || cellText(r.roleName);
            const info = skillIdToInfo.get(cellText(r.skillId));
            const skillName = (info && info.name) || cellText(r.skillName);
            const domainName =
                info && info.domainName
                    ? info.domainName
                    : domainIdToName.get(cellText(r.domainId)) || '';
            const subDomainName = (info && info.subDomainName) || cellText(r.subDomainName);
            const level = normalizeLevel(r.requiredLevel);
            if (!roleName || !skillName) {
                if (cellText(r.roleId) || cellText(r.skillId))
                    out.errors.push(`Role requirement ${i + 1}: unresolved role/skill`);
                return;
            }
            if (level === null) {
                out.errors.push(`Role requirement ${i + 1}: invalid required level`);
                return;
            }
            out.requirements.push(
                withOpt(
                    {
                        roleName,
                        skillName,
                        domainName,
                        requiredLevel: level,
                        isCritical: parseBoolish(r.isCritical),
                    },
                    { subDomainName }
                )
            );
        });
        const organization = [];
        for (const u of model.organization || []) {
            const site = cellText(u.site);
            if (!site) continue;
            organization.push({
                site,
                department: cellText(u.department),
                service: cellText(u.service),
            });
        }
        if (organization.length) out.organization = organization;
        (model.employees || []).forEach((e, i) => {
            const employeeNumber = cellText(e.employeeId);
            const fullName = cellText(e.employeeName);
            if (!employeeNumber || !fullName) {
                if (employeeNumber || fullName)
                    out.errors.push(`Employee ${i + 1}: missing ID or name`);
                return;
            }
            const { firstName, lastName } = parseEmployeeName(fullName);
            out.employees.push({
                employeeNumber,
                fullName,
                firstName,
                lastName,
                site: cellText(e.site),
                department: cellText(e.department),
                service: cellText(e.service),
                roleName: roleIdToName.get(cellText(e.roleId)) || cellText(e.roleOriginal) || '',
                roleOriginal: cellText(e.roleOriginal),
                managerName: cellText(e.manager),
                supervisorName: cellText(e.supervisor),
            });
        });
        (model.assessments || []).forEach((a, i) => {
            const employeeNumber = cellText(a.employeeId);
            const info = skillIdToInfo.get(cellText(a.skillId));
            const skillName = (info && info.name) || cellText(a.skillName);
            const domainName =
                info && info.domainName
                    ? info.domainName
                    : domainIdToName.get(cellText(a.domainId)) || '';
            const subDomainName = (info && info.subDomainName) || cellText(a.subDomainName);
            const level = normalizeLevel(a.currentLevel);
            if (!employeeNumber || !skillName) return;
            if (level === null) {
                // The exported sheet is now SCAFFOLDED — every skill a role requires
                // appears, most of them deliberately blank until a supervisor fills
                // them in. A blank is therefore "not rated yet", a normal state, and
                // must not be reported as an error: on a fresh instance that would
                // drown the preview in thousands of false failures. Only a value that
                // was actually typed and is unusable counts as an error.
                if (cellText(a.currentLevel) === '') out.notRated = (out.notRated || 0) + 1;
                else
                    out.errors.push(
                        `Assessment ${i + 1}: invalid current level "${cellText(a.currentLevel)}" (must be 0-4, skipped)`
                    );
                return;
            }
            // Carry the assessment date through to the writer. Dropping it here is
            // what made every re-import restamp the row with today's date even once
            // the column was exported.
            out.assessments.push(
                withOpt(
                    {
                        employeeNumber,
                        skillName,
                        domainName,
                        currentLevel: level,
                        assessedAt: cellText(a.assessedAt) || null,
                    },
                    { subDomainName, assessedBy: cellText(a.assessedBy), notes: cellText(a.notes) }
                )
            );
        });

        return out;
    }

    // Back-compat name used by unit tests / earlier callers.
    parseWorkbook(wb) {
        return this._modelToInternal(this._workbookToModel(wb));
    }

    // ===================== PREVIEW (dry-run) =====================

    async preview(filepath, format) {
        const data = await this.parse(filepath, format);

        const countNew = async (items, existsFn) => {
            let exist = 0;
            const seen = new Set();
            for (const it of items) {
                if (seen.has(it.key)) continue;
                seen.add(it.key);
                if (await existsFn(it)) exist++;
            }
            return { inFile: seen.size, existing: exist, new: seen.size - exist };
        };

        const counts = {};
        counts.domains = await countNew(
            data.domains.map((d) => ({ key: d.name.toLowerCase(), name: d.name })),
            async (d) => !!(await db.get('SELECT id FROM domains WHERE name = ?', [d.name]))
        );
        counts.skills = await countNew(
            data.skills.map((s) => ({
                key: `${s.domainName}|${s.subDomainName || ''}|${s.name}`.toLowerCase(),
                ...s,
            })),
            async (s) =>
                !!(
                    (await this._resolveSkillInSubDomain(s.name, s.domainName, s.subDomainName)) ||
                    (await resolveActiveSkillByName(db, s.name, s.domainName))
                )
        );
        counts.roles = await countNew(
            data.roles.map((r) => ({ key: r.name.toLowerCase(), name: r.name })),
            async (r) => !!(await db.get('SELECT id FROM roles WHERE name = ?', [r.name]))
        );
        // The import REWRITES an existing requirement/assessment in place. Saying
        // only "N in file" let the operator read a full re-import as a no-op.
        counts.requirements = {
            inFile: data.requirements.length,
            note: 'existing rows are updated in place',
        };
        const empExist = await countNew(
            data.employees.map((e) => ({
                key: e.employeeNumber,
                employeeNumber: e.employeeNumber,
            })),
            async (e) =>
                !!(await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    e.employeeNumber,
                ]))
        );
        counts.employees = empExist;
        counts.assessments = {
            inFile: data.assessments.length,
            // Scaffold rows left blank: the not-yet-measured, reported explicitly
            // and separately — never imported as a level 0.
            notRated: data.notRated || 0,
            note: 'existing rows are updated in place',
        };

        return { counts, credentialsToGenerate: { employees: empExist.new }, errors: data.errors };
    }

    // ===================== IMPORT =====================

    async import(filepath, adminId, format) {
        const data = await this.parse(filepath, format);
        // Every counter NAMES what happened to the row:
        //   created   — the row did not exist and was inserted
        //   updated   — the row existed with different values and was REWRITTEN
        //   unchanged — the row existed and already matched: nothing was written
        //   skipped   — the row was NOT applied; the reason is in `errors`
        //
        // Before this, an existing row was rewritten and counted `skipped`, so a
        // re-import of 2 714 assessments and 1 932 requirements reported
        // `created: 0, skipped: N` — identical to "did nothing". Measured with
        // xmin (physical row version): 2 714 / 2 714 assessments, 1 932 / 1 932
        // requirements and 79 / 80 employees had actually been rewritten.
        const section = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] });
        const results = {
            domains: section(),
            subDomains: section(),
            skills: section(),
            sites: section(),
            departments: section(),
            services: section(),
            roleFamilies: section(),
            roles: section(),
            requirements: section(),
            employees: section(),
            assessments: section(),
            warnings: [...data.errors],
            credentials: [],
        };
        // Scaffold rows the supervisor deliberately left blank. They are NOT
        // assessments at level 0 and are NOT errors — they are the not-yet-measured,
        // reported separately and explicitly, exactly as the export reports them.
        results.assessments.notRated = data.notRated || 0;

        // Per-employee outcome, so a hierarchy link written in the second pass
        // upgrades that employee from `unchanged` to `updated` instead of leaving
        // the summary claiming nothing was written.
        const ctx = { empOutcome: new Map() };

        await db.runTransaction(async () => {
            await this._importDomains(data, results);
            await this._importSubDomains(data, results);
            await this._importSkills(data, results);
            await this._importRoleFamilies(data, results);
            await this._importRoles(data, results);
            await this._importRequirements(data, results);
            await this._importOrganization(data, results);
            await this._importEmployees(data, results, ctx);
            await this._linkHierarchy(data, results, ctx);
            await this._importAssessments(data, results, adminId);
        });

        return { success: true, results };
    }

    /**
     * Exact, active-only lookup by (domain, sub-domain, name) — the framework's own
     * identity, and the only one that separates a name reused by two sub-domains
     * of the same domain. Returns null when the reference carries no sub-domain;
     * callers then fall back to the shared active-only resolver by (name, domain).
     */
    async _resolveSkillInSubDomain(name, domainName, subDomainName) {
        const clean = name == null ? '' : String(name).trim();
        if (!clean || !subDomainName || !String(subDomainName).trim()) return null;
        return db.get(
            `
            SELECT s.id FROM skills s
            JOIN subDomains sd ON sd.id = s.subDomainId
            JOIN domains d ON d.id = s.domainId
            WHERE LOWER(s.name) = LOWER(?) AND LOWER(sd.name) = LOWER(?) AND LOWER(d.name) = LOWER(?)
              AND s.isActive = true
            ORDER BY s.id LIMIT 1`,
            [clean, String(subDomainName).trim(), String(domainName || '').trim()]
        );
    }

    // One aggregate line rather than one warning per row: a file with 1 116
    // duplicate skill rows must not bury the real errors.
    _reportDuplicates(results, section, n, label) {
        if (!n) return;
        results[section].skipped += n;
        results.warnings.push(
            `${n} duplicate ${label} row(s) in the file were ignored (first occurrence kept).`
        );
    }

    async _getOrCreateDomain(name, results) {
        let domain = await db.get('SELECT id FROM domains WHERE name = ?', [name]);
        if (!domain) {
            await db.run('INSERT INTO domains (name, isActive) VALUES (?, true)', [name]);
            domain = await db.get('SELECT id FROM domains WHERE name = ?', [name]);
            if (results) results.domains.created++;
        }
        return domain;
    }

    async _importDomains(data, results) {
        const seen = new Set();
        let dup = 0;
        for (const d of data.domains) {
            const key = d.name.toLowerCase();
            if (seen.has(key)) {
                dup++;
                continue;
            }
            seen.add(key);
            const existing = await db.get('SELECT id FROM domains WHERE name = ?', [d.name]);
            // The section carries only the domain name, so a known domain has
            // nothing to correct: nothing is written and it is reported as such.
            if (existing) {
                results.domains.unchanged++;
                continue;
            }
            await this._getOrCreateDomain(d.name, results);
        }
        this._reportDuplicates(results, 'domains', dup, 'domain');
    }

    async _getOrCreateSubDomain(domainId, name, results, extra = {}) {
        let sub = await db.get(
            'SELECT id, definition, position FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
            [domainId, name]
        );
        if (!sub) {
            await db.run(
                'INSERT INTO subDomains (domainId, name, definition, position, isActive) VALUES (?, ?, ?, ?, true)',
                [
                    domainId,
                    name,
                    extra.definition || null,
                    extra.position == null ? 999 : extra.position,
                ]
            );
            sub = await db.get(
                'SELECT id, definition, position FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                [domainId, name]
            );
            if (results && results.subDomains) results.subDomains.created++;
        }
        return sub;
    }

    async _importSubDomains(data, results) {
        const seen = new Set();
        let dup = 0;
        for (const sd of data.subDomains || []) {
            const key = `${sd.domainName}|${sd.name}`.toLowerCase();
            if (seen.has(key)) {
                dup++;
                continue;
            }
            seen.add(key);
            const domain = await this._getOrCreateDomain(sd.domainName, results);
            const existing = await db.get(
                'SELECT id, definition, position FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                [domain.id, sd.name]
            );
            if (!existing) {
                await this._getOrCreateSubDomain(domain.id, sd.name, results, sd);
                continue;
            }
            // A blank definition/position in the file is an absence, not "clear it".
            const sets = [];
            const vals = [];
            if (sd.definition && sd.definition !== (existing.definition || '')) {
                sets.push('definition = ?');
                vals.push(sd.definition);
            }
            if (sd.position != null && Number(sd.position) !== Number(existing.position)) {
                sets.push('position = ?');
                vals.push(sd.position);
            }
            if (!sets.length) {
                results.subDomains.unchanged++;
                continue;
            }
            vals.push(existing.id);
            await db.run(`UPDATE subDomains SET ${sets.join(', ')} WHERE id = ?`, vals);
            results.subDomains.updated++;
        }
        this._reportDuplicates(results, 'subDomains', dup, 'sub-domain');
    }

    async _importSkills(data, results) {
        const seen = new Set();
        let dup = 0;
        for (const s of data.skills) {
            if (!s.domainName) {
                results.skills.errors.push(`Skill "${s.name}": no domain — row skipped`);
                results.skills.skipped++;
                continue;
            }
            // Identity = (domain, sub-domain, name), the live unique index
            // uq_skill_subdomain_name (sub_domain_id, lower(name)). Keying on
            // (domain, name) alone merged the 10 names that two sub-domains of one
            // domain legitimately share, and reported them as "duplicate rows".
            const key = `${s.domainName}|${s.subDomainName || ''}|${s.name}`.toLowerCase();
            if (seen.has(key)) {
                dup++;
                continue;
            }
            seen.add(key);
            const domain = await this._getOrCreateDomain(s.domainName, results);
            const sub = s.subDomainName
                ? await this._getOrCreateSubDomain(domain.id, s.subDomainName, results)
                : null;
            const existing = sub
                ? await db.get(
                      'SELECT id FROM skills WHERE subDomainId = ? AND LOWER(name) = LOWER(?) AND isActive = true ORDER BY id LIMIT 1',
                      [sub.id, s.name]
                  )
                : // No sub-domain in the file: match any active skill of that name in the
                  // domain (preferring one without a sub-domain), so an older-layout file
                  // re-imported over a sub-domain-linked catalogue never duplicates it.
                  await db.get(
                      'SELECT id FROM skills WHERE domainId = ? AND LOWER(name) = LOWER(?) AND isActive = true ORDER BY (subDomainId IS NULL) DESC, id LIMIT 1',
                      [domain.id, s.name]
                  );
            // The section carries only the identity: a known skill has nothing to
            // correct. Nothing written -> `unchanged`, not `skipped`.
            if (existing) {
                results.skills.unchanged++;
                continue;
            }
            await db.run(
                'INSERT INTO skills (name, domainId, subDomainId, isActive) VALUES (?, ?, ?, true)',
                [s.name, domain.id, sub ? sub.id : null]
            );
            results.skills.created++;
        }
        this._reportDuplicates(results, 'skills', dup, 'skill');
    }

    async _getOrCreateRoleFamily(name, results, description = null) {
        let fam = await db.get(
            'SELECT id, description FROM role_families WHERE LOWER(name) = LOWER(?)',
            [name]
        );
        if (!fam) {
            await db.run(
                "INSERT INTO role_families (name, description, origin, isActive) VALUES (?, ?, 'standard', true)",
                [name, description || null]
            );
            fam = await db.get(
                'SELECT id, description FROM role_families WHERE LOWER(name) = LOWER(?)',
                [name]
            );
            if (results && results.roleFamilies) results.roleFamilies.created++;
        }
        return fam;
    }

    async _importRoleFamilies(data, results) {
        const seen = new Set();
        let dup = 0;
        for (const f of data.roleFamilies || []) {
            const key = f.name.toLowerCase();
            if (seen.has(key)) {
                dup++;
                continue;
            }
            seen.add(key);
            const existing = await db.get(
                'SELECT id, description FROM role_families WHERE LOWER(name) = LOWER(?)',
                [f.name]
            );
            if (!existing) {
                await this._getOrCreateRoleFamily(f.name, results, f.description);
                continue;
            }
            if (f.description && f.description !== (existing.description || '')) {
                await db.run('UPDATE role_families SET description = ? WHERE id = ?', [
                    f.description,
                    existing.id,
                ]);
                results.roleFamilies.updated++;
            } else {
                results.roleFamilies.unchanged++;
            }
        }
        this._reportDuplicates(results, 'roleFamilies', dup, 'role family');
    }

    async _importRoles(data, results) {
        const seen = new Set();
        let dup = 0;
        for (const r of data.roles) {
            const key = r.name.toLowerCase();
            if (seen.has(key)) {
                dup++;
                continue;
            }
            seen.add(key);
            // The family is part of the role's identity in the framework; a file that
            // names one gets it created and linked (56 families were lost on restore).
            const fam = r.roleFamily
                ? await this._getOrCreateRoleFamily(r.roleFamily, results)
                : null;
            const existing = await db.get(
                'SELECT id, description, role_family_id AS roleFamilyId FROM roles WHERE name = ?',
                [r.name]
            );
            if (existing) {
                // Career Level round-trips as the role description. A corrected
                // one used to be applied ONLY when the stored description was
                // empty, so every edit to an already-described role was silently
                // discarded — and reported as `skipped`, which reads as "known,
                // nothing to do". A BLANK cell is not treated as "clear it": the
                // roles_template_IA layout has no such column at all, and wiping
                // 41 descriptions from a file that never carried them would be
                // the same class of silent damage in the other direction.
                const sets = [];
                const vals = [];
                if (r.careerLevel && r.careerLevel !== (existing.description || '')) {
                    sets.push('description = ?');
                    vals.push(r.careerLevel);
                }
                if (fam && Number(existing.roleFamilyId) !== Number(fam.id)) {
                    sets.push('role_family_id = ?');
                    vals.push(fam.id);
                }
                if (sets.length) {
                    vals.push(existing.id);
                    await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, vals);
                    results.roles.updated++;
                } else {
                    results.roles.unchanged++;
                }
                continue;
            }
            await db.run(
                'INSERT INTO roles (name, description, role_family_id, isActive) VALUES (?, ?, ?, true)',
                [r.name, r.careerLevel || '', fam ? fam.id : null]
            );
            results.roles.created++;
        }
        this._reportDuplicates(results, 'roles', dup, 'role');
    }

    // Organization units in their own right (see SECTIONS.organization); the
    // employee pass below still creates whatever a person's row names.
    async _importOrganization(data, results) {
        const seen = new Set();
        for (const u of data.organization || []) {
            const key = `${u.site}|${u.department}|${u.service}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            await this._resolveOrg(u, results);
        }
    }

    async _importRequirements(data, results) {
        for (const req of data.requirements) {
            const role = await db.get('SELECT id FROM roles WHERE name = ?', [req.roleName]);
            if (!role) {
                results.requirements.errors.push(
                    `Requirement: role "${req.roleName}" not found — row skipped`
                );
                results.requirements.skipped++;
                continue;
            }
            // Skill names are NOT unique: merged duplicates keep a soft-retired twin.
            // A bare `WHERE name = ?` with no isActive, no ORDER BY and no LIMIT let
            // PostgreSQL return any matching row — often the retired one — so the
            // requirement landed on a skill no screen shows, while the real
            // requirement on the live twin stayed untouched. The role silently gained
            // a phantom requirement. The shared resolver is deterministic and never
            // returns a retired skill; it is already used by the three other importers.
            // With a sub-domain the lookup is exact (see _resolveSkillInSubDomain).
            const skill =
                (await this._resolveSkillInSubDomain(
                    req.skillName,
                    req.domainName,
                    req.subDomainName
                )) || (await resolveActiveSkillByName(db, req.skillName, req.domainName));
            if (!skill) {
                results.requirements.errors.push(
                    (await isRetiredOnly(db, req.skillName))
                        ? `Requirement: skill "${req.skillName}" is retired (soft-deleted) — row skipped`
                        : `Requirement: skill "${req.skillName}" not found — row skipped`
                );
                results.requirements.skipped++;
                continue;
            }
            const critical = req.isCritical ? true : false;
            const existing = await db.get(
                'SELECT id, requiredLevel, isCritical FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
                [role.id, skill.id]
            );
            if (existing) {
                // Rewriting a row with the values it already holds is not work
                // done; it was counted `skipped`, which read as work NOT done.
                // Both are now named, and an identical row is left untouched
                // (a re-import no longer rewrites 1 932 rows to no effect).
                const same =
                    Number(existing.requiredLevel) === Number(req.requiredLevel) &&
                    Boolean(existing.isCritical) === critical;
                if (same) {
                    results.requirements.unchanged++;
                    continue;
                }
                await db.run(
                    'UPDATE roleSkillRequirements SET requiredLevel = ?, isCritical = ? WHERE id = ?',
                    [req.requiredLevel, critical, existing.id]
                );
                results.requirements.updated++;
            } else {
                await db.run(
                    'INSERT INTO roleSkillRequirements (roleId, skillId, requiredLevel, isCritical) VALUES (?, ?, ?, ?)',
                    [role.id, skill.id, req.requiredLevel, critical]
                );
                results.requirements.created++;
            }
        }
    }

    async _resolveOrg(emp, results) {
        let siteId = null,
            deptId = null,
            serviceId = null;
        if (emp.site) {
            let site = await db.get('SELECT id FROM sites WHERE name = ?', [emp.site]);
            if (!site) {
                await db.run('INSERT INTO sites (name, isActive) VALUES (?, true)', [emp.site]);
                site = await db.get('SELECT id FROM sites WHERE name = ?', [emp.site]);
                results.sites.created++;
            }
            siteId = site.id;
        }
        if (emp.department && siteId) {
            let dept = await db.get('SELECT id FROM departments WHERE name = ? AND siteId = ?', [
                emp.department,
                siteId,
            ]);
            if (!dept) {
                await db.run(
                    'INSERT INTO departments (name, siteId, isActive) VALUES (?, ?, true)',
                    [emp.department, siteId]
                );
                dept = await db.get('SELECT id FROM departments WHERE name = ? AND siteId = ?', [
                    emp.department,
                    siteId,
                ]);
                results.departments.created++;
            }
            deptId = dept.id;
        }
        if (emp.service && deptId) {
            let service = await db.get(
                'SELECT id FROM services WHERE name = ? AND departmentId = ?',
                [emp.service, deptId]
            );
            if (!service) {
                await db.run(
                    'INSERT INTO services (name, departmentId, isActive) VALUES (?, ?, true)',
                    [emp.service, deptId]
                );
                service = await db.get(
                    'SELECT id FROM services WHERE name = ? AND departmentId = ?',
                    [emp.service, deptId]
                );
                results.services.created++;
            }
            serviceId = service.id;
        }
        return { siteId, deptId, serviceId };
    }

    async _importEmployees(data, results, ctx = { empOutcome: new Map() }) {
        for (const emp of data.employees) {
            const { siteId, deptId, serviceId } = await this._resolveOrg(emp, results);
            const role = emp.roleName
                ? await db.get('SELECT id FROM roles WHERE name = ?', [emp.roleName])
                : null;
            if (!siteId || !deptId || !serviceId || !role) {
                results.employees.errors.push(
                    `Employee ${emp.employeeNumber} (${emp.fullName}): missing site/department/service/role — skipped`
                );
                results.employees.skipped++;
                continue;
            }
            const existing = await db.get(
                'SELECT id, firstName, lastName, siteId, departmentId, serviceId, roleId FROM employees WHERE employeeNumber = ?',
                [emp.employeeNumber]
            );
            if (existing) {
                // An existing person was ALWAYS rewritten and counted `skipped`:
                // the operator could not tell a re-imported name/placement change
                // from an import that had done nothing at all.
                const same =
                    String(existing.firstName || '') === String(emp.firstName || '') &&
                    String(existing.lastName || '') === String(emp.lastName || '') &&
                    Number(existing.siteId) === Number(siteId) &&
                    Number(existing.departmentId) === Number(deptId) &&
                    Number(existing.serviceId) === Number(serviceId) &&
                    Number(existing.roleId) === Number(role.id);
                if (same) {
                    results.employees.unchanged++;
                    ctx.empOutcome.set(String(existing.id), 'unchanged');
                    continue;
                }
                await db.run(
                    `
                    UPDATE employees SET firstName = ?, lastName = ?, siteId = ?, departmentId = ?, serviceId = ?, roleId = ?
                    WHERE id = ?
                `,
                    [emp.firstName, emp.lastName, siteId, deptId, serviceId, role.id, existing.id]
                );
                results.employees.updated++;
                ctx.empOutcome.set(String(existing.id), 'updated');
            } else {
                await db.run(
                    `
                    INSERT INTO employees (employeeNumber, firstName, lastName, siteId, departmentId, serviceId, roleId, isActive)
                    VALUES (?, ?, ?, ?, ?, ?, ?, true)
                `,
                    [
                        emp.employeeNumber,
                        emp.firstName,
                        emp.lastName,
                        siteId,
                        deptId,
                        serviceId,
                        role.id,
                    ]
                );
                const created = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    emp.employeeNumber,
                ]);
                results.employees.created++;
                ctx.empOutcome.set(String(created.id), 'created');

                const isTaken = async (name) => {
                    const e = await db.get('SELECT id FROM employees WHERE username = ?', [name]);
                    const a = await db.get('SELECT id FROM admins WHERE username = ?', [name]);
                    return Boolean(e || a);
                };
                const username = await uniqueUsername(
                    baseUsername({
                        firstName: emp.firstName,
                        lastName: emp.lastName,
                        employeeNumber: emp.employeeNumber,
                    }),
                    isTaken
                );
                const password = generatePassword();
                const hash = await bcrypt.hash(password, 10);
                await db.run(
                    'UPDATE employees SET username = ?, password_hash = ?, is_account_active = true, force_password_change = true WHERE id = ?',
                    [username, hash, created.id]
                );
                results.credentials.push({
                    type: 'employee',
                    employeeNumber: emp.employeeNumber,
                    name: emp.fullName,
                    username,
                    password,
                });
            }
        }
    }

    async _linkHierarchy(data, results, ctx = { empOutcome: new Map() }) {
        const rows = await db.all(
            'SELECT id, firstName, lastName, supervisor_id AS "supervisorId", manager_id AS "managerId", manager_type AS "managerType", is_active AS "isActive" FROM employees'
        );
        // 3.23.18 — the reporting lines as they stand, kept current as this
        // pass writes, so a loop is refused against the database PLUS the rows
        // already linked from this same file. Same rule as
        // EmployeeModel.wouldCreateReportingCycle (both lines; a link only
        // carries through an ACTIVE person), answered in memory: one read for the
        // whole file instead of a sub-tree walk per row.
        const lines = new Map();
        for (const r of rows) {
            lines.set(Number(r.id), {
                sup: r.supervisorId == null ? null : Number(r.supervisorId),
                mgr:
                    r.managerId != null && (r.managerType || 'employee') === 'employee'
                        ? Number(r.managerId)
                        : null,
                active: r.isActive !== false,
            });
        }
        const wouldLoop = (employeeId, candidateId) => {
            const eid = Number(employeeId);
            const cid = Number(candidateId);
            if (eid === cid) return true;
            const seen = new Set([cid]);
            const stack = [cid];
            while (stack.length) {
                const n = stack.pop();
                if (n === eid) return true;
                const l = lines.get(n);
                if (!l || !l.active) continue;
                for (const p of [l.sup, l.mgr]) {
                    if (p != null && !seen.has(p)) {
                        seen.add(p);
                        stack.push(p);
                    }
                }
            }
            return false;
        };
        const nameToIds = new Map();
        for (const r of rows) {
            const key = `${r.firstName} ${r.lastName}`.replace(/\s+/g, ' ').trim().toLowerCase();
            if (!nameToIds.has(key)) nameToIds.set(key, []);
            nameToIds.get(key).push(r.id);
        }
        const resolve = (name, who, emp) => {
            const key = cellText(name).replace(/\s+/g, ' ').trim().toLowerCase();
            if (!key) return null;
            const ids = nameToIds.get(key);
            if (!ids || ids.length === 0) {
                results.warnings.push(
                    `${who} "${name}" for ${emp.employeeNumber} not found — left blank`
                );
                return null;
            }
            if (ids.length > 1) {
                results.warnings.push(
                    `${who} "${name}" for ${emp.employeeNumber} is ambiguous — left blank`
                );
                return null;
            }
            return ids[0];
        };
        for (const emp of data.employees) {
            const self = await db.get(
                'SELECT id, manager_id AS managerId, manager_type AS managerType, supervisorId FROM employees WHERE employeeNumber = ?',
                [emp.employeeNumber]
            );
            if (!self) continue;
            // An EMPTY cell is an absence, not an instruction to delete.
            //
            // This wiped real reporting lines. The export joins `employees` on
            // manager_id with no manager_type guard, so an employee managed by an
            // ADMIN exported a BLANK Manager cell; re-importing the untouched file
            // then read that blank as "remove the manager" and wrote
            // manager_id = NULL, manager_type = NULL. Measured on a straight
            // export -> import round trip with no edits at all:
            //     emp 287/288/289/290 -> managerId "33" => null, managerType "admin" => null
            // Four true links destroyed, reported only as the neutral
            // `employees.updated: 4`, with no warning of any kind.
            //
            // A name that does not resolve is treated the same way: a typo must not
            // detach somebody either. It already warns; now it also keeps the link.
            // Clearing a manager is done deliberately in the app, never by omission
            // in a spreadsheet — the same rule as everywhere else in this codebase:
            // an absence of data is not a result.
            const keepMgr = self.managerId == null ? null : Number(self.managerId);
            const keepSup = self.supervisorId == null ? null : Number(self.supervisorId);
            const managerId = emp.managerName ? resolve(emp.managerName, 'Manager', emp) : null;
            const supervisorId = emp.supervisorName
                ? resolve(emp.supervisorName, 'Supervisor', emp)
                : null;
            let safeMgr = managerId && managerId !== self.id ? managerId : null;
            let safeSup = supervisorId && supervisorId !== self.id ? supervisorId : null;
            let keptMgrType = null;
            // 3.23.18 — NO REPORTING LOOP, NO SELF-LINE. A NEW employee link
            // the file supplies is refused when the candidate already sits in this
            // person's sub-tree (wouldLoop above — both lines, as the app's own
            // forms check them) or IS this person. The row keeps the link it had,
            // the refusal is a row-level error, and the import carries on. A loop
            // spread across two rows of the same file is caught at the second.
            const refuse = (candidate, who, name) => {
                if (candidate == null) return false;
                if (wouldLoop(self.id, candidate)) {
                    results.employees.errors.push(
                        `Employee ${emp.employeeNumber}: ${who} "${name}" would create a reporting loop (or points at the person themselves) — link not changed`
                    );
                    return true;
                }
                return false;
            };
            const sameEmpMgr =
                safeMgr != null &&
                Number(safeMgr) === keepMgr &&
                (self.managerType || 'employee') === 'employee';
            if (safeMgr != null && !sameEmpMgr && refuse(safeMgr, 'Manager', emp.managerName))
                safeMgr = null;
            if (
                safeSup != null &&
                Number(safeSup) !== keepSup &&
                refuse(safeSup, 'Supervisor', emp.supervisorName)
            )
                safeSup = null;
            if (safeMgr == null && keepMgr != null) {
                safeMgr = keepMgr;
                keptMgrType = self.managerType || null;
            }
            if (safeSup == null && keepSup != null) safeSup = keepSup;
            // This pass rewrote EVERY employee row unconditionally, so a summary
            // saying "nothing changed" would have been false for 79 of 80 people.
            // Write only when the link actually differs, and when it does, say so.
            // manager_type is required by chk_employees_manager_pair whenever
            // manager_id is set. A link the FILE supplied is an employee; a link we
            // are merely PRESERVING keeps whatever type it already had (an
            // admin-managed employee must not be silently reclassified).
            const nextMgrType = safeMgr == null ? null : keptMgrType || 'employee';
            const same =
                (self.managerId == null ? null : Number(self.managerId)) ===
                    (safeMgr == null ? null : Number(safeMgr)) &&
                (self.supervisorId == null ? null : Number(self.supervisorId)) ===
                    (safeSup == null ? null : Number(safeSup)) &&
                (self.managerType || null) === nextMgrType;
            if (same) continue;
            await db.run(
                'UPDATE employees SET manager_id = ?, manager_type = ?, supervisorId = ? WHERE id = ?',
                [safeMgr, nextMgrType, safeSup, self.id]
            );
            {
                const cur = lines.get(Number(self.id)) || { active: true };
                lines.set(Number(self.id), {
                    ...cur,
                    sup: safeSup == null ? null : Number(safeSup),
                    mgr: safeMgr != null && nextMgrType === 'employee' ? Number(safeMgr) : null,
                });
            }
            if (ctx.empOutcome.get(String(self.id)) === 'unchanged') {
                ctx.empOutcome.set(String(self.id), 'updated');
                results.employees.unchanged--;
                results.employees.updated++;
            }
        }
    }

    async _importAssessments(data, results, adminId) {
        // assessed_by → admins(id); resolve a real assessor rather than hard-coding
        // 1 (which FK-violates and rolls back the whole import on a DB without admin 1).
        let assessor = adminId;
        if (!assessor) {
            const a =
                (await db.get("SELECT id FROM admins WHERE username = 'admin' LIMIT 1")) ||
                (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
            assessor = a ? a.id : null;
        }
        // The file's "Assessed By" label resolves to an admins.id; only a row that
        // carries none is attributed to the importer. Before this every re-import
        // re-attributed ALL assessments to the importer (68 x 2 712 -> 1 x 2 714).
        const { byName: adminByName, byId: adminById } = await buildAdminMaps();
        for (const a of data.assessments) {
            const employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                a.employeeNumber,
            ]);
            if (!employee) {
                results.assessments.errors.push(
                    `Assessment: employee "${a.employeeNumber}" not found — row skipped`
                );
                results.assessments.skipped++;
                continue;
            }
            // Same resolution rule as the requirements above: an assessment must
            // never be written onto a soft-retired twin of the skill.
            const skill =
                (await this._resolveSkillInSubDomain(a.skillName, a.domainName, a.subDomainName)) ||
                (await resolveActiveSkillByName(db, a.skillName, a.domainName));
            if (!skill) {
                results.assessments.errors.push(
                    (await isRetiredOnly(db, a.skillName))
                        ? `Assessment: skill "${a.skillName}" is retired (soft-deleted) — row skipped`
                        : `Assessment: skill "${a.skillName}" not found — row skipped`
                );
                results.assessments.skipped++;
                continue;
            }
            const rowAssessor = resolveAssessorId(a.assessedBy, adminByName, adminById, assessor);
            // A note the file does not carry is an absence: COALESCE keeps the stored one.
            const notes = a.notes == null || a.notes === '' ? null : String(a.notes);
            const existing = await db.get(
                'SELECT id, currentLevel, assessedBy, assessedAt, notes FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                [employee.id, skill.id]
            );
            // Preserve the date the file carries. An absent or unreadable one falls
            // back to now, so the previous behaviour becomes the fallback rather
            // than the rule — a re-import no longer restamps the whole history.
            const parsedAt = a.assessedAt ? new Date(a.assessedAt) : null;
            const assessedAt =
                parsedAt && !Number.isNaN(parsedAt.getTime()) ? parsedAt.toISOString() : null;
            if (existing) {
                // The level, the assessor AND the date are all rewritten here, so
                // "nothing changed" may only be claimed when all three already
                // match. This is the row that made the finding: 2 714 assessments
                // were physically rewritten and reported `skipped`. A row that
                // already matches is now left completely untouched — its original
                // assessor is no longer re-attributed to the importer.
                const sameLevel = Number(existing.currentLevel) === Number(a.currentLevel);
                const sameAssessor = String(existing.assessedBy) === String(rowAssessor);
                const sameDate =
                    !!assessedAt &&
                    !!existing.assessedAt &&
                    new Date(existing.assessedAt).getTime() === new Date(assessedAt).getTime();
                const sameNotes =
                    notes === null ||
                    notes === String(existing.notes == null ? '' : existing.notes);
                if (sameLevel && sameAssessor && sameDate && sameNotes) {
                    results.assessments.unchanged++;
                    continue;
                }
                await db.run(
                    'UPDATE skillAssessments SET currentLevel = ?, assessedBy = ?, notes = COALESCE(?, notes), assessedAt = COALESCE(?::timestamptz, now()) WHERE id = ?',
                    [a.currentLevel, rowAssessor, notes, assessedAt, existing.id]
                );
                results.assessments.updated++;
            } else {
                await db.run(
                    'INSERT INTO skillAssessments (employeeId, skillId, currentLevel, assessedBy, notes, assessedAt) VALUES (?, ?, ?, ?, ?, COALESCE(?::timestamptz, now()))',
                    [employee.id, skill.id, a.currentLevel, rowAssessor, notes, assessedAt]
                );
                results.assessments.created++;
            }
        }
    }
}

const instance = new SkillMatrixWorkbookService();
// Expose pure helpers + format constants for unit tests.
instance.normalizeHeader = normalizeHeader;
instance.parseBoolish = parseBoolish;
instance.normalizeLevel = normalizeLevel;
instance.parseEmployeeName = parseEmployeeName;
instance.buildHeaderIndex = buildHeaderIndex;
instance.cellText = cellText;
instance.detectFormat = detectFormat;
instance.SUPPORTED_FORMATS = SUPPORTED_FORMATS;
// _modelToJson/_modelToXml/_modelToCsv/_workbookToModel/_jsonToModel/_xmlToModel/
// _csvToModel/_modelToInternal are already on the instance via the prototype and
// are used directly by unit tests.

module.exports = instance;
