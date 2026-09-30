'use strict';
/**
 * UAT3 M-11, the CLASS — « un lien doit correspondre à une route RÉELLEMENT
 * montée » (SPEC §2.8).
 *
 * The first pass fixed the three dead links a tester had clicked and pinned
 * those three names. Five more were dead in the same file and nothing caught
 * them, because the tables that feed their sections (`assessment_disputes`,
 * `lms_enrollments`, `account_requests`, `maker_checker_requests`) are empty on
 * the development database: `/v2/disputes`, `/lms`, `/invitations`, `/mobility`
 * and `/admin/maker-checker` had never existed either.
 *
 * So this file pins the INVARIANT and not the names: every link literal the
 * department brief can emit — the `link:` of a cell or of a section, the
 * positional link of the A6 decision queues, the LINK table and every value of
 * the alias table that repairs already-archived payloads — is resolved through
 * `resolveLink` and matched against the REAL router tree. A new section that
 * invents a path fails here, before a reader clicks it.
 *
 * DB-free: the routers only need DATABASE_URL to be SET (the Pool is lazy).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/dept_brief_links_test';
process.env.NODE_ENV = 'test';
// Most of the brief's destinations are /v2/*. Those routers used to need
// V2_FEATURES=1; they are now always mounted (behind their module switch), so
// the flag is deliberately NOT set: the destinations must exist by default.
delete process.env.V2_FEATURES;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dept-brief-links-test-secret';
process.env.API_KEY = process.env.API_KEY || 'dept-brief-links-test-api-key';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVICE_PATH = path.join(ROOT, 'src/services/DeptBriefService.js');
const SRC = fs.readFileSync(SERVICE_PATH, 'utf8');
const S = require('../../src/services/DeptBriefService');

/** Express keeps a sub-router's prefix only as the regexp it compiled from it. */
function mountPrefix(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    return layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\$$/, '')
        .replace(/\\\//g, '/');
}

function collectPaths(router) {
    const paths = new Set();
    (function walk(stack, prefix) {
        for (const layer of stack) {
            if (layer.route) {
                const p = layer.route.path;
                for (const one of Array.isArray(p) ? p : [p]) {
                    paths.add(prefix + (one === '/' ? '' : one) || '/');
                }
            } else if (layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountPrefix(layer));
            }
        }
    })(router.stack, '');
    return paths;
}

let mounted;
beforeAll(() => {
    mounted = collectPaths(require('../../src/routes/index'));
});

/**
 * A brief link may carry a query string (`/employees?noManager=1`), a fragment
 * (`/v2/continuity#ret-table`) or an interpolated id (`/cycles/${cyc.id}`).
 * Compare the PATH only, and let a `:param` segment of the route match the
 * interpolation.
 */
