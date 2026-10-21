'use strict';
/**
 * SA-44: "Import & export" for an auditor and an HSE profile is export ONLY.
 *
 * Before: the menu showed the entry (export_data), the route admitted the
 * reader (requireAnyPermission), and DataManagementController.index bounced
 * every non-SuperAdmin, non-local-admin to /dashboard, so an auditor could
 * never reach the exports they were granted.
 *
 *  1. The real controller and template: an auditor or an HSE profile gets 200
 *     with the export blocks only (no import, templates, restore, JSON
 *     migration, SQL console, snapshots or reset; no API key); a local admin
 *     who may import and the SuperAdmin keep the full page; a viewer without
 *     export_data is still refused.
 *  2. The real route tree: every non-export route stays refused to the
 *     auditor, server-side, before any handler runs; the export routes admit.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.V2_FEATURES = '1';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const ROOT = path.join(__dirname, '../..');
const loadNs = (lng, ns) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lng, ns + '.json'), 'utf8'));
    } catch (_) {
        return {};
    }
};
const tFor = (lng) => (key, opts) => {
    const [ns, k] = String(key).includes(':') ? key.split(':') : ['common', key];
    const v = loadNs(lng, ns)[k];
    return typeof v === 'string'
        ? v
        : opts && opts.defaultValue !== undefined
          ? opts.defaultValue
          : key;
};

const AUDITOR = {
    id: 801,
    userType: 'admin',
    role: 'viewer',
    permissions: ['view_system_logs', 'view_domains_skills', 'view_roles', 'export_data'],
};
const HSE = {
    id: 802,
    userType: 'admin',
    role: 'localadmin',
    permissions: [
        'view_employees',
        'manage_assessments',
        'view_domains_skills',
        'manage_compliance',
        'view_compliance',
        'export_data',
    ],
};
const HR = {
    id: 803,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['view_employees', 'export_data', 'import_data'],
};
const SUPER = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
const VIEWER_NO_EXPORT = {
    id: 804,
    userType: 'admin',
    role: 'viewer',
    permissions: ['view_employees'],
};

const asUser =
    (user, lng = 'fr') =>
    (req, res, next) => {
        const t = tFor(lng);
        req.user = user;
        req.isAuthenticated = () => true;
        req.flash = () => {};
        req.t = t;
        res.locals.__ = t;
        res.locals.user = user;
        res.locals.cspNonce = 'n';
        res.locals.csrfToken = 'tok';
        res.locals.lang = lng;
        res.locals.colon = lng === 'fr' ? ' :' : ':';
        res.locals.fmtDateTime = (d) => String(d);
        res.locals.fmtDate = (d) => String(d);
        next();
    };

describe('the page, per persona (real controller, real template)', () => {
    let ctrl;
    let mockSnap;
    beforeAll(() => {
        jest.isolateModules(() => {
            jest.doMock('../../src/models/SnapshotModel', () => ({
                findAllWithCreator: jest.fn(async () => [
                    { id: 9, name: 'snap-hidden', createdAt: new Date() },
                ]),
                sizesById: jest.fn(async () => ({})),
            }));
            mockSnap = require('../../src/models/SnapshotModel');
            ctrl = require('../../src/controllers/DataManagementController');
        });
    });
    beforeEach(() => {
        jest.spyOn(ctrl, 'computeStatistics').mockResolvedValue({
            totalEmployees: 12,
            totalAssessments: 30,
            totalHistoryEntries: 4,
        });
        mockSnap.findAllWithCreator.mockClear();
    });
    afterEach(() => jest.restoreAllMocks());

    const page = (user, lng) => {
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(ROOT, 'views'));
        app.use(asUser(user, lng));
        app.get('/data-management', (req, res) => ctrl.index(req, res));
        return request(app).get('/data-management');
    };

    test.each([
        ['auditor (viewer + export_data), fr', AUDITOR, 'fr'],
        ['auditor (viewer + export_data), en', AUDITOR, 'en'],
        ['HSE local admin (export_data, no import_data)', HSE, 'fr'],
    ])('%s: 200, export blocks only, no API key, no snapshots', async (_n, user, lng) => {
        const r = await page(user, lng);
        expect(r.status).toBe(200);
        const html = r.text;
        expect(html).toContain(tFor(lng)('datamgmt:export_only_notice'));
        // No form that would only answer 403, no restore, migration, reset or snapshot control.
        expect(html).not.toMatch(/<form[^>]+id="import/);
        expect(html).not.toMatch(/id="fullSystemImportForm"|id="importJsonForm"/);
        expect(html).not.toMatch(/id="createSnapshotModal"|id="resetDatabaseModal"/);
        expect(html).not.toMatch(/\/data-management\/sql-console/);
        expect(html).not.toMatch(/\/data-management\/export\/local-admins/);
        expect(html).not.toMatch(/skill-matrix-workbook\/template/);
        expect(html).not.toMatch(/\/data-management\/templates\//);
        // The export links are there.
        expect(html).toMatch(/href="\/data-management\/export\/employees"/);
        expect(html).toMatch(/href="\/data-management\/export\/assessments"/);
        expect(html).toMatch(/href="\/data-management\/skill-matrix-workbook\/export\/excel"/);
        expect(html).not.toContain('snap-hidden');
        expect(mockSnap.findAllWithCreator).not.toHaveBeenCalled();
    });

    test('local admin with import_data: full page, unchanged', async () => {
        const r = await page(HR, 'fr');
        expect(r.status).toBe(200);
        expect(r.text).toMatch(/id="importEmployeesForm"/);
        expect(r.text).toMatch(/id="importJsonForm"/);
        expect(r.text).not.toMatch(/id="resetDatabaseModal"/);
        expect(r.text).not.toContain(tFor('fr')('datamgmt:export_only_notice'));
    });

    test('SuperAdmin: everything, SQL console, snapshots and reset included', async () => {
        const r = await page(SUPER, 'fr');
        expect(r.status).toBe(200);
        expect(r.text).toMatch(/id="importEmployeesForm"/);
        expect(r.text).toMatch(/id="resetDatabaseModal"/);
        expect(r.text).toContain('snap-hidden');
    });

    test('a viewer without export_data is still refused (redirect)', async () => {
        const r = await page(VIEWER_NO_EXPORT, 'fr');
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/dashboard');
    });
});

describe('server-side: non-export routes stay refused to the auditor (real route tree)', () => {
    jest.setTimeout(60000);
    let app;
    const reached = [];
    beforeAll(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.isolateModules(() => {
            const sentinel = (name) =>
                new Proxy(
                    {},
                    {
                        get(_t, prop) {
                            if (prop === 'upload')
                                return { single: () => (_req, _res, next) => next() };
                            if (prop === 'then') return undefined;
                            return function (req, res) {
                                reached.push(`${name}.${String(prop)}`);
                                res.status(299).json({ reached: String(prop) });
                            };
                        },
                    }
                );
            jest.doMock('../../src/controllers/DataManagementController', () => sentinel('DM'));
            jest.doMock('../../src/controllers/SqlConsoleController', () => sentinel('SQL'));
            const router = require('../../src/routes/index');
            app = express();
            app.use(express.json());
            app.use(asUser(AUDITOR));
            app.use(router);
        });
    });
    afterAll(() => jest.restoreAllMocks());

    const call = (method, url) =>
        request(app)[method](url).set('Accept', 'application/json').send({});

    test.each([
        ['post', '/data-management/import/employees'],
        ['post', '/data-management/import/assessments'],
        ['post', '/data-management/skill-matrix-workbook/import'],
        ['post', '/data-management/skill-matrix-workbook/preview'],
        ['post', '/admin/data/import'],
        ['post', '/admin/data/import-json'],
        ['get', '/admin/data/export-full'],
        ['get', '/admin/data/export-json'],
        ['post', '/data-management/snapshots'],
        ['post', '/data-management/snapshots/1/restore'],
        ['post', '/data-management/reset'],
        ['get', '/data-management/sql-console'],
        ['get', '/data-management/export/local-admins'],
    ])('%s %s → refused before any handler', async (method, url) => {
        const before = reached.length;
        const r = await call(method, url);
        expect([401, 403, 404]).toContain(r.status);
        expect(reached.length).toBe(before);
    });

    test.each([
        ['get', '/data-management'],
        ['get', '/data-management/export/employees'],
        ['get', '/data-management/export/assessments'],
        ['get', '/data-management/skill-matrix-workbook/export/excel'],
        ['get', '/api/data-management/statistics'],
    ])('%s %s → admitted (export)', async (method, url) => {
        const r = await call(method, url);
        expect(r.status).toBe(299);
    });
});
