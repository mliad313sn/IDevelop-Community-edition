'use strict';
/**
 * Erasure on the REAL test database, every scenario inside ONE transaction
 * that is always rolled back (nothing persists).
 *
 *  1. SCHEMA-DRIVEN COMPLETENESS. Every column that references an employee
 *     (every foreign key to `employees`, plus every employee-id-like column:
 *     …employee_id, subject_id, user_id, actor/author/reviewer/coach/mentor/
 *     manager/supervisor ids, actor_ref, requester_ref, …_by_ref) must be
 *     declared in DSRService.SUBJECT_DATA_REGISTRY, and every OTHER table must
 *     be classified in TABLES_WITHOUT_SUBJECT_COLUMN. A new table (360°, the
 *     one-to-one space, HRIS, the skills library, privacy…) or a new employee
 *     column that is in neither list fails this test instead of silently
 *     escaping the erasure.
 *  2. Every generic registry statement is valid SQL on the real schema.
 *  3. Behaviour: a subject planted with a unique token in registry-covered
 *     places is exported WITH the token and, after erase(), the token is found
 *     in none of them; their uploaded certificate file is deleted, a file
 *     outside the uploads folder is not.
 *  4. Legal hold: erasure refused (person- and job-level); the two-person
 *     override (request, then a DIFFERENT SuperAdmin approves) erases;
 *     self-approval and a single-SuperAdmin instance are refused; the audit
 *     lines carry ids only.
 *  5. Retention: old UNREAD notifications and old REJECTED applicants.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'ok' }),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const TOKEN = 'zqxregistryprobe';
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-uploads-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-outside-'));

let savedUploads;
beforeAll(async () => {
    savedUploads = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = UPLOADS;
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (savedUploads === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = savedUploads;
    if (HAS_DB) await db.close();
    fs.rmSync(UPLOADS, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

async function inRollback(fn) {
    let result = null;
    try {
        await db.runTransaction(async () => {
            result = await fn();
            throw new Error('__ROLLBACK__');
        });
    } catch (e) {
        if (!/__ROLLBACK__/.test(e.message)) throw e;
    }
    return result;
}

const DSR = () => require('../../src/services/DSRService');
const Maint = () => require('../../src/services/MaintenanceService');
const Registry = () => require('../../src/services/erasureRegistry');

async function employeeReferences() {
    return db.all(`
      SELECT DISTINCT tbl, col FROM (
        SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
          FROM pg_constraint c
          JOIN LATERAL unnest(c.conkey) k(n) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
         WHERE c.contype = 'f' AND c.confrelid = 'public.employees'::regclass
        UNION
        SELECT c.table_name::text, c.column_name::text
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
           AND (c.column_name ~ '(^|_)employee_id$'
             OR c.column_name IN ('subject_id', 'user_id', 'actor_ref', 'requester_ref')
             OR c.column_name ~ '^(actor|author|reviewer|coach|mentor|manager|supervisor|current_reviewer|grantor|grantee)_id$'
             OR c.column_name ~ '_by_ref$')
      ) x ORDER BY 1, 2`);
}

suite('the erasure registry covers the real schema', () => {
    test('every employee column is declared, every other table classified', async () => {
        const { SUBJECT_DATA_REGISTRY: reg, TABLES_WITHOUT_SUBJECT_COLUMN: other } = Registry();
        const declared = new Set(reg.filter((e) => e.column).map((e) => `${e.table}.${e.column}`));
        const refs = await employeeReferences();
        expect(refs.length).toBeGreaterThan(100);
        const missing = refs.map((r) => `${r.tbl}.${r.col}`).filter((k) => !declared.has(k));
        expect(missing).toEqual([]);

        const tables = (
            await db.all(
                `SELECT table_name AS t FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
            )
        ).map((r) => r.t);
        const withColumn = new Set(refs.map((r) => r.tbl));
        const unclassified = tables.filter(
            (t) => !withColumn.has(t) && !Object.prototype.hasOwnProperty.call(other, t)
        );
        expect(unclassified).toEqual([]);
        // and nothing classified that does not exist
        const stale = Object.keys(other).filter((t) => !tables.includes(t));
        expect(stale).toEqual([]);
        for (const [t, [cls, why]] of Object.entries(other)) {
            expect([
                t,
                ['config', 'aggregate', 'via', 'admin', 'telemetry', 'ledger'].includes(cls),
            ]).toEqual([t, true]);
            expect([t, typeof why === 'string' && why.length >= 5]).toEqual([t, true]);
        }
        // the IDevelop-only modules are classified explicitly
        for (const t of [
            'feedback360_subjects',
            'feedback360_responses',
            'feedback360_nominations',
            'one_on_one_notes',
            'one_on_one_agenda_items',
            'hris_links',
            'hris_sync_runs',
            'profiling_objections',
            'erasure_override_requests',
        ])
            expect([t, reg.some((e) => e.table === t)]).toEqual([t, true]);
        for (const t of ['feedback360_answers', 'feedback360_rounds', 'hris_value_mappings'])
            expect([t, Boolean(other[t])]).toEqual([t, true]);
    });

    test('every entry has a valid treatment, and every generic statement is valid SQL', async () => {
        const { SUBJECT_DATA_REGISTRY: reg, registryWhere, registrySet } = Registry();
        const TREAT = ['redacted', 'disclosed', 'erase', 'delete', 'custom', 'keep'];
        const keys = new Set([
            ...DSR().REDACTED_ON_ERASURE.map((c) => c.key),
            ...DSR().DISCLOSED_ABOUT_SUBJECT.map((c) => c.key),
        ]);
        for (const e of reg) {
            expect([e.table, e.column || e.scope, TREAT.includes(e.treatment)]).toEqual([
                e.table,
                e.column || e.scope,
                true,
            ]);
            if (e.treatment === 'keep' || e.treatment === 'custom')
                expect([e.table, typeof e.why]).toEqual([e.table, 'string']);
            if (e.treatment === 'redacted' || e.treatment === 'disclosed')
                expect([e.table, keys.has(e.key)]).toEqual([e.table, true]);
            if (e.treatment === 'erase')
                expect([e.table, Object.keys(e.set || {}).length > 0]).toEqual([e.table, true]);
            if (e.export === false)
                expect([e.table, typeof e.exportWhy]).toEqual([e.table, 'string']);
        }
        await inRollback(async () => {
            for (const e of reg) {
                if (e.treatment !== 'erase' && e.treatment !== 'delete') continue;
                const { sql, params } = registryWhere(e, 1);
                const stmt =
                    e.treatment === 'delete'
                        ? `DELETE FROM ${e.table} WHERE ${sql}`
                        : `UPDATE ${e.table} SET ${registrySet(e)} WHERE ${sql}`;
                await db.runInSavepoint(() => db.run(`EXPLAIN ${stmt}`, params));
                if (e.files)
                    await db.runInSavepoint(() =>
                        db.run(
                            `EXPLAIN SELECT ${e.files.join(', ')} FROM ${e.table} WHERE ${sql}`,
                            params
                        )
                    );
            }
        });
    });
});

async function aSubject() {
    const emp = await db.get(
        `SELECT id, employee_number FROM employees
          WHERE is_active = true AND erased_at IS NULL ORDER BY id DESC LIMIT 1`
    );
    const skill = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
    return { id: Number(emp.id), number: emp.employeeNumber, skillId: Number(skill.id) };
}

suite('erasure behaviour', () => {
    test('planted data is exported, then gone; the upload is deleted, an outside file is not', async () => {
        const inside = path.join(UPLOADS, `cert-${TOKEN}.pdf`);
        const outside = path.join(OUTSIDE, `cert-${TOKEN}.pdf`);
        fs.writeFileSync(inside, '%PDF-1.4');
        fs.writeFileSync(outside, '%PDF-1.4');
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await inRollback(async () => {
            const s = await aSubject();
            await db.run(
                `INSERT INTO employee_certifications
                    (employee_id, skill_id, issued_on, notes, cert_number, file_uri, original_name, av_status)
                 VALUES (?, ?, CURRENT_DATE - 10, ?, ?, ?, ?, 'clean')`,
                [s.id, s.skillId, `${TOKEN} note`, `${TOKEN}-123`, inside, `${TOKEN}.pdf`]
            );
            await db.run(
                `INSERT INTO employee_certifications
                    (employee_id, skill_id, issued_on, file_uri, original_name, av_status)
                 VALUES (?, ?, CURRENT_DATE - 9, ?, 'x.pdf', 'clean')`,
                [s.id, s.skillId, outside]
            );
            await db.run(
                `INSERT INTO employee_aspirations (employee_id, interests, open_to_mobility)
                 VALUES (?, ?, true)
                 ON CONFLICT (employee_id) DO UPDATE SET interests = EXCLUDED.interests`,
                [s.id, `${TOKEN} aspiration`]
            );
            await db.run(
                `INSERT INTO planned_absences (employee_id, starts_on, ends_on, kind, note)
                 VALUES (?, CURRENT_DATE, CURRENT_DATE + 2, 'leave', ?)`,
                [s.id, `${TOKEN} absence`]
            );
            await db.run(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state)
                 VALUES ('employee', ?, 'inapp', 'test.kind', 'en', ?::jsonb, 'queued')`,
                [s.id, JSON.stringify({ note: TOKEN })]
            );
            await db.run(
                `INSERT INTO hris_links (provider, external_id, employee_id) VALUES ('csv', ?, ?)`,
                [`${TOKEN}-ext`, s.id]
            );
            await db.run(
                `INSERT INTO hris_sync_runs (provider, mode, status, trigger, counts, errors, records)
                 VALUES ('csv', 'dry_run', 'planned', 'manual', '{}'::jsonb, '[]'::jsonb, ?::jsonb)`,
                [JSON.stringify([{ externalId: `${TOKEN}-ext`, name: 'x' }])]
            );

            const exp = await DSR().export(s.id);
            expect(JSON.stringify(exp.certifications)).toContain(TOKEN);
            expect(JSON.stringify(exp.aspirations)).toContain(TOKEN);
            expect(JSON.stringify(exp.plannedAbsences)).toContain(TOKEN);
            expect(JSON.stringify(exp.notifications)).toContain(TOKEN);
            expect(JSON.stringify(exp.hrisLinks)).toContain(TOKEN);

            const out = await DSR().erase(s.id, null, { reason: 'registry test' });
            expect(out.erased).toBe(true);
            expect(out.filesDeleted).toBe(1);

            const leftovers = [];
            for (const [table, cols] of [
                ['employee_certifications', ['notes', 'cert_number', 'original_name', 'file_uri']],
                ['employee_aspirations', ['interests']],
                ['planned_absences', ['note']],
                ['notifications', ['payload::text']],
                ['hris_links', ['external_id']],
                ['hris_sync_runs', ['records::text']],
            ]) {
                const r = await db.get(
                    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${cols
                        .map((c) => `COALESCE(${c}, '') LIKE ?`)
                        .join(' OR ')}`,
                    cols.map(() => `%${TOKEN}%`)
                );
                if (r.n) leftovers.push(table);
            }
            expect(leftovers).toEqual([]);
            const log = await db.get(
                `SELECT details FROM system_logs WHERE action = 'GDPR_ERASURE' AND entity_id = ?
                  ORDER BY id DESC LIMIT 1`,
                [s.id]
            );
            expect(String(log.details)).not.toContain(String(s.number));
        });
        expect(fs.existsSync(inside)).toBe(false);
        expect(fs.existsSync(outside)).toBe(true);
    });
});

suite('legal hold and the two-person override', () => {
    const SUPER1 = { id: 1, userType: 'admin', role: 'superadmin' };

    test('refused under hold; the requester cannot approve; a second SuperAdmin can', async () => {
        await inRollback(async () => {
            const s = await aSubject();
            await db.run(
                `UPDATE employees SET legal_hold_at = now(), legal_hold_by = 'admin:1',
                        legal_hold_reason = 'pending case' WHERE id = ?`,
                [s.id]
            );
            await expect(DSR().erase(s.id, 1, { reason: 'x' })).rejects.toMatchObject({
                code: 'erasure_legal_hold',
                status: 409,
            });
            // a forged override id is refused by the service itself
            await expect(
                DSR().erase(s.id, 1, { reason: 'x', legalHoldOverride: 999999 })
            ).rejects.toMatchObject({ code: 'erasure_override_invalid' });

            // single SuperAdmin: no override possible
            await db.run(
                "UPDATE admins SET is_active = false WHERE role::text = 'superadmin' AND id <> 1"
            );
            await expect(
                Maint().dsrErase(SUPER1, { employeeId: s.id, reason: 'x', confirmNumber: s.number })
            ).rejects.toMatchObject({
                status: 409,
                message: 'maintenance_erase_legal_hold_single_superadmin',
            });
            await expect(
                Maint().dsrOverrideRequest(SUPER1, {
                    employeeId: s.id,
                    reason: 'court order lifted',
                    confirmNumber: s.number,
                })
            ).rejects.toMatchObject({ message: 'maintenance_override_single_superadmin' });

            // a second SuperAdmin
            const two = await db.get(
                `INSERT INTO admins (username, email, password_hash, role, is_active)
                 VALUES ('second.super', 'second.super@example.test', 'x', 'superadmin', true)
                 RETURNING id`
            );
            const SUPER2 = { id: Number(two.id), userType: 'admin', role: 'superadmin' };
            const st = await Maint().dsrEraseStatus(SUPER1, { employeeId: s.id });
            expect(st).toMatchObject({ overridePossible: true, openOverride: null });
            expect(st.hold).toMatchObject({ level: 'employee', reason: 'pending case' });
            await expect(
                Maint().dsrErase(SUPER1, { employeeId: s.id, reason: 'x', confirmNumber: s.number })
            ).rejects.toMatchObject({ status: 409, message: 'maintenance_erase_legal_hold' });

            const req = await Maint().dsrOverrideRequest(SUPER1, {
                employeeId: s.id,
                reason: 'court order lifted',
                confirmNumber: s.number,
            });
            expect(req.state).toBe('pending');
            await expect(
                Maint().dsrOverrideRequest(SUPER2, {
                    employeeId: s.id,
                    reason: 'again',
                    confirmNumber: s.number,
                })
            ).rejects.toMatchObject({ message: 'maintenance_override_already_open' });
            await expect(
                Maint().dsrOverrideDecide(SUPER1, {
                    requestId: req.requestId,
                    approve: true,
                    note: 'me',
                })
            ).rejects.toMatchObject({ message: 'maintenance_override_same_person' });
            expect((await Maint().dsrOverrideList(SUPER2)).map((r) => Number(r.id))).toContain(
                req.requestId
            );
            const done = await Maint().dsrOverrideDecide(SUPER2, {
                requestId: req.requestId,
                approve: true,
                note: 'checked the release letter',
            });
            expect(done).toMatchObject({ state: 'executed', employeeId: s.id });
            const row = await db.get('SELECT erased_at FROM employees WHERE id = ?', [s.id]);
            expect(row.erasedAt).toBeTruthy();
            const r = await db.get('SELECT state FROM erasure_override_requests WHERE id = ?', [
                req.requestId,
            ]);
            expect(r.state).toBe('executed');
            const lines = await db.all(
                `SELECT details FROM system_logs
                  WHERE action LIKE 'MAINT_DSR_ERASE_OVERRIDE%' OR (action = 'GDPR_ERASURE' AND entity_id = ?)`,
                [s.id]
            );
            expect(lines.length).toBeGreaterThanOrEqual(3);
            for (const l of lines) expect(String(l.details)).not.toContain(String(s.number));
        });
    });

    test('a refusal by the second SuperAdmin needs a reason; the requester may withdraw', async () => {
        await inRollback(async () => {
            const s = await aSubject();
            await db.run('UPDATE employees SET legal_hold_at = now() WHERE id = ?', [s.id]);
            const two = await db.get(
                `INSERT INTO admins (username, email, password_hash, role, is_active)
                 VALUES ('second.super2', 'second.super2@example.test', 'x', 'superadmin', true)
                 RETURNING id`
            );
            const SUPER2 = { id: Number(two.id), userType: 'admin', role: 'superadmin' };
            const req = await Maint().dsrOverrideRequest(SUPER1, {
                employeeId: s.id,
                reason: 'r',
                confirmNumber: s.number,
            });
            await expect(
                Maint().dsrOverrideDecide(SUPER2, { requestId: req.requestId, approve: false })
            ).rejects.toMatchObject({ message: 'maintenance_reason_required' });
            const w = await Maint().dsrOverrideDecide(SUPER1, {
                requestId: req.requestId,
                approve: false,
            });
            expect(w.state).toBe('withdrawn');
            const row = await db.get('SELECT erased_at FROM employees WHERE id = ?', [s.id]);
            expect(row.erasedAt).toBeNull();
        });
    });

    test('erase() refuses a person-level hold whatever the method (the purge ledgers it as skipped)', async () => {
        await inRollback(async () => {
            const s = await aSubject();
            await db.run('UPDATE employees SET legal_hold_at = now() WHERE id = ?', [s.id]);
            await expect(
                DSR().erase(s.id, null, { method: 'retention_purge' })
            ).rejects.toMatchObject({ code: 'erasure_legal_hold' });
        });
    });
});

suite('retention pruning', () => {
    test('old unread notifications go; old rejected applicants are pseudonymised', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await inRollback(async () => {
            const n = await db.get(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, created_at)
                 VALUES ('employee', 1, 'inapp', 'test.kind', 'en', '{}'::jsonb, 'queued', now() - interval '400 days')
                 RETURNING id`
            );
            const later = await db.get(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, created_at, release_at)
                 VALUES ('employee', 1, 'inapp', 'test.kind', 'en', '{}'::jsonb, 'queued', now() - interval '400 days', now() + interval '1 day')
                 RETURNING id`
            );
            const o = await db.get(
                `INSERT INTO onboarding_requests (email, first_name, last_name, source, status, requested_at, decided_at, decision_note)
                 VALUES ('applicant.probe@example.test', 'Pat', 'Probe', 'signup', 'rejected', now() - interval '400 days', now() - interval '400 days', 'no')
                 RETURNING id`
            );
            const r = await require('../../src/jobs/telemetry-prune').tick();
            expect(r.unread).toBeGreaterThanOrEqual(1);
            expect(r.applicants).toBeGreaterThanOrEqual(1);
            expect(await db.get('SELECT id FROM notifications WHERE id = ?', [n.id])).toBeFalsy();
            expect(
                await db.get('SELECT id FROM notifications WHERE id = ?', [later.id])
            ).toBeTruthy();
            const app = await db.get(
                'SELECT email, first_name, decision_note FROM onboarding_requests WHERE id = ?',
                [o.id]
            );
            expect(String(app.email)).toMatch(/@erased\.local$/);
            expect(app.firstName).toBeNull();
            expect(app.decisionNote).toBeNull();
        });
    });
});
