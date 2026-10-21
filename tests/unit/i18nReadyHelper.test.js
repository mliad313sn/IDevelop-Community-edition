'use strict';
/**
 * The suites that load the real app (tests/helpers/c318/buildApp.loadApp) used to
 * sleep a fixed 300 ms "to let server.js's i18n init settle". server.js starts
 * i18next asynchronously and renders raw keys until it is done; the init is not
 * finished when loadApp() returns (proved below), so a fixed sleep is a bet on
 * the machine's load. i18nReady() waits for the real condition.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/i18n_ready_unit_test';

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));

const { loadApp, i18nReady } = require('../helpers/c318/buildApp');

test('loadApp() returns before i18n is ready; i18nReady() waits until the texts resolve', async () => {
    const i18next = require('i18next');
    // a suite may init i18next ITSELF before loading the app
    await require('../../src/config/i18n').init();
    expect(i18next.isInitialized).toBe(true);
    loadApp();
    // server.js's own init (and its middleware handle) is still running
    expect(!!globalThis.__c318I18nReady).toBe(false);
    await expect(i18nReady()).resolves.toBe(true);
    expect(globalThis.__c318I18nReady).toBe(true);
    const key = 'common:save';
    expect(i18next.t(key, { lng: 'fr' })).not.toBe(key);
    expect(i18next.t(key, { lng: 'en' })).not.toBe(key);
}, 120000);

test('i18nReady() gives up loudly instead of hanging', async () => {
    const saved = globalThis.__c318I18nReady;
    globalThis.__c318I18nReady = false;
    try {
        await expect(i18nReady(50)).rejects.toThrow(/not live after 50 ms/);
    } finally {
        globalThis.__c318I18nReady = saved;
    }
});
