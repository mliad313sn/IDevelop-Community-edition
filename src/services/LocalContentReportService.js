'use strict';

/**
 * LocalContentReportService — the regulator-ready local-content pack
 * (migration 149, table lc_regulatory_packs).
 *
 * One pack = one operating country × one period (quarter or year). It is a
 * POINT-IN-TIME snapshot, stored as JSON:
 *   - workforce: nationals / expatriates / unspecified, in total, by level
 *     (management = has at least one active report; execution = none), by role
 *     family and by site — the state on the day the pack was generated;
 *   - nationalisation plans of that country and their computed status
 *     (NationalisationService — the same rule as the Nationalisation tab);
 *   - training of nationals over the period: LMS completions and
 *     certifications issued, plus certifications valid at the period end
 *     (expatriates alongside, for comparison).
 *
 * Lifecycle: draft (may be regenerated) → published (FROZEN — a database
 * trigger refuses any change to its content) → superseded by the next
 * published version. A draft can be discarded with a reason. Nothing is ever
 * deleted.
 *
 * Anonymity: a count from 1 to 4 is rendered "< 5" in every output (page,
 * XLSX, print), and a percentage is only computed on a base of at least 5.
 * The snapshot keeps the exact counts; masking is applied at rendering, in ONE
 * function (maskCount), so no output can forget it. The one exception (F3, PO
 * decision 2026-09-29): a PUBLISHED pack whose publisher explicitly chose
 * « Chiffres exacts pour déclaration officielle » renders exact counts — the
 * choice is frozen in its snapshot (meta.publication) and audited.
 *
 * Access: admins only — viewing needs view_compliance or manage_compliance,
 * generating / publishing / discarding needs manage_compliance (never a
 * viewer), and in every case the country must be within the admin's clearance
 * (RBACService.canAccessCountry: SuperAdmin, or a country-scoped admin). A
 * pack speaks for a whole country, so a site-scoped admin — who would see only
 * part of it — cannot produce one.
 */

const db = require('../config/database');
const RBACService = require('./RBACService');
const NationalisationService = require('./NationalisationService');

const ANONYMITY_THRESHOLD = 5;
const COUNTRY_TEMPLATES = ['ML', 'BF', 'GN', 'CI', 'SN'];

function lcError(code, status, key) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    e.expose = true;
    e.i18nKey = `localcontent:${key}`;
    return e;
}

/** A count as it may be shown: 1–4 → '< 5'; 0 and ≥ 5 as is; null stays null. */
function maskCount(n) {
    if (n == null) return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (v > 0 && v < ANONYMITY_THRESHOLD) return `< ${ANONYMITY_THRESHOLD}`;
    return v;
}

/** Share in %, or null when the base is under the anonymity threshold (or empty). */
function safePct(part, base) {
    const b = Number(base);
    if (!Number.isFinite(b) || b < ANONYMITY_THRESHOLD) return null;
    return Math.round((100 * Number(part || 0)) / b);
}

/** Exact count for the official (published, exact-figures) pack; null stays null. */
function exactCount(n) {
    if (n == null) return null;
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}

/** Exact share in % on any non-empty base (official pack); null on an empty base. */
function exactPct(part, base) {
    const b = Number(base);
    if (!Number.isFinite(b) || b <= 0) return null;
    return Math.round((100 * Number(part || 0)) / b);
}

/**
 * F4 (3.23.21) — how much of the headcount has NO recorded nationality. Shown
 * explicitly (never folded into nationals or expatriates): above WARN the pack
 * carries a warning, above BLOCK it cannot be published unless the publisher
 * acknowledges it explicitly.
 */
const UNSPECIFIED_WARN_PCT = 2;
const UNSPECIFIED_BLOCK_PCT = 10;
function unspecifiedShare(total) {
    const headcount = Number((total && total.headcount) || 0);
    const unspecified = Number((total && total.unspecified) || 0);
    if (!headcount) return { headcount: 0, unspecified, pct: null, level: 'empty' };
    const pct = Math.round((1000 * unspecified) / headcount) / 10;
    const level =
        pct > UNSPECIFIED_BLOCK_PCT ? 'block' : pct > UNSPECIFIED_WARN_PCT ? 'warn' : 'ok';
    return { headcount, unspecified, pct, level };
}

