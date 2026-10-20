'use strict';
/**
 * The exactly-once machinery of the compliance jobs (migration 56):
 *
 *   cert-expiry — the 90/60/30/expired stage ladder (stageFor) and the
 *     alert_stage WATERMARK: a stage fires only when computed > stored, the
 *     stage is CLAIMED (db.run) before any notification, and a repeat run at
 *     the same stage stays silent.
 *
 *   cycle-nudge — the nudge_log LEDGER: the ON CONFLICT DO NOTHING insert is
 *     the claim; a nudge goes out only when the claim inserted a row, so a
 *     re-run can never double-send.
 *
 * DB / settings / notification / LMS all mocked; a shared invocation log
 * asserts claim-before-notify ordering.
 */

const mockCalls = [];
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(async (sql) => {
        mockCalls.push('run:' + sql.slice(0, 40).trim());
        return {};
    }),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { getValue: jest.fn(), setValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockNotify = jest.fn(async () => {
    mockCalls.push('mockNotify');
    return { inapp: 'queued' };
});
jest.mock('../../src/services/NotificationService', () => ({ notify: mockNotify }));
jest.mock('../../src/services/LmsService', () => ({ assignCourse: jest.fn() }));

const { stageFor, tick: certTick } = require('../../src/jobs/cert-expiry');
const { tick: nudgeTick } = require('../../src/jobs/cycle-nudge');

beforeEach(() => {
    mockCalls.length = 0;
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockClear();
    mockSettings.getValue.mockReset();
    mockSettings.setValue.mockReset().mockResolvedValue(undefined);
    mockNotify.mockClear();
});

describe('cert-expiry stage ladder', () => {
    test('stageFor maps days-to-expiry onto the 90/60/30/expired ladder', () => {
        expect(stageFor(null)).toBe(0); // no expiry
        expect(stageFor(120)).toBe(0);
        expect(stageFor(90)).toBe(1);
        expect(stageFor(61)).toBe(1);
        expect(stageFor(60)).toBe(2);
        expect(stageFor(31)).toBe(2);
        expect(stageFor(30)).toBe(3);
        expect(stageFor(0)).toBe(3);
        expect(stageFor(-1)).toBe(4); // expired
    });

    const dueCert = (alertStage) => ({
        certId: 10,
        employeeId: 1,
        fullName: 'A B',
        skillId: 5,
        skillName: 'First Aid',
        expiresOn: '2026-09-01',
        daysToExpiry: 45,
        alertStage,
    });

    test('fires once per stage: claims the watermark BEFORE notifying', async () => {
        mockSettings.getValue.mockResolvedValue(null); // not run today
        mockDb.all.mockImplementation(async (sql) => {
            // ReportingLineService.linesFor — the ACTIVE supervisor 99 of employee 1.
            if (/LEFT JOIN employees sup/.test(sql)) {
                return [{ employeeId: 1, employeeActive: true, supId: 99, supName: 'Sup Ervisor' }];
            }
            return [dueCert(0)]; // computed stage 2 > stored 0
        });
        mockDb.get.mockImplementation(async (sql) => {
            if (/course_skill_map/.test(sql)) return null; // no mapped course
            return null;
        });
        mockDb.run.mockImplementation(async (sql) => {
            mockCalls.push('run:' + sql.slice(0, 40).trim());
            return {};
        });

        const r = await certTick();
        expect(r.alerts).toBe(1);
        expect(mockNotify).toHaveBeenCalledTimes(2); // employee + manager
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({
                userType: 'employee',
                userId: 99,
                kind: 'cert.expiry.team',
            })
        );
        // Ordering: the watermark UPDATE happens before the first mockNotify.
        const claimIdx = mockCalls.findIndex((c) =>
            c.startsWith('run:UPDATE employee_certifications')
        );
        const notifyIdx = mockCalls.indexOf('mockNotify');
        expect(claimIdx).toBeGreaterThanOrEqual(0);
        expect(claimIdx).toBeLessThan(notifyIdx);
    });

    test('same stage again → silent (computed stage not greater than watermark)', async () => {
        mockSettings.getValue.mockResolvedValue(null);
        mockDb.all.mockResolvedValue([dueCert(2)]); // stored watermark already 2
        const r = await certTick();
        expect(r.alerts).toBe(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('daily gate: a second run the same day is skipped entirely', async () => {
        mockSettings.getValue.mockResolvedValue(new Date().toISOString().slice(0, 10));
        const r = await certTick();
        expect(r.skipped).toBe('already_today');
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('expired: critical, the refresher is assigned FIRST and silently, the mail opens it', async () => {
        const Lms = require('../../src/services/LmsService');
        Lms.assignCourse.mockReset().mockImplementation(async () => {
            mockCalls.push('assign');
            return {};
        });
        mockSettings.getValue.mockResolvedValue(null);
        mockDb.all.mockImplementation(async (sql) => {
            if (/LEFT JOIN employees sup/.test(sql)) return [];
            return [{ ...dueCert(3), daysToExpiry: -2 }];
        });
        mockDb.get.mockImplementation(async (sql) => {
            if (/SELECT m\.course_id/.test(sql)) return { courseId: 41 };
            if (/FROM lms_enrollments e/.test(sql)) return { x: 1 };
            return null;
        });
        const r = await certTick();
        expect(r.lmsAssigned).toBe(1);
        expect(Lms.assignCourse).toHaveBeenCalledWith(1, 41, {
            assignedBy: null,
            notifyLearner: false,
        });
        // assigned before the person is told, so the one mail can say so
        expect(mockCalls.indexOf('assign')).toBeLessThan(mockCalls.indexOf('mockNotify'));
        const own = mockNotify.mock.calls.map(([a]) => a).find((a) => a.kind === 'cert.expiry');
        expect(own.severity).toBe('critique');
        expect(own.payload).toMatchObject({ refresher: true, link: '/employee/my-learning' });
        const { blocks } = require('../../src/utils/emailTemplate');
        for (const lang of ['fr', 'en']) {
            const m = own.content(blocks(lang));
            expect(m.ctaUrl).toBe('/employee/my-learning');
            expect(m.blocks.some((b) => b.type === 'notice' && b.severity === 'critical')).toBe(
                true
            );
        }
        expect(JSON.stringify(own.content(blocks('en')).blocks)).toMatch(/refresher course/);
    });

    test('no mapped course: no refresher line, the button opens the certifications', async () => {
        const { __test } = require('../../src/jobs/cert-expiry');
        const { blocks } = require('../../src/utils/emailTemplate');
        const m = __test.employeeMail(
            { skillName: 'First Aid' },
            2,
            { fr: 'expire dans 60 jours', en: 'expires within 60 days' },
            '01/09/2026',
            { refresher: false }
        )(blocks('en'));
        expect(m.ctaUrl).toBe('/employee/my-certifications');
        expect(JSON.stringify(m.blocks)).not.toMatch(/refresher/);
    });
});

describe('cycle-nudge exactly-once ledger', () => {
    // The job computes the ladder step from the campaign's dates (injectable
    // clock): D-2 goes to everyone not yet submitted (migration 183 wave).
    const openCycle = {
        id: 3,
        code: 'C1',
        label: 'Cycle 1',
        status: 'open',
        closesAt: new Date(Date.now() + 1.4 * 86400000),
        openedAt: new Date(Date.now() - 30 * 86400000),
    };

    function wireDb({ claimInserts }) {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM assessment_cycles/.test(sql)) return [openCycle];
            if (/FROM cycle_participants p/.test(sql)) {
                return [{ employeeId: 7, expected: 12, sent: 0 }];
            }
            return []; // no pending manager reviews
        });
        mockDb.get.mockImplementation(async (sql) => {
            if (/INSERT INTO nudge_log/.test(sql)) {
                mockCalls.push('claim');
                return claimInserts ? { id: 1 } : null; // ON CONFLICT DO NOTHING → null when already claimed
            }
            return null;
        });
    }

    test('claim inserted → reminder_2 sent (deadline within 2 days)', async () => {
        wireDb({ claimInserts: true });
        const r = await nudgeTick();
        expect(r.reminders).toBe(1);
        expect(mockNotify).toHaveBeenCalledTimes(1);
        expect(mockNotify.mock.calls[0][0].payload.stage).toBe('reminder_2');
        // claim precedes the notification
        expect(mockCalls.indexOf('claim')).toBeLessThan(mockCalls.indexOf('mockNotify'));
    });

    test('claim already taken → nothing sent (idempotent re-run)', async () => {
        wireDb({ claimInserts: false });
        const r = await nudgeTick();
        expect(r.reminders).toBe(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });
});
