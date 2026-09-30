'use strict';
/**
 * HRIS sync against the REAL schema, inside ONE transaction that also applies
 * migration 160 (idempotent) and is always rolled back — nothing survives.
 *
 *   - credentials are encrypted at rest (secretBox) and never read back;
 *   - dry run → apply creates joiners through the employee rules, links them,
 *     sets the supervisor; a SECOND apply of the same export changes nothing;
 *   - a mover goes through LifecycleService (a 'mover' event);
 *   - a leaver is deprovisioned (employee + account off, 'leaver' event);
 *   - an empty export trips the guard: aborted, nothing applied.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.APP_KEY = process.env.APP_KEY || 'hris-test-app-key-0123456789abcdef';
const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'ok' }),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const Hris = HAS_DB ? require('../../src/services/HrisSyncService') : null;
const MIG = fs.readFileSync(path.join(__dirname, '../../db/postgres/160_hris_sync.sql'), 'utf8');

let ready = false;
beforeAll(async () => {
    if (!HAS_DB) return;
    try {
        await db.connect();
        ready = true;
    } catch (_) {
        ready = false;
    }
});
afterAll(async () => {
    if (HAS_DB && ready) await db.close();
});

const ROLLBACK = new Error('__HRIS_ROLLBACK__');
async function inRolledBackTx(fn) {
    try {
        await db.runTransaction(async () => {
            await db._txStore.getStore().query(MIG);
            await fn();
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
}

const HEAD =
    'external_id,employee_number,first_name,last_name,email,job_title,department,site,service,manager_external_id,status';
const csv = (...rows) => [HEAD, ...rows].join('\n');

async function seedOrg() {
    const site = await db.get(
        `INSERT INTO sites (name, code) VALUES ('Hris Test Site', 'HRISTS') RETURNING id`
    );
    const dept = await db.get(
        `INSERT INTO departments (site_id, name) VALUES (?, 'Hris Test Dept') RETURNING id`,
        [site.id]
    );
    const svc = await db.get(
        `INSERT INTO services (department_id, name) VALUES (?, 'Hris Test Svc') RETURNING id`,
        [dept.id]
    );
    const r1 = await db.get(`INSERT INTO roles (name) VALUES ('Hris Test Welder') RETURNING id`);
    const r2 = await db.get(`INSERT INTO roles (name) VALUES ('Hris Test Lead') RETURNING id`);
    return {
        siteId: Number(site.id),
        deptId: Number(dept.id),
        svcId: Number(svc.id),
        welder: Number(r1.id),
        lead: Number(r2.id),
    };
}

const ACTOR = 'admin:1';
const BOSS =
    'HX-BOSS,HXE-900,Bea,Boss,bea.boss@hris.test,Hris Test Lead,Hris Test Dept,Hris Test Site,Hris Test Svc,,active';
const J1 =
    'HX-1,HXE-901,Ann,One,ann.one@hris.test,Hris Test Welder,Hris Test Dept,Hris Test Site,Hris Test Svc,HX-BOSS,active';
const J2 =
    'HX-2,HXE-902,Bob,Two,bob.two@hris.test,Hris Test Welder,Hris Test Dept,Hris Test Site,Hris Test Svc,HX-BOSS,active';

suite('HRIS sync on the real schema (rolled back)', () => {
    test('credentials are encrypted at rest, write-only, kept when left blank', async () => {
        if (!ready) return;
        await inRolledBackTx(async () => {
            await Hris.saveConnector(
                'personio',
                {
                    config: {},
                    credentials: { client_id: 'cid-123', client_secret: 's3cr3t-value' },
                },
                { actorRef: ACTOR }
            );
            const row = await db.get(
                `SELECT credentials FROM hris_connectors WHERE provider = 'personio'`
            );
            expect(row.credentials.startsWith('enc:v1:')).toBe(true);
            expect(row.credentials).not.toContain('s3cr3t-value');
            expect(row.credentials).not.toContain('cid-123');
            const masked = Hris.mask(await Hris.getRow('personio'));
            expect(masked.credentialsStored).toEqual({ client_id: true, client_secret: true });
            expect(JSON.stringify(masked)).not.toContain('s3cr3t-value');
            // A blank box keeps the stored secret; a new value replaces it.
            await Hris.saveConnector(
                'personio',
                { config: {}, credentials: { client_id: '', client_secret: 'rotated' } },
                { actorRef: ACTOR }
            );
            const creds = Hris.decryptCredentials(await Hris.getRow('personio'));
            expect(creds).toEqual({ client_id: 'cid-123', client_secret: 'rotated' });
            // Saving is audited, without the secret.
            const log = await db.get(
                `SELECT details FROM system_logs WHERE action = 'HRIS_CONNECTOR_SAVED' ORDER BY id DESC LIMIT 1`
            );
            expect(log.details).toMatch(/credentials updated \(client_secret\)/);
            expect(log.details).not.toContain('rotated');
        });
    });

    test('dry run → apply; a second apply of the same export changes nothing', async () => {
        if (!ready) return;
        await inRolledBackTx(async () => {
            const org = await seedOrg();
            await Hris.saveConnector(
                'csv',
                { enabled: true, leaverGuardPct: 50, config: { mode: 'full' } },
                { actorRef: ACTOR }
            );

            const text = csv(BOSS, J1, J2);
            const dry = await Hris.dryRun('csv', {
                trigger: 'upload',
                actorRef: ACTOR,
                text,
                fileName: 'x.csv',
            });
            expect(dry.status).toBe('planned');
            expect(dry.plan.counts).toMatchObject({
                joiners: 3,
                movers: 0,
                leavers: 0,
                unmapped: 0,
            });
            // a dry run writes no employee
            expect(
                await db.get(`SELECT id FROM employees WHERE employee_number = 'HXE-901'`)
            ).toBeFalsy();

            const res = await Hris.apply(dry.runId, { actorRef: ACTOR });
            expect(res.status).toBe('applied');
            expect(res.errors).toEqual([]);
            expect(res.applied).toMatchObject({ joiners: 3 });

            const ann = await db.get(
                `SELECT id, site_id, department_id, service_id, role_id, supervisor_id, username, is_active
                   FROM employees WHERE employee_number = 'HXE-901'`
            );
            const boss = await db.get(`SELECT id FROM employees WHERE employee_number = 'HXE-900'`);
            expect({
                siteId: Number(ann.siteId),
                departmentId: Number(ann.departmentId),
                serviceId: Number(ann.serviceId),
                roleId: Number(ann.roleId),
                isActive: ann.isActive,
            }).toEqual({
                siteId: org.siteId,
                departmentId: org.deptId,
                serviceId: org.svcId,
                roleId: org.welder,
                isActive: true,
            });
            expect(Number(ann.supervisorId)).toBe(Number(boss.id));
            expect(ann.username).toBe('ann.one');
            const link = await db.get(
                `SELECT employee_id FROM hris_links WHERE provider = 'csv' AND external_id = 'HX-1'`
            );
            expect(Number(link.employeeId)).toBe(Number(ann.id));
            const joinerEv = await db.get(
                `SELECT id FROM lifecycle_events WHERE employee_id = ? AND kind = 'joiner'`,
                [ann.id]
            );
            expect(joinerEv).toBeTruthy();

            // The dry run is consumed; applying it again is refused.
            await expect(Hris.apply(dry.runId, { actorRef: ACTOR })).rejects.toMatchObject({
                code: 'hris_run_not_applicable',
            });

            // Idempotent: the same export again plans nothing and applies nothing.
            const before = await db.get(`SELECT count(*)::int AS n FROM employees`);
            const dry2 = await Hris.dryRun('csv', { trigger: 'upload', actorRef: ACTOR, text });
            expect(dry2.plan.counts).toMatchObject({
                joiners: 0,
                movers: 0,
                updates: 0,
                leavers: 0,
                links: 0,
                unchanged: 3,
            });
            const res2 = await Hris.apply(dry2.runId, { actorRef: ACTOR });
            expect(res2.applied).toEqual({
                joiners: 0,
                movers: 0,
                updates: 0,
                leavers: 0,
                links: 0,
            });
            const after = await db.get(`SELECT count(*)::int AS n FROM employees`);
            expect(after.n).toBe(before.n);

            // Mover: Ann becomes a lead → through the lifecycle.
            const moved = csv(BOSS, J1.replace('Hris Test Welder', 'Hris Test Lead'), J2);
            const dry3 = await Hris.dryRun('csv', {
                trigger: 'manual',
                actorRef: ACTOR,
                text: moved,
            });
            expect(dry3.plan.movers).toEqual([
                expect.objectContaining({
                    externalId: 'HX-1',
                    changes: { roleId: { from: org.welder, to: org.lead } },
                }),
            ]);
            await Hris.apply(dry3.runId, { actorRef: ACTOR });
            const annRole = await db.get('SELECT role_id FROM employees WHERE id = ?', [ann.id]);
            expect(Number(annRole.roleId)).toBe(org.lead);
            const moverEv = await db.get(
                `SELECT payload FROM lifecycle_events WHERE employee_id = ? AND kind = 'mover' ORDER BY id DESC LIMIT 1`,
                [ann.id]
            );
            expect(moverEv.payload).toMatchObject({ source: 'hris', changed: ['roleId'] });

            // Leaver: Bob is gone from the full export → deprovisioned.
            const dry4 = await Hris.dryRun('csv', {
                trigger: 'manual',
                actorRef: ACTOR,
                text: csv(BOSS, J1.replace('Hris Test Welder', 'Hris Test Lead')),
            });
            expect(dry4.plan.leavers).toEqual([
                expect.objectContaining({ externalId: 'HX-2', reason: 'missing' }),
            ]);
            await Hris.apply(dry4.runId, { actorRef: ACTOR });
            const bob = await db.get(
                `SELECT id, is_active, is_account_active FROM employees WHERE employee_number = 'HXE-902'`
            );
            expect(bob).toMatchObject({ isActive: false, isAccountActive: false });
            const leaverEv = await db.get(
                `SELECT payload FROM lifecycle_events WHERE employee_id = ? AND kind = 'leaver' ORDER BY id DESC LIMIT 1`,
                [bob.id]
            );
            expect(leaverEv.payload).toMatchObject({ source: 'hris' });

            // Run log: counts, trigger, actor.
            const runs = await Hris.listRuns(20);
            const applied = runs.filter((r) => r.mode === 'apply');
            expect(applied.length).toBe(4);
            expect(applied[applied.length - 1]).toMatchObject({
                status: 'applied',
                trigger: 'manual',
                actorRef: ACTOR,
            });
        });
    });

    test('an empty export trips the guard: aborted, nothing applied, not appliable', async () => {
        if (!ready) return;
        await inRolledBackTx(async () => {
            await seedOrg();
            await Hris.saveConnector(
                'csv',
                { enabled: true, leaverGuardPct: 100, config: {} },
                { actorRef: ACTOR }
            );
            const first = await Hris.dryRun('csv', {
                trigger: 'upload',
                actorRef: ACTOR,
                text: csv(BOSS, J1),
            });
            await Hris.apply(first.runId, { actorRef: ACTOR });

            const empty = await Hris.dryRun('csv', {
                trigger: 'upload',
                actorRef: ACTOR,
                text: HEAD,
            });
            expect(empty.status).toBe('aborted');
            expect(empty.plan.guard).toMatchObject({ tripped: true, reason: 'empty_export' });
            await expect(Hris.apply(empty.runId, { actorRef: ACTOR })).rejects.toMatchObject({
                code: 'hris_run_not_applicable',
            });
            const still = await db.get(
                `SELECT is_active FROM employees WHERE employee_number = 'HXE-901'`
            );
            expect(still.isActive).toBe(true);
            const log = await db.get(
                `SELECT severity FROM system_logs WHERE action = 'HRIS_SYNC_ABORTED' ORDER BY id DESC LIMIT 1`
            );
            expect(log.severity).toBe('warn');

            // The guard is checked AGAIN at apply time: a plan reviewed under a
            // 100% threshold, applied after it was lowered, is stopped.
            const leave = await Hris.dryRun('csv', {
                trigger: 'upload',
                actorRef: ACTOR,
                text: csv(BOSS),
            });
            expect(leave.status).toBe('planned');
            await db.run(`UPDATE hris_connectors SET leaver_guard_pct = 1 WHERE provider = 'csv'`);
            const stopped = await Hris.apply(leave.runId, { actorRef: ACTOR });
            expect(stopped.status).toBe('aborted');
            expect((await Hris.getRun(leave.runId)).status).toBe('superseded');
            const annStill = await db.get(
                `SELECT is_active FROM employees WHERE employee_number = 'HXE-901'`
            );
            expect(annStill.isActive).toBe(true);
        });
    });

    test('scheduled job: nothing without a connector; plan + notify; apply only when ticked', async () => {
        if (!ready) return;
        const os = require('os');
        const JobRun = require('../../src/services/JobRunService');
        const alert = jest.spyOn(JobRun, 'alert').mockResolvedValue(1);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hris-job-'));
        try {
            await inRolledBackTx(async () => {
                await db.run('UPDATE hris_connectors SET enabled = false');
                const tick = require('../../src/jobs/hris-sync').tick;
                expect(await tick()).toEqual({ skipped: 'no_connector' });

                await seedOrg();
                fs.writeFileSync(path.join(dir, 'export.csv'), csv(BOSS, J1));
                await Hris.saveConnector(
                    'csv',
                    {
                        enabled: true,
                        scheduleHour: 0,
                        leaverGuardPct: 50,
                        config: { folder_path: dir },
                    },
                    { actorRef: ACTOR }
                );
                const at = new Date('2026-09-30T03:10:00');
                const r = await tick({ now: at });
                expect(r).toMatchObject({ done: true, provider: 'csv', status: 'planned' });
                expect(alert).toHaveBeenCalledWith(
                    'ops.hris_plan_ready',
                    `hris-plan:${r.dryRun}`,
                    expect.objectContaining({ link: `/admin/integrations/hris?run=${r.dryRun}` })
                );
                expect(
                    await db.get(`SELECT id FROM employees WHERE employee_number = 'HXE-901'`)
                ).toBeFalsy();
                expect(await tick({ now: at })).toEqual({ skipped: 'already_today' });

                // "Apply automatically" ticked → the next pass applies.
                await Hris.saveConnector(
                    'csv',
                    {
                        enabled: true,
                        autoApply: true,
                        scheduleHour: 0,
                        leaverGuardPct: 50,
                        config: { folder_path: dir },
                    },
                    { actorRef: ACTOR }
                );
                const r2 = await tick({ now: new Date('2026-10-01T03:10:00') });
                expect(r2).toMatchObject({ status: 'applied' });
                expect(
                    await db.get(`SELECT id FROM employees WHERE employee_number = 'HXE-901'`)
                ).toBeTruthy();
                const run = await Hris.getRun(r2.apply);
                expect(run).toMatchObject({
                    trigger: 'schedule',
                    actorRef: 'system:hris',
                    status: 'applied',
                });

                // An empty export the next night: guard → alert, nothing applied.
                fs.writeFileSync(path.join(dir, 'export.csv'), HEAD);
                const r3 = await tick({ now: new Date('2026-10-02T03:10:00') });
                expect(r3).toMatchObject({ status: 'aborted' });
                expect(alert).toHaveBeenCalledWith(
                    'ops.hris_sync_alert',
                    `hris-abort:${r3.dryRun}`,
                    expect.any(Object)
                );
            });
        } finally {
            alert.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('SCIM placement: every value maps → placed; one does not → not placed (queue)', async () => {
        if (!ready) return;
        await inRolledBackTx(async () => {
            const org = await seedOrg();
            const AppSettings = require('../../src/models/AppSettingsModel');
            await AppSettings.setValue(
                'hris.scimAutoPlace',
                'true',
                'boolean',
                'test',
                'onboarding'
            );
            await Hris.addMapping('department', 'Extraction', org.deptId, { actorRef: ACTOR });
            await Hris.addMapping('role', 'Soudeur', org.welder, { actorRef: ACTOR });
            const boss = await db.get(
                `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id)
                 VALUES ('HXE-BOSS', 'Bea', 'Boss', ?, ?, ?, ?) RETURNING id`,
                [org.siteId, org.deptId, org.svcId, org.lead]
            );
            const EXT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
            const user = (over = {}) => ({
                userName: 'awa.scim@hris.test',
                externalId: 'entra-awa',
                name: { givenName: 'Awa', familyName: 'Scim' },
                title: 'Soudeur',
                [EXT]: {
                    employeeNumber: 'HXE-SCIM',
                    department: 'Extraction',
                    manager: { value: String(boss.id) },
                },
                ...over,
            });

            const miss = await Hris.scimPlace(user({ title: 'Astronaut' }), { actorRef: ACTOR });
            expect(miss).toEqual({ placed: false, reasons: ['unmapped_role'] });
            const badMgr = await Hris.scimPlace(
                user({ [EXT]: { department: 'Extraction', manager: { value: '999999999' } } }),
                { actorRef: ACTOR }
            );
            expect(badMgr.placed).toBe(false);
            expect(badMgr.reasons).toContain('unmapped_manager');

            const ok = await Hris.scimPlace(user(), { actorRef: ACTOR });
            expect(ok.placed).toBe(true);
            const e = await db.get(
                `SELECT employee_number, service_id, role_id, supervisor_id FROM employees WHERE id = ?`,
                [ok.employeeId]
            );
            expect(e.employeeNumber).toBe('HXE-SCIM');
            expect(Number(e.serviceId)).toBe(org.svcId); // the department's only service
            expect(Number(e.roleId)).toBe(org.welder);
            expect(Number(e.supervisorId)).toBe(Number(boss.id));
            const link = await db.get(
                `SELECT employee_id FROM hris_links WHERE provider = 'scim' AND external_id = 'entra-awa'`
            );
            expect(Number(link.employeeId)).toBe(ok.employeeId);

            // Switched off → never placed.
            await AppSettings.setValue(
                'hris.scimAutoPlace',
                'false',
                'boolean',
                'test',
                'onboarding'
            );
            expect(await Hris.scimPlace(user({ userName: 'other@hris.test' }))).toEqual({
                placed: false,
                reasons: ['disabled'],
            });
        });
    });
});
