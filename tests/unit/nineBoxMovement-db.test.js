'use strict';
/**
 * 9-box movements (migration 175), on the REAL test database. Every scenario
 * runs inside ONE transaction that is always rolled back, on people created
 * inside it.
 *
 *  - a new evaluation is linked, at submission, to the person's previous
 *    APPROVED placement (a snapshot: later edits never rewrite it);
 *  - a box change needs a written reason of at least 20 characters at
 *    submission, at approval straight from a draft, when a reviewer changes the
 *    box of a submitted proposal, and at calibration; a refused act writes
 *    NOTHING;
 *  - a reason that is only spaces or punctuation, one repeated character, or a
 *    copy of the person's previous reason is refused;
 *  - an unchanged box needs nothing; a first placement is 'first';
 *  - nine_box_events records the move with ids only;
 *  - the report: rows, counts per direction, the 9 × 9 matrix, filters, and
 *    leavers / erased people left out;
 *  - the formal export returns the movement and its reason, the self-service
 *    download withholds the whole 9-box category, erasure redacts the reason;
 *  - the employee dashboard query gives the direction only when the previous
 *    placement was disclosed too;
 *  - the migration backfill rebuilds history, flagged, and is idempotent.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn(async () => ({ inapp: 'queued' })),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const NineBox = HAS_DB ? require('../../src/services/NineBoxService') : null;
const MIG_175 = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/175_ninebox_movement.sql'),
    'utf8'
);
const WHY = 'Results well above the objectives set for the half-year';

let USER = null;

beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const a = await db.get(
        "SELECT id, username, role FROM admins WHERE role = 'superadmin' ORDER BY id LIMIT 1"
    );
    USER = { id: Number(a.id), userType: 'admin', role: a.role, username: a.username };
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function inRolledBackTx(fn) {
    let out;
    await db
        .runTransaction(async () => {
            out = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return out;
}

let seq = 0;
/** A person created inside the transaction (no placement yet). */
async function person(extra = {}) {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
    );
    seq += 1;
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, 'Movement', ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
            `NBMV-${Date.now()}-${seq}`,
            `Fixture ${seq}`,
            tpl.siteId,
            tpl.departmentId,
            tpl.serviceId,
            tpl.roleId,
            extra.active === false ? false : true,
        ]
    );
    return Number(r.id);
}

/** A decided placement `daysAgo` days ago (no snapshot). */
const decided = (emp, perf, pot, daysAgo, status = 'approved', extra = {}) =>
    db.get(
        `INSERT INTO nine_box_evaluations
            (employee_id, performance, potential, box, box_label, status, clearance,
             cell_tier, cell_trend, position_source, comments, approved_at,
             movement_justification, movement_justified_at,
             disclosed_to_employee, disclosed_at, disclosure_reason)
         VALUES (?, ?, ?, ?, 'fixture', ?, 'confidential', 2, 'stable', 'manager', 'NBMV',
                 now() - (? || ' days')::interval, ?, CASE WHEN ?::text IS NULL THEN NULL ELSE now() END,
                 ?, CASE WHEN ? THEN now() END, CASE WHEN ? THEN 'Annual review' END)
         RETURNING *`,
        [
            emp,
            perf,
            pot,
            NineBox.computeBox(perf, pot).box,
            status,
            String(daysAgo),
            extra.just || null,
            extra.just || null,
            Boolean(extra.disclosed),
            Boolean(extra.disclosed),
            Boolean(extra.disclosed),
        ]
    );
const row = (id) => db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
const refusal = async (fn) => {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e;
    }
};

// Four eyes (migration 190, on for a new install): the SuperAdmin of this
// suite drafts AND approves, so every approval carries the override reason.
const FOUR_EYES = 'Drafted and approved by the suite SuperAdmin.';

