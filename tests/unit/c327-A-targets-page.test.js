'use strict';
/**
 * « Indicator targets » page (/kpi/targets): the real template rendered with
 * the real FR / EN catalogues (no database), the controller's refusals, the
 * route guards and the navigation gate.
 *   - a missing target reads « No target set », never 0; an inherited one is
 *     said so; the history prints the decision and its reason;
 *   - the form appears only for an account that may decide, with the CSRF
 *     token, its scopes limited to what it governs, and no inline handler;
 *   - FR / EN wording, no indicator of a module that is off;
 *   - GET needs an administrator account, POST needs manage_kpi_targets;
 *     the menu offers the page to administrators only.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'views/pages/kpi/targets.ejs');
const TEMPLATE = fs.readFileSync(FILE, 'utf8');
const NAV = require('../../src/config/navigation');

function translator(lang) {
    return (key, o) => {
        const str = String(key);
        const [ns, k] = str.includes(':') ? str.split(':') : ['common', str];
        // eslint-disable-next-line security/detect-non-literal-require
        const dict = require(`../../locales/${lang}/${ns}.json`);
        let out = dict[k] !== undefined ? dict[k] : str;
        if (o) for (const [a, b] of Object.entries(o)) out = out.split(`{{${a}}}`).join(String(b));
        return out;
    };
}

function render(over = {}, lang = 'fr') {
    return ejs.render(
        TEMPLATE,
        {
            __: translator(lang),
            lang,
            csrfToken: 'tok-123',
            kpis: ['K1', 'K6'],
            units: { K1: 'pct', K6: 'count' },
            rows: [
                { kpiId: 'K1', scopeType: 'org', display: '80 %', effectiveFrom: '01/06/2026' },
                {
                    kpiId: 'K1',
                    scopeType: 'site',
                    scopeId: 4,
                    name: 'Harbour View',
                    display: '80 %',
                    inherited: true,
                    effectiveFrom: '01/06/2026',
                },
                { kpiId: 'K6', scopeType: 'org', display: null, effectiveFrom: null },
            ],
            history: [
                {
                    kpiId: 'K1',
                    scopeType: 'org',
                    display: '80 %',
                    effectiveFromLabel: '01/06/2026',
                    createdAtLabel: '15/05/2026',
                    by: 'admin',
                    reason: 'Workforce plan <b>2026</b>',
                },
                {
                    kpiId: 'K6',
                    scopeType: 'org',
                    display: null,
                    effectiveFromLabel: '01/07/2026',
                    createdAtLabel: '20/06/2026',
                    by: 'admin',
                    reason: 'Withdrawn',
                },
            ],
            canEdit: true,
            canEditOrg: false,
            editableSites: [{ id: 4, name: 'Harbour View' }],
            today: '2026-10-15',
            ...over,
        },
        { filename: FILE }
    );
}

describe('the targets page', () => {
    test('no target reads « No target set », never 0; inherited is said; FR and EN', () => {
        const fr = render();
        expect(fr).toMatch(/Aucune cible définie/);
        expect(fr).toMatch(/cible de l&#39;organisation|cible de l'organisation/);
        expect(fr).toMatch(/Retirée/);
        const en = render({}, 'en');
        expect(en).toMatch(/No target set/);
        expect(en).toMatch(/organisation target/);
        expect(en).toMatch(/Indicator targets/);
        expect(en).not.toMatch(/Aucune cible/);
    });
    test('the form: CSRF token, only the governed scopes, no inline handler, reason escaped', () => {
        const h = render();
        expect(h).toMatch(/<form method="POST" action="\/kpi\/targets"/);
        expect(h).toMatch(/name="_csrf" value="tok-123"/);
        expect(h).toMatch(/<option value="site:4">Harbour View<\/option>/);
        expect(h).not.toMatch(/<option value="org">/); // no unrestricted clearance
        expect(h).not.toMatch(/\son[a-z]+="/i);
        expect(h).not.toMatch(/<script/i);
        expect(h).toMatch(/Workforce plan &lt;b&gt;2026&lt;\/b&gt;/);
        expect(h).not.toMatch(/<b>2026<\/b>/);
    });
    test('a reader who may not decide sees no form', () => {
        const h = render({ canEdit: false });
        expect(h).not.toMatch(/<form/);
        expect(h).toMatch(/Vous consultez les cibles/);
    });
    test('the page lists only the indicators it is given (a module off is omitted upstream)', () => {
        const h = render({ kpis: ['K1'], rows: [{ kpiId: 'K1', scopeType: 'org' }], history: [] });
        expect(h).not.toMatch(/data-kpi="K6"/);
        expect(h).not.toMatch(/value="K6"/);
        expect(h).toMatch(
            /Aucune cible n&#39;a encore été fixée|Aucune cible n'a encore été fixée/
        );
    });
});

describe('controller refusals', () => {
    const C = require('../../src/controllers/KpiTargetController');
    const res = () => {
        const r = { statusCode: 200, locals: { lang: 'en' } };
        r.status = (c) => {
            r.statusCode = c;
            return r;
        };
        r.render = (v, l) => {
            r.view = v;
            r.viewLocals = l;
            return r;
        };
        r.json = (b) => {
            r.body = b;
            return r;
        };
        r.redirect = (s, u) => {
            r.redirectTo = u || s;
            return r;
        };
        return r;
    };
    test('a non-administrator gets the 403 page', async () => {
        const r = res();
        await C.page({ user: { id: 1, userType: 'manager' }, t: (k) => k }, r, (e) => {
            throw e;
        });
        expect(r.statusCode).toBe(403);
        expect(r.view).toBe('pages/error');
    });
    test('a refused decision answers a fixed relative redirect with a flash', async () => {
        const S = require('../../src/services/KpiTargetService');
        const spy = jest
            .spyOn(S, 'setTarget')
            .mockRejectedValue(new S.TargetError('invalid_value'));
        const r = res();
        const flashes = [];
        await C.save(
            {
                user: { id: 1, userType: 'admin', role: 'superadmin' },
                body: { kpiId: 'K1', scope: 'org', targetValue: 'x' },
                headers: {},
                get: () => null,
                flash: (k, v) => flashes.push([k, v]),
                t: (k) => k,
            },
            r,
            (e) => {
                throw e;
            }
        );
        spy.mockRestore();
        expect(r.redirectTo).toBe('/kpi/targets');
        expect(flashes).toEqual([['error', 'kpi:targets_err_invalid_value']]);
    });
});

describe('route guards and navigation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
    test('GET needs an administrator account; POST needs manage_kpi_targets', () => {
        expect(src).toMatch(/router\.get\('\/kpi\/targets', requireAdmin,/);
        expect(src).toMatch(
            /router\.post\('\/kpi\/targets', requirePermission\('manage_kpi_targets'\),/
        );
    });
    test('the slug is a write permission with FR / EN labels', () => {
        const P = require('../../src/config/permissions');
        expect(P.isWrite('manage_kpi_targets')).toBe(true);
        for (const lang of ['fr', 'en']) {
            const a = require(`../../locales/${lang}/admin.json`);
            expect(a.perm.manage_kpi_targets.label).toBeTruthy();
            expect(a.perm.manage_kpi_targets.desc).toBeTruthy();
        }
    });
    test('the menu offers the page to administrators, not to managers', () => {
        const ctx = (user, perms) =>
            NAV.buildContext({
                user,
                can: (s) => perms === '*' || perms.includes(s),
                wsVisible: () => true,
                appModules: {},
            });
        expect(
            NAV.gates(ctx({ id: 1, userType: 'admin', role: 'superadmin' }, '*')).kpi_targets
        ).toBe(true);
        expect(NAV.gates(ctx({ id: 3, userType: 'admin', role: 'viewer' }, [])).kpi_targets).toBe(
            true
        );
        expect(NAV.gates(ctx({ id: 2, userType: 'manager' }, [])).kpi_targets).toBe(false);
        expect(NAV.CATALOGUE.kpi_targets.href).toBe('/kpi/targets');
    });
});
