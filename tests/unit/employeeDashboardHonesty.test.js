'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The employee's own dashboard showed them a level they had never been given,
 * and a readiness score the rest of the platform disagreed with.
 *
 * A bespoke local query did three wrong things at once:
 *   * COALESCE(sa.current_level, 0) rendered a never-assessed skill as
 *     "current 0" with a real-looking gap;
 *   * it included requirements of level 0 — which mean NOT REQUIRED — and those
 *     scored gap 0, so they were badged "✓ atteint" and padded the denominator;
 *   * met/total produced a readiness figure contradicting v_employee_readiness
 *     on the same profile.
 *
 * Measured on test.employee, live page vs database:
 *
 *              before      after     database
 *   readiness    80%        89%         89
 *   skills met   40/50      39/49       39/49
 *   gaps         10         9           9
 *   unmeasured   shown as level 0       1  (now labelled "Non mesuré")
 *
 * The fix reads the shared v_employee_skill_gaps (which already excludes
 * required_level = 0 and carries is_assessed) and takes readiness from the same
 * figure the organisation publishes.
 *
 * Re-audit A6: that org figure is readiness_assessed_only (readiness over the
 * ASSESSED requirements), the column the dashboard, the reports and the
 * manager's view of this same person all use — not v_employee_readiness.readiness
 * (the all-requirements figure), which folded every not-yet-assessed skill back
 * in as a failure and showed the employee a number up to 17 points below their
 * manager's. readiness_assessed_only is NULL when nothing has been assessed, so
 * the never-measured first-run state is preserved without a separate guard, and
 * coverage now travels alongside so the partial assessment is shown.
 *
 * The label reuses the existing dash:rd_not_measured pair, whose French title
 * already says exactly the right thing: "Jamais évalué — aucune donnée, ce
 * n'est pas un niveau 0".
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ctrl = read('src/controllers/EmployeePortalController.js');
const view = read('views/pages/employee/dashboard.ejs');

// Every assertion below runs against WHITESPACE-NORMALISED source. The
// pre-commit hook runs eslint --fix and prettier --write over staged JS, so any
// statement here can be reflowed across lines the moment an unrelated edit
// pushes it past the print width — which is exactly how the `criticalGaps`
// assertion below went red one commit after it was written and verified. What
// these tests pin is the logic; layout belongs to prettier.
const flat = ctrl.replace(/\s+/g, ' ');

describe('the dashboard reads the shared views, not a private query', () => {
    test('gap rows come from v_employee_skill_gaps', () => {
        expect(flat).toMatch(/FROM v_employee_skill_gaps g WHERE g\.employee_id = \?/);
    });

    test('the old COALESCE-to-zero query is gone', () => {
        expect(flat).not.toMatch(/COALESCE\(sa\.current_level, 0\) AS current/);
        expect(flat).not.toMatch(
            /GREATEST\(0, rsr\.required_level - COALESCE\(sa\.current_level, 0\)\)/
        );
    });

    test('readiness comes from readiness_assessed_only, the org figure (A6)', () => {
        // The manager, the dashboard and the reports all read
        // readiness_assessed_only from v_employee_assessment_coverage; the portal
        // must read the SAME column, not the all-requirements v_employee_readiness.
        expect(flat).toMatch(
            /readiness_assessed_only[^']*FROM v_employee_assessment_coverage WHERE employee_id = \?/
        );
        expect(flat).not.toMatch(/SELECT readiness, assessed_required FROM v_employee_readiness/);
    });

    test('a missing coverage row yields null, not a fabricated zero', () => {
        expect(flat).toMatch(
            /covRow && covRow\.readinessAssessedOnly != null \? Math\.round\(Number\(covRow\.readinessAssessedOnly\)\) : null/
        );
    });

    test('a row that exists but measures nothing is also null', () => {
        // readiness_assessed_only is itself NULL for a person with requirements
        // and no assessments (assessed over zero is undefined, not 0), so the
        // ternary above yields null without a separate guard — the tile shows its
        // first-run state, never "0% — 0 of 161 skills met".
        expect(flat).toMatch(/covRow\.readinessAssessedOnly != null/);
    });
});

describe('an unmeasured skill is never a level 0', () => {
    test('current and gap are NULL unless the skill was assessed', () => {
        expect(flat).toMatch(/current: assessed \? Number\(r\.actualLevel\) : null/);
        expect(flat).toMatch(/gap: assessed \? Number\(r\.gap\) : null/);
    });

    test('met counts only measured rows that meet the requirement', () => {
        expect(flat).toMatch(/met: assessed && Number\(r\.isMet\) === 1/);
        expect(flat).toMatch(/const met = gapRows\.filter\( ?\(r\) => r\.met ?\)\.length/);
    });

    test('the gaps tile counts measured shortfalls only', () => {
        expect(flat).toMatch(
            /const gaps = gapRows\.filter\( ?\(r\) => r\.assessed && Number\(r\.gap\) > 0 ?\)\.length/
        );
        expect(flat).not.toMatch(/gaps: total - met/);
    });

    test('critical gaps require a measurement too', () => {
        expect(flat).toMatch(
            /criticalGaps = gapRows\.filter\( ?\(r\) => r\.assessed && Number\(r\.gap\) > 0 && r\.isCritical ?\)/
        );
    });

    test('the unmeasured count is surfaced rather than dropped', () => {
        expect(flat).toMatch(
            /const unmeasured = gapRows\.filter\( ?\(r\) => !r\.assessed ?\)\.length/
        );
        expect(flat).toMatch(/snapshot = \{[^}]*unmeasured/);
    });
});

describe('the template refuses to print an unobserved level', () => {
    test('the current cell shows a dash when nothing was measured', () => {
        expect(view).toMatch(/<% if \(!g\.assessed\) \{ %><span class="text-muted">—<\/span>/);
    });

    test('the gap cell says "not measured" instead of showing a tick', () => {
        expect(view).toMatch(/__\('dash:rd_not_measured'\)/);
        expect(view).toMatch(/title="<%= __\('dash:rd_not_measured_title'\) %>"/);
    });

    test('only a MEASURED critical shortfall paints the row red', () => {
        expect(view).toMatch(
            /g\.assessed && Number\(g\.gap\) > 0 && g\.isCritical \? ' style="background/
        );
    });

    test('the unmeasured count appears on the gaps card', () => {
        expect(view).toMatch(/snapshot\.unmeasured %> <%= __\('dash:rd_not_measured'\)/);
    });
});

describe('the labels exist in both languages', () => {
    test('rd_not_measured and its title are present in FR and EN', () => {
        for (const lang of ['fr', 'en']) {
            // Scan the whole bundle: the keys are nested under a section, and
            // `dash.readiness` is itself a translated STRING, not a container.
            const dash = JSON.parse(read(`locales/${lang}/dash.json`));
            const flat = JSON.stringify(dash);
            expect(flat).toMatch(/"rd_not_measured"/);
            expect(flat).toMatch(/"rd_not_measured_title"/);
        }
    });
});
