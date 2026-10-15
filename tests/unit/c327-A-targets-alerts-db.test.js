'use strict';
/**
 * KPI targets and the threshold-alert engine on the REAL test database
 * (migration 186). Every case runs in one transaction that is always rolled
 * back: the database is left as found.
 *
 *   targets   dated resolution, organisation inheritance, a withdrawal stops
 *             it, append-only (UPDATE and DELETE refused), authority (a
 *             SuperAdmin everywhere; a local admin needs manage_kpi_targets AND
 *             the site in clearance; the organisation needs an unrestricted
 *             clearance; a viewer never), audited, the same decision posted
 *             twice appends nothing, a module that is off refuses its KPIs;
 *   alerts    an alert fires ONCE per band entry, re-raises only when worse,
 *             « back to normal » once; a pass on unchanged figures sends
 *             nothing; the first pass announces what is already in a band; a
 *             site alert reaches the in-scope accounts only; a recipient not
 *             told is retried alone; the daily claim runs one pass a day; a
 *             module that is off is never computed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

let mockFlags = { campaigns: true, development: true, talent: true, mobility: true };
jest.mock('../../src/services/ModuleService', () => ({
    flags: async () => ({ ...mockFlags }),
    isOn: async (k) => mockFlags[k] === true,
}));
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'queued', email: 'digest_deferred' }),
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const T = HAS_DB ? require('../../src/services/KpiTargetService') : null;
const A = HAS_DB ? require('../../src/services/KpiAlertService') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;
const N = require('../../src/services/NotificationService');
const EmailT = require('../../src/utils/emailTemplate');

const ROLLBACK = new Error('__C327A_ROLLBACK__');
async function inTx(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

let SUPER;
let SITES;
let N_SITES = 0;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const a = await db.get(
        `SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1`
    );
    SUPER = { userType: 'admin', role: 'superadmin', id: Number(a.id) };
    SITES = (await db.all('SELECT id FROM sites ORDER BY id LIMIT 2')).map((s) => Number(s.id));
    N_SITES = SITES.length;
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const STAMP = `${Date.now()}`.slice(-7);
async function mkAdmin(tag, role, siteId, perms = []) {
    const row = await db.get(
        `INSERT INTO admins (username, password_hash, role) VALUES (?, 'x', ?) RETURNING id`,
        [`c327a_${tag}_${STAMP}`, role]
    );
    const id = Number(row.id);
    if (siteId)
        await db.run(
            `INSERT INTO admin_scopes (admin_id, scope_type, site_id) VALUES (?, 'site', ?)`,
            [id, siteId]
        );
    for (const p of perms)
        await db.run(`INSERT INTO admin_permissions (admin_id, permission) VALUES (?, ?)`, [id, p]);
    return { id, userType: 'admin', role, permissions: perms };
}
const mailText = (m) => {
    const c = m.content(EmailT.blocks('fr'));
    return [c.intro, ...c.blocks.map((b) => b.text)].join(' ');
};

suite('KPI targets (rolled back)', () => {
    afterEach(() => {
        mockFlags = { campaigns: true, development: true, talent: true, mobility: true };
    });

    test('dated, organisation inheritance, withdrawal, append-only, audited, idempotent', async () => {
        await inTx(async () => {
            const S1 = SITES[0];
            const k1 = (scopeType, targetValue, effectiveFrom, extra = {}) => ({
                kpiId: 'K1',
                scopeType,
                targetValue,
                effectiveFrom,
                reason: 'Workforce plan',
                ...extra,
            });
            await T.setTarget(k1('org', '75', '2026-01-01'), SUPER);
            await T.setTarget(k1('org', '80,5', '2026-06-01'), SUPER);
            expect((await T.targetFor('K1', 'org', '2026-03-01')).value).toBe(75);
            expect((await T.targetFor('K1', 'org', '2026-07-01')).value).toBe(80.5);
            expect(await T.targetFor('K1', 'org', '2025-12-31')).toBeNull();
            expect(await T.targetFor('K2', 'org', '2026-07-01')).toBeNull(); // no target set
            expect(await T.targetFor('K1', { type: 'site', id: S1 }, '2026-07-01')).toMatchObject({
                value: 80.5,
                inherited: true,
            });
            await T.setTarget(k1('site', '', '2026-07-01', { scopeId: S1 }), SUPER);
            expect(await T.targetFor('K1', { siteId: S1 }, '2026-07-02')).toBeNull();
            // the same decision posted again appends nothing
            const again = await T.setTarget(k1('org', '80.5', '2026-06-01'), SUPER);
            expect(again.unchanged).toBe(true);
            const n = await db.get(
                "SELECT COUNT(*)::int AS n FROM kpi_targets WHERE kpi_id = 'K1' AND reason = 'Workforce plan'"
            );
            expect(n.n).toBe(3);
            // append-only
            await expect(
                db.runInSavepoint(() =>
                    db.run(`UPDATE kpi_targets SET target_value = 1 WHERE kpi_id = 'K1'`)
                )
            ).rejects.toThrow(/append-only/);
            await expect(
                db.runInSavepoint(() => db.run(`DELETE FROM kpi_targets WHERE kpi_id = 'K1'`))
            ).rejects.toThrow(/append-only/);
            const log = await db.get(
                `SELECT COUNT(*)::int AS n FROM system_logs
                  WHERE action IN ('KPI_TARGET_SET', 'KPI_TARGET_WITHDRAWN') AND entity_type = 'kpi_target'`
            );
            expect(log.n).toBeGreaterThanOrEqual(3);
            // a calendar day that does not exist is refused, not a 500
            await expect(T.setTarget(k1('org', '70', '2026-02-31'), SUPER)).rejects.toMatchObject({
                code: 'invalid_date',
            });
        });
    });

    test('authority: the permission AND the clearance; the organisation needs an unrestricted one', async () => {
        await inTx(async () => {
            const [S1, S2] = SITES;
            const hr = await mkAdmin('hr', 'localadmin', S1, ['manage_kpi_targets']);
            const noPerm = await mkAdmin('np', 'localadmin', S1, []);
            const viewer = await mkAdmin('vw', 'viewer', S1, ['manage_kpi_targets']);
            const input = (scopeType, scopeId) => ({
                kpiId: 'K9',
                scopeType,
                scopeId,
                targetValue: '100',
                effectiveFrom: '2026-10-01',
                reason: 'Safety',
            });
            await expect(T.setTarget(input('site', S1), hr)).resolves.toMatchObject({ value: 100 });
            if (S2)
                await expect(T.setTarget(input('site', S2), hr)).rejects.toMatchObject({
                    code: 'forbidden',
                });
            await expect(T.setTarget(input('org'), hr)).rejects.toMatchObject({
                code: 'forbidden',
            });
            await expect(T.setTarget(input('site', S1), noPerm)).rejects.toMatchObject({
                code: 'forbidden',
            });
            await expect(T.setTarget(input('site', S1), viewer)).rejects.toMatchObject({
                code: 'forbidden',
            });
            await expect(
                T.setTarget({ ...input('site', S1), targetValue: '120' }, hr)
            ).rejects.toMatchObject({ code: 'invalid_value' });
            await expect(
                T.setTarget({ ...input('site', S1), reason: '  ' }, hr)
            ).rejects.toMatchObject({ code: 'reason_required' });
            await expect(
                T.setTarget({ ...input('org'), kpiId: 'K6', targetValue: '1,5' }, SUPER)
            ).rejects.toMatchObject({ code: 'invalid_value' });
            await expect(
                T.setTarget({ ...input('org'), kpiId: 'K14', targetValue: '30' }, SUPER)
            ).rejects.toMatchObject({ code: 'invalid_kpi' });
            const ov = await T.overview(hr);
            expect(ov.canEdit).toBe(true);
            expect(ov.canEditOrg).toBe(false);
            expect(ov.editableSites).toEqual([S1]);
            const ovv = await T.overview(viewer);
            expect(ovv.canEdit).toBe(false);
        });
    });

    test('a module that is off: its indicators are not offered, not accepted, have no target', async () => {
        await inTx(async () => {
            await T.setTarget(
                {
                    kpiId: 'K6',
                    scopeType: 'org',
                    targetValue: '1',
                    effectiveFrom: '2026-01-01',
                    reason: 'Bench',
                },
                SUPER
            );
            mockFlags = {};
            expect(await T.targetableIds()).not.toContain('K6');
            expect(await T.targetableIds()).not.toContain('K11');
            expect(await T.targetFor('K6', 'org', '2026-02-01')).toBeNull();
            await expect(
                T.setTarget(
                    {
                        kpiId: 'K11',
                        scopeType: 'org',
                        targetValue: '80',
                        effectiveFrom: '2026-01-01',
                        reason: 'x',
                    },
                    SUPER
                )
            ).rejects.toMatchObject({ code: 'not_found', status: 404 });
            const kept = await db.get(
                `SELECT COUNT(*)::int AS n FROM kpi_targets WHERE kpi_id = 'K6' AND reason = 'Bench'`
            );
            expect(kept.n).toBe(1); // stored rows are kept
        });
    });
});

suite('KPI alert engine (rolled back, KpiService stubbed)', () => {
    let spy;
    // hermetic: targets stored on the database (append-only, they cannot be
    // removed in the transaction) must not change what the stubbed figures raise
    let tspy = null;
    afterEach(() => {
        if (spy) spy.mockRestore();
        spy = null;
        if (tspy) tspy.mockRestore();
        tspy = null;
        mockFlags = { campaigns: true, development: true, talent: true, mobility: true };
        N.notify.mockReset();
        N.notify.mockResolvedValue({ inapp: 'queued', email: 'digest_deferred' });
    });

    /** Stub bySite: the organisation and one site; K8 expired people driven by `state.k8`. */
    function stub(siteId, state, seen = []) {
        tspy = jest.spyOn(T, 'targetFor').mockResolvedValue(null);
        spy = jest.spyOn(K, 'bySite').mockImplementation(async (kpiId) => {
            seen.push(kpiId);
            const r = (o) => ({ kpi: kpiId, n: 30, ...o });
            const make = () => {
                if (kpiId === 'K8')
                    return r({
                        value: state.k8,
                        status: state.k8 ? 'at_risk' : 'compliant',
                        breakdown: { expiredPeople: state.k8 },
                    });
                if (kpiId === 'K1') return r({ value: 90, status: 'compliant' });
                if (kpiId === 'K3') return r({ value: 90, rawValue: 90 });
                if (kpiId === 'K9') return r({ value: 100, status: 'compliant' });
                if (kpiId === 'K6') return r({ value: 0, status: 'compliant' });
                if (kpiId === 'K11') return r({ value: null, status: null, campaigns: [] });
                return r({ value: null });
            };
            return {
                kpi: kpiId,
                org: make(),
                rows: [{ siteId, siteName: 'S', noSite: false, result: make() }],
            };
        });
    }
    const calls = () => N.notify.mock.calls.map((c) => c[0]);

    test('fires once per band entry, re-raises only when worse, recovers once; in-scope audience', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM kpi_alert_states');
            await db.run('DELETE FROM kpi_alert_events');
            const [S1, S2] = SITES;
            const hse = await mkAdmin('hse', 'localadmin', S1, ['view_compliance']);
            const hr = await mkAdmin('hr2', 'localadmin', S1, ['manage_kpi_targets']);
            const dir = await mkAdmin('dir', 'viewer', S1, []);
            const plain = await mkAdmin('pl', 'localadmin', S1, []);
            const other = S2 ? await mkAdmin('oth', 'localadmin', S2, ['view_compliance']) : null;
            const state = { k8: 2 };
            stub(S1, state);

            // first pass: everything already in a band is announced
            const r1 = await A.run({ today: '2026-10-04' });
            expect(r1.raised).toBe(2); // organisation + site K8
            const site = calls().filter((m) => m.payload.scopeType === 'site');
            const told = site.map((m) => m.userId).sort((a, b) => a - b);
            expect(told).toEqual([hse.id, hr.id, dir.id].sort((a, b) => a - b));
            expect(told).not.toContain(plain.id);
            if (other) expect(told).not.toContain(other.id);
            for (const m of site) {
                expect(m.kind).toBe('safety.kpi_alert');
                expect(m.payload.figures).toMatchObject({ kpi: 'K8', value: 2 });
                expect(mailText(m)).not.toMatch(/\d/);
            }
            expect(
                calls()
                    .filter((m) => m.payload.scopeType === 'org')
                    .map((m) => m.userId)
            ).toContain(SUPER.id);

            // unchanged figures: nothing
            N.notify.mockClear();
            const r2 = await A.run({ today: '2026-10-05' });
            expect(r2.raised + r2.worsened + r2.recovered).toBe(0);
            expect(N.notify).not.toHaveBeenCalled();

            // better but still in the band: nothing
            state.k8 = 1;
            const r2b = await A.run({ today: '2026-10-05' });
            expect(r2b.raised + r2b.worsened + r2b.recovered).toBe(0);
            // back to the previous peak: still nothing (only a NEW peak re-raises)
            state.k8 = 2;
            const r2c = await A.run({ today: '2026-10-05' });
            expect(r2c.worsened).toBe(0);
            expect(N.notify).not.toHaveBeenCalled();

            // worse than ever: re-raised
            state.k8 = 3;
            const r3 = await A.run({ today: '2026-10-06' });
            expect(r3.worsened).toBe(2);

            // back to normal, once
            state.k8 = 0;
            N.notify.mockClear();
            const r4 = await A.run({ today: '2026-10-07' });
            expect(r4.recovered).toBe(2);
            expect(calls().every((m) => m.kind === 'kpi.recovered')).toBe(true);
            const r5 = await A.run({ today: '2026-10-08' });
            expect(r5.recovered).toBe(0);

            const ev = await db.get(
                `SELECT COUNT(*)::int AS n, bool_and(complete) AS ok FROM kpi_alert_events WHERE kpi_id = 'K8'`
            );
            expect(ev.n).toBe(6);
            expect(ev.ok).toBe(true);
        });
    });

    test('a recipient not told is retried alone on the next pass', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM kpi_alert_states');
            await db.run('DELETE FROM kpi_alert_events');
            const [S1] = SITES;
            const a1 = await mkAdmin('r1', 'viewer', S1, []);
            const a2 = await mkAdmin('r2', 'viewer', S1, []);
            stub(S1, { k8: 1 });
            N.notify.mockImplementation(async (m) =>
                m.userId === a2.id && m.payload.scopeType === 'site'
                    ? { inapp: 'error' }
                    : { inapp: 'queued' }
            );
            await A.run({ today: '2026-10-04' });
            N.notify.mockReset();
            N.notify.mockResolvedValue({ inapp: 'queued' });
            const r2 = await A.run({ today: '2026-10-05' });
            expect(r2.retried).toBeGreaterThanOrEqual(1);
            const retried = calls().map((m) => m.userId);
            expect(retried).toContain(a2.id);
            expect(retried).not.toContain(a1.id);
        });
    });

    test('module-aware: K6 and K11 are never computed while their modules are off', async () => {
        await inTx(async () => {
            const seen = [];
            stub(SITES[0], { k8: 0 }, seen);
            mockFlags = {};
            await A.run({ today: '2026-10-04' });
            expect(seen).not.toContain('K6');
            expect(seen).not.toContain('K11');
            expect(seen).toEqual(expect.arrayContaining(['K1', 'K3', 'K8', 'K9']));
        });
    });

    test('a real KpiService pass completes and a second pass on the same figures is silent', async () => {
        await inTx(async () => {
            const r1 = await A.run({ today: '2026-10-04' });
            expect(r1.failed).toEqual([]);
            expect(r1.evaluated).toBeGreaterThan(0);
            for (const m of calls()) {
                expect(m.payload.figures).toBeDefined();
                expect(mailText(m)).not.toMatch(/\d/);
            }
            N.notify.mockClear();
            const r2 = await A.run({ today: '2026-10-05' });
            expect(r2.raised + r2.worsened + r2.recovered).toBe(0);
            expect(N.notify).not.toHaveBeenCalled();
        });
    });

    test('the daily claim runs one pass a day', async () => {
        await inTx(async () => {
            const job = require('../../src/jobs/kpi-alerts');
            await db.run(`DELETE FROM kpi_alert_states WHERE rule_key = '__run__'`);
            expect(await job.__test.claimDay('2026-10-04')).toBe(true);
            expect(await job.__test.claimDay('2026-10-04')).toBe(false);
            expect(await job.__test.claimDay('2026-10-05')).toBe(true);
            expect(await job.tick({ now: new Date(2026, 9, 5, 2, 0, 0) })).toEqual({
                skipped: 'too_early',
            });
        });
    });

    test('the test database has sites', () => {
        expect(N_SITES).toBeGreaterThan(0);
    });
});
