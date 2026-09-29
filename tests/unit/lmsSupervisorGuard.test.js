'use strict';
/**
 * The LMS closed loop has one rule that must never bend: an e-learning
 * completion may raise a skill, but it may NEVER reverse a supervisor's
 * decision. That rule was broken for a subtle reason worth pinning forever.
 *
 * `assessment_history.source` is DERIVED from the notes text by
 * fn_classify_assessment_source(). The primary approval path writes the notes
 * 'Set from supervisor-validated rating', which matched none of the classifier's
 * patterns and was filed as 'manual' — so the guard (which only looked for
 * 'supervisor_review') never fired for it, and a later completion silently
 * restored a level a supervisor had deliberately downgraded.
 *
 * These tests pin BOTH ends of that coupling: the guard, and the exact notes
 * string the approval path writes. Rename one without the other and this fails
 * here instead of in somebody's skill profile.
 *
 * DB-free: the service only needs DATABASE_URL to be SET (the Pool is lazy).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/lms_guard_test';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const LmsService = require('../../src/services/LmsService');

const SAW_PATH = path.join(
    __dirname,
    '..',
    '..',
    'src',
    'services',
    'SelfAssessmentWorkflowService.js'
);

describe('a completion never overrides a supervisor decision', () => {
    test('the approval path still writes the notes this guard recognises', () => {
        const src = fs.readFileSync(SAW_PATH, 'utf8');
        // The literal written by _promoteToSkillAssessment when the reviewer
        // entered their OWN rating — i.e. the supervisor's decision.
        const m = src.match(/notes:\s*level\s*!=\s*null\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
        expect(m).not.toBeNull(); // the promotion path was restructured — re-check the coupling
        const supervisorNotes = m[1];
        const selfNotes = m[2];

        // Guards against a vacuous test: these must be real, distinct strings.
        expect(supervisorNotes.length).toBeGreaterThan(10);
        expect(supervisorNotes).not.toEqual(selfNotes);

        // Even filed under the pre-migration-74 classification, the supervisor's
        // rating is protected; the self-approved one is not a supervisor decision.
        expect(LmsService._isSupervisorDecision({ source: 'manual', notes: supervisorNotes })).toBe(
            true
        );
        expect(LmsService._isSupervisorDecision({ source: 'manual', notes: selfNotes })).toBe(
            false
        );
    });

    test('a classified supervisor review is locked', () => {
        expect(
            LmsService._isSupervisorDecision({ source: 'supervisor_review', notes: 'anything' })
        ).toBe(true);
        expect(
            LmsService._isSupervisorDecision({ source: 'supervisor_validated', notes: null })
        ).toBe(true);
    });

    test('nothing else is mistaken for a supervisor decision', () => {
        expect(LmsService._isSupervisorDecision(null)).toBe(false);
        expect(LmsService._isSupervisorDecision(undefined)).toBe(false);
        expect(
            LmsService._isSupervisorDecision({
                source: 'lms_completion',
                notes: 'LMS completion: auto skill uplift',
            })
        ).toBe(false);
        expect(
            LmsService._isSupervisorDecision({
                source: 'self_assessment',
                notes: 'Set from approved self-assessment',
            })
        ).toBe(false);
        expect(LmsService._isSupervisorDecision({ source: 'import', notes: 'bulk import' })).toBe(
            false
        );
        expect(
            LmsService._isSupervisorDecision({ source: 'manual', notes: 'adjusted by admin' })
        ).toBe(false);
    });
});

describe('a malformed provider date cannot stall a sync', () => {
    test('unparseable values become null instead of a database error', () => {
        for (const bad of [
            '0000-00-00',
            'N/A',
            '',
            null,
            undefined,
            'not a date',
            '31/02/2026x',
            '0001-01-01',
        ]) {
            expect(LmsService._toTimestamp(bad)).toBeNull();
        }
    });

    test('real dates survive intact', () => {
        expect(LmsService._toTimestamp('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
        expect(LmsService._toTimestamp('2026-06-01T10:30:00Z')).toBe('2026-06-01T10:30:00.000Z');
        expect(LmsService._toTimestamp(new Date('2026-06-01T00:00:00Z'))).toBe(
            '2026-06-01T00:00:00.000Z'
        );
    });
});

describe('enrollment status only moves forward', () => {
    test('the ranking is assigned → in_progress → completed', () => {
        const r = LmsService._STATUS_RANK;
        expect(r.assigned).toBeLessThan(r.in_progress);
        expect(r.in_progress).toBeLessThan(r.completed);
        // Terminal states are deliberately absent: only a human sets them, and
        // advanceEnrollment must refuse to touch a row that carries one.
        expect(r.failed).toBeUndefined();
        expect(r.cancelled).toBeUndefined();
    });
});
