'use strict';
/**
 * 9-box movements (migration 175) without a database:
 *  - the DIRECTION rule over all 9 × 9 pairs of boxes;
 *  - the FR/EN parity of the new strings, and the stored labels left alone
 *    (pages name a box from its number, in the reader's language);
 *  - the copy rule applies to a calibration rationale: the calibrated
 *    placement's own stored reason IS the previous one, so pasting it back is
 *    refused;
 *  - a refused rationale at finalize answers in the reader's language;
 *  - the console's own dialog explains a refusal (never a native alert), and
 *    the page wraps at phone width.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
const mockFinalize = jest.fn();
jest.mock('../../src/services/TalentDepthService', () => ({
    finalizeCalibration: (...a) => mockFinalize(...a),
}));

const NineBox = require('../../src/services/NineBoxService');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tFor =
    (lng) =>
    (key, opts = {}) => {
        const [ns, k] = String(key).split(':');
        let dict = {};
        try {
            dict = JSON.parse(read(path.join('locales', lng, ns + '.json')));
        } catch (_) {
            dict = {};
        }
        const s = typeof dict[k] === 'string' ? dict[k] : opts.defaultValue;
        return String(s == null ? key : s).replace(/\{\{(\w+)\}\}/g, (_m, v) => opts[v] ?? '');
    };

const BANDS = ['low', 'medium', 'high'];
const cells = [];
for (const performance of BANDS)
    for (const potential of BANDS) cells.push({ performance, potential });

describe('movementDirection', () => {
    test('no previous placement → first, whatever the new one', () => {
        for (const c of cells) {
            expect(NineBox.movementDirection(null, c)).toBe('first');
            expect(NineBox.movementDirection(undefined, c)).toBe('first');
        }
    });

    test('all 81 pairs follow the two-axis rule; only a box change needs a reason', () => {
        const seen = { stable: 0, up: 0, down: 0, lateral: 0 };
        for (const a of cells) {
            for (const b of cells) {
                const dPerf = BANDS.indexOf(b.performance) - BANDS.indexOf(a.performance);
                const dPot = BANDS.indexOf(b.potential) - BANDS.indexOf(a.potential);
                const want =
                    dPerf === 0 && dPot === 0
                        ? 'stable'
                        : dPerf >= 0 && dPot >= 0
                          ? 'up'
                          : dPerf <= 0 && dPot <= 0
                            ? 'down'
                            : 'lateral';
                const got = NineBox.movementDirection(a, b);
                expect([a, b, got]).toEqual([a, b, want]);
                seen[got] += 1;
                const boxChanged =
                    NineBox.computeBox(a.performance, a.potential).box !==
                    NineBox.computeBox(b.performance, b.potential).box;
                expect(NineBox.movementNeedsJustification(got)).toBe(boxChanged);
            }
        }
        expect(seen).toEqual({ stable: 9, up: 27, down: 27, lateral: 18 });
    });

    test('named cases and the minimum length', () => {
        const m = (pp, pt, np, nt) =>
            NineBox.movementDirection(
                { performance: pp, potential: pt },
                { performance: np, potential: nt }
            );
        expect(m('low', 'low', 'high', 'high')).toBe('up');
        expect(m('medium', 'high', 'medium', 'medium')).toBe('down');
        expect(m('high', 'low', 'low', 'high')).toBe('lateral');
        expect(m('medium', 'medium', 'medium', 'medium')).toBe('stable');
        expect(NineBox.movementNeedsJustification('first')).toBe(false);
        expect(NineBox.constructor.MOVEMENT_MIN_JUSTIFICATION).toBe(20);
    });
});

describe('strings and stored labels', () => {
    test('identical nb_mv_* key sets in FR and EN, none empty, FR not a copy of EN', () => {
        const fr = require('../../locales/fr/talentx.json');
        const en = require('../../locales/en/talentx.json');
        const keys = (o) =>
            Object.keys(o)
                .filter((k) => k.startsWith('nb_mv_'))
                .sort();
        expect(keys(fr)).toEqual(keys(en));
        expect(keys(fr).length).toBeGreaterThan(40);
        for (const k of keys(fr)) {
            expect(String(fr[k]).trim()).not.toBe('');
            expect(String(en[k]).trim()).not.toBe('');
        }
        expect(fr.nb_mv_justification_prompt).not.toBe(en.nb_mv_justification_prompt);
        expect(fr.nb_mv_title).not.toBe(en.nb_mv_title);
    });

    test('the stored box label stays the legacy English name (pages localise at render)', () => {
        expect(NineBox.computeBox('high', 'high')).toEqual({ box: 9, label: 'Gold Star' });
        expect(NineBox.computeBox('low', 'low')).toEqual({ box: 1, label: 'Concern' });
        const src = read('src/services/NineBoxService.js');
        expect(src).not.toMatch(/'high-high': '[^']*[éèàÀ]/);
    });
});

describe('a calibration rationale obeys the copy rule', () => {
    const PREVIOUS = 'Clear progress leading the night teams through the year';
    const SUPER = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
    // The calibrated placement (id 51) carries the person's previous reason.
    const EV = {
        id: 51,
        employeeId: 138,
        status: 'approved',
        potential: 'high',
        performance: 'high',
        box: 9,
        boxLabel: 'Gold Star',
        movementSnapshotAt: '2026-09-01',
        previousEvaluationId: 40,
        previousBox: 6,
        previousPerformance: 'high',
        previousPotential: 'medium',
        movementJustification: PREVIOUS,
    };
    const TABLE = [EV, { id: 40, employeeId: 138, movementJustification: null }];

    beforeEach(() => {
        mockDb.run.mockClear();
        mockDb.get.mockReset().mockImplementation(async (sql, params) => {
            const s = String(sql);
            if (
                /SELECT \* FROM nine_box_evaluations\s+WHERE employee_id = \? AND status = 'approved'/.test(
                    s
                )
            )
                return EV;
            if (/SELECT movement_justification FROM nine_box_evaluations/.test(s)) {
                const [emp, excl] = params;
                const rows = TABLE.filter(
                    (r) => r.employeeId === emp && r.id !== excl && r.movementJustification
                );
                return rows[0] ? { movementJustification: rows[0].movementJustification } : null;
            }
            return null;
        });
    });

    const calibrate = (reason) =>
        NineBox.applyCalibration(SUPER, {
            employeeId: 138,
            toBox: 'high-medium',
            reason,
            sessionId: 7,
            cycleId: 3,
        });

    test('the previous reason pasted back (any case or spacing) is refused, nothing written', async () => {
        await expect(calibrate(PREVIOUS)).rejects.toMatchObject({
            code: 'MOVEMENT_JUSTIFICATION_COPY',
            status: 400,
        });
        await expect(calibrate('  ' + PREVIOUS.toUpperCase() + ' ')).rejects.toMatchObject({
            code: 'MOVEMENT_JUSTIFICATION_COPY',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a genuine rationale passes the rule', async () => {
        const err = await calibrate('Session: performance brought back to the site panel').catch(
            (e) => e
        );
        expect(err && err.code ? String(err.code) : '').not.toMatch(/^MOVEMENT_JUSTIFICATION/);
    });

    test('the movement UPDATE never blanks a stored reason', async () => {
        await calibrate('Session: performance brought back to the site panel').catch(() => null);
        const upd = mockDb.run.mock.calls.find(([s]) => /movement_justification =/.test(s));
        expect(upd).toBeTruthy();
        expect(upd[0]).toMatch(/movement_justification = COALESCE\(\?, movement_justification\)/);
    });

    describe('at finalize, the refusal is answered in the reader language', () => {
        const appAs = (lng) => {
            const router = require('../../src/routes/v2-capability');
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = SUPER;
                req.isAuthenticated = () => true;
                req.t = tFor(lng);
                next();
            });
            app.use('/v2/cap', router);
            return app;
        };

        test.each([
            ['fr', 'copy', PREVIOUS],
            ['en', 'copy', PREVIOUS],
            ['fr', 'required', 'too short'],
            ['en', 'required', 'too short'],
        ])('%s / %s', async (lng, kind, reason) => {
            const thrown = await calibrate(reason).catch((e) => e);
            expect(thrown && thrown.i18n).toBeTruthy();
            mockFinalize.mockReset().mockRejectedValue(thrown);
            const r = await request(appAs(lng))
                .post('/v2/cap/calibration/7/finalize')
                .set('Accept', 'application/json')
                .send({});
            expect(r.status).toBe(400);
            const expected = tFor(lng)(`talentx:nb_mv_err_justification_${kind}`, { min: 20 });
            expect(r.body.error).toBe(expected);
            expect(r.body.code).toBe(thrown.code);
        });
    });
});

describe('console and movements page', () => {
    const consoleView = read('views/pages/talent/nine-box-console.ejs');
    const page = read('views/pages/talent/nine-box-movements.ejs');

    test('a refused reason is explained in the app dialog, never a native alert', () => {
        const ask = consoleView.slice(consoleView.indexOf('async _askJustification('));
        const body = ask.slice(0, ask.indexOf('\n  },'));
        expect(body).toMatch(/promptDialog\([^)]*\{ multiline:true, required:true \}\)/);
        expect(body.replace(/\/\/[^\n]*/g, '')).not.toMatch(/\balert\(/);
    });

    test('the tab row wraps and the grid scrolls inside its panel at phone width', () => {
        expect(consoleView).toMatch(/class="nb-tabs" style="display:flex;flex-wrap:wrap/);
        expect(consoleView).toMatch(/#nb-grid-panel\{overflow-x:auto/);
        expect(consoleView).toContain('href="/talent/nine-box/movements"');
    });

    test('the movements page writes the direction (glyph + word) and uses real table headers', () => {
        expect(page).toMatch(/<th scope="row">/);
        expect(page).toMatch(/<th scope="col">/);
        expect(page).toContain("T('nb_mv_' + d)");
        expect(page).toContain('/api/ninebox/movements.csv');
        // No inline script: nothing on this page needs a CSP exemption.
        expect(page).not.toMatch(/<script/);
    });

    test('routes: the CSV is mounted before /api/ninebox/:id, with the console guard', () => {
        const routes = read('src/routes/index.js');
        const csv = routes.indexOf("'/api/ninebox/movements.csv'");
        const byId = routes.indexOf("'/api/ninebox/:id'");
        expect(csv).toBeGreaterThan(-1);
        expect(csv).toBeLessThan(byId);
        expect(routes).toMatch(
            /router\.get\('\/talent\/nine-box\/movements', requireManagerOrAdmin, NineBoxController\.movementsPage\)/
        );
        expect(routes).toMatch(
            /router\.get\('\/api\/ninebox\/movements\.csv', requireManagerOrAdmin, NineBoxController\.movementsCsv\)/
        );
    });
});

