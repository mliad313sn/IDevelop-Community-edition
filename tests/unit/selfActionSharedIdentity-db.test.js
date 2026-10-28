'use strict';

/**
 * An administration account linked to NOBODY is still "self" when it shares
 * the person's identity (e-mail, external SSO id, an SSO identity row): it
 * may not review, approve or arbitrate that person's record, and two-person
 * rules count it as the same human. It only ever refuses — it grants no
 * reading or acting right. Against the real test database, every scenario
 * inside one rolled-back transaction.
 */
const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => null) }));

const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__SELF_IDENTITY_ROLLBACK__');
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn();
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}

async function world() {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees WHERE id = 1'
    );
    const emp = async (n, extra = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id,
                                            department_id, service_id, role_id, email,
                                            external_id, auth_provider, is_active)
                     VALUES (?, ?, 'Sample', ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `SI-${n}-${stamp}`,
                        `Person${n}`,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        tpl.roleId,
                        extra.email || null,
                        extra.externalId || null,
                        extra.provider || null,
                    ]
                )
            ).id
        );
    const adm = async (n, extra = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, email, external_id, auth_provider)
                     VALUES (?, 'x', ?, ?, ?, ?) RETURNING id`,
                    [
                        `siadm${n}${stamp}`,
                        extra.role || 'localadmin',
                        extra.email || null,
                        extra.externalId || null,
                        extra.provider || null,
                    ]
                )
            ).id
        );
    return { stamp, emp, adm };
}

suite('self-action through a shared identity', () => {
    const { adminMatchesEmployee, isSamePerson } = require('../../src/utils/personIdentity');

    test('e-mail (case and spaces ignored), external id and SSO identity rows match; nothing else', async () => {
        const out = await inRolledBackTx(async () => {
            const w = await world();
            const mail = `ada.sample.${w.stamp}@example.test`;
            const e1 = await w.emp(1, { email: mail });
            const a1 = await w.adm(1, { email: `  ${mail.toUpperCase()} ` });
            const e2 = await w.emp(2, { externalId: `oid-${w.stamp}`, provider: 'oidc' });
            const a2 = await w.adm(2, { externalId: `oid-${w.stamp}`, provider: 'oidc' });
            const e3 = await w.emp(3, { externalId: `sub-${w.stamp}`, provider: 'entra' });
            const a3 = await w.adm(3, {});
            await db.run(
                `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid)
                 VALUES ('admin', ?, 'entra', ?)`,
                [a3, `sub-${w.stamp}`]
            );
            const stranger = await w.adm(4, { email: `someone.else.${w.stamp}@example.test` });
            const blank = await w.adm(5, { email: '  ' });
            const e5 = await w.emp(5, { email: '' });
            return {
                mail: await adminMatchesEmployee(a1, e1),
                ext: await adminMatchesEmployee(a2, e2),
                sso: await adminMatchesEmployee(a3, e3),
                cross: await adminMatchesEmployee(a1, e2),
                stranger: await adminMatchesEmployee(stranger, e1),
                blank: await adminMatchesEmployee(blank, e5),
                bad: await adminMatchesEmployee('x', e1),
                both: [
                    await isSamePerson({ id: a1, userType: 'admin' }, { employeeId: e1 }),
                    await isSamePerson({ id: e1, userType: 'employee' }, { adminId: a1 }),
                    await isSamePerson({ id: e1, userType: 'employee' }, { adminId: stranger }),
                ],
            };
        });
        expect(out).toEqual({
            mail: true,
            ext: true,
            sso: true,
            cross: false,
            stranger: false,
            blank: false,
            bad: false,
            both: [true, true, false],
        });
    });

    test('a linked admin account is judged by its link, not by its e-mail', async () => {
        const out = await inRolledBackTx(async () => {
            const w = await world();
            const mail = `shared.${w.stamp}@example.test`;
            const e1 = await w.emp(1, { email: mail });
            const e2 = await w.emp(2, {});
            const a = await w.adm(1, { email: mail });
            await db.run('UPDATE admins SET linked_employee_id = ? WHERE id = ?', [e2, a]);
            return [
                await isSamePerson({ id: a, userType: 'admin' }, { employeeId: e1 }),
                await isSamePerson({ id: a, userType: 'admin' }, { employeeId: e2 }),
            ];
        });
        expect(out).toEqual([false, true]);
    });

    test('the review workflow refuses the unlinked account on that record only, and grants nothing', async () => {
        const SA = require('../../src/services/SelfAssessmentWorkflowService');
        const out = await inRolledBackTx(async () => {
            const w = await world();
            const mail = `grace.sample.${w.stamp}@example.test`;
            const me = await w.emp(1, { email: mail });
            const other = await w.emp(2, {});
            const a = await w.adm(1, { email: mail, role: 'superadmin' });
            const user = { id: a, userType: 'admin', role: 'superadmin', username: 'si' };
            const mine = await SA.resolveAuthority(user, me);
            const theirs = await SA.resolveAuthority(user, other);
            let refused = null;
            try {
                await SA.bulkApproveForEmployee(me, user, null);
            } catch (e) {
                refused = e.i18n ? e.i18n.key || e.i18n : e.message;
            }
            return {
                mine: { isSelf: mine.isSelf, selfByIdentity: mine.selfByIdentity },
                theirs: { isSelf: theirs.isSelf, selfByIdentity: theirs.selfByIdentity },
                refused,
            };
        });
        expect(out.mine).toEqual({ isSelf: false, selfByIdentity: true });
        expect(out.theirs).toEqual({ isSelf: false, selfByIdentity: false });
        expect(String(out.refused)).toMatch(/review_own|review your own/);
    });
});
