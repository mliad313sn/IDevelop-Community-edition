'use strict';
/**
 * Objection to profiling (GDPR art. 21) on the surfaces that NAME a person on
 * the strength of a score: key-person risk (sole holders) and the copilot's
 * rankings (weakest / strongest readiness, flight-risk list). The person stays
 * in the counts and averages; they are never named. Both fail closed: when the
 * objections cannot be read, nobody is named. Plus the views that carry the
 * notice, the download and the objection render without inline handlers.
 *
 * DB mocked throughout.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    hasPermission: () => true,
    getFilteredEmployees: jest.fn(async () => []),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));

const KeyPerson = require('../../src/services/KeyPersonRiskService');

describe('key-person risk never names an objector', () => {
    const row = {
        skillId: 1,
        skillName: 'Welding',
        unitId: 3,
        unitName: 'Plant',
        requiredLevel: 3,
        isCritical: true,
        requiredOf: 4,
        measured: 2,
        qualified: 1,
        band: 'sole_holder',
        holderNames: ['Sam Holder'],
        holderIds: ['42'],
        holderRoles: ['Operator'],
    };
    test('an objector is counted but not named', () => {
        const shaped = KeyPerson._shape(row, new Set([42]));
        expect(shaped.qualified).toBe(1);
        expect(shaped.band).toBe('sole_holder');
        expect(shaped.holders).toEqual([{ id: null, name: null, roleName: null, objection: true }]);
    });
    test('a non-objector is named as before', () => {
        expect(KeyPerson._shape(row, new Set([7])).holders).toEqual([
            { id: 42, name: 'Sam Holder', roleName: 'Operator' },
        ]);
    });
    test('fails closed: unreadable objections name nobody', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        mockDb.all.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
        const objectors = await KeyPerson._objectors();
        expect(objectors).toBeNull();
        expect(KeyPerson._shape(row, objectors).holders[0].objection).toBe(true);
    });
});

describe('copilot rankings never name an objector', () => {
    const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
    let Copilot;
    const people = [
        { id: 1, firstName: 'Low', lastName: 'Objector' },
        { id: 2, firstName: 'Mid', lastName: 'Person' },
    ];
    function mockData({ objectorsFail = false } = {}) {
        mockRbac.getFilteredEmployees.mockResolvedValue(people);
        mockDb.all.mockImplementation(async (sql) => {
            const s = String(sql);
            if (/FROM profiling_objections/.test(s)) {
                if (objectorsFail) throw Object.assign(new Error('down'), { code: '57P01' });
                return [{ employeeId: 1 }];
            }
            if (/readiness_assessed_only AS pct/.test(s))
                return [
                    {
                        empId: 1,
                        fullName: 'Low Objector',
                        pct: 20,
                        assessed: 5,
                        expected: 10,
                        coverage: 50,
                    },
                    {
                        empId: 2,
                        fullName: 'Mid Person',
                        pct: 60,
                        assessed: 5,
                        expected: 10,
                        coverage: 50,
                    },
                ];
            if (/rr\.flight_risk = 'high'/.test(s))
                return [
                    { empId: 1, name: 'Low Objector' },
                    { empId: 2, name: 'Mid Person' },
                ];
            return [];
        });
    }
    beforeEach(() => {
        Copilot = require('../../src/services/CopilotService');
    });

    test('the objector is averaged but not ranked or listed', async () => {
        mockData();
        const ctx = await Copilot.buildContext(SUPER);
        expect(ctx.avgReadinessPct).toBe(40); // (20 + 60) / 2: still counted
        expect(ctx.lowestReadiness.map((r) => r.name)).toEqual(['Mid Person']);
        expect(ctx.highestReadiness.map((r) => r.name)).toEqual(['Mid Person']);
        expect(ctx.flightRiskWho).toEqual([{ name: 'Mid Person' }]);
        expect(JSON.stringify(ctx)).not.toMatch(/Low Objector/);
    });

    test('fails closed: unreadable objections name nobody', async () => {
        mockData({ objectorsFail: true });
        const ctx = await Copilot.buildContext(SUPER);
        expect(ctx.lowestReadiness).toEqual([]);
        expect(ctx.flightRiskWho).toEqual([]);
        expect(ctx.avgReadinessPct).toBe(40);
    });
});

describe('views: notice, download, objection, register', () => {
    const ejs = require('ejs');
    const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/compliance.json'), 'utf8'));
    const exec = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/exec.json'), 'utf8'));
    const __ = (k, o) => {
        const [ns, key] = k.split(':');
        const bag = ns === 'exec' ? exec : fr;
        let s = bag[key] || k;
        for (const [n, v] of Object.entries(o || {})) s = s.replace(`{{${n}}}`, String(v));
        return s;
    };
    const base = {
        __,
        csrfToken: 'tok',
        cspNonce: 'n',
        colon: ': ',
        fmtDate: (d) => String(d || ''),
        fmtDateTime: (d) => String(d || ''),
    };
    const render = (v, locals) =>
        ejs.render(
            fs.readFileSync(path.join(ROOT, 'views', v), 'utf8'),
            { ...base, ...locals },
            {
                filename: path.join(ROOT, 'views', v),
            }
        );
    const noInline = (html) => {
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/javascript:/i);
    };

    test('the notice page shows escaped blocks and the acknowledgement form', () => {
        const html = render('pages/employee/privacy-notice.ejs', {
            notice: {
                version: 2,
                publishedAt: '2026-10-01',
                title: 'Notice <b>',
                blocks: [{ type: 'p', text: '<script>x</script>' }],
            },
            acknowledged: false,
        });
        expect(html).toContain('action="/privacy/notice/acknowledge"');
        expect(html).toContain('name="version" value="2"');
        expect(html).not.toContain('<script>x</script>');
        expect(html).toContain('Notice &lt;b&gt;');
        noInline(html);
    });

    test('my data: download link and the objection form for an employee', () => {
        const html = render('pages/employee/my-data.ejs', {
            mine: { categories: [], retentionDays: null },
            privacy: { isEmployee: true, objection: null, notice: { version: 3 } },
        });
        expect(html).toContain('href="/employee/my-data/download"');
        expect(html).toContain('action="/employee/my-data/objection"');
        expect(html).toContain('href="/privacy/notice"');
        noInline(html);
        const objecting = render('pages/employee/my-data.ejs', {
            mine: null,
            privacy: { isEmployee: true, objection: { createdAt: '2026-10-01' }, notice: null },
        });
        expect(objecting).toContain('action="/employee/my-data/objection/withdraw"');
        // older callers without privacy locals still render
        expect(() => render('pages/employee/my-data.ejs', { mine: null })).not.toThrow();
    });

    test('register: publish form prefilled with the template, review lists', () => {
        const Privacy = require('../../src/services/PrivacyService');
        const html = render('pages/compliance/register.ejs', {
            reg: { categories: [] },
            privacy: {
                notice: null,
                template: Privacy.DEFAULT_TEMPLATE,
                review: {
                    objections: [{ id: 5, firstName: 'A', lastName: 'B', createdAt: 'x' }],
                    triggers: [
                        { id: 6, firstName: 'A', lastName: 'B', zone: 'red', createdAt: 'x' },
                    ],
                },
            },
        });
        expect(html).toContain('action="/compliance/register/privacy-notice"');
        expect(html).toContain('[[');
        expect(html).toContain('action="/compliance/privacy/objections/5/review"');
        expect(html).toContain('action="/compliance/privacy/triggers/6/resolve"');
        noInline(html);
    });

    test('key-person page shows the objection label, not a link to the person', () => {
        const src = fs.readFileSync(path.join(ROOT, 'views/pages/exec/key-person.ejs'), 'utf8');
        expect(src).toMatch(/h\.objection[\s\S]*exec:kp_holder_objection/);
    });
});

describe('privacy routes carry the right guards', () => {
    const flat = fs
        .readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8')
        .replace(/\s+/g, ' ')
        .replace(/\( /g, '(');
    test.each([
        ['get', '/privacy/notice', 'requireAuth'],
        ['post', '/privacy/notice/acknowledge', 'requireAuth'],
        ['get', '/employee/my-data/download', 'requireEmployeeOrManager'],
        ['post', '/employee/my-data/objection', 'requireEmployeeOrManager'],
        ['post', '/employee/my-data/objection/withdraw', 'requireEmployeeOrManager'],
        ['post', '/compliance/register/privacy-notice', 'requireSuperAdminPage'],
        ['post', '/compliance/privacy/objections/:id(\\\\d+)/review', 'requireSuperAdminPage'],
        ['post', '/compliance/privacy/triggers/:id(\\\\d+)/resolve', 'requireSuperAdminPage'],
    ])('%s %s behind %s', (method, route, guard) => {
        expect(flat).toContain(`router.${method}('${route}', ${guard},`);
    });
});