suite('9-box movement: snapshot, direction and the written reason', () => {
    test('first placement ever: direction first, no reason needed', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'medium',
                potential: 'medium',
            });
            await NineBox.submit(USER, d.id);
            return row(d.id);
        });
        expect(out.status).toBe('under_review');
        expect(out.movementDirection).toBe('first');
        expect(out.previousEvaluationId).toBeNull();
        expect(out.movementSnapshotAt).toBeTruthy();
    });

    test('a box change without a 20-character reason is refused and writes nothing', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
            });
            const none = await refusal(() => NineBox.submit(USER, d.id));
            const short = await refusal(() =>
                NineBox.submit(USER, d.id, null, { movementJustification: 'too short' })
            );
            const after = await row(d.id);
            const events = await db.all(
                "SELECT 1 FROM nine_box_events WHERE evaluation_id = ? AND action IN ('submit','movement')",
                [d.id]
            );
            return { none, short, after, events: events.length };
        });
        for (const e of [out.none, out.short]) {
            expect(e).toBeTruthy();
            expect(e.code).toBe('MOVEMENT_JUSTIFICATION_REQUIRED');
            expect(e.status).toBe(400);
            expect(e.i18n.key).toBe('talentx:nb_mv_err_justification_required');
        }
        expect(out.after.status).toBe('draft');
        expect(out.after.movementSnapshotAt).toBeNull();
        expect(out.events).toBe(0);
    });

    test('with a reason: snapshot of the previous approved placement, event with ids only', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const old = await decided(emp, 'low', 'low', 90);
            // An older placement, and a newer CANCELLED one, are both ignored.
            await decided(emp, 'medium', 'medium', 200, 'archived');
            const cancelled = await decided(emp, 'high', 'high', 30, 'archived');
            await db.run(
                "INSERT INTO nine_box_events (evaluation_id, employee_id, action, from_status, to_status) VALUES (?, ?, 'cancel', 'approved', 'archived')",
                [cancelled.id, emp]
            );
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
            });
            await NineBox.submit(USER, d.id, null, { movementJustification: WHY });
            const ev = await db.get(
                "SELECT detail FROM nine_box_events WHERE evaluation_id = ? AND action = 'movement'",
                [d.id]
            );
            return { oldId: Number(old.id), r: await row(d.id), detail: ev && ev.detail };
        });
        expect(Number(out.r.previousEvaluationId)).toBe(out.oldId);
        expect(Number(out.r.previousBox)).toBe(1);
        expect(out.r.previousPerformance).toBe('low');
        expect(out.r.movementDirection).toBe('up');
        expect(out.r.movementJustification).toBe(WHY);
        expect(Number(out.r.movementJustifiedBy)).toBe(USER.id);
        expect(out.r.movementJustifiedByType).toBe('admin');
        const detail = typeof out.detail === 'string' ? JSON.parse(out.detail) : out.detail;
        expect(detail).toEqual({
            previousEvaluationId: out.oldId,
            fromBox: 1,
            toBox: out.r.box,
            direction: 'up',
            justified: true,
        });
        expect(JSON.stringify(detail)).not.toContain('objectives');
    });

    test('the snapshot is history: editing the previous row afterwards does not rewrite it', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const old = await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'high',
                movementJustification: WHY,
            });
            await NineBox.submit(USER, d.id);
            await db.run(
                "UPDATE nine_box_evaluations SET performance = 'high', potential = 'high', box = 9 WHERE id = ?",
                [old.id]
            );
            return row(d.id);
        });
        expect(Number(out.previousBox)).toBe(1);
        expect(out.previousPerformance).toBe('low');
        expect(out.movementDirection).toBe('up');
    });

    test('unchanged box: no reason needed (stable)', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'medium', 'high', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'medium',
                potential: 'high',
            });
            await NineBox.submit(USER, d.id);
            return row(d.id);
        });
        expect(out.status).toBe('under_review');
        expect(out.movementDirection).toBe('stable');
        expect(out.movementJustification).toBeNull();
    });

    test('a reviewer changing the box of a submitted proposal must give a new reason', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'medium', 'medium', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
                movementJustification: WHY,
            });
            await NineBox.submit(USER, d.id);
            const refused = await refusal(() =>
                NineBox.update(USER, d.id, { performance: 'low', potential: 'medium' })
            );
            const unchanged = await row(d.id);
            await NineBox.update(USER, d.id, {
                performance: 'low',
                potential: 'high',
                movementJustification: 'Review: delivery below plan, potential confirmed',
            });
            return { refused, unchanged, r: await row(d.id) };
        });
        expect(out.refused && out.refused.code).toBe('MOVEMENT_JUSTIFICATION_REQUIRED');
        expect(out.unchanged.performance).toBe('high');
        expect(out.r.movementDirection).toBe('lateral');
        expect(out.r.movementJustification).toMatch(/^Review:/);
        expect(Number(out.r.previousBox)).toBe(5);
    });

    test('approval straight from a draft takes the snapshot and enforces the rule', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const old = await decided(emp, 'high', 'high', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'low',
                potential: 'medium',
            });
            const refused = await refusal(() =>
                NineBox.approve(USER, d.id, null, { fourEyesReason: FOUR_EYES })
            );
            const still = await row(old.id);
            await NineBox.approve(USER, d.id, null, {
                fourEyesReason: FOUR_EYES,
                movementJustification: WHY,
            });
            return { refused, still, r: await row(d.id), oldAfter: await row(old.id) };
        });
        expect(out.refused && out.refused.code).toBe('MOVEMENT_JUSTIFICATION_REQUIRED');
        expect(out.still.status).toBe('approved');
        expect(out.r.status).toBe('approved');
        expect(out.r.movementDirection).toBe('down');
        expect(out.oldAfter.status).toBe('archived');
    });

    test('calibration that moves the box: a short rationale is refused, a real one recorded', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'medium', 'medium', 120, 'archived');
            const cur = await decided(emp, 'medium', 'medium', 60);
            const refused = await refusal(() =>
                NineBox.applyCalibration(USER, {
                    employeeId: emp,
                    toBox: 'high-high',
                    reason: 'ok',
                })
            );
            const before = await row(cur.id);
            await NineBox.applyCalibration(USER, {
                employeeId: emp,
                toBox: 'high-high',
                reason: 'Session: exceptional results confirmed by peers',
            });
            const ev = await db.get(
                "SELECT detail FROM nine_box_events WHERE evaluation_id = ? AND action = 'calibrate'",
                [cur.id]
            );
            return { refused, before, r: await row(cur.id), detail: ev && ev.detail };
        });
        expect(out.refused && out.refused.code).toBe('MOVEMENT_JUSTIFICATION_REQUIRED');
        expect(out.before.box).toBe(5);
        expect(out.r.box).toBe(9);
        expect(out.r.movementDirection).toBe('up');
        expect(out.r.movementJustification).toMatch(/^Session:/);
        // Ids only in the journal: the rationale itself is not copied there.
        const detail = typeof out.detail === 'string' ? JSON.parse(out.detail) : out.detail;
        expect(detail.reasonRecorded).toBe(true);
        expect(JSON.stringify(detail)).not.toContain('exceptional');
    });

    test.each([
        ['spaces and punctuation only', ' . . . ,,, ;;; !!! ??? --- ...  '],
        ['one repeated character', 'aaaaaaaaaaaaaaaaaaaaaaa'],
        ['one repeated character with spaces and dots', 'a a a a a a a a a a a a.'],
        ['ellipses', '……………………………………………………………'],
    ])('a placeholder reason (%s) is refused, nothing written', async (_l, text) => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'high',
            });
            const e = await refusal(() =>
                NineBox.submit(USER, d.id, null, { movementJustification: text })
            );
            return { code: e && e.code, status: (await row(d.id)).status };
        });
        expect(out.code).toBe('MOVEMENT_JUSTIFICATION_PLACEHOLDER');
        expect(out.status).toBe('draft');
    });

    test("a copy of the person's previous reason (any case or spacing) is refused; a new sentence passes", async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'medium', 'medium', 90, 'approved', {
                just: 'Objectives met, autonomy confirmed in review',
            });
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
            });
            const copy = await refusal(() =>
                NineBox.submit(USER, d.id, null, {
                    movementJustification: '  OBJECTIVES met,autonomy   confirmed in REVIEW ',
                })
            );
            const fresh = await refusal(() =>
                NineBox.submit(USER, d.id, null, {
                    movementJustification: 'Clearly beyond the sales targets of the half-year',
                })
            );
            return { copy: copy && copy.code, fresh };
        });
        expect(out.copy).toBe('MOVEMENT_JUSTIFICATION_COPY');
        expect(out.fresh).toBeNull();
    });

    test('a calibration of a FIRST placement needs its reason; an empty one never blanks a stored reason', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const cur = await decided(emp, 'low', 'low', 60);
            const refused = await refusal(() =>
                NineBox.applyCalibration(USER, {
                    employeeId: emp,
                    toBox: 'high-low',
                    reason: 'too short',
                })
            );
            await NineBox.applyCalibration(USER, {
                employeeId: emp,
                toBox: 'high-low',
                reason: 'Session decision: potential seen in the new assignment',
            });
            return { refused, r: await row(cur.id) };
        });
        expect(out.refused && out.refused.code).toBe('MOVEMENT_JUSTIFICATION_REQUIRED');
        expect(out.r.movementDirection).toBe('first');
        expect(out.r.movementJustification).toMatch(/^Session decision/);
    });
});

