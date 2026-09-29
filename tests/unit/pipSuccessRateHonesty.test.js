'use strict';
/**
 * PIP SUCCESS RATE — an absence of measurement is not a result.
 *
 * Reproduced on live data before this guard existed: 4 PIPs, NONE of them ever
 * observed in `active`, three closed administratively (one opened at 14:19 and
 * closed "success" at 14:24, five minutes later) — and the talent-development
 * dashboard published "67 % — 2/3 closed" as a performance measure.
 *
 * The rule locked here:
 *   1. A closure is MEASURED only when the plan period it claims to judge had
 *      actually elapsed: a declared `ends_on`, already reached at closure.
 *      No end date, or closed before it => not measured. Fails CLOSED.
 *   2. A percentage is published only over at least `minMeasured` measured
 *      closures (the survey module's small-group suppression threshold).
 *   3. Otherwise successRate is null and the tile reads "not measured"
 *      (dash:rd_not_measured) — never a confident percentage, never an em dash
 *      that reads as "zero".
 *   4. The excluded plans are SURFACED, not deleted: unmeasuredClosed and
 *      neverStarted stay in the payload and on the tile.
 *
 * DB mocked here; the SQL predicate itself is proven end-to-end by the
 * rolled-back live probe (5 measured closures => 60 %, while the two closures
 * whose period had not elapsed would have made it 70 %).
 */

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
    getFilteredEmployees: async () => [],
}));

const DashboardController = require('../../src/controllers/DashboardController');

const EMPTY = {};
/** Drive the real controller with one pips aggregate row; return `payload.pip`. */
async function pipBlock(pipRow) {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    // getTalentDevelopment issues 5 db.get calls in order:
    // coaching, idp, idpActions, pips, levelUps  (coachCtx + nine use db.all)
    mockDb.get
        .mockResolvedValueOnce(EMPTY) // coaching
        .mockResolvedValueOnce(EMPTY) // idp
        .mockResolvedValueOnce(EMPTY) // idp actions
        .mockResolvedValueOnce(pipRow) // pips
        .mockResolvedValueOnce(EMPTY); // level-ups
    let payload = null;
    await new DashboardController().getTalentDevelopment(
        { user: { id: 1, userType: 'admin', role: 'superadmin' }, query: {} },
        {
            json: (o) => {
                payload = o;
            },
            status() {
                return this;
            },
        }
    );
    return payload.pip;
}

/** The pips aggregate row shape the controller reads. */
const agg = (o = {}) => ({
    total: 0,
    proposed: 0,
    active: 0,
    closedSuccess: 0,
    closedFailure: 0,
    measuredSuccess: 0,
    measuredFailure: 0,
    ...o,
});

describe('DashboardController.getTalentDevelopment — the PIP denominator', () => {
    test('the reproduced live shape: 3 paper closures, 0 measured => no percentage', async () => {
        const p = await pipBlock(
            agg({
                total: 4,
                proposed: 1,
                active: 0,
                closedSuccess: 2,
                closedFailure: 1,
                measuredSuccess: 0,
                measuredFailure: 0,
            })
        );
        expect(p.successRate).toBeNull(); // was 67
        expect(p.successRate).not.toBe(67);
        expect(p.measuredClosed).toBe(0);
        expect(p.unmeasuredClosed).toBe(3); // the signal, kept
        expect(p.neverStarted).toBe(1);
    });

    test('closures whose plan period never elapsed are EXCLUDED from the rate', async () => {
        // 3 measured successes + 2 measured failures, plus 2 unmeasured successes.
        // Honest = 3/5 = 60. Counting all closures would read 5/7 = 71.
        const p = await pipBlock(
            agg({
                total: 8,
                proposed: 1,
                closedSuccess: 5,
                closedFailure: 2,
                measuredSuccess: 3,
                measuredFailure: 2,
            })
        );
        expect(p.measuredClosed).toBe(5);
        expect(p.successRate).toBe(60);
        expect(p.successRate).not.toBe(71);
        expect(p.unmeasuredClosed).toBe(2);
    });

    test('too few measured closures to publish a ratio => not measured, counts kept', async () => {
        const p = await pipBlock(
            agg({
                total: 3,
                closedSuccess: 3,
                measuredSuccess: 3,
                measuredFailure: 0,
            })
        );
        expect(p.measuredClosed).toBe(3);
        expect(p.measuredClosed).toBeLessThan(p.minMeasured);
        expect(p.successRate).toBeNull(); // never a triumphant 100 % over 3
        expect(p.minMeasured).toBeGreaterThanOrEqual(4);
    });

    // 3.23.17: the product's single "too few to publish" floor is 5 (surveys,
    // DEI, bias detection, department brief) — 4 closures are not publishable.
    test('exactly at the threshold the rate IS published', async () => {
        const p = await pipBlock(
            agg({
                total: 5,
                closedSuccess: 5,
                measuredSuccess: 5,
                measuredFailure: 0,
            })
        );
        expect(p.minMeasured).toBe(5);
        expect(p.measuredClosed).toBe(5);
        expect(p.successRate).toBe(100);
    });

    test('4 measured closures stay below the floor', async () => {
        const p = await pipBlock(
            agg({ total: 4, closedSuccess: 4, measuredSuccess: 4, measuredFailure: 0 })
        );
        expect(p.successRate).toBeNull();
    });

    test('no PIPs at all => not measured, and no division by zero', async () => {
        const p = await pipBlock(agg());
        expect(p.successRate).toBeNull();
        expect(p.measuredClosed).toBe(0);
        expect(p.unmeasuredClosed).toBe(0);
    });

    test('the aggregate gates the measured counters on an ELAPSED plan period', async () => {
        await pipBlock(agg());
        const sql = mockDb.get.mock.calls[3][0];
        expect(sql).toMatch(/measured_success/);
        expect(sql).toMatch(/measured_failure/);
        // both counters must require a declared end date that had been reached
        const measured = sql.slice(sql.indexOf('measured_success') - 400);
        expect(measured).toMatch(/ends_on IS NOT NULL/);
        expect(measured).toMatch(/updated_at >= p\.ends_on/);
    });
});

