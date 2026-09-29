'use strict';
/**
 * SSO migration — bulk remap of EXISTING employees onto SSO identities
 * (migration 144, console /admin/sso-migration).
 *
 * The operator uploads the directory export (Microsoft Entra "Download users":
 * objectId, userPrincipalName, mail, employeeId, displayName, userType,
 * accountEnabled). Every row is matched onto an employee — employee number
 * first (unique, decisive), then e-mail against `mail`, then e-mail against the
 * UPN — and classified with a named outcome. Nothing is ever guessed: two keys
 * pointing at different people, an address shared by several accounts, a key
 * already held, a duplicate in the file… each stops the row with its reason.
 *
 * Applying writes PENDING mappings (sso_pending_links), not identities: the
 * mapping is claimed by the person's first SIGNED sign-in presenting the same
 * objectId / UPN / employeeId (SsoService.claimPendingMapping). So nobody is
 * linked on the strength of a file alone, and the first SSO sign-in lands on
 * the existing account — never on a duplicate, never in the onboarding queue.
 *
 * Invariants:
 *   - EMPLOYEES ONLY. Administrators sign in with password + MFA by policy.
 *   - Dry run first. An apply replays a stored preview and is refused when the
 *     re-computed outcome differs from what the operator confirmed.
 *   - The outcome counts always add up to the rows of the file.
 *   - Undo cancels the batch's mappings that are still pending; a mapping
 *     already claimed is a real sign-in and is reported, never silently kept.
 *
 * @module services/SsoRemapService
 */
const crypto = require('crypto');
const db = require('../config/database');
const LogService = require('./LogService');

const MAX_ROWS = 20000;
const PREVIEW_TTL_HOURS = 24;
const LOCK_KEY = 144144; // pg advisory lock: one apply/undo at a time

/**
 * Providers a mapping may target: only those whose sign-in presents a claim key
 * (objectId / UPN / employeeId). The generic OIDC and Google handlers carry
 * none, so a mapping for them could never be claimed — and would keep the
 * person out of every later batch as "already awaiting sign-in".
 */
const PROVIDERS = ['saml', 'entra'];

/** Outcomes that become a mapping on apply. */
const APPLYABLE = new Set(['will_map']);

/** Every outcome, in display order. */
const OUTCOMES = [
    'will_map',
    'already_linked',
    'already_mapped',
    'no_match',
    'ambiguous',
    'conflicting_keys',
    'duplicate_in_file',
    'duplicate_target',
    'identity_taken',
    'key_taken',
    'inactive',
    'local_only',
    'guest',
    'directory_disabled',
    'no_claim_key',
];

