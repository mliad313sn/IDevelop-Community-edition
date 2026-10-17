'use strict';

/**
 * "Approve all" (per person and for the team) asks for the session's CSRF
 * token on top of the same-origin guard that covers /api/*: a missing or
 * wrong token is a 403 JSON refusal and the handler never runs.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const requireSessionCsrf = require('../../src/middleware/requireSessionCsrf');

function appWith(sessionToken) {
    const app = express();
    app.use(express.json());
    const handler = jest.fn((req, res) => res.json({ success: true }));
    app.use((req, res, next) => {
        req.session = sessionToken === undefined ? {} : { csrfToken: sessionToken };
        req.t = (key, o) => (key === 'common:err_csrf_session' ? 'reload please' : o.defaultValue);
        next();
    });
    app.post('/approve-all', requireSessionCsrf, handler);
    return { app, handler };
}

describe('requireSessionCsrf', () => {
    test('without the header: 403 csrf_required, nothing runs', async () => {
        const { app, handler } = appWith('tok-abc');
        const r = await request(app).post('/approve-all').send({});
        expect(r.status).toBe(403);
        expect(r.body).toEqual({ success: false, code: 'csrf_required', error: 'reload please' });
        expect(handler).not.toHaveBeenCalled();
    });
    test('a wrong token, or a session without one: refused', async () => {
        const a = appWith('tok-abc');
        const r1 = await request(a.app).post('/approve-all').set('x-csrf-token', 'tok-abd');
        expect(r1.status).toBe(403);
        const b = appWith(undefined);
        const r2 = await request(b.app).post('/approve-all').set('x-csrf-token', '');
        expect(r2.status).toBe(403);
        expect(a.handler).not.toHaveBeenCalled();
        expect(b.handler).not.toHaveBeenCalled();
    });
    test("the session's token in the header (or the body): passes", async () => {
        const a = appWith('tok-abc');
        const r1 = await request(a.app).post('/approve-all').set('x-csrf-token', 'tok-abc');
        expect(r1.status).toBe(200);
        const r2 = await request(a.app).post('/approve-all').send({ _csrf: 'tok-abc' });
        expect(r2.status).toBe(200);
        expect(a.handler).toHaveBeenCalledTimes(2);
    });
    test('sameToken never matches two empty values', () => {
        expect(requireSessionCsrf.sameToken('', '')).toBe(false);
        expect(requireSessionCsrf.sameToken('a', 'ab')).toBe(false);
        expect(requireSessionCsrf.sameToken('ab', 'ab')).toBe(true);
    });
});

describe('route wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
    test.each([
        ['/api/self-assessment/employee/:employeeId/approve-all', 'bulkApprove'],
        ['/api/self-assessment/team/approve-all', 'teamApproveAgreed'],
    ])('%s asks for the session token before %s', (route, handler) => {
        const at = src.indexOf(`'${route}'`);
        expect(at).toBeGreaterThan(0);
        const reg = src.slice(at, src.indexOf(`SelfAssessmentWorkflowController.${handler}`, at));
        expect(reg).toMatch(/requireSessionCsrf,/);
    });
});
