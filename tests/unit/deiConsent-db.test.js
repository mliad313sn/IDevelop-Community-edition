'use strict';
/**
 * DEI consent model on the REAL test database, every scenario inside ONE
 * transaction that is always rolled back.
 *
 *  - migration 171 is idempotent and flags a pre-existing (unknown-provenance)
 *    row for HR review instead of trusting its self_declared = true;
 *  - a flagged row is excluded from the analytics; a consented self-declaration
 *    is counted;
 *  - declare() writes the consent ledger (text[] fields, version) and withdraw()
 *    nulls every value at once while the ledger row survives, closed;
 *  - HR clearing records the reason and the reviewer on the row.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
// Audit lines are best-effort; keep them out of the rolled-back transaction.
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue() }));
const MIG_171 = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '171_dei_consent_self_declaration.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    let result = null;
    await db
        .runTransaction(async () => {
            result = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return result;
}

suite('DEI consent model on the real schema', () => {
    jest.setTimeout(60000);
    const DEI = () => require('../../src/services/DEIService');

    test('legacy flagged, consented declaration counted, withdrawal nulls, ledger kept', async () => {
        const out = await inRolledBackTx(async () => {
            // Twelve people of our own (inside the rolled-back transaction).
            const tpl = await db.get(
                `SELECT site_id, department_id, service_id, role_id FROM employees
                  WHERE is_active = true ORDER BY id LIMIT 1`
            );
            const stamp = Date.now();
            const ids = [];
            for (let n = 0; n < 12; n++)
                ids.push(
                    Number(
                        (
                            await db.get(
                                `INSERT INTO employees (employee_number, first_name, last_name, site_id,
                                                        department_id, service_id, role_id, is_active)
                                 VALUES (?, ?, 'DEIT', ?, ?, ?, ?, true) RETURNING id`,
                                [
                                    `DEIT-${n}-${stamp}`,
                                    `P${n}`,
                                    tpl.siteId,
                                    tpl.departmentId,
                                    tpl.serviceId,
                                    tpl.roleId,
                                ]
                            )
                        ).id
                    )
                );
            // Start from a clean slate for these people (inside the rolled-back tx).
            await db.run(
                `DELETE FROM employee_demographics WHERE employee_id IN (${ids.join(',')})`
            );
            // A LEGACY row as the old manager endpoint wrote it: self_declared
            // defaulted to true, no provenance.
            await db
                ._client()
                .query(
                    'INSERT INTO employee_demographics (employee_id, gender, disability) VALUES ($1, $2, true)',
                    [ids[0], 'zqxLegacy']
                );
            await db._client().query(MIG_171);
            await db._client().query(MIG_171); // idempotent
            const legacy = await db.get(
                'SELECT provenance, needs_review FROM employee_demographics WHERE employee_id = ?',
                [ids[0]]
            );

            // Five people self-declare the same label with consent.
            for (const id of ids.slice(1, 6))
                await DEI().declare(id, { gender: 'zqxSelf' }, { consent: true, locale: 'fr' });
            const rep = await DEI().representation('gender');

            // One withdraws.
            await DEI().withdraw(ids[1]);
            const afterWithdraw = await db.get(
                'SELECT gender, provenance, needs_review FROM employee_demographics WHERE employee_id = ?',
                [ids[1]]
            );
            const ledger = await db.all(
                'SELECT fields, text_version, withdrawn_at, end_reason FROM dei_consents WHERE employee_id = ? ORDER BY id',
                [ids[1]]
            );

            // A re-declaration supersedes the consent in force (one open at most).
            await DEI().declare(ids[2], { ageBand: '35-44' }, { consent: true });
            const redeclared = await db.all(
                'SELECT end_reason, withdrawn_at FROM dei_consents WHERE employee_id = ? ORDER BY id',
                [ids[2]]
            );

            // HR clears the legacy row.
            const q = await DEI().reviewQueue(null);
            await DEI().hrClear(
                { userType: 'admin', role: 'superadmin', id: 1 },
                ids[0],
                'entered by a manager before consent'
            );
            const cleared = await db.get(
                'SELECT gender, disability, provenance, needs_review, hr_reviewed_by, hr_review_note FROM employee_demographics WHERE employee_id = ?',
                [ids[0]]
            );
            return { ids, legacy, rep, afterWithdraw, ledger, redeclared, q, cleared };
        });

        expect(out.legacy).toEqual({
            provenance: 'legacy_unknown',
            needsReview: true,
        });
        const grp = (g) => out.rep.find((r) => r.grp === g);
        expect(Number(grp('zqxSelf').n)).toBe(5);
        expect(grp('zqxLegacy')).toBeUndefined();

        expect(out.afterWithdraw).toEqual({
            gender: null,
            provenance: 'withdrawn',
            needsReview: false,
        });
        expect(out.ledger).toHaveLength(1);
        expect(out.ledger[0].fields).toEqual(['gender']);
        expect(out.ledger[0].textVersion).toBe(DEI().CONSENT_TEXT_VERSION);
        expect(out.ledger[0].endReason).toBe('withdrawn');
        expect(out.ledger[0].withdrawnAt).not.toBeNull();

        expect(out.redeclared.map((r) => r.endReason)).toEqual(['superseded', null]);

        expect(out.q.map((r) => r.employeeId)).toContain(out.ids[0]);
        expect(out.q.find((r) => r.employeeId === out.ids[0]).held).toEqual([
            'gender',
            'disability',
        ]);
        expect(out.cleared).toEqual({
            gender: null,
            disability: null,
            provenance: 'hr_cleared',
            needsReview: false,
            hrReviewedBy: 'admin:1',
            hrReviewNote: 'entered by a manager before consent',
        });
    });
});
