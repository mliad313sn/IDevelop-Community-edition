'use strict';
/**
 * IDS ONLY in the audit log; names resolved when the log is READ. Behavioural,
 * mocked database.
 *
 *  - LogService: whatever the caller wrote, the row's own subjects (actor,
 *    person entity, `subjects`) have their full name / login / e-mail replaced
 *    by their ref, and every other e-mail address is masked; hyphenated
 *    identifiers do not throw (the needle regex uses the `u` flag).
 *  - The writers: an employee login, an admin login, an unknown identifier, a
 *    rejected applicant, an HRIS joiner — no name, no login, no address.
 *  - SystemLogModel.resolvePeople: refs become names at read time, an erased
 *    person reads "Erased person #id" (or the caller's localised label), a
 *    failed lookup leaves the refs.
 *  - AuditRetentionService: retention clamped to 1..10 (default 5), keyed
 *    fingerprints, the job gated to once a day and a refused purge surfaced.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockCreate = jest.fn(async () => ({}));
jest.mock('../../src/models/SystemLogModel', () => {
    const real = jest.requireActual('../../src/models/SystemLogModel');
    return { ...real, ENTITY_SYNONYMS: real.ENTITY_SYNONYMS, create: (...a) => mockCreate(...a) };
});

const LogService = require('../../src/services/LogService');

const PEOPLE = {
    employee: {
        84: {
            first_name: 'Nadia',
            last_name: 'FENWICK',
            email: 'n.fenwick@stonebridge.example',
            username: 'nfenwick',
        },
    },
    admin: { 3: { username: 'okeller', email: 'o.keller@stonebridge.example' } },
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    LogService._identCache.clear();
    mockDb.get.mockImplementation(async (sql, params) => {
        const id = Number(params && params[0]);
        if (/FROM employees WHERE id = \?/.test(sql)) return PEOPLE.employee[id] || undefined;
        if (/FROM admins WHERE id = \?/.test(sql)) return PEOPLE.admin[id] || undefined;
        return undefined;
    });
});

const written = () => mockCreate.mock.calls.map((c) => c[0]);

describe('LogService — ids only, whatever the caller wrote', () => {
    test("an employee's name, login and e-mail become their ref; other addresses are masked", async () => {
        await LogService.log({
            action: 'X',
            entityType: 'employees',
            entityId: 84,
            actorRef: 'employee:84',
            details:
                'Employee logged in: nfenwick (Nadia FENWICK) — FENWICK Nadia, n.fenwick@stonebridge.example, cc boss@corp.example',
        });
        const d = written()[0].details;
        expect(d).not.toMatch(/nadia|fenwick|@/i);
        expect(d).toContain('employee:84');
        expect(d).toContain('[e-mail]');
    });

    test('object details: values scrubbed, keys and non-personal values kept', async () => {
        await LogService.log({
            adminId: 3,
            action: 'ACCESS_REVIEW',
            entityType: 'admin',
            entityId: 3,
            details: { target: 'okeller', reviewedBy: 'OKELLER', decision: 'appropriate', n: 2 },
        });
        expect(written()[0].details).toEqual({
            target: 'admin:3',
            reviewedBy: 'admin:3',
            decision: 'appropriate',
            n: 2,
        });
    });

    test('`subjects` names a person who is neither the actor nor the entity', async () => {
        await LogService.log({
            action: 'HRIS_MOVER_APPLIED',
            entityType: 'hris_sync',
            details: 'nfenwick moved by the connector',
            subjects: ['employee:84'],
        });
        expect(written()[0].details).toBe('employee:84 moved by the connector');
    });

    test('a short or partial token is never mangled (word boundaries, ≥ 3 chars)', async () => {
        PEOPLE.employee[85] = { first_name: 'Al', last_name: 'Bo', email: null, username: 'al' };
        await LogService.log({
            action: 'X',
            actorRef: 'employee:85',
            details: 'Alert: calibration of Albert',
        });
        expect(written()[0].details).toBe('Alert: calibration of Albert');
    });

    test('no database (lookup throws): e-mails are still masked, the row is still written', async () => {
        mockDb.get.mockRejectedValue(new Error('no pool'));
        await LogService.log({
            action: 'X',
            actorRef: 'employee:84',
            details: 'to n.fenwick@stonebridge.example',
        });
        expect(written()[0].details).toBe('to [e-mail]');
    });

    test('hyphenated identifiers are replaced, never thrown on', () => {
        const subjects = [
            { ref: 'employee:42', needles: ['Anne-Marie Lowe', 'EMP-0001', 'a/b-c'] },
        ];
        const out = LogService.scrubDetails(
            { msg: 'Updated Anne-Marie Lowe (EMP-0001), path a/b-c' },
            subjects
        );
        expect(out.msg).toBe('Updated employee:42 (employee:42), path employee:42');
        const inside = LogService.scrubDetails({ msg: 'XEMP-0001 EMP-00012' }, [
            { ref: 'employee:42', needles: ['EMP-0001'] },
        ]);
        expect(inside.msg).toBe('XEMP-0001 EMP-00012');
    });
});

describe('the writers', () => {
    test('employee login success writes no name and no login', async () => {
        // The central scrub cannot help here (no lookup): the WRITER itself
        // must pass ids only.
        mockDb.get.mockRejectedValue(new Error('no lookup'));
        const EmployeeModel = require('../../src/models/EmployeeModel');
        const bcrypt = require('bcrypt');
        const emp = {
            id: 84,
            username: 'nfenwick',
            firstName: 'Nadia',
            lastName: 'FENWICK',
            isAccountActive: true,
            passwordHash: 'h',
        };
        jest.spyOn(EmployeeModel, 'findByUsername').mockResolvedValue(emp);
        jest.spyOn(EmployeeModel, 'update').mockResolvedValue({});
        jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        const req = { ip: '10.0.0.1', get: () => 'ua' };
        const out = await EmployeeAuthService.login('nfenwick', 'pw', req);
        expect(out.success).toBe(true);
        const row = written().find((r) => r.action === 'EMPLOYEE_LOGIN_SUCCESS');
        expect(row).toBeTruthy();
        expect(JSON.stringify(row)).not.toMatch(/nadia|fenwick/i);
        expect(row.actorRef).toBe('employee:84');
    });

    test('an unknown identifier is fingerprinted, never stored as typed', async () => {
        const EmployeeModel = require('../../src/models/EmployeeModel');
        const AdminModel = require('../../src/models/AdminModel');
        jest.spyOn(EmployeeModel, 'findByUsername').mockResolvedValue(null);
        jest.spyOn(AdminModel, 'findByUsername').mockResolvedValue(null);
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        await EmployeeAuthService.login('sam.typo', 'pw', { ip: '10.0.0.1', get: () => 'ua' });
        const row = written().find((r) => r.action === 'EMPLOYEE_LOGIN_FAILED');
        expect(row.details).not.toMatch(/sam\.typo/);
        expect(row.details).toMatch(/fp:[0-9a-f]{10}/);
        // the same identifier → the same fingerprint (correlation survives)
        const A = require('../../src/services/AuditRetentionService');
        expect(A.fingerprint('Sam.Typo ')).toBe(A.fingerprint('sam.typo'));
    });

    test('admin login success names the admin by id only', async () => {
        const AdminModel = require('../../src/models/AdminModel');
        const bcrypt = require('bcrypt');
        jest.spyOn(AdminModel, 'findByUsername').mockResolvedValue({
            id: 3,
            username: 'okeller',
            isActive: true,
            passwordHash: 'h',
        });
        jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        const AuthService = require('../../src/services/AuthService');
        const out = await AuthService.login('okeller', 'pw', { ip: '10.0.0.1', get: () => 'ua' });
        expect(out.success).toBe(true);
        const row = written().find((r) => r.action === 'LOGIN_SUCCESS');
        expect(row.details).toBe('Admin #3 logged in');
    });

    test('a rejected applicant: no address and no note in the log', async () => {
        const OnboardingRequestModel = require('../../src/models/OnboardingRequestModel');
        jest.spyOn(OnboardingRequestModel, 'findById').mockResolvedValue({
            id: 12,
            email: 'applicant@mail.example',
            status: 'pending',
            firstName: 'Iris',
            lastName: 'QUANTRELL',
        });
        jest.spyOn(OnboardingRequestModel, 'update').mockResolvedValue({});
        const OnboardingService = require('../../src/services/OnboardingService');
        await OnboardingService.reject(12, 'Iris QUANTRELL applied twice', 3).catch(() => {});
        const row = written().find((r) => r.action === 'ONBOARDING_REJECTED');
        expect(row).toBeTruthy();
        expect(JSON.stringify(row)).not.toMatch(/applicant@|iris|quantrell/i);
        expect(row.details).toMatch(/#12/);
    });

    test('a campaign line names its actor by ref', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', '..', 'src', 'services', 'CycleService.js'),
            'utf8'
        );
        const fn = src.slice(
            src.indexOf('function actorLabel('),
            src.indexOf('async function audit(')
        );
        expect(fn).toMatch(/return `\$\{type\}:\$\{actor\.id\}`/);
        expect(fn).not.toMatch(/username|firstName|lastName|displayName/);
    });
});

describe('SystemLogModel.resolvePeople — names at read time', () => {
    const Model = jest.requireActual('../../src/models/SystemLogModel');
    test('refs become names; an erased person reads "Erased person #id"; export fields filled', async () => {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM employees/.test(sql))
                return [
                    { id: 84, firstName: 'Nadia', lastName: 'FENWICK', erasedAt: null },
                    { id: 90, firstName: 'Erased', lastName: '90', erasedAt: '2026-09-01' },
                ];
            if (/FROM admins/.test(sql))
                return [{ id: 3, username: 'okeller', linkedEmployeeId: null }];
            return [];
        });
        const rows = await Model.resolvePeople([
            { id: 1, actorRef: 'employee:84', details: 'Employee #84 logged in', username: null },
            {
                id: 2,
                adminId: 3,
                username: 'okeller',
                entityType: 'employee',
                entityId: 90,
                details: 'erased employee:90',
            },
            { id: 3, actorRef: 'manager:90', details: { who: 'employee:84' } },
        ]);
        expect(rows[0].username).toBe('Nadia FENWICK');
        expect(rows[1].subjectErasedId).toBe(90);
        expect(rows[1].details).toBe('erased employee:90 (Erased person #90)');
        expect(rows[2].actorErasedId).toBe(90);
        expect(rows[2].username).toBe('Erased person #90');
        expect(rows[2].details).toEqual({ who: 'employee:84 (Nadia FENWICK)' });
    });

    test("the reader's language words an erased person", async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM employees/.test(sql)
                ? [{ id: 90, firstName: 'Erased', lastName: '90', erasedAt: '2026-09-01' }]
                : []
        );
        const [row] = await Model.resolvePeople([{ id: 1, actorRef: 'employee:90' }], {
            erasedLabel: (id) => `Personne effacée #${id}`,
        });
        expect(row.username).toBe('Personne effacée #90');
    });

    test('a campaign line written "by admin:1" is READ as "by admin:1 (admin)"', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM admins/.test(sql) ? [{ id: 1, username: 'admin', linkedEmployeeId: null }] : []
        );
        const [row] = await Model.resolvePeople([
            { id: 9, adminId: 1, details: 'Cycle #9 — participant excused — by admin:1' },
        ]);
        expect(row.details).toBe('Cycle #9 — participant excused — by admin:1 (admin)');
        expect(row.username).toBe('admin');
    });

    test('a failed lookup leaves the rows exactly as stored (never a wrong name)', async () => {
        mockDb.all.mockRejectedValue(new Error('down'));
        const input = [{ id: 1, actorRef: 'employee:84', details: 'x employee:84' }];
        expect(await Model.resolvePeople(input)).toBe(input);
    });
});

describe('AuditRetentionService', () => {
    const A = require('../../src/services/AuditRetentionService');
    test('retention clamped to 1..10, default 5', () => {
        expect(A.clampYears('')).toBe(5);
        expect(A.clampYears(null)).toBe(5);
        expect(A.clampYears('abc')).toBe(5);
        expect(A.clampYears(0)).toBe(1);
        expect(A.clampYears(25)).toBe(10);
        expect(A.clampYears('7')).toBe(7);
    });

    test('the fingerprint is keyed: another secret gives another fingerprint', () => {
        const saved = process.env.SESSION_SECRET;
        try {
            process.env.SESSION_SECRET = 'one-secret';
            const a = A.fingerprint('someone@mail.example');
            process.env.SESSION_SECRET = 'another-secret';
            const b = A.fingerprint('someone@mail.example');
            expect(a).toMatch(/^fp:[0-9a-f]{10}$/);
            expect(a).not.toBe(b);
            const plain = require('crypto')
                .createHash('sha256')
                .update('someone@mail.example')
                .digest('hex')
                .slice(0, 10);
            expect(b).not.toBe(`fp:${plain}`);
        } finally {
            if (saved === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = saved;
        }
        expect(A.fingerprint('')).toBe('fp:none');
    });

    test('the job runs once a day and re-throws a refused purge after sealing', async () => {
        const now = new Date('2031-03-02T10:00:00');
        mockDb.get.mockImplementation(async (sql) => {
            if (/fn_system_logs_seal/.test(sql)) return { n: 1 };
            if (/fn_system_logs_purge/.test(sql))
                throw new Error('AUDIT_PURGE_REFUSED: the audit chain does not verify');
            return undefined;
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(A.tick({ now })).rejects.toThrow(/AUDIT_PURGE_REFUSED/);
        expect((await A.tick({ now })).skipped).toBe('already_today');
        const sealCalls = mockDb.get.mock.calls.filter((c) => /fn_system_logs_seal/.test(c[0]));
        expect(sealCalls.length).toBe(1);
    });

    test('redaction failure fails the erasure (fail closed)', async () => {
        mockDb.get.mockRejectedValue(new Error('function fn_system_logs_redact does not exist'));
        await expect(A.redactErasedSubject(84, ['Nadia FENWICK'])).rejects.toMatchObject({
            code: 'audit_redaction_failed',
        });
    });

    test('verify() flattens the broken lists into brokenAt', async () => {
        mockDb.get.mockResolvedValue({
            v: {
                intact: false,
                hashedRows: 10,
                broken: { content: [7], link: [9], fork: [], seal: [7] },
            },
        });
        const v = await A.verify(5);
        expect(v.intact).toBe(false);
        expect(v.brokenAt).toEqual([7, 9]);
    });
});

describe('the audit-log path is closed to the SQL console', () => {
    const svc = require('../../src/services/SqlConsoleService');
    test.each([
        "SET LOCAL idevelop.audit_path = 'redact'",
        "set idevelop.audit_redaction_entry = '12'",
        'SELECT fn_system_logs_purge(1)',
        "SELECT public._fn_system_logs_redact_flush(1, null, null, '[]', '[]')",
        "select public.fn_system_logs_redact(1, ARRAY['x'])",
    ])('%s is refused', (sql) => {
        expect(svc._auditTamperViolation([sql])).toMatch(/redaction and purge/);
    });
    test('the verifier stays callable (read-only)', () => {
        expect(svc._auditTamperViolation(['SELECT fn_system_logs_verify(5)'])).toBeFalsy();
    });
});