/** True when the pack is the published official document with exact figures chosen. */
function isExactFigures(pack, snap) {
    const s =
        snap || (typeof pack.snapshot === 'string' ? JSON.parse(pack.snapshot) : pack.snapshot);
    const pub = s && s.meta && s.meta.publication;
    return (
        (pack.state === 'published' || pack.state === 'superseded') &&
        !!pub &&
        pub.exactFigures === true
    );
}

/**
 * '2026-Q3' (quarter) or '2026' (year) → [start, end) calendar bounds.
 * @returns {{periodType:string,label:string,start:string,end:string,endInclusive:string}}
 */
function parsePeriod(periodType, label) {
    const lbl = String(label || '')
        .trim()
        .toUpperCase();
    let y;
    let startM;
    let months;
    if (periodType === 'quarter') {
        const m = /^(\d{4})-Q([1-4])$/.exec(lbl);
        if (!m) throw lcError('LC_BAD_PERIOD', 400, 'err_bad_period');
        y = Number(m[1]);
        startM = (Number(m[2]) - 1) * 3;
        months = 3;
    } else if (periodType === 'year') {
        const m = /^(\d{4})$/.exec(lbl);
        if (!m) throw lcError('LC_BAD_PERIOD', 400, 'err_bad_period');
        y = Number(m[1]);
        startM = 0;
        months = 12;
    } else {
        throw lcError('LC_BAD_PERIOD', 400, 'err_bad_period');
    }
    if (y < 2000 || y > 2100) throw lcError('LC_BAD_PERIOD', 400, 'err_bad_period');
    const iso = (d) => d.toISOString().slice(0, 10);
    const start = new Date(Date.UTC(y, startM, 1));
    const end = new Date(Date.UTC(y, startM + months, 1));
    const endIncl = new Date(end.getTime() - 86400000);
    return { periodType, label: lbl, start: iso(start), end: iso(end), endInclusive: iso(endIncl) };
}

function templateFor(countryCode) {
    const c = String(countryCode || '').toUpperCase();
    return COUNTRY_TEMPLATES.includes(c) ? c : 'generic';
}

/**
 * A template label: the country's own wording when it has one, the common
 * wording otherwise. `t` is req.t (i18next).
 */
function tplLabel(t, templateCode, key) {
    const specific = `localcontent:tpl_${String(templateCode).toLowerCase()}_${key}`;
    const generic = `localcontent:tpl_generic_${key}`;
    if (typeof t !== 'function') return key;
    const v = t(specific, { defaultValue: '' });
    return v && v !== specific && v !== `tpl_${String(templateCode).toLowerCase()}_${key}`
        ? v
        : t(generic);
}

class LocalContentReportService {
    // ---- authorisation -----------------------------------------------------

    canView(user) {
        if (!user || user.userType !== 'admin') return false;
        if (RBACService.isSuperAdmin(user)) return true;
        return (
            RBACService.hasPermission(user, 'view_compliance') ||
            RBACService.hasPermission(user, 'manage_compliance')
        );
    }

    canManage(user) {
        if (!user || user.userType !== 'admin') return false;
        if (RBACService.isViewer(user)) return false;
        if (RBACService.isSuperAdmin(user)) return true;
        return RBACService.hasPermission(user, 'manage_compliance');
    }

    async _assertCountry(user, countryId) {
        if (!user || user.userType !== 'admin') throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        if (!(await RBACService.canAccessCountry(user, countryId))) {
            throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        }
    }

    /** Countries the caller may produce or read a pack for. */
    async countriesFor(user) {
        if (!this.canView(user)) return [];
        const all = await db.all(
            `SELECT id, code, name FROM countries WHERE COALESCE(is_active, true) = true ORDER BY name`
        );
        const out = [];
        for (const c of all) {
            if (await RBACService.canAccessCountry(user, c.id)) {
                out.push({
                    id: Number(c.id),
                    code: c.code,
                    name: c.name,
                    template: templateFor(c.code),
                });
            }
        }
        return out;
    }

    // ---- snapshot ------------------------------------------------------------

