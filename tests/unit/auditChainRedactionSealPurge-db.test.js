'use strict';
/**
 * The audit log's redaction / seal / purge paths and the one verifier
 * (migration 170), on the REAL test database. Every scenario runs inside ONE
 * transaction that is always rolled back; migration 170 is applied again inside
 * it (idempotent). Nothing persists.
 *
 *  1. The append-only guard still refuses every UPDATE / DELETE, including one
 *     made with the redaction setting set by hand, a forged vouch, and a vouch
 *     with the right hashes but about a person who is NOT erased.
 *  2. Redaction: refused for a person who is not erased; on an erased person
 *     their names / login / e-mail become their ref `employee:<id>`, a chained
 *     AUDIT_REDACTION entry vouches for each changed row, and the verifier says
 *     INTACT (redactedRows > 0).
 *  3. The verifier still detects any OTHER tampering: a further edit of a
 *     redacted row, an edit of an ordinary row, a deleted row.
 *  4. DSRService.erase() redacts the audit log in the same transaction.
 *  5. Seals + sealed purge: whole sealed months only, never seals / redaction
 *     / purge entries, never a row about a person under legal hold; the
 *     verifier says INTACT afterwards and still catches an edit of a kept row
 *     and a deletion after the boundary.
 *  6. The chain trigger draws the id under its lock: a writer that waited for
 *     the lock gets a HIGHER id than the rows chained before it.
 *  7. Historic id/lock-race forks (one or several losing leaves with a lower
 *     id than their parent) are benign; any other fork is flagged.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'ok' }),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/170_audit_log_redaction_seals_retention.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    await db
        .runTransaction(async () => {
            const c = db._client();
            await c.query(MIG); // idempotent on a migrated database
            await fn(c);
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
}

/** Run a statement in a savepoint; returns the error message or 'ACCEPTED'. */
async function attempt(c, sql, params) {
    await c.query('SAVEPOINT a170');
    try {
        await c.query(sql, params);
        await c.query('RELEASE SAVEPOINT a170');
        return 'ACCEPTED';
    } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT a170');
        return e.message;
    }
}

const verify = async (c) => (await c.query('SELECT fn_system_logs_verify(50) AS v')).rows[0].v;

/** A person with a distinctive name, and audit rows naming them. */
async function plantPerson(c, tag) {
    const e = (
        await c.query(
            `SELECT id FROM employees WHERE erased_at IS NULL AND legal_hold_at IS NULL
              ORDER BY id DESC LIMIT 1`
        )
    ).rows[0];
    const first = `Zelda${tag}`;
    const last = `QUORVAX${tag}`;
    const email = `zq.${tag}@example.test`;
    const username = `zquorvax${tag}`;
    await c.query(
        `UPDATE employees SET first_name = $1, last_name = $2, email = $3, username = $4 WHERE id = $5`,
        [first, last, email, username, e.id]
    );
    const rows = [];
    for (const d of [
        JSON.stringify(`Employee logged in: ${username} (${first} ${last})`),
        JSON.stringify({
            note: `e-mail changed "${email}" -> "x@y.test"`,
            who: `${last} ${first}`,
        }),
    ]) {
        rows.push(
            (
                await c.query(
                    `INSERT INTO system_logs (action, entity_type, entity_id, details, actor_ref)
                     VALUES ('A170_PROBE', 'employee', $1, $2::jsonb, $3) RETURNING id, row_hash`,
                    [e.id, d, `employee:${e.id}`]
                )
            ).rows[0]
        );
    }
    return { id: Number(e.id), first, last, email, username, rows };
}

