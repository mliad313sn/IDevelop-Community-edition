'use strict';
/**
 * A coaching session is signed by its two parties only, and the signature
 * records the ACCOUNT that was used (coaching_signoffs.actor_ref, migration
 * 177):
 *  - the person coached signs as 'employee';
 *  - the coach signs as 'coach', directly or through the administration
 *    account linked to them; user_id is always the PERSON;
 *  - an administrator who can READ the session but is not its coach (a
 *    SuperAdmin included) is refused with 403, nothing written;
 *  - a role sent in the body is ignored.
 */
const express = require('express');
const request = require('supertest');

function baseDb() {
    return {
        get: jest.fn(async () => undefined),
        all: jest.fn(async () => []),
        run: jest.fn(async () => ({ changes: 1 })),
        runTransaction: jest.fn(async (fn) => fn()),
        runInSavepoint: jest.fn(async (fn) => fn()),
    };
}

describe('only the two parties sign a coaching session', () => {
    let db, signOff;
    const session = { employeeId: 70, coachId: 50 };
    function appAs(user) {
        jest.resetModules();
        db = baseDb();
        db.get.mockResolvedValue(session);
        signOff = jest.fn(async () => {});
        jest.doMock('../../src/config/database', () => db);
        jest.doMock('../../src/middleware/auth', () => ({
            requireAuth: (q, s, n) => n(),
            requireEmployeeOrManager: (q, s, n) => n(),
        }));
        jest.doMock('../../src/services/CoachingService', () => ({ signOff }));
        jest.doMock('../../src/services/RBACService', () => ({
            isViewer: (u) => u.role === 'viewer',
            isSuperAdmin: (u) => u.role === 'superadmin',
            getFilteredEmployees: async () => [{ id: 70 }],
        }));
        jest.doMock('../../src/services/GovernanceService', () => ({
            // Admin account 4 is linked to the coach (person 50); the others to nobody.
            actingPersonId: async (u) => (u.userType === 'admin' ? (u.id === 4 ? 50 : null) : u.id),
            lineAuthorityEmployeeIds: async () => [],
        }));
        const a = express();
        a.use(express.json());
        a.use((req, _r, n) => {
            req.user = user;
            req.t = (k, o) => (o && o.defaultValue) || k;
            n();
        });
        a.use('/v2/coaching', require('../../src/routes/v2-coaching'));
        return a;
    }

    test.each([
        ['the person coached', { id: 70, userType: 'employee' }, 'employee', 70, 'employee:70'],
        ['the coach', { id: 50, userType: 'manager' }, 'coach', 50, 'employee:50'],
        [
            'the coach through their linked admin account',
            { id: 4, userType: 'admin', role: 'localadmin' },
            'coach',
            50,
            'admin:4',
        ],
    ])('%s signs as %s', async (_l, user, role, uid, ref) => {
        const r = await request(appAs(user))
            .post('/v2/coaching/sessions/3/sign')
            .send({ role: role === 'coach' ? 'employee' : 'coach' });
        expect(r.status).toBe(200);
        expect(signOff).toHaveBeenCalledWith(
            expect.objectContaining({ role, userId: uid, actorRef: ref })
        );
    });

    test.each([
        ['a SuperAdmin who is not the coach', { id: 1, userType: 'admin', role: 'superadmin' }],
        ['an in-scope admin', { id: 2, userType: 'admin', role: 'localadmin' }],
    ])('%s → 403, no signature', async (_l, user) => {
        const r = await request(appAs(user)).post('/v2/coaching/sessions/3/sign').send({});
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/coach of this session/);
        expect(signOff).not.toHaveBeenCalled();
    });

    test('CoachingService.signOff stores actor_ref', async () => {
        jest.resetModules();
        const d = baseDb();
        jest.doMock('../../src/config/database', () => d);
        jest.dontMock('../../src/services/CoachingService');
        const CS = require('../../src/services/CoachingService');
        await CS.signOff({
            sessionId: 3,
            role: 'coach',
            userId: 50,
            ip: '::1',
            ua: 'x',
            actorRef: 'admin:4',
        });
        expect(d.run.mock.calls[0][0]).toMatch(/actor_ref/);
        expect(d.run.mock.calls[0][1]).toEqual([3, 'coach', 50, '::1', 'x', 'admin:4']);
    });

    test('the refusal sentence exists in FR and EN', () => {
        const fr = require('../../locales/fr/coaching.json');
        const en = require('../../locales/en/coaching.json');
        expect(fr.err_sign_parties_only).toBeTruthy();
        expect(en.err_sign_parties_only).toBeTruthy();
        expect(fr.err_sign_parties_only).not.toBe(en.err_sign_parties_only);
    });
});
