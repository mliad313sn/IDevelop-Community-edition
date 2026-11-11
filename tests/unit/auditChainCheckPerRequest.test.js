'use strict';

/**
 * The audit-chain check is shared inside ONE request (two readers, one walk
 * of the chain in the database) and never across requests: a new request
 * always sees the chain as it is now. A failure is not kept.
 */
const mockDb = { get: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const Audit = require('../../src/services/AuditRetentionService');

const intact = { v: { intact: true, checked: 12, broken: {} } };

beforeEach(() => {
    mockDb.get.mockReset();
});

const verifyCalls = () =>
    mockDb.get.mock.calls.filter((c) => /fn_system_logs_verify/.test(String(c[0]))).length;

test('two readers of one request: one database call, the same answer', async () => {
    mockDb.get.mockResolvedValue(intact);
    const req = {};
    const [a, b] = await Promise.all([
        Audit.chainStatusOnce(req, 10),
        Audit.chainStatusOnce(req, 10),
    ]);
    const c = await Audit.chainStatusOnce(req, 10);
    expect(verifyCalls()).toBe(1);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(a.intact).toBe(true);
});

test('a new request walks the chain again (never cached across requests)', async () => {
    mockDb.get.mockResolvedValueOnce(intact).mockResolvedValueOnce({
        v: { intact: false, broken: { content: [7] } },
    });
    const first = await Audit.chainStatusOnce({}, 10);
    const second = await Audit.chainStatusOnce({}, 10);
    expect(verifyCalls()).toBe(2);
    expect(first.intact).toBe(true);
    expect(second).toMatchObject({ intact: false, brokenAt: [7] });
});

test('a failure is not kept; no request means no cache', async () => {
    mockDb.get.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(intact);
    const req = {};
    await expect(Audit.chainStatusOnce(req, 10)).rejects.toThrow('db down');
    await expect(Audit.chainStatusOnce(req, 10)).resolves.toMatchObject({ intact: true });
    await Audit.chainStatusOnce(null, 10);
    await Audit.chainStatusOnce(null, 10);
    expect(verifyCalls()).toBe(4);
});

test('GET /v2/cap/audit/verify goes through the per-request check', () => {
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../src/routes/v2-capability.js'),
        'utf8'
    );
    expect(src).toMatch(/AuditRetentionService'\)\.chainStatusOnce\(req, 10\)/);
});
