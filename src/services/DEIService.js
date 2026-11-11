'use strict';

/**
 * DEIService — fairness analytics over self-declared demographics (stored in the
 * sealed employee_demographics table, separate from core PII). Every aggregate
 * is suppressed below a minimum group size so individuals are never identifiable.
 * Answers the parity questions a CHRO/board/regulator actually asks: representation
 * by level, 9-box distribution by group, PIP rate by group.
 *
 * SELF-DECLARATION WITH EXPLICIT CONSENT ONLY (migration 171). Every field of
 * this table is VOLUNTARY (the HR master record `employees.nationality` is
 * separate):
 *   - only the person writes it, from « My diversity data » (/v2/cap/my-diversity,
 *     reachable whatever the talent module says, so consent can always be
 *     withdrawn), after ticking the consent box(es); a manager or an admin can
 *     no longer write it;
 *   - each declaration opens a row of the consent ledger (dei_consents: fields,
 *     consent-text version, dates); withdrawing nulls every value AT ONCE and
 *     closes the ledger row (kept, field names only);
 *   - ETHNICITY is off by default (special-category data under the GDPR and
 *     equivalent national laws): refused on input, hidden from every view and
 *     analytic, until the SuperAdmin turns deiEthnicityEnabled on by typing the
 *     legal sign-off (audited);
 *   - DISABILITY is kept for workplace accommodation: separate consent, seen by
 *     the person and by HR admins holding HR_SENSITIVE_PERMISSION — never by a
 *     manager, never an analytic dimension;
 *   - NATIONALITY follows the one nationality switch (the localContent module,
 *     utils/featureFlags): off, it is neither collected nor analysed;
 *   - rows of unknown provenance (written before 171, when self_declared
 *     defaulted to TRUE) are flagged needs_review: excluded from analytics,
 *     shown to the person to confirm or withdraw, and to HR to clear.
 */
const db = require('../config/database');

const MIN_GROUP = 5;

/** Consent-text version recorded in the ledger (bump when the wording changes). */
const CONSENT_TEXT_VERSION = 'dei-consent-v1';
/** HR admins holding this slug may read a person's declaration (incl. disability). */
const HR_SENSITIVE_PERMISSION = 'edit_employees';
/** The phrases the SuperAdmin types to turn ethnicity on (FR / EN, either works). */
const ETHNICITY_ACK_PHRASES = Object.freeze([
    'VALIDATION JURIDIQUE OBTENUE',
    'LEGAL SIGN-OFF OBTAINED',
]);

/**
 * Self-declared values are short labels ("Female", "35-44"), and they are
 * rendered back as group names on the talent hub. They used to be stored as
 * ANY free text — `<img src=x onerror=…>` included — and the hub wrote them
 * into innerHTML (stored XSS). Letters of any script, digits, spaces and a few
 * separators; nothing that can open markup. Max 64.
 */
