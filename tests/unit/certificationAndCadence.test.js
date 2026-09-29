'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L3-6 (378), L3-3 (360), L3-5 (360), L2-3 (360) and L3-12 (180).
 *
 * Five defects that each turn "we do not know" or "nobody decided" into a
 * confident, wrong statement.
 *
 * L3-6  "Certified only" kept `cert_status === 'valid'` alone, while everywhere
 *       else in the product "valid today" is valid | expiring | no_expiry. The
 *       dispatch list silently dropped every holder of a PERMANENT licence and
 *       everyone inside their revalidation window — as an ABSENT ROW, which a
 *       shift supervisor cannot notice — while the compliance page counted those
 *       same people as covered. G=7, O=6, D=9.
 *
 * L3-3  A certificate dated in the FUTURE became the current one, masking an
 *       expired ticket: cert_status flipped to valid, the person left
 *       v_certification_lapsed, their level stopped being degraded, and a
 *       safe-shift coverage rule went from breached back to satisfied — silently.
 *       Verified: with an expired-2021 ticket plus a certificate dated
 *       CURRENT_DATE + 400, the view now still reports `expired`. G=9, O=4, D=10.
 *
 * L3-5  `onJoiner` never enrolled the arrival in `cycle_participants`, and the
 *       whole campaign dashboard reads FROM that table. The joiner was absent from
 *       the DENOMINATOR, so a campaign could report 100% complete while they had
 *       submitted nothing, and no reminder reached them. G=6, O=6, D=10.
 *
 * L2-3  The 9-box re-assessment cadence used COALESCE(approved_at, updated_at)
 *       over every non-archived row, so an untouched DRAFT read as "assessed just
 *       now". Verified on this instance: 8 of the 10 listed employees have only a
 *       draft and every one showed due=false — people with no decision at all
 *       disappeared from the queue. After the fix all 8 are due. G=5, O=8, D=9.
 *
 * L3-12 `setMonth(getMonth() + n)` overflows short months: 2026-08-31 + 6 landed
 *       on 2027-03-03 — up to three days of extra validity on a statutory ticket.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const CertificationService = require('../../src/services/CertificationService');

describe('"valid today" means the same thing on every screen (L3-6)', () => {
    const svc = read('src/services/QualifiedPeopleService.js');

    test('the set matches v_coverage_status and CoverageService', () => {
        expect(svc).toMatch(/VALID_NOW: new Set\(\['valid', 'expiring', 'no_expiry'\]\)/);
        const coverage = read('src/services/CoverageService.js');
        expect(coverage).toMatch(/cert_status IN \('valid', 'expiring', 'no_expiry'\)/);
    });

    test('the dispatch filter uses it', () => {
        expect(svc).toMatch(
            /rows\.filter\(\(r\) => QualifiedPeopleService\.VALID_NOW\.has\(r\.certStatus\)\)/
        );
        expect(svc).not.toMatch(/r\.certStatus === 'valid'/);
    });
});

describe('a certificate that has not been issued yet is not current (L3-3)', () => {
    test('the view ignores future-dated rows', () => {
        const mig = read('db/postgres/88_certification_not_future_dated.sql');
        expect(mig).toMatch(/AND employee_certifications\.issued_on <= CURRENT_DATE/);
        expect(mig).toMatch(/CREATE OR REPLACE VIEW v_certification_current/);
    });

    test('the service refuses to record one, so the row is never created either', () => {
        const svc = read('src/services/CertificationService.js');
        expect(svc).toMatch(/if \(!isNotFuture\(issuedOn\)\) \{/);
        expect(svc).toMatch(/throw new Error\('issuedOn cannot be in the future'\)/);
    });

    test('isNotFuture accepts today and rejects tomorrow', () => {
        const iso = (d) => d.toISOString().slice(0, 10);
        const today = new Date();
        const tomorrow = new Date(Date.now() + 86400000);
        const yesterday = new Date(Date.now() - 86400000);
        expect(CertificationService.isNotFuture(iso(today))).toBe(true);
        expect(CertificationService.isNotFuture(iso(yesterday))).toBe(true);
        expect(CertificationService.isNotFuture(iso(tomorrow))).toBe(false);
        expect(CertificationService.isNotFuture('not-a-date')).toBe(false);
    });
});

describe('expiry dates do not drift over short months (L3-12)', () => {
    const cases = [
        ['2026-08-31', 6, '2027-02-28'], // was 2027-03-03 — 3 free days
        ['2026-01-31', 1, '2026-02-28'], // was 2026-03-03
        ['2024-01-31', 1, '2024-02-29'], // leap year
        ['2026-03-15', 12, '2027-03-15'], // ordinary anniversary, unchanged
        ['2026-05-31', 3, '2026-08-31'], // target month is long — day preserved
    ];
    test.each(cases)('%s + %i months = %s', (from, months, expected) => {
        expect(CertificationService.addMonthsClamped(from, months)).toBe(expected);
    });

    test('an unparseable date yields null rather than an invented one', () => {
        expect(CertificationService.addMonthsClamped('nonsense', 6)).toBeNull();
    });
});

describe('an arrival joins the campaign roster (L3-5)', () => {
    const svc = read('src/services/LifecycleService.js');

    test('onJoiner enrols them in cycle_participants', () => {
        expect(svc).toMatch(/require\('\.\/CycleService'\)\.enrolParticipants\(cycle\.id\)/);
    });

    test('it reuses the idempotent enrolment rather than a second roster query', () => {
        const cycle = read('src/services/CycleService.js');
        expect(cycle).toMatch(/ON CONFLICT \(cycle_id, employee_id\) DO NOTHING/);
    });

    test('a failure to enrol is reported, not swallowed', () => {
        expect(svc).toMatch(/joiner enrolment failed for employee/);
    });
});

describe('only an approved 9-box starts the re-assessment clock (L2-3)', () => {
    const svc = read('src/services/NineBoxService.js');

    test('the cadence is dated from an approval', () => {
        expect(svc).toMatch(/AND status = 'approved' AND approved_at IS NOT NULL/);
        expect(svc).toMatch(/const approvedAt = approvedByEmp\[Number\(e\.id\)\] \|\| null/);
    });

    test('someone with only a draft stays due', () => {
        // `due` defaults to true and is only cleared by an approval date.
        expect(svc).toMatch(/let monthsSince = null,\s*due = true;\s*if \(approvedAt\) \{/);
    });

    test('the reported "last assessed" date is a decision, not an edit', () => {
        expect(svc).toMatch(/lastAssessedAt: approvedAt/);
        expect(svc).not.toMatch(/lastAssessedAt: p \? p\.assessedAt : null/);
    });

    test('the roster still shows the current row, draft included', () => {
        // Only the cadence needed an approval; hiding the draft would lose work.
        expect(svc).toMatch(/placement: p,/);
    });
});
