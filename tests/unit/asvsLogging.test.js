'use strict';
/**
 * ASVS 4.0.3 V7 — security events are logged (7.1.3, 7.2.1, 7.2.2) and the
 * log never carries a secret (7.1.1, 7.1.2).
 *
 * The event inventory is pinned at its source, one row per event class the
 * requirement names; the "no secret" property is exercised on the writers
 * that handle one (API key issue, request-log URL redaction). The
 * re-authentication gate's own events are covered in recentAuth.test.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('security events are written to the audit trail', () => {
    test.each([
        ['login success', 'src/controllers/AuthController.js', "'LOGIN_SUCCESS'"],
        ['login failure (admin)', 'src/services/AuthService.js', "action: 'LOGIN_FAILED'"],
        [
            'login failure (employee)',
            'src/services/EmployeeAuthService.js',
            "'EMPLOYEE_LOGIN_FAILED'",
        ],
        ['logout', 'src/controllers/AuthController.js', "'LOGOUT'"],
        ['lockout', 'src/middleware/rateLimiter.js', "'ACCOUNT_LOCKED'"],
        ['rate limiting', 'src/middleware/rateLimiter.js', "'LOGIN_RATE_LIMITED'"],
        ['MFA challenge', 'src/controllers/AuthController.js', "'MFA_CHALLENGE'"],
        ['MFA enabled', 'src/routes/v2-uam.js', "action: 'MFA_ENABLED'"],
        ['MFA disabled', 'src/routes/v2-uam.js', "action: 'MFA_DISABLED'"],
        [
            'MFA reset by an admin',
            'src/controllers/AdminController.js',
            "action: 'MFA_RESET_BY_ADMIN'",
        ],
        ['admin created', 'src/controllers/AdminController.js', "action: 'ADMIN_CREATED'"],
        [
            'role and permission change',
            'src/controllers/AdminController.js',
            'perms: ${grantedPerms',
        ],
        [
            'access extended',
            'src/controllers/AdminController.js',
            "action: 'ADMIN_ACCESS_EXTENDED'",
        ],
        ['password changed', 'src/controllers/AuthController.js', "'PASSWORD_CHANGED'"],
        ['API key created', 'src/services/ApiKeyService.js', "'API_KEY_CREATED'"],
        ['API key revoked', 'src/services/ApiKeyService.js', "'API_KEY_REVOKED'"],
        ['re-authentication', 'src/middleware/recentAuth.js', "'REAUTH_FAILED'"],
        ['CSRF rejection', 'server.js', "action: 'CSRF_REJECTED'"],
        // The origin guard moved to src/middleware/httpHardening.js (testable).
        ['cross-origin rejection', 'src/middleware/httpHardening.js', "'CROSS_ORIGIN_BLOCKED'"],
    ])('%s', (_label, file, needle) => {
        expect(read(file)).toContain(needle);
    });

    test('every 401/403 lands in system_logs (access-control failures, 7.2.2)', () => {
        const src = read('server.js');
        expect(src).toMatch(/const denied = sc === 401 \|\| sc === 403;/);
    });

    test('API key events from /api/v1 carry the real actor and request', () => {
        const api = read('src/api/v1/index.js');
        expect(api).toMatch(/ApiKeyService\.generate\(\s*\{[\s\S]*?\},\s*req\s*\)/);
        expect(api).toMatch(/ApiKeyService\.revoke\(id, req\)/);
    });
});

describe('no secret reaches the logs', () => {
    test('issuing an API key never writes the raw key to the audit row', async () => {
        jest.resetModules();
        const rows = [];
        jest.doMock('../../src/config/database', () => ({
            get: jest.fn(async () => ({ id: 42 })),
            run: jest.fn(async () => ({ changes: 1 })),
            all: jest.fn(async () => []),
        }));
        jest.doMock('../../src/services/LogService', () => ({
            log: jest.fn(async (r) => rows.push(r)),
        }));
        const ApiKeyService = require('../../src/services/ApiKeyService');
        const k = await ApiKeyService.generate(
            { label: 'bi', scope: 'powerbi.read', createdBy: 1 },
            { user: { id: 1, userType: 'admin' }, ip: '10.0.0.1', get: () => 'jest', id: 'r1' }
        );
        expect(k.key).toMatch(/^ak_/);
        expect(rows.map((r) => r.action)).toEqual(['API_KEY_CREATED']);
        expect(JSON.stringify(rows)).not.toContain(k.key);
        expect(rows[0].ipAddress).toBe('10.0.0.1');
        jest.dontMock('../../src/config/database');
        jest.dontMock('../../src/services/LogService');
    });

    test('request URLs are logged with secrets redacted', () => {
        const { safeUrl } = require('../../src/middleware/logger');
        const url = safeUrl({
            path: '/reset-password',
            query: { token: 'abc123', password: 'hunter2', apiKey: 'ak_x', page: '2' },
        });
        expect(url).not.toMatch(/abc123|hunter2|ak_x/);
        expect(url).toContain('page=2');
    });

    test('the activity trail never stores a request body', () => {
        const src = read('src/middleware/activityTrail.js');
        expect(src).not.toMatch(/req\.body/);
    });
});
