'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L5-8 (192), L2-11 (180), L2-12 (180), L2-13 (126), L3-13 (144),
 * L3-14 (126) and L5-11 (96).
 *
 * L5-8  The departmental digest sent to an ADMIN went straight through
 *       `EmailService.send`, bypassing `notify()` — so it skipped the recipient's
 *       own "e-mail notifications = NO" setting AND quiet hours, and was never
 *       written to their bell either. An admin who had opted out received it
 *       anyway and could not find it in-app. The employee branch beside it always
 *       went through notify(); the asymmetry was accidental.
 *
 * L2-11 One query in the whole app resolved "the current campaign" with
 *       `ORDER BY closes_at DESC`; six others use ASC. With two cycles open the
 *       9-box mirror wrote into a cycle nobody else considered current, so the
 *       placement vanished from DEI, bias, copilot and Power BI, which all filter
 *       on the cycle the rest of the app agrees on.
 *
 * L2-12 A 35-day "newly at high risk" window against a MONTHLY cadence (28-31
 *       days) re-reported 4-7 days of overlap every time, so the same people
 *       appeared as newly-at-risk in two consecutive briefs and the e-mail
 *       contradicted the application.
 *
 * L2-13 "Critical posts without a successor" counted EVERY role that merely had a
 *       criticality row — score 1 on a 1-5 scale included — inflating the
 *       key-person exposure shown on the dashboard and in the monthly brief. The
 *       Commencer total also added a role that was both without a successor and
 *       overdue for review twice. Verified: with roles seeded at scores 1-4, only
 *       the score-4 one is now reported.
 *
 * L3-13 `coverage_rules.min_level` accepted 1-5 while the competency scale is 0-4,
 *       so a rule at "level >= 5" was a permanent, unsatisfiable critical breach
 *       that no one could ever clear. Verified: the DB now refuses level 5.
 *
 * L3-14 Reverting a joiner deleted that person's blank drafts in EVERY cycle,
 *       including an open campaign unrelated to the correction.
 *
 * L5-11 A POLICY refusal (SSO-only account, expired invitation) was recorded as a
 *       failed authentication, so a user who typed their real password out of
 *       habit five times LOCKED THEIR OWN ACCOUNT for 30 minutes while the log
 *       blamed a login failure. Verified: a correct password on an SSO-only
 *       account is now exempt, a wrong guess is still counted.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the digest respects the recipient preferences (L5-8)', () => {
    const job = read('src/jobs/dept-digest.js');
    // Whitespace-normalised: the pre-commit hook (prettier) reflows object
    // properties across lines, so pin the logic, not the layout.
    const jobFlat = job.replace(/\s+/g, ' ');

    test('an admin subscriber goes through notify(), like an employee does', () => {
        expect(job).toMatch(/} else if \(adminId\) \{/);
        expect(jobFlat).toMatch(/userType: 'admin', userId: adminId,/);
    });

    test('adminId is actually resolved', () => {
        expect(jobFlat).toMatch(
            /name = a\.username; email = a\.email; adminId = sub\.subscriberId;/
        );
    });

    test('the direct-email path remains only as a last resort', () => {
        // Kept for a subscriber that is neither, rather than being the admin route.
        const adminBranch = job.indexOf('} else if (adminId) {');
        const emailBranch = job.indexOf('} else if (email) {');
        expect(adminBranch).toBeGreaterThan(-1);
        expect(emailBranch).toBeGreaterThan(adminBranch);
    });
});

describe('one definition of "the current campaign" (L2-11)', () => {
    test('no query orders it DESC any more', () => {
        const nb = read('src/services/NineBoxService.js');
        expect(nb).not.toMatch(/status = 'open' ORDER BY closes_at DESC/);
        expect(nb).toMatch(/WHERE status = 'open' ORDER BY closes_at LIMIT 1/);
    });
});

describe('the brief window cannot span two sends (L2-12)', () => {
    test('the window is at most the shortest month', () => {
        const job = read('src/jobs/planning-digest.js');
        expect(job).toMatch(/const NEWLY_HIGH_DAYS = 28;/);
    });
});