suite('9-box movement: the report', () => {
    test('rows, counts per direction, the 9 × 9 matrix and the filters', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const emp2 = await person();
            await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'high',
                movementJustification: WHY,
            });
            await NineBox.approve(USER, d.id, null, { fourEyesReason: FOUR_EYES });
            const d2 = await NineBox.createDraft(USER, {
                employeeId: emp2,
                performance: 'medium',
                potential: 'medium',
            });
            await NineBox.approve(USER, d2.id, null, { fourEyesReason: FOUR_EYES });
            const all = await NineBox.movements(USER, {});
            const up = await NineBox.movements(USER, { direction: 'up' });
            return { all, up, ids: [Number(d.id), Number(d2.id)] };
        });
        const mine = out.all.rows.filter((r) => out.ids.includes(r.evaluationId));
        expect(mine).toHaveLength(2);
        const moved = mine.find((r) => r.evaluationId === out.ids[0]);
        expect(moved.movement.direction).toBe('up');
        expect(moved.movement.previous.box).toBe(1);
        expect(moved.movement.justification).toBe(WHY);
        expect(moved.movement.justifiedBy).toBe(USER.username);
        expect(mine.find((r) => r.evaluationId === out.ids[1]).movement.direction).toBe('first');
        expect(out.all.matrix[0][8]).toBeGreaterThanOrEqual(1); // box 1 → box 9
        expect(out.up.rows.every((r) => r.movement.direction === 'up')).toBe(true);
        expect(out.up.rows.some((r) => r.evaluationId === out.ids[0])).toBe(true);
        expect(out.up.counts.up).toBe(out.up.rows.length);
        // A first placement never reaches the matrix.
        const matrixTotal = out.all.matrix.flat().reduce((a, b) => a + b, 0);
        expect(matrixTotal).toBe(out.all.counts.total - out.all.counts.first);
    });

    test('leavers and erased people are left out of the report', async () => {
        const out = await inRolledBackTx(async () => {
            const leaver = await person({ active: false });
            const erased = await person();
            const a = await decided(leaver, 'low', 'low', 10);
            const b = await decided(erased, 'low', 'low', 10);
            await db.run('UPDATE employees SET erased_at = now() WHERE id = ?', [erased]);
            const all = await NineBox.movements(USER, {});
            return { ids: all.rows.map((r) => r.evaluationId), a: Number(a.id), b: Number(b.id) };
        });
        expect(out.ids).not.toContain(out.a);
        expect(out.ids).not.toContain(out.b);
    });
});

