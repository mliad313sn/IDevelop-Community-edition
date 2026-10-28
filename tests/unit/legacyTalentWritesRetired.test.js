'use strict';
/**
 * SA-42: the former /v2/talent write routes are retired. They wrote
 * talent_placements directly, without draft, approval, journal or audit line.
 * They now answer 410 with a pointer to /talent/nine-box and write nothing;
 * the reads are unchanged.
 */
const express = require('express');
const request = require('supertest');

function baseDb() {
    return {
        get: jest.fn(async () => undefined),
        all: jest.fn(async () => []),
        run: jest.fn(async () => ({ changes: 1 })),
        runTransaction: jest.fn(async (fn) => fn()),
        runInSavepoint: jest.fn(async (fn) => fn()),
    };
}

describe('former 9-box writes answer 410 and write nothing', () => {
    let db, app;
    beforeEach(() => {
        jest.resetModules();
        db = baseDb();
        jest.doMock('../../src/config/database', () => db);
        jest.doMock('../../src/middleware/auth', () => ({ requireAuth: (q, s, n) => n() }));
        jest.doMock('../../src/middleware/rateLimiter', () => ({
            writeActionLimiter: (q, s, n) => n(),
        }));
        jest.doMock('../../src/services/RBACService', () => ({
            isSuperAdmin: () => true,
            isViewer: () => false,
            getFilteredEmployees: async () => [{ id: 70 }],
        }));
        app = express();
        app.use(express.json());
        app.use((req, _r, n) => {
            req.user = { id: 1, userType: 'admin', role: 'superadmin' };
            req.t = (k, o) => (o && o.defaultValue) || k;
            n();
        });
        app.use('/v2/talent', require('../../src/routes/v2-talent'));
    });
    test.each([
        [
            '/v2/talent/ratings',
            { employeeId: 70, performance: 'high', potential: 'high', cycleId: 3 },
        ],
        ['/v2/talent/placements/70/compute', { cycleId: 3 }],
        [
            '/v2/talent/placements/70/override',
            { cycleId: 3, box: 'high-high', tier: 'up', reason: 'because of the review' },
        ],
        ['/v2/talent/placements/70/from-criteria', { cycleId: 3, onduty: 90 }],
    ])('POST %s → 410, location /talent/nine-box, no write', async (url, body) => {
        const r = await request(app).post(url).send(body);
        expect(r.status).toBe(410);
        expect(r.body.location).toBe('/talent/nine-box');
        expect(r.body.error).toMatch(/talent\/nine-box/);
        expect(db.run).not.toHaveBeenCalled();
        expect(db.get).not.toHaveBeenCalled();
    });
    test('reads are unchanged (GET /recommendations still 200)', async () => {
        const r = await request(app).get('/v2/talent/recommendations');
        expect(r.status).toBe(200);
    });
});
