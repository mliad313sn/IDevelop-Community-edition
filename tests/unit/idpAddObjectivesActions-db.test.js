'use strict';
/**
 * The IDP page is no longer a dead end: objectives and actions are added from
 * it (POST /v2/idp/:id/objectives and /actions, IDPService.addObjective /
 * addAction).
 *
 *   - the plan authority (the direct supervisor or manager, an in-scope admin)
 *     adds an objective or an action: one row, journalled;
 *   - the subject of the plan and a read-only delegate are refused, nothing
 *     written; an empty text is refused; a closed plan is refused;
 *   - an action links only to an objective of the SAME plan;
 *   - a plan created from the page is seeded in the reader's language;
 *   - the page says whose plan it is, offers the add forms to the authority,
 *     names the action types in words, and an empty list says what to do next.
 *
 * The service cases run on the real test database inside rolled-back
 * transactions; the page is rendered from the real template.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: async () => ({}),
    enqueueBulkInApp: async () => ({}),
}));
jest.mock('../../src/services/LogService', () => ({ log: async () => {} }));

const db = HAS_DB ? require('../../src/config/database') : null;
beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    let result = null;
    let error = null;
    await db
        .runTransaction(async () => {
            try {
                result = await fn();
            } catch (e) {
                error = e;
            }
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    if (error) throw error;
    return result;
}
async function attempt(fn) {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e;
    }
}

let seq = 0;
async function person(supervisorId = null) {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
    );
    seq += 1;
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, supervisor_id, is_active)
         VALUES (?, 'Plan', ?, ?, ?, ?, ?, ?, true) RETURNING id`,
        [
            `IDP-${Date.now()}-${seq}`,
            `Holder ${seq}`,
            tpl.siteId,
            tpl.departmentId,
            tpl.serviceId,
            tpl.roleId,
            supervisorId,
        ]
    );
    return Number(r.id);
}

suite('IDPService.addObjective / addAction on the real schema', () => {
    test('the authority adds; the subject, a viewer, an empty text and a closed plan are refused', async () => {
        const out = await inRolledBackTx(async () => {
            const IDP = require('../../src/services/IDPService');
            const sup = await person();
            const subj = await person(sup);
            const plan = await db.get(
                `INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id`,
                [subj]
            );
            const SUP = { id: sup, userType: 'employee' };
            const r = {};
            r.obj = await IDP.addObjective({
                idpId: plan.id,
                user: SUP,
                smartText: 'Lead two site inductions by the end of the quarter',
                dueOn: '2027-01-31',
            });
            r.act = await IDP.addAction({
                idpId: plan.id,
                user: SUP,
                title: 'Shadow an experienced inductor',
                type: 'mentoring',
                objectiveId: r.obj.objectiveId,
            });
            r.objRow = await db.get(
                'SELECT smart_text, due_on, state FROM idp_objectives WHERE id = ?',
                [r.obj.objectiveId]
            );
            r.actRow = await db.get(
                'SELECT title, type, objective_id, status FROM idp_actions WHERE id = ?',
                [r.act.actionId]
            );
            r.events = (
                await db.all(`SELECT action FROM idp_plan_events WHERE idp_id = ? ORDER BY id`, [
                    plan.id,
                ])
            ).map((e) => e.action);
            // an objective of ANOTHER plan is not linked
            const other = await db.get(
                `INSERT INTO idp_plans (employee_id, status) VALUES (?, 'draft') RETURNING id`,
                [await person(sup)]
            );
            const foreign = await IDP.addObjective({
                idpId: other.id,
                user: { id: 1, userType: 'admin', role: 'superadmin' },
                smartText: 'Another plan',
            });
            const linked = await IDP.addAction({
                idpId: plan.id,
                user: SUP,
                title: 'Unlinked on purpose',
                objectiveId: foreign.objectiveId,
                type: 'not-a-type',
            });
            r.foreign = await db.get('SELECT objective_id, type FROM idp_actions WHERE id = ?', [
                linked.actionId,
            ]);
            const before = Number(
                (
                    await db.get('SELECT COUNT(*)::int AS n FROM idp_objectives WHERE idp_id = ?', [
                        plan.id,
                    ])
                ).n
            );
            r.subject = await attempt(() =>
                IDP.addObjective({
                    idpId: plan.id,
                    user: { id: subj, userType: 'employee' },
                    smartText: 'My own objective',
                })
            );
            r.viewer = await attempt(() =>
                IDP.addAction({
                    idpId: plan.id,
                    user: { id: 3, userType: 'admin', role: 'viewer' },
                    title: 'Viewer action',
                })
            );
            r.empty = await attempt(() =>
                IDP.addObjective({ idpId: plan.id, user: SUP, smartText: '   ' })
            );
            await db.run(`UPDATE idp_plans SET status = 'archived' WHERE id = ?`, [plan.id]);
            r.closed = await attempt(() =>
                IDP.addObjective({ idpId: plan.id, user: SUP, smartText: 'Too late' })
            );
            r.after = Number(
                (
                    await db.get('SELECT COUNT(*)::int AS n FROM idp_objectives WHERE idp_id = ?', [
                        plan.id,
                    ])
                ).n
            );
            r.before = before;
            return r;
        });
        expect(out.objRow).toMatchObject({
            smartText: 'Lead two site inductions by the end of the quarter',
            state: 'pending',
        });
        expect(out.actRow).toMatchObject({
            title: 'Shadow an experienced inductor',
            type: 'mentoring',
            objectiveId: String(out.obj.objectiveId),
            status: 'pending',
        });
        expect(out.events).toEqual(['objective_added', 'action_added']);
        expect(out.foreign).toEqual({ objectiveId: null, type: 'training' });
        expect(out.subject && out.subject.code).toBe('IDP_OWN_PLAN');
        expect(out.viewer && out.viewer.code).toBe('IDP_FORBIDDEN');
        expect(out.empty && out.empty.code).toBe('IDP_TEXT_REQUIRED');
        expect(out.closed && out.closed.code).toBe('IDP_NOT_OPEN');
        expect(out.after).toBe(out.before);
    });

    test('a plan seeded in English reads in English (objective and action)', async () => {
        const out = await inRolledBackTx(async () => {
            const IDP = require('../../src/services/IDPService');
            const subj = await person();
            const emp = await db.get('SELECT role_id FROM employees WHERE id = ?', [subj]);
            const req = await db.get(
                `SELECT skill_id FROM role_skill_requirements WHERE role_id = ? AND required_level > 0
                  ORDER BY skill_id LIMIT 1`,
                [emp.roleId]
            );
            if (!req) return { skipped: true };
            const { idpId } = await IDP.createManualPlan({
                employeeId: subj,
                skillIds: [req.skillId],
                locale: 'en',
            });
            return {
                objectives: await db.all('SELECT smart_text FROM idp_objectives WHERE idp_id = ?', [
                    idpId,
                ]),
                actions: await db.all('SELECT title FROM idp_actions WHERE idp_id = ?', [idpId]),
            };
        });
        if (out.skipped) return;
        expect(out.objectives.length).toBeGreaterThan(0);
        for (const o of out.objectives) expect(o.smartText).toMatch(/^By /);
        for (const a of out.actions) {
            expect(a.title).toMatch(/reach level \d/);
            expect(a.title).not.toMatch(/close gap to/);
        }
    });
});

// ---- the page ---------------------------------------------------------------
const ROOT = path.join(__dirname, '../..');
const loadNs = (lng, ns) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lng, ns + '.json'), 'utf8'));
const tFor = (lng) => (key, opts) => {
    const [ns, k] = String(key).includes(':') ? key.split(':') : ['common', key];
    let dict;
    try {
        dict = loadNs(lng, ns);
    } catch (_) {
        dict = {};
    }
    let v =
        typeof dict[k] === 'string' ? dict[k] : opts && opts.defaultValue ? opts.defaultValue : key;
    for (const [p, val] of Object.entries(opts || {}))
        v = v.split('{{' + p + '}}').join(String(val));
    return v;
};
const render = (lng, locals) =>
    ejs.renderFile(path.join(ROOT, 'views/pages/idp/detail.ejs'), {
        __: tFor(lng),
        colon: lng === 'fr' ? ' :' : ':',
        csrfToken: 't',
        cspNonce: 'n',
        fmtDate: (d) => String(d).slice(0, 10),
        actionTypes: require('../../src/services/IDPService').ACTION_TYPES,
        ...locals,
    });
const PLAN = { id: 7, employeeId: 70, status: 'active' };

describe('the IDP page', () => {
    test.each(['fr', 'en'])(
        '%s: the authority sees whose plan it is, empty states with a next step, and the add forms',
        async (lng) => {
            const html = await render(lng, {
                plan: PLAN,
                objectives: [],
                actions: [],
                canManagePlan: true,
                subjectName: 'Alex Sample',
                roleSkills: [{ id: 3, name: 'Lifting' }],
            });
            const t = tFor(lng);
            expect(html).toContain(t('idp:detail_title', { name: 'Alex Sample' }));
            expect(html).toContain('action="/v2/idp/7/objectives"');
            expect(html).toContain('action="/v2/idp/7/actions"');
            expect(html).toContain(t('idp:objectives_empty_msg'));
            expect(html).toContain(t('idp:actions_empty_msg'));
            expect(html).toContain('href="#idp-add-objective"');
            expect(html).toContain(t('idp:act_on_the_job'));
            expect(html).toContain('Lifting');
            expect(html).not.toMatch(/idp:[a-z_]+/); // no raw key reaches the page
        }
    );

    test('the subject sees the plan without the add forms, and action types in words', async () => {
        const html = await render('en', {
            plan: PLAN,
            objectives: [{ id: 1, smartText: 'Reach level 3', state: 'pending' }],
            actions: [{ id: 2, title: 'Course', type: 'self_study', status: 'pending' }],
            canManagePlan: false,
            subjectName: 'Alex Sample',
        });
        expect(html).not.toContain('action="/v2/idp/7/objectives"');
        expect(html).not.toContain('action="/v2/idp/7/actions"');
        expect(html).toContain('Self-study');
        expect(html).not.toContain('>self_study<');
    });

    test('a closed plan offers no add form, even to its authority', async () => {
        const html = await render('fr', {
            plan: { ...PLAN, status: 'completed' },
            objectives: [],
            actions: [],
            canManagePlan: true,
            subjectName: 'Alex Sample',
        });
        expect(html).not.toContain('action="/v2/idp/7/objectives"');
        expect(html).not.toContain('href="#idp-add-objective"');
    });
});