suite('9-box movement: privacy', () => {
    const SECRET = 'NBMV-SECRET delivery behind plan for three quarters';

    test('the formal export carries the movement and its reason; the self-service download withholds the 9-box', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
            });
            await NineBox.approve(USER, d.id, null, {
                fourEyesReason: FOUR_EYES,
                movementJustification: SECRET,
            });
            const full = await require('../../src/services/DSRService').export(emp);
            const mine = await require('../../src/services/PrivacyService').myDataExport({
                id: emp,
                userType: 'employee',
            });
            return { id: Number(d.id), full, mine };
        });
        const r = out.full.nineBox.find((x) => Number(x.id) === out.id);
        expect(r).toMatchObject({ previousBox: 1, movementDirection: 'up' });
        expect(r.movementJustification).toBe(SECRET);
        expect(r.approvedAt).toBeTruthy();
        // Self-service: the confidential 9-box category is withheld as a whole.
        expect(out.mine.withheld).toContain('nineBox');
        expect(out.mine.withheld).toContain('calibrationAdjustments');
        expect(JSON.stringify(out.mine)).not.toContain('NBMV-SECRET');
    });

    test('erasure redacts the reason and keeps the movement record', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            await decided(emp, 'low', 'low', 90);
            const d = await NineBox.createDraft(USER, {
                employeeId: emp,
                performance: 'high',
                potential: 'medium',
            });
            await NineBox.approve(USER, d.id, null, {
                fourEyesReason: FOUR_EYES,
                movementJustification: SECRET,
            });
            await require('../../src/services/DSRService').erase(emp, USER.id, {
                reason: 'test erasure',
            });
            return row(d.id);
        });
        expect(out.movementJustification).toBe('[erased]');
        expect(out.movementDirection).toBe('up');
        expect(Number(out.previousBox)).toBe(1);
    });

    test('employee dashboard: the direction only when the previous placement was disclosed too', async () => {
        const EmployeePortal = require('../../src/controllers/EmployeePortalController');
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/EmployeePortalController.js'),
            'utf8'
        );
        expect(EmployeePortal).toBeTruthy();
        const m =
            /`(SELECT performance, potential, box, box_label, approved_at,[\s\S]*?LIMIT 1)`/.exec(
                src
            );
        expect(m).toBeTruthy();
        const sql = m[1];
        const out = await inRolledBackTx(async () => {
            const a = await person();
            const b = await person();
            for (const [emp, oldDisclosed] of [
                [a, true],
                [b, false],
            ]) {
                const old = await decided(emp, 'low', 'low', 90, 'archived', {
                    disclosed: oldDisclosed,
                });
                await db.run(
                    `INSERT INTO nine_box_evaluations (employee_id, performance, potential, box, status, clearance,
                            cell_tier, cell_trend, position_source, approved_at,
                            previous_evaluation_id, previous_box, previous_performance, previous_potential,
                            movement_direction, movement_snapshot_at, movement_justification,
                            disclosed_to_employee, disclosed_at, disclosure_reason)
                     VALUES (?, 'high', 'high', 9, 'approved', 'confidential', 2, 'stable', 'manager', now(),
                             ?, 1, 'low', 'low', 'up', now(), ?, true, now(), 'Development review')`,
                    [emp, old.id, SECRET]
                );
            }
            return { a: await db.get(sql, [a]), b: await db.get(sql, [b]) };
        });
        expect(out.a.movementDirection).toBe('up');
        expect(out.b.box).toBe(9);
        expect(out.b.movementDirection).toBeNull();
        expect(JSON.stringify(out)).not.toContain('NBMV-SECRET');
    });
});

