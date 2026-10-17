'use strict';
/**
 * « À traiter » and the bell: what each persona is offered.
 *
 * Behavioural, mocked database (every count query answers 4; the running
 * campaign has 3 people not started; an uplift is pending; one 360° question-
 * naire waits). Each source is checked against the guard of the page it links
 * to AND the module that owns that page (Administration → Modules).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(async () => ({ c: 4 })),
    all: jest.fn(async () => []),
    run: jest.fn(),
    runTransaction: jest.fn(),
};
let mockModules = {};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));
jest.mock('../../src/services/RBACService', () => {
    const real = jest.requireActual('../../src/services/RBACService');
    return {
        isSuperAdmin: (u) => real.isSuperAdmin(u),
        hasPermission: (u, s) => real.hasPermission(u, s),
        scopeFilter: async () => ({ clause: '', params: [] }),
    };
});
jest.mock('../../src/services/ModuleService', () => ({
    resolve: async () => ({ modules: mockModules, stage: 'custom', legacy: false }),
    isOn: async (k) => mockModules[k] === true,
}));
jest.mock('../../src/services/CycleService', () => ({
    findCurrent: jest.fn(async () => ({ id: 9, code: 'C9', closesAt: null })),
    resolveScope: jest.fn(async () => ({})),
    progress: jest.fn(async () => ({ states: { not_started: { count: 3 } } })),
}));
jest.mock('../../src/services/LmsService', () => ({
    pendingUplifts: jest.fn(async () => [{ completionId: 1 }]),
}));
jest.mock('../../src/services/Feedback360Service', () => ({
    pendingCounts: jest.fn(async () => ({ answer: 1, nominate: 0, approve: 0 })),
}));

const {
    collectTasks,
    collectMyActions,
    myActions,
} = require('../../src/controllers/TalentActionsController');
const TasksController = require('../../src/controllers/TasksController');
const { passesGuard } = require('../../src/utils/routeGuard');

const ALL_ON = {
    campaigns: true,
    development: true,
    talent: true,
    mobility: true,
    engagement: true,
    ai: true,
};
const COMPLIANCE_GRANTS = [
    'view_employees',
    'manage_assessments',
    'configure_lms',
    'view_domains_skills',
    'view_roles',
    'manage_compliance',
    'view_compliance',
    'export_data',
];
const P = {
    employee: { id: 501, userType: 'employee' },
    manager: { id: 137, userType: 'manager' },
    superadmin: { id: 1, userType: 'admin', role: 'superadmin', permissions: [] },
    hse: { id: 69, userType: 'admin', role: 'localadmin', permissions: COMPLIANCE_GRANTS },
    hr: {
        id: 70,
        userType: 'admin',
        role: 'localadmin',
        permissions: [
            'manage_cycles',
            'manage_onboarding',
            'manage_invitations',
            'reset_employee_password',
            'edit_employees',
        ],
    },
    resetOnly: {
        id: 71,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['reset_employee_password'],
    },
    auditor: {
        id: 72,
        userType: 'admin',
        role: 'viewer',
        permissions: ['view_system_logs', 'view_compliance', 'export_data', 'view_continuity'],
    },
};
const tr = (k, fallback) => fallback;
const hrefs = (out) => out.items.map((i) => i.href);

beforeEach(() => {
    mockModules = { ...ALL_ON };
    mockDb.get.mockImplementation(async () => ({ c: 4 }));
});

describe('no item points at a page the person would be refused', () => {
    test('a compliance admin (no manage_cycles): no campaign item; the training item is kept', async () => {
        const out = await collectTasks(P.hse, tr);
        expect(hrefs(out).some((h) => h.startsWith('/cycles/'))).toBe(false);
        expect(hrefs(out)).toContain('/v2/lms/uplifts');
        expect(hrefs(out)).not.toContain('/onboarding');
        expect(hrefs(out).some((h) => h.startsWith('/admin/accounts'))).toBe(false);
    });

    test('SuperAdmin and manager DO get the campaign item (they may open /cycles/:id)', async () => {
        for (const u of [P.superadmin, P.manager]) {
            const out = await collectTasks(u, tr);
            expect(hrefs(out)).toContain('/cycles/9?state=not_started');
        }
    });

    test('an HR admin with manage_cycles gets the campaign, onboarding, accounts and leaver items', async () => {
        const out = await collectTasks(P.hr, tr);
        expect(hrefs(out)).toEqual(
            expect.arrayContaining([
                '/cycles/9?state=not_started',
                '/onboarding',
                '/admin/accounts?requests=1',
                '/v2/lifecycle?state=requested',
            ])
        );
    });

    test('reset_employee_password without manage_invitations: no accounts item (its page wants manage_invitations)', async () => {
        const out = await collectTasks(P.resetOnly, tr);
        expect(hrefs(out).some((h) => h.startsWith('/admin/accounts'))).toBe(false);
    });

    test('read-only account: no queue item at all', async () => {
        const out = await collectTasks(P.auditor, tr);
        expect(out.items).toEqual([]);
        expect(out.total).toBe(0);
    });
});

describe('each task source respects its module', () => {
    test('stage 1 (campaigns only): no item links into a module that is off', async () => {
        mockModules = { campaigns: true };
        for (const u of [P.superadmin, P.manager, P.employee, P.hr]) {
            const out = await collectTasks(u, tr);
            const leaked = hrefs(out).filter((h) =>
                /^\/(v2\/(idp|pip|lms|lifecycle)|coaching|employee\/my-coaching|feedback-360)/.test(
                    h
                )
            );
            expect(`${u.id}: ${leaked.join(',')}`).toBe(`${u.id}: `);
        }
        // the core and campaign items stay
        const m = await collectTasks(P.manager, tr);
        expect(hrefs(m)).toEqual(
            expect.arrayContaining([
                '/supervisor/self-assessment-reviews',
                '/cycles/9?state=not_started',
            ])
        );
    });

    test('campaigns off: no campaign chase', async () => {
        mockModules = { ...ALL_ON, campaigns: false };
        const out = await collectTasks(P.superadmin, tr);
        expect(hrefs(out).some((h) => h.startsWith('/cycles/'))).toBe(false);
    });

    test('engagement off: no recognition line; mobility off: no departure request', async () => {
        mockModules = { ...ALL_ON, engagement: false, mobility: false };
        const e = await collectTasks(P.employee, tr);
        expect(e.items.map((i) => i.key)).not.toContain('recognition');
        const h = await collectTasks(P.hr, tr);
        expect(hrefs(h)).not.toContain('/v2/lifecycle?state=requested');
    });

    test('development on: the 360° questionnaire waiting for the person is a task', async () => {
        const out = await collectTasks(P.employee, tr);
        const f = out.items.find((i) => i.key === 'f360_answer');
        expect(f).toEqual(expect.objectContaining({ href: '/feedback-360', count: 1 }));
    });
});

describe('a manager’s « À traiter » includes their own actions', () => {
    test('the team drafts open the team console, never /v2/idp', async () => {
        const out = await collectTasks(P.manager, tr);
        expect(out.items.find((i) => i.key === 'idp_draft').href).toBe('/v2/idp/manage');
    });

    test('manager sees team queues AND own items; employee sees only own items', async () => {
        const m = await collectTasks(P.manager, tr);
        const keys = m.items.map((i) => i.key);
        expect(keys).toEqual(expect.arrayContaining(['sa_review', 'sa_changes', 'my_coaching']));
        const e = await collectTasks(P.employee, tr);
        const ek = e.items.map((i) => i.key);
        expect(ek).toContain('sa_changes');
        expect(ek).not.toContain('sa_review');
        expect(ek.some((k) => /campaign|pip_|idp_draft|approvals|onboarding/.test(k))).toBe(false);
    });

    test('every item has a kind, a verb and an app-relative href', async () => {
        const out = await collectTasks(P.superadmin, tr);
        expect(out.items.length).toBeGreaterThan(3);
        for (const it of out.items) {
            expect(['assessments', 'plans', 'training', 'accounts', 'info']).toContain(it.kind);
            expect(typeof it.verb).toBe('string');
            expect(it.href).toMatch(/^\/[^/\\]/);
        }
    });

    test('the AI companion keeps reading the plain list', async () => {
        const items = await collectMyActions(P.manager, tr);
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThan(0);
    });
});

describe('the bell number counts ACTIONS only', () => {
    test('recognition (information, not a task) is listed but never counted', async () => {
        const out = await collectTasks(P.employee, tr);
        const rec = out.items.find((i) => i.key === 'recognition');
        expect(rec).toBeTruthy();
        expect(rec.info).toBe(true);
        const counted = out.items.filter((i) => !i.info).reduce((a, i) => a + i.count, 0);
        expect(out.total).toBe(counted);
        expect(out.total).toBeLessThan(out.items.reduce((a, i) => a + i.count, 0));
    });

    test('a failing source is reported (complete:false), the others still listed', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM pips/.test(sql)) throw new Error('boom');
            return { c: 4 };
        });
        const out = await collectTasks(P.superadmin, tr);
        expect(out.complete).toBe(false);
        expect(out.items.length).toBeGreaterThan(0);
        let payload;
        await myActions(
            { user: P.superadmin, t: (k, o) => (o && o.defaultValue) || k },
            { json: (o) => (payload = o), set() {} }
        );
        expect(payload.complete).toBe(false);
    });
});

describe('/tasks page and /action-center', () => {
    const res = () => {
        const r = { redirects: [], headers: {} };
        r.redirect = (a, b) => r.redirects.push(b === undefined ? [302, a] : [a, b]);
        r.set = (k, v) => (r.headers[k] = v);
        r.render = (view, locals) => Object.assign(r, { view, locals });
        return r;
    };
    const req = (user) => ({ user, t: (k, o) => (o && o.defaultValue) || k });

    test('groups follow the fixed order and carry their counts', async () => {
        const r = res();
        await TasksController.page(req(P.superadmin), r);
        expect(r.view).toBe('pages/tasks/index');
        const kinds = r.locals.groups.map((g) => g.kind);
        const order = ['assessments', 'plans', 'training', 'accounts', 'info'];
        expect(kinds).toEqual(order.filter((k) => kinds.includes(k)));
        for (const g of r.locals.groups)
            expect(g.count).toBe(g.items.reduce((a, i) => a + i.count, 0));
        expect(r.locals.total).toBe(r.locals.groups.reduce((a, g) => a + (g.count || 0), 0));
        expect(r.headers['Cache-Control']).toBe('no-store');
    });

    test('employees and read-only accounts are sent to their own home, no error', async () => {
        const e = res();
        await TasksController.page(req(P.employee), e);
        expect(e.redirects).toEqual([[302, '/employee/dashboard']]);
        const v = res();
        await TasksController.page(req(P.auditor), v);
        expect(v.redirects).toEqual([[302, '/dashboard']]);
    });

    test('/action-center: 301 → /tasks for eligible people, employees keep their dashboard', () => {
        for (const u of [P.manager, P.hse, P.superadmin]) {
            const r = res();
            TasksController.legacyActionCenter(req(u), r);
            expect(r.redirects).toEqual([[301, '/tasks']]);
        }
        const r = res();
        TasksController.legacyActionCenter(req(P.employee), r);
        expect(r.redirects).toEqual([[302, '/employee/dashboard']]);
    });

    test('the page renders escaped labels and only app-relative links', () => {
        const ejs = require('ejs');
        const path = require('path');
        const fs = require('fs');
        const file = path.join(__dirname, '../../views/pages/tasks/index.ejs');
        const html = ejs.render(
            fs.readFileSync(file, 'utf8'),
            {
                __: (k) => k,
                cspNonce: 'n',
                complete: true,
                total: 2,
                groups: TasksController.groupItems([
                    {
                        key: 'x',
                        kind: 'assessments',
                        label: '<img src=x onerror=alert(1)>',
                        verb: 'Go',
                        count: 2,
                        href: '//evil.example',
                        icon: 'fa-x" onmouseover="y',
                    },
                ]),
            },
            { filename: file }
        );
        expect(html).not.toContain('<img');
        expect(html).toContain('href="#"');
        expect(html).not.toContain('onmouseover');
    });
});

describe('routeGuard.passesGuard fails closed', () => {
    test('a guard that throws, never decides, or is missing refuses', () => {
        const u = P.superadmin;
        expect(
            passesGuard(() => {
                throw new Error('x');
            }, u)
        ).toBe(false);
        expect(passesGuard(() => {}, u)).toBe(false);
        expect(passesGuard(undefined, u)).toBe(false);
        expect(passesGuard((q, s, next) => next(), null)).toBe(false);
        expect(passesGuard([(q, s, next) => next(), () => {}], u)).toBe(false);
        expect(passesGuard([(q, s, next) => next(), (q, s, next) => next()], u)).toBe(true);
    });

    test('the real permission guard: granted → passes; missing → refused', () => {
        const { requirePermission } = require('../../src/middleware/auth');
        expect(passesGuard(requirePermission('manage_onboarding'), P.hr)).toBe(true);
        expect(passesGuard(requirePermission('manage_onboarding'), P.hse)).toBe(false);
        expect(passesGuard(requirePermission('manage_onboarding'), P.superadmin)).toBe(true);
    });
});
