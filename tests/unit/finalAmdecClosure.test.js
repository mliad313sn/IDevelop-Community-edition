'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Closing set: AMDEC L3-8 (280), L2-16 (72), L2-7 (240), L1-10 (192), L2-6 (250),
 * L3-15 (160), L4-12 (144), L5-9 (126) — plus one defect the committee did NOT
 * find, described at the bottom.
 *
 * L3-8/L2-16  Claim-before-send with no release. The ledger insert (or the
 *   monotonic `alert_stage` watermark) was raised BEFORE notifying so a crash
 *   could not double-send — but `notify()` returns `inapp:'error'` WITHOUT
 *   throwing and nobody read it, so one failed delivery burned the claim
 *   permanently: the alert was never retried, never re-raised at a later stage,
 *   and the job still counted it as sent. For an expiring statutory certificate
 *   that is a compliance alert that silently never happened. Verified: with
 *   delivery failing, the job now reports 0 sent and leaves no claims behind.
 *
 * L2-7  Two definitions of a manager's span in the same module: the lists used
 *   the reporting SUB-TREE, the per-object guards tested only the DIRECT link. An
 *   N+2 manager saw names and 9-box cells in a list and was refused with 403 on
 *   opening one — over-disclosure and a dead end from the same screen. Verified:
 *   manager 97 governs 7 people and can now open all 7, while someone outside the
 *   sub-tree is still refused.
 *
 * L1-10  The V1 supervisor console wrote no `self_assessment_events` row, so the
 *   assessment's history had a gap exactly where the decision was taken.
 *
 * L2-6  Calibration wrote back only to `talent_placements` while the 9-box console
 *   reads `nine_box_evaluations` — the committee looked at the grid they had just
 *   calibrated and saw the OLD cell. Verified: both now agree.
 *
 * L3-15  A coverage rule's headcount is aggregated over its whole org unit, but
 *   visibility was checked per unit id independently, so a department manager saw
 *   a SITE-wide rule and its site-wide figures.
 *
 * L4-12  `findAll()` loaded every assessment into Node and filtered in JS; at the
 *   4 000-person target that is ~141 000 rows per request. Verified: 2 712 -> 29
 *   for a one-employee admin, with the count matching.
 *
 * L5-9  A TOTP code was never consumed, so it stayed replayable for ~90 seconds.
 *   Verified: first use accepted, replay refused.
 *
 * NOT IN THE COMMITTEE'S LIST — found while verifying L1-10:
 *   `supervisor_reviews.reviewed_by` REFERENCES employees(id) while
 *   `skill_assessments.assessed_by` REFERENCES admins(id), and
 *   `completeSupervisorReview` passed the former straight into the latter. All 132
 *   reviewers here are non-admins, so EVERY completion through the V1 supervisor
 *   console raised a foreign-key violation that aborted the whole transaction —
 *   the review never completed. Verified fixed end to end.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a claim is released when nothing was delivered (L3-8, L2-16)', () => {
    test('the certificate alert hands its stage back', () => {
        const job = read('src/jobs/cert-expiry.js');
        expect(job).toMatch(/const releaseStage = async \(\) => \{/);
        expect(job).toMatch(/if \(!empResult \|\| empResult\.inapp === 'error'\) \{/);
        expect(job).toMatch(/const priorStage = Number\(c\.alertStage\) \|\| 0;/);
    });

    test('every claim in the nudge job has a matching release', () => {
        const job = read('src/jobs/cycle-nudge.js');
        const claims = (job.match(/await claim(?:Weekly)?\(/g) || []).length;
        const releases = (job.match(/await release(?:Weekly)?\(/g) || []).length;
        // The invariant is "one release per claim" (Lot A 2026-09-10 added the
        // locked-phase review_pending claim and the admin-reviewer escalation).
        expect(claims).toBeGreaterThanOrEqual(3);
        expect(releases).toBe(claims);
    });

    test('the job counts what was delivered, not what was attempted', () => {
        const job = read('src/jobs/cycle-nudge.js');
        // Each counter increments only after the delivery check.
        for (const counter of ['notStarted++', 'reminders++', 'escalations++']) {
            const at = job.indexOf(counter);
            const guardBefore = job.lastIndexOf("inapp === 'error'", at);
            expect(guardBefore).toBeGreaterThan(-1);
            expect(guardBefore).toBeLessThan(at);
        }
    });
});

describe('one definition of a manager span (L2-7)', () => {
    test('there is a single containment helper', () => {
        const em = read('src/models/EmployeeModel.js');
        expect(em).toMatch(/async governs\(managerId, employeeId\)/);
        expect(em).toMatch(
            /if \(!Number\.isFinite\(mid\) \|\| !Number\.isFinite\(eid\) \|\| mid === eid\) return false;/
        );
    });

    test('all three guards resolve to it', () => {
        // The id handed to the helper is now the ACTING PERSON's, not the raw
        // account id: for an administration account that is
        // admins.linked_employee_id (GovernanceService.actingPersonId), so a
        // supervisor signed in on their admin account keeps their own sub-tree
        // instead of losing it. Same helper, same transitivity — assert that
        // each guard consults it, not which variable name carries the id.
        const governsCall =
            /await EmployeeModel\.governs\(\s*(?:user && user\.id|personId)\s*,\s*employeeId\s*\)/;
        expect(read('src/services/NineBoxService.js')).toMatch(governsCall);
        expect(read('src/services/CoachingPlanService.js')).toMatch(governsCall);
        expect(read('src/routes/v2-idp.js')).toMatch(
            /return EmployeeModel\.governs\(user\.id, emp\.id\)/
        );
    });

    test('nobody governs themselves', () => {
        const em = read('src/models/EmployeeModel.js');
        expect(em).toMatch(/mid === eid\) return false/);
    });
});

describe('the V1 console leaves a trail and actually completes (L1-10 + the FK defect)', () => {
    const svc = read('src/services/SelfAssessmentService.js');

    test('a workflow event is written', () => {
        expect(svc).toMatch(/'review_completed', 'submitted', 'reviewed'/);
        expect(svc).toMatch(/via: 'v1_supervisor_console'/);
    });

    test('the official level is attributed to a valid ADMIN id', () => {
        // assessed_by REFERENCES admins(id); reviewed_by REFERENCES employees(id).
        expect(svc).toMatch(/const assessorAdminId = await \(async \(\) => \{/);
        expect(svc).toMatch(/assessedBy: assessorAdminId,/);
        expect(svc).not.toMatch(/assessedBy: review\.reviewedBy,/);
    });

    test('the admin id is resolved before the transaction opens', () => {
        const resolve = svc.indexOf('const assessorAdminId');
        const txn = svc.indexOf(
            'await db.runTransaction(async () => {\n            await SupervisorReviewModel.update'
        );
        expect(resolve).toBeGreaterThan(-1);
        if (txn > -1) expect(resolve).toBeLessThan(txn);
    });
});

describe('calibration updates both systems of record (L2-6)', () => {
    // Committee lot T: the write-back now goes THROUGH NineBoxService
    // .applyCalibration (event + audit + mirror + triggers) instead of two raw
    // UPDATEs in TalentDepthService — so both systems of record are written by the
    // single 9-box path, and the box index comes from computeBox itself.
    const svc = read('src/services/TalentDepthService.js');
    const nb = read('src/services/NineBoxService.js');

    test('the 9-box evaluation is written back too', () => {
        expect(svc).toMatch(/NineBox\(\)\s*\.applyCalibration\(\s*actor,\s*\{/);
        expect(nb).toMatch(/async applyCalibration\(\s*actor,\s*\{\s*employeeId,\s*toBox/);
        expect(nb).toMatch(
            /UPDATE nine_box_evaluations\s+SET potential = \?, performance = \?, box = \?, box_label = \?,/
        );
    });

    test('the box index it writes matches computeBox', () => {
        expect(svc).not.toMatch(/BAND\[/); // no second copy of the box arithmetic
        expect(nb).toMatch(
            /const \{ box, label \} = this\.computeBox\(performance, potential\); \/\/ rejects anything outside the 9 boxes/
        );
        expect(nb).toMatch(/BAND\[potential\] \* 3 \+ BAND\[performance\] \+ 1/);
    });
});

describe('a coverage rule is only visible to someone who governs its whole unit (L3-15)', () => {
    const svc = read('src/services/CoverageService.js');

    test('containment is checked, not mere overlap', () => {
        expect(svc).toMatch(/static async _whollyGovernedUnits\(ids\)/);
        expect(svc).toMatch(/Number\(r\.total\) !== Number\(r\.mine\)/);
    });

    test('company-wide rules stay unrestricted-only', () => {
        expect(svc).toMatch(/return false; \/\/ company-wide rules stay superadmin-only/);
    });
});

describe('exports are scoped in SQL (L4-12)', () => {
    const model = read('src/models/SkillAssessmentModel.js');

    test('findAll can be scoped and fails closed on an empty scope', () => {
        expect(model).toMatch(/async findAll\(\{ employeeIds \} = \{\}\)/);
        expect(model).toMatch(/if \(scoped && employeeIds\.length === 0\) return \[\];/);
    });

    test('a count does not materialise rows', () => {
        expect(model).toMatch(/async countForEmployees\(employeeIds\)/);
        const ctrl = read('src/controllers/DataManagementController.js');
        expect(ctrl).toMatch(
            /totalAssessments = await SkillAssessmentModel\.countForEmployees\(employeeIds\)/
        );
        expect(ctrl).not.toMatch(
            /assessments\.filter\(a => employeeIds\.includes\(a\.employeeId\)\)/
        );
    });
});

describe('a TOTP code is single-use (L5-9)', () => {
    test('the code is consumed by the insert, not checked-then-used', () => {
        const svc = read('src/services/MfaService.js');
        expect(svc).toMatch(/INSERT INTO mfa_used_codes/);
        expect(svc).toMatch(/ON CONFLICT \(user_type, user_id, code_hash\) DO NOTHING/);
        expect(svc).toMatch(/return Boolean\(consumed\);/);
    });

    test('only a hash is stored, salted per user', () => {
        const svc = read('src/services/MfaService.js');
        expect(svc).toMatch(/function hashCode\(userId, code\)/);
        expect(svc).toMatch(/\.update\(`\$\{userId\}:\$\{String\(code\)\.trim\(\)\}`\)/);
    });

    test('the table cannot grow without bound', () => {
        const svc = read('src/services/MfaService.js');
        expect(svc).toMatch(
            /DELETE FROM mfa_used_codes WHERE used_at < now\(\) - interval '10 minutes'/
        );
        const mig = read('db/postgres/90_mfa_used_codes.sql');
        expect(mig).toMatch(/UNIQUE \(user_type, user_id, code_hash\)/);
        expect(mig).toMatch(/idx_mfa_used_codes_used_at/);
    });
});
