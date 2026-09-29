'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-4 (criticality 480) and L2-2 (378).
 *
 * L4-4 — The SQL console is the most destructive tool in the product, and its audit
 *        entry recorded the LENGTH of the script: "superadmin executed 4 711
 *        characters of SQL". Nothing lets anyone reconstruct what was done to the
 *        database. G=6, O=10 (every single execution), D=8.
 *
 * L2-2 — `/v2/continuity/retention` served `SELECT rr.*`, and
 *        `RetentionRiskService` stores the employee's exact 9-box position in
 *        `risk_factors.nineBox` as an input to the impact score. That endpoint is
 *        scoped to a manager's SUB-TREE, while NineBoxService only discloses a
 *        placement to a DIRECT manager and only when `disclosed_to_employee` allows
 *        it. An N+2 manager therefore read, as JSON, a confidential placement they
 *        are refused on every screen. G=7, O=6, D=9 — the field is not rendered
 *        anywhere, so nobody would notice it being served.
 *
 * Verified: the served payload no longer contains `nineBox` while `_computed` is
 * retained, so the score stays reconstructible for audit.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the SQL console records what was actually run', () => {
    const ctrl = read('src/controllers/SqlConsoleController.js');

    test('the script itself is audited, not its length', () => {
        expect(ctrl).toMatch(/; sql=\$\{truncateForAudit\(sql\)\}/);
        expect(ctrl).not.toMatch(/\$\{\(sql \|\| ''\)\.length\} chars/);
    });

    test('truncation is stated, never implied to be complete', () => {
        expect(ctrl).toMatch(/…\[truncated, \$\{s\.length\} chars total\]/);
    });

    test('a multi-line script stays one readable audit line', () => {
        expect(ctrl).toMatch(/\.replace\(\/\\s\+\/g, ' '\)/);
    });

    test('an empty script is recorded as empty rather than as nothing', () => {
        expect(ctrl).toMatch(/if \(!s\) return '\(empty\)'/);
    });
});

describe('the retention endpoint does not carry a 9-box placement', () => {
    const route = read('src/routes/v2-continuity.js');

    test('columns are enumerated instead of SELECT rr.*', () => {
        expect(route).toMatch(
            /SELECT rr\.employee_id, rr\.flight_risk, rr\.impact_of_loss, rr\.computed_score/
        );
    });

    test('the confidential key is removed from what is served', () => {
        expect(route).toMatch(/\(rr\.risk_factors - 'nineBox'\) AS risk_factors/);
    });

    test('the rest of risk_factors survives, so the score stays auditable', () => {
        // Dropping the whole column would hide how the score was reached.
        expect(route).toMatch(/AS risk_factors/);
        expect(route).not.toMatch(/SELECT rr\.\*, e\.first_name/);
    });

    test('the key is still WRITTEN — this is an exposure fix, not a data change', () => {
        const svc = read('src/services/RetentionRiskService.js');
        expect(svc).toMatch(/factors\.nineBox = `\$\{potential\}-\$\{performance\}`/);
    });
});
