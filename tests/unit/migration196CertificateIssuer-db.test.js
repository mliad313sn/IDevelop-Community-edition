'use strict';
/**
 * Migration 196 (the body that issued a certificate) — the file, the pure
 * normalisation, and the REAL schema inside transactions that are always
 * rolled back.
 *
 *   - idempotent forms, public-qualified, end with the SQL console sync, no
 *     UPDATE: the rows recorded before 196 are never back-filled;
 *   - the CHECK binds: NULL, or trimmed and 1 to 200 characters;
 *   - the register form's value is normalised (blank = not recorded, never '');
 *   - the issuer is a fact of the certificate: the erasure keeps it, the
 *     access export lists it;
 *   - the expiry mail says it to the person only, never in a subject.
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
const M196 = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/196_certificate_issuer.sql'),
    'utf8'
);
const CertificationService = require('../../src/services/CertificationService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__MIG196_ROLLBACK__');
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

describe('the migration file', () => {
    test('idempotent, qualified, never back-fills, ends with the console sync', () => {
        expect(M196.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
        const code = M196.split('\n')
            .filter((l) => !/^\s*--/.test(l))
            .join('\n');
        expect(code).toMatch(
            /ALTER TABLE public\.employee_certifications ADD COLUMN IF NOT EXISTS issuer text;/
        );
        expect(code).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
        expect(code).not.toMatch(/\bUPDATE\b/i);
        expect(code).not.toMatch(/\bDELETE\b/i);
        expect(code).not.toMatch(/\bDROP\b/i);
        expect(code).not.toMatch(/NOT NULL|DEFAULT/i);
        expect(code).not.toMatch(/ALTER TABLE (?!public\.)/);
    });
});

describe('the issuer as the register form sends it', () => {
    const N = CertificationService.normaliseIssuer;
    test('trimmed, one space between words, at most 200 characters', () => {
        expect(N('  Northfield Training Centre  ')).toBe('Northfield Training Centre');
        expect(N('Northfield\n\tTraining   Centre')).toBe('Northfield Training Centre');
        expect(N('a'.repeat(250))).toHaveLength(200);
        expect(N(`${'b'.repeat(199)}  c`)).toBe('b'.repeat(199));
    });
    test('blank or not a string is « not recorded » (null), never an empty string', () => {
        for (const v of ['', '   ', '\n\t', null, undefined, 42, ['x'], { a: 1 }])
            expect(N(v)).toBeNull();
    });
});

describe('the lists that must know the column', () => {
    test('the erasure keeps it as a fact of the certificate; the export lists it', () => {
        const DSR = require('../../src/services/DSRService');
        const cert = DSR.REDACTED_ON_ERASURE.find((c) => c.key === 'certifications');
        expect(cert.kept).toContain('issuer');
        expect(cert.erased).not.toContain('issuer');
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/DSRService.js'),
            'utf8'
        );
        expect(src).toMatch(
            /original_name, av_status, created_at, issuer\s+FROM employee_certifications/
        );
    });

    test('the expiry mail says it to the person, never to the line nor in a subject', () => {
        const { __test } = require('../../src/jobs/cert-expiry');
        const { blocks } = require('../../src/utils/emailTemplate');
        const label = { fr: 'expire dans 30 jours', en: 'expires within 30 days' };
        const withIssuer = __test.employeeMail(
            { skillName: 'Working at height', issuer: 'Northfield Training Centre' },
            3,
            label,
            '01/09/2026'
        );
        for (const lang of ['fr', 'en'])
            expect(JSON.stringify(withIssuer(blocks(lang)).blocks)).toContain(
                'Northfield Training Centre'
            );
        const without = __test.employeeMail(
            { skillName: 'Working at height' },
            3,
            label,
            '01/09/2026'
        );
        expect(JSON.stringify(without(blocks('en')).blocks)).not.toMatch(/Issued by/);
        const job = fs.readFileSync(path.join(__dirname, '../../src/jobs/cert-expiry.js'), 'utf8');
        // the line's mail is written in the tick and never names the issuer
        const team = job.slice(job.indexOf("kind: 'cert.expiry.team'"));
        expect(team).not.toMatch(/issuer/);
        const C = require('../../src/services/notificationCatalogue');
        const cat = JSON.stringify(C.CATALOGUE ? C.CATALOGUE : C);
        expect(cat).not.toMatch(/issuer/i);
    });
});

suite('migration 196 on the real schema', () => {
    test('the column is nullable text and the CHECK binds', async () => {
        const out = await inRolledBackTx(async (q) => {
            const col = await q.query(
                `SELECT data_type, is_nullable, column_default FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'employee_certifications'
                    AND column_name = 'issuer'`
            );
            const pair = await q.query(
                `SELECT e.id AS e, s.id AS s FROM employees e CROSS JOIN skills s
                  ORDER BY e.id, s.id LIMIT 1`
            );
            const { e, s } = pair.rows[0];
            const ins = (issuer) =>
                refused(
                    q,
                    `INSERT INTO public.employee_certifications (employee_id, skill_id, issued_on, issuer)
                     VALUES ($1, $2, CURRENT_DATE - 10, $3)`,
                    [e, s, issuer]
                );
            return {
                col: col.rows[0],
                ok: [
                    await ins(null),
                    await ins('Northfield Training Centre'),
                    await ins('x'.repeat(200)),
                ],
                bad: [
                    await ins(''),
                    await ins(' padded'),
                    await ins('padded '),
                    await ins('y'.repeat(201)),
                ],
            };
        });
        expect(out.col).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
        expect(out.ok).toEqual([null, null, null]);
        expect(out.bad).toEqual(['23514', '23514', '23514', '23514']);
    });

    test('a re-run changes nothing and back-fills no row', async () => {
        const out = await inRolledBackTx(async (q) => {
            const pair = await q.query(
                `SELECT e.id AS e, s.id AS s FROM employees e CROSS JOIN skills s
                  ORDER BY e.id, s.id LIMIT 1`
            );
            const { e, s } = pair.rows[0];
            const r = await q.query(
                `INSERT INTO public.employee_certifications (employee_id, skill_id, issued_on)
                 VALUES ($1, $2, CURRENT_DATE - 10) RETURNING id`,
                [e, s]
            );
            await q.query(M196);
            await q.query(M196);
            const after = await q.query(
                'SELECT issuer FROM public.employee_certifications WHERE id = $1',
                [r.rows[0].id]
            );
            const checks = await q.query(
                `SELECT COUNT(*)::int AS n FROM pg_constraint
                  WHERE conname = 'chk_employee_certifications_issuer'`
            );
            return { issuer: after.rows[0].issuer, checks: checks.rows[0].n };
        });
        expect(out).toEqual({ issuer: null, checks: 1 });
    });

    test('the register records the normalised issuer, and blank as not recorded', async () => {
        const out = await inRolledBackTx(async (q) => {
            const pair = await q.query(
                `SELECT e.id AS e, s.id AS s FROM employees e
                   CROSS JOIN skills s
                  WHERE e.is_active = true
                  ORDER BY e.id, s.id LIMIT 1`
            );
            const { e, s } = pair.rows[0];
            const actor = { id: 1, userType: 'admin' };
            const a = await CertificationService.record(
                {
                    employeeId: Number(e),
                    skillId: Number(s),
                    issuedOn: '2026-01-15',
                    issuer: '  Northfield   Training Centre ',
                },
                actor
            );
            const b = await CertificationService.record(
                {
                    employeeId: Number(e),
                    skillId: Number(s),
                    issuedOn: '2026-02-15',
                    issuer: '   ',
                },
                actor
            );
            const listed = await CertificationService.listCurrent([Number(e)]);
            return {
                a: a.issuer,
                b: b.issuer,
                listedHasIssuerField: listed.length > 0 && 'issuer' in listed[0],
            };
        });
        expect(out.a).toBe('Northfield Training Centre');
        expect(out.b).toBeNull();
        expect(out.listedHasIssuerField).toBe(true);
    });
});
