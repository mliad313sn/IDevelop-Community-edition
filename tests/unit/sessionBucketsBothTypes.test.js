'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L5-2 (criticality 400) and L5-4 (320) — one person, two session buckets.
 *
 * A session row records the `userType` the person had when they SIGNED IN, because
 * that is what `serializeUser` wrote. `deserializeUser` recomputes the type on every
 * request, so `req.user.userType` is what they are NOW. The two disagree for anyone
 * who governs someone: 20 of the 77 people on this instance are typed 'manager'
 * while `PasswordResetService.resolveSubject` only ever yields 'employee'.
 *
 * Consequences, all silent:
 *   L5-2  "Forgot password" revoked only the 'employee' bucket, so a manager who
 *         reset their password because it was compromised stayed signed in on every
 *         device — with the very password they had just replaced.
 *   L5-4  /account/sessions listed only the current type, so it showed an EMPTY
 *         list while sessions were live, and "sign out my other devices" deleted 0
 *         rows and reported success. The password-change screen states
 *         unconditionally that all other sessions were signed out.
 *
 * Verified against the real `session` store (rolled back): one person with one
 * session in each bucket saw 1 of 2 before, 2 of 2 after, and a reset now clears
 * both.
 *
 * Scoring rationale for L5-2: G=8 (the compromised credential stays usable), O=5,
 * D=10 (the screen confirms success).
 *
 * EmployeeController, DSRService and LifecycleService already revoked both buckets;
 * these three call sites were the ones left behind.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a password reset ends every session, whichever bucket it is in', () => {
    const svc = read('src/services/PasswordResetService.js');

    test('an employee subject also clears the manager bucket', () => {
        expect(svc).toMatch(
            /if \(v\.subjectType === 'employee'\) \{\s*\n\s*await SessionService\.revokeAllForUser\(v\.subjectId, 'manager', null\);/
        );
    });

    test('the original bucket is still revoked', () => {
        expect(svc).toMatch(/revokeAllForUser\(v\.subjectId, v\.subjectType, null\)/);
    });
});

describe('the account screens address both buckets', () => {
    const ctrl = read('src/controllers/AuthController.js');

    test('there is one helper naming the buckets a person can own', () => {
        expect(ctrl).toMatch(
            /function sessionBuckets\(userType\) \{\s*\n\s*return userType === 'admin' \? \['admin'\] : \['employee', 'manager'\];/
        );
    });

    test('the active-sessions list unions them', () => {
        // \s* between the tokens on purpose: prettier wraps a call whose
        // arguments no longer fit, and an assertion that pins the LAYOUT rather
        // than the code goes red on a reformat that changed nothing. Measure the
        // call, not where the line breaks fall.
        expect(ctrl).toMatch(
            /sessionBuckets\(req\.user\.userType\)\.map\(\(t\)\s*=>\s*SessionService\.listForUser\(req\.user\.id,\s*t\)\s*\)/
        );
    });

    test('"sign out other devices" counts across them', () => {
        const revokes =
            ctrl.match(
                /sessionBuckets\(req\.user\.userType\)\.map\(\(t\)\s*=>\s*SessionService\.revokeOthers\(req\.user\.id,\s*t,\s*req\.sessionID\)\s*\)/g
            ) || [];
        // Once for the explicit action, once after a password change.
        expect(revokes.length).toBe(2);
    });

    test('no call site still passes the current userType straight through', () => {
        expect(ctrl).not.toMatch(
            /SessionService\.listForUser\(req\.user\.id, req\.user\.userType\)/
        );
        expect(ctrl).not.toMatch(
            /SessionService\.revokeOthers\(req\.user\.id, req\.user\.userType, req\.sessionID\)/
        );
    });
});
