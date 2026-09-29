'use strict';

// Lot 0 F2 (L6-03 / L6-04 / L1-06): a refused form keeps what was typed and
// speaks the session language; it never bounces to /dashboard.
const fs = require('fs');
const path = require('path');
const V = require('../../src/utils/validators');

const frValidation = require('../../locales/fr/validation.json');
const enValidation = require('../../locales/en/validation.json');

/** A tiny req/res pair with a flash store, like the middleware sees them. */
function mockReq({
    path: p = '/employees',
    body = {},
    referer = null,
    lang = 'fr',
    xhr = false,
    headers = {},
} = {}) {
    const flashes = {};
    const t = (key, opts) => {
        const [ns, k] = key.split(':');
        const dict = ns === 'validation' ? (lang === 'fr' ? frValidation : enValidation) : {};
        return dict[k] || key;
    };
    return {
        path: p,
        body,
        xhr,
        headers,
        get: (h) =>
            h.toLowerCase() === 'referer'
                ? referer
                : h.toLowerCase() === 'host'
                  ? 'localhost:3110'
                  : undefined,
        t,
        language: lang,
        flash: (k, v) => {
            (flashes[k] = flashes[k] || []).push(v);
        },
        _flashes: flashes,
    };
}
function mockRes() {
    const res = { statusCode: 200, redirectedTo: null, jsonBody: null };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.jsonBody = b;
        return res;
    };
    res.redirect = (to) => {
        res.redirectedTo = to;
        return res;
    };
    return res;
}
/** Run an express-validator chain (all but the final handler) then the handler. */
async function runChain(chain, req, res) {
    for (const mw of chain.slice(0, -1)) await mw.run(req);
    let nexted = false;
    chain[chain.length - 1](req, res, () => {
        nexted = true;
    });
    return nexted;
}

describe('Lot 0 F2 — messages are validation:* keys translated through req.t', () => {
    test('no English withMessage string is left in validators.js (every message is a key)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/utils/validators.js'), 'utf8');
        const msgs = [...src.matchAll(/withMessage\('([^']+)'\)/g)].map((m) => m[1]);
        expect(msgs.length).toBeGreaterThanOrEqual(25);
        msgs.forEach((m) => expect(m).toMatch(/^validation:[a-z_]+$/));
        expect(src).toMatch(/throw new Error\('validation:pw_no_match'\)/);
        expect(src).not.toMatch(/redirect\(['"]\/dashboard/);
    });

    test('every validation key used has FR and EN text', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/utils/validators.js'), 'utf8');
        const keys = [...src.matchAll(/validation:([a-z_]+)/g)].map((m) => m[1]);
        keys.forEach((k) => {
            expect(frValidation[k]).toBeTruthy();
            expect(enValidation[k]).toBeTruthy();
        });
        expect(Object.keys(frValidation).sort()).toEqual(Object.keys(enValidation).sort());
    });

    test('the validation namespace is registered in i18n', () => {
        const src = require('../helpers/flatSource').flat(
            fs.readFileSync(path.join(__dirname, '../../src/config/i18n.js'), 'utf8')
        );
        expect(src).toMatch(/'validation'\]/);
    });

    test('POST /employees with no site → FRENCH message, draft kept, redirect to the form (not /dashboard)', async () => {
        const req = mockReq({
            path: '/employees',
            body: { firstName: 'ZZ-L0', lastName: 'Probe', siteId: '', password: 'Secret-123456!' },
        });
        const res = mockRes();
        const nexted = await runChain(V.employeeValidation, req, res);
        expect(nexted).toBe(false);
        expect(res.redirectedTo).toBe('/employees/create');
        expect(req._flashes.error).toContain('Un site valide est requis');
        expect(req._flashes.error.join(' ')).not.toMatch(/required/i);
        const draft = JSON.parse(req._flashes['draft:/employees/create'][0]);
        expect(draft.firstName).toBe('ZZ-L0');
        expect(draft.password).toBeUndefined(); // never echoed back
        expect(draft.__from).toBe('/employees');
    });

    test('same request in an EN session → English message', async () => {
        const req = mockReq({
            path: '/employees',
            body: { firstName: 'X', lastName: 'Y', siteId: '' },
            lang: 'en',
        });
        const res = mockRes();
        await runChain(V.employeeValidation, req, res);
        expect(req._flashes.error).toContain('A valid site is required');
    });

    test('POST /admins password mismatch → FR message, username kept, form route (no Referer needed)', async () => {
        const req = mockReq({
            path: '/admins',
            body: {
                username: 'zz.l0',
                email: '',
                password: 'Qa-Committee-2026!',
                passwordConfirm: 'Qa-Committee-2026?',
                role: 'viewer',
            },
        });
        const res = mockRes();
        await runChain(V.adminValidation, req, res);
        expect(res.redirectedTo).toBe('/admins/create');
        expect(req._flashes.error).toEqual(['Les mots de passe ne correspondent pas']);
        const draft = JSON.parse(req._flashes['draft:/admins/create'][0]);
        expect(draft.username).toBe('zz.l0');
        expect(draft.password).toBeUndefined();
        expect(draft.passwordConfirm).toBeUndefined();
    });

    test('weak password → each policy message once, in French', async () => {
        const req = mockReq({
            path: '/admins',
            body: { username: 'u', password: 'short', passwordConfirm: 'short', role: 'viewer' },
        });
        const res = mockRes();
        await runChain(V.adminValidation, req, res);
        expect(req._flashes.error).toEqual([
            'Le mot de passe doit contenir au moins 12 caractères',
            'Le mot de passe doit contenir au moins une majuscule',
            'Le mot de passe doit contenir au moins un chiffre',
            'Le mot de passe doit contenir au moins un caractère spécial',
        ]);
    });

    test('POST /organization/sites empty name → FR message, code kept, list page', async () => {
        const req = mockReq({ path: '/organization/sites', body: { name: '', code: 'ZZL0' } });
        const res = mockRes();
        await runChain(V.siteValidation, req, res);
        expect(res.redirectedTo).toBe('/organization/sites');
        expect(req._flashes.error).toEqual(['Le nom du site est requis']);
        expect(JSON.parse(req._flashes['draft:/organization/sites'][0]).code).toBe('ZZL0');
    });

    test('POST /organization/sites from the hub → back to the hub tab', async () => {
        const req = mockReq({ path: '/organization/sites', body: { name: '', from: 'hub' } });
        const res = mockRes();
        await runChain(V.siteValidation, req, res);
        expect(res.redirectedTo).toBe('/organization?tab=sites');
        expect(req._flashes['draft:/organization']).toBeDefined(); // key is the path, not the query
    });

    test('POST /employees/:id (edit) → /employees/:id/edit; POST /admins/:id → /admins/:id', async () => {
        const r1 = mockReq({ path: '/employees/142', body: { firstName: '' } });
        const s1 = mockRes();
        await runChain(V.employeeValidation, r1, s1);
        expect(s1.redirectedTo).toBe('/employees/142/edit');
        const r2 = mockReq({ path: '/admins/631', body: { username: '', role: 'viewer' } });
        const s2 = mockRes();
        await runChain(V.adminUpdateValidation, r2, s2);
        expect(s2.redirectedTo).toBe('/admins/631');
    });

    test('unknown POST path: same-origin Referer wins, else the path itself — never /dashboard', () => {
        expect(
            V.formRouteFor(
                mockReq({
                    path: '/employees/7/assessments',
                    referer: 'http://localhost:3110/employees/7/assessments?x=1',
                })
            )
        ).toBe('/employees/7/assessments?x=1');
        expect(
            V.formRouteFor(
                mockReq({ path: '/employees/7/assessments', referer: 'http://evil.example/steal' })
            )
        ).toBe('/employees/7/assessments');
        expect(V.formRouteFor(mockReq({ path: '/employees/7/assessments' }))).toBe(
            '/employees/7/assessments'
        );
    });

    test('JSON clients get a stable code plus the translated message', async () => {
        const req = mockReq({
            path: '/employees/7/assessments',
            body: { skillId: 'x', currentLevel: 9 },
            headers: { accept: 'application/json' },
        });
        const res = mockRes();
        await runChain(V.assessmentValidation, req, res);
        expect(res.statusCode).toBe(400);
        const codes = res.jsonBody.errors.map((e) => e.code);
        expect(codes).toEqual(
            expect.arrayContaining(['validation:skill_required', 'validation:level_range'])
        );
        expect(res.jsonBody.errors.find((e) => e.code === 'validation:level_range').msg).toBe(
            'Le niveau doit être compris entre 0 et 4'
        );
    });

    test('safeDraft strips every credential-like field and keeps org unit codes', () => {
        const d = V.safeDraft({
            name: 'S',
            code: 'ABC',
            password: 'x',
            newPasswordConfirm: 'y',
            _csrf: 't',
            apiToken: 'k',
            otp: '1',
            permissions: ['a', 'b'],
            scopes: { 1: { type: 'site', value: '11' } },
        });
        expect(d).toEqual({
            name: 'S',
            code: 'ABC',
            permissions: ['a', 'b'],
            scopes: { 1: { type: 'site', value: '11' } },
        });
    });
});

