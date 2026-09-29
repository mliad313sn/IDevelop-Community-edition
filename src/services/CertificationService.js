'use strict';

/**
 * CertificationService — the Certification & Verification-of-Competency (VOC)
 * engine (migration 56).
 *
 *   - Per-skill certification policy: validity, revalidation window, and the
 *     skill-currency decay horizon.
 *   - Issued certification records per (employee, skill) with VOC sign-off
 *     and ONE evidence file (certificate scan / VOC checklist photo). The
 *     evidence goes through the SAME ClamAV pipeline as assessment evidence:
 *     pending → clean | quarantined | scan_error (fail-closed: anything not
 *     'clean' is never served back for download).
 *   - Expiry logic lives in v_certification_current (computed cert_status);
 *     re-issuing a certification simply inserts a newer record — history is
 *     append-only and the view picks the latest non-revoked row.
 */

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { scopeClause } = require('../utils/rbacScope');

/** True when `iso` is a valid date that is not after today (dates compared in UTC). */
function isNotFuture(iso) {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return d.getTime() <= today;
}

/**
 * Add whole months to an ISO date, clamping to the end of the target month.
 *
 * `d.setMonth(d.getMonth + n)` OVERFLOWS on short months: 2026-08-31 + 6 landed
 * on 2027-03-03 and 2026-01-31 + 1 on 2026-03-03 — up to three days of extra
 * validity granted on a statutory ticket, with nothing to signal it. The end of
 * the month is the correct anniversary when the source day does not exist.
 */
function addMonthsClamped(iso, months) {
    const src = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(src.getTime())) return null;
    const day = src.getUTCDate();
    const target = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth() + months, 1));
    // Day 0 of the following month is the last day of the target month.
    const lastDay = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
    ).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve('uploads');
const QUARANTINE_DIR = process.env.QUARANTINE_DIR || path.resolve('uploads', '_quarantine');
const CLAMD_SOCKET = process.env.CLAMD_SOCKET || '/var/run/clamav/clamd.sock';

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

class CertificationService {
    // ---- Policies ----------------------------------------------------------

    /** Create or update the certification/currency policy for a skill. */
    static async setPolicy(
        skillId,
        {
            isCertification = true,
            validityMonths = null,
            revalidationWindowDays = 90,
            decayMonths = null,
        },
        adminId = null
    ) {
        const num = (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : null;
        };
        return db.get(
            `INSERT INTO skill_certification_policies
                (skill_id, is_certification, validity_months, revalidation_window_days, decay_months, created_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (skill_id) DO UPDATE SET
                is_certification = EXCLUDED.is_certification,
                validity_months = EXCLUDED.validity_months,
                revalidation_window_days = EXCLUDED.revalidation_window_days,
                decay_months = EXCLUDED.decay_months,
                updated_at = now()
             RETURNING *`,
            [
                skillId,
                !!isCertification,
                num(validityMonths),
                num(revalidationWindowDays) || 90,
                num(decayMonths),
                adminId,
            ]
        );
    }

    static async listPolicies() {
        return db.all(
            `SELECT p.*, s.name AS skill_name
               FROM skill_certification_policies p JOIN skills s ON s.id = p.skill_id
              ORDER BY s.name`
        );
    }

    // ---- Certification records ---------------------------------------------

    /**
     * Record an issued certification / VOC sign-off. expires_on defaults to
     * issued_on + policy.validity_months when the policy defines one.
     * `file` is an optional multer file (evidence) — AV-scanned before use.
     */
    static async record(
        {
            employeeId,
            skillId,
            certNumber = null,
            issuedOn,
            expiresOn = null,
            notes = null,
            file = null,
        },
        actor
    ) {
        if (!employeeId || !skillId || !issuedOn)
            throw new Error('employeeId, skillId and issuedOn are required');

        // A certificate cannot be issued in the future. Allowing it let a
        // future-dated row become the CURRENT one for a skill — masking an expired
        // ticket, restoring the person's level and flipping a safe-shift coverage
        // rule from breached back to satisfied, with nobody notified.
        // `v_certification_current` now ignores such rows; this stops them being
        // created at all, so an operator gets an error instead of a silent effect.
        if (!isNotFuture(issuedOn)) {
            throw new Error('issuedOn cannot be in the future');
        }

        // Derive expiry from the policy when not explicitly given.
        if (!expiresOn) {
            const policy = await db.get(
                'SELECT validity_months FROM skill_certification_policies WHERE skill_id = ?',
                [skillId]
            );
            if (policy && policy.validityMonths) {
                expiresOn = addMonthsClamped(issuedOn, Number(policy.validityMonths));
            }
        }

        const verifiedByType = actor ? (actor.userType === 'admin' ? 'admin' : 'employee') : null;
        const row = await db.get(
            `INSERT INTO employee_certifications
                (employee_id, skill_id, cert_number, issued_on, expires_on, notes,
                 verified_by_type, verified_by, verified_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, now(), ?)
             RETURNING *`,
            [
                employeeId,
                skillId,
                certNumber,
                issuedOn,
                expiresOn,
                notes,
                verifiedByType,
                actor ? actor.id : null,
                actor && actor.userType === 'admin' ? actor.id : null,
            ]
        );

        if (file) await this._attachEvidence(row.id, file);
        return db.get('SELECT * FROM employee_certifications WHERE id = ?', [row.id]);
    }