suite('migration 175 backfill', () => {
    test('rebuilds decided history, flagged as rebuilt, never invents a reason, idempotent', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await person();
            const a = await decided(emp, 'high', 'high', 200, 'archived');
            const b = await decided(emp, 'low', 'high', 50);
            await db._client().query(MIG_175); // picks up the two new rows
            const first = { a: await row(a.id), b: await row(b.id) };
            // Mark the snapshot: a second run must leave a snapshotted row alone.
            await db.run(
                "UPDATE nine_box_evaluations SET movement_snapshot_at = '2001-01-01T00:00:00Z' WHERE id = ?",
                [b.id]
            );
            await db._client().query(MIG_175); // a second run changes nothing
            const second = { a: await row(a.id), b: await row(b.id) };
            return { first, second, aId: Number(a.id) };
        });
        expect(out.first.a.movementDirection).toBe('first');
        expect(out.first.a.movementBackfilled).toBe(true);
        expect(Number(out.first.b.previousEvaluationId)).toBe(out.aId);
        expect(out.first.b.movementDirection).toBe('down');
        expect(out.first.b.movementBackfilled).toBe(true);
        expect(out.first.b.movementJustification).toBeNull();
        expect(new Date(out.second.b.movementSnapshotAt).toISOString()).toBe(
            '2001-01-01T00:00:00.000Z'
        );
        expect(out.second.b.movementDirection).toBe('down');
    });
});
