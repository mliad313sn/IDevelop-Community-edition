'use strict';

/**
 * DEIService — fairness analytics over self-declared demographics (stored in the
 * sealed employee_demographics table, separate from core PII). Every aggregate
 * is suppressed below a minimum group size so individuals are never identifiable.
 * Answers the parity questions a CHRO/board/regulator actually asks: representation
 * by level, 9-box distribution by group, PIP rate by group.
 */
const db = require('../config/database');

const MIN_GROUP = 5;

/**
 * Self-declared values are short labels ("Femme", "36-45", "Sénégalaise"), and
 * they are rendered back as group names on the talent hub. They used to be
 * stored as ANY free text — `<img src=x onerror=…>` included — and the hub
 * wrote them into innerHTML (stored XSS). Letters of any script, digits,
 * spaces and a few separators; nothing that can open markup. Max 64.
 */
const LABEL_RE = /^[\p{L}\p{M}\p{N} .'’\-_/()+,]{1,64}$/u;
const DEMO_FIELDS = ['gender', 'ethnicity', 'ageBand', 'nationality'];

function refuse(code) {
    const e = new Error(code);
    e.status = 400;
    e.code = code;
    e.expose = true;
    return e;
}

/** null for "not declared"; the trimmed label when valid; throws otherwise. */
function cleanLabel(v, field) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (!LABEL_RE.test(s)) throw refuse(`dei_invalid_${field}`);
    return s;
}

class DEIService {
    /** Validate a demographics payload; throws a 400 refusal on any bad field. */
    validate(d = {}) {
        const out = {};
        for (const f of DEMO_FIELDS) out[f] = cleanLabel(d[f], f);
        return out;
    }

    async setDemographics(employeeId, raw) {
        const clean = this.validate(raw || {});
        const d = { ...raw, ...clean };
        return db.get(
            `INSERT INTO employee_demographics (employee_id, gender, ethnicity, age_band, disability, nationality, self_declared, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, now())
             ON CONFLICT (employee_id) DO UPDATE SET gender=EXCLUDED.gender, ethnicity=EXCLUDED.ethnicity,
               age_band=EXCLUDED.age_band, disability=EXCLUDED.disability, nationality=EXCLUDED.nationality,
               self_declared=EXCLUDED.self_declared, updated_at=now()
             RETURNING employee_id`,
            [
                employeeId,
                d.gender || null,
                d.ethnicity || null,
                d.ageBand || null,
                d.disability == null ? null : d.disability === true || d.disability === 'true',
                d.nationality || null,
                d.selfDeclared !== false,
            ]
        );
    }

    _suppress(rows, countKey = 'n') {
        return rows.map((r) =>
            Number(r[countKey]) < MIN_GROUP ? { ...r, suppressed: true, [countKey]: null } : r
        );
    }

    /** Representation: headcount by a demographic dimension. */
    async representation(dim = 'gender') {
        if (!['gender', 'ethnicity', 'age_band', 'nationality'].includes(dim))
            throw new Error('invalid dimension');
        const rows = await db.all(
            `SELECT COALESCE(d.${dim}, 'Undeclared') AS grp, COUNT(*) AS n
             FROM employees e JOIN employee_demographics d ON d.employee_id = e.id
             WHERE e.is_active = true GROUP BY 1 ORDER BY 2 DESC`
        );
        return this._suppress(rows);
    }

    /** 9-box distribution by demographic group (latest cycle), suppressed. */
    async nineBoxByGroup(dim = 'gender') {
        if (!['gender', 'ethnicity', 'age_band', 'nationality'].includes(dim))
            throw new Error('invalid dimension');
        const rows = await db.all(
            `SELECT COALESCE(d.${dim},'Undeclared') AS grp, p.box, COUNT(*) AS n
             FROM talent_placements p
             JOIN employee_demographics d ON d.employee_id = p.employee_id
             WHERE p.cycle_id = (SELECT MAX(cycle_id) FROM talent_placements)
             GROUP BY 1, 2 ORDER BY 1, 2`
        );
        // suppress small (group,box) cells
        return rows.map((r) =>
            Number(r.n) < MIN_GROUP ? { grp: r.grp, box: r.box, n: null, suppressed: true } : r
        );
    }

    /** PIP rate by group: active PIPs / headcount, suppressed below threshold. */
    async pipRateByGroup(dim = 'gender') {
        if (!['gender', 'ethnicity', 'age_band', 'nationality'].includes(dim))
            throw new Error('invalid dimension');
        const rows = await db.all(
            `SELECT COALESCE(d.${dim},'Undeclared') AS grp, COUNT(*) AS headcount,
                    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pips pp WHERE pp.employee_id = e.id AND pp.state IN ('proposed','approved','active'))) AS on_pip
             FROM employees e JOIN employee_demographics d ON d.employee_id = e.id
             WHERE e.is_active = true GROUP BY 1`
        );
        return rows.map((r) => {
            const headcount = Number(r.headcount),
                onPip = Number(r.onPip);
            if (headcount < MIN_GROUP) return { grp: r.grp, suppressed: true };
            // Complementary small-cell rule: a sensitive count of 1..MIN_GROUP-1 (or its
            // complement) in a small group is identifying — e.g. "1 of 5 on a PIP". Guard
            // BOTH the numerator and its complement, not just the denominator. Keep the
            // headcount (already public via representation); hide the PIP figures.
            if (onPip < MIN_GROUP || headcount - onPip < MIN_GROUP) {
                return { grp: r.grp, headcount, suppressed: true };
            }
            return {
                grp: r.grp,
                headcount,
                onPip,
                pipRatePct: Math.round((onPip / headcount) * 100),
            };
        });
    }
}

module.exports = new DEIService();