describe('Lot 0 F2 — controllers keep the draft on their own business refusals (source pins)', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../src/controllers', f), 'utf8');
    test('EmployeeController create/update never redirect to the form without keepDraft', () => {
        const src = read('EmployeeController.js');
        expect(src).not.toMatch(/res\.redirect\('\/employees\/create'\)/);
        expect(src).not.toMatch(/res\.redirect\(`\/employees\/\$\{id\}\/edit`\)/);
        expect((src.match(/keepDraft\(req, /g) || []).length).toBeGreaterThanOrEqual(15);
    });
    test('AdminController create/update keep the draft (and Lot C handlers are untouched)', () => {
        const src = read('AdminController.js');
        expect(src).not.toMatch(/res\.redirect\('\/admins\/create'\)/);
        const updateBody = src.slice(
            src.indexOf('async update(req, res)'),
            src.indexOf('async resetPassword(')
        );
        expect(updateBody).toMatch(/keepDraft\(req, `\/admins\/\$\{id\}`\)/);
        expect(updateBody).not.toMatch(/return res\.redirect\(`\/admins\/\$\{id\}`\);/);
    });
    test('OrganizationController write catch-alls keep the draft', () => {
        const src = read('OrganizationController.js');
        expect(
            (src.match(/keepDraft\(req, backTo\(req, '(site|department|service)'\)\)/g) || [])
                .length
        ).toBe(6);
    });
    test('server.js exposes res.locals.draft from the flash and the forms read it', () => {
        const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
        expect(server).toMatch(/req\.flash\('draft:' \+ req\.path\)/);
        [
            'employees/create.ejs',
            'employees/edit.ejs',
            'admins/create.ejs',
            'admins/show.ejs',
            'organization/sites.ejs',
            'organization/departments.ejs',
            'organization/services.ejs',
        ].forEach((v) => {
            const view = fs.readFileSync(path.join(__dirname, '../../views/pages', v), 'utf8');
            expect(view).toMatch(/typeof draft !== 'undefined' && draft/);
        });
    });
});
