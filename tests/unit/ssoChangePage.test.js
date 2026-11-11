'use strict';
/**
 * GET /account/sso-change (port item S2), database faked: what the signed-in
 * person sees when they open the in-app SSO notice.
 *   - migrated + SSO not live + go-live planned → the ANNOUNCEMENT, with its date;
 *   - migrated + SSO live → the INVITATION (the e-mail's steps);
 *   - not migrated / SuperAdmin / exception holder → a short neutral page;
 *   - migrated, SSO not live, no date → « rien ne change pour l'instant »;
 *   - a failure never reads « nothing changes for you »;
 *   - the view: layout page, no inline handler, no script.
 */
const path = require('path');
const ejs = require('ejs');

const mockState = { rows: {}, live: false, settings: {}, exception: false };
const mockDb = {
    get: jest.fn(async (sql) => {
        if (/FROM sso_migration_invites/.test(sql)) return mockState.rows.invite || null;
        if (/FROM admins WHERE id/.test(sql)) return mockState.rows.admin || null;
        if (/FROM employees WHERE id/.test(sql)) return mockState.rows.employee || null;
        if (/SELECT 1 AS ok/.test(sql)) return mockState.rows.migrated ? { ok: 1 } : null;
        if (/match_upn/.test(sql)) return { matchUpn: 'sam.rivera@corp.test' };
        return null;
    }),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/config/sso', () => ({
    getEnabledProviders: () => (mockState.live ? [{ key: 'entra', name: 'Microsoft' }] : []),
    getTestProvider: () => null,
}));
jest.mock('../../src/services/AdminSsoService', () => ({
    isEnforced: () => mockState.live,
    hasSsoException: async () => mockState.exception,
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: async (k, d) => (k in mockState.settings ? mockState.settings[k] : d),
}));
jest.mock('../../src/utils/branding', () => ({
    getBranding: async () => ({ appName: 'MonApp' }),
}));

const Inv = require('../../src/services/SsoInviteService');
const InvitationController = require('../../src/controllers/InvitationController');
const FR = require('../../locales/fr/auth.json');

const EMP_USER = { id: 42, userType: 'employee' };
const empRow = { id: 42, firstName: 'Sam', lastName: 'Rivera', email: null, isActive: true };
const invite = {
    id: 7,
    subjectType: 'employee',
    subjectId: 42,
    provider: 'entra',
    variant: 'standard',
    status: 'waiting_sso',
};

beforeEach(() => {
    mockState.rows = { invite, employee: empRow, migrated: true };
    mockState.live = false;
    mockState.exception = false;
    const future = new Date(Date.now() + 36 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    mockState.settings = {
        'sso.goLiveAt': `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`,
    };
});

const sentences = (page) => page.blocks.flatMap((b) => (b.t === 'steps' ? b.items : [b.text]));

describe('changeFor — the content for THIS person', () => {
    test('SSO not live + a planned date → the announcement, with the date', async () => {
        const r = await Inv.changeFor(EMP_USER);
        expect(r.mode).toBe('announce');
        const plan = await Inv.announcementPlan();
        const date = Inv.formatGoLive(plan.goLiveAt, 'fr');
        expect(sentences(r.page.fr)[0]).toBe(
            `À partir du ${date}, vous vous connecterez à MonApp avec votre compte Microsoft, le même que pour Windows ou Outlook.`
        );
        expect(r.page.fr.hello).toBe('Bonjour Sam,');
        expect(sentences(r.page.fr)).toContain(FR.ssoann_nothing_yet);
    });
    test('SSO live → the invitation (steps, company login)', async () => {
        mockState.live = true;
        const r = await Inv.changeFor(EMP_USER);
        expect(r.mode).toBe('invite');
        const steps = r.page.fr.blocks.find((b) => b.t === 'steps').items;
        expect(steps[1]).toBe('Cliquez « Se connecter avec Microsoft ».');
        expect(steps[2]).toMatch(/sam\.rivera@corp\.test/);
    });
    test('not migrated (no row, not live) → neutral', async () => {
        mockState.rows.invite = null;
        expect((await Inv.changeFor(EMP_USER)).mode).toBe('none');
    });
    test('an SSO exception keeps its password → neutral, never the invitation', async () => {
        mockState.live = true;
        mockState.exception = true;
        expect((await Inv.changeFor(EMP_USER)).mode).toBe('none');
    });
    test('a SuperAdmin never signs in by SSO → neutral', async () => {
        mockState.live = true;
        mockState.rows.invite = { ...invite, subjectType: 'admin', subjectId: 1 };
        mockState.rows.admin = { id: 1, username: 'root', role: 'superadmin', isActive: true };
        expect((await Inv.changeFor({ id: 1, userType: 'admin', role: 'superadmin' })).mode).toBe(
            'none'
        );
    });
    test('migrated, SSO not live, no date → « later » (nothing changes yet)', async () => {
        mockState.settings = {};
        expect((await Inv.changeFor(EMP_USER)).mode).toBe('later');
    });
    test('the lookup is keyed on the signed-in person only', async () => {
        await Inv.changeFor({ id: 99, userType: 'manager' });
        const call = mockDb.get.mock.calls.find(([sql]) => /FROM sso_migration_invites/.test(sql));
        expect(call[1]).toEqual(['employee', 99]);
    });
});

describe('the controller and the view', () => {
    const t = (k, o = {}) => {
        const key = String(k).replace(/^auth:/, '');
        return String(FR[key] || k).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) =>
            o[x] == null ? '' : o[x]
        );
    };
    async function renderFor(user, { fail = false } = {}) {
        if (fail)
            mockDb.get.mockImplementationOnce(async () => {
                throw new Error('boom');
            });
        let view;
        let locals;
        const req = { user, language: 'fr', t };
        const res = {
            render: (v, l) => {
                view = v;
                locals = l;
            },
        };
        await InvitationController.ssoChange(req, res);
        const html = await ejs.renderFile(
            path.join(__dirname, '..', '..', 'views', `${view}.ejs`),
            { ...locals, __: t },
            { async: false }
        );
        return { view, locals, html };
    }
    test('renders the announcement for the person, as a layout page', async () => {
        const { view, locals, html } = await renderFor(EMP_USER);
        expect(view).toBe('pages/account/sso-change');
        expect(locals.layout).toBeUndefined(); // the normal layout
        expect(locals.mode).toBe('announce');
        expect(html).toMatch(/Bientôt : nouvelle connexion/);
        expect(html).toMatch(/À partir du .*, vous vous connecterez à MonApp/);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/<script/i);
    });
    test('a failure says it could not be shown — never « no change planned »', async () => {
        const { locals, html } = await renderFor(EMP_USER, { fail: true });
        expect(locals.mode).toBe('error');
        expect(html).toMatch(/ne peuvent pas être affichées/);
        expect(html).not.toMatch(/Aucun changement de connexion/);
    });
    test('not migrated → the short neutral page', async () => {
        mockState.rows.invite = null;
        const { html } = await renderFor(EMP_USER);
        expect(html).toMatch(/Aucun changement de connexion n’est prévu pour votre compte/);
    });
});
