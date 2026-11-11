'use strict';
/**
 * The /api/v1 person-level feeds publish the active, not-erased population to
 * EVERY caller, SuperAdmin included. scopeFilter() is empty for a SuperAdmin, so
 * /api/v1/employees and the readiness and 9-box feeds used to publish leavers
 * and erased people.
 *
 * Static check always runs; the database check (test databases only) makes one
 * leaver and one erased person inside a transaction that is always rolled back.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
if (!HAS_DB) jest.doMock('../../src/config/database', () => ({}));

const SRC = fs.readFileSync(path.join(__dirname, '../../src/api/v1/repository.js'), 'utf8');

describe('static contract', () => {
    test('every person-level list and count applies the active population', () => {
        expect(SRC).toMatch(
            /const ACTIVE_POP = ' AND e\.is_active = true AND e\.erased_at IS NULL';/
        );
        // readiness list + count, employees list + count, 9-box list + count
        expect(SRC.match(/\$\{sc\.clause\}\$\{ACTIVE_POP\}/g)).toHaveLength(6);
        expect(SRC).not.toMatch(/\$\{sc\.clause\}(?!\$\{ACTIVE_POP\})[`\n]/);
    });
});

const suite = HAS_DB ? describe : describe.skip;
suite('a SuperAdmin caller never receives leavers or erased people (rolled back)', () => {
    const db = HAS_DB ? require('../../src/config/database') : null;
    const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
    const ROLLBACK = new Error('rollback');

    beforeAll(async () => {
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('employees and readiness feeds, list and count agree', async () => {
        const { EmployeesRepository, ReadinessRepository } = require('../../src/api/v1/repository');
        let seen;
        await db
            .runTransaction(async () => {
                const before = (await EmployeesRepository.list(SUPER)).map((r) => r.id);
                expect(before).toEqual(expect.arrayContaining([1, 2, 3]));
                await db.run('UPDATE employees SET is_active = false WHERE id = 3');
                await db.run('UPDATE employees SET erased_at = now() WHERE id = 1');
                const list = (await EmployeesRepository.list(SUPER)).map((r) => r.id);
                const count = await EmployeesRepository.count(SUPER);
                const rlist = (await ReadinessRepository.list(SUPER)).map((r) => r.employeeId);
                const rcount = await ReadinessRepository.count(SUPER);
                seen = { list, count, rlist, rcount };
                throw ROLLBACK;
            })
            .catch((e) => {
                if (e !== ROLLBACK) throw e;
            });
        expect(seen.list).not.toContain(1);
        expect(seen.list).not.toContain(3);
        expect(seen.list).toContain(2);
        expect(seen.count).toBe(seen.list.length);
        expect(seen.rlist).not.toContain(1);
        expect(seen.rlist).not.toContain(3);
        expect(seen.rcount).toBe(seen.rlist.length);
    });
});
