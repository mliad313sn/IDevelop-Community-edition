'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/correctness]: « Les actes de continuité et
 * de LMS d'un MANAGER sont attribués au compte intégré "admin" (#1) :
 * propriétaire, nominateur, décideur ».
 *
 * Both routers carried their own `actorAdminId(user)`:
 *
 *     if (isAdmin(user)) return user.id;
 *     return (await db.get("SELECT id FROM admins WHERE username = 'admin'")).id;
 *
 * A supervisor or manager is an EMPLOYEE, so every one of them took the second
 * branch. Columns whose entire purpose is to say WHO acted —
 * succession_plans.owner_admin_id, the course→skill mapper, an enrolment's
 * assigned_by — came back naming the system administrator. An operator reading
 * the plan a year later is told something untrue by the one field they would
 * trust for it, and the person who actually acted is gone.
 *
 * The columns are foreign keys onto admins(id), so an employee id genuinely
 * cannot be written there. That is a reason to record NOBODY, not a reason to
 * record the wrong somebody — the project's own arbitration, applied elsewhere
 * already: prefer NULL to a false attribution. Where the person DOES have a
 * linked admin account, that account is genuinely them and is used.
 *
 * The real actor is never lost either way: LogService records actorRef on
 * every one of these routes.
 *
 * PROVEN BY EXECUTION on the dev database in a rolled-back transaction
 * (scratchpad/probe-actor-attribution.js, 7/7), including that a DEACTIVATED
 * linked account is not used.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const { actorAdminId } = require('../../src/utils/actorAdminId');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
});

describe('who gets recorded as having acted', () => {
    test('an admin is recorded as themselves', async () => {
        expect(await actorAdminId({ id: 7, userType: 'admin' })).toBe(7);
        // …without a lookup: they already are an admin.
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('a manager with a linked admin account is recorded as that account', async () => {
        mockDb.get.mockResolvedValue({ id: 99 });
        expect(await actorAdminId({ id: 42, userType: 'manager' })).toBe(99);
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(String(sql)).toMatch(/linked_employee_id = \?/);
        expect(String(sql)).toMatch(/is_active = true/);
        expect(params[0]).toBe(42);
    });

    // The built-in account EXISTS and is findable — that is the whole point.
    // A mock that answers null to every query cannot tell "no fallback" apart
    // from "fell back and found nothing", and a reinstated fallback slipped
    // straight through it. Route by SQL so the wrong answer is available to be
    // returned, and assert it is not.
    const BUILTIN = 1;
    const withBuiltinPresent = () =>
        mockDb.get.mockImplementation(async (sql) =>
            /username = 'admin'/.test(String(sql)) ? { id: BUILTIN } : null
        );

    test('a manager with NO linked account is recorded as NOBODY', async () => {
        withBuiltinPresent();
        const who = await actorAdminId({ id: 42, userType: 'manager' });
        expect(who).toBeNull();
        expect(who).not.toBe(BUILTIN);
    });

    test('an employee is treated the same way', async () => {
        withBuiltinPresent();
        expect(await actorAdminId({ id: 8, userType: 'employee' })).toBeNull();
    });

    test('the built-in account is never even looked up', async () => {
        withBuiltinPresent();
        await actorAdminId({ id: 42, userType: 'manager' });
        const asked = mockDb.get.mock.calls.map((c) => String(c[0]));
        expect(asked.some((s) => /username = 'admin'/.test(s))).toBe(false);
    });

    test('a missing user never throws', async () => {
        expect(await actorAdminId(null)).toBeNull();
        expect(await actorAdminId({})).toBeNull();
    });

    test('a database failure yields NULL, not a wrong id', async () => {
        mockDb.get.mockRejectedValue(new Error('boom'));
        expect(await actorAdminId({ id: 42, userType: 'manager' })).toBeNull();
    });
});

describe('the built-in admin fallback is gone from the routers', () => {
    test.each(['src/routes/v2-continuity.js', 'src/routes/v2-lms.js'])(
        '%s no longer resolves to the built-in account',
        (file) => {
            const src = read(file);
            expect(src).not.toMatch(/SELECT id FROM admins WHERE username = 'admin'/);
            expect(src).toMatch(/require\('\.\.\/utils\/actorAdminId'\)/);
        }
    );

    test.each(['src/routes/v2-continuity.js', 'src/routes/v2-lms.js'])(
        '%s keeps no second local copy of the helper',
        (file) => {
            // Two spellings of "who acted" is how the two drift apart.
            expect(read(file)).not.toMatch(/async function actorAdminId\(/);
        }
    );
});
