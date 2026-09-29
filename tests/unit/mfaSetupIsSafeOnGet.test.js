'use strict';

/**
 * CODE-REVIEW-2026-09-17 [BLOQUANT/security]:
 * "Un GET sur /v2/uam/mfa/setup desactive en silence un second facteur deja actif".
 *
 * PROVEN BY EXECUTION before the fix, against idevelop inside a rolled-back
 * transaction (_probe-mfa-setup.js): with a CONFIRMED enrolment in place, one
 * call to `MfaService.beginSetup` rotated `secret_enc` and set
 * `confirmed_at = NULL`, and `MfaService.isActive` then returned false — the
 * account had silently dropped to a single factor and the authenticator
 * already on the user's phone no longer worked.
 *
 * Why that was reachable, and why it is a security defect rather than a bug:
 * the only caller is `router.get('/mfa/setup')`. A GET carries no CSRF token
 * and needs no form, so ANY top-level navigation a third-party page can cause
 * — a link, a redirect, a prefetch — turned off a victim's second factor while
 * they were signed in. The product already has the deliberate path for this:
 * `POST /mfa/disable`, which demands a current TOTP or backup code.
 *
 * The fix guards the upsert on `confirmed_at IS NULL` and reports
 * `started: false`; the route then redirects instead of rendering a QR code.
 * Re-running the probe with the guard removed turns exactly these assertions
 * red again, which is what makes them worth keeping.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const MfaService = require('../../src/services/MfaService');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
});

const lastRunSql = () => String(mockDb.run.mock.calls[mockDb.run.mock.calls.length - 1][0]);

describe('beginSetup cannot destroy an enrolment that is already confirmed', () => {
    test('the upsert is guarded on confirmed_at IS NULL', async () => {
        mockDb.run.mockResolvedValue({ changes: 1 });
        await MfaService.beginSetup({ userType: 'admin', userId: 7, accountLabel: 'a' });

        const sql = lastRunSql();
        // The guard, tolerant of any whitespace the formatter chooses.
        expect(sql).toMatch(/ON CONFLICT\s*\(\s*user_type\s*,\s*user_id\s*\)/i);
        expect(sql).toMatch(/WHERE\s+mfa_secrets\.confirmed_at\s+IS\s+NULL/i);
        // And it still clears the confirmation for the row it IS allowed to
        // touch, otherwise a restarted enrolment would count as confirmed.
        expect(sql).toMatch(/confirmed_at\s*=\s*NULL/i);
    });

    test('a refused write (0 rows) reports started:false and hands out NO secret', async () => {
        mockDb.run.mockResolvedValue({ changes: 0 });
        const out = await MfaService.beginSetup({
            userType: 'admin',
            userId: 7,
            accountLabel: 'a',
        });

        expect(out.started).toBe(false);
        expect(out.secret).toBeNull();
        // A null otpauthUrl matters as much as the null secret: the route feeds
        // it to the QR encoder, so leaking one here would still print a code
        // for a secret the database refused to store.
        expect(out.otpauthUrl).toBeNull();
    });

    test('a first-time or unconfirmed enrolment still proceeds', async () => {
        mockDb.run.mockResolvedValue({ changes: 1 });
        const out = await MfaService.beginSetup({
            userType: 'employee',
            userId: 42,
            accountLabel: 'someone',
        });

        expect(out.started).toBe(true);
        expect(typeof out.secret).toBe('string');
        expect(out.secret.length).toBeGreaterThan(0);
        expect(out.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
        expect(out.otpauthUrl).toContain(`secret=${out.secret}`);
    });

    test('two enrolments do not share a secret', async () => {
        mockDb.run.mockResolvedValue({ changes: 1 });
        const a = await MfaService.beginSetup({ userType: 'admin', userId: 1, accountLabel: 'a' });
        const b = await MfaService.beginSetup({ userType: 'admin', userId: 2, accountLabel: 'b' });
        expect(a.secret).not.toBe(b.secret);
    });
});

describe('the GET route renders nothing when two-factor is already on', () => {
    const src = read('src/routes/v2-uam.js');
    const at = (re) => {
        const m = re.exec(src);
        expect(m).not.toBeNull();
        return m.index;
    };
    const setup = src.slice(
        at(/router\.get\(\s*'\/mfa\/setup'/),
        at(/router\.post\(\s*'\/mfa\/verify'/)
    );

    test('it reads `started` and leaves before the QR code is built', () => {
        expect(setup).toMatch(
            /const\s*\{[^}]*\bstarted\b[^}]*\}\s*=\s*await MfaService\.beginSetup/s
        );
        expect(setup).toMatch(/if\s*\(\s*!started\s*\)/);
        // The early return must come BEFORE the QR encoder, or a refused setup
        // still renders a code for a secret that was never stored.
        expect(setup.indexOf('if (!started)')).toBeLessThan(setup.indexOf('toDataURL'));
        expect(setup).toMatch(/return res\.redirect\('\/v2\/uam\/mfa\/manage'\)/);
    });

    test('the reader is told why, in their own language', () => {
        expect(setup).toMatch(/flash:mfa_already_active/);
        for (const lang of ['fr', 'en']) {
            const flash = JSON.parse(read(`locales/${lang}/flash.json`));
            expect(typeof flash.mfa_already_active).toBe('string');
            expect(flash.mfa_already_active.length).toBeGreaterThan(0);
        }
        const fr = JSON.parse(read('locales/fr/flash.json'));
        const en = JSON.parse(read('locales/en/flash.json'));
        expect(fr.mfa_already_active).not.toBe(en.mfa_already_active);
    });

    test('turning the factor OFF is still a POST that demands a code', () => {
        // The safe GET is only half the story: the destructive operation has to
        // keep existing, behind CSRF and a current code.
        const disable = src.slice(at(/router\.post\(\s*'\/mfa\/disable'/));
        expect(disable).toMatch(/verifyAtLogin/);
        expect(disable).toMatch(/consumeBackupCode/);
        expect(disable).toMatch(/MfaService\.disable/);
    });
});
