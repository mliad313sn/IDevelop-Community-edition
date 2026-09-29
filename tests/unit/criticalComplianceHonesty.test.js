'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * "Critical compliance" must never fabricate a 0 %.
 *
 * critical_met comes from v_employee_readiness, where an UNMEASURED requirement
 * sits at level 0 and therefore reads as "not met". So met/total produced a
 * confident "0 % critical compliance" for an organisation that had simply never
 * measured its critical skills — live, that was 0 met of 303 expected with
 * critical_assessed = 0. Read by a director, 0 % means "we are catastrophically
 * non-compliant"; the truth was "nobody has checked yet".
 *
 * This is the never-assessed-as-earned-zero fabrication that migrations 71/79
 * exist to prevent, and it mattered more once the KPI snapshot job began
 * PERSISTING the figure — a false 0 % would have been written into the trend
 * history permanently, where no later correction could remove it.
 *
 * The rule, identical to readiness_assessed_only: unmeasured is NULL, never 0.
 */

const fs = require('fs');
const path = require('path');

const MODEL = fs.readFileSync(path.join(__dirname, '../../src/models/DashboardModel.js'), 'utf8');

/** The getOverviewKPIs statement. */
function overviewSql() {
    const i = MODEL.indexOf('roles_at_risk AS (');
    expect(i).toBeGreaterThan(-1);
    return MODEL.slice(i, MODEL.indexOf('return await db.get(sql, params);', i));
}

describe('criticalCompliance is NULL when unmeasured, never 0', () => {
    test('the metric is guarded by an assessed-count condition', () => {
        const sql = overviewSql();
        expect(sql).toMatch(
            /CASE WHEN SUM\(critical_assessed\) > 0[\s\S]*?END as criticalCompliance/
        );
    });

    test('an unguarded met/total expression is not reintroduced', () => {
        const sql = overviewSql();
        // The bare form, with no CASE guard preceding it on the same expression.
        const bare =
            /(?<!THEN\s)ROUND\(100\.0 \* SUM\(critical_met\)[^)]*\)[^)]*\) as criticalCompliance/;
        expect(bare.test(sql)).toBe(false);
    });

    test('the assessed-critical count is selected so the guard has an input', () => {
        const sql = overviewSql();
        expect(sql).toMatch(/critical_assessed/);
    });

    test('COALESCE is never applied to criticalCompliance itself', () => {
        // Coalescing the OUTPUT to 0 would recreate the fabrication downstream.
        expect(MODEL).not.toMatch(/COALESCE\s*\(\s*criticalCompliance/i);
    });
});

describe('every consumer renders an unmeasured value as unmeasured', () => {
    test('the dashboard KPI card prints an em dash, not 0%', () => {
        const js = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
        expect(js).toMatch(/kpis\.criticalCompliance == null \? '—'/);
    });

    test('the board pack prints an em dash for a null KPI', () => {
        const ejs = fs.readFileSync(
            path.join(__dirname, '../../views/pages/exec/board-pack.ejs'),
            'utf8'
        );
        expect(ejs).toMatch(/function pv\(v, suffix\)[\s\S]{0,120}undefined\)\s*\?\s*'—'/);
    });

    test('the snapshot service stores the KPI without coercing null to a number', () => {
        const svc = fs.readFileSync(
            path.join(__dirname, '../../src/services/KpiSnapshotService.js'),
            'utf8'
        );
        // numOrNull must be what guards the persisted value.
        expect(svc).toMatch(/numOrNull\(m\.criticalCompliance\)/);
        expect(svc).not.toMatch(/Number\(m\.criticalCompliance\)\s*\|\|\s*0/);
    });
});