    /**
     * One row per active employee of the country: classification + grouping
     * keys. Aggregation happens OUTSIDE (see _workforce), so the SQL layer's
     * GROUP BY expansion never has to parse the classifier's CASE.
     */
    _workforceRowsSql() {
        // `_k.cid` is the country; the classifier is the module's one rule.
        const NAT = NationalisationService.natCase('_k.cid');
        return `SELECT ${NAT} AS nat,
                       CASE WHEN EXISTS (SELECT 1 FROM employees rep
                                          WHERE rep.is_active = true AND rep.id <> e.id
                                            AND (rep.supervisor_id = e.id
                                                 OR (rep.manager_id = e.id AND rep.manager_type = 'employee')))
                            THEN 'management' ELSE 'execution' END AS lvl,
                       COALESCE(rf.name, '—') AS fam,
                       _st.name AS site
                  FROM employees e
                  JOIN sites _st ON _st.id = e.site_id
                  LEFT JOIN roles r ON r.id = e.role_id
                  LEFT JOIN role_families rf ON rf.id = r.role_family_id
                  CROSS JOIN (SELECT ?::bigint AS cid) _k
                 WHERE e.is_active = true AND _st.country_id = _k.cid`;
    }

    async _workforce(countryId) {
        const cid = Number(countryId);
        const cols = `count(*)::int AS headcount,
                      count(*) FILTER (WHERE w.nat = 1)::int AS nationals,
                      count(*) FILTER (WHERE w.nat = 0)::int AS expats,
                      count(*) FILTER (WHERE w.nat IS NULL)::int AS unspecified`;
        const rows = this._workforceRowsSql();
        const norm = (r) => ({
            name: r.name,
            headcount: Number(r.headcount),
            nationals: Number(r.nationals),
            expats: Number(r.expats),
            unspecified: Number(r.unspecified),
        });
        const grouped = (col) =>
            db.all(
                `SELECT w.${col} AS name, ${cols} FROM (${rows}) w
                  GROUP BY w.${col} ORDER BY headcount DESC, w.${col}`,
                [cid]
            );
        const total = await db.get(`SELECT ${cols} FROM (${rows}) w`, [cid]);
        const byLevel = await grouped('lvl');
        const byRoleFamily = await grouped('fam');
        const bySite = await grouped('site');
        return {
            total: norm({ name: null, ...total }),
            byLevel: byLevel.map(norm),
            byRoleFamily: byRoleFamily.map(norm),
            bySite: bySite.map(norm),
        };
    }

    async _training(countryId, period) {
        const NAT = NationalisationService.natCase('_k.cid');
        const cid = Number(countryId);
        const split = (rows, fields) => {
            const empty = () => Object.fromEntries(fields.map((f) => [f, 0]));
            const out = { nationals: empty(), expats: empty(), unspecified: empty() };
            for (const r of rows) {
                const k =
                    r.nat == null ? 'unspecified' : Number(r.nat) === 1 ? 'nationals' : 'expats';
                for (const f of fields) out[k][f] = Number(r[f] || 0);
            }
            return out;
        };
        // Classify in an inner query, aggregate outside (see _workforceRowsSql).
        const lms = await db.all(
            `SELECT x.nat, count(*)::int AS completions, count(DISTINCT x.eid)::int AS people
               FROM (SELECT ${NAT} AS nat, lc.employee_id AS eid
                       FROM lms_completions lc
                       JOIN employees e ON e.id = lc.employee_id
                       JOIN sites _st ON _st.id = e.site_id
                       CROSS JOIN (SELECT ?::bigint AS cid) _k
                      WHERE _st.country_id = _k.cid
                        AND lc.completed_at >= ?::date AND lc.completed_at < ?::date) x
              GROUP BY x.nat`,
            [cid, period.start, period.end]
        );
        const issued = await db.all(
            `SELECT x.nat, count(*)::int AS certificates, count(DISTINCT x.eid)::int AS people
               FROM (SELECT ${NAT} AS nat, ec.employee_id AS eid
                       FROM employee_certifications ec
                       JOIN employees e ON e.id = ec.employee_id
                       JOIN sites _st ON _st.id = e.site_id
                       CROSS JOIN (SELECT ?::bigint AS cid) _k
                      WHERE _st.country_id = _k.cid AND NOT ec.is_revoked
                        AND ec.issued_on >= ?::date AND ec.issued_on < ?::date) x
              GROUP BY x.nat`,
            [cid, period.start, period.end]
        );
        const valid = await db.all(
            `SELECT x.nat, count(DISTINCT x.eid)::int AS people
               FROM (SELECT ${NAT} AS nat, ec.employee_id AS eid
                       FROM employee_certifications ec
                       JOIN employees e ON e.id = ec.employee_id
                       JOIN sites _st ON _st.id = e.site_id
                       CROSS JOIN (SELECT ?::bigint AS cid) _k
                      WHERE _st.country_id = _k.cid AND e.is_active = true AND NOT ec.is_revoked
                        AND ec.issued_on < ?::date
                        AND (ec.expires_on IS NULL OR ec.expires_on >= ?::date)) x
              GROUP BY x.nat`,
            [cid, period.end, period.end]
        );
        return {
            lmsCompletions: split(lms, ['completions', 'people']),
            certificationsIssued: split(issued, ['certificates', 'people']),
            certificationsValidAtEnd: split(valid, ['people']),
        };
    }