    /** Attach + AV-scan the evidence file for a certification record. */
    static async _attachEvidence(certId, file) {
        ensureDir(UPLOADS_DIR);
        ensureDir(QUARANTINE_DIR);
        const ext = path.extname(file.originalname || '').slice(0, 10);
        const dest = path.join(
            UPLOADS_DIR,
            `cert-${certId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
        );
        fs.renameSync(file.path, dest);
        await db.run(
            `UPDATE employee_certifications
                SET file_uri = ?, original_name = ?, mime = ?, size_bytes = ?, av_status = 'pending', updated_at = now()
              WHERE id = ?`,
            [dest, file.originalname, file.mimetype, file.size, certId]
        );

        try {
            const ClamScan = require('clamscan');
            const scanner = await new ClamScan().init({ clamdscan: { socket: CLAMD_SOCKET } });
            const { isInfected, viruses } = await scanner.scanFile(dest);
            if (isInfected) {
                const qPath = path.join(QUARANTINE_DIR, path.basename(dest));
                fs.renameSync(dest, qPath);
                await db.run(
                    `UPDATE employee_certifications
                        SET av_status = 'quarantined', av_signature = ?, quarantine_uri = ?, scanned_at = now()
                      WHERE id = ?`,
                    [(viruses || []).join(','), qPath, certId]
                );
            } else {
                await db.run(
                    "UPDATE employee_certifications SET av_status = 'clean', scanned_at = now() WHERE id = ?",
                    [certId]
                );
            }
        } catch (e) {
            // Fail-closed: 'scan_error' evidence is kept but never served back.
            await db.run(
                "UPDATE employee_certifications SET av_status = 'scan_error', scanned_at = now() WHERE id = ?",
                [certId]
            );
            console.error('[certification] clamav scan failed:', e.message);
        }
    }

    static async revoke(certId, reason, _actor) {
        const row = await db.get(
            `UPDATE employee_certifications
                SET is_revoked = true, revoked_reason = ?, updated_at = now()
              WHERE id = ? AND NOT is_revoked RETURNING *`,
            [reason || null, certId]
        );
        if (!row) return null; // already revoked, or no such record

        // Withdrawing a certificate drops the holder's qualification for that skill
        // to zero: they come off the "who can do this now" list, off the succession
        // bench, and a coverage rule can go into breach. None of that was announced
        // to anyone — the person simply stopped being qualified in silence, and the
        // first they knew was being turned away from a task.
        try {
            const who = await db.get(
                `SELECT c.employee_id AS "employeeId", s.name AS "skillName"
                   FROM employee_certifications c JOIN skills s ON s.id = c.skill_id
                  WHERE c.id = ?`,
                [certId]
            );
            if (who && who.employeeId) {
                await require('./NotificationService').notify({
                    userType: 'employee',
                    userId: Number(who.employeeId),
                    kind: 'certification.revoked',
                    category: 'compliance',
                    payload: {
                        skill: who.skillName,
                        reason: reason || null,
                        link: '/employee/dashboard',
                    },
                });
            }
        } catch (e) {
            console.error(
                '[certification] revoke notification failed for cert',
                certId,
                e && e.message
            );
        }

        try {
            await require('./LogService').log({
                adminId: _actor && _actor.userType === 'admin' ? _actor.id : null,
                action: 'CERTIFICATION_REVOKED',
                entityType: 'certification',
                entityId: Number(certId),
                details: `Certificate revoked${reason ? `: ${reason}` : ''}`,
            });
        } catch (_) {
            /* audit is best-effort; the revocation already happened */
        }

        return row;
    }

    // ---- Scoped reads (scope BEFORE aggregate) -----------------------------

    /** Current certifications for the caller's scope, optionally by status. */
    static async listCurrent(ids, { status = null, limit = 200 } = {}) {
        const params = [];
        let statusSql = '';
        if (status) {
            statusSql = ' AND cc.cert_status = ?';
            params.push(status);
        }
        const scope = scopeClause(ids, params, 'cc.employee_id');
        params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
        return db.all(
            `SELECT cc.* FROM v_certification_current cc
              WHERE 1 = 1${statusSql}${scope}
              ORDER BY cc.expires_on ASC NULLS LAST
              LIMIT ?`,
            params
        );
    }

    /** KPI counts by cert_status for the caller's scope. */
    static async statusCounts(ids) {
        const params = [];
        const scope = scopeClause(ids, params, 'cc.employee_id');
        const rows = await db.all(
            `SELECT cc.cert_status AS status, COUNT(*)::int AS n
               FROM v_certification_current cc
              WHERE 1 = 1${scope}
              GROUP BY cc.cert_status`,
            params
        );
        const out = { valid: 0, expiring: 0, expired: 0, no_expiry: 0 };
        for (const r of rows) out[r.status] = r.n;
        return out;
    }

    // ---- Bulk import (Excel template → preview → commit) -------------------

    /**
     * Parse + validate the Certifications import workbook and, unless dryRun,
     * record every valid row. Idempotent: a row whose (employee, skill,
     * issued_on) already exists as a non-revoked record is skipped, so
     * re-importing the same file is safe.
     *
     * @returns {{ total, valid, created, skipped, errors: [{row, error}] }}
     */
    static async importWorkbook(filePath, { dryRun = true, actor = null } = {}) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sheet =
            workbook.getWorksheet('Certifications') ||
            workbook.worksheets.find((w) => w.name !== 'Instructions');
        if (!sheet) throw new Error('No "Certifications" sheet found in the workbook');

        // Cell → trimmed string ('' for empty); dates normalised to YYYY-MM-DD.
        const str = (v) => {
            if (v == null) return '';
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            if (typeof v === 'object' && v.text) return String(v.text).trim(); // rich text
            return String(v).trim();
        };
        const asDate = (v, label, rowNo, errors) => {
            const s = str(v);
            if (!s) return null;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
                errors.push({ row: rowNo, error: `${label} must be YYYY-MM-DD (got "${s}")` });
                return undefined;
            }
            return s;
        };

        const rows = [];
        sheet.eachRow((row, number) => {
            if (number === 1) return; // header
            const [, employeeNumber, skillName, certNumber, issuedOn, expiresOn, notes] =
                row.values;
            if (!str(employeeNumber) && !str(skillName)) return; // blank line
            rows.push({
                rowNo: number,
                employeeNumber: str(employeeNumber),
                skillName: str(skillName),
                certNumber: str(certNumber),
                issuedOn,
                expiresOn,
                notes: str(notes),
            });
        });

        const errors = [];
        const valid = [];
        let skipped = 0;
        for (const r of rows) {
            if (!r.employeeNumber) {
                errors.push({ row: r.rowNo, error: 'Employee Number is required' });
                continue;
            }
            if (!r.skillName) {
                errors.push({ row: r.rowNo, error: 'Skill Name is required' });
                continue;
            }
            const issuedOn = asDate(r.issuedOn, 'Issued On', r.rowNo, errors);
            if (issuedOn === undefined) continue;
            if (!issuedOn) {
                errors.push({ row: r.rowNo, error: 'Issued On is required' });
                continue;
            }
            const expiresOn = asDate(r.expiresOn, 'Expires On', r.rowNo, errors);
            if (expiresOn === undefined) continue;
            if (expiresOn && expiresOn <= issuedOn) {
                errors.push({ row: r.rowNo, error: 'Expires On must be after Issued On' });
                continue;
            }

            const emp = await db.get(
                'SELECT id FROM employees WHERE LOWER(employee_number) = LOWER(?)',
                [r.employeeNumber]
            );
            if (!emp) {
                errors.push({
                    row: r.rowNo,
                    error: `Unknown employee number "${r.employeeNumber}"`,
                });
                continue;
            }
            const skill = await db.get('SELECT id FROM skills WHERE LOWER(name) = LOWER(?)', [
                r.skillName,
            ]);
            if (!skill) {
                errors.push({ row: r.rowNo, error: `Unknown skill "${r.skillName}"` });
                continue;
            }

            const dup = await db.get(
                `SELECT id FROM employee_certifications
                  -- Revoked rows are INCLUDED in the duplicate check. Excluding
                  -- them meant re-importing the same workbook recreated a
                  -- certificate somebody had deliberately withdrawn — silently
                  -- re-certifying a person whose ticket was pulled after an
                  -- incident. A genuine re-issue carries a new issued_on and is
                  -- therefore unaffected.
                  WHERE employee_id = ? AND skill_id = ? AND issued_on = ?`,
                [emp.id, skill.id, issuedOn]
            );
            if (dup) {
                skipped++;
                continue;
            }

            valid.push({
                rowNo: r.rowNo,
                employeeId: Number(emp.id),
                skillId: Number(skill.id),
                certNumber: r.certNumber || null,
                issuedOn,
                expiresOn: expiresOn || null,
                notes: r.notes || null,
            });
        }

        let created = 0;
        if (!dryRun) {
            for (const v of valid) {
                await this.record(
                    {
                        employeeId: v.employeeId,
                        skillId: v.skillId,
                        certNumber: v.certNumber,
                        issuedOn: v.issuedOn,
                        expiresOn: v.expiresOn,
                        notes: v.notes,
                    },
                    actor
                );
                created++;
            }
        }
        return { total: rows.length, valid: valid.length, created, skipped, errors };
    }

    // ---- Certification VALIDITY → qualification signal ----------------------
    /**
     * A certificate that has lapsed must stop counting OUTSIDE this page.
     * Migration 78 exposes the authority as `v_certification_lapsed`: the
     * (employee, skill) pairs where a certification was HELD and is no longer
     * valid (latest record expired, or every record revoked). Readiness,
     * benchmark fit and the succession bench treat such a skill as level 0
     * until it is revalidated.
     *
     * Two deliberate limits, both about not over-reaching:
     *   - never held a certificate → nothing changes (a policy on the skill is
     *     not evidence that a given person was ever certified);
     *   - the requirement itself is untouched — the skill is still assessed and
     *     still counted in the role's requirement total. Only the verdict moves.
     */
    static get LAPSED_VIEW() {
        return 'v_certification_lapsed';
    }

    /**
     * SQL predicate for callers that compute qualification in SQL:
     *   `CASE WHEN ${CertificationService.lapsedExistsSql('e.id','r.skill_id')}
     *         THEN 0 ELSE COALESCE(sa.current_level, 0) END`
     * Column expressions are interpolated, never user input.
     */
    static lapsedExistsSql(employeeColExpr, skillColExpr) {
        return `EXISTS (SELECT 1 FROM ${CertificationService.LAPSED_VIEW} cl_x
                         WHERE cl_x.employee_id = ${employeeColExpr}
                           AND cl_x.skill_id = ${skillColExpr})`;
    }

    /**
     * Lapsed (employee, skill) pairs as a Set of "employeeId:skillId" keys, for
     * the JS-side qualification maths (ReadinessService). `employeeIds` null or
     * empty means "every employee".
     */
    static async lapsedPairSet(employeeIds = null) {
        const params = [];
        let where = '';
        if (Array.isArray(employeeIds)) {
            if (!employeeIds.length) return new Set();
            where = ` WHERE employee_id IN (${employeeIds.map(() => '?').join(',')})`;
            params.push(...employeeIds);
        }
        try {
            const rows = await db.all(
                `SELECT employee_id AS "employeeId", skill_id AS "skillId"
                   FROM ${CertificationService.LAPSED_VIEW}${where}`,
                params
            );
            return new Set(rows.map((r) => `${Number(r.employeeId)}:${Number(r.skillId)}`));
        } catch (e) {
            // Pre-migration-78 schema: degrade to "nothing lapsed" rather than
            // taking the readiness surfaces down with us.
            console.error('[certification] lapsedPairSet unavailable:', e.message);
            return new Set();
        }
    }

    /**
     * Requirements that are unmet ONLY because the held certificate lapsed —
     * the auditable link between /compliance and the readiness/benchmark/
     * succession numbers. Scoped like every other read on this service.
     */
    static async listLapseImpact(ids, { limit = 100 } = {}) {
        const params = [];
        const scope = scopeClause(ids, params, 'li.employee_id');
        params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000));
        try {
            return await db.all(
                `SELECT li.* FROM v_certification_lapse_impact li
                  WHERE 1 = 1${scope}
                  ORDER BY li.is_critical DESC, li.last_expires_on ASC NULLS LAST, li.full_name
                  LIMIT ?`,
                params
            );
        } catch (e) {
            console.error('[certification] lapse impact unavailable:', e.message);
            return [];
        }
    }

    /** Lapsed (or soon-lapsing) skill levels for the caller's scope. */
    static async listLapsed(ids, { limit = 200 } = {}) {
        const params = [];
        const scope = scopeClause(ids, params, 'sc.employee_id');
        params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
        return db.all(
            `SELECT sc.* FROM v_skill_currency sc
              WHERE sc.is_lapsed${scope}
              ORDER BY sc.days_since_assessed DESC
              LIMIT ?`,
            params
        );
    }
}

// Pure date helpers, exposed so the month-overflow and future-date rules can be
// tested directly rather than inferred from a database round-trip.
CertificationService.addMonthsClamped = addMonthsClamped;
CertificationService.isNotFuture = isNotFuture;

module.exports = CertificationService;
