'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-1 (criticality 630) — the skill-matrix export applied no clearance.
 *
 * `exportData(format)` never received the caller, so `_collectModel` selected
 * every active employee and every assessment. The workbook carries name,
 * employee number, site, department, service, role, manager, supervisor and every
 * assessed level — the most personal artifact the product produces.
 *
 * Measured before the fix: a local admin cleared for ONE employee,
 * downloaded all 77 with 3 584 assessment rows. At the 4 000-person target that is
 * the whole workforce in a single click, behind a permission (`export_data`) that
 * says nothing about scope. The sibling `exportEmployees` had scoped correctly all
 * along, which is what makes this an oversight rather than a design choice.
 *
 * After the fix: 1 employee, 29 assessment rows, 0 rows outside the clearance.
 *
 * Scoring rationale: G=9 (bulk personal-data disclosure), O=7 (any scoped admin
 * holding export_data), D=10 (the file downloads normally; nothing signals that it
 * contains more than the caller may see).
 *
 * The referential sections stay org-wide by design — domains, skills, roles and
 * their required levels are the framework each DEPARTMENT designed, not personal
 * data. Verified: 1 126 skills and 41 roles in every export, scoped or not.
 */

const fs = require('fs');
const path = require('path');
const { flat } = require('../helpers/flatSource');
// Layout-proof: prettier reflows the sources these assertions read.
const read = (p) => flat(fs.readFileSync(path.join(__dirname, '../..', p), 'utf8'));

describe('the export is built inside the caller clearance', () => {
    const svc = read('src/services/SkillMatrixWorkbookService.js');

    test('exportData accepts the caller and passes it down', () => {
        expect(svc).toMatch(/async exportData\(format = 'excel', user = null\)/);
        expect(svc).toMatch(/_collectModel\(\{ includeLiveEmployees: true, user \}\), format\)/);
    });

    test('the raw-workbook entry point is scoped too', () => {
        expect(svc).toMatch(/async exportWorkbook\(user = null\)/);
    });

    test('the scope is resolved with the shared helper, which fails closed', () => {
        expect(svc).toMatch(
            /const \{ scopedEmployeeIds, scopeClause \} = require\('\.\.\/utils\/rbacScope'\)/
        );
        expect(svc).toMatch(/scopeClause\(await scopedEmployeeIds\(user\), empParams, 'e\.id'\)/);
        // " AND 1 = 0" on an empty scope — never a fall-through to the whole org.
        const helper = read('src/utils/rbacScope.js');
        expect(helper).toMatch(/if \(!ids\.length\) return ' AND 1 = 0'/);
    });

    test('BOTH employee-bearing queries are scoped, not just the employee sheet', () => {
        // The assessments query is a UNION ALL: each branch filters employees, so
        // each branch needs the clause and its parameters.
        const occurrences = svc.match(/WHERE e\.isActive = 1\$\{empScope\}/g) || [];
        expect(occurrences.length).toBe(3); // employees + both UNION branches
        expect(svc).toMatch(/\[\.\.\.empParams, \.\.\.empParams\]/);
    });

    test('the blank template is not scoped — it holds no employee rows', () => {
        expect(svc).toMatch(/includeLiveEmployees\s*\?\s*scopeClause/);
        expect(svc).toMatch(/async buildTemplateData\(format = 'excel'\)/);
    });

    test('the referential query is deliberately NOT scoped', () => {
        // Rule: the skill count per role is department-designed and must never be
        // reduced. Scoping the skills sheet would silently shrink the framework.
        const skills = svc.slice(
            svc.indexOf('SELECT s.id, s.name, s.domainId'),
            svc.indexOf('SELECT s.id, s.name, s.domainId') + 260
        );
        expect(skills).not.toMatch(/empScope/);
    });
});

describe('the route hands the caller through', () => {
    test('the controller passes req.user to the export', () => {
        const ctrl = read('src/controllers/DataManagementController.js');
        // \s* on purpose: prettier wraps this call across four lines, and an
        // assertion that pins the layout goes red on a reformat that changed no
        // behaviour. What matters is that req.user is passed, not where the
        // line breaks.
        expect(ctrl).toMatch(/SkillMatrixWorkbookService\.exportData\(\s*format,\s*req\.user\s*\)/);
    });
});