// Accepted header spellings, normalised (lower-case, no spaces/underscores/dashes).
const HEADERS = {
    objectId: ['objectid', 'id', 'objectidentifier', 'oid', 'azureadobjectid'],
    upn: ['userprincipalname', 'upn', 'principalname'],
    mail: ['mail', 'email', 'emailaddress', 'courriel'],
    employeeId: ['employeeid', 'employeenumber', 'matricule', 'employeeno'],
    displayName: ['displayname', 'name', 'nom', 'fullname'],
    userType: ['usertype'],
    accountEnabled: ['accountenabled', 'enabled'],
    // MSOnline exports carry the OPPOSITE flag: BlockCredential = true means disabled.
    blockCredential: ['blockcredential'],
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lc = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const trim = (v) => (v == null ? '' : String(v).trim());
const headerKey = (h) =>
    lc(h)
        .replace(/^\ufeff/, '')
        .replace(/[\s_\-.]/g, '');

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Split one CSV text into rows of cells (RFC 4180 quotes, ',' or ';'). */
function _cells(text, sep) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else q = false;
            } else cell += c;
        } else if (c === '"') q = true;
        else if (c === sep) {
            row.push(cell);
            cell = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else cell += c;
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/**
 * Parse a directory export. Returns the normalised rows, or `error` (a locale
 * key under admin:) when the file cannot be used at all.
 * @returns {{rows?: Array<object>, columns?: string[], error?: string, params?: object}}
 */
function parseCsv(text) {
    let t = String(text == null ? '' : text).replace(/^\ufeff/, '');
    // Excel's "sep=," hint line.
    let sep = null;
    const m = /^sep=(.)\r?\n/i.exec(t);
    if (m) {
        sep = m[1];
        t = t.slice(m[0].length);
    }
    const first = t.split(/\r?\n/, 1)[0] || '';
    if (!sep) sep = first.split(';').length > first.split(',').length ? ';' : ',';
    const grid = _cells(t, sep);
    if (grid.length < 2) return { error: 'ssom_err_empty' };

    const head = grid[0].map(headerKey);
    const col = {};
    for (const [field, names] of Object.entries(HEADERS)) {
        const idx = head.findIndex((h) => names.includes(h));
        if (idx >= 0) col[field] = idx;
    }
    const body = grid.slice(1);
    // A bare "id" column is the objectId only in a Graph export, where it holds
    // GUIDs; a generic ID column (a row number, a staff code) is not.
    if (col.objectId != null && head[col.objectId] === 'id') {
        const firstVal = body.map((r) => trim(r[col.objectId])).find((v) => v);
        if (!firstVal || !GUID.test(firstVal)) delete col.objectId;
    }
    if (col.objectId == null && col.upn == null && col.employeeId == null) {
        return { error: 'ssom_err_no_key_column' };
    }
    if (body.length > MAX_ROWS) return { error: 'ssom_err_too_many', params: { max: MAX_ROWS } };

    const get = (r, f) => (col[f] == null ? '' : trim(r[col[f]]));
    const rows = body.map((r, i) => ({
        rowNo: i + 2, // the spreadsheet line (header is line 1)
        objectId: get(r, 'objectId'),
        upn: get(r, 'upn'),
        mail: get(r, 'mail'),
        employeeId: get(r, 'employeeId'),
        displayName: get(r, 'displayName'),
        userType: get(r, 'userType'),
        accountEnabled:
            get(r, 'accountEnabled') ||
            (col.blockCredential != null && get(r, 'blockCredential') !== ''
                ? _falsy(get(r, 'blockCredential'))
                    ? 'true'
                    : 'false'
                : ''),
    }));
    return { rows, columns: Object.keys(col) };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function _falsy(v) {
    const s = lc(v);
    return s === 'false' || s === 'no' || s === 'non' || s === '0' || s === 'faux';
}

/** Everything classify needs, loaded once. */
async function _context(provider) {
    const emps = await db.all(
        `SELECT e.id, e.employee_number, e.email, e.first_name, e.last_name,
                e.is_account_active, e.auth_policy, s.name AS site_name
           FROM employees e LEFT JOIN sites s ON s.id = e.site_id`
    );
    const byId = new Map();
    const byNumber = new Map();
    const byEmail = new Map();
    for (const e of emps) {
        const rec = {
            id: Number(e.id),
            number: trim(e.employeeNumber ?? e.employee_number),
            email: lc(e.email),
            name: `${trim(e.firstName ?? e.first_name)} ${trim(e.lastName ?? e.last_name)}`.trim(),
            active: (e.isAccountActive ?? e.is_account_active) === true,
            localOnly: String(e.authPolicy ?? e.auth_policy ?? 'any') === 'local_only',
            site: trim(e.siteName ?? e.site_name),
        };
        byId.set(rec.id, rec);
        if (rec.number) {
            const k = lc(rec.number);
            byNumber.set(k, [...(byNumber.get(k) || []), rec]);
        }
        if (rec.email) byEmail.set(rec.email, [...(byEmail.get(rec.email) || []), rec]);
    }
    const ids = await db.all(
        'SELECT subject_type, subject_id, sso_uid FROM user_identities WHERE sso_provider = ?',
        [provider]
    );
    const linkedEmployees = new Set();
    const uidHolder = new Map();
    for (const r of ids) {
        const type = r.subjectType ?? r.subject_type;
        const sid = Number(r.subjectId ?? r.subject_id);
        if (type === 'employee') linkedEmployees.add(sid);
        uidHolder.set(lc(r.ssoUid ?? r.sso_uid), { type, id: sid });
    }
    const pend = await db.all(
        `SELECT id, employee_id, match_object_id, match_upn, match_employee_id
           FROM sso_pending_links WHERE provider = ? AND status = 'pending'`,
        [provider]
    );
    const pendingByEmployee = new Map();
    const pendingKey = new Map(); // 'oid:x' / 'upn:x' / 'emp:x' -> employee id
    for (const p of pend) {
        const eid = Number(p.employeeId ?? p.employee_id);
        pendingByEmployee.set(eid, p);
        const o = p.matchObjectId ?? p.match_object_id;
        const u = p.matchUpn ?? p.match_upn;
        const x = p.matchEmployeeId ?? p.match_employee_id;
        if (o) pendingKey.set('oid:' + o, eid);
        if (u) pendingKey.set('upn:' + u, eid);
        if (x) pendingKey.set('emp:' + lc(x), eid);
    }
    return { byId, byNumber, byEmail, linkedEmployees, uidHolder, pendingByEmployee, pendingKey };
}

const _label = (e) => ({ id: e.id, name: e.name, number: e.number, site: e.site });

/**
 * Classify every row. Pure over (rows, ctx, resolutions) so it is unit-tested
 * without a database. `resolutions` maps a rowNo to an employee id chosen by
 * the operator for a row the matcher could not decide.
 */
function classify(rows, ctx, resolutions = {}) {
    // Keys seen more than once in the file can identify nobody.
    const seen = new Map();
    const note = (k) => {
        if (k) seen.set(k, (seen.get(k) || 0) + 1);
    };
    for (const r of rows) {
        note(r.objectId && 'oid:' + lc(r.objectId));
        note(r.upn && 'upn:' + lc(r.upn));
        note(r.employeeId && 'emp:' + lc(r.employeeId));
    }
    const dupInFile = (r) =>
        ['oid:' + lc(r.objectId), 'upn:' + lc(r.upn), 'emp:' + lc(r.employeeId)].some(
            (k) => !k.endsWith(':') && seen.get(k) > 1
        );

    const out = rows.map((r) => {
        const res = {
            rowNo: r.rowNo,
            input: r,
            outcome: null,
            matchKey: null,
            employee: null,
            candidates: [],
        };
        const set = (outcome) => {
            res.outcome = outcome;
            return res;
        };
        const oid = lc(r.objectId);
        const upn = lc(r.upn);
        const empKey = lc(r.employeeId);
        if (!oid && !upn && !empKey) return set('no_claim_key');
        if (lc(r.userType) === 'guest' || upn.includes('#ext#')) return set('guest');
        if (r.accountEnabled !== '' && _falsy(r.accountEnabled)) return set('directory_disabled');
        if (dupInFile(r)) return set('duplicate_in_file');

        // --- find the employee ---
        let target = null;
        const manual = resolutions[r.rowNo] != null ? Number(resolutions[r.rowNo]) : null;
        if (manual) {
            target = ctx.byId.get(manual) || null;
            if (!target) return set('no_match');
            res.matchKey = 'manual';
        } else {
            const byNum = empKey ? ctx.byNumber.get(empKey) || [] : [];
            const byMail = lc(r.mail) ? ctx.byEmail.get(lc(r.mail)) || [] : [];
            const byUpn = upn ? ctx.byEmail.get(upn) || [] : [];
            if (byNum.length > 1) {
                res.candidates = byNum.map(_label);
                return set('ambiguous');
            }
            if (byNum.length === 1) {
                target = byNum[0];
                res.matchKey = 'employee_number';
                // A decisive key contradicted by another single match: stop.
                const other = [...byMail, ...byUpn].filter((e) => e.id !== target.id);
                if (other.length) {
                    res.candidates = [target, ...other].map(_label);
                    return set('conflicting_keys');
                }
            } else {
                const ids = [...new Set([...byMail, ...byUpn].map((e) => e.id))];
                if (ids.length > 1) {
                    res.candidates = ids.map((id) => _label(ctx.byId.get(id)));
                    return set('ambiguous');
                }
                if (!ids.length) return set('no_match');
                target = ctx.byId.get(ids[0]);
                res.matchKey = byMail.length ? 'email' : 'upn';
            }
        }
        res.employee = _label(target);

        // --- is this person mappable? ---
        if (!target.active) return set('inactive');
        if (target.localOnly) return set('local_only');
        if (ctx.linkedEmployees.has(target.id)) return set('already_linked');
        if (ctx.pendingByEmployee.has(target.id)) return set('already_mapped');
        if (oid) {
            const h = ctx.uidHolder.get(oid);
            if (h && !(h.type === 'employee' && h.id === target.id)) return set('identity_taken');
        }
        // Only keys the row actually carries; an absent key holds nothing.
        const keyHolders = [
            oid ? ctx.pendingKey.get('oid:' + oid) : undefined,
            upn ? ctx.pendingKey.get('upn:' + upn) : undefined,
            empKey ? ctx.pendingKey.get('emp:' + empKey) : undefined,
        ].filter((x) => typeof x === 'number' && x !== target.id);
        if (keyHolders.length) return set('key_taken');
        return set('will_map');
    });

    // Two rows landing on the same person: neither may win.
    const perTarget = new Map();
    out.filter((r) => r.outcome === 'will_map').forEach((r) =>
        perTarget.set(r.employee.id, [...(perTarget.get(r.employee.id) || []), r])
    );
    for (const list of perTarget.values()) {
        if (list.length > 1)
            list.forEach((r) => {
                r.outcome = 'duplicate_target';
            });
    }
    return out;
}

function summarize(classified) {
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    classified.forEach((r) => {
        counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    });
    const total = classified.length;
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    if (sum !== total)
        throw new Error(`SSO remap: outcome counts (${sum}) do not add up to the rows (${total})`);
    return { total, counts, toMap: counts.will_map, fingerprint: fingerprint(classified) };
}

/**
 * WHO would be mapped, not how many: sha256 over the sorted (line, employee)
 * pairs of the mappable rows. An apply is refused unless it reproduces the
 * preview's fingerprint — the same count can hide a different person.
 */
function fingerprint(classified) {
    const pairs = classified
        .filter((r) => APPLYABLE.has(r.outcome))
        .map((r) => `${r.rowNo}:${r.employee.id}`)
        .sort();
    return crypto.createHash('sha256').update(pairs.join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// Preview / apply / undo
// ---------------------------------------------------------------------------

function _isSuper(actor) {
    return !!actor && actor.userType === 'admin' && String(actor.role) === 'superadmin';
}

function _checkProvider(provider) {
    return PROVIDERS.includes(provider);
}

function _cleanResolutions(resolutions) {
    const out = {};
    Object.entries(resolutions || {}).forEach(([k, v]) => {
        const rn = Number(k);
        const id = Number(v);
        if (Number.isInteger(rn) && rn > 0 && Number.isInteger(id) && id > 0) out[rn] = id;
    });
    return out;
}

async function _persistBatch({
    provider,
    mode,
    status,
    dryRunOf,
    sourceName,
    sha,
    classified,
    summary,
    actor,
    resolutions,
}) {
    const b = await db.get(
        `INSERT INTO sso_remap_batches (provider, mode, status, dry_run_of, source_name, source_sha256,
                                        row_count, summary, created_by, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ${mode === 'apply' ? 'now()' : 'NULL'})
         RETURNING id`,
        [
            provider,
            mode,
            status,
            dryRunOf || null,
            sourceName || null,
            sha,
            classified.length,
            JSON.stringify({ ...summary, resolutions: resolutions || {} }),
            Number(actor.id),
        ]
    );
    const batchId = Number(b.id);
    for (const r of classified) {
        await db.run(
            `INSERT INTO sso_remap_rows (batch_id, row_no, input, match_key, employee_id, outcome, pending_id)
             VALUES (?, ?, ?::jsonb, ?, ?, ?, ?)`,
            [
                batchId,
                r.rowNo,
                JSON.stringify(r.input),
                r.matchKey,
                r.employee ? r.employee.id : null,
                r.outcome,
                r.pendingId || null,
            ]
        );
    }
    return batchId;
}

/**
 * Dry run: parse, classify, store. Never writes a mapping.
 * @returns {Promise<{ok:boolean, code?:string, params?:object, batchId?:number, rows?:Array, summary?:object}>}
 */
async function preview({ text, sourceName, provider, resolutions }, actor) {
    if (!_isSuper(actor)) return { ok: false, code: 'ssom_err_super_only' };
    if (!_checkProvider(provider)) return { ok: false, code: 'ssom_err_provider' };
    const parsed = parseCsv(text);
    if (parsed.error) return { ok: false, code: parsed.error, params: parsed.params };
    const res = _cleanResolutions(resolutions);
    const ctx = await _context(provider);
    const classified = classify(parsed.rows, ctx, res);
    const summary = summarize(classified);
    const sha = crypto.createHash('sha256').update(String(text)).digest('hex');
    let batchId;
    await db.runTransaction(async () => {
        batchId = await _persistBatch({
            provider,
            mode: 'dry_run',
            status: 'previewed',
            sourceName,
            sha,
            classified,
            summary,
            actor,
            resolutions: res,
        });
    });
    await LogService.log({
        adminId: actor.id,
        action: 'SSO_REMAP_PREVIEW',
        entityType: 'sso_remap_batch',
        entityId: batchId,
        details: `SSO migration dry run #${batchId} (${provider}, ${sourceName || 'file'}): ${summary.total} rows, ${summary.toMap} mappable.`,
    });
    return { ok: true, batchId, rows: classified, summary, columns: parsed.columns };
}

/** Rows of a stored batch, re-shaped as classify input. */
async function _storedInputs(batchId) {
    const rows = await db.all(
        'SELECT row_no, input FROM sso_remap_rows WHERE batch_id = ? ORDER BY row_no',
        [batchId]
    );
    return rows.map((r) => {
        const inp = typeof r.input === 'string' ? JSON.parse(r.input) : r.input || {};
        return { ...inp, rowNo: Number(r.rowNo ?? r.row_no) };
    });
}

/**
 * Apply a previewed batch. The rows are RE-CLASSIFIED against live data under
 * a lock; if the number of mappings differs from `expectedCount` (what the
 * operator typed to confirm), nothing is written and the preview must be
 * re-run — the data moved since it was shown.
 */
async function apply({ previewId, expectedCount }, actor) {
    if (!_isSuper(actor)) return { ok: false, code: 'ssom_err_super_only' };
    const b = await db.get(
        `SELECT id, provider, mode, status, source_name, source_sha256, summary, created_at,
                (created_at < now() - make_interval(hours => ?::int)) AS expired,
                EXISTS (SELECT 1 FROM sso_remap_batches x WHERE x.dry_run_of = sso_remap_batches.id) AS used
           FROM sso_remap_batches WHERE id = ?`,
        [PREVIEW_TTL_HOURS, Number(previewId)]
    );
    if (!b || b.mode !== 'dry_run') return { ok: false, code: 'ssom_err_no_preview' };
    if (b.expired === true)
        return {
            ok: false,
            code: 'ssom_err_preview_expired',
            params: { hours: PREVIEW_TTL_HOURS },
        };
    if (b.used === true) return { ok: false, code: 'ssom_err_preview_used' };
    const summaryIn = typeof b.summary === 'string' ? JSON.parse(b.summary) : b.summary || {};
    const res = _cleanResolutions(summaryIn.resolutions);
    const provider = b.provider;
    const inputs = await _storedInputs(Number(b.id));

    let result = null;
    await db.runTransaction(async () => {
        await db.get('SELECT pg_advisory_xact_lock(?) AS l', [LOCK_KEY]);
        const ctx = await _context(provider);
        const classified = classify(inputs, ctx, res);
        const summary = summarize(classified);
        if (
            Number(expectedCount) !== summary.toMap ||
            summary.fingerprint !== summaryIn.fingerprint
        ) {
            result = {
                ok: false,
                code: 'ssom_err_stale',
                params: { expected: Number(expectedCount) || 0, now: summary.toMap },
            };
            return;
        }
        for (const r of classified) {
            if (!APPLYABLE.has(r.outcome)) continue;
            const p = await db.get(
                `INSERT INTO sso_pending_links (provider, employee_id, match_object_id, match_upn, match_employee_id, created_by)
                 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
                [
                    provider,
                    r.employee.id,
                    lc(r.input.objectId) || null,
                    lc(r.input.upn) || null,
                    lc(r.input.employeeId) || null,
                    Number(actor.id),
                ]
            );
            r.pendingId = Number(p.id);
        }
        const batchId = await _persistBatch({
            provider,
            mode: 'apply',
            status: 'applied',
            dryRunOf: Number(b.id),
            sourceName: b.sourceName ?? b.source_name,
            sha: b.sourceSha256 ?? b.source_sha256,
            classified,
            summary,
            actor,
            resolutions: res,
        });
        await db.run(
            'UPDATE sso_pending_links SET batch_id = ? WHERE id IN (SELECT pending_id FROM sso_remap_rows WHERE batch_id = ? AND pending_id IS NOT NULL)',
            [batchId, batchId]
        );
        result = { ok: true, batchId, summary, provider };
    });
    if (result && result.ok) {
        await LogService.log({
            adminId: actor.id,
            action: 'SSO_REMAP_APPLIED',
            entityType: 'sso_remap_batch',
            entityId: result.batchId,
            details: `SSO migration batch #${result.batchId} applied from dry run #${b.id} (${provider}): ${result.summary.toMap} mapping(s) created, ${result.summary.total - result.summary.toMap} row(s) not mapped.`,
        });
    }
    return result;
}

/**
 * Undo an applied batch: cancel its mappings that are still pending. Mappings
 * already claimed by a sign-in are real links now — they are counted and left,
 * to be removed per account (employee page → Authentication methods) if wrong.
 */
async function undo({ batchId, reason }, actor) {
    if (!_isSuper(actor)) return { ok: false, code: 'ssom_err_super_only' };
    const why = trim(reason);
    if (why.length < 5) return { ok: false, code: 'ssom_err_reason' };
    let result = null;
    await db.runTransaction(async () => {
        await db.get('SELECT pg_advisory_xact_lock(?) AS l', [LOCK_KEY]);
        const b = await db.get(
            'SELECT id, mode, status FROM sso_remap_batches WHERE id = ? FOR UPDATE',
            [Number(batchId)]
        );
        if (!b || b.mode !== 'apply') {
            result = { ok: false, code: 'ssom_err_no_batch' };
            return;
        }
        if (b.status === 'reverted') {
            result = { ok: false, code: 'ssom_err_already_reverted' };
            return;
        }
        const r = await db.run(
            `UPDATE sso_pending_links SET status = 'cancelled', cancelled_at = now(), cancelled_by = ?
              WHERE batch_id = ? AND status = 'pending'`,
            [Number(actor.id), Number(b.id)]
        );
        const kept = await db.get(
            "SELECT COUNT(*)::int AS n FROM sso_pending_links WHERE batch_id = ? AND status = 'bound'",
            [Number(b.id)]
        );
        await db.run(
            `UPDATE sso_remap_batches SET status = 'reverted', reverted_at = now(), reverted_by = ?, revert_reason = ?
              WHERE id = ?`,
            [Number(actor.id), why, Number(b.id)]
        );
        result = {
            ok: true,
            batchId: Number(b.id),
            cancelled: r.changes || 0,
            alreadyClaimed: Number(kept.n) || 0,
        };
    });
    if (result && result.ok) {
        await LogService.log({
            adminId: actor.id,
            action: 'SSO_REMAP_REVERTED',
            entityType: 'sso_remap_batch',
            entityId: result.batchId,
            details: `SSO migration batch #${result.batchId} undone: ${result.cancelled} pending mapping(s) cancelled, ${result.alreadyClaimed} already claimed by a sign-in kept. Reason: ${why}`,
        });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

/**
 * Where the migration stands, over ACTIVE sign-in accounts. Each figure is a
 * measurement: "signed in via SSO" reads user_identities.last_used_at, stamped
 * by the SSO sign-in path — a link that exists is not a sign-in that happened.
 */
async function readiness() {
    const r = await db.get(`
        WITH act AS (SELECT id, auth_policy FROM employees WHERE is_account_active = true),
             linked AS (SELECT DISTINCT subject_id AS id FROM user_identities WHERE subject_type = 'employee'),
             used AS (SELECT DISTINCT subject_id AS id FROM user_identities
                       WHERE subject_type = 'employee' AND last_used_at IS NOT NULL),
             pend AS (SELECT DISTINCT employee_id AS id FROM sso_pending_links WHERE status = 'pending')
        SELECT (SELECT COUNT(*) FROM act)::int AS active,
               (SELECT COUNT(*) FROM act WHERE id IN (SELECT id FROM linked))::int AS linked,
               (SELECT COUNT(*) FROM act WHERE id IN (SELECT id FROM used))::int AS signed_in,
               (SELECT COUNT(*) FROM act WHERE id IN (SELECT id FROM linked) AND id NOT IN (SELECT id FROM used))::int AS linked_not_used,
               (SELECT COUNT(*) FROM act WHERE id IN (SELECT id FROM pend) AND id NOT IN (SELECT id FROM linked))::int AS pending,
               -- Password-only accounts not already counted as linked: the tiles never double-count.
               (SELECT COUNT(*) FROM act WHERE auth_policy = 'local_only' AND id NOT IN (SELECT id FROM linked))::int AS local_only,
               (SELECT COUNT(*) FROM act WHERE id NOT IN (SELECT id FROM linked) AND id NOT IN (SELECT id FROM pend)
                                         AND auth_policy <> 'local_only')::int AS unmapped,
               (SELECT COUNT(*) FROM onboarding_requests WHERE status = 'pending' AND source = 'sso')::int AS onboarding_sso`);
    const n = (k) => Number(r[k] ?? r[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]) || 0;
    // "Signed in via SSO" is only measured since user_identities.last_used_at
    // exists (migration 144): the tile says since when, so an older sign-in is
    // never read as "never signed in".
    const since = await db
        .get("SELECT applied_at FROM schema_meta WHERE key = '144_sso_remap'")
        .catch(() => null);
    return {
        measuredSince: since ? (since.appliedAt ?? since.applied_at) : null,
        active: n('active'),
        linked: n('linked'),
        signedIn: n('signed_in'),
        linkedNotUsed: n('linked_not_used'),
        pending: n('pending'),
        localOnly: n('local_only'),
        unmapped: n('unmapped'),
        onboardingSso: n('onboarding_sso'),
    };
}

async function batches(limit = 30) {
    const rows = await db.all(
        `SELECT b.id, b.provider, b.mode, b.status, b.dry_run_of, b.source_name, b.row_count, b.summary,
                b.created_at, b.applied_at, b.reverted_at, b.revert_reason,
                a.username AS created_by_name,
                (SELECT COUNT(*) FROM sso_pending_links p WHERE p.batch_id = b.id AND p.status = 'pending')::int AS open_count,
                (SELECT COUNT(*) FROM sso_pending_links p WHERE p.batch_id = b.id AND p.status = 'bound')::int AS bound_count
           FROM sso_remap_batches b LEFT JOIN admins a ON a.id = b.created_by
          WHERE b.mode = 'apply'
          ORDER BY b.id DESC LIMIT ?`,
        [Number(limit)]
    );
    return rows.map((r) => ({
        ...r,
        summary: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary,
    }));
}

/** Active employees with neither an SSO link nor an open mapping. */
async function unmappedEmployees() {
    return db.all(
        `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.email, s.name AS site_name
           FROM employees e LEFT JOIN sites s ON s.id = e.site_id
          WHERE e.is_account_active = true AND e.auth_policy <> 'local_only'
            AND NOT EXISTS (SELECT 1 FROM user_identities u WHERE u.subject_type = 'employee' AND u.subject_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM sso_pending_links p WHERE p.employee_id = e.id AND p.status = 'pending')
          ORDER BY e.last_name, e.first_name`
    );
}

/** Open mappings, i.e. people expected to sign in via SSO for the first time. */
async function pendingMappings(limit = 500) {
    return db.all(
        `SELECT p.id, p.provider, p.match_object_id, p.match_upn, p.match_employee_id, p.created_at, p.batch_id,
                e.id AS employee_id, e.employee_number, e.first_name, e.last_name
           FROM sso_pending_links p JOIN employees e ON e.id = p.employee_id
          WHERE p.status = 'pending' ORDER BY e.last_name, e.first_name LIMIT ?`,
        [Number(limit)]
    );
}

/** Employees the operator may pick when resolving a row by hand. */
async function searchEmployees(q, limit = 20) {
    const s = `%${lc(q)}%`;
    if (lc(q).length < 2) return [];
    return db.all(
        `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.email, s.name AS site_name
           FROM employees e LEFT JOIN sites s ON s.id = e.site_id
          WHERE e.is_account_active = true
            AND (lower(e.employee_number) LIKE ? OR lower(e.email) LIKE ?
                 OR lower(e.first_name || ' ' || e.last_name) LIKE ? OR lower(e.last_name || ' ' || e.first_name) LIKE ?)
          ORDER BY e.last_name, e.first_name LIMIT ?`,
        [s, s, s, s, Number(limit)]
    );
}

module.exports = {
    PROVIDERS,
    OUTCOMES,
    MAX_ROWS,
    parseCsv,
    classify,
    summarize,
    preview,
    apply,
    undo,
    readiness,
    batches,
    unmappedEmployees,
    pendingMappings,
    searchEmployees,
    _context,
};
