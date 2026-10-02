'use strict';
/**
 * Privacy (migration 165) against the REAL schema, every case inside one
 * transaction that is always rolled back (nothing persists):
 *
 *   - the notice: placeholders refused, versions append-only, a stale version
 *     cannot be acknowledged, acknowledgements counted per account type;
 *   - the objection to profiling: recorded once, the stored automated
 *     retention verdict withdrawn (never a low score), a recompute refuses to
 *     score, the automatic 9-box trigger is held for review and its decision
 *     needs a reason; withdrawal re-opens scoring;
 *   - the "my data" download: built on DSRService.export, confidential talent
 *     categories withheld and named, the objection included; the per-hour
 *     ceiling holds;
 *   - erasure deletes the objection rows and keeps the acknowledgement.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'ok' }),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const Privacy = HAS_DB ? require('../../src/services/PrivacyService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw new Error('__ROLLBACK__');
        });
    } catch (err) {
        if (!String(err.message).includes('__ROLLBACK__')) throw err;
    } finally {
        Privacy.clearCache();
    }
}

const NOTICE = {
    titleFr: 'Notice',
    titleEn: 'Notice',
    bodyFr: '## Responsable\nSociété exemple\n- point',
    bodyEn: '## Controller\nExample company\n- item',
};

async function anEmployee() {
    return db.get('SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 1');
}

suite('privacy notice', () => {
    test('placeholders refused; versions append-only; stale version refused', async () => {
        await inRollback(async () => {
            const emp = await anEmployee();
            const user = { id: Number(emp.id), userType: 'employee' };
            await expect(
                Privacy.publish({ ...NOTICE, bodyEn: 'Contact [[DPO]]' }, 'admin:1')
            ).rejects.toMatchObject({ status: 400, code: 'notice_placeholders' });
            expect(Privacy.DEFAULT_TEMPLATE.fr.body).toMatch(Privacy.PLACEHOLDER_RE);

            const before = await Privacy.currentVersion({ fresh: true });
            const v1 = await Privacy.publish(NOTICE, 'admin:1');
            const v2 = await Privacy.publish({ ...NOTICE, changeNote: 'x' }, 'admin:1');
            expect(v2.version).toBe(v1.version + 1);
            expect(v1.version).toBe(before ? Number(before.version) + 1 : 1);

            await expect(Privacy.acknowledge(user, v1.version, 'en')).rejects.toMatchObject({
                status: 409,
                code: 'stale_version',
            });
            await Privacy.acknowledge(user, v2.version, 'en');
            await Privacy.acknowledge(user, v2.version, 'en'); // idempotent
            expect(
                await Privacy.hasAcknowledged({ type: 'employee', id: user.id }, v2.version)
            ).toBe(true);
            expect(await Privacy.ackStats(v2.version)).toEqual({ admin: 0, employee: 1 });

            const shown = Privacy.present(await Privacy.currentVersion({ fresh: true }), 'en');
            expect(shown.blocks).toEqual([
                { type: 'h', text: 'Controller' },
                { type: 'p', text: 'Example company' },
                { type: 'ul', items: ['item'] },
            ]);
        });
    });
});

suite('objection to profiling', () => {
    test('withdraws the automated verdict, refuses a recompute, holds the 9-box trigger', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await inRollback(async () => {
            const emp = await anEmployee();
            const empId = Number(emp.id);
            const user = { id: empId, userType: 'employee' };
            const RR = require('../../src/services/RetentionRiskService');
            await db.run('DELETE FROM retention_risk WHERE employee_id = ?', [empId]);
            const scored = await RR.computeFor(empId);
            expect(scored).toBeTruthy();

            expect((await Privacy.setObjection(user, 'I object')).created).toBe(true);
            expect((await Privacy.setObjection(user, 'again')).created).toBe(false);
            expect(await Privacy.isObjecting(empId)).toBe(true);
            expect((await Privacy.activeObjectorIds()).has(empId)).toBe(true);

            const row = await db.get('SELECT * FROM retention_risk WHERE employee_id = ?', [empId]);
            expect(row.flightRisk).toBeNull();
            expect(row.computedScore).toBeNull();
            expect(row.riskFactors).toEqual({ profilingObjection: true });

            // a single-employee recompute does not score them either
            const again = await RR.computeFor(empId);
            expect(again.computedScore).toBeNull();
            expect(again.riskFactors).toEqual({ profilingObjection: true });

            // the automatic development trigger is held, not run
            const DT = require('../../src/services/DevelopmentTriggerService');
            const admin = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
            const out = await DT.triggerForPlacement(admin, {
                employeeId: empId,
                performance: 'low',
                potential: 'medium',
            });
            expect(out).toMatchObject({ zone: 'red', paused: true, createdHold: true });
            const again2 = await DT.triggerForPlacement(admin, {
                employeeId: empId,
                performance: 'low',
                potential: 'medium',
            });
            expect(again2).toMatchObject({ paused: true, createdHold: false });
            expect(
                (
                    await db.get(
                        "SELECT COUNT(*)::int AS n FROM talent_manager_tasks WHERE employee_id = ? AND created_at > now() - interval '1 minute'",
                        [empId]
                    )
                ).n
            ).toBe(0);

            // the reviewer sees both, decides with a reason
            const ov = await Privacy.reviewOverview(admin);
            expect(ov.objections.map((o) => Number(o.employeeId))).toContain(empId);
            const held = ov.triggers.find((t) => Number(t.employeeId) === empId);
            expect(held).toBeTruthy();
            await expect(
                Privacy.resolveTrigger(admin, held.id, { resolution: 'dismiss', reason: ' ' })
            ).rejects.toMatchObject({ code: 'reason_required' });
            await expect(
                Privacy.reviewOverview({ id: 9, userType: 'admin', role: 'admin', permissions: [] })
            ).rejects.toMatchObject({ status: 403 });
            const r = await Privacy.resolveTrigger(admin, held.id, {
                resolution: 'dismiss',
                reason: 'Discussed with the person',
            });
            expect(r).toMatchObject({ ok: true, resolution: 'dismiss' });
            await expect(
                Privacy.resolveTrigger(admin, held.id, { resolution: 'dismiss', reason: 'x' })
            ).rejects.toMatchObject({ status: 404 });
            const obj = ov.objections.find((o) => Number(o.employeeId) === empId);
            await Privacy.markReviewed(admin, obj.id, 'Noted');

            // withdrawal: scored again
            expect((await Privacy.withdrawObjection(user, 'changed my mind')).withdrawn).toBe(true);
            expect(await Privacy.isObjecting(empId)).toBe(false);
            const rescored = await RR.computeFor(empId);
            expect(rescored.riskFactors.profilingObjection).toBeUndefined();
        });
        errSpy.mockRestore();
    });

    test('an admin session cannot object (no employee record)', async () => {
        await inRollback(async () => {
            await expect(
                Privacy.setObjection({ id: 1, userType: 'admin' }, 'x')
            ).rejects.toMatchObject({ status: 403, code: 'employees_only' });
        });
    });
});

suite('my data download and erasure', () => {
    test('confidential categories withheld and named; per-hour ceiling; erasure', async () => {
        await inRollback(async () => {
            const emp = await anEmployee();
            const empId = Number(emp.id);
            const user = { id: empId, userType: 'employee' };
            await Privacy.setObjection(user, 'reason');
            const v = await Privacy.publish(NOTICE, 'admin:1');
            await Privacy.acknowledge(user, v.version, 'fr');

            const out = await Privacy.myDataExport(user);
            expect(out.employeeId).toBe(empId);
            expect(out.withheld.sort()).toEqual(
                ['calibrationAdjustments', 'nineBox', 'retentionRisk'].sort()
            );
            for (const k of out.withheld) expect(out.data[k]).toBeUndefined();
            expect(out.data.profile).toBeTruthy();
            expect(out.data.profilingObjections).toHaveLength(1);
            expect(out.data.privacyNoticeAcks.map((a) => Number(a.version))).toContain(v.version);
            expect(out.privacy.profilingObjection).toBeTruthy();
            expect(await Privacy.myDataExport({ id: 1, userType: 'admin' })).toBeNull();

            for (let i = 0; i < 5; i++) await Privacy.claimExport(user, 'json');
            await expect(Privacy.claimExport(user, 'json')).rejects.toMatchObject({
                status: 429,
                code: 'rate_limited',
            });

            // erasure: objection rows go, the acknowledgement stays
            const DSR = require('../../src/services/DSRService');
            jest.spyOn(console, 'log').mockImplementation(() => {});
            await DSR.erase(empId, 1, { reason: 'test' });
            expect(
                (
                    await db.get(
                        'SELECT COUNT(*)::int AS n FROM profiling_objections WHERE employee_id = ?',
                        [empId]
                    )
                ).n
            ).toBe(0);
            expect(
                (
                    await db.get(
                        "SELECT COUNT(*)::int AS n FROM privacy_notice_acks WHERE subject_type = 'employee' AND subject_id = ?",
                        [empId]
                    )
                ).n
            ).toBe(1);
        });
    });
});
