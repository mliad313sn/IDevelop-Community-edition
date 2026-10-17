'use strict';
/**
 * STORED text (typed once, shown later on other pages) is rendered ESCAPED,
 * over the REAL app (tests/helpers/c318/buildApp.js) against a test database.
 * Each case writes a harmless marker into real rows (people, roles, skills and
 * places, notifications, self-assessment justifications and comments, campaign
 * reasons, report templates, sign-up requests, an admin's username, white-label
 * settings, 360-degree feedback rounds, one-to-one meetings and their agenda,
 * HRIS synchronisation runs) and reads the pages that show it, INSIDE one
 * transaction that is always rolled back (nothing persists).
 *
 * For every case:
 *   - no HTML page contains the marker's raw tag `<i data-stx…>`;
 *   - no page answers 5xx, and a text/html answer is never JSON carrying it;
 *   - at least one page DOES show the escaped marker (or a JSON API returns
 *     it), so the case is never vacuous: the stored text reached the output.
 * Skipped unless DATABASE_URL names a test database (tests/helpers/testDatabase).
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
process.env.PREAUTH_RATE_LIMIT = '100000000';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000';
// Every staged module on (360-degree feedback, one-to-one, talent…).
process.env.V2_FEATURES = '1';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});

const request = require('supertest');
const { loadApp, i18nReady, mintSession } = require('../helpers/c318/buildApp');
const storeState = require('../helpers/c318/sessionStoreMock').state;
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(5 * 60 * 1000);

const CSRF = 'stored-text-csrf';
const ROLLBACK = Symbol('stored-text-rollback');
const EXPLORE = process.env.STX_EXPLORE === '1'; // triage: print every page's verdict
/** A harmless marker; the attribute names its field so a failure names its source. */
const M = (field) => `<i data-stx-${field}>m</i>&"'`;
const RAW = /<i data-stx/;
const ESCAPED = /&lt;i data-stx/;

let db;
let app;
const F = {};
const COOKIE = {};

async function inRollback(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn();
            await new Promise((r) => setTimeout(r, 10));
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
    return out;
}

function fetchPage(role, url, json = false) {
    let r = request(app).get(url).redirects(0).timeout(60000);
    if (COOKIE[role]) r = r.set('Cookie', COOKIE[role]);
    return r
        .set('Accept', json ? 'application/json' : 'text/html,application/xhtml+xml')
        .then((x) => ({
            status: x.status,
            ct: String(x.headers['content-type'] || ''),
            body: x.text != null ? x.text : JSON.stringify(x.body),
        }));
}

/** Plant with `setup()` (inside the rollback), then read `pages(ctx)`. */
async function storedCase({ setup, pages }) {
    return inRollback(async () => {
        const ctx = await setup();
        const out = [];
        for (const [role, url, json] of pages(ctx || {})) {
            const r = await fetchPage(role, url, json);
            const at = r.body.search(RAW);
            out.push({
                role,
                url,
                status: r.status,
                ct: r.ct,
                raw: at >= 0 && /html/i.test(r.ct),
                rawCtx: at >= 0 ? r.body.slice(Math.max(0, at - 160), at + 60) : null,
                escaped: ESCAPED.test(r.body),
                jsonText: /json/i.test(r.ct) && r.body.includes('data-stx'),
            });
        }
        return out;
    });
}

function judge(name, rows) {
    if (EXPLORE)
        for (const r of rows)
            console.log(
                `[stored-text] ${name} ${r.role} ${r.url} -> ${r.status} ${r.ct.split(';')[0]} raw=${r.raw} esc=${r.escaped} json=${r.jsonText}`
            );
    expect(rows.filter((r) => r.raw).map((r) => `${r.role} ${r.url}: …${r.rawCtx}…`)).toEqual([]);
    expect(
        rows.filter((r) => r.status >= 500).map((r) => `${r.role} ${r.url} ${r.status}`)
    ).toEqual([]);
    for (const r of rows) if (/^text\/html/i.test(r.ct)) expect(r.jsonText).toBe(false);
    expect(rows.some((r) => r.escaped || r.jsonText)).toBe(true);
}

const one = async (sql, params = []) => {
    const r = await db.get(sql, params);
    return r && r.id != null ? Number(r.id) : null;
};

