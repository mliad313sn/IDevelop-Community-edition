'use strict';
/**
 * Anonymous requests create no session: a 404, the API root or a flash-only
 * bounce used to mint a CSRF token and so persist a session row each. Only
 * the pages that render a form (/login, /forgot-password, /reset-password,
 * /signup, the SSO pages) do. Real express + express-session stack.
 */
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { csrfSync } = require('csrf-sync');
const flash = require('../../src/middleware/flash');
const hh = require('../../src/middleware/httpHardening');

function buildApp() {
    const store = new session.MemoryStore();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
        session({
            store,
            secret: 'x'.repeat(40),
            resave: false,
            saveUninitialized: false,
            rolling: true,
        })
    );
    app.use(flash());
    // the same minting rule and the same flash reads as server.js
    const { generateToken } = csrfSync();
    app.use((req, res, next) => {
        res.locals.csrfToken = req.session && hh.mayMintCsrfToken(req) ? generateToken(req) : '';
        res.locals.success = req.flash('success');
        res.locals.errors = req.flash('error');
        next();
    });
    app.get('/login', (req, res) =>
        res.json({ token: res.locals.csrfToken, errors: res.locals.errors })
    );
    app.post('/login', (req, res) => {
        req.flash('error', 'Invalid credentials');
        res.redirect('/login');
    });
    app.get('/api/v1/', (req, res) => res.json({ ok: true }));
    app.get('/bounce', (req, res) => {
        req.flash('error', 'Please sign in');
        res.redirect('/login');
    });
    app.use((req, res) => res.status(404).json({ token: res.locals.csrfToken }));
    const count = () => new Promise((resolve) => store.length((e, n) => resolve(n)));
    return { app, count };
}

describe('anonymous requests do not create sessions', () => {
    test('a 404, the API root and a flash-only bounce store nothing; the login form does', async () => {
        const { app, count } = buildApp();
        for (let i = 0; i < 5; i++) {
            const a = await request(app).get('/nope-' + i);
            expect(a.headers['set-cookie']).toBeUndefined();
            expect(a.body.token).toBe('');
            const b = await request(app).get('/api/v1/');
            expect(b.headers['set-cookie']).toBeUndefined();
            const c = await request(app).get('/bounce');
            expect(c.headers['set-cookie']).toBeUndefined();
        }
        expect(await count()).toBe(0);
        const l = await request(app).get('/login');
        expect(l.body.token).toBeTruthy();
        expect(l.headers['set-cookie']).toBeDefined();
        expect(await count()).toBe(1);
    });

    test('the login failure flash still reaches the login page (established session)', async () => {
        const { app } = buildApp();
        const agent = request.agent(app);
        await agent.get('/login');
        await agent.post('/login').type('form').send({});
        const again = await agent.get('/login');
        expect(again.body.errors).toEqual(['Invalid credentials']);
        const third = await agent.get('/login');
        expect(third.body.errors).toEqual([]);
    });
});

describe('mayMintCsrfToken', () => {
    test.each([
        ['/login', true],
        ['/login/mfa', true],
        ['/forgot-password', true],
        ['/reset-password', true],
        ['/signup', true],
        ['/auth/sso/choose', true],
        ['/', false],
        ['/dashboard', false],
        ['/api/v1/', false],
        ['/loginx', false],
        ['/signup/x', false],
    ])('anonymous %s → %p', (p, want) => {
        expect(hh.mayMintCsrfToken({ path: p, session: { cookie: {} } })).toBe(want);
    });
    test('a signed-in user or an established session always gets one; no session never', () => {
        expect(hh.mayMintCsrfToken({ path: '/x', user: { id: 1 }, session: {} })).toBe(true);
        expect(hh.mayMintCsrfToken({ path: '/x', session: { csrfToken: 't' } })).toBe(true);
        expect(hh.mayMintCsrfToken({ path: '/login' })).toBe(false);
    });
    test('server.js mints through it', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../server.js'),
            'utf8'
        );
        expect(src).toMatch(/httpHardening\.mayMintCsrfToken\(req\) \? gen\(req\)/);
    });
});
