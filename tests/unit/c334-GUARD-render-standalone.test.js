'use strict';
/**
 * Guard — every page rendered with `layout: false` renders with what its
 * controller passes.
 *
 * Why: a standalone page carries its own <html> shell, so it never receives
 * the declarations of layouts/main.ejs. A variable that only the layout
 * declares answers a 500 on that page, and a text match (« the page contains
 * _brand ») is exactly what hides it. This suite RENDERS instead.
 *
 * What: (1) the set of `res.render('pages/…', { layout: false … })` sites in
 * src/ is discovered by a scan and must equal the LOCALS map below (a new
 * standalone page fails until it is listed with its minimal locals); (2) each
 * page is rendered with the res.locals globals every request carries plus ONLY
 * the keys its controller passes; (3) the render must not throw, and the HTML
 * must contain no raw « undefined », « [object Object] » or « NaN », in French
 * and in English. No database.
 *
 * Extend: add the new view to LOCALS with the keys of its render call.
 */
// no database: some services require the db module at load time
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const R = require('../helpers/guards/repo');
const S = require('../helpers/guards/scans');
const dateFormat = require('../../src/utils/dateFormat');
const kpiFormat = require('../../src/utils/kpiFormat');

const ROOT = R.REPO;
const NS = {};
const ns = (lang, n) => {
    const k = lang + ':' + n;
    if (!NS[k]) {
        const p = path.join(ROOT, 'locales', lang, n + '.json');
        NS[k] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    }
    return NS[k];
};
/** plural-aware translator over the real locale files */
const tr = (lang) => (key, vars) => {
    const [n, ...rest] = String(key).split(':');
    const k = rest.join(':');
    const d = ns(lang, n);
    let v;
    if (vars && vars.count !== undefined) {
        const one = lang === 'fr' ? Number(vars.count) < 2 : Number(vars.count) === 1;
        v = d[k + (one ? '_one' : '_other')];
    }
    if (typeof v !== 'string')
        v = k.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), d);
    if (typeof v !== 'string') v = (vars && vars.defaultValue) || key;
    return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) => (vars && vars[x] != null ? vars[x] : ''));
};

/** the res.locals / app.locals globals every request carries (server.js, src/middleware) */
const globals = (lang) => ({
    __: tr(lang),
    lang,
    assetVersion: '1',
    cspNonce: 'n',
    externalFonts: false,
    csrfToken: 'csrf',
    user: null,
    currentPath: '/',
    can: () => false,
    entitlement: {},
    appModules: {},
    adoptionStage: 1,
    modulesLegacy: false,
    companionEnabled: false,
    sqlConsoleEnabled: false,
    setupProgress: null,
    wsVisible: false,
    success: [],
    errors: [],
    warnings: [],
    messages: {},
    draft: null,
    colon: lang === 'en' ? ':' : ' :',
    branding: { appName: 'IDevelop', logoUrl: null, faviconUrl: null, tagline: null },
    brandName: 'IDevelop',
    fmtDate: (d) => dateFormat.fmtDate(d, lang),
    fmtDateTime: (d) => dateFormat.fmtDateTime(d, lang),
    fmtPeriodBound: (d) => dateFormat.fmtPeriodBound(d),
    monthLabel: (ym) => dateFormat.fmtMonth(ym, lang),
    numFmt: kpiFormat.forLang(lang),
    enumLabel: (v) => String(v),
    featureLocalContent: false,
    nationalisationEnabled: false,
    sharedDevice: false,
    mfaGrace: null,
    passwordChangeAllowed: true,
    requestId: 'r1',
    personName: (p) => (p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : ''),
    navConfig: require('../../src/config/navigation'),
    skillHelpCore: require('../../src/utils/skillHelp'),
    deptBriefPrefs: null,
});

/** a minimal regulator-pack view model (aggregates only, invented names) */
function packVm(lang) {
    const Reports = require('../../src/services/LocalContentReportService');
    const zero = { completions: 0, people: 0 };
    return Reports.viewModel(
        {
            id: 1,
            state: 'draft',
            version: 1,
            templateCode: 'XX',
            companyName: 'Example Company',
            snapshot: {
                meta: {
                    countryName: 'Testland',
                    templateCode: 'XX',
                    periodLabel: '2026',
                    periodStart: '2026-01-01',
                    periodEndInclusive: '2026-12-31',
                    asOf: '2026-10-11T00:00:00Z',
                    anonymityThreshold: 5,
                    periodOpen: true,
                },
                workforce: {
                    total: { headcount: 3, nationals: 2, expats: 1, unspecified: 0 },
                    byLevel: [],
                    byRoleFamily: [],
                    bySite: [],
                },
                plans: { summary: { total: 0 }, rows: [] },
                training: {
                    lmsCompletions: { nationals: zero, expats: zero, unspecified: zero },
                    certificationsIssued: {
                        nationals: { certificates: 0, people: 0 },
                        expats: { certificates: 0, people: 0 },
                        unspecified: { certificates: 0, people: 0 },
                    },
                    certificationsValidAtEnd: {
                        nationals: { people: 0 },
                        expats: { people: 0 },
                        unspecified: { people: 0 },
                    },
                },
            },
        },
        tr(lang)
    );
}