suite('audit log redaction, seals and sealed purge (rolled back)', () => {
    test('the guard refuses UPDATE / DELETE, the setting alone, and forged vouches', async () => {
        await inRolledBackTx(async (c) => {
            const p = await plantPerson(c, 'g');
            const id = p.rows[0].id;
            expect(
                await attempt(c, `UPDATE system_logs SET details = '"x"' WHERE id = $1`, [id])
            ).toMatch(/IMMUTABLE_TABLE/);
            expect(await attempt(c, 'DELETE FROM system_logs WHERE id = $1', [id])).toMatch(
                /IMMUTABLE_TABLE/
            );
            // The setting by hand is not enough …
            expect(
                await attempt(
                    c,
                    `SELECT set_config('idevelop.audit_path', 'redact', true);
                     UPDATE system_logs SET details = '"x"' WHERE id = ${Number(id)}`
                )
            ).toMatch(/IMMUTABLE_TABLE/);
            // … nor a hand-made vouch that does not match the new content …
            const forged = await c.query(
                `INSERT INTO system_logs (action, entity_type, entity_id, details) VALUES ('AUDIT_REDACTION', 'employee', $3,
                   jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('id', $1::bigint, 'h0', $2::text, 'h1', 'nope'))))
                 RETURNING id`,
                [id, p.rows[0].row_hash, p.id]
            );
            expect(
                await attempt(
                    c,
                    `SELECT set_config('idevelop.audit_path', 'redact', true),
                            set_config('idevelop.audit_redaction_entry', '${Number(forged.rows[0].id)}', true);
                     UPDATE system_logs SET details = '"x"' WHERE id = ${Number(id)}`
                )
            ).toMatch(/IMMUTABLE_TABLE/);
            // … nor a vouch with the RIGHT hashes about a person who is not erased.
            const exact = await c.query(
                `INSERT INTO system_logs (action, entity_type, entity_id, details)
                 SELECT 'AUDIT_REDACTION', 'employee', $2::bigint,
                        jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
                          'id', s.id, 'h0', s.row_hash,
                          'h1', fn_system_logs_rowhash(s.prev_hash, s.admin_id, s.action, s.entity_type,
                                                       s.entity_id, '"x"'::jsonb, s.created_at))))
                   FROM system_logs s WHERE s.id = $1 RETURNING id`,
                [id, p.id]
            );
            expect(
                await attempt(
                    c,
                    `SELECT set_config('idevelop.audit_path', 'redact', true),
                            set_config('idevelop.audit_redaction_entry', '${Number(exact.rows[0].id)}', true);
                     UPDATE system_logs SET details = '"x"' WHERE id = ${Number(id)}`
                )
            ).toMatch(/IMMUTABLE_TABLE/);
            // A purge setting without a matching chained AUDIT_PURGE entry: refused.
            expect(
                await attempt(
                    c,
                    `SELECT set_config('idevelop.audit_path', 'purge', true),
                            set_config('idevelop.audit_purge_entry', '999999999', true),
                            set_config('idevelop.audit_purge_boundary', '999999999', true),
                            set_config('idevelop.audit_purge_cutoff', '2100-01-01', true);
                     DELETE FROM system_logs WHERE id = ${Number(id)}`
                )
            ).toMatch(/IMMUTABLE_TABLE/);
            // Other append-only tables keep the plain guard.
            const ah = (await c.query('SELECT id FROM assessment_history LIMIT 1')).rows[0];
            if (ah)
                expect(
                    await attempt(c, 'DELETE FROM assessment_history WHERE id = $1', [ah.id])
                ).toMatch(/IMMUTABLE_TABLE/);
        });
    });

    test('the writing functions are not executable by PUBLIC', async () => {
        await inRolledBackTx(async (c) => {
            const rows = (
                await c.query(
                    `SELECT p.proname,
                            has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                            has_function_privilege(current_user, p.oid, 'EXECUTE') AS me
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public'
                        AND p.proname IN ('fn_system_logs_redact', '_fn_system_logs_redact_flush', 'fn_system_logs_purge')`
                )
            ).rows;
            expect(rows).toHaveLength(3);
            for (const r of rows)
                expect({ fn: r.proname, pub: r.pub, me: r.me }).toEqual({
                    fn: r.proname,
                    pub: false,
                    me: true,
                });
        });
    });

    test('redaction: refused unless erased; then vouched, and the chain verifies', async () => {
        await inRolledBackTx(async (c) => {
            const before = await verify(c);
            expect(before.intact).toBe(true);
            const p = await plantPerson(c, 'r');
            const needles = [`${p.first} ${p.last}`, `${p.last} ${p.first}`, p.email, p.username];
            expect(
                await attempt(c, 'SELECT fn_system_logs_redact($1, $2::text[])', [p.id, needles])
            ).toMatch(/AUDIT_REDACTION_REFUSED/);

            await c.query('UPDATE employees SET erased_at = now() WHERE id = $1', [p.id]);
            const r = (
                await c.query('SELECT fn_system_logs_redact($1, $2::text[], $3, $4) AS r', [
                    p.id,
                    needles,
                    'admin:1',
                    'test',
                ])
            ).rows[0].r;
            expect(r.rows).toBeGreaterThanOrEqual(2);
            const rows = (
                await c.query(
                    'SELECT id, details::text AS d, row_hash FROM system_logs WHERE id = ANY($1)',
                    [p.rows.map((x) => x.id)]
                )
            ).rows;
            for (const row of rows) {
                expect(row.d).toContain(`employee:${p.id}`);
                expect(row.d).not.toMatch(
                    new RegExp(`${p.first}|${p.last}|${p.username}|${p.email}`, 'i')
                );
                // the row keeps its ORIGINAL hash (links untouched)
                expect(row.row_hash).toBe(
                    p.rows.find((x) => Number(x.id) === Number(row.id)).row_hash
                );
            }
            const entry = (
                await c.query(`SELECT details FROM system_logs WHERE id = $1`, [r.entries[0]])
            ).rows[0].details;
            expect(entry.subject).toBe(`employee:${p.id}`);
            expect(JSON.stringify(entry)).not.toMatch(new RegExp(p.last, 'i'));

            const after = await verify(c);
            expect(after.intact).toBe(true);
            expect(after.redactedRows).toBeGreaterThanOrEqual(2);
            // Idempotent: nothing left to redact.
            const again = (
                await c.query('SELECT fn_system_logs_redact($1, $2::text[]) AS r', [p.id, needles])
            ).rows[0].r;
            expect(again.rows).toBe(0);
        });
    });

    test('any OTHER change is still detected: re-edited redacted row, edited row, deleted row', async () => {
        await inRolledBackTx(async (c) => {
            const p = await plantPerson(c, 't');
            await c.query('UPDATE employees SET erased_at = now() WHERE id = $1', [p.id]);
            await c.query('SELECT fn_system_logs_redact($1, $2::text[])', [p.id, [p.username]]);
            const other = (
                await c.query(
                    `INSERT INTO system_logs (action, details) VALUES ('A170_PLAIN', '"plain"'),
                            ('A170_PLAIN2', '"plain2"'), ('A170_PLAIN3', '"plain3"') RETURNING id`
                )
            ).rows.map((x) => Number(x.id));
            expect((await verify(c)).intact).toBe(true);

            // Tampering needs the guard off (what a database owner could do).
            await c.query('ALTER TABLE system_logs DISABLE TRIGGER trg_system_logs_immutable');
            await c.query(`UPDATE system_logs SET details = '"rewritten"' WHERE id = $1`, [
                p.rows[0].id,
            ]);
            await c.query(`UPDATE system_logs SET details = '"edited"' WHERE id = $1`, [other[0]]);
            await c.query('DELETE FROM system_logs WHERE id = $1', [other[1]]);
            await c.query('ALTER TABLE system_logs ENABLE TRIGGER trg_system_logs_immutable');

            const v = await verify(c);
            expect(v.intact).toBe(false);
            expect(v.broken.content).toEqual(
                expect.arrayContaining([Number(p.rows[0].id), other[0]])
            );
            expect(v.broken.link).toEqual(expect.arrayContaining([other[2]])); // successor of the deleted row
        });
    });

    test('DSRService.erase() redacts the audit log in the same transaction', async () => {
        await inRolledBackTx(async (c) => {
            const p = await plantPerson(c, 'd');
            const DSR = require('../../src/services/DSRService');
            const out = await DSR.erase(p.id, null, { reason: 'audit redaction test' });
            expect(out.erased).toBe(true);
            expect(out.auditRowsRedacted).toBeGreaterThanOrEqual(2);
            const leaks = (
                await c.query(
                    `SELECT count(*)::int AS n FROM system_logs WHERE details::text ILIKE $1`,
                    [`%${p.last}%`]
                )
            ).rows[0].n;
            expect(leaks).toBe(0);
            expect((await verify(c)).intact).toBe(true);
            // The log page reads the ref as an erased person.
            const SystemLogModel = require('../../src/models/SystemLogModel');
            const [row] = await SystemLogModel.resolvePeople(
                (
                    await c.query(
                        'SELECT id, actor_ref AS "actorRef", details FROM system_logs WHERE id = $1',
                        [p.rows[0].id]
                    )
                ).rows
            );
            expect(row.actorErasedId).toBe(p.id);
            expect(JSON.stringify(row.details)).toContain(`Erased person #${p.id}`);
        });
    });

    test('seals + sealed purge keep seals, held people and what verifies; tampering still shows', async () => {
        await inRolledBackTx(async (c) => {
            // History in a past month: rows about a person under legal hold, and
            // rows about nobody in particular.
            const held = {
                id: Number(
                    (
                        await c.query(
                            `SELECT id FROM employees WHERE erased_at IS NULL ORDER BY id LIMIT 1`
                        )
                    ).rows[0].id
                ),
            };
            await c.query(
                `UPDATE employees SET legal_hold_at = now(), legal_hold_by = 'test', legal_hold_reason = 'test' WHERE id = $1`,
                [held.id]
            );
            const heldRow = (
                await c.query(
                    `INSERT INTO system_logs (action, entity_type, details, actor_ref, created_at)
                     VALUES ('A170_OLD_HELD', 'auth', '"held"', $1, date_trunc('month', now()) - interval '14 months' + interval '3 days')
                     RETURNING id`,
                    [`employee:${held.id}`]
                )
            ).rows[0];
            await c.query(
                `INSERT INTO system_logs (action, entity_type, details, created_at)
                 SELECT 'A170_OLD', 'x', to_jsonb('old ' || g),
                        date_trunc('month', now()) - interval '14 months' + (g || ' hours')::interval + interval '4 days'
                   FROM generate_series(1, 20) g`
            );

            const n = Number((await c.query('SELECT fn_system_logs_seal() AS n')).rows[0].n);
            const sealed = Number(
                (await c.query("SELECT COUNT(*) AS n FROM system_logs WHERE action = 'AUDIT_SEAL'"))
                    .rows[0].n
            );
            expect(sealed).toBeGreaterThan(0);
            expect(n).toBeGreaterThanOrEqual(0);
            expect((await c.query('SELECT fn_system_logs_seal() AS n')).rows[0].n).toBe(0); // idempotent

            // Retention bounds are enforced in the database too.
            expect(await attempt(c, 'SELECT fn_system_logs_purge(0)')).toMatch(
                /AUDIT_PURGE_REFUSED/
            );
            expect(await attempt(c, 'SELECT fn_system_logs_purge(11)')).toMatch(
                /AUDIT_PURGE_REFUSED/
            );
            // Nothing is 5 years old today.
            expect((await c.query('SELECT fn_system_logs_purge(5) AS r')).rows[0].r.deleted).toBe(
                0
            );

            // Six years from now, everything before this month is past retention.
            const before = (await c.query('SELECT count(*)::int AS n FROM system_logs')).rows[0].n;
            const r = (
                await c.query(
                    `SELECT fn_system_logs_purge(5, 'admin:1', now() + interval '6 years') AS r`
                )
            ).rows[0].r;
            expect(r.deleted).toBeGreaterThan(0);
            const after = (await c.query('SELECT count(*)::int AS n FROM system_logs')).rows[0].n;
            expect(after).toBe(before - r.deleted + 1); // + the AUDIT_PURGE entry
            expect(
                (
                    await c.query(
                        `SELECT count(*)::int AS n FROM system_logs WHERE action = 'AUDIT_SEAL'`
                    )
                ).rows[0].n
            ).toBe(sealed);
            expect(
                (
                    await c.query('SELECT count(*)::int AS n FROM system_logs WHERE id = $1', [
                        heldRow.id,
                    ])
                ).rows[0].n
            ).toBe(1);
            // Before the cutoff, only proofs and rows about the held person remain.
            const refs = ['employee', 'manager', 'supervisor'].map((t) => `${t}:${held.id}`);
            const leftover = (
                await c.query(
                    `SELECT count(*)::int AS n FROM system_logs s
                      WHERE s.created_at < $1::timestamptz
                        AND s.action NOT IN ('AUDIT_SEAL', 'AUDIT_REDACTION', 'AUDIT_PURGE')
                        AND (s.actor_ref = ANY($2)) IS NOT TRUE
                        AND (s.entity_type IN ('employee', 'employees') AND s.entity_id = $3) IS NOT TRUE
                        AND ((s.details->>'subject') = ANY($2)) IS NOT TRUE
                        AND ((s.details->>'employeeId') = $3::text) IS NOT TRUE
                        AND (s.admin_id IN (SELECT id FROM admins WHERE linked_employee_id = $3)) IS NOT TRUE
                        AND (s.entity_type IN ('admin', 'admins', 'localAdmins')
                             AND s.entity_id IN (SELECT id FROM admins WHERE linked_employee_id = $3)) IS NOT TRUE`,
                    [r.cutoff, refs, held.id]
                )
            ).rows[0].n;
            expect(leftover).toBe(0);

            const v = await verify(c);
            expect(v.intact).toBe(true);
            expect(Number(v.purgeBoundaryId)).toBe(Number(r.boundaryId));

            // A purge is audited as a chained entry naming its boundary.
            const pe = (await c.query('SELECT details FROM system_logs WHERE id = $1', [r.entryId]))
                .rows[0].details;
            expect(pe.boundaryId).toBe(r.boundaryId);

            // Tamper with a KEPT row below the boundary, and delete one after it.
            const kept = Number(heldRow.id);
            await c.query(
                `INSERT INTO system_logs (action, details) VALUES ('A170_T1', '"1"'), ('A170_T2', '"2"'), ('A170_T3', '"3"')`
            );
            const tail = (
                await c.query(
                    `SELECT id FROM system_logs WHERE id > $1 AND action LIKE 'A170_T%' ORDER BY id LIMIT 3`,
                    [r.boundaryId]
                )
            ).rows.map((x) => Number(x.id));
            await c.query('ALTER TABLE system_logs DISABLE TRIGGER trg_system_logs_immutable');
            await c.query(
                `UPDATE system_logs SET details = '"forged"',
                        row_hash = fn_system_logs_rowhash(prev_hash, admin_id, action, entity_type, entity_id, '"forged"'::jsonb, created_at)
                  WHERE id = $1`,
                [kept]
            );
            await c.query('DELETE FROM system_logs WHERE id = $1', [tail[1]]);
            await c.query('ALTER TABLE system_logs ENABLE TRIGGER trg_system_logs_immutable');
            const bad = await verify(c);
            expect(bad.intact).toBe(false);
            expect(bad.broken.purged).toContain(Number(kept)); // re-hashed, but not the hash the purge recorded
            expect(bad.broken.link).toContain(tail[2]);
        });
    });

    test('historic id/lock-race forks are benign; a second continuing branch is flagged', async () => {
        await inRolledBackTx(async (c) => {
            // Reproduce the race with the pre-170 trigger (default id, then the lock).
            await c.query(`CREATE OR REPLACE FUNCTION pg_temp.old_chain() RETURNS trigger LANGUAGE plpgsql AS $f$
                DECLARE p text;
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('system_logs_hashchain')::bigint);
                    SELECT row_hash INTO p FROM public.system_logs ORDER BY id DESC LIMIT 1;
                    NEW.prev_hash := p;
                    NEW.row_hash := encode(digest(coalesce(p, '') || '|' || coalesce(NEW.admin_id::text, '') || '|' ||
                        coalesce(NEW.action, '') || '|' || coalesce(NEW.entity_type, '') || '|' ||
                        coalesce(NEW.entity_id::text, '') || '|' || coalesce(NEW.details::text, '') || '|' ||
                        coalesce(NEW.created_at::text, now()::text), 'sha256'), 'hex');
                    RETURN NEW;
                END $f$`);
            await c.query('ALTER TABLE system_logs DISABLE TRIGGER trg_system_logs_hashchain');
            await c.query(
                'CREATE TRIGGER trg_a170_old_chain BEFORE INSERT ON system_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.old_chain()'
            );
            const seq = `pg_get_serial_sequence('public.system_logs', 'id')`;
            // A three-way fork: two late writers with lower ids under one parent.
            const x = Number((await c.query(`SELECT nextval(${seq}) AS v`)).rows[0].v);
            const y = Number((await c.query(`SELECT nextval(${seq}) AS v`)).rows[0].v);
            await c.query(
                `INSERT INTO system_logs (action, details) VALUES ('A170_WINNER', '"w"')`
            );
            await c.query(
                `INSERT INTO system_logs (id, action, details) VALUES ($1, 'A170_LOSER', '"l1"')`,
                [x]
            );
            await c.query(
                `INSERT INTO system_logs (id, action, details) VALUES ($1, 'A170_LOSER', '"l2"')`,
                [y]
            );
            await c.query(`INSERT INTO system_logs (action, details) VALUES ('A170_NEXT', '"n"')`);
            const v1 = await verify(c);
            expect(v1.intact).toBe(true);
            expect(v1.benignForks).toBeGreaterThanOrEqual(1);

            // A loser that CONTINUES (has its own successor) is a second branch: flagged.
            await c.query('DROP TRIGGER trg_a170_old_chain ON system_logs');
            await c.query('ALTER TABLE system_logs ENABLE TRIGGER trg_system_logs_hashchain');
            const loser = (await c.query(`SELECT row_hash FROM system_logs WHERE id = $1`, [x]))
                .rows[0].row_hash;
            await c.query('ALTER TABLE system_logs DISABLE TRIGGER trg_system_logs_hashchain');
            await c.query(
                `INSERT INTO system_logs (action, details, prev_hash, row_hash)
                 VALUES ('A170_BRANCH', '"b"', $1::text,
                         fn_system_logs_rowhash($1::text, NULL, 'A170_BRANCH', NULL, NULL, '"b"'::jsonb, now()))`,
                [loser]
            );
            await c.query('ALTER TABLE system_logs ENABLE TRIGGER trg_system_logs_hashchain');
            const v2 = await verify(c);
            expect(v2.intact).toBe(false);
            expect(v2.broken.fork).toEqual(expect.arrayContaining([x]));
        });
    });

    test('the chain trigger draws the id under its lock (no more id/lock forks)', async () => {
        const { Client } = require('pg');
        const FN =
            /CREATE OR REPLACE FUNCTION public\.fn_system_logs_hashchain\(\)[\s\S]*?END \$fn\$;/.exec(
                MIG
            )[0];
        const a = new Client({ connectionString: process.env.DATABASE_URL });
        const b = new Client({ connectionString: process.env.DATABASE_URL });
        await a.connect();
        await b.connect();
        try {
            await b.query('BEGIN');
            await b.query(FN); // B runs the 170 trigger (uncommitted, B only)
            await a.query('BEGIN');
            await a.query(`INSERT INTO system_logs (action) VALUES ('A170_A1')`); // A holds the chain lock
            // B takes its DEFAULT id now, then waits for A's lock …
            const pending = b.query(
                `INSERT INTO system_logs (action) VALUES ('A170_B') RETURNING id`
            );
            // Wait until B is REALLY blocked on A's lock.
            const bPid = b.processID; // never query B here: its INSERT is still pending
            for (let i = 0; i < 1500; i++) {
                const w = await a.query(
                    `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
                    [bPid]
                );
                if (w.rows[0] && w.rows[0].wait_event_type === 'Lock') break;
                await new Promise((r) => setTimeout(r, 20));
            }
            const a2 = (
                await a.query(`INSERT INTO system_logs (action) VALUES ('A170_A2') RETURNING id`)
            ).rows[0];
            await a.query('ROLLBACK');
            const bRow = (await pending).rows[0];
            // … and the trigger re-draws it under the lock: after A2, not before.
            expect(Number(bRow.id)).toBeGreaterThan(Number(a2.id));
        } finally {
            await a.query('ROLLBACK').catch(() => {});
            await b.query('ROLLBACK').catch(() => {});
            await a.end();
            await b.end();
        }
    });
});
