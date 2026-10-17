'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.API_RATE_LIMIT = '3';
process.env.API_IP_RATE_LIMIT = '3';
process.env.API_RATE_WINDOW = '15';

/**
 * The API rate limit could be bypassed with junk keys.
 *
 * The per-key bucket was keyed on the RAW credential, before any validation:
 * each random `X-API-Key` value opened a fresh bucket, so a caller rotating
 * junk keys was never limited. Now the per-IP bucket always applies and only a
 * key that VALIDATES (an api_keys row or the legacy shared env key) earns a
 * bucket of its own on top of it.
 */

jest.mock('../../src/services/ApiKeyService', () => ({
    validate: jest.fn(async (raw) => (raw === 'ak_good' ? { id: 7, scope: 'read' } : null)),
}));

const express = require('express');
const request = require('supertest');
const { apiRateLimiter, _resetApiKeyCacheForTests } = require('../../src/middleware/rateLimiter');
const ApiKeyService = require('../../src/services/ApiKeyService');

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api', apiRateLimiter, (req, res) =>
        res.json({ ok: true, bucket: req._rateKeyId || null })
    );
    return app;
}

beforeEach(() => {
    _resetApiKeyCacheForTests();
    ApiKeyService.validate.mockClear();
});

test('rotating junk keys from one address hits the IP ceiling', async () => {
    const app = buildApp();
    const codes = [];
    for (let i = 0; i < 6; i++) {
        const r = await request(app)
            .get('/api/x')
            .set('X-Forwarded-For', '203.0.113.10')
            .set('X-API-Key', 'junk-' + i);
        codes.push(r.status);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429, 429]);
});

test('a junk key never gets a bucket of its own', async () => {
    const app = buildApp();
    const r = await request(app)
        .get('/api/x')
        .set('X-Forwarded-For', '203.0.113.11')
        .set('X-API-Key', 'not-a-key');
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBeNull();
});

test('a validated key is bucketed by its id, and the lookup is cached', async () => {
    const app = buildApp();
    const r1 = await request(app)
        .get('/api/x')
        .set('X-Forwarded-For', '203.0.113.12')
        .set('X-API-Key', 'ak_good');
    const r2 = await request(app)
        .get('/api/x')
        .set('X-Forwarded-For', '203.0.113.12')
        .set('Authorization', 'Bearer ak_good');
    expect(r1.body.bucket).toBe('7');
    expect(r2.body.bucket).toBe('7');
    expect(ApiKeyService.validate).toHaveBeenCalledTimes(1);
});

test('a JWT-shaped bearer stays on the IP bucket (validated by the route)', async () => {
    const app = buildApp();
    const r = await request(app)
        .get('/api/x')
        .set('X-Forwarded-For', '203.0.113.13')
        .set('Authorization', 'Bearer eyJhbGciOi.eyJzdWIiOi.c2ln');
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBeNull();
    expect(ApiKeyService.validate).not.toHaveBeenCalled();
});