describe('the movements CSV', () => {
    test('filters are validated against known values; every cell goes through the formula guard', async () => {
        jest.resetModules();
        const NB = require('../../src/services/NineBoxService');
        const seen = [];
        jest.spyOn(NB, 'movements').mockImplementation(async (_u, filters) => {
            seen.push(filters);
            return {
                rows: [
                    {
                        firstName: '=HYPERLINK("http://x")',
                        lastName: 'Fixture',
                        employeeNumber: '+1',
                        siteName: '@site',
                        departmentName: '-dept',
                        cycleLabel: null,
                        box: 9,
                        status: 'approved',
                        approvedAt: '2026-05-04T10:00:00Z',
                        movement: {
                            direction: 'up',
                            previous: { box: 1 },
                            justification: '=cmd|" /C calc"!A0 reason long enough',
                            requiresJustification: true,
                            justifiedBy: 'admin',
                            justifiedAt: '2026-05-04T10:00:00Z',
                        },
                    },
                ],
                counts: {},
                matrix: [],
                options: {},
            };
        });
        jest.spyOn(NB, '_audit').mockResolvedValue(undefined);
        const ctl = require('../../src/controllers/NineBoxController');
        const app = express();
        app.use((req, _res, next) => {
            req.user = { id: 1, userType: 'admin', role: 'superadmin' };
            req.t = tFor('en');
            req.language = 'en';
            next();
        });
        app.get('/csv', ctl.movementsCsv);
        const r = await request(app).get(
            '/csv?cycle=1;DROP&siteId=-3&departmentId=12&direction=sideways'
        );
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toMatch(/text\/csv/);
        expect(seen[0]).toEqual({ cycle: '', siteId: '', departmentId: '12', direction: '' });
        expect(r.text).not.toMatch(/(^|[;,])"?=HYPERLINK/m);
        expect(r.text).not.toMatch(/(^|[;,])"?=cmd/m);
        expect(r.text).toContain('Gold Star');
        expect(r.text).toContain('Moved up');
        const r2 = await request(app).get('/csv?cycle=none&direction=down');
        expect(r2.status).toBe(200);
        expect(seen[1]).toEqual({ cycle: 'none', siteId: '', departmentId: '', direction: 'down' });
    });
});