function isMounted(link) {
    const pathOnly = String(link).split('?')[0].split('#')[0];
    const candidate = pathOnly.replace(/\$\{[^}]*\}/g, '1');
    if (mounted.has(candidate)) return true;
    for (const route of mounted) {
        if (!route.includes(':')) continue;
        const re = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`);
        if (re.test(candidate)) return true;
    }
    return false;
}

/** Every link literal the service can put into a payload. */
function linkLiteralsOf(src) {
    const out = [];
    src.split(/\r?\n/).forEach((line, i) => {
        const at = i + 1;
        let m;
        // `link: '/x'` — cells and sections.
        const re = /link:\s*(['"])(\/[^'"]*)\1/g;
        while ((m = re.exec(line))) out.push({ line: at, link: m[2] });
        // `link: LINK.x` — the named table.
        const re2 = /link:\s*LINK\.(\w+)/g;
        while ((m = re2.exec(line)))
            out.push({ line: at, link: S.LINK[m[1]], via: `LINK.${m[1]}` });
        // A6: `push(family, slug, label, source, link, …)` — the link is a
        // POSITIONAL argument, which is exactly why three dead ones hid there.
        const re3 = /,\s*'[a-z_]+',\s*(['"])(\/[^'"]*)\1\s*,/g;
        while ((m = re3.exec(line))) out.push({ line: at, link: m[2], via: 'push()' });
        const re4 = /,\s*'[a-z_]+',\s*LINK\.(\w+)\s*,/g;
        while ((m = re4.exec(line)))
            out.push({ line: at, link: S.LINK[m[1]], via: `push() LINK.${m[1]}` });
    });
    // The pre-commit hook (prettier) wraps a long push() across lines, which puts
    // the positional link on a line of its own where the per-line scan above can
    // no longer see the `'source', '/link',` pair. Re-run the two positional
    // patterns over the WHOLE text (their \s* spans the newlines) so a wrapped
    // call is found too. Duplicates are harmless — the consumers key on the link.
    let mm;
    const reFull3 = /,\s*'[a-z_]+',\s*(['"])(\/[^'"]*)\1\s*,/g;
    while ((mm = reFull3.exec(src))) out.push({ line: 0, link: mm[2], via: 'push()' });
    const reFull4 = /,\s*'[a-z_]+',\s*LINK\.(\w+)\s*,/g;
    while ((mm = reFull4.exec(src)))
        out.push({ line: 0, link: S.LINK[mm[1]], via: `push() LINK.${mm[1]}` });
    return out;
}

describe('department brief — every deep link is a route that is really mounted', () => {
    test('the route inventory really loaded (guards against a vacuous test)', () => {
        expect(mounted.size).toBeGreaterThan(100);
        expect(mounted.has('/dashboard')).toBe(true);
        expect([...mounted].some((p) => p.startsWith('/v2/'))).toBe(true);
    });

    test('the scan really finds the links (guards against a vacuous regexp)', () => {
        const found = linkLiteralsOf(SRC);
        expect(found.length).toBeGreaterThan(20);
        const set = new Set(found.map((f) => f.link));
        // one cell link, one section link, one LINK.* link and one push() link
        expect(set.has('/compliance')).toBe(true);
        expect(set.has(S.LINK.keyPerson)).toBe(true);
        expect(set.has('/onboarding')).toBe(true);
        expect(set.has(S.LINK.makerChecker)).toBe(true);
    });

    test('every link literal of the producer is a mounted route AS WRITTEN', () => {
        // Deliberately NOT through `resolveLink`: the alias table exists to
        // repair payloads that are already archived, and if it were allowed to
        // cover the producer too, a new dead link would pass here the day
        // somebody aliased it. What the job FREEZES must already be real.
        const dead = linkLiteralsOf(SRC)
            .filter((f) => !isMounted(f.link))
            .map((f) => `DeptBriefService.js:${f.line} ${f.link}${f.via ? ` (${f.via})` : ''}`);
        expect(dead).toEqual([]);
    });

    test('every LINK target and every alias target is a mounted route', () => {
        const dead = [];
        for (const [name, link] of Object.entries(S.LINK)) {
            if (!isMounted(link)) dead.push(`LINK.${name} -> ${link}`);
        }
        for (const [legacy, link] of Object.entries(S.LEGACY_LINK_ALIAS)) {
            if (!isMounted(link)) dead.push(`${legacy} -> ${link}`);
        }
        expect(dead).toEqual([]);
    });

    test('the five paths S10 found dead are gone from the producer', () => {
        // They survive in ONE place: the alias that repairs archived payloads.
        const alias = SRC.slice(
            SRC.indexOf('const LEGACY_LINK_ALIAS'),
            SRC.indexOf('function _readerLink')
        );
        const rest = SRC.replace(alias, '');
        for (const dead of ['/v2/disputes', '/invitations', '/admin/maker-checker']) {
            expect(rest).not.toMatch(new RegExp(`link:\\s*'${dead}'`));
            expect(rest).not.toMatch(new RegExp(`,\\s*'${dead}',`));
            expect(alias).toContain(`'${dead}'`);
        }
        expect(rest).not.toMatch(/link: '\/lms'/);
        expect(rest).not.toMatch(/, '\/mobility',/);
        expect(alias).toContain("'/lms'");
        expect(alias).toContain("'/mobility'");
        // …and an archived payload is repaired at render time, never rewritten.
        expect(S.resolveLink('/v2/disputes')).toBe('/v2/slf/disputes');
        expect(S.resolveLink('/invitations')).toBe('/admin/accounts');
        expect(S.resolveLink('/mobility')).toBe('/v2/cap');
        expect(S.resolveLink('/admin/maker-checker')).toBe('/v2/uam/maker-checker/queue');
    });

    test('the LMS link is resolved for the READER — never a 403, never a bounce', () => {
        // The hub is gated by configure_lms, the learner page by
        // employee-or-manager: one frozen string cannot serve both.
        const lmsAdmin = { isAdmin: true, canConfigureLms: true };
        const plainAdmin = { isAdmin: true, canConfigureLms: false };
        const learner = { isAdmin: false, canConfigureLms: false };
        expect(S.resolveLink('/lms', lmsAdmin)).toBe('/v2/lms');
        expect(S.resolveLink('/v2/lms', lmsAdmin)).toBe('/v2/lms');
        expect(S.resolveLink('/lms', plainAdmin)).toBe(null); // no page → no link
        expect(S.resolveLink('/v2/lms', plainAdmin)).toBe(null);
        expect(S.resolveLink('/lms', learner)).toBe('/employee/my-learning');
        expect(S.resolveLink('/v2/lms', learner)).toBe('/employee/my-learning');
        // Nothing else in the brief depends on who reads it.
        expect(S.resolveLink('/compliance', learner)).toBe('/compliance');
        expect(S.resolveLink('/v2/slf/disputes', plainAdmin)).toBe('/v2/slf/disputes');
        // No reader (a job, an export) — the frozen value is left alone.
        expect(S.resolveLink('/lms')).toBe('/v2/lms');
    });

    test('the reader is built from the SESSION, by the controller, with the hub own test', () => {
        // The service must NOT read a session permission: its own principals are
        // built by a job and carry none (that is why A6 uses getPermissions).
        expect(SRC).not.toMatch(/\.hasPermission\(/);
        const ctrl = fs.readFileSync(
            path.join(ROOT, 'src/controllers/DeptBriefController.js'),
            'utf8'
        );
        expect(ctrl).toMatch(/function readerOf\(req\)/);
        expect(ctrl).toMatch(/canConfigureLms: RBACService\.hasPermission\(u, 'configure_lms'\)/);
        // …and BOTH render paths go through it.
        expect(
            ctrl.match(/linkOf: \(l\) => DeptBriefService\.resolveLink\(l, readerOf\(req\)\)/g) ||
                []
        ).toHaveLength(2);
        // The guard this mirrors, quoted from the router itself.
        const lms = fs.readFileSync(path.join(ROOT, 'src/routes/v2-lms.js'), 'utf8');
        expect(lms).toMatch(/hasPermission\(req\.user, 'configure_lms'\)/);
        expect(lms).toMatch(/router\.get\(\s*'\/',\s*requireAuth,\s*requireConfigureLms/);
    });

    test('the retention link leads to a PAGE, not to the JSON endpoint', () => {
        // /v2/continuity/retention answers {ok:true,list:[…]}; the page that
        // shows that list is the continuity hub, at the id of its own table.
        expect(S.LINK.retention).toBe('/v2/continuity#ret-table');
        const view = fs.readFileSync(path.join(ROOT, 'views/pages/continuity/index.ejs'), 'utf8');
        expect(view).toContain('id="ret-table"');
        const cont = fs.readFileSync(path.join(ROOT, 'src/routes/v2-continuity.js'), 'utf8');
        // `\s*` after the paren: the reformat puts the path on its own line.
        expect(cont).toMatch(/router\.get\(\s*'\/retention',[\s\S]{0,2000}?res\.json\(/);
    });

    test('the page prints no anchor when the reader has no page, and routes the CTA through the resolver', () => {
        const ejs = fs.readFileSync(
            path.join(ROOT, 'views/pages/reports/dept-brief-show.ejs'),
            'utf8'
        );
        expect(ejs).toMatch(/const openHref = href\(s\.cta \|\| s\.link\)/);
        expect(ejs).toMatch(/if \(s\.link && openHref\)/);
        // The old short-circuit — a frozen cta escaping the alias — is gone.
        expect(ejs).not.toMatch(/href="<%= s\.cta \|\| href\(s\.link\) %>"/);
    });
});