    async _plans(countryId, period, today) {
        const plans = await NationalisationService.listPlans(null, {
            countryId,
            bypassScope: true,
            today,
        });
        // Plans still open, plus those closed on or after the period start
        // (a position nationalised during the period is exactly what to prove).
        const periodStartMs = Date.parse(`${period.start}T00:00:00Z`);
        const rows = plans
            .filter(
                (p) =>
                    p.state === 'active' ||
                    (p.stateChangedAt && new Date(p.stateChangedAt).getTime() >= periodStartMs)
            )
            .map((p) => {
                // a successor who left the company is never counted.
                const active = p.successors.filter((s) =>
                    s.counted === undefined ? s.state === 'active' : s.counted
                );
                const readiness = active.some((s) => s.isReady)
                    ? 'ready'
                    : active.some((s) => s.readinessPercent != null)
                      ? 'developing'
                      : active.length
                        ? 'not_measured'
                        : 'no_successor';
                return {
                    planId: p.id,
                    roleName: p.roleName,
                    roleFamilyName: p.roleFamilyName,
                    siteName: p.siteName,
                    targetDate: p.targetDate,
                    state: p.state,
                    status: p.status,
                    statusReason: p.statusReason,
                    successorCount: p.activeSuccessorCount,
                    idpLinkedCount: p.idpLinkedCount,
                    // Leaver / mover cascade: awaiting a human decision.
                    needsDecision: p.needsDecision === true,
                    flags: p.flags || [],
                    // No individual readiness percentage in a regulator document:
                    // the position is identifiable, so only the state is given.
                    readiness,
                };
            });
        const summary = {
            planned: 0,
            in_progress: 0,
            at_risk: 0,
            overdue: 0,
            achieved: 0,
            cancelled: 0,
        };
        rows.forEach((r) => {
            summary[r.status] = (summary[r.status] || 0) + 1;
        });
        summary.total = rows.length;
        return { summary, rows, periodStart: period.start };
    }

    /** Build the snapshot JSON for one country and period (no write). */
    async buildSnapshot(countryId, period, { now = new Date() } = {}) {
        const c = await db.get(`SELECT id, code, name FROM countries WHERE id = ?`, [
            Number(countryId),
        ]);
        if (!c) throw lcError('LC_COUNTRY_NOT_FOUND', 404, 'err_country_not_found');
        let companyName = null;
        try {
            companyName = (await require('../utils/branding').getBranding()).appName || null;
        } catch (_) {
            companyName = null;
        }
        const today = NationalisationService.ymd(now);
        // Sequential: inside a transaction all three share one client.
        const workforce = await this._workforce(c.id);
        const training = await this._training(c.id, period);
        const plans = await this._plans(c.id, period, today);
        return {
            schema: 1,
            meta: {
                countryId: Number(c.id),
                countryCode: c.code,
                countryName: c.name,
                templateCode: templateFor(c.code),
                periodType: period.periodType,
                periodLabel: period.label,
                periodStart: period.start,
                periodEnd: period.end,
                periodEndInclusive: period.endInclusive,
                // The pack describes the workforce AS OF this instant.
                asOf: now.toISOString(),
                periodOpen: today < period.end,
                companyName,
                anonymityThreshold: ANONYMITY_THRESHOLD,
            },
            workforce,
            plans,
            training,
        };
    }

    // ---- lifecycle -----------------------------------------------------------

    async _pack(id) {
        const p = await db.get(`SELECT * FROM lc_regulatory_packs WHERE id = ?`, [Number(id)]);
        if (!p) throw lcError('LC_PACK_NOT_FOUND', 404, 'err_pack_not_found');
        return p;
    }