d('stored text is rendered escaped on every page that shows it (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        await require('../../src/utils/searchSql').init(db);
        F.superadmin = await one(
            "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
        );
        // a supervisor and one of their reports, both able to sign in
        const pair = await db.get(
            `SELECT e.id AS emp, e.supervisor_id AS mgr FROM employees e
               JOIN employees m ON m.id = e.supervisor_id
              WHERE e.is_active AND m.is_active
                AND NOT e.force_password_change AND NOT m.force_password_change
                AND e.auth_policy <> 'mfa_required' AND m.auth_policy <> 'mfa_required'
              ORDER BY e.id LIMIT 1`
        );
        F.employee = Number(pair.emp);
        F.manager = Number(pair.mgr);
        const emp = await db.get('SELECT * FROM employees WHERE id = ?', [F.employee]);
        F.employeeNumber = emp.employeeNumber;
        F.roleId = Number(emp.roleId);
        F.siteId = Number(emp.siteId);
        F.departmentId = Number(emp.departmentId);
        F.serviceId = Number(emp.serviceId);
        F.skillId = await one(
            'SELECT skill_id AS id FROM role_skill_requirements WHERE role_id = ? ORDER BY skill_id LIMIT 1',
            [F.roleId]
        );
        app = loadApp();
        await i18nReady();
        const P = {
            superadmin: { id: F.superadmin, userType: 'admin' },
            manager: { id: F.manager, userType: 'employee' },
            employee: { id: F.employee, userType: 'employee' },
        };
        for (const [role, p] of Object.entries(P))
            COOKIE[role] = await mintSession(storeState.store, p, CSRF);
    });

    afterAll(async () => {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    test('a person’s first and last name: lists, profile, edit form, one-to-one, org chart, API', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run('UPDATE employees SET first_name = ?, last_name = ? WHERE id = ?', [
                    M('first'),
                    M('last'),
                    F.employee,
                ]);
            },
            pages: () => [
                ['superadmin', `/employees?search=${encodeURIComponent(F.employeeNumber)}`],
                ['superadmin', `/employees/${F.employee}`],
                ['superadmin', `/employees/${F.employee}/edit`],
                ['superadmin', '/admin/accounts'],
                ['manager', '/employees'],
                ['manager', `/employees/${F.employee}`],
                ['manager', '/one-on-one/'],
                ['manager', `/one-on-one/${F.employee}`],
                ['manager', '/supervisor/dashboard'],
                ['employee', `/employees/${F.employee}`],
                ['superadmin', '/api/v1/employees?limit=500', true],
            ],
        });
        judge('employee-name', rows);
    });

    test('role, skill and place names: catalogues, role page, profile, admin scope editor', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run('UPDATE roles SET name = ?, description = ? WHERE id = ?', [
                    M('role'),
                    M('roledesc'),
                    F.roleId,
                ]);
                await db.run('UPDATE skills SET name = ? WHERE id = ?', [M('skill'), F.skillId]);
                await db.run('UPDATE sites SET name = ? WHERE id = ?', [M('site'), F.siteId]);
                await db.run('UPDATE departments SET name = ? WHERE id = ?', [
                    M('dept'),
                    F.departmentId,
                ]);
                await db.run('UPDATE services SET name = ? WHERE id = ?', [M('svc'), F.serviceId]);
            },
            pages: () => [
                ['superadmin', '/roles'],
                ['superadmin', `/roles/${F.roleId}`],
                ['superadmin', '/domains-skills'],
                ['superadmin', `/employees/${F.employee}`],
                ['superadmin', `/employees/${F.employee}/assessments`],
                ['superadmin', '/organization'],
                ['superadmin', '/admins/create'],
                ['superadmin', `/admins/${F.superadmin}`],
                ['superadmin', '/benchmark'],
                ['manager', `/employees/${F.employee}`],
                ['employee', `/employees/${F.employee}`],
            ],
        });
        judge('catalogue-names', rows);
        // The admin scope editors carry place names as JSON data (« < » escaped
        // as <), set as option text by the page: present, never as markup.
        const scopePages = await inRollback(async () => {
            await db.run('UPDATE sites SET name = ? WHERE id = ?', [M('site'), F.siteId]);
            return Promise.all([
                fetchPage('superadmin', '/admins/create'),
                fetchPage('superadmin', `/admins/${F.superadmin}`),
            ]);
        });
        for (const p of scopePages) {
            expect(p.status).toBe(200);
            expect(p.body).toContain('\\u003ci data-stx-site>m\\u003c/i>');
            expect(p.body).not.toMatch(RAW);
        }
    });

    test('notification title and reason: the notification centre and its JSON feed', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, created_at)
                     VALUES ('admin', ?, 'inapp', 'sa.cancelled', 'fr', ?::jsonb, 'sent', now())`,
                    [
                        F.superadmin,
                        JSON.stringify({
                            title: M('ntitle'),
                            reason: M('nreason'),
                            link: '/notifications',
                        }),
                    ]
                );
            },
            pages: () => [
                ['superadmin', '/notifications'],
                ['superadmin', '/api/notifications', true],
                ['superadmin', '/admin/notifications'],
            ],
        });
        judge('notification', rows);
    });

    test('self-assessment justification, notes and review comments: review queue and status pages', async () => {
        const rows = await storedCase({
            setup: async () => {
                const sa = await db.get(
                    `INSERT INTO self_assessment_rounds
                        (employee_id, skill_id, self_rated_level, status, workflow_state,
                         justification, notes, submitted_at)
                     VALUES (?, ?, 2, 'submitted', 'submitted', ?, ?, now()) RETURNING id`,
                    [F.employee, F.skillId, M('sajust'), M('sanotes')]
                );
                await db.run(
                    `INSERT INTO self_assessment_comments (self_assessment_id, author_id, author_type, body)
                     VALUES (?, ?, 'employee', ?)`,
                    [sa.id, F.manager, M('sacomment')]
                );
                return { sa: Number(sa.id) };
            },
            pages: (c) => [
                ['superadmin', `/employees/${F.employee}/assessments`],
                ['manager', `/employees/${F.employee}/assessments`],
                ['manager', '/supervisor/self-assessment-reviews'],
                ['manager', '/api/self-assessment/queue', true],
                ['manager', `/api/self-assessment/${c.sa}/thread`, true],
                ['employee', '/employee/self-assessment'],
                ['employee', '/employee/assessment-status'],
                ['employee', '/api/self-assessment/mine', true],
            ],
        });
        judge('self-assessment', rows);
    });

    test('campaign label and justification of a cancellation: campaigns pages', async () => {
        const rows = await storedCase({
            setup: async () => {
                const c = await db.get(
                    `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by,
                                                    cancelled_at, cancel_reason, cancelled_by_admin_id)
                     VALUES ('STX-1', ?, now() - interval '20 days', now() - interval '1 day',
                             'cancelled', ?, now(), ?, ?) RETURNING id`,
                    [M('cylabel'), F.superadmin, M('cyreason'), F.superadmin]
                );
                return { cycle: Number(c.id) };
            },
            pages: (c) => [
                ['superadmin', '/cycles'],
                ['superadmin', `/cycles/${c.cycle}`],
                ['superadmin', '/reports/dept-analytics'],
                ['superadmin', `/api/analytics/campaign-burndown?cycleId=${c.cycle}`, true],
            ],
        });
        judge('campaign', rows);
    });

    test('report template name and description: templates, builder and schedules', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run(
                    `INSERT INTO report_templates (name, description, report_type, data_source, selected_fields,
                                                   created_by, is_public, creator_type)
                     SELECT ?, ?, (SELECT enum_range(NULL::report_type))[1], 'employees', '[]'::jsonb, ?, true, 'admin'`,
                    [M('rtname'), M('rtdesc'), F.superadmin]
                );
            },
            pages: () => [
                ['superadmin', '/reports/templates'],
                ['superadmin', '/reports/templates', true],
                ['superadmin', '/reports/builder'],
                ['superadmin', '/reports/schedules'],
            ],
        });
        judge('report-template', rows);
    });

    test('a sign-up request: name, provider and decision note on the admin queue', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run(
                    `INSERT INTO onboarding_requests (email, first_name, last_name, source, auth_provider, status, decision_note)
                     VALUES (?, ?, ?, 'signup', ?, 'pending', ?)`,
                    [
                        'stored.text@example.test',
                        M('onbfirst'),
                        M('onblast'),
                        M('onbprov'),
                        M('onbnote'),
                    ]
                );
            },
            pages: () => [['superadmin', '/onboarding']],
        });
        judge('onboarding', rows);
    });

    test('white-label name, tagline and legal notice: page shells and the sign-in page', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        const branding = require('../../src/utils/branding');
        const realGet = AppSettingsModel.getValue.bind(AppSettingsModel);
        const BRAND = new Map([
            ['appName', M('appname')],
            ['brandTagline', M('tagline')],
            ['legalNotice', M('legal')],
        ]);
        // The settings cache hands the stored value back without re-reading
        // the row on each request, so the value is served at that seam.
        const spy = jest
            .spyOn(AppSettingsModel, 'getValue')
            .mockImplementation(async (k, dflt) =>
                BRAND.has(k) ? BRAND.get(k) : realGet(k, dflt)
            );
        if (typeof branding.invalidate === 'function') branding.invalidate();
        try {
            const rows = await storedCase({
                setup: async () => null,
                pages: () => [
                    ['superadmin', '/about'],
                    ['manager', '/employees'],
                    ['employee', '/notifications'],
                    ['anonymous', '/login'],
                ],
            });
            judge('branding', rows);
            expect(rows.filter((r) => r.escaped).length).toBeGreaterThanOrEqual(3);
        } finally {
            spy.mockRestore();
            if (typeof branding.invalidate === 'function') branding.invalidate();
        }
    });

    test('an admin’s own username (legacy or provisioned by an identity provider)', async () => {
        const hostile = 'stx</script><i data-stx-adminuser>m</i>';
        const rows = await storedCase({
            setup: async () => {
                await db.run('UPDATE admins SET username = ? WHERE id = ?', [
                    hostile,
                    F.superadmin,
                ]);
            },
            pages: () => [
                ['superadmin', '/admin/access-review'],
                ['superadmin', '/admins'],
                ['superadmin', '/admin/accounts'],
                ['superadmin', `/admins/${F.superadmin}`],
            ],
        });
        judge('admin-username', rows);
        // the script context: no `</script>` from data may close an inline script early
        const html = await inRollback(async () => {
            await db.run('UPDATE admins SET username = ? WHERE id = ?', [hostile, F.superadmin]);
            return (await fetchPage('superadmin', '/admin/access-review')).body;
        });
        expect(html).not.toContain('stx</script>');
    });

    test('a 360-degree feedback round title: the management list, the round and its subject', async () => {
        const rows = await storedCase({
            setup: async () => {
                const r = await db.get(
                    `INSERT INTO feedback360_rounds (title, kind, status, deadline, created_by_type, created_by_id)
                     VALUES (?, 'individual', 'open', CURRENT_DATE + 14, 'admin', ?) RETURNING id`,
                    [M('f360title'), F.superadmin]
                );
                const s = await db.get(
                    `INSERT INTO feedback360_subjects (round_id, employee_id, manager_employee_id, status)
                     VALUES (?, ?, ?, 'nominating') RETURNING id`,
                    [r.id, F.employee, F.manager]
                );
                return { round: Number(r.id), subject: Number(s.id) };
            },
            pages: (c) => [
                ['superadmin', '/feedback-360/manage'],
                ['superadmin', `/feedback-360/rounds/${c.round}`],
                ['superadmin', `/feedback-360/subjects/${c.subject}`],
                ['manager', '/feedback-360/'],
                ['employee', '/feedback-360/'],
                ['employee', `/feedback-360/subjects/${c.subject}`],
            ],
        });
        judge('feedback360', rows);
    });

    test('a one-to-one meeting: title, shared notes and agenda item', async () => {
        const rows = await storedCase({
            setup: async () => {
                const ci = await db.get(
                    `INSERT INTO check_ins (employee_id, manager_id, kind, title, scheduled_at, status, shared_notes, created_by)
                     VALUES (?, ?, 'one_on_one', ?, now() + interval '2 days', 'scheduled', ?, ?) RETURNING id`,
                    [F.employee, F.manager, M('ootitle'), M('oonotes'), F.manager]
                );
                await db.run(
                    `INSERT INTO one_on_one_agenda_items (check_in_id, author_employee_id, body) VALUES (?, ?, ?)`,
                    [ci.id, F.employee, M('ooagenda')]
                );
                await db.run(
                    `INSERT INTO one_on_one_notes (check_in_id, author_employee_id, visibility, body)
                     VALUES (?, ?, 'shared', ?)`,
                    [ci.id, F.manager, M('oonote')]
                );
            },
            pages: () => [
                ['manager', `/one-on-one/${F.employee}`],
                ['manager', `/one-on-one/${F.employee}/data.json`, true],
                ['employee', '/one-on-one/'],
                ['employee', `/one-on-one/${F.employee}`],
                ['superadmin', `/api/v1/employees/${F.employee}/check-ins`, true],
            ],
        });
        judge('one-on-one', rows);
    });

    test('an HRIS synchronisation run: source label and errors on the integration page', async () => {
        const rows = await storedCase({
            setup: async () => {
                await db.run(
                    `INSERT INTO hris_sync_runs (provider, mode, status, trigger, actor_ref, source_label, counts, errors)
                     VALUES ('csv', 'dry_run', 'planned', 'upload', ?, ?, '{}'::jsonb, ?::jsonb)`,
                    [
                        `admin:${F.superadmin}`,
                        M('hrislabel'),
                        JSON.stringify([{ row: 2, message: M('hriserr') }]),
                    ]
                );
            },
            pages: () => [['superadmin', '/admin/integrations/hris']],
        });
        judge('hris', rows);
    });
});
