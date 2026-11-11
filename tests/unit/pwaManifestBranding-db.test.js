'use strict';

/**
 * The web manifests are served from branding on the REAL middleware chain of
 * server.js (tests/helpers/c318/buildApp.js compiles it without booting):
 * the organisation's name and favicon, the stock file's other fields, public
 * and revalidated; the stock name when no brand name is set.
 */
process.env.ACTIVITY_TRAIL = '0';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});
const mockBrand = { value: null };
jest.mock('../../src/utils/branding', () => {
    const real = jest.requireActual('../../src/utils/branding');
    return {
        ...real,
        getBranding: async () => mockBrand.value || real.getBranding(),
    };
});

const request = require('supertest');
const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

jest.setTimeout(60000);

let app;
let db;
beforeAll(async () => {
    if (!HAS_DB) return;
    db = require('../../src/config/database');
    await db.connect();
    const { loadApp, i18nReady } = require('../helpers/c318/buildApp');
    app = loadApp();
    await i18nReady();
});
afterAll(async () => {
    if (db) await db.close().catch(() => {});
});

suite('branded web manifests', () => {
    test('the brand name and favicon, the stock fields kept, no-cache, no session', async () => {
        mockBrand.value = {
            appName: 'Northwind Skills Portal',
            faviconUrl: '/branding/favicon?v=abc',
        };
        const res = await request(app).get('/manifest.fr.webmanifest');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/manifest\+json/);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['set-cookie']).toBeUndefined();
        const m = JSON.parse(res.text);
        expect(m.name).toBe('Northwind Skills Portal');
        expect(m.short_name).toBe('Northwind Sk');
        expect(m.lang).toBe('fr');
        expect(m.icons[0]).toEqual({
            src: '/branding/favicon?v=abc',
            sizes: 'any',
            purpose: 'any',
        });
        expect(m.icons.length).toBeGreaterThan(1);
    });
    test('no brand name: the stock name of the file', async () => {
        const { name } = require('../../src/config/product');
        mockBrand.value = { appName: name, faviconUrl: null };
        const res = await request(app).get('/manifest.webmanifest');
        const m = JSON.parse(res.text);
        const stock = JSON.parse(
            require('fs').readFileSync(
                require('path').join(__dirname, '../../public/manifest.webmanifest'),
                'utf8'
            )
        );
        expect(m.name).toBe(stock.name);
        expect(m.short_name).toBe(stock.short_name);
        expect(m.icons).toEqual(stock.icons);
    });
    test('the worker is never cached by the browser', async () => {
        const res = await request(app).get('/service-worker.js?v=abc');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
    });
});