describe('"critical" means the top of the scale (L2-13)', () => {
    // Whitespace-normalised: the pre-commit hook runs prettier over staged JS,
    // so an unrelated edit elsewhere in the file can reflow either of these
    // across lines. Both assertions below went red that way without the logic
    // changing at all. Pin the logic, not the layout.
    const svc = read('src/services/ContinuityService.js').replace(/\s+/g, ' ');

    test('there is an explicit threshold', () => {
        expect(svc).toMatch(/static get CRITICAL_SCORE_MIN\(\) \{ return 4; \}/);
        expect(svc).toMatch(
            /WHERE rc\.criticality_score >= \$\{ContinuityService\.CRITICAL_SCORE_MIN\}/
        );
    });

    test('the getting-started total counts each role once', () => {
        expect(svc).toMatch(/total: needCriticalityTotal \+ new Set\(\[/);
    });
});

describe('a coverage rule must be reachable (L3-13)', () => {
    test('the service clamps to the real scale', () => {
        const svc = read('src/services/CoverageService.js');
        expect(svc).toMatch(/const COVERAGE_LEVEL_MAX = 4;/);
        expect(svc).toMatch(/function clampCoverageLevel\(v\)/);
        expect(svc).not.toMatch(/Math\.min\(Math\.max\(parseInt\(minLevel, 10\) \|\| 1, 1\), 5\)/);
    });

    test('the database enforces it too', () => {
        const mig = read('db/postgres/89_coverage_rule_level_scale.sql');
        expect(mig).toMatch(/CHECK \(min_level BETWEEN 1 AND 4\)/);
        expect(mig).toMatch(/UPDATE coverage_rules SET min_level = 4 WHERE min_level > 4/);
    });
});

describe('reverting an arrival stays inside its own campaign (L3-14)', () => {
    test('the delete is bounded by the cycle THE EVENT recorded, not the one open now', () => {
        // SECTION accounts / B3: the old bound was `cycle_id = (SELECT id FROM
        // assessment_cycles WHERE status = 'open' …)` evaluated AT REVERT TIME,
        // so a revert months later hit whichever campaign happened to be open.
        // The behavioural assertions live in tests/unit/lifecycleRevertScoping.test.js.
        const svc = read('src/services/LifecycleService.js');
        expect(svc).toMatch(/AND cycle_id = \?/);
        expect(svc).toMatch(/\[ev\.employeeId, originCycleId\]/);
        expect(svc).not.toMatch(/AND cycle_id = \(SELECT id FROM assessment_cycles/);
    });
});

describe('a policy refusal is not a failed password (L5-11)', () => {
    test('the refusals are marked', () => {
        expect(read('src/services/AuthService.js')).toMatch(
            /success: false,\s*policyRefusal: true/
        );
        const emp = read('src/services/EmployeeAuthService.js');
        expect((emp.match(/policyRefusal: true/g) || []).length).toBe(3); // SSO-only + expired invitation + shared e-mail (migration 107)
    });

    test('the middleware does not count them toward lockout', () => {
        const mw = read('src/middleware/auth.js');
        expect(mw).toMatch(
            /if \(!policyRefusal\) await recordLoginAttempt\(username, ctx\.ip, false\);/
        );
    });

    test('the message stays generic, so accounts are not enumerable', () => {
        const mw = read('src/middleware/auth.js');
        expect(mw).toMatch(/return done\(null, false, \{ message: 'Invalid credentials' \}\);/);
    });

    test('the exemption applies only AFTER the password verifies', () => {
        // A wrong guess on an SSO-only account is a real brute-force signal and
        // must still count; only the habitual correct password is exempt.
        const emp = read('src/services/EmployeeAuthService.js');
        const compare = emp.indexOf('bcrypt.compare(password, employee.passwordHash)');
        const policy = emp.indexOf('employee.passwordDisabled === true');
        expect(compare).toBeGreaterThan(-1);
        expect(policy).toBeGreaterThan(compare);
    });
});
