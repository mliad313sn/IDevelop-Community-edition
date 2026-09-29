'use strict';

// Security invariant: the SQL console's tamper guard and its restore-point Revert
// must agree about which tables are append-only. Before this was fixed, the editor
// refused to write system_logs / assessment_history / review_signatures while the
// Revert button next to it rolled all three back via pg_restore --clean — one click
// erased the hash-chained audit trail the same page called immutable.
//
// These tests lock the three pieces that keep the two coherent:
//   1. both read ONE list (DatabaseCleanupService.IMMUTABLE_TABLES);
//   2. the re-attach carries preserved rows back VERBATIM with the hash-chain
//      trigger suspended, so row_hash/prev_hash survive and the chain still verifies;
//   3. a row that genuinely cannot come back is reported and quarantined — and the
//      next revert refuses — instead of being silently dropped.
const mockClient = { query: jest.fn(), release: jest.fn() };
const mockDb = {
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn(),
    runTransaction: jest.fn(),
    pool: { connect: jest.fn(async () => mockClient) },
};
jest.mock('../../src/config/database', () => mockDb);

const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../../src/services/SqlConsoleService');
const cleanup = require('../../src/services/DatabaseCleanupService');

/** Minimal fake pg client: dispatch on the SQL text, record everything issued. */
function fakeClient(handlers) {
    const log = [];
    return {
        log,
        release() {},
        async query(sql, params) {
            log.push(String(sql).replace(/\s+/g, ' ').trim());
            for (const [re, res] of handlers) {
                if (re.test(sql)) return typeof res === 'function' ? res(sql, params) : res;
            }
            return { rows: [], rowCount: 0 };
        },
    };
}

const COLS = [
    { attname: 'id' },
    { attname: 'action' },
    { attname: 'prev_hash' },
    { attname: 'row_hash' },
];

function reattachHandlers({ onBulkInsert, onRowInsert } = {}) {
    return [
        [
            /fn_system_logs_hashchain/,
            { rows: [{ tbl: 'system_logs', tgname: 'trg_system_logs_hashchain' }] },
        ],
        [/a\.attname/, { rows: COLS }], // _commonColumns
        [
            /SELECT attname FROM pg_attribute/,
            { rows: COLS.concat([{ attname: 'added_by_later_migration' }]) },
        ],
        [/SELECT p\.id FROM/, { rows: [{ id: '7' }, { id: '8' }] }], // rows the restore removed
        [
            /^INSERT INTO public\."system_logs" .* SELECT .* FROM "audit_preserve_/s,
            (sql, p) => {
                if (p) return onRowInsert ? onRowInsert(p) : { rowCount: 1 };
                if (onBulkInsert) return onBulkInsert();
                return { rowCount: 2 };
            },
        ],
    ];
}

const PRESERVED = {
    schema: 'audit_preserve_20260101000000_ab12',
    tables: ['system_logs'],
    counts: { system_logs: 42 },
};

