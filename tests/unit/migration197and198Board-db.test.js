'use strict';
/**
 * Migrations 197 (board_decisions, board_decision_events) and 198
 * (board_pack_runs) — the files, the lists that must know the tables, and the
 * REAL schema inside transactions that are always rolled back.
 *
 *   - idempotent (a re-run changes nothing and raises nothing), public.
 *     qualified, each ends by keeping the SQL console reader in step;
 *   - the scope key is the widened form from the start, with the English
 *     `reader:` prefix; the owner is an English ROLE code, never a person;
 *   - a decision never changes except its follow-up state, and is never
 *     deleted; its history and the recorded packs are append-only through the
 *     shared block_mutation(), so append_only_tables(), the cleanup, the SQL
 *     console revert and the go-live reset know all three tables;
 *   - population_ids holds whole numbers only and its length is the
 *     population.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
const read = (f) => fs.readFileSync(path.join(__dirname, '../../db/postgres', f), 'utf8');
const MIG197 = read('197_board_decisions.sql');
const MIG198 = read('198_board_pack_runs.sql');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__MIG197_ROLLBACK__');
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}
async function refused(q, sql, params = []) {
    await q.query('SAVEPOINT probe');
    try {
        await q.query(sql, params);
        await q.query('RELEASE SAVEPOINT probe');
        return null;
    } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT probe');
        return e.code || 'error';
    }
}

const TABLES = ['board_decisions', 'board_decision_events', 'board_pack_runs'];

describe('the migration files and the lists that must know the tables', () => {
    test('idempotent forms only, qualified, each ends with the console sync', () => {
        for (const mig of [MIG197, MIG198]) {
            expect(mig.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
            expect(mig).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
            expect(mig).not.toMatch(/\bDELETE\s+FROM\b/i);
            expect(mig).not.toMatch(/\bUPDATE\s+public\./i);
            // every table it names is schema-qualified
            for (const m of mig.matchAll(/\b(?:TABLE|ON|REFERENCES)\s+(?!IF\b|EACH\b)([a-z_]+)\b/g))
                expect([m[0], m[1]]).toEqual([m[0], 'public']);
        }
        expect(MIG197).toMatch(/CREATE TABLE IF NOT EXISTS public\.board_decisions /);
        expect(MIG197).toMatch(/CREATE TABLE IF NOT EXISTS public\.board_decision_events /);
        expect(MIG198).toMatch(/CREATE TABLE IF NOT EXISTS public\.board_pack_runs /);
        expect(MIG197).toMatch(
            /BEFORE DELETE ON public\.board_decisions[\s\S]{0,80}public\.block_mutation\(\)/
        );
        expect(MIG197).toMatch(
            /BEFORE UPDATE OR DELETE ON public\.board_decision_events[\s\S]{0,80}public\.block_mutation\(\)/
        );
        expect(MIG198).toMatch(
            /BEFORE UPDATE OR DELETE ON public\.board_pack_runs[\s\S]{0,80}public\.block_mutation\(\)/
        );
    });

    test('English codes from the start: the reader: prefix and the owner roles', () => {
        const widened =
            "reader:(admin|employee|manager):[0-9]{1,12}(/(site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}/dept:[0-9]{1,9}|svc:[0-9]{1,9}))?)$'";
        expect(MIG197).toContain(widened);
        expect(MIG198).toContain(widened);
        for (const mig of [MIG197, MIG198]) {
            expect(mig).not.toMatch(/perimetre|codir|\bdrh\b|formation/i);
        }
        expect(MIG197).toMatch(
            /'exec_committee', 'hr_director', 'hse', 'site', 'training',\s+'hr_local', 'managers', 'finance'/
        );
    });

    test('cleanup, console revert, go-live reset and erasure registry know the tables', () => {
        const cleanup = require('../../src/services/DatabaseCleanupService');
        const svc = require('../../src/services/SqlConsoleService');
        const golive = require('../../scripts/reset-for-golive');
        for (const t of TABLES) {
            expect([t, cleanup.isImmutable(t)]).toEqual([t, true]);
            expect(svc.PROTECTED_TABLES).toContain(t);
            expect([t, golive.WIPE.has(t)]).toEqual([t, true]);
            // row triggers only: the TRUNCATE of the reset needs no guard lifted
            expect(golive.APPEND_ONLY_WIPE).not.toContain(t);
        }
        const { SUBJECT_DATA_REGISTRY: reg } = require('../../src/services/erasureRegistry');
        for (const [t, c] of [
            ['board_decisions', 'created_by_ref'],
            ['board_decision_events', 'actor_ref'],
            ['board_pack_runs', 'generated_by_ref'],
            ['board_pack_runs', 'population_ids'],
        ])
            expect(reg.find((e) => e.table === t && e.column === c)).toMatchObject({
                treatment: 'keep',
            });
        const DSR = require('../../src/services/DSRService');
        expect(DSR.DISCLOSED_ABOUT_SUBJECT.map((x) => x.key)).toContain('boardTextsNamingSubject');
    });
});

suite('migrations 197 and 198 on the real schema', () => {
    test('a re-run is a no-op; the checks and the guards bind', async () => {
        const out = await inRolledBackTx(async (q) => {
            await q.query(MIG197);
            await q.query(MIG197);
            await q.query(MIG198);
            await q.query(MIG198);
            const trg = await q.query(
                `SELECT c.relname || ':' || t.tgname AS "t"
                   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = ANY($1) AND NOT t.tgisinternal ORDER BY 1`,
                [TABLES]
            );
            const aot = await q.query('SELECT table_name FROM public.append_only_tables()');
            const r = {};
            const ins = (scope, extra = {}) =>
                refused(
                    q,
                    `INSERT INTO board_decisions (scope_key, pack_date, decided_at, decision_text,
                                                  owner_role, due_date, kpi_id, created_by_ref)
                     VALUES ($1, CURRENT_DATE, CURRENT_DATE, $2, $3, $4, $5, 'admin:1')`,
                    [
                        scope,
                        extra.text === undefined ? 'Open a second training session' : extra.text,
                        extra.role || 'hr_director',
                        extra.due || null,
                        extra.kpi || null,
                    ]
                );
            for (const ok of [
                'org',
                'site:3',
                'site:none',
                'dept:4',
                'site:3/dept:4',
                'svc:2',
                'reader:manager:17',
                'reader:admin:2/site:3',
                'reader:employee:9/site:3/dept:4',
            ])
                r['ok ' + ok] = await ins(ok);
            for (const bad of [
                'perimetre:admin:2',
                'reader:admin:2/reader:admin:3',
                'site:x',
                'site:3/',
                'ORG',
                "org' OR '1'='1",
            ])
                r['bad ' + bad] = await ins(bad);
            r.roleFr = await ins('org', { role: 'codir' });
            r.blank = await ins('org', { text: '   ' });
            r.kpi = await ins('org', { kpi: 'K123' });
            r.dueBefore = await ins('org', { due: '2000-01-01' });

            const d = await q.query(
                `INSERT INTO board_decisions (scope_key, pack_date, decided_at, decision_text,
                                              owner_role, created_by_ref)
                 VALUES ('org', CURRENT_DATE, CURRENT_DATE, 'Review the safety plan', 'hse', 'admin:1')
                 RETURNING id`
            );
            const id = d.rows[0].id;
            r.closedWithoutDate = await refused(
                q,
                "UPDATE board_decisions SET state = 'done' WHERE id = $1",
                [id]
            );
            r.move = await refused(
                q,
                "UPDATE board_decisions SET state = 'done', state_changed_at = now(), closed_at = now() WHERE id = $1",
                [id]
            );
            r.text = await refused(
                q,
                "UPDATE board_decisions SET decision_text = 'Something else' WHERE id = $1",
                [id]
            );
            r.owner = await refused(
                q,
                "UPDATE board_decisions SET owner_role = 'finance' WHERE id = $1",
                [id]
            );
            r.del = await refused(q, 'DELETE FROM board_decisions WHERE id = $1', [id]);

            const ev = (kind, from, to, note) =>
                refused(
                    q,
                    `INSERT INTO board_decision_events (decision_id, kind, from_state, to_state, note, actor_ref)
                     VALUES ($1, $2, $3, $4, $5, 'admin:1')`,
                    [id, kind, from, to, note]
                );
            r.evCreated = await ev('created', null, 'open', null);
            r.evDropNoReason = await ev('state', 'open', 'dropped', null);
            r.evSame = await ev('state', 'open', 'open', null);
            r.evNoteEmpty = await ev('note', null, null, '  ');
            r.evNote = await ev('note', null, null, 'Budget confirmed');
            r.evUpdate = await refused(
                q,
                "UPDATE board_decision_events SET note = 'x' WHERE decision_id = $1",
                [id]
            );
            r.evDelete = await refused(
                q,
                'DELETE FROM board_decision_events WHERE decision_id = $1',
                [id]
            );

            const run = (ids, population, extra = '') =>
                refused(
                    q,
                    `INSERT INTO board_pack_runs (scope_key, pack_date, kpi_contract, population,
                                                  population_ids, generated_by_ref${extra ? ', coverage' : ''})
                     VALUES ('org', CURRENT_DATE, 'kpi-2', $1, $2::bigint[], 'admin:1'${extra ? ', ' + extra : ''})`,
                    [population, ids]
                );
            r.runOk = await run([3, 5, 8], 3);
            r.runCount = await run([3, 5], 3);
            r.runNull = await run([3, null], 2);
            r.runText = await run(['3', 'x'], 2);
            r.runCoverage = await run([1], 1, '101');
            r.runScope = await refused(
                q,
                `INSERT INTO board_pack_runs (scope_key, pack_date, kpi_contract, population, generated_by_ref)
                 VALUES ('perimetre:admin:1', CURRENT_DATE, 'kpi-2', 0, 'admin:1')`
            );
            r.runUpdate = await refused(q, "UPDATE board_pack_runs SET kpi_contract = 'kpi-1'");
            r.runDelete = await refused(q, 'DELETE FROM board_pack_runs');
            return {
                triggers: trg.rows.map((x) => x.t),
                aot: aot.rows.map((x) => x.table_name),
                r,
            };
        });
        expect(out.triggers).toEqual([
            'board_decision_events:trg_board_decision_events_immutable',
            'board_decisions:trg_board_decisions_guard',
            'board_decisions:trg_board_decisions_no_delete',
            'board_pack_runs:trg_board_pack_runs_immutable',
        ]);
        for (const t of TABLES) expect(out.aot).toContain(t);
        const R = out.r;
        for (const k of Object.keys(R).filter((x) => x.startsWith('ok ')))
            expect([k, R[k]]).toEqual([k, null]);
        for (const k of Object.keys(R).filter((x) => x.startsWith('bad ')))
            expect([k, R[k]]).toEqual([k, '23514']);
        expect(R.roleFr).toBe('23514');
        expect(R.blank).toBe('23514');
        expect(R.kpi).toBe('23514');
        expect(R.dueBefore).toBe('23514');
        expect(R.closedWithoutDate).toBe('23514');
        expect(R.move).toBeNull(); // the follow-up state is the one thing that moves
        expect(R.text).toBe('23514');
        expect(R.owner).toBe('23514');
        expect(R.del).toBe('23514');
        expect(R.evCreated).toBeNull();
        expect(R.evDropNoReason).toBe('23514');
        expect(R.evSame).toBe('23514');
        expect(R.evNoteEmpty).toBe('23514');
        expect(R.evNote).toBeNull();
        expect(R.evUpdate).toBe('23514');
        expect(R.evDelete).toBe('23514');
        expect(R.runOk).toBeNull();
        expect(R.runCount).toBe('23514');
        expect(R.runNull).toBe('23514');
        expect(R.runText).toBe('22P02'); // not a whole number: refused by the type
        expect(R.runCoverage).toBe('23514');
        expect(R.runScope).toBe('23514');
        expect(R.runUpdate).toBe('23514');
        expect(R.runDelete).toBe('23514');
    });
});
