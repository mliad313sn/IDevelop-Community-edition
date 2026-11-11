'use strict';

/**
 * The MFA enrolment hold is a server signal the layout can read: holdOnSetup
 * marks the session (mfaHoldActive), an allow-listed page (the setup page
 * itself) exposes res.locals.mfaHold, and the first request the gate lets
 * through clears it. The header bell reads it and does not poll
 * /api/notifications and /api/my-actions, which the hold answers 403.
 */
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async () => false),
    mfaUserType: () => 'admin',
    hasFreshEnrolment: () => false,
    rememberEnrolment: () => {},
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (_k, d) => d),
    getAll: jest.fn(async () => ({})),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');

function call(p, session, user) {
    const req = {
        path: p,
        session,
        user,
        isAuthenticated: () => true,
        flash: () => {},
        t: null,
    };
    const out = { next: false, status: null, redirect: null, json: null };
    const res = {
        locals: {},
        status(c) {
            out.status = c;
            return res;
        },
        json(j) {
            out.json = j;
            return res;
        },
        redirect(u) {
            out.redirect = u;
            return res;
        },
    };
    return Promise.resolve(
        enforceMfaEnrollment(req, res, () => {
            out.next = true;
        })
    ).then(() => ({ out, res }));
}

describe('MFA enrolment hold signal', () => {
    const admin = { id: 9, userType: 'admin', role: 'admin', username: 'x' };

    test('held: the API is refused AND the session is marked; the setup page then exposes mfaHold', async () => {
        const session = { mfaEnrolRequired: true };
        const api = await call('/api/notifications', session, admin);
        expect(api.out.status).toBe(403);
        expect(session.mfaHoldActive).toBe(true);
        const page = await call('/v2/uam/mfa/setup', session, admin);
        expect(page.out.next).toBe(true);
        expect(page.res.locals.mfaHold).toBe(true);
    });

    test('a page redirected to setup marks the hold too', async () => {
        const session = { mfaEnrolRequired: true };
        const r = await call('/dashboard', session, admin);
        expect(r.out.redirect).toBe('/v2/uam/mfa/setup');
        expect(session.mfaHoldActive).toBe(true);
    });

    test('released (second factor proven in this session): the next request clears the mark', async () => {
        const session = { mfaEnrolRequired: true, mfaHoldActive: true, mfaVerifiedInSession: true };
        const r = await call('/dashboard', session, admin);
        expect(r.out.next).toBe(true);
        expect(session.mfaHoldActive).toBeUndefined();
        const page = await call('/v2/uam/mfa/manage', session, admin);
        expect(page.res.locals.mfaHold).toBe(false);
    });

    test('an employee (outside the policy) is never marked', async () => {
        const session = {};
        const emp = { id: 84, userType: 'employee' };
        const r = await call('/employee/dashboard', session, emp);
        expect(r.out.next).toBe(true);
        expect(session.mfaHoldActive).toBeUndefined();
        const page = await call('/v2/uam/mfa/setup', session, emp);
        expect(page.res.locals.mfaHold).toBe(false);
    });
});

describe('the header bell during the hold', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../views/partials/header.ejs'), 'utf8');

    test('the bell carries the hold as data, not as script text', () => {
        expect(src).toMatch(
            /data-mfa-hold="<%= \(typeof mfaHold !== 'undefined' && mfaHold\) \? '1' : '0' %>"/
        );
    });

    // Run the bell script with a fake DOM and count the fetches.
    function runBell(held) {
        const scripts = [...src.matchAll(/<script nonce="<%= cspNonce %>">([\s\S]*?)<\/script>/g)];
        const body = scripts
            .map((m) => m[1])
            .find((b) => b.includes('getElementById(id)') && b.includes('loadNotifs(true)'));
        expect(body).toBeTruthy();
        // The EJS include of the strings becomes an empty object here.
        const code = body.replace(/<%-[\s\S]*?%>/g, '{}').replace(/<%=[\s\S]*?%>/g, '');
        const fetched = [];
        const el = () => ({
            getAttribute: (k) =>
                k === 'data-mfa-hold' ? (held ? '1' : '0') : k === 'data-kiosk' ? '0' : null,
            setAttribute: () => {},
            addEventListener: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            style: {},
            textContent: '',
            innerHTML: '',
            hidden: false,
        });
        const window = {
            fetch: (u) => {
                fetched.push(String(u));
                return new Promise(() => {});
            },
            addEventListener: () => {},
        };
        const ctx = {
            window,
            fetch: window.fetch,
            document: {
                getElementById: () => el(),
                addEventListener: () => {},
                visibilityState: 'visible',
                querySelector: () => null,
            },
            setInterval: () => 0,
            setTimeout: () => 0,
            Date,
            JSON,
            Number,
            String,
            encodeURIComponent,
        };
        try {
            vm.runInNewContext(code, ctx);
        } catch (_) {
            /* a missing fake DOM detail after the fetches does not matter here */
        }
        return fetched;
    }

    test('held: no request at all; free: the bell loads', () => {
        expect(runBell(true)).toEqual([]);
        expect(runBell(false).length).toBeGreaterThan(0);
    });
});
