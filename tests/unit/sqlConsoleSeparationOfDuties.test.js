'use strict';
/**
 * Separation of duties — the super-admin SQL console is OFF unless the server
 * operator sets SQL_CONSOLE_ENABLED=1. While off: every console route answers
 * 404, the sidebar entry and the Data Management card link are hidden, and the
 * instance-health page states the switch position.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
}));

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const svc = require('../../src/services/SqlConsoleService');
const { requireSqlConsoleEnabled } = require('../../src/middleware/sqlConsoleEnabled');

const ORIGINAL = process.env.SQL_CONSOLE_ENABLED;
afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SQL_CONSOLE_ENABLED;
    else process.env.SQL_CONSOLE_ENABLED = ORIGINAL;
});

describe('SqlConsoleService.isEnabled — an operator (environment) switch', () => {
    test.each([
        [undefined, false],
        ['', false],
        ['0', false],
        ['false', false],
        ['yes', false],
        ['1', true],
        ['true', true],
        [' TRUE ', true],
    ])('SQL_CONSOLE_ENABLED=%p → %p', (value, expected) => {
        if (value === undefined) delete process.env.SQL_CONSOLE_ENABLED;
        else process.env.SQL_CONSOLE_ENABLED = value;
        expect(svc.isEnabled()).toBe(expected);
    });

    test('it is read from the environment, never from App Settings', () => {
        const src = read('src/services/SqlConsoleService.js');
        const body = src.slice(src.indexOf('isEnabled() {'), src.indexOf('isEnabled() {') + 400);
        expect(body).toMatch(/process\.env\.SQL_CONSOLE_ENABLED/);
        expect(body).not.toMatch(/AppSettings/);
    });
});

describe('route gate', () => {
    function app() {
        const a = express();
        a.use('/data-management/sql-console', requireSqlConsoleEnabled);
        a.get('/data-management/sql-console', (req, res) => res.status(200).send('console'));
        a.post('/data-management/sql-console/execute', (req, res) => res.json({ ran: true }));
        a.get('/data-management', (req, res) => res.status(200).send('hub'));
        return a;
    }

    test('disabled (default) → every console route answers 404; siblings unaffected', async () => {
        delete process.env.SQL_CONSOLE_ENABLED;
        const a = app();
        await request(a)
            .get('/data-management/sql-console')
            .set('Accept', 'application/json')
            .expect(404);
        await request(a)
            .post('/data-management/sql-console/execute')
            .set('Accept', 'application/json')
            .expect(404);
        await request(a).get('/data-management').expect(200);
    });

    test('enabled → the console routes are reached', async () => {
        process.env.SQL_CONSOLE_ENABLED = '1';
        const a = app();
        await request(a).get('/data-management/sql-console').expect(200, 'console');
        await request(a).post('/data-management/sql-console/execute').expect(200);
    });

    test('the real router mounts the gate BEFORE every console route', () => {
        const routes = read('src/routes/index.js');
        const gate = routes.indexOf(
            "router.use('/data-management/sql-console', requireSqlConsoleEnabled)"
        );
        expect(gate).toBeGreaterThan(-1);
        const firstRoute = routes.search(/router\.(get|post)\(\s*'\/data-management\/sql-console/);
        expect(firstRoute).toBeGreaterThan(gate);
    });
});

describe('UI', () => {
    const SIDEBAR = path.join(ROOT, 'views/partials/sidebar.ejs');
    const locals = (enabled) => ({
        user: { userType: 'admin', role: 'superadmin', username: 'sa' },
        can: () => true,
        wsVisible: () => true,
        appModules: {},
        featureLocalContent: false,
        sqlConsoleEnabled: enabled,
        currentPath: '/nowhere',
        __: (k) => k,
        cspNonce: 'n',
        csrfToken: 't',
        lang: 'en',
    });
    const render = (L) => ejs.render(fs.readFileSync(SIDEBAR, 'utf8'), L, { filename: SIDEBAR });

    test('sidebar hides the SQL console entry while disabled, shows it when enabled', () => {
        expect(render(locals(false))).not.toContain('href="/data-management/sql-console"');
        expect(render(locals(true))).toContain('href="/data-management/sql-console"');
    });

    test('the Data Management card only links to the console when enabled', () => {
        const view = read('views/pages/data-management/index.ejs');
        const card = view.slice(view.indexOf('SQL Console (super-admin only)'));
        const link = card.indexOf('href="/data-management/sql-console"');
        const cond = card.indexOf('sqlConsoleEnabled');
        expect(cond).toBeGreaterThan(-1);
        expect(link).toBeGreaterThan(cond);
        expect(card).toContain("__('datamgmt:sql_console_disabled')");
    });

    test('the instance-health page reports the switch position', () => {
        expect(read('views/pages/admin/health.ejs')).toContain('admin:health_kpi_sql_console');
        expect(read('src/controllers/HealthController.js')).toMatch(
            /sqlConsoleEnabled: require\('\.\.\/services\/SqlConsoleService'\)\.isEnabled\(\)/
        );
        expect(read('server.js')).toMatch(/res\.locals\.sqlConsoleEnabled = /);
    });

    test('documented in .env.example', () => {
        expect(read('.env.example')).toMatch(/^# SQL_CONSOLE_ENABLED=1$/m);
    });
});
