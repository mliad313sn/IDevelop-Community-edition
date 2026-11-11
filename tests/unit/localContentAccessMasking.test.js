'use strict';

/**
 * The local content report (nationality by unit) is for a SuperAdmin or an
 * administrator holding view_local_content — never a manager — and only
 * while the localContent module is on. Every breakdown cell under 5 people
 * is masked, with complementary suppression, on the page and in the CSV.
 * People whose operating country is unknown are counted apart.
 */
process.env.NODE_ENV = 'test';

const mockDb = {
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
};
jest.mock('../../src/config/database', () => mockDb);
const mockSettings = { featureLocalContent: true, localContentHomeCountry: '' };
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => (k in mockSettings ? mockSettings[k] : d)),
}));

const C = require('../../src/controllers/LocalContentController');
const { PERMISSIONS } = require('../../src/config/permissions');
const accessProfiles = require('../../src/config/accessProfiles');

const SUPER = { userType: 'admin', role: 'superadmin', id: 1 };
const LOCAL = (permissions) => ({ userType: 'admin', role: 'localadmin', id: 7, permissions });

function res() {
    const r = { headers: {} };
    r.redirect = jest.fn(() => r);
    r.render = jest.fn(() => r);
    r.send = jest.fn(() => r);
    r.status = jest.fn(() => r);
    r.setHeader = jest.fn((k, v) => (r.headers[k] = v));
    return r;
}
function req(user, query = {}) {
    const flashes = [];
    return {
        user,
        query,
        t: (k) => k,
        flash: (type, msg) => flashes.push([type, msg]),
        flashes,
    };
}

beforeEach(() => {
    mockSettings.featureLocalContent = true;
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
});

describe('maskSmallGroups', () => {
    const mask = C.constructor.maskSmallGroups;
    test('< 5 masked; one lone masked group drags the next smallest with it', () => {
        const rows = [
            { name: 'A', headcount: 20, nationals: 15, expats: 5, unspecified: 0 },
            { name: 'B', headcount: 7, nationals: 4, expats: 3, unspecified: 0 },
            { name: 'C', headcount: 3, nationals: 1, expats: 2, unspecified: 0 },
        ];
        mask(rows);
        expect(rows.map((r) => r.masked || false)).toEqual([false, 'complementary', 'small']);
        expect(rows[2]).toMatchObject({ headcount: null, nationals: null, expats: null });
        expect(rows[0]).toMatchObject({ headcount: 20, nationals: 15 });
    });
    test('two small groups hide each other; none small changes nothing', () => {
        const two = [
            { name: 'A', headcount: 20 },
            { name: 'B', headcount: 2 },
            { name: 'C', headcount: 1 },
        ];
        mask(two);
        expect(two.map((r) => r.masked || false)).toEqual([false, 'small', 'small']);
        const none = [
            { name: 'A', headcount: 5 },
            { name: 'B', headcount: 9 },
        ];
        mask(none);
        expect(none.some((r) => r.masked)).toBe(false);
        expect(mask(null)).toEqual([]);
    });
});

describe('who may open the report', () => {
    test('SuperAdmin or view_local_content — never a manager, an employee or another admin', () => {
        expect(C.canSeeReport(SUPER)).toBe(true);
        expect(C.canSeeReport(LOCAL(['view_local_content']))).toBe(true);
        expect(C.canSeeReport(LOCAL(['view_compliance', 'manage_succession']))).toBe(false);
        expect(C.canSeeReport({ userType: 'manager', id: 2 })).toBe(false);
        expect(C.canSeeReport({ userType: 'employee', id: 3 })).toBe(false);
        expect(C.canSeeReport(null)).toBe(false);
    });
    test('the slug is read-only and in no access profile', () => {
        const p = PERMISSIONS.find((x) => x.slug === 'view_local_content');
        expect(p).toMatchObject({ write: false, group: 'governance' });
        const profiles = accessProfiles.ACCESS_PROFILES;
        const list = Array.isArray(profiles) ? profiles : Object.values(profiles);
        for (const prof of list) expect(prof.slugs || []).not.toContain('view_local_content');
    });
    test('a manager is sent back to the dashboard, and nothing is read', async () => {
        const r = res();
        const q = req({ userType: 'manager', id: 2 });
        await C.index(q, r);
        expect(r.redirect).toHaveBeenCalledWith('/dashboard');
        expect(q.flashes).toEqual([['error', 'flash:no_permission']]);
        expect(mockDb.get).not.toHaveBeenCalled();
        expect(mockDb.all).not.toHaveBeenCalled();
    });
    test('module off: the module message, whoever asks', async () => {
        mockSettings.featureLocalContent = false;
        const r = res();
        const q = req(SUPER);
        await C.index(q, r);
        expect(r.redirect).toHaveBeenCalledWith('/dashboard');
        expect(q.flashes).toEqual([['error', 'flash:module_disabled']]);
    });
});

