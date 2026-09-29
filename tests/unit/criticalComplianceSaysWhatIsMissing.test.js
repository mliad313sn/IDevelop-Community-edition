'use strict';
/**
 * "Why is compliance still null?"
 *
 * Because nothing critical has been assessed — which is the CORRECT reading,
 * and the card never said it. Measured on both databases through the product's
 * own query (DashboardModel.getOverviewKPIs):
 *
 *   live : criticalCompliance null · assessed 0 of 187 critical requirements
 *   dev  : criticalCompliance null · assessed 0 of 303
 *
 * and, in the underlying rows, not one `skill_assessments` row lands on an
 * (employee, critical-skill) pair — of 146 distinct critical skills, exactly
 * one has ever been assessed for anyone. The guard
 * `CASE WHEN SUM(critical_assessed) > 0` is doing its job: it exists so the
 * dashboard stops publishing a confident 0 % over an organisation that has
 * simply never measured its critical skills.
 *
 * The DEFECT was that the card rendered a bare em dash and stopped there. "—"
 * says something is missing; it does not say what, or how much, or that the
 * fix is to assess those requirements. The reader had to ask a human.
 *
 * The product already had the right shape two cards further down: "Roles at
 * Risk" prints `Not measured: N` BESIDE its value. This applies the same rule
 * — the unmeasured count sits beside the figure, never inside it, so nothing
 * unmeasured is ever rendered as a result.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the denominator reaches the client', () => {
    const model = read('src/models/DashboardModel.js');

    test('the query selects how many critical requirements EXIST, not only how many are assessed', () => {
        expect(model).toMatch(/SUM\(critical_assessed\) as criticalAssessedRequirements/);
        expect(model).toMatch(/SUM\(critical_expected\) as criticalExpectedRequirements/);
    });

    test('both come from the coverage view via the base CTE', () => {
        expect(model).toMatch(/COALESCE\(c\.critical_assessed, 0\)\s*AS critical_assessed/);
        expect(model).toMatch(/COALESCE\(c\.critical_expected, 0\)\s*AS critical_expected/);
    });

    test('the honesty guard itself is untouched — null, never a fabricated 0', () => {
        // This is the rule the whole card depends on; the change must not have
        // loosened it while adding the explanation.
        expect(model).toMatch(/CASE WHEN SUM\(critical_assessed\) > 0/);
        expect(model).not.toMatch(/COALESCE\(\s*criticalCompliance/i);
    });
});

describe('the card explains the dash instead of just showing it', () => {
    const js = read('public/js/dashboard.js');
    const card = js.slice(js.indexOf('kpiCriticalCompliance'), js.indexOf('kpiRolesAtRisk'));

    test('the value stays an em dash — an unmeasured thing is never a number', () => {
        expect(card).toMatch(/kpis\.criticalCompliance == null \? '—'/);
    });

    test('the subtitle names the unmeasured count when there is nothing to measure from', () => {
        expect(card).toMatch(
            /kpis\.criticalCompliance == null &&\s*Number\(kpis\.criticalExpectedRequirements\) > 0/
        );
        expect(card).toMatch(/rdNotMeasured/);
        expect(card).toMatch(/criticalAssessedRequirements/);
        expect(card).toMatch(/criticalExpectedRequirements/);
    });

    test('with no critical requirement in scope it falls back to the plain subtitle', () => {
        // 0 of 0 would be a nonsense ratio; that scope simply has no critical
        // skills and the card should not imply neglected work.
        expect(card).toMatch(/: I18N\.kpiSafetySkills \|\| 'safety & compliance skills'/);
    });

    test('the count is escaped and grouped like every other figure on the row', () => {
        expect(card).toMatch(/esc\(I18N\.rdNotMeasured/);
        expect(card).toMatch(/grp\(Number\(kpis\.criticalExpectedRequirements\)\)/);
    });
});
