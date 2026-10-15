'use strict';
/**
 * Audit lines of the SSO-enforced password door and of SSO sign-ins carry the
 * subject ref (`admin:<id>` / `employee:<id>`) or the `fp:<10 hex>` fingerprint
 * of an unknown identifier — never the identifier as typed, never a username —
 * and the ref is one SystemLogModel.resolvePeople turns back into the name when
 * the log is read. Behavioural, mocked database.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockEnv = { adminsByName: {}, employees: {} };

jest.mock('../../src/config/sso', () => ({
    isConfigured: () => true,
    getEnabledProviders: () => [
        { key: 'entra', label: 'Microsoft', icon: '', name: 'Microsoft', customLabel: false },
    ],
}));
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM admins WHERE id = ANY/.test(s))
            return [{ id: 7, username: 'ops.lead', linked_employee_id: null }].filter((a) =>
                p[0].includes(a.id)
            );
        if (/FROM employees WHERE id = ANY/.test(s))
            return [{ id: 55, first_name: 'Rhea', last_name: 'MARLOWE', erased_at: null }].filter(
                (e) => p[0].includes(e.id)
            );
        return [];
    }),
    run: jest.fn(async () => ({ changes: 1 })),
}));
const mockAudit = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn((e) => {
        mockAudit.push(e);
        return Promise.resolve();
    }),
}));
jest.mock('../../src/middleware/rateLimiter', () => ({
    recordLoginAttempt: jest.fn(async () => {}),
    noteEnforcedFailure: jest.fn(async () => {}),
    clearEnforcedFailures: jest.fn(),
    lockStateFor: jest.fn(async () => ({ locked: false })),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async (u) => mockEnv.adminsByName[u]),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async () => null),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async (u) => mockEnv.employees[u]),
    findById: jest.fn(async () => null),
}));
jest.mock('../../src/services/AuthService', () => ({ login: jest.fn() }));
jest.mock('../../src/services/EmployeeAuthService', () => ({
    login: jest.fn(),
    takeRefusalCode: () => null,
}));

const bcrypt = require('bcrypt');
const GOOD = bcrypt.hashSync('good', 4);
const { _enforcedPasswordLogin } = require('../../src/middleware/auth');
const SsoController = require('../../src/controllers/SsoController');
const SystemLogModel = require('../../src/models/SystemLogModel');
const { fingerprint } = require('../../src/services/AuditRetentionService');

const ctx = { ip: '192.0.2.9', get: () => 'jest' };
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    mockAudit.length = 0;
    mockEnv.adminsByName = {
        root: { id: 1, username: 'root', role: 'superadmin', isActive: true, passwordHash: GOOD },
        'ops.lead': { id: 7, username: 'ops.lead', role: 'localadmin', isActive: true },
    };
    mockEnv.employees = {
        'rhea.marlowe': { id: 55, username: 'rhea.marlowe', passwordHash: GOOD },
    };
});

describe('SSO-enforced password door: refs / fingerprints, never the typed identifier', () => {
    test.each([
        ['ops.lead', /password sign-in for admin:7 refused/],
        ['rhea.marlowe', /password sign-in for employee:55 refused/],
        ['Sam.Typo@corp.example', null],
    ])('%s → audited without the identifier', async (typed, want) => {
        await _enforcedPasswordLogin({}, typed, 'whatever', ctx);
        await flush();
        const line = mockAudit.find((l) => l.action === 'LOGIN_BLOCKED');
        expect(line).toBeTruthy();
        expect(line.details).not.toContain(typed);
        expect(line.details).not.toMatch(/"/);
        if (want) expect(line.details).toMatch(want);
        else expect(line.details).toContain(`password sign-in for ${fingerprint(typed)} refused`);
    });

    test('SuperAdmin break-glass: bad password and success name admin:<id>, not the login', async () => {
        await _enforcedPasswordLogin({}, 'root', 'bad', ctx);
        await _enforcedPasswordLogin({}, 'root', 'good', ctx);
        await flush();
        const texts = mockAudit.map((l) => l.details);
        expect(texts.some((t) => /break-glass sign-in for admin:1 refused/.test(t))).toBe(true);
        expect(texts.some((t) => /SSO enforced\): admin:1$/.test(t))).toBe(true);
        expect(texts.join('\n')).not.toMatch(/\broot\b/);
    });
});

describe('SSO sign-in audit rows carry refs the log page resolves', () => {
    test('admin SSO sign-in rows: admin:<id>, no username; resolvePeople restores the name', async () => {
        const rows = SsoController._internals.ssoAdminAudits(
            { id: 7, username: 'ops.lead' },
            'entra',
            'direct',
            'idp'
        );
        for (const [, details, adminId] of rows) {
            expect(details).toMatch(/admin:7 signed in via SSO/);
            expect(details).not.toContain('ops.lead');
            expect(adminId).toBe(7);
        }
        const [resolved] = await SystemLogModel.resolvePeople([
            { adminId: null, actorRef: null, entityType: 'auth', details: rows[1][1] },
        ]);
        expect(resolved.details).toMatch(/admin:7 \(ops\.lead\) signed in via SSO/);
    });

    test('an employee ref written by the SSO door is resolved to the person', async () => {
        await _enforcedPasswordLogin({}, 'rhea.marlowe', 'whatever', ctx);
        await flush();
        const line = mockAudit.find((l) => l.action === 'LOGIN_BLOCKED');
        const [resolved] = await SystemLogModel.resolvePeople([
            { entityType: 'auth', details: line.details },
        ]);
        expect(resolved.details).toMatch(/employee:55 \(Rhea MARLOWE\)/);
    });
});
