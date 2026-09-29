'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The official skill profile must never record the employee's OWN rating in
 * place of a rating a supervisor validated.
 *
 * `approve()` passes the reviewer's level explicitly and was correct. But
 * `managerValidate()` and `arbitrate({outcome:'approve'})` finalise an
 * assessment that is already in state 'reviewed' — meaning a supervisor has
 * been through it — and both called `_promoteToSkillAssessment(sa, user, auth)`
 * with NO level. The fallback then promoted `sa.selfRatedLevel`.
 *
 * Proven by rollback probe, self 1 / supervisor 4:
 *
 *   supervisor_reviews_says:        {"lvl":4,"gap":3}
 *   official_skill_level_written:   {"currentLevel":1,...}
 *   VERDICT: DEFECT — promoted 1 (the SELF rating) over supervisor 4
 *
 * Nothing errors, nothing is logged. The wrong number simply becomes the
 * official level feeding readiness, gaps, benchmark and the 9-box, while
 * supervisor_reviews keeps saying 4 — so the two disagree permanently and the
 * report that would reveal it reads from the corrupted side.
 *
 * After the fix, the same probe promotes 4 on BOTH paths, and the agreement
 * case (no supervisor level recorded) still promotes the self-rating — the fix
 * must not invert into "always ignore the employee".
 */

const fs = require('fs');
const path = require('path');
const svc = fs.readFileSync(
    path.join(__dirname, '../../src/services/SelfAssessmentWorkflowService.js'),
    'utf8'
);

describe('promotion consults the supervisor review before falling back', () => {
    test('a recorded supervisor_rated_level is read when no level was passed', () => {
        expect(svc).toMatch(/if \(level == null && sa && sa\.id != null\)/);
        expect(svc).toMatch(/SELECT supervisor_rated_level AS "lvl" FROM supervisor_reviews/);
        expect(svc).toMatch(/WHERE self_assessment_id = \? AND supervisor_rated_level IS NOT NULL/);
    });

    test('the lookup happens BEFORE the self-rating fallback is computed', () => {
        const lookup = svc.indexOf(
            'SELECT supervisor_rated_level AS "lvl" FROM supervisor_reviews'
        );
        const fallback = svc.indexOf(
            'const lvl = Number(level != null ? level : sa.selfRatedLevel)'
        );
        expect(lookup).toBeGreaterThan(-1);
        expect(fallback).toBeGreaterThan(-1);
        expect(lookup).toBeLessThan(fallback);
    });

    test('the self-rating is still the last resort, so agreement is preserved', () => {
        expect(svc).toMatch(/const lvl = Number\(level != null \? level : sa\.selfRatedLevel\);/);
    });

    test('a failed lookup falls through instead of blocking the approval', () => {
        expect(svc).toMatch(/fall through to the self-rating rather than blocking the approval/);
    });

    test('the precedence order is documented where the next reader will look', () => {
        expect(svc).toMatch(/Precedence, most authoritative first/);
    });
});

describe('both finalising paths reach that promotion', () => {
    test('managerValidate promotes', () => {
        const i = svc.indexOf('async managerValidate(');
        const body = svc.slice(i, svc.indexOf('async arbitrate('));
        expect(body).toMatch(/_promoteToSkillAssessment\(sa, user, auth\)/);
    });

    test('arbitrate promotes when the outcome is approval', () => {
        const i = svc.indexOf('async arbitrate(');
        // Slice to the NEXT method, not a magic character count: `arbitrate`
        // grew past 2500 characters when the closed-campaign write gate was
        // added, and a fixed window silently stopped covering the very line
        // this test exists to protect.
        const rest = svc.slice(i + 1);
        const nextMethod = rest.search(/\n {4}(?:async )?[A-Za-z_$][\w$]*\(/);
        const body = nextMethod === -1 ? svc.slice(i) : svc.slice(i, i + 1 + nextMethod);
        expect(body).toMatch(
            /if \(toState === 'approved'\) await this\._promoteToSkillAssessment\(sa, user, auth\)/
        );
    });

    test('approve still passes its own reviewer level, which outranks the lookup', () => {
        expect(svc).toMatch(/_promoteToSkillAssessment\(sa, user, auth, mgrLevel\)/);
    });
});
