'use strict';
/**
 * CODE-REVIEW-2026-09-17 [BLOQUANT/security]: « SCIM ignore la portée ET
 * l'intention "lecture seule" d'une clé d'API : une clé Power BI peut
 * DÉSACTIVER des comptes (org-wide pour la clé partagée héritée). »
 *
 * Triaged by execution against the current tree: HALF of it was already
 * closed. Scope IS enforced — the reads go through
 * `RBACService.scopeFilter` and the writes through `inScope`, so no key
 * reaches beyond its perimeter and the org-wide half is gone.
 *
 * The read-only half was NOT. Every mutating route was gated on
 * `requireApiKey` alone, so any valid key could provision and deprovision:
 * a reporting key could PATCH `active:false` and run the full leaver cascade
 * (LifecycleService.deprovision) on anyone inside its scope.
 *
 * THE TRAP in fixing it: `/api/v1` already had exactly this predicate, but
 * the two authentication paths mark the principal DIFFERENTLY —
 * `src/api/v1/index.js` sets `req.user._apiKey` / `req.user.apiScope`, while
 * `src/middleware/apiAuth.js` (the one SCIM uses) sets `req._apiKey = {scope}`
 * and leaves `req.user` as the resolved admin. Reusing the old predicate
 * verbatim would have read "not an API key" for every SCIM caller and
 * returned true — a write gate that permits everything while looking
 * correct. Hence one shared `apiKeyCanWrite(req)` that reads BOTH shapes,
 * and the first test below is the one that would have caught the mistake.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const { apiKeyCanWrite, apiKeyScopeOf } = require('../../src/middleware/apiAuth');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('apiKeyCanWrite reads BOTH principal shapes', () => {
    // Shape A — middleware/apiAuth (SCIM, /api/v1 bearer): the REQUEST is marked.
    const shapeA = (scope) => ({ _apiKey: { id: 1, scope, label: 'k' }, user: { id: 5 } });
    // Shape B — the /api/v1 router's own auth: the USER is marked.
    const shapeB = (scope) => ({ user: { id: 0, _apiKey: true, apiScope: scope } });

    test('a read-only scope cannot write, in EITHER shape', () => {
        for (const make of [shapeA, shapeB]) {
            for (const scope of ['powerbi.read', 'legacy.shared', 'read', 'reporting.readonly']) {
                expect(apiKeyCanWrite(make(scope))).toBe(false);
            }
        }
    });

    test('a write scope can write, in EITHER shape', () => {
        for (const make of [shapeA, shapeB]) {
            for (const scope of ['scim.write', 'rw', 'admin', 'full', 'hr.readwrite']) {
                expect(apiKeyCanWrite(make(scope))).toBe(true);
            }
        }
    });

    test('a real SESSION is never blocked here — RBAC decides downstream', () => {
        expect(apiKeyCanWrite({ user: { id: 3, userType: 'admin', role: 'superadmin' } })).toBe(
            true
        );
        expect(apiKeyCanWrite({})).toBe(true);
        expect(apiKeyScopeOf({ user: { id: 3 } })).toBeNull();
    });

    test('an API-key principal is recognised as one in both shapes', () => {
        // The regression that mattered: if this returned null for shape A, the
        // gate would fall through to "session → allow" for every SCIM caller.
        expect(apiKeyScopeOf(shapeA('powerbi.read'))).toBe('powerbi.read');
        expect(apiKeyScopeOf(shapeB('powerbi.read'))).toBe('powerbi.read');
    });

    test('an empty scope is treated as read-only, not as permission', () => {
        expect(apiKeyCanWrite(shapeA(''))).toBe(false);
        expect(apiKeyCanWrite(shapeB(''))).toBe(false);
    });
});

describe('the SCIM router gates every mutating verb', () => {
    const src = read('src/routes/scim.js');
    const registration = (verb, route) => {
        const re = new RegExp(`router\\.${verb}\\(\\s*'${route.replace(/[/:]/g, '\\$&')}'`);
        const i = src.search(re);
        expect(i).toBeGreaterThan(-1);
        return src.slice(i, src.indexOf('ah(', i));
    };

    test.each([
        ['patch', '/scim/v2/Users/:id'],
        ['delete', '/scim/v2/Users/:id'],
        ['post', '/scim/v2/Users'],
    ])('%s %s carries requireScimWrite', (verb, route) => {
        expect(registration(verb, route)).toContain('requireScimWrite');
    });

    test.each([
        ['get', '/scim/v2/Users'],
        ['get', '/scim/v2/Users/:id'],
    ])('%s %s does NOT — a read key must keep reading', (verb, route) => {
        expect(registration(verb, route)).not.toContain('requireScimWrite');
    });

    test('the refusal is SCIM-shaped, because an IdP parses it', () => {
        const guard = src.slice(
            src.indexOf('const requireScimWrite'),
            src.indexOf('function toScim')
        );
        expect(guard).toMatch(/status\(403\)/);
        expect(guard).toMatch(/scimType:\s*'noPermission'/);
        expect(guard).toMatch(/schemas:\s*\[ERR\]/);
    });

    test('the scope check on reads and writes is still there (the closed half)', () => {
        expect(src).toMatch(/RBACService\.scopeFilter\(/);
        expect(src).toMatch(/await inScope\(req, id\)/);
    });
});

describe('there is ONE definition of "may this key write"', () => {
    test('the v1 router imports it instead of carrying a second copy', () => {
        const v1 = read('src/api/v1/index.js');
        expect(v1).toMatch(/require\('\.\.\/\.\.\/middleware\/apiAuth'\)/);
        // A second local spelling is how the two drift apart.
        expect(v1).not.toMatch(/function apiKeyCanWrite\s*\(/);
        expect(v1).toMatch(/apiKeyCanWrite\(req\)/);
    });
});
