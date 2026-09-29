'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * L2 auto-finalisation could never promote a rating.
 *
 * When the SLA expires with no HR decision, `autoFinalizeOverdueL2` finalises the
 * dispute and flows the decided rating to the official skill profile. It called
 * `_applyDecidedRatingToSkill(reviewId, rating, null)` — no human actor, because
 * the finalisation is automatic — and that null reached
 * `skill_assessments.assessed_by`, which is NOT NULL.
 *
 * Reproduced (fix reverted), on a review that carries a rating:
 *
 *   threw: null value in column "assessed_by" of relation "skill_assessments"
 *          violates not-null constraint
 *   OUTER ERROR: current transaction is aborted, commands ignored...
 *
 * Two consequences, both silent:
 *   - the dispute stayed at L2/escalated for ever, the employee still waiting;
 *   - the throw propagated out of the method and aborted the REST of that
 *     dispute-escalator pass, so unrelated disputes were skipped too.
 *
 * It appeared to work only when the review carried NO rating — i.e. when there
 * was nothing to promote and the helper returned early.
 *
 * After the fix, same probe:
 *   autoFinalizeOverdueL2 result: 1 · threw: null
 *   dispute state after: {"state":"auto_finalized","decidedRating":0}
 *   official skill row: {"lvl":0,"by":"1"}
 *
 * The attribution is resolved exactly as SelfAssessmentWorkflowService does for
 * the identical case, so the two promotion paths cannot drift apart.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const svc = read('src/services/DisputeServiceV2.js');

describe('an automatic finalisation still has a valid attribution', () => {
    test('a system admin is resolved when no human decided', () => {
        expect(svc).toMatch(/let assessedBy = decidedBy \|\| null;/);
        expect(svc).toMatch(
            /SELECT id FROM admins WHERE username = 'admin' AND is_active = true LIMIT 1/
        );
        expect(svc).toMatch(/SELECT id FROM admins ORDER BY id LIMIT 1/);
    });

    test('the null is never handed to the NOT NULL column', () => {
        expect(svc).not.toMatch(/assessedBy: decidedBy \|\| null/);
        expect(svc).toMatch(/assessedBy,\s*\n\s*notes: 'Set by dispute resolution/);
    });

    test('an unattributable promotion is skipped, never allowed to throw', () => {
        expect(svc).toMatch(/if \(!assessedBy\) return;/);
    });

    test('the resolution matches the sibling service, so the two cannot drift', () => {
        const wf = read('src/services/SelfAssessmentWorkflowService.js');
        for (const q of [
            "SELECT id FROM admins WHERE username = 'admin' AND is_active = true LIMIT 1",
            'SELECT id FROM admins ORDER BY id LIMIT 1',
        ]) {
            expect(svc).toContain(q);
            expect(wf).toContain(q);
        }
    });

    test('why it failed is recorded, including the constraint', () => {
        expect(svc).toMatch(/NOT NULL/);
        expect(svc).toMatch(/aborted the rest of that dispute-escalator pass/);
    });
});

/**
 * The HUMAN paths had the same hole one step further along, and it WAS reachable.
 *
 * `resolveL0`/`resolveL1` pass `decidedBy = req.user.id`. Their route guard is
 * `requireManager`, which admits ONLY `userType === 'manager'` — so that id is
 * always an EMPLOYEE id. It is correct for `assessment_disputes.decided_by`
 * (FK -> employees) but NOT for `skill_assessments.assessed_by` (FK -> admins),
 * which is where the decided rating gets promoted. And the dispute screen
 * REQUIRES a 0-4 rating before it will submit, so every "Resolve" click took the
 * failing path. An id that is not a real admin must be treated as no id at all.
 *
 * Measured after the fix, in rolled-back transactions:
 *   L0 resolved by supervisor 136 -> state resolved, skill promoted, assessed_by 1
 *   L1 resolved by manager    137 -> state resolved, skill promoted, assessed_by 1
 *
 * NOT a defect, and deliberately not "fixed": an ADMIN cannot resolve L0/L1 at
 * all — `requireManager` refuses them — so the admin-id-into-decided_by case is
 * unreachable through the product. L2 is the admin path and correctly writes the
 * separate `decided_by_admin_id` column (FK -> admins), gated by `canArbitrate`,
 * which requires `userType === 'admin'`. The two-column design is coherent; only
 * the promotion helper needed to defend itself.
 */
describe('a human decider who is not an admin still promotes the rating', () => {
    test('an id that is not a real admin is treated as no id at all', () => {
        expect(svc).toMatch(
            /const isAdmin = await db\.get\('SELECT id FROM admins WHERE id = \?', \[assessedBy\]\)/
        );
        expect(svc).toMatch(/if \(!isAdmin\) assessedBy = null;/);
    });

    test('the check runs BEFORE the system-admin fallback, so the fallback catches it', () => {
        const check = svc.indexOf('if (!isAdmin) assessedBy = null;');
        const fallback = svc.indexOf(
            "SELECT id FROM admins WHERE username = 'admin' AND is_active = true LIMIT 1"
        );
        expect(check).toBeGreaterThan(-1);
        expect(fallback).toBeGreaterThan(check);
    });

    test('the reachable failure is recorded, including which FK it violated', () => {
        expect(svc).toMatch(/skill_assessments_assessed_by_fkey/);
        expect(svc).toMatch(/REQUIRES a rating/);
    });
});

describe('every promotion call site passes an attribution it can defend', () => {
    // The assertion is about WHICH attribution each call site passes, not about
    // how the file is wrapped: the formatter splits a long call over several
    // lines, so the argument list is matched across whitespace.
    const call = (args) =>
        new RegExp('_applyDecidedRatingToSkill\\(\\s*' + args.join(',\\s*') + ',?\\s*\\)');

    // Every call site also names the DISPUTE (fourth argument) so a withheld
    // promotion on a replaced round can be traced on the dispute itself.
    test('the automatic path passes null deliberately and lets the helper resolve it', () => {
        // The L2 SLA path has no actor by definition; the helper — not the call
        // site — is where that is handled, so every caller behaves the same.
        expect(svc).toMatch(call(['row\\.supervisorReviewId', 'rating', 'null', 'd\\.id']));
    });

    test('the human paths pass the real decider', () => {
        expect(svc).toMatch(
            call(['r\\.supervisorReviewId', 'decidedRating', 'decidedByAdminId', 'disputeId'])
        );
        expect(svc).toMatch(
            call(['r\\.supervisorReviewId', 'decidedRating', 'decidedBy', 'disputeId'])
        );
    });
});
