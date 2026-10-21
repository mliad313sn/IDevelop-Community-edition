'use strict';

/**
 * DataQualityService — « Data quality » (/admin/data-quality, 4.0.0 port wave
 * 10): the counts that keep the indicators from being measured, by section.
 * INVENTORY COUNTS, not indicators: each row says how many records lack
 * something, out of how many, and links to the page where they are fixed.
 *
 * Sections and the permission that opens each (a section is computed only
 * for a reader who may open its module; SuperAdmin sees all):
 *   people        view_employees          the reader's cleared population
 *   framework     view_domains_skills or view_roles   the shared catalogue
 *   development   view_employees + the development module   the population
 *   certificates  view_compliance or manage_compliance  the population
 *   snapshots     SuperAdmin              the nightly KPI snapshots
 *   audit         SuperAdmin or view_system_logs      the audit trail
 *   privacy       SuperAdmin              erasure, retention, admin accounts
 *
 * Rules every row follows:
 *   - a count is « no anomaly » only when its population is > 0; an empty
 *     population is « nothing concerned », never 0 % and never « done »;
 *   - « not configured » and « not measured » (unavailable) are states, never
 *     a count of 0;
 *   - fewer than 5 records: the count, no %; a non-zero count never prints
 *     « 0.0 % » (`tiny`);
 *   - no person name, no person id: the « Open » link goes to the module page,
 *     which carries its own permission;
 *   - the nationality row exists only while the local-content module is on.
 * Row states are English codes (the page translates them):
 *   not_configured · unavailable · empty · clean · complete · todo · info
 *
 * It reuses the services that already define each figure: the readiness
 * measurability of the dashboard (KpiService K1, DashboardHomeService), the
 * skill-description report (SkillDescriptionService), the certificate record
 * quality (HseOpsService K44), the « nobody reviews » rule (reviewerGapSql)
 * and the audit-chain verifier (AuditRetentionService).
 */

const db = require('../config/database');

const SMALL_N = 5;
const DAY_WINDOW = 90;
const ANCHOR_STALE_DAYS = 7;
const SEAL_GRACE_DAY = 5;
const PANEL_PATH = '/admin/data-quality';

/** The permissions that open the page (any one; SuperAdmin passes). */
const PANEL_SLUGS = Object.freeze([
    'view_employees',
    'view_domains_skills',
    'view_roles',
    'view_compliance',
    'manage_compliance',
    'view_system_logs',
]);

/** The section order of the page. */
const SECTIONS = Object.freeze([
    'people',
    'framework',
    'development',
    'certificates',
    'snapshots',
    'audit',
    'privacy',
]);

/** Snapshot columns watched for « never filled in 90 days » (labels: admin:dq_col_*). */
const SNAPSHOT_COLUMNS = Object.freeze([
    'avg_readiness',
    'assessment_coverage',
    'critical_compliance',
    'certs_expiring_90d',
    'certs_expired',
    'safety_fit_pct',
    'bench_strength_pct',
    'bench_critical_roles',
    'critical_roles_without_ready',
]);

/** The K44 fill rates and the row each one feeds (fixed). */
const CERT_RATES = Object.freeze([
    ['dated', 'cert_not_dated'],
    ['evidence', 'cert_no_evidence'],
    ['voc', 'cert_no_signoff'],
    ['numbered', 'cert_no_number'],
    ['issuer', 'cert_no_issuer'],
]);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The status of ONE row, decided on what the page prints.
 * @returns {{tone:string, status:string}}
 */
function rowStatus(row) {
    const r = row || {};
    if (r.state === 'not_configured') return { tone: 'unmeasured', status: 'not_configured' };
    if (r.state === 'unavailable') return { tone: 'unmeasured', status: 'unavailable' };
    if (r.state === 'info')
        return r.alert ? { tone: 'risk', status: 'todo' } : { tone: 'neutral', status: 'info' };
    const pop = num(r.population);
    if (pop !== null && pop <= 0) return { tone: 'neutral', status: 'empty' };
    const c = num(r.count);
    if (c === null) return { tone: 'unmeasured', status: 'unavailable' };
    if (c === 0) return { tone: 'good', status: 'clean' };
    return r.alert ? { tone: 'risk', status: 'todo' } : { tone: 'warn', status: 'complete' };
}

