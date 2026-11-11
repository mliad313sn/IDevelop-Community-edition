'use strict';
/**
 * Guard — every registered job names a module that exists, and fails loudly.
 *
 * Why: a tick whose fn wraps `require()` in a try / catch that returns null
 * resolves to null when the module is missing or broken, and the run is
 * recorded as a success: the health page shows a green tick for work that
 * never happened. The LMS sync tick did exactly that.
 *
 * What: every entry of src/jobs/index.js TICKS names a module that resolves
 * (the `require('…')` targets of its fn, resolved from src/jobs); no fn
 * swallows a require() error; names are unique; the cron minute pattern and
 * everyMin agree; and every file in src/jobs exporting tick() is registered
 * (no job outside the registry). No database: the ticks are not run.
 *
 * Exceptions: allowlist.json → ticks (name, reason).
 */
const fs = require('fs');
const path = require('path');
const A = require('../helpers/guards/allowlist');
const R = require('../helpers/guards/repo');

const JOBS = path.join(R.REPO, 'src', 'jobs');
const { TICKS } = require('../../src/jobs/index');

/** require('…') targets of a tick's fn source, resolved from src/jobs → [{spec, resolved|null}] */
function modulesOf(tick) {
    const src = tick.fn.toString();
    const out = [];
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        let resolved = null;
        try {
            resolved = require.resolve(m[1].startsWith('.') ? path.join(JOBS, m[1]) : m[1]);
        } catch {
            resolved = null;
        }
        out.push({ spec: m[1], resolved });
    }
    return out;
}
const isAllowed = (t) => A.allowed('ticks', { name: t.name });
const SWALLOW =
    /try\s*\{[^}]*require\([^)]*\)[^}]*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*return\s+null/;

describe('tick registry: every registered job module is requirable', () => {
    test('registry sanity: unique names, a fn, at least one require per tick', () => {
        expect(TICKS.length).toBeGreaterThan(20);
        expect(new Set(TICKS.map((t) => t.name)).size).toBe(TICKS.length);
        for (const t of TICKS) {
            expect(typeof t.fn).toBe('function');
            expect(modulesOf(t).length).toBeGreaterThan(0);
        }
        expect(A.unreasoned('ticks')).toEqual([]);
    });

    test('no missing module', () => {
        const missing = TICKS.filter((t) => !isAllowed(t)).flatMap((t) =>
            modulesOf(t)
                .filter((m) => !m.resolved)
                .map((m) => `${t.name} → require('${m.spec}') does not resolve`)
        );
        expect(missing).toEqual([]);
    });

    test('no registered fn swallows a require() error (a missing module must fail, never report ok)', () => {
        expect(TICKS.filter((t) => SWALLOW.test(t.fn.toString())).map((t) => t.name)).toEqual([]);
    });

    test('regression: the removed priority-index tick stays removed', () => {
        expect(TICKS.find((t) => t.name === 'priority-index.refresh')).toBeUndefined();
    });

    test('mutation self-check: a fn that swallows a missing module is detected', async () => {
        const fn = () => {
            try {
                return require('../services/DoesNotExistService').refresh();
            } catch {
                return null;
            }
        };
        expect(modulesOf({ fn }).map((m) => m.resolved)).toEqual([null]);
        expect(SWALLOW.test(fn.toString())).toBe(true);
        await expect(Promise.resolve().then(() => fn())).resolves.toBeNull();
    });

    test('every src/jobs/*.js exporting tick() is in the registry (no job outside TICKS)', () => {
        const files = fs.readdirSync(JOBS).filter((f) => f.endsWith('.js') && f !== 'index.js');
        const registered = new Set(
            TICKS.flatMap((t) => modulesOf(t).map((m) => m.resolved)).filter(Boolean)
        );
        const orphans = files.filter(
            (f) =>
                /\btick\s*[:(,]|exports\.tick\b|\btick\b\s*}/.test(
                    fs.readFileSync(path.join(JOBS, f), 'utf8')
                ) && !registered.has(require.resolve(path.join(JOBS, f)))
        );
        expect(orphans.filter((f) => !A.allowed('ticks', { file: f }))).toEqual([]);
    });

    test('cron minute pattern and everyMin agree on the period class', () => {
        for (const t of TICKS) {
            const m = t.cron.match(/^\*\/(\d+) /);
            if (m) expect(Number(m[1])).toBe(t.everyMin);
            else expect(t.everyMin).toBe(60);
        }
    });
});
