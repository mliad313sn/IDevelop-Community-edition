'use strict';
/**
 * « New in the role » (4.0.0 port, wave 5).
 *
 * Someone who has just changed role is not "not ready" on their first day:
 * for `newInRoleMonths` months (App Setting, default 6, 0 = never) after the
 * date recorded in employees.role_start_date (migration 188), the 9-box and
 * PIP screens say so next to their name. Only a RECORDED start date counts:
 * without one there is no flag, never a guess from the hire date.
 */
const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 60;

/** The setting, read through AppSettingsModel; any failure reads as the default. */
async function newInRoleMonths() {
    try {
        const v = await require('../models/AppSettingsModel').getValue(
            'newInRoleMonths',
            String(DEFAULT_MONTHS)
        );
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return DEFAULT_MONTHS;
        return Math.min(MAX_MONTHS, Math.floor(n));
    } catch (_) {
        return DEFAULT_MONTHS;
    }
}

/** A DATE (Date, 'YYYY-MM-DD' or ISO string) as a UTC midnight, or null. */
function dayOf(v) {
    if (!v) return null;
    let s;
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null;
        // pg returns a DATE column as local midnight: keep the local calendar day.
        const p = (n) => String(n).padStart(2, '0');
        s = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    } else {
        s = String(v).slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pure: true when `roleStartDate` is on or before `today` and less than
 * `months` months before it. 0 months, no date or a future date: false.
 */
function isNewInRole(roleStartDate, months, today = new Date()) {
    const m = Number(months);
    if (!Number.isFinite(m) || m <= 0) return false;
    const start = dayOf(roleStartDate);
    if (!start) return false;
    const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (start > t) return false;
    const limit = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - Math.floor(m), t.getUTCDate())
    );
    return start > limit;
}

/**
 * The ids (of `employeeIds`) that are new in their role today, as a Set.
 * One query; a schema without the column answers an empty set.
 */
async function newInRoleIds(employeeIds, { months = null, today = new Date() } = {}) {
    const ids = [
        ...new Set((employeeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
    ];
    const out = new Set();
    if (!ids.length) return out;
    const m = months == null ? await newInRoleMonths() : Number(months);
    if (!m) return out;
    let rows = [];
    try {
        rows = await require('../config/database').all(
            `SELECT id, to_char(role_start_date, 'YYYY-MM-DD') AS "start"
               FROM employees WHERE id = ANY(?) AND role_start_date IS NOT NULL`,
            [ids]
        );
    } catch (_) {
        return out;
    }
    for (const r of rows || []) if (isNewInRole(r.start, m, today)) out.add(Number(r.id));
    return out;
}

module.exports = { DEFAULT_MONTHS, MAX_MONTHS, newInRoleMonths, isNewInRole, newInRoleIds };