/**
 * The share beside a count: null without a population, under 5, or when the
 * row is not a count. One decimal, rounded half up; a non-zero count that
 * rounds to 0.0 is flagged `tiny` (« under 0.1 % »), never printed as 0.
 * @returns {{pct:number|null, tiny:boolean}}
 */
function rowShare(count, population) {
    const c = num(count);
    const p = num(population);
    if (c === null || p === null || p <= 0 || p < SMALL_N) return { pct: null, tiny: false };
    const pct = Math.round((1000 * c) / p) / 10;
    return { pct, tiny: c > 0 && pct === 0 };
}

/** A raw row decorated with its status and share. Pure. */
function finishRow(row) {
    const st = rowStatus(row);
    const sh =
        row.state === 'info' || row.state === 'not_configured' || row.state === 'unavailable'
            ? { pct: null, tiny: false }
            : rowShare(row.count, row.population);
    return { ...row, status: st.status, tone: st.tone, pct: sh.pct, tiny: sh.tiny };
}

/**
 * The month that must be sealed by now (YYYY-MM), or null before the grace
 * day (the 5th). Pure.
 */
function sealDueMonth(today) {
    const d = today instanceof Date ? today : new Date(today);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getUTCDate() <= SEAL_GRACE_DAY) return null;
    const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
    return `${y}-${String(m).padStart(2, '0')}`;
}

/** The anchor job needs attention: its last run failed, or no success for a week. Pure. */
function anchorAlert({ fresh, lastRunOk }) {
    return lastRunOk === false || !fresh;
}

/** The viewer's reach. */
function permsOf(viewer) {
    const RBACService = require('./RBACService');
    const u = viewer || {};
    const isAdmin = u.userType === 'admin';
    const sa = isAdmin && RBACService.isSuperAdmin(u);
    const can = (slug) => isAdmin && (sa || RBACService.hasPermission(u, slug));
    return { sa, isAdmin, can };
}

/** May this reader open the page at all? */
function canSeePanel(viewer) {
    const p = permsOf(viewer);
    return p.isAdmin && (p.sa || PANEL_SLUGS.some((s) => p.can(s)));
}

/** The sections a reader sees, in page order; `flags` = the module switches. */
function sectionsFor(viewer, flags = {}) {
    const p = permsOf(viewer);
    if (!p.isAdmin) return [];
    const on = (m) => !!(flags && flags[m] === true);
    const show = {
        people: p.can('view_employees'),
        framework: p.can('view_domains_skills') || p.can('view_roles'),
        development: on('development') && p.can('view_employees'),
        certificates: p.can('view_compliance') || p.can('manage_compliance'),
        snapshots: p.sa,
        audit: p.sa || p.can('view_system_logs'),
        privacy: p.sa,
    };
    return SECTIONS.filter((k) => show[k]);
}

// ---------------------------------------------------------------------------
// Sections (each returns raw rows; `ids` = the resolved, cleared population)
// ---------------------------------------------------------------------------

async function peopleSection(ids, { lc, can, scope }) {
    const population = ids.length;
    const href = '/employees';
    const rolesHref = can('view_roles') ? '/roles' : null;
    const keys = [
        'no_line',
        'no_site',
        'no_role',
        'no_requirement',
        'not_assessed',
        'no_role_start',
    ];
    if (lc) keys.push('no_nationality');
    if (!population) return keys.map((key) => ({ key, count: 0, population: 0, href }));
    const { missingReviewerSql } = require('../utils/reviewerGapSql');
    const r = await db.get(
        `SELECT COUNT(*) FILTER (WHERE ${missingReviewerSql('e')}) AS "noLine",
                COUNT(*) FILTER (WHERE e.site_id IS NULL) AS "noSite",
                COUNT(*) FILTER (WHERE e.role_id IS NULL) AS "noRole",
                COUNT(*) FILTER (WHERE e.role_start_date IS NULL) AS "noStart",
                COUNT(*) FILTER (WHERE NULLIF(BTRIM(e.nationality), '') IS NULL) AS "noNat"
           FROM employees e WHERE e.id = ANY(?)`,
        [ids]
    );
    // « No requirement » and « not assessed yet » are the dashboard's own
    // measurability (K1): two different reasons, never one « not measurable ».
    const k1 = await require('./KpiService').compute('K1', scope);
    const m = require('./DashboardHomeService').measurability(k1, null);
    const rows = [
        {
            key: 'no_line',
            count: Number(r.noLine) || 0,
            population,
            alert: true,
            href: '/employees?missingReviewer=1',
        },
        { key: 'no_site', count: Number(r.noSite) || 0, population, href },
        { key: 'no_role', count: Number(r.noRole) || 0, population, href },
        m && !m.emptyScope
            ? { key: 'no_requirement', count: m.noRequirement, population, href: rolesHref }
            : {
                  key: 'no_requirement',
                  state: 'unavailable',
                  count: null,
                  population,
                  href: rolesHref,
              },
        m && !m.emptyScope
            ? { key: 'not_assessed', count: m.notAssessed, population, href: '/skill-matrix' }
            : {
                  key: 'not_assessed',
                  state: 'unavailable',
                  count: null,
                  population,
                  href: '/skill-matrix',
              },
        { key: 'no_role_start', count: Number(r.noStart) || 0, population, href },
    ];
    if (lc) rows.push({ key: 'no_nationality', count: Number(r.noNat) || 0, population, href });
    return rows;
}

