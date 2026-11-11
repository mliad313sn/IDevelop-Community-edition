'use strict';
/**
 * express-flash (unmaintained since 2013, pulls in connect-flash) is replaced by
 * an in-house helper with the same req.flash API (src/middleware/flash.js).
 * Reading a flash never writes into the session, and a message cannot create a
 * session for an anonymous visitor. Real express + express-session stack.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const flash = require('../../src/middleware/flash');

function buildApp({ mintOnLogin = true } = {}) {
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
    app.use((req, res, next) => {
        res.locals.errors = req.flash('error');
        next();
    });
    app.get('/login', (req, res) => {
        if (mintOnLogin) req.session.csrfToken = 'tok';
        res.json({ errors: res.locals.errors });
    });
    app.post('/login', (req, res) => {
        req.flash('error', 'Invalid credentials');
        res.redirect('/login');
    });
    app.get('/bounce', (req, res) => {
        req.flash('error', 'Please sign in');
        res.redirect('/login');
    });
    app.use((req, res) => res.status(404).json({}));
    const count = () => new Promise((resolve) => store.length((e, n) => resolve(n)));
    return { app, count };
}

describe('sessions', () => {
    test('a 404 and a flash-only bounce store nothing for an anonymous visitor', async () => {
        const { app, count } = buildApp();
        for (let i = 0; i < 5; i++) {
            const a = await request(app).get('/nope-' + i);
            expect(a.headers['set-cookie']).toBeUndefined();
            const c = await request(app).get('/bounce');
            expect(c.headers['set-cookie']).toBeUndefined();
        }
        expect(await count()).toBe(0);
    });

    test('a failed sign-in flash still reaches the login page (established session)', async () => {
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

describe('the connect-flash API is kept', () => {
    const fake = (sess) => ({ session: sess, user: { id: 1 } });
    function withFlash(req) {
        const res = { locals: {}, render() {} };
        flash()(req, res, () => {});
        return { req, res };
    }
    test('queue, format, arrays, read-and-clear, all', () => {
        const { req } = withFlash(fake({ cookie: {} }));
        expect(req.flash('info', 'a')).toBe(1);
        expect(req.flash('info', 'b %s', 'x')).toBe(2);
        expect(req.flash('warning', ['w1', 'w2'])).toBe(2);
        expect(req.flash('info')).toEqual(['a', 'b x']);
        expect(req.flash('info')).toEqual([]);
        expect(req.flash()).toEqual({ warning: ['w1', 'w2'] });
        expect(req.flash()).toEqual({});
        expect(req.session.flash).toBeUndefined();
    });
    test('reading never writes into the session', () => {
        const sess = { cookie: {} };
        const { req } = withFlash({ session: sess });
        req.flash('success');
        req.flash('error');
        req.flash();
        expect(Object.keys(sess)).toEqual(['cookie']);
    });
    test('res.render receives res.locals.messages, like express-flash', () => {
        const { req, res } = withFlash(fake({ cookie: {} }));
        req.flash('success', 'ok');
        res.render('x');
        expect(res.locals.messages).toEqual({ success: ['ok'] });
    });
    test('a write without a session throws, like connect-flash', () => {
        const { req } = withFlash({ user: { id: 1 } });
        expect(() => req.flash('error', 'x')).toThrow(/requires sessions/);
    });
});

describe('dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    test('express-flash is gone and server.js uses the in-house helper', () => {
        expect(pkg.dependencies['express-flash']).toBeUndefined();
        const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
        expect(server).toMatch(/const flash = require\('\.\/src\/middleware\/flash'\);/);
    });
    test('node-mocks-http is a development dependency only', () => {
        expect(pkg.dependencies['node-mocks-http']).toBeUndefined();
        expect(pkg.devDependencies['node-mocks-http']).toEqual(expect.any(String));
    });
});