// ---------------------------------------------------------------------------
// The client tile. `renderTalentKPIs` is EXECUTED (extracted from the shipped
// public/js/dashboard.js and run in a sandbox with a stub DOM), not regexed:
// a test that only pins the spelling of the source would pass while the tile
// printed a fabricated percentage.
// ---------------------------------------------------------------------------
function loadRenderTalentKPIs(i18n) {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
    const start = src.indexOf('function renderTalentKPIs(');
    expect(start).toBeGreaterThan(-1);
    // brace-match the function so the slice is exact
    let i = src.indexOf('{', start),
        depth = 0,
        end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
    }
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const esc = (s) =>
        String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    const pctClass = (v, good, warn) =>
        v == null ? 'neutral' : v >= good ? 'good' : v >= warn ? 'warning' : 'critical';
    const el = { innerHTML: '' };
    const document = { getElementById: () => el };
    // renderTalentKPIs now interpolates its sub-lines through the bundle's own
    // fmt() (positional {0}/{1} placeholders, so French word order can differ).
    // Extract the REAL one rather than reimplementing it here: a private copy
    // would let the two drift and this suite would still pass.
    const fstart = src.indexOf('function fmt(');
    expect(fstart).toBeGreaterThan(-1);
    let fi = src.indexOf('{', fstart),
        fdepth = 0,
        fend = -1;
    for (; fi < src.length; fi++) {
        if (src[fi] === '{') fdepth++;
        else if (src[fi] === '}') {
            fdepth--;
            if (fdepth === 0) {
                fend = fi + 1;
                break;
            }
        }
    }
    expect(fend).toBeGreaterThan(fstart);
    const fmtSrc = src.slice(fstart, fend);

    // eslint-disable-next-line no-new-func
    const make = new Function(
        'document',
        'I18N',
        'esc',
        'pctClass',
        `${fmtSrc}; const fmtPct = (v) => v + '%'; ${body}; return renderTalentKPIs;`
    );
    return { render: make(document, i18n, esc, pctClass), el };
}

const payload = (pip) => ({
    coaching: {
        coachingActive: 0,
        mentoringActive: 0,
        notStarted: 0,
        avgProgress: 0,
        active: 0,
        completed: 0,
        cancelled: 0,
    },
    idp: { active: 0, draft: 0, completed: 0, completionPct: null, actionDone: 0, actionTotal: 0 },
    nineBox: { assessed: 0, top: 0, risk: 0 },
    skillLevelUps90d: 0,
    pip,
});

const FR = {
    rdNotMeasured: 'Non mesuré',
    rdNotMeasuredTitle: "Jamais évalué — aucune donnée, ce n'est pas un niveau 0",
};

describe('the talent-development tile', () => {
    test('unmeasured => "not measured" + its tooltip, never a percentage', () => {
        const { render, el } = loadRenderTalentKPIs(FR);
        render(
            payload({
                total: 4,
                proposed: 1,
                active: 0,
                closedSuccess: 2,
                closedFailure: 1,
                closed: 3,
                measuredSuccess: 0,
                measuredFailure: 0,
                measuredClosed: 0,
                unmeasuredClosed: 3,
                neverStarted: 1,
                minMeasured: 4,
                successRate: null,
            })
        );
        const html = el.innerHTML;
        expect(html).toContain('Non mesuré');
        expect(html).toContain('Jamais évalué'); // the localized tooltip
        expect(html).not.toMatch(/>\s*67%\s*</); // the old fabricated value
        expect(html).not.toMatch(/2\/3 closed/); // the old fabricated sub
        // the excluded plans are still on screen
        expect(html).toMatch(/0 of 3 closures ran their plan period/);
        expect(html).toMatch(/1 never started/);
    });

    test('measured => the percentage, over the measured denominator only', () => {
        const { render, el } = loadRenderTalentKPIs(FR);
        render(
            payload({
                total: 8,
                proposed: 0,
                active: 0,
                closedSuccess: 5,
                closedFailure: 2,
                closed: 7,
                measuredSuccess: 3,
                measuredFailure: 2,
                measuredClosed: 5,
                unmeasuredClosed: 2,
                neverStarted: 0,
                minMeasured: 4,
                successRate: 60,
            })
        );
        const html = el.innerHTML;
        expect(html).toMatch(/>60%</);
        expect(html).toMatch(/3\/5 plans run to term/);
        expect(html).not.toContain('Non mesuré');
    });

    test('falls back to English when the i18n bundle is missing, never to a number', () => {
        const { render, el } = loadRenderTalentKPIs({});
        render(
            payload({
                total: 1,
                proposed: 0,
                active: 0,
                closedSuccess: 1,
                closedFailure: 0,
                closed: 1,
                measuredSuccess: 1,
                measuredFailure: 0,
                measuredClosed: 1,
                unmeasuredClosed: 0,
                neverStarted: 0,
                minMeasured: 4,
                successRate: null,
            })
        );
        expect(el.innerHTML).toContain('Not measured');
        expect(el.innerHTML).not.toMatch(/>100%</);
    });
});
