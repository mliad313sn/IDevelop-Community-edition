'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 A-17 — RESIDUAL: « constaté le JJ/MM/AAAA » on the briefs ALREADY
 * ARCHIVED, and on the plain-text twin of the e-mail.
 *
 * The lot-A fix corrected the PRODUCER only (`buildPayload`). It is not
 * retroactive and nothing repaired an archived payload, so the 45 briefs of
 * idevelop — the two of the finding, #332 and #351, among them — kept publishing
 * « B = ce qu’il y a à faire, constaté le jour d’envoi » on the page and would
 * have e-mailed it again on « Renvoyer », two lines above « Chiffres figés au
 * 14/09/2026 ». Measured before this fix, over HTTP on :3223: 4 GET (332/351 ×
 * FR/EN) → 200, generic sentence 1/1/1/1, date 0/0/0/0.
 *
 * The lot had the precedent in its own hands: M-11 repairs the dead deep links
 * of an archived payload AT RENDER TIME without rewriting the archive. This is
 * the same repair, on the same copy, keyed on the same instant the page already
 * prints two lines below (`computedAt`).
 *
 * The A-17 test of lot A cannot see any of this: it calls `buildPayload` and
 * never renders an archive. These tests do.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
}));

const S = require('../../src/services/DeptBriefService');
const { renderBlocks } = require('../../src/jobs/dept-brief').__test;
const ROOT = path.join(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/DeptBriefService.js'), 'utf8');

/** The §2.1 sentence ONLY — anchored on its own B clause, so the M-08 age note
 *  (« … was observed on … ») can never be counted as a hit. */
const GEN_FR = 'B = ce qu’il y a à faire, constaté le jour d’envoi';
const GEN_EN = 'B = what is outstanding, as observed on the sending day';
const DATE_FR = /B = ce qu’il y a à faire, constaté le (\d{2}\/\d{2}\/\d{4})/;
const DATE_EN = /B = what is outstanding, as observed on (\d{2}\/\d{2}\/\d{4})/;

/** The sentence as the 45 archived payloads of idevelop really carry it, copied
 *  from `SELECT payload->'natureOfFigures' FROM dept_briefs WHERE id = 332`. */
const LEGACY = Object.freeze({
    fr:
        'A = ce qui s’est passé pendant la période · B = ce qu’il y a à faire, constaté le jour d’envoi · ' +
        'C = ce qui arrive avant la prochaine période. Les vues du produit ne sont pas historisées : ' +
        'l’état est celui du jour d’envoi.',
    en:
        'A = what happened during the period · B = what is outstanding, as observed on the sending day · ' +
        'C = what falls due before the next period. The product views are not historised: ' +
        'the state is the state of the sending day.',
});

/** One archived brief, in the shape the job wrote before the producer fix. */
const archived = (over = {}) => ({
    version: 1,
    cadence: 'monthly',
    period: '2026-08',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    displayEnd: '2026-08-31T00:00:00.000Z',
    days: 31,
    horizonDays: 30,
    computedAt: '2026-09-14T08:19:07.943Z',
    units: [
        { unitId: 11, departmentId: 11, label: { fr: 'Riverside / IT', en: 'Riverside / IT' } },
    ],
    blocks: { A: [], B: [], C: [] },
    footer: null,
    flow: null,
    deltas: { basis: 'comparable', seriesStart: null },
    disclaimer: {
        fr: 'Les chiffres non mesurés sont affichés « — ».',
        en: 'Unmeasured figures are shown as "—".',
    },
    natureOfFigures: { ...LEGACY },
    ...over,
});

// ===========================================================================
describe('A-17 residual — an ARCHIVED brief names the day it was observed on', () => {
    test('the render-time repair substitutes the payload’s own computedAt, FR and EN', () => {
        const p = S.repairFrozenPayload(archived());
        expect(DATE_FR.exec(p.natureOfFigures.fr)[1]).toBe('14/09/2026');
        expect(DATE_EN.exec(p.natureOfFigures.en)[1]).toBe('14/09/2026');
        expect(p.natureOfFigures.fr).not.toContain(GEN_FR);
        expect(p.natureOfFigures.en).not.toContain(GEN_EN);
    });

    test('the repaired sentence is the PRODUCER’s own, word for word', () => {
        const p = S.repairFrozenPayload(archived());
        expect(p.natureOfFigures).toEqual(S.natureOfFiguresText('2026-09-14T08:19:07.943Z'));
    });

    test('it follows the instant, it is not a constant', () => {
        const p = S.repairFrozenPayload(archived({ computedAt: '2026-07-02T23:30:00.000Z' }));
        expect(DATE_FR.exec(p.natureOfFigures.fr)[1]).toBe('02/07/2026');
        expect(DATE_EN.exec(p.natureOfFigures.en)[1]).toBe('02/07/2026');
    });

    test('the ARCHIVE is never rewritten — the repair works on a copy', () => {
        const original = archived();
        const before = JSON.stringify(original);
        S.repairFrozenPayload(original);
        expect(JSON.stringify(original)).toBe(before);
        expect(original.natureOfFigures.fr).toContain(GEN_FR);
    });

    test('the repair is idempotent', () => {
        const once = S.repairFrozenPayload(archived());
        expect(JSON.stringify(S.repairFrozenPayload(once))).toBe(JSON.stringify(once));
    });

    test('a payload computed AFTER the producer fix is returned untouched', () => {
        const fresh = archived({
            natureOfFigures: S.natureOfFiguresText('2026-09-14T08:19:07.943Z'),
        });
        expect(JSON.stringify(S.repairFrozenPayload(fresh))).toBe(JSON.stringify(fresh));
    });

    test('a payload carrying some OTHER sentence is never second-guessed', () => {
        const other = archived({
            natureOfFigures: { fr: 'Chiffres figés.', en: 'Frozen figures.' },
        });
        expect(S.repairFrozenPayload(other).natureOfFigures).toEqual({
            fr: 'Chiffres figés.',
            en: 'Frozen figures.',
        });
    });

    test('NO instant to name ⇒ the generic sentence is KEPT, never « constaté le — »', () => {
        for (const bad of [null, undefined, '', 'not-a-date']) {
            const p = S.repairFrozenPayload(archived({ computedAt: bad }));
            expect(p.natureOfFigures.fr).toContain(GEN_FR);
            expect(p.natureOfFigures.fr).not.toContain('constaté le —');
            expect(p.natureOfFigures.en).not.toContain('as observed on —');
        }
    });

    test('the repair is WIRED into repairFrozenPayload, which the page and the resend both run', () => {
        // The CALL, not a commented-out copy of it: `^\s{4}` anchors it to the
        // body of repairFrozenPayload — a mutation that comments the line out
        // must fail this test, not slip past it.
        expect(SRC).toMatch(/^ {4}_repairNatureOfFigures\(p\);$/m);
        // The producer builds the sentence with the SAME function as the repair.
        expect(SRC).toMatch(/natureOfFigures: natureOfFiguresText\(observedAt\)/);
        const ctrl = fs.readFileSync(
            path.join(ROOT, 'src/controllers/DeptBriefController.js'),
            'utf8'
        );
        expect(ctrl).toMatch(
            /DeptBriefService\.repairFrozenPayload\(parsePayload\(row\.payload\)\)/
        );
        const job = fs.readFileSync(path.join(ROOT, 'src/jobs/dept-brief.js'), 'utf8');
        expect(job).toMatch(/const payload = repairFrozenPayload\(/);
    });
});

// ===========================================================================
describe('A-17 residual — the e-mail says the same thing in both its parts', () => {
    const render = (p) =>
        renderBlocks(p, { appName: 'IDevelop', accent: '#2563eb', baseUrl: '', maxLines: 7 });

    test('« Renvoyer » (repair → renderBlocks) e-mails the DATED sentence, FR and EN', () => {
        const out = render(S.repairFrozenPayload(archived()));
        expect(DATE_FR.exec(out.html)[1]).toBe('14/09/2026');
        expect(DATE_EN.exec(out.html)[1]).toBe('14/09/2026');
        expect(out.html).not.toContain(GEN_FR);
        expect(out.html).not.toContain(GEN_EN);
        // …and the frozen note two lines below names the SAME day: the page and
        // the e-mail no longer contradict themselves.
        expect(out.html).toContain('Chiffres figés au 14/09/2026');
    });

    test('the plain-text twin carries the §2.1 sentence too, right after the units', () => {
        const out = render(S.repairFrozenPayload(archived()));
        const lines = out.text.split('\n');
        expect(lines[1]).toBe('Riverside / IT');
        expect(lines[2]).toContain('A = ce qui s’est passé pendant la période');
        expect(DATE_FR.exec(out.text)[1]).toBe('14/09/2026');
    });

    test('a FRESH brief e-mails it in the text part as well', () => {
        const fresh = archived({
            natureOfFigures: S.natureOfFiguresText('2026-09-15T06:00:00.000Z'),
        });
        const out = render(fresh);
        expect(DATE_FR.exec(out.text)[1]).toBe('15/09/2026');
    });
});