describe('SQL console — append-only tables survive a restore-point revert', () => {
    test('the tamper guard and the revert read ONE list of append-only tables', () => {
        expect(svc.PROTECTED_TABLES.slice().sort()).toEqual(
            cleanup.IMMUTABLE_PG_TABLES.slice().sort()
        );
        // self_assessment_events joined the list in the UAT3 pass-2 fix: migration 116
        // had put the same two append-only triggers on it and the list stayed at three,
        // so the console let DELETE — and DROP TABLE — through on a journal the database
        // itself calls immutable, and the revert's quarantine never copied it.
        expect(svc.PROTECTED_TABLES.slice().sort()).toEqual([
            'assessment_history',
            'review_signatures',
            'self_assessment_events',
            'system_logs',
        ]);
        // …and it is really derived from IMMUTABLE_TABLES, not a parallel copy.
        for (const t of svc.PROTECTED_TABLES) expect(cleanup.isImmutable(t)).toBe(true);
    });

    test('re-attach suspends the hash-chain trigger and carries the hash columns back verbatim', async () => {
        const c = fakeClient(reattachHandlers());
        const report = await svc._reattachAuditTables(c, PRESERVED);

        const iDisable = c.log.findIndex((s) =>
            /DISABLE TRIGGER "trg_system_logs_hashchain"/.test(s)
        );
        const iInsert = c.log.findIndex((s) => /^INSERT INTO public\."system_logs"/.test(s));
        const iEnable = c.log.findIndex((s) =>
            /ENABLE TRIGGER "trg_system_logs_hashchain"/.test(s)
        );
        expect(iDisable).toBeGreaterThan(-1);
        expect(iDisable).toBeLessThan(iInsert); // hashes are NOT recomputed…
        expect(iEnable).toBeGreaterThan(iInsert); // …and the trigger comes back
        expect(c.log[iEnable + 1]).toBe('COMMIT'); // both inside one transaction
        // prev_hash/row_hash are among the copied columns → the chain still verifies.
        expect(c.log[iInsert]).toMatch(/"prev_hash"/);
        expect(c.log[iInsert]).toMatch(/"row_hash"/);
        // The sequence is realigned or the next audit append would collide on the PK.
        expect(c.log.some((s) => /setval\(pg_get_serial_sequence/.test(s))).toBe(true);

        expect(report.system_logs.reattached).toBe(2);
        expect(report.system_logs.unreattachable).toEqual([]);
        // A restore point older than a migration cannot carry that migration's columns.
        expect(report.system_logs.droppedColumns).toEqual(['added_by_later_migration']);
    });

    test('one un-attachable row does not cost the rest of the audit tail — it is reported, not dropped', async () => {
        const fk = Object.assign(
            new Error('violates foreign key constraint "assessment_history_employee_id_fkey"'),
            { code: '23503' }
        );
        const c = fakeClient(
            reattachHandlers({
                onBulkInsert: () => {
                    throw fk;
                }, // atomic pass fails…
                onRowInsert: (p) => {
                    if (String(p[0]) === '8') throw fk;
                    return { rowCount: 1 };
                }, // …row-wise saves the rest
            })
        );
        const report = await svc._reattachAuditTables(c, PRESERVED);

        expect(c.log).toContain('ROLLBACK');
        expect(c.log.filter((s) => /SAVEPOINT reattach_row/.test(s)).length).toBeGreaterThan(0);
        expect(report.system_logs.reattached).toBe(1);
        expect(report.system_logs.unreattachable).toHaveLength(1);
        expect(report.system_logs.unreattachable[0].id).toBe('8');
        expect(report.system_logs.unreattachable[0].error).toMatch(/foreign key/);
    });

    test('nothing to re-attach → no transaction is opened at all', async () => {
        const h = reattachHandlers();
        h[3] = [/SELECT p\.id FROM/, { rows: [] }];
        const c = fakeClient(h);
        const report = await svc._reattachAuditTables(c, PRESERVED);
        expect(c.log).not.toContain('BEGIN');
        expect(report.system_logs.reattached).toBe(0);
    });

    test('a revert REFUSES while audit rows from an earlier revert are still quarantined', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlconsole-rp-'));
        const prev = process.env.SQL_CONSOLE_BACKUP_DIR;
        process.env.SQL_CONSOLE_BACKUP_DIR = dir;
        fs.writeFileSync(path.join(dir, 'rp-1.dump'), 'not-a-real-dump');
        mockClient.query.mockReset();
        mockClient.query.mockImplementation(async (sql) =>
            /pg_namespace WHERE nspname LIKE/.test(sql)
                ? { rows: [{ nspname: 'audit_preserve_20260101000000_ab12' }] }
                : { rows: [] }
        );
        try {
            await expect(svc.revertRestorePoint('rp-1')).rejects.toThrow(/Refusing to revert/);
            // It must bail out BEFORE pg_restore — no snapshot, no restore, no data loss.
            const issued = mockClient.query.mock.calls.map((c) => String(c[0]));
            expect(issued.some((s) => /CREATE SCHEMA/.test(s))).toBe(false);
        } finally {
            process.env.SQL_CONSOLE_BACKUP_DIR = prev;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an unknown restore point is still rejected before anything is touched', async () => {
        await expect(svc.revertRestorePoint('../../etc/passwd')).rejects.toThrow(
            /Invalid restore point name/
        );
    });
});
