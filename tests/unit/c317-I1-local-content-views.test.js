'use strict';
/**
 * 3.23.18 — lane I1 (local content): the page tabs and the printable pack
 * RENDER (EJS executed, not grepped), and the new router enforces its guards.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const path = require('path');
const ejs = require('ejs');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
}));

const VIEWS = path.join(__dirname, '../../views/pages/reports');
const __ = (k, o) => (o && o.n ? `${k}{${o.n}}` : k);

const baseLocals = {
    __,
    // Published by the app on res.locals beside `__` (A-11 colon typography).
    colon: ' :',
    home: 'CI',
    kpi: { total: 3, nationals: 0, expats: 0, unspecified: 3, nationalPct: null },
    byCountry: [{ name: 'CI', headcount: 3, nationals: 0, expats: 0, unspecified: 3 }],
    byDepartment: [],
    byFamily: [],
    bySite: [],
    expatPositions: [],
    csrfToken: 'tok',
};

function render(file, locals) {
    return ejs.renderFile(path.join(VIEWS, file), locals, { async: false });
}

describe('local-content page tabs', () => {
    test('overview: an unmeasurable ratio reads "—", never "null%" nor "0%"', async () => {
        const html = await render('local-content.ejs', { ...baseLocals, tab: 'overview' });
        expect(html).not.toMatch(/null%/);
        expect(html).not.toMatch(/lc-bar-label">0%/);
        expect(html).toMatch(/localcontent:tab_nationalisation/);
        expect(html).toMatch(/localcontent:tab_regulatory/);
    });

    test('nationalisation tab: unmeasured readiness says so; write forms carry the CSRF token', async () => {
        const html = await render('local-content.ejs', {
            ...baseLocals,
            tab: 'nationalisation',
            natAllowed: true,
            natCanWrite: true,
            natCandidates: { 5: [{ id: 21, name: 'Awa K.', roleName: 'Géologue' }] },
            natUnplanned: [
                {
                    employeeId: 12,
                    name: 'Jean D.',
                    nationality: 'France',
                    roleName: 'Chef',
                    siteName: 'S',
                    countryName: 'CI',
                },
            ],
            natPlans: [
                {
                    id: 5,
                    roleName: 'Chef de mine',
                    siteName: 'S',
                    countryName: 'CI',
                    incumbentName: 'Jean D.',
                    incumbentNationality: 'France',
                    targetDate: '2027-01-15',
                    state: 'active',
                    status: 'at_risk',
                    statusReason: 'readiness_not_measured',
                    successors: [
                        {
                            id: 30,
                            name: 'Awa K.',
                            state: 'active',
                            readinessPercent: null,
                            coveragePercent: null,
                            gapsMeasured: 0,
                            gapsUnmeasured: 12,
                            idpId: null,
                        },
                    ],
                },
            ],
        });
        expect(html).toMatch(/localcontent:not_measured/);
        expect(html).not.toMatch(/null %/);
        expect(html).toMatch(
            /action="\/reports\/local-content\/nationalisation\/plans\/5\/successors"/
        );
        expect(html).toMatch(/action="\/reports\/local-content\/nationalisation\/plans"/);
        const forms = html.match(/<form method="post"/g) || [];
        const tokens = html.match(/name="_csrf" value="tok"/g) || [];
        expect(forms.length).toBeGreaterThan(0);
        expect(tokens.length).toBe(forms.length);
    });

    test('nationalisation tab: a reader without the grant is told, not shown an empty list', async () => {
        const html = await render('local-content.ejs', {
            ...baseLocals,
            tab: 'nationalisation',
            natAllowed: false,
        });
        expect(html).toMatch(/localcontent:nat_not_allowed/);
        expect(html).not.toMatch(/localcontent:nat_no_plans/);
    });

    test('regulatory tab: publish / discard only on a draft, only for a manager of packs', async () => {
        const packs = [
            {
                id: 1,
                countryName: 'CI',
                periodLabel: '2026-Q2',
                version: 1,
                state: 'published',
                generatedAt: new Date(),
                publishedAt: new Date(),
            },
            {
                id: 2,
                countryName: 'CI',
                periodLabel: '2026-Q3',
                version: 1,
                state: 'draft',
                generatedAt: new Date(),
            },
        ];
        const html = await render('local-content.ejs', {
            ...baseLocals,
            tab: 'regulatory',
            packAllowed: true,
            packCanManage: true,
            packs,
            packCountries: [{ id: 9, name: 'CI' }],
        });
        expect(html).toMatch(/packs\/2\/publish/);
        expect(html).not.toMatch(/packs\/1\/publish/);
        expect(html).toMatch(/packs\/1\/xlsx/);
        const ro = await render('local-content.ejs', {
            ...baseLocals,
            tab: 'regulatory',
            packAllowed: true,
            packCanManage: false,
            packs,
            packCountries: [],
        });
        expect(ro).not.toMatch(/\/publish/);
        expect(ro).not.toMatch(/action="\/reports\/local-content\/packs"/);
    });
});

describe('printable regulator pack', () => {
    test('masked counts, company, period, and the signature block', async () => {
        const Reports = require('../../src/services/LocalContentReportService');
        const vm = Reports.viewModel(
            {
                id: 1,
                state: 'draft',
                version: 1,
                templateCode: 'ML',
                companyName: 'Acme Mining',
                snapshot: {
                    meta: {
                        countryName: 'Mali',
                        templateCode: 'ML',
                        periodLabel: '2026',
                        periodStart: '2026-01-01',
                        periodEndInclusive: '2026-12-31',
                        asOf: 'x',
                        anonymityThreshold: 5,
                        periodOpen: true,
                    },
                    workforce: {
                        total: { headcount: 3, nationals: 2, expats: 1, unspecified: 0 },
                        byLevel: [],
                        byRoleFamily: [],
                        bySite: [],
                    },
                    plans: { summary: { total: 0 }, rows: [] },
                    training: {
                        lmsCompletions: {
                            nationals: { completions: 0, people: 0 },
                            expats: { completions: 0, people: 0 },
                            unspecified: { completions: 0, people: 0 },
                        },
                        certificationsIssued: {
                            nationals: { certificates: 0, people: 0 },
                            expats: { certificates: 0, people: 0 },
                            unspecified: { certificates: 0, people: 0 },
                        },
                        certificationsValidAtEnd: {
                            nationals: { people: 0 },
                            expats: { people: 0 },
                            unspecified: { people: 0 },
                        },
                    },
                },
            },
            (k) => k
        );
        const html = await render('local-content-pack.ejs', { __, vm, title: 'x' });
        expect(html).toMatch(/&lt; 5/);
        expect(html).not.toMatch(/<td class="n">3<\/td>/);
        expect(html).toMatch(/Acme Mining/);
        expect(html).toMatch(/2026-01-01/);
        expect(html).toMatch(/localcontent:sig_signature/);
        expect(html).toMatch(/localcontent:print_not_published/);
    });
});

describe('router guards (fail closed)', () => {
    const express = require('express');
    const request = require('supertest');
    const LocalContentController = require('../../src/controllers/LocalContentController');
    const Nat = require('../../src/services/NationalisationService');
    const Reports = require('../../src/services/LocalContentReportService');

    function app(user, enabled = true) {
        jest.spyOn(LocalContentController, '_enabled').mockResolvedValue(enabled);
        const a = express();
        a.use(express.json());
        a.use((req, _res, next) => {
            req.user = user;
            req.isAuthenticated = () => !!user;
            req.flash = () => {};
            next();
        });
        a.use('/reports/local-content', require('../../src/routes/v2-localcontent'));
        return a;
    }

    test('module off → nothing exists', async () => {
        const create = jest.spyOn(Nat, 'createPlan');
        const r = await request(app({ userType: 'admin', role: 'superadmin', id: 1 }, false))
            .post('/reports/local-content/nationalisation/plans')
            .set('Accept', 'application/json')
            .send({ incumbentEmployeeId: 1, targetDate: '2027-01-01' });
        expect(r.status).toBe(404);
        expect(create).not.toHaveBeenCalled();
    });

    test('a viewer cannot write a plan, a manager cannot generate a pack', async () => {
        const create = jest.spyOn(Nat, 'createPlan');
        const gen = jest.spyOn(Reports, 'generateDraft');
        const viewer = {
            userType: 'admin',
            role: 'viewer',
            id: 7,
            permissions: ['view_continuity', 'manage_succession'],
        };
        const r1 = await request(app(viewer))
            .post('/reports/local-content/nationalisation/plans')
            .set('Accept', 'application/json')
            .send({ incumbentEmployeeId: 1, targetDate: '2027-01-01' });
        expect(r1.status).toBe(403);
        const r2 = await request(app({ userType: 'manager', id: 50 }))
            .post('/reports/local-content/packs')
            .set('Accept', 'application/json')
            .send({ countryId: 9, periodType: 'year', periodLabel: '2026' });
        expect(r2.status).toBe(403);
        expect(create).not.toHaveBeenCalled();
        expect(gen).not.toHaveBeenCalled();
    });

    test('service refusals surface as their status with a stable code', async () => {
        const e = Object.assign(new Error('x'), {
            code: 'LC_SUCCESSOR_NOT_NATIONAL',
            status: 400,
            expose: true,
            i18nKey: 'localcontent:err_successor_not_national',
        });
        jest.spyOn(Nat, 'addSuccessor').mockRejectedValue(e);
        const r = await request(app({ userType: 'manager', id: 50 }))
            .post('/reports/local-content/nationalisation/plans/5/successors')
            .set('Accept', 'application/json')
            .send({ employeeId: 20 });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('LC_SUCCESSOR_NOT_NATIONAL');
    });
});