async function frameworkSection({ can, flags }) {
    const skillsHref = can('view_domains_skills') ? '/domains-skills' : null;
    const rolesHref = can('view_roles') ? '/roles' : null;
    const rows = [];
    if (can('view_domains_skills')) {
        // The skill-description report of « Skill quality » — one definition.
        const q = await require('./SkillDescriptionService').qualityReport({ limit: 0 });
        const c = (q && q.counts) || {};
        rows.push(
            {
                key: 'skill_no_description',
                count: Number(c.missingDescription) || 0,
                population: Number(c.used) || 0,
                href: '/framework/quality',
            },
            {
                key: 'skill_few_anchors',
                count: Number(c.fewAnchors) || 0,
                population: Number(c.used) || 0,
                href: '/framework/quality',
            }
        );
    }
    const r = await db.get(
        `WITH sk AS (SELECT id FROM skills WHERE is_active),
              ro AS (SELECT id FROM roles WHERE is_active),
              req AS (SELECT DISTINCT q.role_id, q.skill_id FROM role_skill_requirements q
                        JOIN roles x ON x.id = q.role_id AND x.is_active
                       WHERE q.required_level > 0)
         SELECT (SELECT COUNT(*) FROM sk) AS "skills",
                (SELECT COUNT(*) FROM sk WHERE NOT EXISTS (SELECT 1 FROM req WHERE req.skill_id = sk.id)) AS "skillNoRole",
                (SELECT COUNT(*) FROM ro) AS "roles",
                (SELECT COUNT(*) FROM ro WHERE NOT EXISTS (SELECT 1 FROM req WHERE req.role_id = ro.id)) AS "noReq",
                (SELECT COUNT(*) FROM ro WHERE NOT EXISTS (SELECT 1 FROM role_criticality rc WHERE rc.role_id = ro.id)) AS "noCrit",
                (SELECT COUNT(*) FROM role_criticality) AS "critRows"`
    );
    if (can('view_domains_skills'))
        rows.push({
            key: 'skill_no_role',
            count: Number(r.skillNoRole) || 0,
            population: Number(r.skills) || 0,
            href: skillsHref,
        });
    if (can('view_roles'))
        rows.push({
            key: 'role_no_requirement',
            count: Number(r.noReq) || 0,
            population: Number(r.roles) || 0,
            href: rolesHref,
        });
    // Critical roles belong to the talent module (succession): no row while it is off.
    if (flags && flags.talent === true && can('view_roles')) {
        const href = can('view_continuity') || can('manage_succession') ? '/v2/continuity' : null;
        rows.push(
            Number(r.critRows) > 0
                ? {
                      key: 'role_no_criticality',
                      count: Number(r.noCrit) || 0,
                      population: Number(r.roles) || 0,
                      href,
                  }
                : {
                      key: 'role_no_criticality',
                      state: 'not_configured',
                      count: null,
                      population: Number(r.roles) || 0,
                      href,
                  }
        );
    }
    return rows;
}