/** a minimal dashboard context tab (counts only, no person) */
const overviewPanel = () => ({
    id: 'overview',
    blocks: ['gauge', 'trend', 'siteStatus'],
    threshold: 80,
    profile: {
        axes: [
            { key: 'K1', weight: 30, value: 70, state: 'measured', status: 'watch' },
            { key: 'K3', weight: 15, value: 80, state: 'measured', status: 'compliant' },
            { key: 'K4', weight: 25, value: null, state: 'outside' },
        ],
    },
    gauge: { score: 72.5, status: 'warn', partial: true, measuredCount: 2, total: 3 },
    recorded: [{ month: '2026-09', K1: 66 }],
    reconstructed: [
        { month: '2026-08', K1: 60, K3: 40 },
        { month: '2026-09', K1: 64, K3: 50 },
    ],
    sites: [{ key: '1', siteName: 'North', rank: 2, k1: { value: 90, status: 'compliant' } }],
});

/** view → the keys its controller passes (and nothing else) */
const LOCALS = {
    'pages/auth/login': () => ({
        title: 'Login',
        kioskEnabled: false,
        kioskForced: false,
        kioskChecked: false,
        kioskIdleMinutes: 5,
        ssoProviders: [],
        ssoHelpContact: null,
        ssoExceptions: false,
        ssoEnforced: false,
        ssoDegraded: false,
        breakglass: false,
        signupEnabled: false,
        emailEnabled: false,
        notice: null,
    }),
    'pages/auth/login-mfa': () => ({ title: 'Two-Factor Verification' }),
    'pages/auth/forgot-password': () => ({ title: 'Reset', emailEnabled: false }),
    'pages/auth/reset-password': () => ({ title: 'Reset', token: 't0k', setup: false }),
    'pages/auth/sso-choose-account': () => ({
        title: 'Choose',
        nonce: 'x',
        personName: 'A. B.',
        admins: [{ id: 1, username: 'adm', role: 'superadmin' }],
    }),
    'pages/auth/sso-enrol-code': () => ({ title: 'Enrol' }),
    'pages/onboarding/signup': () => ({
        title: 'Create account',
        allowedDomains: ['example.test'],
        allowForm: true,
        ssoProviders: [],
        prefill: {},
    }),
    'pages/onboarding/pending': () => ({
        title: 'Awaiting setup',
        state: { status: 'pending', email: 'x@example.test' },
    }),
    'pages/admins/sso-notices': () => ({
        title: 'Notices',
        notices: [{ name: 'A. B.', employeeNumber: 'EMP-1', subject: 's', text: 't' }],
    }),
    'pages/reports/local-content-pack': (lang) => ({ vm: packVm(lang), title: 'Pack' }),
    'pages/dashboard/_panel': () => ({
        ctx: { scope: {}, scopeQuery: '', navVisible: {} },
        panel: overviewPanel(),
    }),
    'pages/error': () => ({ title: '404', message: 'Nope' }),
};

const render = (view, lang) =>
    ejs.render(
        fs.readFileSync(path.join(ROOT, 'views', view + '.ejs'), 'utf8'),
        { ...globals(lang), ...LOCALS[view](lang) },
        { filename: path.join(ROOT, 'views', view + '.ejs') }
    );
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');

describe('every layout:false page is listed with its locals', () => {
    test('the scan of src/ and the LOCALS map name the same pages', () => {
        const found = Object.keys(S.standaloneRenderSites()).sort();
        expect(found).toEqual(Object.keys(LOCALS).sort());
    });
});

describe('mutation self-check: a missing local is caught by a render, not by a text match', () => {
    test('the SSO notices page without its notices throws a ReferenceError', () => {
        const file = path.join(ROOT, 'views', 'pages/admins/sso-notices.ejs');
        const locals = { ...globals('fr'), ...LOCALS['pages/admins/sso-notices']() };
        delete locals.notices;
        expect(() => ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file })).toThrow(
            /notices is not defined/
        );
    });
});

describe.each(['fr', 'en'])('standalone pages render with minimal locals (%s)', (lang) => {
    test.each(Object.keys(LOCALS))('%s', (view) => {
        const html = render(view, lang);
        // a `_`-prefixed page is a fragment fetched into the dashboard, not a document
        if (!/\/_[^/]+$/.test(view)) expect(html).toMatch(/<html/);
        else expect(html).toMatch(/<(div|section)/);
        const t = text(html);
        expect(t).not.toMatch(/\bundefined\b/);
        expect(t).not.toMatch(/\[object Object\]/);
        expect(t).not.toMatch(/\bNaN\b/);
    });
});
