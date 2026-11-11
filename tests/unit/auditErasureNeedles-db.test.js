'use strict';
/**
 * The erasure's audit-log redaction must find the person's OLDER addresses
 * too: a line written before an e-mail change carries the previous one.
 * collectNeedles adds the addresses recorded against this person's id: the
 * e-mail each SSO identity asserted at link time (and an e-mail-shaped SSO
 * uid), the onboarding request that created them, the UPN of an SSO-migration
 * mapping.
 *
 * On the real test database, inside ONE transaction that is always rolled
 * back: the same transaction context the erasure uses, so the existence checks
 * must never abort it. Runs on idevelop_test* / idevelop_fixtures only.
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

const db = HAS_DB ? require('../../src/config/database') : null;
const AuditRetention = require('../../src/services/AuditRetentionService');

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

suite('previous addresses recorded against the person are redaction needles', () => {
    test('SSO identity e-mail + e-mail-shaped uid, onboarding address, migration UPN', async () => {
        const tag = crypto.randomBytes(4).toString('hex');
        const OLD_SSO = `old.sso.${tag}@corp.test`;
        const OLD_UID = `nameid.${tag}@corp.test`;
        const OLD_ONB = `applied.${tag}@corp.test`;
        const OLD_UPN = `upn.${tag}@corp.test`;
        const out = await inRolledBackTx(async () => {
            const emp = await db.get(
                'SELECT id, email FROM employees WHERE erased_at IS NULL ORDER BY id LIMIT 1'
            );
            const before = await AuditRetention.collectNeedles(emp.id);
            await db.run(
                `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, email)
                 VALUES ('employee', ?, ?, ?, ?)`,
                [emp.id, `needles_${tag}`, OLD_UID, OLD_SSO]
            );
            await db.run(
                `INSERT INTO onboarding_requests (email, source, status, created_employee_id)
                 VALUES (?, 'signup', 'approved', ?)`,
                [OLD_ONB, emp.id]
            );
            const admin = await db.get('SELECT id FROM admins ORDER BY id LIMIT 1');
            await db.run(
                `INSERT INTO sso_pending_links (provider, employee_id, match_upn, created_by)
                 VALUES (?, ?, ?, ?)`,
                [`needles_${tag}`, emp.id, OLD_UPN, admin.id]
            );
            const after = await AuditRetention.collectNeedles(emp.id);
            // The transaction is still usable (no statement failed inside it).
            const alive = await db.get('SELECT 1 AS one');
            return { emp, before, after, alive };
        });
        expect(out.alive.one).toBe(1);
        for (const addr of [OLD_SSO, OLD_UID, OLD_ONB, OLD_UPN]) {
            expect({ addr, before: out.before.includes(addr) }).toEqual({ addr, before: false });
            expect({ addr, after: out.after.includes(addr) }).toEqual({ addr, after: true });
        }
        // The current identifiers are still there.
        if (out.emp.email) expect(out.after).toContain(String(out.emp.email));
    });
});
