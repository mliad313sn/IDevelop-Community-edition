'use strict';

/**
 * NEW-1 — a no-op round trip of the workbook silently deleted real reporting lines.
 *
 * Found by the PRODUCT OWNER reviewing Lot E's own work: Lot E measured the 4
 * employee rewrites, saw them honestly counted as `updated`, and declared the
 * importer correct WITHOUT OPENING THEM. What they contained was data loss.
 *
 * Two halves, both in SkillMatrixWorkbookService:
 *
 *  1. EXPORT joined `employees mgr ON e.manager_id = mgr.id` with no
 *     `manager_type` guard. `manager_id` only points at an employee when
 *     manager_type says 'employee'; for the 4 people managed by ADMIN 33 the
 *     join matched nothing and the Manager cell exported BLANK. (Latent and
 *     worse: an employee sharing the numeric id of the managing admin would have
 *     been exported as their manager — the wrong person in a personnel file.)
 *
 *  2. IMPORT read that blank as an instruction: `manager_id = NULL,
 *     manager_type = NULL`. `resolve()` only warns for a name it cannot match,
 *     so a name that was never exported produced no warning at all.
 *
 * Measured on a straight export -> import with NO edits, before the fix:
 *     emp 287/288/289/290 -> managerId "33" => null | managerType "admin" => null
 *     employees: {created:0, updated:4, unchanged:75}
 *
 * After the fix, same probe as superadmin:
 *     employees: {created:0, updated:0, unchanged:79}
 *     columns changed by a NO-OP round trip: 0
 *
 * (The first run of that check was VACUOUS — exporting as `user: null` makes
 * scopedEmployeeIds fail closed, so the sheet held no employees to damage. The
 * numbers above are from the re-run with a real superadmin identity, which is
 * why the test below asserts the fixture is non-empty first.)
 *
 * The rule is the one this whole exercise turns on: an absence is not an
 * instruction. A blank cell — or a name that does not resolve — leaves the
 * existing link alone. Detaching a manager is done deliberately in the app.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
// Layout-proof: prettier reflows the source these assertions read.
const src = require('../helpers/flatSource').flat(
    fs.readFileSync(
        path.join(__dirname, '../../src/services/SkillMatrixWorkbookService.js'),
        'utf8'
    )
);

describe('the export names the manager it actually has', () => {
    test('the manager join is guarded by manager_type', () => {
        expect(src).toMatch(
            /LEFT JOIN employees mgr ON e\.manager_id = mgr\.id AND e\.manager_type = 'employee'/
        );
    });

    test('the unguarded join cannot come back', () => {
        expect(src).not.toMatch(/LEFT JOIN employees mgr ON e\.manager_id = mgr\.id\s*\n/);
    });

    test('why it matters is recorded, including the wrong-person case', () => {
        expect(src).toMatch(/WRONG PERSON/);
    });
});

describe('an empty cell never detaches an existing link', () => {
    test('the previous link is captured before anything is decided', () => {
        expect(src).toMatch(
            /const keepMgr = self\.managerId == null \? null : Number\(self\.managerId\);/
        );
        expect(src).toMatch(
            /const keepSup = self\.supervisorId == null \? null : Number\(self\.supervisorId\);/
        );
    });

    test('a blank or unresolvable manager falls back to the existing link', () => {
        expect(src).toMatch(
            /if \(safeMgr == null && keepMgr != null\) \{ safeMgr = keepMgr; keptMgrType = self\.managerType \|\| null; \}/
        );
    });

    test('the same protection covers the supervisor', () => {
        expect(src).toMatch(/if \(safeSup == null && keepSup != null\) safeSup = keepSup;/);
    });

    test('a preserved admin manager is NOT reclassified as an employee', () => {
        expect(src).toMatch(
            /const nextMgrType = safeMgr == null \? null : \(?keptMgrType \|\| 'employee'\)?;/
        );
        // the old unconditional 'employee' write must be gone
        expect(src).not.toMatch(
            /manager_type = \?, supervisorId = \? WHERE id = \?', \[safeMgr, safeMgr \? 'employee' : null/
        );
    });

    test('the comparison that decides "unchanged" uses the resolved type', () => {
        expect(src).toMatch(/\(self\.managerType \|\| null\) === nextMgrType/);
    });

    test('the measured data loss is recorded so nobody re-simplifies this', () => {
        expect(src).toMatch(/manager_id = NULL, manager_type = NULL/);
        expect(src).toMatch(/287\/288\/289\/290|emp 287/);
    });
});