const LABEL_RE = /^[\p{L}\p{M}\p{N} .'’\-_/()+,]{1,64}$/u;
const DEMO_FIELDS = ['gender', 'ethnicity', 'ageBand', 'nationality'];
const ALL_FIELDS = Object.freeze([...DEMO_FIELDS, 'disability']);
/** Analytic dimensions. Disability is deliberately NOT one. */
const DIMS = ['gender', 'ethnicity', 'age_band', 'nationality'];
/** Only rows the person declared (with consent) feed an analytic. */
const TRUSTED = "d.provenance = 'self' AND d.needs_review = false";
/** Active, non-erased employees — `e` = employees. */
const ACTIVE = 'e.is_active = true AND e.erased_at IS NULL';

/**
 * Complementary suppression over ONE breakdown (cells of a known total).
 * counts: cell sizes; seed: indices already hidden for another reason.
 * Primary: 0 < n < min is hidden. Complementary: while the hidden cells could
 * be recovered by subtraction to something identifying — exactly one hidden
 * cell, or hidden cells summing to fewer than `min` people — hide the smallest
 * visible cell (ties: the first). Returns the Set of hidden indices.
 */
function complementaryHide(counts, min = MIN_GROUP, seed = null) {
    const hide = new Set(seed ? [...seed] : []);
    counts.forEach((n, i) => {
        if (Number(n) > 0 && Number(n) < min) hide.add(i);
    });
    const unsafe = () => {
        if (!hide.size) return false;
        let sum = 0;
        for (const i of hide) sum += Number(counts[i]) || 0;
        return hide.size === 1 || sum < min;
    };
    while (unsafe()) {
        let pick = -1;
        counts.forEach((n, i) => {
            if (hide.has(i)) return;
            if (pick < 0 || Number(n) < Number(counts[pick])) pick = i;
        });
        if (pick < 0) break; // everything is hidden already
        hide.add(pick);
    }
    return hide;
}

/**
 * Two-way version for a (group × box) table: complementary suppression applied
 * along every row (group) and every column (box) until stable.
 * cells: [{grp, box, n}] → Set of hidden indices.
 */
function complementaryHide2D(cells, min = MIN_GROUP) {
    const hide = new Set();
    cells.forEach((c, i) => {
        if (c.n > 0 && c.n < min) hide.add(i);
    });
    const lines = (key) => {
        const m = new Map();
        cells.forEach((c, i) => {
            const k = String(c[key]);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(i);
        });
        return [...m.values()];
    };
    const all = [...lines('grp'), ...lines('box')];
    let changed = true;
    while (changed) {
        changed = false;
        for (const idx of all) {
            const seed = new Set(idx.map((i, j) => (hide.has(i) ? j : -1)).filter((j) => j >= 0));
            if (!seed.size) continue;
            const local = complementaryHide(
                idx.map((i) => cells[i].n),
                min,
                seed
            );
            for (const j of local) {
                if (!hide.has(idx[j])) {
                    hide.add(idx[j]);
                    changed = true;
                }
            }
        }
    }
    return hide;
}

function refuse(code, status = 400) {
    const e = new Error(code);
    e.status = status;
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

/** true / false / null (not declared) from a form or JSON value. */
function cleanBool(v) {
    if (v == null || v === '') return null;
    if (v === true || v === 'true' || v === '1' || v === 'yes') return true;
    if (v === false || v === 'false' || v === '0' || v === 'no') return false;
    throw refuse('dei_invalid_disability');
}

function ticked(v) {
    return v === true || v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

function isSuper(user) {
    return !!user && user.userType === 'admin' && user.role === 'superadmin';
}

/** The one nationality switch (the localContent module) — fails closed. */
async function nationalisationOn() {
    return require('../utils/featureFlags').isNationalisationEnabled();
}

async function audit(entry) {
    try {
        await require('./LogService').log(entry);
    } catch (_) {
        /* audit best-effort — never breaks the person's action */
    }
}

class DEIService {
    get MIN_GROUP() {
        return MIN_GROUP;
    }
    get CONSENT_TEXT_VERSION() {
        return CONSENT_TEXT_VERSION;
    }
    get HR_SENSITIVE_PERMISSION() {
        return HR_SENSITIVE_PERMISSION;
    }
    get ETHNICITY_ACK_PHRASES() {
        return ETHNICITY_ACK_PHRASES;
    }

    /** Validate a demographics payload; throws a 400 refusal on any bad field. */
    validate(d = {}) {
        const out = {};
        for (const f of DEMO_FIELDS) out[f] = cleanLabel(d[f], f);
        out.disability = cleanBool(d.disability);
        return out;
    }

    /** Is the ethnicity field switched on? Any doubt → off (fail closed). */
    async ethnicityEnabled() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = await AppSettingsModel.getValue('deiEthnicityEnabled', false);
            return v === true || v === 'true';
        } catch (_) {
            return false;
        }
    }

    /** May this user read a person's declaration (disability included)? Never a manager. */
    canReadSensitive(user) {
        if (!user || user.userType !== 'admin') return false;
        if (isSuper(user)) return true;
        try {
            return require('./RBACService').hasPermission(user, HR_SENSITIVE_PERMISSION) === true;
        } catch (_) {
            return false;
        }
    }

    /**
     * A manager/admin tried to write someone's demographics. Always refused:
     * the data is self-declared with the person's consent. Ethnicity and
     * disability get their own explicit message.
     */
    refuseOnBehalf(raw = {}) {
        const has = (k) => raw[k] != null && String(raw[k]).trim() !== '';
        if (has('ethnicity') || has('disability')) return refuse('dei_sensitive_self_only', 403);
        return refuse('dei_self_declared_only', 403);
    }

    /**
     * The person's OWN declaration, with explicit consent.
     * opts: { consent, consentDisability, locale }
     *  - any of gender / age band / nationality / ethnicity needs `consent`;
     *  - disability (yes / no) needs its own `consentDisability`;
     *  - ethnicity is refused (403) while the switch is off;
     *  - nationality is ignored while the nationality switch is off (a value
     *    already held is KEPT, never cleared, and stays under the consent).
     * Replaces the whole declaration: a field left blank is no longer held.
     */
    async declare(employeeId, raw = {}, opts = {}) {
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('dei_no_employee');
        const clean = this.validate(raw || {});
        if (clean.ethnicity != null && !(await this.ethnicityEnabled()))
            throw refuse('dei_ethnicity_disabled', 403);
        const natOn = await nationalisationOn();
        if (!natOn) clean.nationality = null;
        const statFields = DEMO_FIELDS.filter((f) => clean[f] != null);
        const fields = [...statFields];
        if (clean.disability != null) fields.push('disability');
        if (!fields.length) throw refuse('dei_nothing_declared');
        if (statFields.length && !ticked(opts.consent)) throw refuse('dei_consent_required');
        if (clean.disability != null && !ticked(opts.consentDisability))
            throw refuse('dei_consent_disability_required');
        const locale = opts.locale ? String(opts.locale).slice(0, 5) : null;

        const out = await db.runTransaction(async () => {
            let nationality = clean.nationality;
            if (!natOn) {
                const held = await db.get(
                    'SELECT nationality FROM employee_demographics WHERE employee_id = ?',
                    [id]
                );
                nationality = (held && held.nationality) || null;
                // The kept value stays covered by the consent ledger.
                if (nationality != null && !fields.includes('nationality'))
                    fields.push('nationality');
            }
            await db.run(
                `UPDATE dei_consents SET withdrawn_at = now(), end_reason = 'superseded'
                  WHERE employee_id = ? AND withdrawn_at IS NULL`,
                [id]
            );
            const c = await db.get(
                `INSERT INTO dei_consents (employee_id, fields, text_version, locale)
                 VALUES (?, ?, ?, ?) RETURNING id`,
                [id, fields, CONSENT_TEXT_VERSION, locale]
            );
            const consentId = c && c.id != null ? Number(c.id) : null;
            await db.get(
                `INSERT INTO employee_demographics
                   (employee_id, gender, ethnicity, age_band, disability, nationality,
                    self_declared, provenance, needs_review, consent_id,
                    hr_reviewed_at, hr_reviewed_by, hr_review_note, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, true, 'self', false, ?, NULL, NULL, NULL, now())
                 ON CONFLICT (employee_id) DO UPDATE SET gender = EXCLUDED.gender,
                   ethnicity = EXCLUDED.ethnicity, age_band = EXCLUDED.age_band,
                   disability = EXCLUDED.disability, nationality = EXCLUDED.nationality,
                   self_declared = true, provenance = 'self', needs_review = false,
                   consent_id = EXCLUDED.consent_id, hr_reviewed_at = NULL,
                   hr_reviewed_by = NULL, hr_review_note = NULL, updated_at = now()
                 RETURNING employee_id`,
                [
                    id,
                    clean.gender,
                    clean.ethnicity,
                    clean.ageBand,
                    clean.disability,
                    nationality,
                    consentId,
                ]
            );
            return { consentId, fields };
        });
        await audit({
            actorRef: `employee:${id}`,
            action: 'DEI_SELF_DECLARED',
            entityType: 'employee',
            entityId: id,
            category: 'privacy',
            // Field NAMES and the consent version only — never a declared value.
            details: `fields=${fields.join(',')} consent=${CONSENT_TEXT_VERSION}`,
        });
        return out;
    }

    /**
     * Withdraw consent: every declared value is nulled NOW; the ledger row is
     * closed, not deleted. Also works on a legacy (unknown-provenance) row.
     */
    async withdraw(employeeId) {
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('dei_no_employee');
        const res = await db.runTransaction(async () => {
            const closed = await db.run(
                `UPDATE dei_consents SET withdrawn_at = now(), end_reason = 'withdrawn'
                  WHERE employee_id = ? AND withdrawn_at IS NULL`,
                [id]
            );
            const cleared = await db.run(
                `UPDATE employee_demographics SET gender = NULL, ethnicity = NULL, age_band = NULL,
                        disability = NULL, nationality = NULL, self_declared = false,
                        provenance = 'withdrawn', needs_review = false, consent_id = NULL,
                        updated_at = now()
                  WHERE employee_id = ?`,
                [id]
            );
            return {
                consents: Number((closed && closed.changes) || 0),
                rows: Number((cleared && cleared.changes) || 0),
            };
        });
        await audit({
            actorRef: `employee:${id}`,
            action: 'DEI_CONSENT_WITHDRAWN',
            entityType: 'employee',
            entityId: id,
            category: 'privacy',
            details: 'declared values nulled; consent ledger closed',
        });
        return res;
    }

    /** Shape a stored row for display; ethnicity only when switched on (or its owner). */
    _present(row, { showEthnicity, showNationality = true }) {
        if (!row) return null;
        const out = {
            gender: row.gender ?? null,
            ageBand: row.ageBand ?? row.age_band ?? null,
            nationality: row.nationality ?? null,
            disability: row.disability == null ? null : row.disability === true,
            provenance: row.provenance || 'legacy_unknown',
            needsReview: row.needsReview === true || row.needs_review === true,
            updatedAt: row.updatedAt ?? row.updated_at ?? null,
        };
        const eth = row.ethnicity ?? null;
        if (showEthnicity) out.ethnicity = eth;
        else out.ethnicityHeld = eth != null;
        // Nationality switch off: the field is OMITTED (not shown as null).
        if (!showNationality) delete out.nationality;
        return out;
    }

    /**
     * The person's own view: their values (ethnicity and nationality included
     * when one is HELD, whatever the switches — it is their data, and they can
     * withdraw it), the consent in force, and which inputs the page offers.
     */
    async mine(employeeId) {
        const id = Number(employeeId);
        const [row, consent, enabled, natOn] = await Promise.all([
            db.get('SELECT * FROM employee_demographics WHERE employee_id = ?', [id]),
            db.get(
                `SELECT id, fields, text_version, granted_at FROM dei_consents
                  WHERE employee_id = ? AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1`,
                [id]
            ),
            this.ethnicityEnabled(),
            nationalisationOn(),
        ]);
        return {
            values: this._present(row, { showEthnicity: true }),
            consent: consent || null,
            ethnicityEnabled: enabled,
            nationalityEnabled: natOn,
        };
    }

    /**
     * HR read of ONE person's declaration (disability included). Admin with
     * HR_SENSITIVE_PERMISSION or SuperAdmin only — the route also checks scope.
     * Ethnicity only while switched on. Audited (ids only).
     */
    async hrView(user, employeeId) {
        if (!this.canReadSensitive(user)) throw refuse('dei_hr_only', 403);
        const id = Number(employeeId);
        const [row, enabled, natOn] = await Promise.all([
            db.get('SELECT * FROM employee_demographics WHERE employee_id = ?', [id]),
            this.ethnicityEnabled(),
            nationalisationOn(),
        ]);
        await audit({
            adminId: user.id,
            actorRef: `admin:${user.id}`,
            action: 'DEI_RECORD_VIEWED',
            entityType: 'employee',
            entityId: id,
            category: 'privacy',
            details: 'HR read of a self-declared demographics record',
        });
        return this._present(row, { showEthnicity: enabled, showNationality: natOn });
    }

    /**
     * HR review queue: rows of unknown provenance that still hold a value.
     * Field NAMES only (no values) — `scope` = employee ids (null = everyone).
     */
    async reviewQueue(scope) {
        if (Array.isArray(scope) && !scope.length) return [];
        const params = [];
        let where = '';
        if (Array.isArray(scope)) {
            where = ` AND d.employee_id IN (${scope.map(() => '?').join(',')})`;
            params.push(...scope.map(Number));
        }
        const rows = await db.all(
            `SELECT d.employee_id, e.first_name, e.last_name, d.updated_at,
                    (d.gender IS NOT NULL) AS has_gender, (d.ethnicity IS NOT NULL) AS has_ethnicity,
                    (d.age_band IS NOT NULL) AS has_age_band, (d.nationality IS NOT NULL) AS has_nationality,
                    (d.disability IS NOT NULL) AS has_disability
               FROM employee_demographics d JOIN employees e ON e.id = d.employee_id
              WHERE d.needs_review = true AND e.erased_at IS NULL
                AND (d.gender IS NOT NULL OR d.ethnicity IS NOT NULL OR d.age_band IS NOT NULL
                     OR d.nationality IS NOT NULL OR d.disability IS NOT NULL)${where}
              ORDER BY d.updated_at, d.employee_id`,
            params
        );
        const natOn = await nationalisationOn();
        return (rows || []).map((r) => {
            const held = [];
            if (r.hasGender) held.push('gender');
            if (r.hasAgeBand) held.push('ageBand');
            if (r.hasNationality && natOn) held.push('nationality');
            if (r.hasDisability) held.push('disability');
            if (r.hasEthnicity) held.push('ethnicity');
            return {
                employeeId: Number(r.employeeId),
                name: [r.firstName, r.lastName].filter(Boolean).join(' '),
                updatedAt: r.updatedAt,
                held,
            };
        });
    }

    /**
     * HR clears a flagged (unknown-provenance) row: values nulled, reason
     * recorded, audited. A self-declared row is the person's: 409.
     */
    async hrClear(user, employeeId, reason) {
        if (!this.canReadSensitive(user)) throw refuse('dei_hr_only', 403);
        const why = String(reason || '').trim();
        if (why.length < 5) throw refuse('dei_reason_required');
        const id = Number(employeeId);
        const r = await db.run(
            `UPDATE employee_demographics SET gender = NULL, ethnicity = NULL, age_band = NULL,
                    disability = NULL, nationality = NULL, self_declared = false,
                    provenance = 'hr_cleared', needs_review = false, consent_id = NULL,
                    hr_reviewed_at = now(), hr_reviewed_by = ?, hr_review_note = ?, updated_at = now()
              WHERE employee_id = ? AND needs_review = true`,
            [`admin:${user.id}`, why.slice(0, 500), id]
        );
        if (!r || !Number(r.changes)) throw refuse('dei_not_pending_review', 409);
        await audit({
            adminId: user.id,
            actorRef: `admin:${user.id}`,
            action: 'DEI_LEGACY_CLEARED',
            entityType: 'employee',
            entityId: id,
            category: 'privacy',
            details: 'unknown-provenance demographics cleared by HR (reason recorded on the row)',
        });
        return { ok: true };
    }

    /** The ethnicity switch + its sign-off record (for the SuperAdmin panel). */
    async ethnicityStatus() {
        const enabled = await this.ethnicityEnabled();
        let signoff = null;
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            signoff = await AppSettingsModel.getValue('deiEthnicitySignoff', null);
        } catch (_) {
            signoff = null;
        }
        return { enabled, signoff: signoff && typeof signoff === 'object' ? signoff : null };
    }

    /**
     * SuperAdmin turns ethnicity on (typed acknowledgement of the legal
     * sign-off + its reference) or off. Audited. Never via the generic
     * settings form (both keys are readOnly in the settings catalog).
     */
    async setEthnicityEnabled(user, { enabled, acknowledgement, reference } = {}) {
        if (!isSuper(user)) throw refuse('dei_superadmin_only', 403);
        const on = ticked(enabled);
        const AppSettingsModel = require('../models/AppSettingsModel');
        let record;
        if (on) {
            const typed = String(acknowledgement || '')
                .trim()
                .replace(/\s+/g, ' ')
                .toUpperCase();
            if (!ETHNICITY_ACK_PHRASES.includes(typed)) throw refuse('dei_ack_mismatch');
            const ref = String(reference || '').trim();
            if (ref.length < 10) throw refuse('dei_signoff_reference_required');
            record = {
                enabled: true,
                acknowledgement: typed,
                reference: ref.slice(0, 500),
                by: `admin:${user.id}`,
                at: new Date().toISOString(),
            };
        } else {
            const prev = await this.ethnicityStatus();
            record = {
                ...(prev.signoff || {}),
                enabled: false,
                disabledBy: `admin:${user.id}`,
                disabledAt: new Date().toISOString(),
            };
        }
        await AppSettingsModel.setValue(
            'deiEthnicitySignoff',
            record,
            'json',
            'DEI ethnicity switch: legal sign-off record (who, when, reference) — written by the DEI panel, never by hand',
            'privacy',
            user.id
        );
        await AppSettingsModel.setValue(
            'deiEthnicityEnabled',
            on,
            'boolean',
            'DEI: collect and show self-declared ethnicity (off by default; enabling requires a typed legal sign-off)',
            'privacy',
            user.id
        );
        await audit({
            adminId: user.id,
            actorRef: `admin:${user.id}`,
            action: on ? 'DEI_ETHNICITY_ENABLED' : 'DEI_ETHNICITY_DISABLED',
            entityType: 'appSetting',
            category: 'security',
            severity: 'warn',
            details: on
                ? `ethnicity collection enabled; legal sign-off reference recorded (${record.reference.length} chars)`
                : 'ethnicity collection disabled',
        });
        return { enabled: on };
    }

    /**
     * Small cells hidden, WITH complementary suppression: a hidden cell returns
     * no count at all (the key is absent), and whenever the hidden cells of a
     * breakdown could be recovered by subtraction from a known total (exactly
     * one hidden cell, or hidden cells that sum to fewer than MIN_GROUP people),
     * the next smallest visible cell is hidden too.
     */
    _suppress(rows, countKey = 'n') {
        const hide = complementaryHide(rows.map((r) => Number(r[countKey])));
        return rows.map((r, i) => {
            if (!hide.has(i)) return { ...r, [countKey]: Number(r[countKey]) };
            const out = { ...r, suppressed: true };
            delete out[countKey];
            return out;
        });
    }

    /** A dimension is valid AND allowed (ethnicity / nationality only while switched on). */
    async _dim(dim) {
        if (!DIMS.includes(dim)) throw refuse('dei_invalid_dimension');
        if (dim === 'ethnicity' && !(await this.ethnicityEnabled()))
            throw refuse('dei_ethnicity_disabled', 403);
        // Nationality switch off: the dimension does not exist (neutral refusal).
        if (dim === 'nationality' && !(await nationalisationOn()))
            throw refuse('dei_invalid_dimension');
        return dim;
    }

    /** Representation: headcount by a demographic dimension (active, non-erased). */
    async representation(dim = 'gender') {
        const col = await this._dim(dim);
        const rows = await db.all(
            `SELECT COALESCE(d.${col}, 'Undeclared') AS grp, COUNT(*) AS n
             FROM employees e JOIN employee_demographics d ON d.employee_id = e.id
             WHERE ${ACTIVE} AND ${TRUSTED} GROUP BY 1 ORDER BY 2 DESC, 1`
        );
        return this._suppress(rows || []);
    }

    /**
     * 9-box distribution by demographic group (latest cycle) of active,
     * non-erased people. Small cells hidden with complementary suppression
     * along every group (row) AND every box (column): no cell can be recovered
     * by subtracting from a group total or a box total.
     */
    async nineBoxByGroup(dim = 'gender') {
        const col = await this._dim(dim);
        const rows = await db.all(
            `SELECT COALESCE(d.${col},'Undeclared') AS grp, p.box, COUNT(*) AS n
             FROM talent_placements p
             JOIN employees e ON e.id = p.employee_id
             JOIN employee_demographics d ON d.employee_id = p.employee_id
             WHERE p.cycle_id = (SELECT MAX(cycle_id) FROM talent_placements)
               AND ${ACTIVE} AND ${TRUSTED}
             GROUP BY 1, 2 ORDER BY 1, 2`
        );
        const cells = (rows || []).map((r) => ({ grp: r.grp, box: r.box, n: Number(r.n) }));
        const hidden = complementaryHide2D(cells);
        return cells.map((c, i) =>
            hidden.has(i)
                ? { grp: c.grp, box: c.box, suppressed: true }
                : { grp: c.grp, box: c.box, n: c.n }
        );
    }

    /**
     * PIP rate by group: active PIPs / headcount (active, non-erased). A group
     * under MIN_GROUP returns NO figure (not even its headcount); the headcounts
     * get the same complementary suppression as representation(); the PIP
     * figures are hidden when either the count or its complement is small
     * (« 1 of 6 » identifies), then complementary-suppressed across groups.
     */
    async pipRateByGroup(dim = 'gender') {
        const col = await this._dim(dim);
        const rows = await db.all(
            `SELECT COALESCE(d.${col},'Undeclared') AS grp, COUNT(*) AS headcount,
                    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pips pp WHERE pp.employee_id = e.id AND pp.state IN ('proposed','approved','active'))) AS on_pip
             FROM employees e JOIN employee_demographics d ON d.employee_id = e.id
             WHERE ${ACTIVE} AND ${TRUSTED} GROUP BY 1 ORDER BY 1`
        );
        const groups = (rows || []).map((r) => ({
            grp: r.grp,
            headcount: Number(r.headcount),
            onPip: Number(r.onPip),
        }));
        const hideHead = complementaryHide(groups.map((g) => g.headcount));
        const seed = new Set();
        groups.forEach((g, i) => {
            if (hideHead.has(i) || g.onPip < MIN_GROUP || g.headcount - g.onPip < MIN_GROUP)
                seed.add(i);
        });
        const hidePip = complementaryHide(
            groups.map((g) => g.onPip),
            MIN_GROUP,
            seed
        );
        return groups.map((g, i) => {
            if (hideHead.has(i)) return { grp: g.grp, suppressed: true };
            if (hidePip.has(i)) return { grp: g.grp, headcount: g.headcount, suppressed: true };
            return {
                grp: g.grp,
                headcount: g.headcount,
                onPip: g.onPip,
                pipRatePct: Math.round((g.onPip / g.headcount) * 100),
            };
        });
    }
}

const service = new DEIService();
service.ALL_FIELDS = ALL_FIELDS;
service.complementaryHide = complementaryHide;
service.complementaryHide2D = complementaryHide2D;
module.exports = service;
