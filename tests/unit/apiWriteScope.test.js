'use strict';
/** /api/v1 per-key write-scope gate: read keys can't write; session users pass. */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { apiKeyCanWrite } = require('../../src/api/v1');

describe('apiKeyCanWrite', () => {
    test('session users (no _apiKey) always pass — RBAC governs them', () => {
        expect(apiKeyCanWrite({ userType: 'admin', role: 'superadmin' })).toBe(true);
        expect(apiKeyCanWrite({ userType: 'manager' })).toBe(true);
    });
    test('read-only API keys cannot write', () => {
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'powerbi.read' })).toBe(false);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'legacy.shared' })).toBe(false);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: '' })).toBe(false);
        expect(apiKeyCanWrite({ _apiKey: true })).toBe(false);
    });
    test('write/admin/full scopes can write', () => {
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'goals.write' })).toBe(true);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'powerbi.readwrite' })).toBe(true);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'okr.rw' })).toBe(true);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'admin' })).toBe(true);
        expect(apiKeyCanWrite({ _apiKey: true, apiScope: 'full' })).toBe(true);
    });
});
