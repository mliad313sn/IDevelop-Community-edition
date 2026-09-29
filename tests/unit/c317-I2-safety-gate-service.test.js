'use strict';
/**
 * 3.23.18 lane I2 — safety-competency gate (SafetyGateService, migration 150).
 *
 * Behavioural: the pure evaluation, the change recording (audit + history +
 * webhook queue), the webhook delivery (signature, backoff, abandonment) and
 * the SSRF guard. The database is mocked; dns is mocked where a host name is
 * resolved, so nothing leaves the machine.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockScoped = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScoped(...a),
    scopeClause: () => '',
}));
const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: (...a) => mockLog(...a) }));

const crypto = require('crypto');
const dns = require('dns');
const SG = require('../../src/services/SafetyGateService');

const { STATUS, REASON } = SG;
const EMP = { id: 7, isActive: true, roleId: 10, siteId: 1 };
const rule = (skillId, minLevel, certRequired = false, extra = {}) => ({
    roleId: 10,
    siteId: null,
    skillId,
    skillName: `S${skillId}`,
    minLevel,
    certRequired,
    ...extra,
});
const facts = ({ levels = {}, certs = {}, lapsed = {} } = {}) => ({
    levels: new Map(Object.entries(levels).map(([k, v]) => [Number(k), v])),
    certs: new Map(Object.entries(certs).map(([k, v]) => [Number(k), v])),
    lapsed: new Map(Object.entries(lapsed).map(([k, v]) => [Number(k), v])),
});
const codes = (r) => r.reasons.map((x) => x.code);

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockScoped.mockReset().mockResolvedValue(null);
    mockLog.mockClear();
    delete process.env.SAFETY_GATE_WEBHOOK_ALLOW_PRIVATE;
});
afterEach(() => jest.restoreAllMocks());

describe('evaluate — the rules of the gate', () => {
    test('a skill never assessed BLOCKS with not_assessed — never a silent level 0', () => {
        const r = SG.evaluate(EMP, [rule(1, 2)], facts());
        expect(r.status).toBe(STATUS.BLOCKED);
        expect(codes(r)).toEqual([REASON.NOT_ASSESSED]);
        expect(codes(r)).not.toContain(REASON.LEVEL_BELOW_MIN);
    });

    test('measured below the minimum → level_below_min; at the minimum → CLEARED', () => {
        expect(codes(SG.evaluate(EMP, [rule(1, 3)], facts({ levels: { 1: 2 } })))).toEqual([
            REASON.LEVEL_BELOW_MIN,
        ]);
        expect(SG.evaluate(EMP, [rule(1, 3)], facts({ levels: { 1: 3 } })).status).toBe(
            STATUS.CLEARED
        );
    });

    test('a measured level of 0 is below the minimum (a measurement), not "not assessed"', () => {
        expect(codes(SG.evaluate(EMP, [rule(1, 1)], facts({ levels: { 1: 0 } })))).toEqual([
            REASON.LEVEL_BELOW_MIN,
        ]);
    });

    test('mandatory certificate: missing / expired / revoked each block with their own code', () => {
        const ok = { 1: 4 };
        expect(codes(SG.evaluate(EMP, [rule(1, 2, true)], facts({ levels: ok })))).toEqual([
            REASON.CERT_MISSING,
        ]);
        expect(
            codes(
                SG.evaluate(
                    EMP,
                    [rule(1, 2, true)],
                    facts({
                        levels: ok,
                        lapsed: { 1: { lapseReason: 'expired', lastExpiresOn: '2026-01-01' } },
                    })
                )
            )
        ).toEqual([REASON.CERT_EXPIRED]);
        expect(
            codes(
                SG.evaluate(
                    EMP,
                    [rule(1, 2, true)],
                    facts({
                        levels: ok,
                        lapsed: { 1: { lapseReason: 'revoked', lastExpiresOn: null } },
                    })
                )
            )
        ).toEqual([REASON.CERT_REVOKED]);
    });

    test('a lapsed certificate degrades the skill even when the rule does not require one (migration 78)', () => {
        const r = SG.evaluate(
            EMP,
            [rule(1, 2)],
            facts({
                levels: { 1: 4 },
                lapsed: { 1: { lapseReason: 'expired', lastExpiresOn: '2026-03-01' } },
            })
        );
        expect(r.status).toBe(STATUS.BLOCKED);
        expect(r.reasons[0]).toMatchObject({ code: REASON.CERT_EXPIRED, expiresOn: '2026-03-01' });
    });

    test('valid certificate inside the warning window → EXPIRING (still cleared); outside → CLEARED', () => {
        const f = (days) =>
            facts({
                levels: { 1: 4 },
                certs: { 1: { certStatus: 'valid', expiresOn: '2026-10-10', daysLeft: days } },
            });
        const soon = SG.evaluate(EMP, [rule(1, 2, true)], f(10), { warningDays: 30 });
        expect(soon.status).toBe(STATUS.EXPIRING);
        expect(soon.nextExpiry).toBe('2026-10-10');
        expect(soon.reasons[0]).toMatchObject({ code: REASON.CERT_EXPIRING, blocking: false });
        expect(SG.evaluate(EMP, [rule(1, 2, true)], f(60), { warningDays: 30 }).status).toBe(
            STATUS.CLEARED
        );
    });

    test('no configured rule → NOT_CONFIGURED; no role → NOT_CONFIGURED with no_role; leaver → BLOCKED', () => {
        expect(SG.evaluate(EMP, [], facts()).status).toBe(STATUS.NOT_CONFIGURED);
        const noRole = SG.evaluate({ ...EMP, roleId: null }, [], facts());
        expect(noRole.status).toBe(STATUS.NOT_CONFIGURED);
        expect(codes(noRole)).toEqual([REASON.NO_ROLE]);
        const leaver = SG.evaluate(
            { ...EMP, isActive: false },
            [rule(1, 1)],
            facts({ levels: { 1: 4 } })
        );
        expect(leaver.status).toBe(STATUS.BLOCKED);
        expect(codes(leaver)).toContain(REASON.EMPLOYEE_INACTIVE);
    });

    test("rules merge to the STRICTEST per skill; another site's rule is ignored", () => {
        const merged = SG.applicableRules(EMP, [
            rule(1, 2),
            rule(1, 3, false, { siteId: 1 }),
            rule(1, 4, true, { siteId: 2 }),
            rule(2, 1, true),
            rule(9, 4, false, { roleId: 99 }),
        ]);
        expect(merged).toEqual([
            { skillId: 1, skillName: 'S1', minLevel: 3, certRequired: false },
            { skillId: 2, skillName: 'S2', minLevel: 1, certRequired: true },
        ]);
    });
});

describe('toApi — status, reason codes and expiry dates only', () => {
    test('never exposes an assessment level; NOT_CONFIGURED and BLOCKED are not cleared', () => {
        const r = SG.evaluate(
            EMP,
            [rule(1, 3), rule(2, 1, true)],
            facts({ levels: { 1: 2, 2: 4 } })
        );
        const out = SG.toApi({ ...r, employeeNumber: 'E7', evaluatedAt: 'x' });
        const json = JSON.stringify(out);
        expect(json).not.toMatch(/"level"|"requiredLevel"|"rawLevel"/);
        expect(out.cleared).toBe(false);
        expect(out.reasons.map((x) => x.code).sort()).toEqual(
            [REASON.CERT_MISSING, REASON.LEVEL_BELOW_MIN].sort()
        );
        expect(
            SG.toApi({ status: STATUS.NOT_CONFIGURED, reasons: [], employeeNumber: 'E' }).cleared
        ).toBe(false);
        expect(
            SG.toApi({ status: STATUS.EXPIRING, reasons: [], employeeNumber: 'E' }).cleared
        ).toBe(true);
    });
});

describe('scopeAllowsSafetyRead — which API keys may read the gate', () => {
    test.each([
        ['safety.read', true],
        ['powerbi.read safety.read', true],
        ['powerbi.read', false],
        ['read', false],
        ['legacy.shared', false],
        ['', false],
        [null, false],
    ])('%p → %p', (scope, ok) => expect(SG.scopeAllowsSafetyRead(scope)).toBe(ok));
});

describe('computeFor — end to end over mocked reads', () => {
    function wire({ levels = [], certs = [], lapsed = [], cached = [] } = {}) {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_settings/.test(sql))
                return { expiryWarningDays: 30, webhookEnabled: false };
            if (/INSERT INTO safety_gate_status/.test(sql)) return { employeeId: 7 };
            return null;
        });
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM employees e/.test(sql))
                return [
                    {
                        id: 7,
                        employeeNumber: 'E7',
                        name: 'A',
                        isActive: true,
                        roleId: 10,
                        siteId: 1,
                    },
                ];
            if (/FROM safety_gate_rules gr JOIN skills/.test(sql)) return [rule(1, 2, true)];
            if (/v_resolved_assessments/.test(sql)) return levels;
            if (/v_certification_current/.test(sql)) return certs;
            if (/v_certification_lapsed/.test(sql)) return lapsed;
            if (/FROM safety_gate_status WHERE/.test(sql)) return cached;
            return [];
        });
    }

    test('nothing measured → BLOCKED not_assessed + cert_missing, recorded once with an audit row', async () => {
        wire();
        const [r] = await SG.computeFor({ employeeNumber: 'E7' }, null);
        expect(r.status).toBe(STATUS.BLOCKED);
        expect(codes(r).sort()).toEqual([REASON.CERT_MISSING, REASON.NOT_ASSESSED].sort());
        const history = mockDb.run.mock.calls.filter(([sql]) =>
            /safety_gate_status_history/.test(sql)
        );
        expect(history).toHaveLength(1);
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SAFETY_GATE_STATUS_CHANGED', entityId: 7 })
        );
    });

    test('the same answer again is not recorded again', async () => {
        wire();
        const [first] = await SG.computeFor({ employeeNumber: 'E7' }, null, { record: false });
        wire({
            cached: [{ employeeId: 7, status: first.status, fingerprint: SG.fingerprint(first) }],
        });
        await SG.computeFor({ employeeNumber: 'E7' }, null);
        expect(
            mockDb.run.mock.calls.filter(([sql]) => /safety_gate_status_history/.test(sql))
        ).toHaveLength(0);
        expect(mockLog).not.toHaveBeenCalled();
    });

    test('an empty RBAC scope reads nothing', async () => {
        await expect(SG.computeFor({}, [])).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

describe('recordStatuses — webhook only on a real status change', () => {
    const result = {
        employeeId: 7,
        employeeNumber: 'E7',
        status: STATUS.BLOCKED,
        reasons: [{ code: 'not_assessed', blocking: true, skillId: 1 }],
        nextExpiry: null,
        evaluatedAt: 'x',
    };
    test('CLEARED → BLOCKED with the webhook enabled queues one delivery', async () => {
        jest.spyOn(global, 'setImmediate').mockImplementation(() => 0);
        mockDb.all.mockResolvedValue([
            { employeeId: 7, status: STATUS.CLEARED, fingerprint: 'CLEARED|' },
        ]);
        mockDb.get.mockImplementation(async (sql) => {
            if (/INSERT INTO safety_gate_status /.test(sql)) return { employeeId: 7 };
            if (/INSERT INTO safety_gate_webhook_deliveries/.test(sql)) return { id: 55 };
            return null;
        });
        await SG.recordStatuses([result], 'test', {
            webhookEnabled: true,
            webhookUrl: 'https://hooks.example.com/x',
        });
        const q = mockDb.get.mock.calls.filter(([sql]) =>
            /safety_gate_webhook_deliveries/.test(sql)
        );
        expect(q).toHaveLength(1);
        const payload = JSON.parse(q[0][1][1]);
        expect(payload).toMatchObject({
            event: 'safety_gate.status_changed',
            previousStatus: 'CLEARED',
            status: 'BLOCKED',
            cleared: false,
        });
    });

    test('first ever evaluation is logged but does not fire the webhook', async () => {
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO safety_gate_status /.test(sql) ? { employeeId: 7 } : null
        );
        await SG.recordStatuses([result], 'test', {
            webhookEnabled: true,
            webhookUrl: 'https://hooks.example.com/x',
        });
        expect(
            mockDb.get.mock.calls.some(([sql]) => /safety_gate_webhook_deliveries/.test(sql))
        ).toBe(false);
        expect(mockLog).toHaveBeenCalledTimes(1);
    });
});

describe('SSRF guard — https only, no private addresses', () => {
    test.each([
        ['http://hooks.example.com/x', 'https_only'],
        ['ftp://hooks.example.com/x', 'https_only'],
        ['https://user:pw@hooks.example.com/x', 'bad_url'],
        ['not a url', 'bad_url'],
        ['https://127.0.0.1/x', 'private_address'],
        ['https://169.254.169.254/latest/meta-data', 'private_address'],
        ['https://[::1]/x', 'private_address'],
    ])('%s → %s', async (url, code) => {
        await expect(SG.checkWebhookUrl(url)).resolves.toEqual({ ok: false, code });
    });

    test('a public-looking name that RESOLVES to a private address is refused', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
        await expect(SG.checkWebhookUrl('https://hooks.example.com/x')).resolves.toEqual({
            ok: false,
            code: 'private_address',
        });
    });

    test('saving a private webhook URL is refused and nothing is written', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
            { address: '192.168.1.20', family: 4 },
        ]);
        await expect(
            SG.updateSettings(
                {
                    expiryWarningDays: 30,
                    webhookUrl: 'https://ptw.local.example/x',
                    webhookSecret: 's',
                    webhookEnabled: true,
                },
                { id: 1, userType: 'admin', role: 'superadmin' } // 3.23.21 SEC-1: webhook settings are super admin only
            )
        ).rejects.toMatchObject({ code: 'private_address' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('the sender itself re-checks the address: no connection to a private target', async () => {
        const https = require('https');
        const spy = jest.spyOn(https, 'request');
        const r = await SG._postOnce('https://10.0.0.8/hook', '{}', {});
        expect(r).toMatchObject({ ok: false, error: 'private_address' });
        expect(spy).not.toHaveBeenCalled();
    });

    test('enabling the webhook without a secret is refused (unsigned calls never leave)', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
        ]);
        mockDb.get.mockResolvedValue({ secret: null });
        await expect(
            SG.updateSettings(
                {
                    expiryWarningDays: 30,
                    webhookUrl: 'https://hooks.example.com/x',
                    webhookEnabled: true,
                },
                { id: 1, userType: 'admin', role: 'superadmin' }
            )
        ).rejects.toMatchObject({ code: 'secret_required' });
    });
});

describe('deliver — signature, backoff, abandonment', () => {
    function wireDelivery(attempts) {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_webhook_deliveries/.test(sql))
                return { id: 3, event: 'safety_gate.status_changed', payload: '{"a":1}', attempts };
            if (/FROM safety_gate_settings/.test(sql))
                return { url: 'https://hooks.example.com/x', secret: 'topsecret', enabled: true };
            return null;
        });
    }

    test('signs HMAC-SHA256 over "<timestamp>.<body>" and marks delivered', async () => {
        wireDelivery(0);
        const send = jest.fn(async () => ({ ok: true, status: 200 }));
        const r = await SG.deliver(3, { send });
        expect(r).toMatchObject({ delivered: true, attempts: 1 });
        const [, body, headers] = send.mock.calls[0];
        const expected =
            'sha256=' +
            crypto
                .createHmac('sha256', 'topsecret')
                .update(`${headers['X-IDevelop-Timestamp']}.${body}`)
                .digest('hex');
        expect(headers['X-IDevelop-Signature']).toBe(expected);
        expect(mockDb.run.mock.calls[0][0]).toMatch(/state = 'delivered'/);
    });

    test('a failure is rescheduled with exponential backoff', async () => {
        wireDelivery(2);
        const r = await SG.deliver(3, {
            send: async () => ({ ok: false, status: 503, error: 'http_503' }),
        });
        expect(r).toMatchObject({ delivered: false, attempts: 3, abandoned: false });
        const params = mockDb.run.mock.calls[0][1];
        expect(params[0]).toBe('pending');
        expect(params[4]).toBe(SG.backoffMinutes(3));
        expect([1, 2, 3, 4].map(SG.backoffMinutes)).toEqual([1, 2, 4, 8]);
    });

    test('the last allowed attempt abandons the delivery and audits it', async () => {
        wireDelivery(5);
        const r = await SG.deliver(3, {
            send: async () => ({ ok: false, status: null, error: 'timeout' }),
        });
        expect(r.abandoned).toBe(true);
        expect(mockDb.run.mock.calls[0][1][0]).toBe('abandoned');
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SAFETY_GATE_WEBHOOK_ABANDONED' })
        );
    });
});

describe('rule configuration — nothing is ever deleted', () => {
    test('deactivating needs a reason', async () => {
        await expect(
            SG.deactivateRule(1, '  ', { id: 1, userType: 'admin' })
        ).rejects.toMatchObject({ code: 'reason_required' });
        expect(mockDb.get).not.toHaveBeenCalled();
    });
    test('minimum level must be 1..4', async () => {
        await expect(
            SG.addRule({ roleId: 1, skillId: 2, minLevel: 0 }, null)
        ).rejects.toMatchObject({ code: 'bad_level' });
        await expect(
            SG.addRule({ roleId: 1, skillId: 2, minLevel: 5 }, null)
        ).rejects.toMatchObject({ code: 'bad_level' });
    });
});
