/**
 * QualifiedPeopleService — the operational lookup a shift supervisor needs:
 *
 *   "Who on this site can do skill X at level >= N, with a valid certificate,
 *    and is not away this week?"
 *
 * Everything it needs already existed as separate pieces (resolved assessment
 * levels, current certifications, skill currency, planned absences); what was
 * missing was the question. This turns the talent database into a dispatch
 * tool, which is the one use that gets a site supervisor to open the app
 * without being asked to.
 *
 * RBAC: scoped BEFORE aggregation like every other read surface — a manager can
 * only ever see people they govern.
 */
const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { personNameSql } = require('../utils/personName');

const QualifiedPeopleService = {
    /**
     * Certificate states that mean "valid TODAY". Mirrors v_coverage_status and
     * CoverageService — a permanent licence (no_expiry) and one inside its
     * revalidation window (expiring) are both currently valid.
     */
    VALID_NOW: new Set(['valid', 'expiring', 'no_expiry']),

    /** Skills that can be searched, newest-first by usage in role requirements. */
    async searchSkills(term, limit = 20) {
        const t = String(term || '').trim();
        if (t.length < 2) return [];
        // NOTE: no quoted alias in ORDER BY — the sql-compat layer rewrites
        // identifiers and mangles a quoted alias there. Order by the expression.
        return db.all(
            `SELECT s.id, s.name,
                    (SELECT COUNT(*) FROM role_skill_requirements r WHERE r.skill_id = s.id) AS "usedByRoles"
             FROM skills s
             WHERE LOWER(s.name) LIKE ?
             ORDER BY (SELECT COUNT(*) FROM role_skill_requirements r2 WHERE r2.skill_id = s.id) DESC, s.name
             LIMIT ${Number(limit) || 20}`,
            [`%${t.toLowerCase()}%`]
        );
    },

    /**
     * @param opts.skillId      required
     * @param opts.minLevel     default 1
     * @param opts.siteName     optional filter
     * @param opts.departmentName optional filter
     * @param opts.certifiedOnly only people holding a currently valid certificate
     * @param opts.availableOn  ISO date — exclude anyone with a planned absence covering it
     */
    async find(user, opts = {}) {
        const skillId = parseInt(opts.skillId, 10);
        if (!Number.isFinite(skillId)) return { rows: [], skill: null };

        const minLevel = Number.isFinite(Number(opts.minLevel))
            ? Math.max(0, Math.min(4, Number(opts.minLevel)))
            : 1;

        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return { rows: [], skill: null };

        const skill = await db.get('SELECT id, name FROM skills WHERE id = ?', [skillId]);
        if (!skill) return { rows: [], skill: null };

        // A LAPSED statutory certificate degrades the qualification to 0 for that
        // skill (migration 78) — readiness, the benchmark and the succession bench
        // all honour it. This dispatch list read the RAW level, so a person whose
        // ticket had expired stayed at the top of "who can do this now", inside a
        // `minLevel >= 3` filter, with their original level. The only contradiction
        // shown was a "cert_expired" badge that sorts after "away". Sending that
        // person is the operational risk the certificate exists to prevent.
        const CertificationService = require('./CertificationService');
        const LAPSED = CertificationService.lapsedExistsSql('e.id', 'ra.skill_id');
        const EFFECTIVE_LEVEL = `CASE WHEN ${LAPSED} THEN 0 ELSE ra.level END`;
        const where = ['ra.skill_id = ?', `${EFFECTIVE_LEVEL} >= ?`, 'e.is_active = true'];
        const params = [skillId, minLevel];
        if (Array.isArray(ids)) {
            where.push(`e.id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        if (opts.siteName) {
            where.push('s.name = ?');
            params.push(opts.siteName);
        }
        if (opts.departmentName) {
            where.push('d.name = ?');
            params.push(opts.departmentName);
        }

        // Certification and currency are LEFT JOINed so the lookup still works on an
        // instance with no certificate register — the columns simply come back null
        // rather than the whole query returning nothing.
        const rows = await db.all(
            `SELECT e.id                AS "employeeId",
                    e.employee_number   AS "employeeNumber",
                    ${personNameSql('e')} AS "name",
                    s.name              AS "siteName",
                    d.name              AS "departmentName",
                    r.name              AS "roleName",
                    ${EFFECTIVE_LEVEL}  AS "level",
                    ra.level            AS "rawLevel",
                    ra.assessed_at      AS "assessedAt",
                    cc.cert_status      AS "certStatus",
                    cc.expires_on       AS "certExpiresOn",
                    sc.is_lapsed        AS "isLapsed",
                    (SELECT MIN(pa.starts_on) FROM planned_absences pa
                      WHERE pa.employee_id = e.id AND pa.ends_on >= CURRENT_DATE) AS "nextAbsenceFrom",
                    EXISTS (SELECT 1 FROM planned_absences pa
                             WHERE pa.employee_id = e.id
                               AND pa.starts_on <= COALESCE(?::date, CURRENT_DATE)
                               AND pa.ends_on   >= COALESCE(?::date, CURRENT_DATE)) AS "awayOnDate"
             FROM v_resolved_assessments ra
             JOIN employees e ON e.id = ra.employee_id
             LEFT JOIN sites       s ON s.id = e.site_id
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN roles       r ON r.id = e.role_id
             LEFT JOIN v_certification_current cc ON cc.employee_id = e.id AND cc.skill_id = ra.skill_id
             LEFT JOIN v_skill_currency        sc ON sc.employee_id = e.id AND sc.skill_id = ra.skill_id
             WHERE ${where.join(' AND ')}
             ORDER BY ${EFFECTIVE_LEVEL} DESC, e.last_name`,
            [opts.availableOn || null, opts.availableOn || null, ...params]
        );

        // "Valid today" is valid | expiring | no_expiry — the same set
        // v_coverage_status and CoverageService use. Keeping only 'valid' dropped
        // every holder of a PERMANENT licence and everyone inside their
        // revalidation window from the dispatch list, while the compliance page
        // counted those same people as covered: two screens contradicting each
        // other, and the loss shows up as an ABSENT ROW, which a shift supervisor
        // cannot notice.
        const filtered = opts.certifiedOnly
            ? rows.filter((r) => QualifiedPeopleService.VALID_NOW.has(r.certStatus))
            : rows;

        return {
            skill,
            minLevel,
            rows: filtered.map((r) => ({
                ...r,
                // A single readable verdict, so the supervisor does not have to
                // reason across three columns under time pressure.
                readiness: r.awayOnDate
                    ? 'away'
                    : r.certStatus === 'expired'
                      ? 'cert_expired'
                      : r.isLapsed
                        ? 'lapsed'
                        : r.certStatus === 'expiring'
                          ? 'cert_expiring'
                          : 'available',
            })),
        };
    },

    /** Filter options drawn from the caller's scope. */
    async filterOptions(user) {
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return { sites: [], departments: [] };
        const scope = Array.isArray(ids) ? `AND e.id IN (${ids.map(() => '?').join(',')})` : '';
        const p = Array.isArray(ids) ? ids : [];
        const sites = await db.all(
            `SELECT DISTINCT s.name AS "name" FROM employees e JOIN sites s ON s.id = e.site_id
             WHERE e.is_active = true ${scope} ORDER BY "name"`,
            p
        );
        const departments = await db.all(
            `SELECT DISTINCT d.name AS "name" FROM employees e JOIN departments d ON d.id = e.department_id
             WHERE e.is_active = true ${scope} ORDER BY "name"`,
            p
        );
        return { sites: sites.map((r) => r.name), departments: departments.map((r) => r.name) };
    },
};

module.exports = QualifiedPeopleService;
