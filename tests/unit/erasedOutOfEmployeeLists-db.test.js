'use strict';
/**
 * An erased person who is still is_active is out of the employee list, the
 * active population behind RBAC scope filters, and a manager's governed
 * sub-tree (walked through, never returned), like every other layer. The
 * leavers list keeps the pseudonymised rows.
 *
 * Database check (test databases only), inside a transaction always rolled back.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

suite('erased people (rolled back)', () => {
    const db = HAS_DB ? require('../../src/config/database') : null;
    const ROLLBACK = new Error('rollback');

    beforeAll(async () => {
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('list, active population and governed sub-tree exclude an erased person', async () => {
        const EmployeeModel = require('../../src/models/EmployeeModel');
        let seen;
        await db
            .runTransaction(async () => {
                // Seed: 2 supervises 1 and 3. 3 is erased but still is_active, and
                // supervises 1 here, so the walk must go THROUGH them.
                await db.run('UPDATE employees SET supervisor_id = 3 WHERE id = 1');
                await db.run('UPDATE employees SET erased_at = now() WHERE id = 3');
                const page = await EmployeeModel.findPageWithOrg({
                    scopes: null,
                    filters: { isActive: true },
                    limit: 100,
                    offset: 0,
                });
                const unfiltered = await EmployeeModel.findPageWithOrg({
                    scopes: null,
                    filters: {},
                    limit: 100,
                    offset: 0,
                });
                const active = await EmployeeModel.findByScopesAndFilters(null, {
                    isActive: true,
                });
                const any = await EmployeeModel.findByScopesAndFilters(null, {
                    includeInactive: true,
                });
                const governed = await EmployeeModel.findGovernedIds(2);
                const governedRows = await EmployeeModel.findGoverned(2);
                seen = {
                    page: page.rows.map((r) => Number(r.id)),
                    unfiltered: unfiltered.rows.map((r) => Number(r.id)),
                    active: active.map((r) => Number(r.id)),
                    any: any.map((r) => Number(r.id)),
                    governed: governed.map(Number),
                    governedRows: governedRows.map((r) => Number(r.id)),
                };
                throw ROLLBACK;
            })
            .catch((e) => {
                if (e !== ROLLBACK) throw e;
            });
        expect(seen.page).not.toContain(3);
        expect(seen.page).toEqual(expect.arrayContaining([1, 2]));
        expect(seen.unfiltered).not.toContain(3); // the default list is the live population
        expect(seen.active).not.toContain(3);
        expect(seen.any).toContain(3); // no isActive filter: exports, audit trail
        expect(seen.governed).toContain(1); // reached THROUGH the erased person
        expect(seen.governed).not.toContain(3);
        expect(seen.governedRows).not.toContain(3);
    });
});

test('the guard helper is the name-based one', () => {
    expect(typeof isTestDatabaseUrl).toBe('function');
});