    async list(user) {
        if (!this.canView(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        const countries = await this.countriesFor(user);
        if (!countries.length) return [];
        const ids = countries.map((c) => c.id);
        const rows = await db.all(
            `SELECT p.id, p.country_id, c.name AS country_name, c.code AS country_code,
                    p.period_type, p.period_label, p.version, p.state, p.template_code,
                    p.generated_at, p.generated_by_ref, p.published_at, p.published_by_ref,
                    p.superseded_at, p.superseded_by_pack_id, p.state_reason, p.snapshot
               FROM lc_regulatory_packs p JOIN countries c ON c.id = p.country_id
              WHERE p.country_id IN (${ids.map(() => '?').join(',')})
              ORDER BY p.period_start DESC, c.name, p.version DESC`,
            ids
        );
        // the list shows each pack's unspecified-nationality share and,
        // once published, whether it carries exact figures. The snapshot itself
        // is not handed to the page.
        return rows.map((r) => {
            const { snapshot, ...rest } = r;
            let snap = snapshot;
            try {
                if (typeof snap === 'string') snap = JSON.parse(snap);
            } catch (_) {
                snap = null;
            }
            const pub = snap && snap.meta && snap.meta.publication;
            return {
                ...rest,
                quality: {
                    ...unspecifiedShare(snap && snap.workforce && snap.workforce.total),
                    warnPct: UNSPECIFIED_WARN_PCT,
                    blockPct: UNSPECIFIED_BLOCK_PCT,
                },
                exactFigures: pub ? pub.exactFigures === true : null,
                unspecifiedAcknowledged: pub ? pub.unspecifiedAcknowledged === true : null,
            };
        });
    }

    async get(user, id) {
        if (!this.canView(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        const p = await this._pack(id);
        await this._assertCountry(user, p.countryId);
        return p;
    }

    /** Create the draft for (country, period), or regenerate the existing draft. */
    async generateDraft(user, { countryId, periodType, periodLabel }, { now = new Date() } = {}) {
        if (!this.canManage(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        const cid = Number(countryId);
        if (!cid) throw lcError('LC_COUNTRY_NOT_FOUND', 404, 'err_country_not_found');
        await this._assertCountry(user, cid);
        const period = parsePeriod(periodType, periodLabel);
        const snap = await this.buildSnapshot(cid, period, { now });
        const ref = NationalisationService.actorRef(user);
        let id = null;
        await db.runTransaction(async () => {
            const draft = await db.get(
                `SELECT id FROM lc_regulatory_packs
                  WHERE country_id = ? AND period_label = ? AND state = 'draft' FOR UPDATE`,
                [cid, period.label]
            );
            if (draft) {
                id = Number(draft.id);
                await db.run(
                    `UPDATE lc_regulatory_packs
                        SET snapshot = ?::jsonb, company_name = ?, template_code = ?,
                            generated_at = ?, generated_by_ref = ?
                      WHERE id = ? AND state = 'draft'`,
                    [
                        JSON.stringify(snap),
                        snap.meta.companyName,
                        snap.meta.templateCode,
                        now,
                        ref,
                        id,
                    ]
                );
            } else {
                const v = await db.get(
                    `SELECT COALESCE(max(version), 0)::int AS v FROM lc_regulatory_packs
                      WHERE country_id = ? AND period_label = ?`,
                    [cid, period.label]
                );
                const r = await db.run(
                    `INSERT INTO lc_regulatory_packs
                        (country_id, period_type, period_label, period_start, period_end, version,
                         state, template_code, company_name, snapshot, generated_at, generated_by_ref)
                     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?::jsonb, ?, ?)`,
                    [
                        cid,
                        period.periodType,
                        period.label,
                        period.start,
                        period.end,
                        Number(v.v) + 1,
                        snap.meta.templateCode,
                        snap.meta.companyName,
                        JSON.stringify(snap),
                        now,
                        ref,
                    ]
                );
                id = r.lastID;
            }
        });
        return { id };
    }

    /**
     * Freeze a draft. A previously published version becomes 'superseded'.
     *
     * F3 (PO 2026-09-29): the OFFICIAL pack shows exact counts — but only by an
     * explicit, recorded choice of the publisher (`exactFigures`, the checkbox
     * « Chiffres exacts pour déclaration officielle »). Unticked, the published
     * pack keeps the « < 5 » masking. F4: above UNSPECIFIED_BLOCK_PCT of
     * unrecorded nationalities the pack is refused unless the publisher
     * acknowledges it (`acknowledgeUnspecified`). Both decisions are written INTO
     * the frozen snapshot (meta.publication: who, when, what) in the same UPDATE
     * that publishes it, so the choice can never be separated from the document.
     */
    async publish(user, id, { exactFigures = false, acknowledgeUnspecified = false } = {}) {
        if (!this.canManage(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        const p = await this._pack(id);
        await this._assertCountry(user, p.countryId);
        const ref = NationalisationService.actorRef(user);
        let superseded = null;
        let decision = null;
        await db.runTransaction(async () => {
            const cur = await db.get(
                `SELECT id, state, snapshot FROM lc_regulatory_packs WHERE id = ? FOR UPDATE`,
                [Number(p.id)]
            );
            if (!cur || cur.state !== 'draft')
                throw lcError('LC_PACK_NOT_DRAFT', 409, 'err_pack_not_draft');
            const snap = typeof cur.snapshot === 'string' ? JSON.parse(cur.snapshot) : cur.snapshot;
            const q = unspecifiedShare(snap.workforce && snap.workforce.total);
            if (q.level === 'block' && acknowledgeUnspecified !== true)
                throw lcError('LC_UNSPECIFIED_TOO_HIGH', 409, 'err_unspecified_too_high');
            decision = {
                exactFigures: exactFigures === true,
                unspecifiedPct: q.pct,
                unspecifiedLevel: q.level,
                unspecifiedAcknowledged: q.level === 'block' ? true : null,
                decidedByRef: ref,
                decidedAt: new Date().toISOString(),
            };
            snap.meta = { ...(snap.meta || {}), publication: decision };
            const prev = await db.get(
                `SELECT id FROM lc_regulatory_packs
                  WHERE country_id = ? AND period_label = ? AND state = 'published' FOR UPDATE`,
                [Number(p.countryId), p.periodLabel]
            );
            if (prev) {
                superseded = Number(prev.id);
                await db.run(
                    `UPDATE lc_regulatory_packs
                        SET state = 'superseded', superseded_at = now(), superseded_by_pack_id = ?,
                            state_changed_by_ref = ?
                      WHERE id = ?`,
                    [Number(p.id), ref, superseded]
                );
            }
            await db.run(
                `UPDATE lc_regulatory_packs
                    SET state = 'published', published_at = now(), published_by_ref = ?,
                        snapshot = ?::jsonb
                  WHERE id = ? AND state = 'draft'`,
                [ref, JSON.stringify(snap), Number(p.id)]
            );
        });
        return {
            id: Number(p.id),
            superseded,
            exactFigures: decision.exactFigures,
            unspecifiedPct: decision.unspecifiedPct,
            unspecifiedAcknowledged: decision.unspecifiedAcknowledged === true,
        };
    }

    /** Abandon a draft — reason required; the row stays. */
    async discard(user, id, reason) {
        if (!this.canManage(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        const why = String(reason || '').trim();
        if (!why) throw lcError('LC_REASON_REQUIRED', 400, 'err_reason_required');
        const p = await this._pack(id);
        await this._assertCountry(user, p.countryId);
        const r = await db.run(
            `UPDATE lc_regulatory_packs
                SET state = 'discarded', state_reason = ?, state_changed_by_ref = ?
              WHERE id = ? AND state = 'draft'`,
            [why.slice(0, 2000), NationalisationService.actorRef(user), Number(p.id)]
        );
        if (!r.changes) throw lcError('LC_PACK_NOT_DRAFT', 409, 'err_pack_not_draft');
        return { id: Number(p.id) };
    }

    // ---- outputs -------------------------------------------------------------

    /**
     * Everything a renderer needs, with masking already applied — or, for the
     * PUBLISHED pack whose publisher chose exact figures, the exact counts.
     * Every other output (draft, internal screens) keeps « < 5 ».
     */
    viewModel(pack, t) {
        const snap = typeof pack.snapshot === 'string' ? JSON.parse(pack.snapshot) : pack.snapshot;
        const tc = pack.templateCode || snap.meta.templateCode;
        const tr = (k, o) => (typeof t === 'function' ? t(`localcontent:${k}`, o) : k);
        const exact = isExactFigures(pack, snap);
        const cnt = exact ? exactCount : maskCount;
        const pct = exact ? exactPct : safePct;
        const row = (r) => ({
            name: r.name,
            headcount: cnt(r.headcount),
            nationals: cnt(r.nationals),
            expats: cnt(r.expats),
            unspecified: cnt(r.unspecified),
            nationalPct: pct(r.nationals, Number(r.nationals) + Number(r.expats)),
        });
        const levelName = (k) => tr(`level_${k}`);
        const tsplit = (o, fields) =>
            ['nationals', 'expats', 'unspecified'].map((k) => ({
                category: tr(`cat_${k}`),
                ...Object.fromEntries(fields.map((f) => [f, cnt(o[k][f])])),
            }));
        const quality = unspecifiedShare(snap.workforce && snap.workforce.total);
        return {
            id: Number(pack.id),
            state: pack.state,
            version: Number(pack.version),
            meta: snap.meta,
            exactFigures: exact,
            publication: (snap.meta && snap.meta.publication) || null,
            // the unrecorded-nationality share, shown explicitly.
            quality: {
                ...quality,
                warnPct: UNSPECIFIED_WARN_PCT,
                blockPct: UNSPECIFIED_BLOCK_PCT,
            },
            // what the platform does NOT measure is listed as such, never omitted.
            notMeasured: [
                { key: 'wage_bill_share', label: tr('nm_wage_bill_share'), value: tr('nm_value') },
                { key: 'training_spend', label: tr('nm_training_spend'), value: tr('nm_value') },
            ],
            companyName: pack.companyName || snap.meta.companyName,
            publishedAt: pack.publishedAt || null,
            generatedAt: pack.generatedAt || null,
            labels: {
                title: tplLabel(t, tc, 'title'),
                law: tplLabel(t, tc, 'law'),
                workforce: tplLabel(t, tc, 'workforce'),
                plans: tplLabel(t, tc, 'plans'),
                training: tplLabel(t, tc, 'training'),
                signature: tplLabel(t, tc, 'signature'),
            },
            workforce: {
                total: row({ name: tr('total'), ...snap.workforce.total }),
                byLevel: snap.workforce.byLevel.map((r) => row({ ...r, name: levelName(r.name) })),
                byRoleFamily: snap.workforce.byRoleFamily.map(row),
                bySite: snap.workforce.bySite.map(row),
            },
            plans: {
                summary: snap.plans.summary,
                rows: snap.plans.rows.map((r) => ({
                    ...r,
                    statusLabel: tr(`status_${r.status}`),
                    readinessLabel: tr(`readiness_${r.readiness}`),
                    decisionLabel: r.needsDecision ? tr('flag_needs_decision') : null,
                })),
            },
            training: {
                lms: tsplit(snap.training.lmsCompletions, ['completions', 'people']),
                issued: tsplit(snap.training.certificationsIssued, ['certificates', 'people']),
                valid: tsplit(snap.training.certificationsValidAtEnd, ['people']),
            },
        };
    }

    /** XLSX buffer (exceljs), masked, with the header block and signature block. */
    async toXlsx(pack, t) {
        const ExcelJS = require('exceljs');
        const vm = this.viewModel(pack, t);
        const tr = (k, o) => (typeof t === 'function' ? t(`localcontent:${k}`, o) : k);
        const wb = new ExcelJS.Workbook();
        wb.creator = vm.companyName || '';
        const show = (v) => (v == null ? '—' : v);
        const header = (ws) => {
            ws.addRow([vm.labels.title]).font = { bold: true, size: 14 };
            ws.addRow([vm.labels.law]);
            ws.addRow([tr('pack_company'), show(vm.companyName)]);
            ws.addRow([tr('pack_country'), vm.meta.countryName]);
            ws.addRow([
                tr('pack_period'),
                `${vm.meta.periodLabel} (${vm.meta.periodStart} → ${vm.meta.periodEndInclusive})`,
            ]);
            ws.addRow([tr('pack_version'), vm.version, tr(`pack_state_${vm.state}`)]);
            ws.addRow([tr('pack_as_of'), vm.meta.asOf]);
            ws.addRow([
                vm.exactFigures
                    ? tr('pack_exact_note')
                    : tr('pack_anonymity_note', { n: ANONYMITY_THRESHOLD }),
            ]);
            ws.addRow([
                tr('pack_unspecified_share'),
                vm.quality.pct == null ? null : `${vm.quality.pct} %`,
                vm.quality.level === 'ok' || vm.quality.level === 'empty'
                    ? null
                    : tr('pack_unspecified_warn', { pct: vm.quality.warnPct }),
            ]);
            ws.addRow([]);
        };
        const table = (ws, title, head, rows) => {
            ws.addRow([title]).font = { bold: true };
            ws.addRow(head).font = { bold: true };
            rows.forEach((r) => ws.addRow(r.map(show)));
            ws.addRow([]);
        };
        const wfHead = [
            tr('col_group'),
            tr('col_headcount'),
            tr('col_nationals'),
            tr('col_expats'),
            tr('col_unspecified'),
            tr('col_national_pct'),
        ];
        const wfRow = (r) => [
            r.name,
            r.headcount,
            r.nationals,
            r.expats,
            r.unspecified,
            r.nationalPct == null ? null : `${r.nationalPct} %`,
        ];

        // Excel forbids * ? : \ / [ ] in a sheet name and caps it at 31 chars.
        const sheetName = (s, fb) =>
            String(s || '')
                .replace(/[*?:\\/[\]]/g, ' ')
                .trim()
                .slice(0, 31) || fb;
        const ws1 = wb.addWorksheet(sheetName(tr('sheet_workforce'), 'Workforce'));
        header(ws1);
        ws1.addRow([tr('pack_headcount_note')]);
        table(ws1, vm.labels.workforce, wfHead, [wfRow(vm.workforce.total)]);
        table(ws1, tr('by_level'), wfHead, vm.workforce.byLevel.map(wfRow));
        table(ws1, tr('by_role_family'), wfHead, vm.workforce.byRoleFamily.map(wfRow));
        table(ws1, tr('by_site'), wfHead, vm.workforce.bySite.map(wfRow));
        table(
            ws1,
            tr('nm_title'),
            [tr('col_indicator'), tr('col_value')],
            vm.notMeasured.map((r) => [r.label, r.value])
        );

        const ws2 = wb.addWorksheet(sheetName(tr('sheet_plans'), 'Nationalisation'));
        header(ws2);
        table(
            ws2,
            vm.labels.plans,
            [
                tr('col_role'),
                tr('col_role_family'),
                tr('col_site'),
                tr('col_target_date'),
                tr('col_status'),
                tr('col_successors'),
                tr('col_readiness'),
                tr('col_idp_linked'),
            ],
            vm.plans.rows.map((r) => [
                r.roleName,
                r.roleFamilyName,
                r.siteName,
                r.targetDate,
                r.decisionLabel ? `${r.statusLabel} — ${r.decisionLabel}` : r.statusLabel,
                r.successorCount,
                r.readinessLabel,
                r.idpLinkedCount,
            ])
        );

        const ws3 = wb.addWorksheet(sheetName(tr('sheet_training'), 'Training'));
        header(ws3);
        table(
            ws3,
            tr('training_lms'),
            [tr('col_category'), tr('col_completions'), tr('col_people')],
            vm.training.lms.map((r) => [r.category, r.completions, r.people])
        );
        table(
            ws3,
            tr('training_certs_issued'),
            [tr('col_category'), tr('col_certificates'), tr('col_people')],
            vm.training.issued.map((r) => [r.category, r.certificates, r.people])
        );
        table(
            ws3,
            tr('training_certs_valid'),
            [tr('col_category'), tr('col_people')],
            vm.training.valid.map((r) => [r.category, r.people])
        );
        table(
            ws3,
            tr('nm_title'),
            [tr('col_indicator'), tr('col_value')],
            vm.notMeasured.filter((r) => r.key === 'training_spend').map((r) => [r.label, r.value])
        );
        ws3.addRow([]);
        ws3.addRow([vm.labels.signature]).font = { bold: true };
        ws3.addRow([tr('sig_name')]);
        ws3.addRow([tr('sig_title')]);
        ws3.addRow([tr('sig_date')]);
        ws3.addRow([tr('sig_signature')]);
        [ws1, ws2, ws3].forEach((ws) => {
            ws.columns.forEach((col, i) => {
                col.width = i === 0 ? 38 : 18;
            });
        });
        return wb.xlsx.writeBuffer();
    }
}

const instance = new LocalContentReportService();
instance.maskCount = maskCount;
instance.safePct = safePct;
instance.exactCount = exactCount;
instance.exactPct = exactPct;
instance.unspecifiedShare = unspecifiedShare;
instance.isExactFigures = isExactFigures;
instance.UNSPECIFIED_WARN_PCT = UNSPECIFIED_WARN_PCT;
instance.UNSPECIFIED_BLOCK_PCT = UNSPECIFIED_BLOCK_PCT;
instance.parsePeriod = parsePeriod;
instance.templateFor = templateFor;
instance.tplLabel = tplLabel;
instance.ANONYMITY_THRESHOLD = ANONYMITY_THRESHOLD;
module.exports = instance;
