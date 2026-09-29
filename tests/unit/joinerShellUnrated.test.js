'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L3-2 / L1-6 (criticality 480) and L1-5 (350).
 *
 * `onJoiner` seeds one self-assessment shell per required skill so an arrival has a
 * ready worksheet. The shells were written with `self_rated_level = 0` — but 0 is a
 * REAL answer on the 0-4 scale ("None"). "Not yet rated" and "rated None" were the
 * same value, so:
 *
 *   * the campaign showed the joiner `in_progress` with 13/13 skills rated before
 *     they had opened the page, and those zeros flow into readiness and gap
 *     analysis as measured results;
 *   * `cycle-nudge` finds non-starters by the ABSENCE of rows, so the reminder
 *     written specifically for people who have not begun could never see a joiner
 *     again — their own enrolment silenced it;
 *   * L1-5: `v_cycle_participant_status.rated_skills` counts
 *     `FILTER (WHERE self_rated_level IS NOT NULL)` on a column that was declared
 *     NOT NULL, so the filter was ALWAYS true and rated always equalled total.
 *
 * Verified by probe (rolled back): 13 shells, all unrated; the campaign reads
 * `not_started` 0/13; the nudge still sees them; and once one skill is rated the
 * nudge correctly stops.
 *
 * Scoring rationale: G=6, O=8 (every arrival), D=10 (the dashboard shows a
 * plausible "in progress" and the missing reminder is invisible by nature).
 *
 * Existing zeros are deliberately left alone: `locked_state='provisional'` is the
 * normal state of every in-flight assessment (176 of 177 on this instance), so a
 * stored 0 cannot be distinguished from a genuine "None" answer. Rewriting them
 * would destroy real answers to tidy up synthetic ones.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a joiner shell is unrated, not rated zero', () => {
    const svc = read('src/services/LifecycleService.js');

    test('the shell carries NULL', () => {
        expect(svc).toMatch(/VALUES \(\?, \?, NULL, 'draft', \?, 'provisional'\)/);
    });

    test('the column can actually hold NULL', () => {
        const mig = read('db/postgres/87_joiner_shell_unrated.sql');
        expect(mig).toMatch(
            /ALTER TABLE self_assessments ALTER COLUMN self_rated_level DROP NOT NULL/
        );
    });

    test('the migration does not rewrite existing answers', () => {
        const mig = read('db/postgres/87_joiner_shell_unrated.sql');
        expect(mig).not.toMatch(/UPDATE self_assessments/);
        expect(mig).toMatch(/deliberately NOT converted/);
    });

    test('reverting an arrival deletes only UNRATED shells', () => {
        // `self_rated_level = 0` deleted the answers of anyone who had genuinely
        // rated a skill "None" before the arrival was reverted.
        expect(svc).toMatch(/AND locked_state = 'provisional' AND self_rated_level IS NULL/);
        expect(svc).not.toMatch(/AND locked_state = 'provisional' AND self_rated_level = 0/);
    });
});

describe('the "you have not started" reminder can still see a joiner', () => {
    test('a non-starter is someone with no RATED answer, not someone with no rows', () => {
        const job = read('src/jobs/cycle-nudge.js');
        expect(job).toMatch(
            /WHERE sa\.cycle_id = p\.cycle_id AND sa\.employee_id = p\.employee_id\s*\n\s*AND sa\.self_rated_level IS NOT NULL\)/
        );
    });
});

describe('rated_skills counts something (L1-5)', () => {
    test('the view filters on NULL-ability that now exists', () => {
        // The filter was written correctly all along; the column being NOT NULL is
        // what made it a no-op, so rated always equalled total.
        const view = read('db/postgres/70_cycle_participants.sql');
        expect(view).toMatch(
            /COUNT\(\*\) FILTER \(WHERE self_rated_level IS NOT NULL\)::int\s+AS rated/
        );
        const mig = read('db/postgres/87_joiner_shell_unrated.sql');
        expect(mig).toMatch(/DROP NOT NULL/);
    });
});
