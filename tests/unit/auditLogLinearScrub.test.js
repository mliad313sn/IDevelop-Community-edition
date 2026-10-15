'use strict';
/**
 * The audit-log scrubber is linear and capped (ReDoS). An unbounded, unanchored
 * e-mail pattern restarted at every character of a long local-part run: an
 * 80 KB free-text reason blocked LogService.log for seconds, and the anonymous
 * CSRF-rejection audit made that reachable without signing in.
 */

const mockCreate = jest.fn(async () => ({}));
jest.mock('../../src/models/SystemLogModel', () => {
    const real = jest.requireActual('../../src/models/SystemLogModel');
    return { ...real, create: (...a) => mockCreate(...a) };
});
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

const LogService = require('../../src/services/LogService');

const ms = (fn) => {
    const t = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
};
// The fastest of 3 runs: a ReDoS is slow EVERY time (seconds); one slow sample
// under a loaded full run (GC, scheduler) is not one.
const best = (fn, n = 3) => Math.min(...Array.from({ length: n }, () => ms(fn)));
const msAsync = async (fn) => {
    const t = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
};

beforeEach(() => mockCreate.mockClear());

describe('LogService is linear and capped', () => {
    test('an 80 KB free-text reason does not block the event loop', async () => {
        const reason = 'a'.repeat(80000);
        const took = await msAsync(() =>
            LogService.log({
                action: 'CERTIFICATION_REVOKED',
                entityType: 'employee',
                entityId: 1,
                details: `Certification 1 (skill 1) revoked: ${reason}`,
            })
        );
        expect(took).toBeLessThan(100); // generous for CI noise; seconds before the fix
        const row = mockCreate.mock.calls[0][0];
        expect(row.details.length).toBeLessThanOrEqual(LogService.MAX_LOGGED_STRING + 4);
        expect(row.details.endsWith('[…]')).toBe(true);
    });

    test('every adversarial e-mail-ish run of 80 KB scrubs in < 20 ms', () => {
        for (const unit of ['a', '.', '-', "'", 'a.', 'a@', '@a', 'a@a.', '@a.a', 'a-', '%+']) {
            const s = unit.repeat(Math.ceil(80000 / unit.length)) + '!';
            const took = best(() => s.replace(LogService.EMAIL_RE, '[e-mail]'));
            expect({ unit, slow: took > 20 }).toEqual({ unit, slow: false });
        }
    });

    test('e-mail addresses are still masked (no behaviour lost)', () => {
        const out = LogService.scrubDetails(
            "to j.doe@site.example, O'Brien+hr@corp.co.uk and x_y%z@a-b.c.d.example.org; not me@localhost"
        );
        expect(out).toBe('to [e-mail], [e-mail] and [e-mail]; not me@localhost');
    });

    test('nested strings are capped too', () => {
        const out = LogService.scrubDetails({ a: ['x'.repeat(10000)], b: 'short' });
        expect(out.a[0].length).toBeLessThanOrEqual(LogService.MAX_LOGGED_STRING + 4);
        expect(out.b).toBe('short');
    });
});