async function developmentSection(ids) {
    const href = '/v2/idp/manage';
    if (!ids.length)
        return ['action_no_due', 'plan_no_action'].map((key) => ({
            key,
            count: 0,
            population: 0,
            href,
        }));
    const r = await db.get(
        `WITH p AS (SELECT id FROM idp_plans
                     WHERE employee_id = ANY(?) AND status::text IN ('draft', 'active')),
              a AS (SELECT a.id, a.idp_id, a.due_on FROM idp_actions a
                     WHERE a.idp_id IN (SELECT id FROM p)
                       AND a.status::text NOT IN ('completed', 'cancelled'))
         SELECT (SELECT COUNT(*) FROM a) AS "open",
                (SELECT COUNT(*) FROM a WHERE a.due_on IS NULL) AS "noDue",
                (SELECT COUNT(*) FROM p) AS "plans",
                (SELECT COUNT(*) FROM p WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.idp_id = p.id)) AS "noAction"`,
        [ids]
    );
    return [
        {
            key: 'action_no_due',
            count: Number(r.noDue) || 0,
            population: Number(r.open) || 0,
            href,
        },
        {
            key: 'plan_no_action',
            count: Number(r.noAction) || 0,
            population: Number(r.plans) || 0,
            href,
        },
    ];
}

async function certificatesSection(scope, { can }) {
    const href = can('view_compliance') || can('manage_compliance') ? '/compliance' : null;
    const keys = ['cert_missing', ...CERT_RATES.map(([, k]) => k)];
    // The certificate record quality of the Safety tab (K44): one definition.
    const k44 = await require('./HseOpsService').k44CertificateQuality(scope);
    if (k44.emptyScope) return keys.map((key) => ({ key, count: 0, population: 0, href }));
    if (k44.status === 'not_configured')
        return keys.map((key) => ({
            key,
            state: 'not_configured',
            count: null,
            population: null,
            href,
        }));
    const b = k44.breakdown || {};
    const recorded = Number(b.recorded) || 0;
    const missing = Number(b.missing) || 0;
    const rows = [
        { key: 'cert_missing', count: missing, population: recorded + missing, alert: true, href },
    ];
    for (const [rate, key] of CERT_RATES) {
        const x = k44.rates && k44.rates[rate];
        rows.push(
            x && recorded
                ? { key, count: recorded - (Number(x.filled) || 0), population: recorded, href }
                : { key, count: 0, population: 0, href }
        );
    }
    return rows;
}

async function snapshotsSection() {
    const href = '/admin/health';
    const w = await db.get(
        `WITH b AS (
             SELECT CASE WHEN MIN(snapshot_date) IS NULL THEN NULL
                         ELSE GREATEST(MIN(snapshot_date), CURRENT_DATE - ${DAY_WINDOW - 1}) END AS d0
               FROM kpi_snapshots WHERE scope_type = 'org'
         )
         SELECT (SELECT COUNT(*) FROM generate_series(b.d0, CURRENT_DATE, interval '1 day') g(d)) AS "days",
                (SELECT COUNT(*) FROM generate_series(b.d0, CURRENT_DATE, interval '1 day') g(d)
                  WHERE NOT EXISTS (SELECT 1 FROM kpi_snapshots k
                                     WHERE k.scope_type = 'org' AND k.snapshot_date = g.d::date)) AS "missing",
                b.d0 IS NOT NULL AS "any"
           FROM b`
    );
    if (!w || !(w.any === true || w.any === 't'))
        return ['snap_missing_days', 'snap_never_filled'].map((key) => ({
            key,
            state: 'not_configured',
            count: null,
            population: null,
            href,
        }));
    const filled = SNAPSHOT_COLUMNS.map((c) => `COUNT(${c}) AS "${c}"`).join(', ');
    const f = await db.get(
        `SELECT ${filled} FROM kpi_snapshots WHERE snapshot_date >= CURRENT_DATE - ${DAY_WINDOW - 1}`
    );
    // the compat layer camelCases the keys: read either spelling
    const camel = (s) => s.replace(/_([a-z0-9])/g, (_, x) => x.toUpperCase());
    const never = SNAPSHOT_COLUMNS.filter((c) => {
        const v = f ? (f[c] !== undefined ? f[c] : f[camel(c)]) : null;
        return Number(v) === 0;
    });
    return [
        {
            key: 'snap_missing_days',
            count: Number(w.missing) || 0,
            population: Number(w.days) || 0,
            href,
        },
        {
            key: 'snap_never_filled',
            count: never.length,
            population: SNAPSHOT_COLUMNS.length,
            columns: never,
            href,
        },
    ];
}

