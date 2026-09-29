'use strict';
/** Unit tests for the v1 API repositories (DB-mocked) — type-coercion contract. */
jest.mock('../../src/config/database', () => ({ all: jest.fn(), get: jest.fn() }));
const db = require('../../src/config/database');
const {
    DevelopmentRepository,
    GoalsRepository,
    CheckInsRepository,
} = require('../../src/api/v1/repository');

describe('DevelopmentRepository.forEmployee', () => {
    beforeEach(() => {
        db.all.mockReset();
    });

    test('coerces PG bigint/count strings to numbers and shapes the response', async () => {
        db.all
            .mockResolvedValueOnce([
                {
                    id: '10',
                    kind: 'coaching',
                    title: 't',
                    state: 'active',
                    progress: '40',
                    contextType: 'skill_gap',
                    targetDate: null,
                    createdAt: '2026-01-01',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: '5',
                    status: 'active',
                    priority: 'high',
                    createdAt: 'x',
                    objTotal: '3',
                    actTotal: '4',
                    actDone: '2',
                },
            ])
            .mockResolvedValueOnce([
                { id: '7', state: 'closed_success', summary: 's', outcome: 'ok', createdAt: 'y' },
            ]);

        const d = await DevelopmentRepository.forEmployee(100);

        expect(d.coaching[0]).toMatchObject({ id: 10, progress: 40, contextType: 'skill_gap' });
        expect(typeof d.coaching[0].id).toBe('number');
        expect(typeof d.coaching[0].progress).toBe('number');
        expect(d.idps[0]).toMatchObject({
            id: 5,
            status: 'active',
            objectives: 3,
            actions: 4,
            actionsCompleted: 2,
        });
        expect(typeof d.idps[0].objectives).toBe('number');
        expect(d.pips[0]).toMatchObject({ id: 7, state: 'closed_success', outcome: 'ok' });
        // queried all three development tables, scoped to the employee id
        expect(db.all).toHaveBeenCalledTimes(3);
        expect(db.all.mock.calls.every((c) => c[1][0] === 100)).toBe(true);
    });
});

describe('GoalsRepository.listForEmployee', () => {
    beforeEach(() => {
        db.all.mockReset();
        db.get.mockReset();
    });

    test('maps objective + key result and coerces bigint/numeric strings', async () => {
        db.all.mockResolvedValueOnce([
            {
                id: '9',
                employeeId: '88',
                parentId: null,
                kind: 'objective',
                title: 'O',
                description: null,
                metricUnit: null,
                targetValue: null,
                currentValue: '0',
                status: 'active',
                period: '2026-Q3',
                dueDate: null,
                createdAt: 't',
            },
            {
                id: '10',
                employeeId: '88',
                parentId: '9',
                kind: 'key_result',
                title: 'KR',
                description: null,
                metricUnit: 'gaps',
                targetValue: '5',
                currentValue: '2',
                status: 'active',
                period: null,
                dueDate: null,
                createdAt: 't',
            },
        ]);
        const g = await GoalsRepository.listForEmployee(88);
        expect(g[0]).toMatchObject({
            id: 9,
            employeeId: 88,
            parentId: null,
            currentValue: 0,
            kind: 'objective',
        });
        expect(g[1]).toMatchObject({
            id: 10,
            parentId: 9,
            targetValue: 5,
            currentValue: 2,
            kind: 'key_result',
        });
        expect(typeof g[1].targetValue).toBe('number');
        expect(typeof g[1].id).toBe('number');
    });
});

describe('CheckInsRepository.listForEmployee', () => {
    beforeEach(() => {
        db.all.mockReset();
        db.get.mockReset();
    });

    test('maps a check-in, coerces bigint/smallint/bool, and exposes item counts', async () => {
        db.all.mockResolvedValueOnce([
            {
                id: '21',
                employeeId: '88',
                managerId: '12',
                kind: 'one_on_one',
                title: 'Weekly 1:1',
                scheduledAt: '2026-06-20T09:00:00Z',
                occurredAt: null,
                status: 'scheduled',
                sharedNotes: null,
                sentiment: '4',
                createdAt: 't',
                itemTotal: '3',
                actionsTotal: '2',
                actionsDone: '1',
            },
        ]);
        const list = await CheckInsRepository.listForEmployee(88);
        expect(list[0]).toMatchObject({
            id: 21,
            employeeId: 88,
            managerId: 12,
            kind: 'one_on_one',
            status: 'scheduled',
            sentiment: 4,
            items: 3,
            actions: 2,
            actionsCompleted: 1,
        });
        expect(typeof list[0].id).toBe('number');
        expect(typeof list[0].sentiment).toBe('number');
        expect(typeof list[0].items).toBe('number');
    });

    test('null manager and null sentiment stay null (not NaN)', async () => {
        db.all.mockResolvedValueOnce([
            {
                id: '22',
                employeeId: '88',
                managerId: null,
                kind: 'pulse',
                title: null,
                scheduledAt: null,
                occurredAt: null,
                status: 'completed',
                sharedNotes: 'ok',
                sentiment: null,
                createdAt: 't',
                itemTotal: '0',
                actionsTotal: '0',
                actionsDone: '0',
            },
        ]);
        const list = await CheckInsRepository.listForEmployee(88);
        expect(list[0].managerId).toBeNull();
        expect(list[0].sentiment).toBeNull();
        expect(list[0].items).toBe(0);
    });
});
