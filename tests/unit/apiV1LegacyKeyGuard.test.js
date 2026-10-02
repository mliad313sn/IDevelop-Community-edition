'use strict';

/**
 * /api/v1 accepts the legacy shared env key through `legacySharedKey()` only,
 * the same S-02 guard as middleware/apiAuth: a configured key equal to APP_KEY
 * (the at-rest encryption key) is never a credential. The router used to
 * compare against `appConfig.apiKey` directly and skipped that guard.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const APP_KEY = 'k'.repeat(48);
const mockConfig = { apiKey: null, env: 'test' };
jest.mock('../../src/config/app', () => mockConfig);
jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: () => false,
    isEntraBearerEnabled: () => false,
}));
jest.mock('../../src/services/ApiKeyService', () => ({ validate: jest.fn(async () => null) }));
jest.mock('../../src/models/AdminModel', () => ({ findWithScopes: jest.fn() }));
jest.mock('../../src/api/v1/repository', () => {
    const empty = { list: jest.fn(async () => []), count: jest.fn(async () => 0) };
    return {
        SkillsRepository: empty,
        ReadinessRepository: empty,
        EmployeesRepository: empty,
        TalentRepository: empty,
        DevelopmentRepository: empty,
        GoalsRepository: empty,
        CheckInsRepository: empty,
    };
});

const express = require('express');
const request = require('supertest');

function v1App() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/api/v1'));
    return app;
}

const ENV = { ...process.env };
afterEach(() => {
    process.env = { ...ENV };
});

test('a legacy key equal to APP_KEY is refused on /api/v1', async () => {
    process.env.APP_KEY = APP_KEY;
    mockConfig.apiKey = APP_KEY;
    const r = await request(v1App()).get('/api/v1/skills').set('X-API-Key', APP_KEY);
    expect(r.status).toBe(401);
});

test('a distinct legacy key still opens /api/v1', async () => {
    process.env.APP_KEY = APP_KEY;
    mockConfig.apiKey = 'legacy-env-key-0123456789';
    const r = await request(v1App())
        .get('/api/v1/skills')
        .set('X-API-Key', 'legacy-env-key-0123456789');
    expect(r.status).toBe(200);
});

test('the router has no direct comparison with appConfig.apiKey', () => {
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../src/api/v1/index.js'),
        'utf8'
    );
    expect(src).not.toMatch(/appConfig\.apiKey/);
    expect(src).toMatch(/legacySharedKey\(\)/);
});
