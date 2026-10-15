'use strict';
/**
 * A signed-in person who opens a SuperAdmin-only PAGE gets the explanatory 403
 * page (pages/errors/403-permission, superAdminOnly) instead of « 302 →
 * /dashboard + a toast ». Behavioural, on the real middleware with a fake
 * req/res:
 *   - document GET by a local admin   → 403 + render(403-permission, { superAdminOnly: true })
 *   - the same GET by a SuperAdmin    → next()
 *   - a JSON/XHR caller               → the JSON 403 (unchanged)
 *   - a POST by a local admin         → still the redirect (write endpoints rely on it)
 *   - anonymous document GET          → still the sign-in bounce
 * Mutation check: with the `isDocumentGet → requireSuperAdminPage` line removed
 * from requireSuperAdmin, the first case redirects to /dashboard again and this
 * suite fails.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
jest.mock('../../src/utils/contactableAdmins', () => ({
    contactableGranters: async () => [{ username: 'root', role: 'superadmin' }],
}));

const { requireSuperAdmin } = require('../../src/middleware/auth');

function fakeReq({ user, method = 'GET', json = false, path = '/admin/health' } = {}) {
    const headers = json
        ? { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' }
        : {
              accept: 'text/html,application/xhtml+xml',
              'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'document',
          };
    const flashes = [];
    return {
        method,
        originalUrl: path,
        url: path,
        path,
        headers,
        body: {},
        query: {},
        session: {},
        cookies: {},
        signedCookies: {},
        get: (h) => headers[String(h).toLowerCase()],
        is: (t) => (json && t === 'json' ? 'json' : false),
        xhr: json,
        isAuthenticated: () => !!user,
        user: user || null,
        t: (k, o) => (o && o.defaultValue) || k,
        flash: (k, v) => flashes.push([k, v]),
        _flashes: flashes,
    };
}

function fakeRes() {
    const res = { statusCode: 200, out: {}, locals: {} };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.out.json = b;
        return res;
    };
    res.render = (view, locals) => {
        res.out.render = { view, locals };
        return res;
    };
    res.redirect = (a, b) => {
        res.out.redirect = b === undefined ? a : b;
        return res;
    };
    res.cookie = () => res;
    res.clearCookie = () => res;
    return res;
}

const LOCAL = { id: 69, userType: 'admin', role: 'localadmin', permissions: ['view_system_logs'] };
const SUPER = { id: 68, userType: 'admin', role: 'superadmin' };
const MANAGER = { id: 12, userType: 'manager', username: 'mgr' };

const run = (req) =>
    new Promise((resolve) => {
        const res = fakeRes();
        let nexted = false;
        Promise.resolve(
            requireSuperAdmin(req, res, () => {
                nexted = true;
            })
        ).then(() => setTimeout(() => resolve({ res, nexted }), 10));
    });

describe('SuperAdmin-only pages answer the explanatory 403', () => {
    test('local admin, document GET /admin/health → 403 page (superAdminOnly), no redirect, no flash', async () => {
        const req = fakeReq({ user: LOCAL });
        const { res, nexted } = await run(req);
        expect(nexted).toBe(false);
        expect(res.out.redirect).toBeUndefined();
        expect(res.statusCode).toBe(403);
        expect(res.out.render).toBeDefined();
        expect(res.out.render.view).toBe('pages/errors/403-permission');
        expect(res.out.render.locals).toEqual(
            expect.objectContaining({
                superAdminOnly: true,
                attemptedPath: '/admin/health',
                attemptedMethod: 'GET',
                isAdmin: true,
                backUrl: '/dashboard',
            })
        );
        expect(req._flashes).toEqual([]);
    });

    test('a manager gets the same page, with a way back to their own home', async () => {
        const { res } = await run(fakeReq({ user: MANAGER, path: '/admin/integrations/hris' }));
        expect(res.statusCode).toBe(403);
        expect(res.out.render.view).toBe('pages/errors/403-permission');
        expect(res.out.render.locals.isAdmin).toBe(false);
    });

    test('superadmin, same GET → next()', async () => {
        const { res, nexted } = await run(fakeReq({ user: SUPER }));
        expect(nexted).toBe(true);
        expect(res.out).toEqual({});
    });

    test('JSON caller keeps the JSON 403', async () => {
        const { res } = await run(fakeReq({ user: LOCAL, json: true, path: '/admin/api-keys' }));
        expect(res.statusCode).toBe(403);
        expect(res.out.json).toEqual(
            expect.objectContaining({ ok: false, code: 'superadmin_required' })
        );
        expect(res.out.render).toBeUndefined();
    });

    test('POST by a local admin keeps the redirect + flash (write endpoints unchanged)', async () => {
        const req = fakeReq({ user: LOCAL, method: 'POST', path: '/admin/maintenance/run' });
        const { res } = await run(req);
        expect(res.out.redirect).toBe('/dashboard');
        expect(res.out.render).toBeUndefined();
        expect(req._flashes.length).toBe(1);
    });

    test('anonymous document GET keeps the sign-in bounce', async () => {
        const { res } = await run(fakeReq({ user: null }));
        expect(res.out.render).toBeUndefined();
        expect(String(res.out.redirect || '')).toMatch(/^\/login/);
    });
});

describe('legacy pages answer a permanent redirect to the current one', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..', '..');
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
    const cap = fs.readFileSync(path.join(ROOT, 'src/routes/v2-capability.js'), 'utf8');

    test('/supervisor/reviews[/:id] → 301 to the grouped review queue (fixed relative target)', () => {
        expect(routes).toMatch(
            /const LEGACY_REVIEW_QUEUE = '\/supervisor\/self-assessment-reviews';/
        );
        expect(routes).toMatch(
            /router\.get\('\/supervisor\/reviews', requireManagerOrAdmin, \(req, res\) =>\s+res\.redirect\(301, LEGACY_REVIEW_QUEUE\)/
        );
        expect(routes).toMatch(
            /'\/supervisor\/reviews\/:reviewId',\s+requireManagerOrAdmin,\s+requireNumericParam\('reviewId'\),\s+\(req, res\) =>\s+res\.redirect\(\s+301,/
        );
        // The write endpoint is untouched.
        expect(routes).toMatch(/'\/supervisor\/reviews\/:reviewId\/complete'/);
    });

    test('/v2/cap/calibration → 301 to the hub card, behind the talent module guard', () => {
        expect(cap).toMatch(
            /router\.get\('\/calibration', requireManagerOrAdmin, \(req, res\) =>\s+res\.redirect\(301, '\/v2\/cap#calibration'\)/
        );
        // The capability router is mounted behind the module guard, and
        // /calibration belongs to the talent module.
        expect(routes).toMatch(
            /router\.use\('\/v2\/cap', ModuleService\.capGuard\(\), require\('\.\/v2-capability'\)\)/
        );
        const M = require('../../src/config/modules');
        expect(M.CAP_PATHS).toContainEqual(['/calibration', 'talent']);
    });
});