async function auditSection({ sa, can }) {
    const logsHref = can('view_system_logs') ? '/system-logs' : null;
    const healthHref = sa ? '/admin/health' : null;
    const rows = [];
    let v = null;
    try {
        v = await require('./AuditRetentionService').verify(5);
    } catch (_) {
        v = null;
    }
    if (!v) {
        rows.push({
            key: 'audit_chain',
            state: 'unavailable',
            count: null,
            population: null,
            href: logsHref,
        });
    } else {
        const hashed = Number(v.hashedRows) || 0;
        const nBroken = (v.brokenAt || []).length;
        rows.push({
            key: 'audit_chain',
            count: v.intact === false && nBroken === 0 ? 1 : nBroken,
            population: hashed,
            alert: true,
            facts: { unhashed: Number(v.unhashedRows) || 0, seals: Number(v.seals) || 0 },
            href: logsHref,
        });
        const last = v.lastSeal && v.lastSeal.period ? String(v.lastSeal.period) : null;
        const today = await db.get(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS "d"`);
        const due = sealDueMonth(today ? `${today.d}T12:00:00Z` : new Date());
        rows.push({
            key: 'audit_seal',
            state: 'info',
            alert: !!(due && (!last || last < due)),
            facts: { last, due },
            href: logsHref,
        });
    }
    const a = await db.get(
        `SELECT MAX(started_at) FILTER (WHERE ok) AS "lastOk",
                COUNT(*) FILTER (WHERE NOT ok AND started_at > COALESCE(
                    (SELECT MAX(started_at) FROM job_runs WHERE tick_name = 'audit-anchor.tick' AND ok),
                    '-infinity'::timestamptz)) AS "failsSince",
                COUNT(*) AS "runs",
                COALESCE(BOOL_OR(ok AND started_at > now() - interval '${ANCHOR_STALE_DAYS} days'), false) AS "fresh",
                (SELECT ok FROM job_runs WHERE tick_name = 'audit-anchor.tick'
                  ORDER BY started_at DESC, id DESC LIMIT 1) AS "lastRunOk"
           FROM job_runs WHERE tick_name = 'audit-anchor.tick'`
    );
    if (!a || !Number(a.runs)) {
        rows.push({
            key: 'audit_anchor',
            state: 'not_configured',
            count: null,
            population: null,
            href: healthHref,
        });
    } else {
        const yes = (x) => x === true || x === 't';
        const lastRunOk =
            a.lastRunOk === null || a.lastRunOk === undefined ? null : yes(a.lastRunOk);
        rows.push({
            key: 'audit_anchor',
            state: 'info',
            alert: anchorAlert({ fresh: yes(a.fresh), lastRunOk }),
            facts: { lastOk: a.lastOk || null, failsSince: Number(a.failsSince) || 0 },
            href: healthHref,
        });
    }
    return rows;
}

async function privacySection() {
    const href = '/admin/maintenance';
    const e = await db.get(
        `WITH s AS (SELECT DISTINCT entity_id FROM system_logs
                     WHERE action = 'GDPR_ERASURE' AND entity_type = 'employee' AND entity_id IS NOT NULL)
         SELECT (SELECT COUNT(*) FROM s) AS "subjects",
                (SELECT COUNT(*) FROM s WHERE NOT EXISTS (
                    SELECT 1 FROM erasure_tombstones t
                     WHERE t.subject_type = 'employee' AND t.subject_id = s.entity_id)) AS "missing"`
    );
    let mode = 'report';
    try {
        mode = String(
            (await require('../models/AppSettingsModel').getValue(
                'retentionPurgeMode',
                'report'
            )) || 'report'
        );
    } catch (_) {
        mode = 'report';
    }
    const j = await db.get(
        `SELECT COUNT(*) FILTER (WHERE completed_at IS NULL) AS "pending",
                COUNT(*) FILTER (WHERE completed_at IS NULL AND due_at <= now() AND legal_hold_at IS NULL) AS "due",
                MIN(due_at) FILTER (WHERE completed_at IS NULL AND due_at <= now() AND legal_hold_at IS NULL) AS "oldest"
           FROM pii_cleanup_jobs`
    );
    // An active administration account not linked to the employee record that
    // carries the same identity: the person could act on their own record.
    const u = await db.get(
        `SELECT COUNT(*) FILTER (WHERE m) AS "match", COUNT(*) AS "unlinked"
           FROM (SELECT EXISTS (
                     SELECT 1 FROM employees e
                      WHERE e.is_active = true AND e.erased_at IS NULL
                        AND ((a.email IS NOT NULL AND btrim(a.email::text) <> ''
                              AND lower(btrim(a.email::text)) = lower(btrim(coalesce(e.email::text, ''))))
                          OR (a.external_id IS NOT NULL AND btrim(a.external_id) <> ''
                              AND a.external_id = e.external_id))) AS m
                   FROM admins a
                  WHERE a.is_active = true AND a.linked_employee_id IS NULL) x`
    );
    return [
        {
            key: 'admin_unlinked_match',
            count: Number(u && u.match) || 0,
            population: Number(u && u.unlinked) || 0,
            alert: true,
            href: '/admins',
        },
        {
            key: 'erasure_no_tombstone',
            count: Number(e.missing) || 0,
            population: Number(e.subjects) || 0,
            alert: true,
            href,
        },
        {
            key: mode === 'apply' ? 'retention_due_apply' : 'retention_due_report',
            count: Number(j.due) || 0,
            population: Number(j.pending) || 0,
            // a legal deadline ignored: only the report mode leaves it to a person
            alert: mode !== 'apply',
            facts: { oldest: j.oldest || null },
            href,
        },
    ];
}

/**
 * The page model. Sections outside the reader's permissions are never
 * computed. The people, development and certificates sections are limited to
 * the reader's cleared population; the framework, snapshots, audit and privacy
 * sections are organisation-wide by nature and shown only to the permissions
 * that already open those organisation-wide pages.
 */
async function panel(viewer) {
    const perms = permsOf(viewer);
    let flags = {};
    try {
        flags = (await require('./ModuleService').flags()) || {};
    } catch (_) {
        flags = {};
    }
    const visible = sectionsFor(viewer, flags);
    let lc = false;
    try {
        lc = !!(await require('../utils/featureFlags').isNationalisationEnabled());
    } catch (_) {
        lc = false;
    }
    const out = {
        sections: [],
        lc,
        scoped: !perms.sa,
        population: null,
        asOf: new Date().toISOString(),
    };
    if (!visible.length) return out;
    let scope = null;
    let ids = [];
    if (visible.some((k) => k === 'people' || k === 'development' || k === 'certificates')) {
        const K = require('./KpiService');
        const pop = await K.resolvePopulation({ viewer });
        ids = pop.ids;
        scope = { viewer, modules: flags, __population: pop };
        out.population = ids.length;
    }
    const builders = new Map([
        ['people', () => peopleSection(ids, { lc, can: perms.can, scope })],
        ['framework', () => frameworkSection({ can: perms.can, flags })],
        ['development', () => developmentSection(ids)],
        ['certificates', () => certificatesSection(scope, perms)],
        ['snapshots', () => snapshotsSection()],
        ['audit', () => auditSection(perms)],
        ['privacy', () => privacySection()],
    ]);
    for (const key of visible) {
        let rows = null;
        try {
            rows = await builders.get(key)();
        } catch (_) {
            rows = null;
        }
        out.sections.push({
            key,
            scoped: key === 'people' || key === 'development' || key === 'certificates',
            rows: rows ? rows.map(finishRow) : [],
            failed: !rows,
        });
    }
    out.todo = out.sections.reduce(
        (s, sec) => s + sec.rows.filter((r) => r.status === 'todo').length,
        0
    );
    return out;
}

module.exports = {
    PANEL_PATH,
    PANEL_SLUGS,
    SECTIONS,
    SNAPSHOT_COLUMNS,
    CERT_RATES,
    SMALL_N,
    panel,
    canSeePanel,
    sectionsFor,
    // pure, exported for the tests
    rowStatus,
    rowShare,
    finishRow,
    sealDueMonth,
    anchorAlert,
    // the section readers, exported for the database tests
    _sections: { peopleSection, frameworkSection, developmentSection, certificatesSection },
};
