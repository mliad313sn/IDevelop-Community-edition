'use strict';
/**
 * activityTrail middleware — the catch-all mutation trail:
 * records authenticated mutations into perf_events (retention-managed
 * telemetry, NOT the immutable hash-chained audit log), skips reads,
 * anonymous requests and static paths, never persists request bodies, and
 * can be disabled via ACTIVITY_TRAIL=0.
 */

const mockDb = { run: jest.fn().mockResolvedValue({}) };
jest.mock('../../src/config/database', () => mockDb);

const { enforceActivityTrail } = require('../../src/middleware/activityTrail');

function run({
    method = 'POST',
    path = '/employees/5',
    authenticated = true,
    status = 200,
    user,
} = {}) {
    const finishHandlers = [];
    const req = {
        method,
        path,
        id: 'req-1',
        ip: '::1',
        isAuthenticated: () => authenticated,
        user: user || (authenticated ? { id: 7, userType: 'manager' } : null),
        get: () => 'jest-agent',
        body: { password: 'SECRET-NEVER-LOGGED' },
    };
    const res = {
        statusCode: status,
        on: (ev, fn) => {
            if (ev === 'finish') finishHandlers.push(fn);
        },
    };
    const next = jest.fn();
    enforceActivityTrail(req, res, next);
    finishHandlers.forEach((fn) => fn());
    return { next };
}

const lastCall = () => mockDb.run.mock.calls[0];

beforeEach(() => {
    mockDb.run.mockClear();
    delete process.env.ACTIVITY_TRAIL;
});

describe('activityTrail', () => {
    test('authenticated mutation → one perf_events row with route/status/actor, never the body', () => {
        run({ method: 'POST', path: '/compliance/rules', status: 200 });
        expect(mockDb.run).toHaveBeenCalledTimes(1);
        const [sql, params] = lastCall();
        expect(sql).toMatch(/INSERT INTO perf_events/);
        expect(sql).not.toMatch(/system_logs/); // must NOT pollute the immutable audit
        expect(params[0]).toBe('POST /compliance/rules');
        const detail = JSON.parse(params[1]);
        expect(detail.status).toBe(200);
        expect(detail.actor).toBe('manager:7');
        expect(detail.requestId).toBe('req-1');
        expect(typeof detail.ms).toBe('number');
        expect(params[1]).not.toContain('SECRET-NEVER-LOGGED');
    });

    test('GET requests are not trailed (reads live in the file logs)', () => {
        run({ method: 'GET', path: '/employees' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('anonymous mutations are not trailed (auth events cover them)', () => {
        run({ method: 'POST', path: '/login', authenticated: false });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('static asset paths are skipped', () => {
        run({ method: 'POST', path: '/css/x.css' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('failure status codes are captured for debugging', () => {
        run({ status: 500 });
        // lastCall() = [sql, params]; params[1] is the JSON detail column.
        const [, params] = lastCall();
        expect(JSON.parse(params[1]).status).toBe(500);
    });

    test('ACTIVITY_TRAIL=0 disables the middleware', () => {
        process.env.ACTIVITY_TRAIL = '0';
        run({});
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a DB failure never propagates out of the finish handler', () => {
        mockDb.run.mockRejectedValueOnce(new Error('db down'));
        expect(() => run({})).not.toThrow();
    });
});
