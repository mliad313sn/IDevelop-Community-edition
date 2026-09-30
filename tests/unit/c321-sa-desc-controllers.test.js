'use strict';
/**
 * 3.23.21 — controller wiring of « Qu'est-ce que c'est ? » and the HR tools.
 *
 *  · the self-assessment page gets every row's help in exactly TWO extra
 *    queries (batched), whatever the number of skills — and still renders if
 *    they fail;
 *  · an EMPLOYEE (or a manager) never reaches a proposal: every /framework/*
 *    route is behind requirePermission, which refuses non-admins;
 *  · bulk approval needs the explicit confirmation;
 *  · the admin skill dialog sends its FR/EN texts to saveSkillTexts (dialog mode).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({ findByIdWithOrganization: jest.fn() }));
jest.mock('../../src/models/SelfAssessmentModel', () => ({ findByEmployeeId: jest.fn() }));
jest.mock('../../src/models/RoleSkillRequirementModel', () => ({ findByRoleId: jest.fn() }));
jest.mock('../../src/models/SkillAssessmentModel', () => ({ findByEmployeeId: jest.fn() }));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));

const EmployeeModel = require('../../src/models/EmployeeModel');
const SelfAssessmentModel = require('../../src/models/SelfAssessmentModel');
const RoleSkillRequirementModel = require('../../src/models/RoleSkillRequirementModel');
const SkillAssessmentModel = require('../../src/models/SkillAssessmentModel');

function res() {
    const r = { view: null, locals: null, redirectedTo: null, code: 200, body: null };
    r.render = (v, l) => {
        r.view = v;
        r.locals = l;
    };
    r.redirect = (u) => {
        r.redirectedTo = u;
    };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    return r;
}

describe('self-assessment page: help in two batched queries', () => {
    const Portal = require('../../src/controllers/EmployeePortalController');
    const reqs = (n) =>
        Array.from({ length: n }, (_, i) => ({
            skillId: i + 1,
            skillName: 'S' + i,
            domainName: 'D',
            requiredLevel: 2,
        }));
    beforeEach(() => {
        jest.clearAllMocks();
        EmployeeModel.findByIdWithOrganization.mockResolvedValue({ id: 5, roleId: 3 });
        SelfAssessmentModel.findByEmployeeId.mockResolvedValue([]);
        SkillAssessmentModel.findByEmployeeId.mockResolvedValue([]);
        mockDb.get.mockResolvedValue(null);
    });

    test.each([3, 60])('%i skills → exactly 2 db.all calls, help attached', async (n) => {
        RoleSkillRequirementModel.findByRoleId.mockResolvedValue(reqs(n));
        mockDb.all.mockImplementation(async (sql) =>
            /FROM skills s/.test(sql)
                ? reqs(n).map((r) => ({
                      id: r.skillId,
                      category: 'Technical',
                      descriptionFr: 'd' + r.skillId,
                  }))
                : [
                      {
                          skillId: null,
                          category: 'Technical',
                          level: 0,
                          anchor: 'c0',
                          anchorEn: 'c0 en',
                      },
                  ]
        );
        const r = res();
        await Portal.selfAssessment({ user: { id: 5 }, t: (k) => k, flash: jest.fn() }, r);
        expect(r.view).toBe('pages/employee/self-assessment');
        expect(mockDb.all).toHaveBeenCalledTimes(2);
        const rows = r.locals.skillsWithAssessments;
        expect(rows).toHaveLength(n);
        expect(rows[0].skillHelp.descriptionFr).toBe('d1');
        expect(rows[n - 1].skillHelp.anchors.category[0]).toEqual({ fr: 'c0', en: 'c0 en' });
        // Never selects a proposal nor strategic_link.
        mockDb.all.mock.calls.forEach(([sql]) => {
            expect(sql).not.toMatch(/skill_description_proposals|strategic_link/);
        });
    });

    test('a failing help read never breaks the page', async () => {
        RoleSkillRequirementModel.findByRoleId.mockResolvedValue(reqs(2));
        mockDb.all.mockRejectedValue(new Error('boom'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const r = res();
        await Portal.selfAssessment({ user: { id: 5 }, t: (k) => k, flash: jest.fn() }, r);
        spy.mockRestore();
        expect(r.view).toBe('pages/employee/self-assessment');
        expect(r.locals.skillsWithAssessments).toHaveLength(2);
    });
});

describe('proposals are admin-only', () => {
    const { requirePermission } = require('../../src/middleware/auth');
    const call = (user, slug) => {
        const next = jest.fn();
        const r = res();
        const req = {
            user,
            isAuthenticated: () => !!user,
            xhr: true,
            headers: { accept: 'application/json' },
            get: () => 'application/json',
            accepts: () => 'json',
            flash: jest.fn(),
            originalUrl: '/framework/quality',
            path: '/framework/quality',
        };
        return Promise.resolve(requirePermission(slug)(req, r, next)).then(() => ({ next, r }));
    };
    test.each([
        ['employee', { id: 5, userType: 'employee' }],
        ['manager', { id: 6, userType: 'manager' }],
    ])('%s: refused on read and write', async (_, user) => {
        for (const slug of ['view_domains_skills', 'manage_domains_skills']) {
            const { next, r } = await call(user, slug);
            expect(next).not.toHaveBeenCalled();
            expect(r.code).toBe(403);
        }
    });
    test('superadmin passes', async () => {
        const { next } = await call(
            { id: 1, userType: 'admin', role: 'superadmin' },
            'manage_domains_skills'
        );
        expect(next).toHaveBeenCalled();
    });
    test('every /framework route is permission-guarded', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
            'utf8'
        );
        const flat = src.replace(/\s+/g, ' ');
        const routes = flat.split('router.').filter((s) => /^(get|post)\( ?'\/framework\//.test(s));
        // 8 quality routes + 7 skills-library routes (/framework/library/...).
        expect(routes.length).toBe(15);
        routes.forEach((r) =>
            expect(r).toMatch(/requirePermission\('(view|manage)_domains_skills'\)|_sqManage/)
        );
    });
});

describe('quality controller', () => {
    jest.resetModules();
    test('bulk approve needs the confirmation, then passes the ids', async () => {
        jest.doMock('../../src/services/SkillDescriptionService', () => ({
            bulkApprove: jest.fn(async () => ({ approved: 2, skipped: 0 })),
        }));
        const C = require('../../src/controllers/SkillQualityController');
        const S = require('../../src/services/SkillDescriptionService');
        const flash = jest.fn();
        const r1 = res();
        await C.bulkApprove({ body: { ids: ['1', '2'] }, flash, t: (k) => k, user: {} }, r1);
        expect(S.bulkApprove).not.toHaveBeenCalled();
        expect(flash).toHaveBeenCalledWith('error', 'framework:sq_err_confirm_required');
        const r2 = res();
        await C.bulkApprove(
            { body: { ids: ['1', 'x', '2'], confirm: '1' }, flash, t: (k) => k, user: { id: 1 } },
            r2
        );
        expect(S.bulkApprove).toHaveBeenCalledWith([1, 2], { id: 1 });
        expect(r2.redirectedTo).toBe('/framework/quality');
    });
    test('import without a file is a 400, never a crash', async () => {
        const C = require('../../src/controllers/SkillQualityController');
        const r = res();
        await C.importXlsx({ t: (k) => k }, r);
        expect(r.code).toBe(400);
        expect(r.body).toEqual({ ok: false, code: 'no_file' });
    });
});

describe('admin skill dialog', () => {
    test('the FR/EN description and the level fields go to saveSkillTexts in dialog mode', async () => {
        jest.resetModules();
        const save = jest.fn(async () => ({}));
        jest.doMock('../../src/config/database', () => ({
            get: jest.fn(async () => ({ domainId: 4 })),
            all: jest.fn(),
            run: jest.fn(),
        }));
        jest.doMock('../../src/services/SkillDescriptionService', () => ({ saveSkillTexts: save }));
        jest.doMock('../../src/models/SkillModel', () => ({ update: jest.fn(async () => ({})) }));
        jest.doMock('../../src/services/RBACService', () => ({ hasPermission: () => true }));
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn() }));
        const C = require('../../src/controllers/SkillController');
        const r = res();
        await C.update(
            {
                params: { id: '9' },
                user: { id: 1, userType: 'admin' },
                body: {
                    name: 'N',
                    subDomainId: '3',
                    category: 'Safety',
                    description: 'fr',
                    descriptionEn: 'en',
                    fr2: 'a',
                    en2: '',
                },
                flash: jest.fn(),
                t: (k) => k,
                ip: '::1',
                get: () => 'ua',
            },
            r
        );
        expect(save).toHaveBeenCalledWith(
            '9',
            { descEn: 'en', fr2: 'a', en2: '' },
            expect.objectContaining({ eraseEmpty: true })
        );
        expect(r.redirectedTo).toBe('/domains-skills?tab=skills');
    });
});
