'use strict';
/**
 * 3.23.18 lane O-ops2 — S-06 nightly audit-chain anchor (src/jobs/audit-anchor.js).
 * A mocked db hands back the chain head; the job must append ONE JSON line per
 * day to <dir>/chain-head.log, never rewrite earlier lines, skip an empty chain
 * (absence of a head is not a head) and respect the hour gate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const job = require('../../src/jobs/audit-anchor');

function fakeDb(row) {
    return { get: jest.fn(async () => row) };
}

describe('audit-anchor job', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-anchor-'));
    });
    afterEach(() => {
        // The job restricts a folder it CREATES; we pre-create `dir`, and the test
        // user owns everything under it, so plain removal works.
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const env = () => ({ AUDIT_ANCHOR_DIR: path.join(dir, 'anchors') });
    const at = (iso) => new Date(iso);

    test('appends the head (id, row_hash, created_at) once per day, never rewrites', async () => {
        const db1 = fakeDb({
            id: 41,
            rowHash: 'aa'.repeat(32),
            createdAt: new Date('2026-09-25T22:00:00Z'),
        });
        const r1 = await job.tick({ now: at('2026-09-26T03:00:00'), env: env(), db: db1 });
        expect(r1.done).toBe(true);
        expect(db1.get.mock.calls[0][0]).toMatch(/FROM system_logs[\s\S]*ORDER BY id DESC LIMIT 1/);

        const again = await job.tick({ now: at('2026-09-26T09:00:00'), env: env(), db: db1 });
        expect(again).toEqual({ done: false, skipped: 'already_today' });

        const db2 = fakeDb({ id: 57, rowHash: 'bb'.repeat(32), createdAt: '2026-09-26T21:00:00Z' });
        const r2 = await job.tick({ now: at('2026-09-27T03:00:00'), env: env(), db: db2 });
        expect(r2.done).toBe(true);

        const lines = fs
            .readFileSync(path.join(dir, 'anchors', job.FILE_NAME), 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse);
        expect(lines.map((l) => [l.day, l.id, l.rowHash])).toEqual([
            ['2026-09-26', 41, 'aa'.repeat(32)],
            ['2026-09-27', 57, 'bb'.repeat(32)],
        ]);
        expect(lines[0].createdAt).toBe('2026-09-25T22:00:00.000Z');
        expect(lines[0].table).toBe('system_logs');
    });

    test('an empty chain writes nothing', async () => {
        const r = await job.tick({ now: at('2026-09-26T03:00:00'), env: env(), db: fakeDb(null) });
        expect(r).toEqual({ done: false, skipped: 'empty_chain' });
        expect(fs.existsSync(path.join(dir, 'anchors', job.FILE_NAME))).toBe(false);
    });

    test('hour gate (default 01:00) unless forced', async () => {
        const db = fakeDb({ id: 1, rowHash: 'cc', createdAt: null });
        expect(await job.tick({ now: at('2026-09-26T00:30:00'), env: env(), db })).toEqual({
            done: false,
            skipped: 'before_hour',
        });
        expect(
            (await job.tick({ force: true, now: at('2026-09-26T00:30:00'), env: env(), db })).done
        ).toBe(true);
    });

    test('default folder is %ProgramData%\\IDevelop\\audit-anchors', () => {
        expect(job.anchorDir({ ProgramData: 'C:\\ProgramData' })).toBe(
            path.join('C:\\ProgramData', 'IDevelop', 'audit-anchors')
        );
    });
});
