'use strict';
/**
 * Migrations 194 (a dispute's level-0 proposal; auto-finalise OFF where the
 * seed is untouched) and 195 (the evidence of a PIP) — the files, and the REAL
 * schema inside transactions that are always rolled back.
 *
 *   - idempotent forms, public-qualified, end with the SQL console sync;
 *   - THE UPGRADE VALUE RULE (owner decision 5): dispute.autoFinalizeOnExpiry
 *     goes to 'false' only where nobody chose it (updated_by IS NULL); an
 *     administrator's 'true' is kept. On an upgrade that switched it off,
 *     every active SuperAdmin gets ONE in-app notice (a re-run adds none); on
 *     a new install, none;
 *   - the checks bind (proposed rating 0-4, a proposal is rating + date, the
 *     person's answer, note lengths, the actor-ref formats, a checkpoint
 *     carries a note and an author);
 *   - pip.hrVisaRequired is seeded OFF and is governance-class (SuperAdmin);
 *   - the new free text is known to the erasure, the export and the
 *     register; pip_reviews to the cleanup and the go-live reset.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
const read = (f) => fs.readFileSync(path.join(__dirname, '../../db/postgres', f), 'utf8');
const M194 = read('194_dispute_l0_proposal.sql');
const M195 = read('195_pip_evidence_checkpoints.sql');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__MIG194_195_ROLLBACK__');
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}
async function refused(q, sql, params = []) {
    await q.query('SAVEPOINT probe');
    try {
        await q.query(sql, params);
        await q.query('RELEASE SAVEPOINT probe');
        return null;
    } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT probe');
        return e.code || 'error';
    }
}

describe('the migration files and the lists that must know them', () => {
    test('idempotent forms only, qualified, end with the console sync', () => {
        for (const m of [M194, M195]) {
            expect(m.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
            expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
            expect(m).not.toMatch(/\bDELETE\s+FROM\b/i);
            // every ALTER / CREATE / INSERT / UPDATE / FROM / REFERENCES names
            // the public schema
            const code = m
                .split('\n')
                .filter((l) => !/^\s*--/.test(l))
                .join('\n');
            for (const re of [
                /ALTER TABLE (?!public\.)/,
                /INSERT INTO (?!public\.)/,
                /\bUPDATE (?!public\.)/,
                /CREATE TABLE IF NOT EXISTS (?!public\.)/,
                /CREATE INDEX IF NOT EXISTS \w+ ON (?!public\.)/,
                /REFERENCES (?!public\.)/,
                /\bFROM (?!public\.|pg_constraint\b)/,
            ])
                expect([String(re), re.test(code)]).toEqual([String(re), false]);
        }
        expect(M194).toMatch(/ADD COLUMN IF NOT EXISTS proposed_rating/);
        // the ONLY value 194 changes, and only where nobody chose it
        expect(M194).toMatch(
            /WHERE setting_key = 'dispute\.autoFinalizeOnExpiry'\s+AND setting_value = 'true'\s+AND updated_by IS NULL/
        );
        expect(M195).toMatch(/CREATE TABLE IF NOT EXISTS public\.pip_reviews/);
        expect(M195).toMatch(/'pip\.hrVisaRequired',\s*'false'/);
        expect(M195).toMatch(/ON CONFLICT \(setting_key\) DO NOTHING/);
    });

    test('pip.hrVisaRequired is governance-class; auto-finalise is not', () => {
        const { isSecurityClassSetting } = require('../../src/utils/securitySettings');
        expect(isSecurityClassSetting('pip.hrVisaRequired', 'security')).toBe(true);
        expect(isSecurityClassSetting('dispute.autoFinalizeOnExpiry', 'disputes')).toBe(false);
        for (const lang of ['fr', 'en']) {
            const a = require(`../../locales/${lang}/admin.json`);
            expect(a.set_name_pip_hrVisaRequired).toBeTruthy();
            expect(a.set_desc_pip_hrVisaRequired).toBeTruthy();
        }
    });

    test('erasure, export, register, cleanup and go-live reset know the new text', () => {
        const {
            SUBJECT_DATA_REGISTRY: reg,
            TABLES_WITHOUT_SUBJECT_COLUMN: other,
        } = require('../../src/services/erasureRegistry');
        for (const [t, c] of [
            ['assessment_disputes', 'proposed_by'],
            ['pips', 'proposed_by_ref'],
            ['pips', 'activated_by_ref'],
            ['pips', 'hr_visa_by_ref'],
        ])
            expect(reg.find((e) => e.table === t && e.column === c)).toMatchObject({
                treatment: 'keep',
            });
        expect(reg.find((e) => e.table === 'pip_reviews' && e.scope)).toMatchObject({
            treatment: 'redacted',
            key: 'pipReviews',
        });
        expect(other.pip_reviews[0]).toBe('via');
        const DSR = require('../../src/services/DSRService');
        const red = Object.fromEntries(DSR.REDACTED_ON_ERASURE.map((c) => [c.key, c]));
        expect(red.disputes.erased).toEqual(['reason', 'proposal_note']);
        expect(red.pips.erased).toEqual(['summary', 'outcome', 'employee_comment']);
        expect(red.pipReviews.erased).toEqual(['manager_note', 'employee_response']);
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/ComplianceRegisterService.js'),
            'utf8'
        );
        expect(src).toMatch(
            /\{ key: 'pipReviews', group: 'development', audience: 'self_line_hr' \}/
        );
        for (const lang of ['fr', 'en'])
            expect(require(`../../locales/${lang}/compliance.json`).cat_pipReviews).toBeTruthy();
        const cleanup = fs.readFileSync(
            path.join(__dirname, '../../src/services/DatabaseCleanupService.js'),
            'utf8'
        );
        expect(cleanup.indexOf("'pip_reviews'")).toBeGreaterThan(-1);
        expect(cleanup.indexOf("'pip_reviews'")).toBeLessThan(cleanup.indexOf("'pips'"));
        expect(require('../../scripts/reset-for-golive').WIPE.has('pip_reviews')).toBe(true);
    });
});

suite('migrations 194 and 195 on the real schema', () => {
    test('a new install: auto-finalise is off, pip.hrVisaRequired is off, no notice', async () => {
        const out = await inRolledBackTx(async (q) => {
            const s = await q.query(
                `SELECT setting_key, setting_value, category FROM app_settings
                  WHERE setting_key IN ('dispute.autoFinalizeOnExpiry', 'pip.hrVisaRequired')
                  ORDER BY 1`
            );
            const n = await q.query(
                "SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'dispute.auto_finalize_off'"
            );
            return { s: s.rows, n: n.rows[0].n };
        });
        expect(out.s).toEqual([
            {
                setting_key: 'dispute.autoFinalizeOnExpiry',
                setting_value: 'false',
                category: 'disputes',
            },
            { setting_key: 'pip.hrVisaRequired', setting_value: 'false', category: 'security' },
        ]);
        expect(out.n).toBe(0);
    });

    test('the upgrade value rule: an untouched seed goes off with one notice; a choice is kept', async () => {
        const out = await inRolledBackTx(async (q) => {
            // An install that has run for months (the oldest migration is old).
            await q.query("UPDATE schema_meta SET applied_at = now() - interval '200 days'");
            await q.query("DELETE FROM notifications WHERE kind = 'dispute.auto_finalize_off'");
            const supers = await q.query(
                "SELECT COUNT(*)::int AS n FROM admins WHERE role = 'superadmin' AND is_active = true"
            );
            // 1. the untouched seed of migration 47
            await q.query(
                `UPDATE app_settings SET setting_value = 'true', updated_by = NULL
                  WHERE setting_key = 'dispute.autoFinalizeOnExpiry'`
            );
            await q.query(M194);
            const untouched = await q.query(
                "SELECT setting_value FROM app_settings WHERE setting_key = 'dispute.autoFinalizeOnExpiry'"
            );
            const notices = await q.query(
                `SELECT user_type::text AS t, payload->>'link' AS link FROM notifications
                  WHERE kind = 'dispute.auto_finalize_off'`
            );
            // a re-run adds nothing (the value is already off, the notice exists)
            await q.query(M194);
            const again = await q.query(
                "SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'dispute.auto_finalize_off'"
            );
            // 2. an administrator's choice
            await q.query("DELETE FROM notifications WHERE kind = 'dispute.auto_finalize_off'");
            const a = await q.query(
                "SELECT id FROM admins WHERE role = 'superadmin' ORDER BY id LIMIT 1"
            );
            await q.query(
                `UPDATE app_settings SET setting_value = 'true', updated_by = $1
                  WHERE setting_key = 'dispute.autoFinalizeOnExpiry'`,
                [a.rows[0].id]
            );
            await q.query(M194);
            const chosen = await q.query(
                "SELECT setting_value FROM app_settings WHERE setting_key = 'dispute.autoFinalizeOnExpiry'"
            );
            const none = await q.query(
                "SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'dispute.auto_finalize_off'"
            );
            return {
                supers: supers.rows[0].n,
                untouched: untouched.rows[0].setting_value,
                notices: notices.rows,
                again: again.rows[0].n,
                chosen: chosen.rows[0].setting_value,
                none: none.rows[0].n,
            };
        });
        expect(out.supers).toBeGreaterThan(0);
        expect(out.untouched).toBe('false');
        expect(out.notices).toHaveLength(out.supers);
        expect(out.notices.every((n) => n.t === 'admin' && n.link === '/app-settings')).toBe(true);
        expect(out.again).toBe(out.supers);
        expect(out.chosen).toBe('true');
        expect(out.none).toBe(0);
    });

    test('a re-run is a no-op; the checks bind', async () => {
        const out = await inRolledBackTx(async (q) => {
            await q.query(M194);
            await q.query(M195);
            await q.query(M195);
            const e = await q.query('SELECT id FROM employees ORDER BY id LIMIT 1');
            const a = await q.query('SELECT id FROM admins ORDER BY id LIMIT 1');
            const sk = await q.query('SELECT id FROM skills ORDER BY id LIMIT 1');
            // one dispute of an invented review to probe the checks on
            const round = await q.query(
                `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state)
                 VALUES ($1, $2, 3, 'submitted', 'submitted') RETURNING id`,
                [e.rows[0].id, sk.rows[0].id]
            );
            const review = await q.query(
                `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                                 gap, reviewed_by, status)
                 VALUES ($1, $2, $3, 1, -2, $2, 'disputed') RETURNING id`,
                [round.rows[0].id, e.rows[0].id, sk.rows[0].id]
            );
            const dispute = await q.query(
                `INSERT INTO assessment_disputes (supervisor_review_id, employee_id, reason)
                 VALUES ($1, $2, 'mig 194 probe') RETURNING id`,
                [review.rows[0].id, e.rows[0].id]
            );
            const pip = await q.query(
                `INSERT INTO pips (employee_id, initiated_by, state, summary)
                 VALUES ($1, $2, 'cancelled', 'mig 195 probe') RETURNING id`,
                [e.rows[0].id, a.rows[0].id]
            );
            const pid = pip.rows[0].id;
            const r = {};
            {
                const did = dispute.rows[0].id;
                r.rating5 = await refused(
                    q,
                    'UPDATE assessment_disputes SET proposed_rating = 5, proposed_at = now() WHERE id = $1',
                    [did]
                );
                r.ratingNoDate = await refused(
                    q,
                    'UPDATE assessment_disputes SET proposed_rating = 2, proposed_at = NULL WHERE id = $1',
                    [did]
                );
                r.answer = await refused(
                    q,
                    "UPDATE assessment_disputes SET employee_response = 'maybe' WHERE id = $1",
                    [did]
                );
                r.longNote = await refused(
                    q,
                    "UPDATE assessment_disputes SET proposal_note = repeat('x', 4001) WHERE id = $1",
                    [did]
                );
            }
            r.badRef = await refused(q, "UPDATE pips SET activated_by_ref = 'boss' WHERE id = $1", [
                pid,
            ]);
            r.okRef = await refused(
                q,
                "UPDATE pips SET activated_by_ref = 'employee:12', activated_at = now() WHERE id = $1",
                [pid]
            );
            r.longComment = await refused(
                q,
                "UPDATE pips SET employee_comment = repeat('x', 4001) WHERE id = $1",
                [pid]
            );
            r.emptyNote = await refused(
                q,
                "INSERT INTO pip_reviews (pip_id, manager_note, author_ref) VALUES ($1, '   ', 'employee:1')",
                [pid]
            );
            r.badAuthor = await refused(
                q,
                "INSERT INTO pip_reviews (pip_id, manager_note, author_ref) VALUES ($1, 'Held.', 'someone')",
                [pid]
            );
            r.okReview = await refused(
                q,
                "INSERT INTO pip_reviews (pip_id, manager_note, author_ref) VALUES ($1, 'Held.', 'admin:1')",
                [pid]
            );
            const visa = await q.query(
                "SELECT COUNT(*)::int AS n FROM app_settings WHERE setting_key = 'pip.hrVisaRequired'"
            );
            return { r, visa: visa.rows[0].n };
        });
        expect(out.r.rating5).toBe('23514');
        expect(out.r.ratingNoDate).toBe('23514');
        expect(out.r.answer).toBe('23514');
        expect(out.r.longNote).toBe('23514');
        expect(out.r.badRef).toBe('23514');
        expect(out.r.okRef).toBeNull();
        expect(out.r.longComment).toBe('23514');
        expect(out.r.emptyNote).toBe('23514');
        expect(out.r.badAuthor).toBe('23514');
        expect(out.r.okReview).toBeNull();
        expect(out.visa).toBe(1);
    });
});