describe('the report masks small groups', () => {
    function feed() {
        mockDb.get.mockResolvedValue({ total: 30, nationals: 20, expats: 8, noCountry: 2 });
        mockDb.all.mockImplementation(async (sql) => {
            if (/count\(\*\)::int AS headcount/.test(sql))
                return [
                    { name: 'Big', headcount: 17, nationals: 12, expats: 4, unspecified: 1 },
                    { name: 'Mid', headcount: 9, nationals: 6, expats: 2, unspecified: 1 },
                    { name: 'Tiny', headcount: 4, nationals: 2, expats: 2, unspecified: 0 },
                ];
            return [];
        });
    }
    test('CSV: a small group shows "<5" and no figure; its complement no figure either', async () => {
        feed();
        const r = res();
        await C.index(req(SUPER, { format: 'csv' }), r);
        const csv = String(r.send.mock.calls[0][0]);
        expect(csv).toContain('"Country","Tiny","<5","","","","","masked"');
        expect(csv).toContain('"Country","Mid","","","","","","masked (complementary)"');
        expect(csv).toMatch(/"Country","Big","17","12","4","1","16","75%"/);
        expect(csv).not.toMatch(/"Tiny","4"|"Mid","9"/);
    });
    test('page: masked rows reach the view, the unknown-country count too', async () => {
        feed();
        jest.spyOn(C, '_tabData').mockResolvedValue({});
        const r = res();
        await C.index(req(LOCAL(['view_local_content'])), r);
        const [view, locals] = r.render.mock.calls[0];
        expect(view).toBe('pages/reports/local-content');
        expect(locals.bySite.map((x) => x.masked || false)).toEqual([
            false,
            'complementary',
            'small',
        ]);
        expect(locals.kpi.noCountry).toBe(2);
    });
});

describe('the page', () => {
    const ejs = require('ejs');
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '../../views/pages/reports/local-content.ejs');
    const base = {
        __: (k) => k,
        colon: ' :',
        home: '',
        kpi: { total: 30, nationals: 20, expats: 8, unspecified: 2, nationalPct: 71, noCountry: 0 },
        byCountry: [
            { name: 'Big', headcount: 17, nationals: 12, expats: 4, unspecified: 1 },
            { name: 'Mid', masked: 'complementary', headcount: null },
            { name: 'Tiny', masked: 'small', headcount: null },
        ],
        byDepartment: [],
        byFamily: [],
        bySite: [{ name: 'Tiny site', masked: 'small', headcount: null }],
        expatPositions: [],
        csrfToken: 'tok',
        tab: 'overview',
    };
    const render = (over) =>
        ejs.render(fs.readFileSync(file, 'utf8'), { ...base, ...over }, { filename: file });
    test('a masked row says why, with no figure', () => {
        const html = render({});
        expect(html).toMatch(/admin:lc_masked_small/);
        expect(html).toMatch(/admin:lc_masked_complement/);
        expect(html).not.toMatch(/>null</);
    });
    test('the "no home country" warning only when people really have no country', () => {
        expect(render({ kpi: { ...base.kpi, noCountry: 0 } })).not.toMatch(
            /admin:lc_no_home_country/
        );
        expect(render({ kpi: { ...base.kpi, noCountry: 3 } })).toMatch(/admin:lc_no_home_country/);
    });
});
