'use strict';
/**
 * Interaction details of the 4.0.0 port, wave 11:
 *   - the skill matrix draws one domain of skill columns at a time, by default
 *     the domain most required by the roles on the page, « All » one choice away;
 *   - the campaign roster filters are checkbox lists (same field names), and
 *     excusing « the whole filter » is offered, and accepted, only while a
 *     filter is on;
 *   - a same-origin link shows a progress bar while the next page renders;
 *   - the offline page comes back by itself when the network returns;
 *   - the board decisions page has its contextual help.
 * Invented data only.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { chooseDomainColumns } = require('../../src/utils/matrixDomains');

describe('the skill matrix shows one domain of columns at a time', () => {
    const dom = (id, name, skillIds) => ({
        domain: { id, name },
        skills: skillIds.map((s) => ({ id: s, domainId: id })),
    });
    const SKILLS = {
        1: dom(1, 'Lifting and rigging', [11, 12, 13, 14]),
        2: dom(2, 'Quality control', [21, 22]),
        3: dom(3, 'Electrical safety', [31, 32, 33]),
        4: dom(4, 'Empty domain', []),
    };
    const REQS = {
        // two roles on the page: quality is the most required domain
        7: { 21: {}, 22: {}, 31: {} },
        8: { 21: {}, 11: {} },
    };

    test('by default, the domain most required by the roles shown', () => {
        const r = chooseDomainColumns(SKILLS, REQS, '');
        expect(r.activeDomain).toBe('2');
        expect(Object.keys(r.shown)).toEqual(['2']);
        expect(r.shown['2'].skills).toHaveLength(2);
    });

    test('with nothing required, the largest domain; an empty domain is never offered', () => {
        const r = chooseDomainColumns(SKILLS, {}, undefined);
        expect(r.activeDomain).toBe('1');
        expect(r.domainOptions.map((o) => o.id)).toEqual(['1', '2', '3']);
        expect(r.domainOptions[1]).toEqual({
            id: '2',
            name: 'Quality control',
            skills: 2,
            required: 0,
        });
    });

    test('a requested domain is honoured; « all » draws every domain', () => {
        expect(chooseDomainColumns(SKILLS, REQS, '3').activeDomain).toBe('3');
        const all = chooseDomainColumns(SKILLS, REQS, 'all');
        expect(all.activeDomain).toBe('all');
        expect(all.shown).toBe(SKILLS);
    });

    test('an unknown or hostile value falls back to the default, never to a new column set', () => {
        for (const v of ['99', '__proto__', 'constructor', '1 OR 1=1', ['1', '2']]) {
            const r = chooseDomainColumns(SKILLS, REQS, v);
            expect(r.activeDomain).toBe('2');
            expect(Object.keys(r.shown)).toEqual(['2']);
        }
    });

    test('no domain at all: the page still renders with « all »', () => {
        const r = chooseDomainColumns({}, {}, '');
        expect(r.activeDomain).toBe('all');
        expect(r.domainOptions).toEqual([]);
    });

    test('the controller passes the choice and the view offers it', () => {
        const ctl = read('src/controllers/SkillMatrixController.js');
        expect(ctl).toMatch(
            /chooseDomainColumns\(skillsByDomain, roleRequirementsMap, req\.query\.domain\)/
        );
        expect(ctl).toMatch(/skillsByDomain: cols\.shown/);
        const view = read('views/pages/skill-matrix/index.ejs');
        expect(view).toMatch(/<select id="filterDomain" data-on-change="smServerFilter"/);
        expect(view).toContain("p.set('domain', v('filterDomain'))");
        expect(view).toContain("__('dash:sm_domain_all')");
        expect(() => ejs.compile(view, { filename: 'index.ejs' })).not.toThrow();
        for (const lang of ['en', 'fr']) {
            const d = JSON.parse(read(`locales/${lang}/dash.json`));
            for (const k of ['sm_domain_colon', 'sm_domain_count', 'sm_domain_all'])
                expect(d[k]).toBeTruthy();
            expect(d.sm_domain_count).toContain('{{required}}');
        }
    });
});

describe('the campaign roster filters', () => {
    const view = read('views/pages/cycles/show.ejs');

    test('site, department, service, role and manager are checkbox lists', () => {
        expect(view).not.toMatch(/<select[^>]*multiple/);
        for (const n of ['siteId', 'departmentId', 'serviceId', 'roleId', 'supervisorId'])
            expect(view).toMatch(new RegExp(`<input type="checkbox" name="${n}" value=`));
        expect(view).toMatch(/<details class="cyc-ms" id="cyc-site">/);
        // a finger-sized target
        expect(view).toMatch(/\.cyc-ms-opt\{[^}]*min-height:44px/);
        expect(() => ejs.compile(view, { filename: 'show.ejs' })).not.toThrow();
    });

    test('« excuse the whole filter » is offered only while a filter is on', () => {
        expect(view).toMatch(
            /<% if \(filters\.filtered\) \{ %><button type="button" class="btn btn-sm btn-secondary" id="cyc-filter-exclude"/
        );
    });

    test('and the service refuses it without a filter, before touching anything', async () => {
        const CycleService = require('../../src/services/CycleService');
        expect(CycleService.isFiltered(CycleService.parseFilters({}))).toBe(false);
        expect(CycleService.isFiltered(CycleService.parseFilters({ siteId: '3' }))).toBe(true);
        expect(CycleService.isFiltered(CycleService.parseFilters({ supervisorId: 'none' }))).toBe(
            true
        );
        await expect(
            CycleService.excludeBulk(
                1,
                { filter: CycleService.parseFilters({}) },
                { reason: 'Long leave', category: 'long_leave' },
                { userType: 'admin', role: 'superadmin', id: 1 }
            )
        ).rejects.toMatchObject({ code: 'exclusion_filter_empty' });
        const ctl = read('src/controllers/CycleController.js');
        expect(ctl).toMatch(/exclusion_filter_empty: 400/);
        for (const lang of ['en', 'fr'])
            expect(
                JSON.parse(read(`locales/${lang}/admin.json`)).cyc_err_exclusion_filter_empty
            ).toBeTruthy();
    });
});

describe('navigation feedback while the next page renders', () => {
    const src = read('public/js/main.js');
    const iife = src.slice(src.indexOf('(function navigationFeedback()'));

    function world(here = 'https://idevelop.test/team?x=1') {
        const listeners = {};
        const classes = new Set();
        const main = {
            attrs: {},
            setAttribute(k, v) {
                this.attrs[k] = v;
            },
            removeAttribute(k) {
                delete this.attrs[k];
            },
        };
        const body = {
            children: [],
            appendChild(c) {
                this.children.push(c);
            },
        };
        const document = {
            documentElement: {
                classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
            },
            body,
            getElementById: (id) => (id === 'main-content' ? main : null),
            createElement: () => ({
                attrs: {},
                setAttribute(k, v) {
                    this.attrs[k] = v;
                },
            }),
            addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
        };
        const location = new URL(here);
        const window = {
            location,
            addEventListener: (t, fn) => (listeners['w:' + t] = listeners['w:' + t] || []).push(fn),
        };
        vm.runInContext(iife, vm.createContext({ document, window }));
        const link = (href, extra = {}) => {
            const u = new URL(href, here);
            const attrs = { href, ...(extra.attrs || {}) };
            return {
                target: extra.target || '',
                protocol: u.protocol,
                origin: u.origin,
                pathname: u.pathname,
                search: u.search,
                hash: u.hash,
                getAttribute: (k) => (k in attrs ? attrs[k] : null),
                hasAttribute: (k) => k in attrs,
            };
        };
        const click = (a, ev = {}) => {
            const e = { button: 0, defaultPrevented: false, target: { closest: () => a }, ...ev };
            for (const fn of listeners.click || []) fn(e);
        };
        return {
            click,
            link,
            classes,
            main,
            body,
            fire: (t) => (listeners['w:' + t] || []).forEach((f) => f()),
        };
    }

    test('a same-origin link starts it and marks the main region busy', () => {
        const w = world();
        w.click(w.link('/exec/board-pack'));
        expect(w.classes.has('is-navigating')).toBe(true);
        expect(w.main.attrs['aria-busy']).toBe('true');
        expect(w.body.children[0].className).toBe('nav-pending');
        expect(w.body.children[0].attrs['aria-hidden']).toBe('true');
        // back from the back/forward cache: cleared
        w.fire('pageshow');
        expect(w.classes.has('is-navigating')).toBe(false);
        expect(w.main.attrs['aria-busy']).toBeUndefined();
    });

    test.each([
        ['an in-page anchor', (w) => w.click(w.link('#details'))],
        ['the same page with a hash', (w) => w.click(w.link('/team?x=1#row-3'))],
        ['another origin', (w) => w.click(w.link('https://example.org/'))],
        ['a new tab', (w) => w.click(w.link('/team', { target: '_blank' }))],
        ['a download', (w) => w.click(w.link('/export.csv', { attrs: { download: '' } }))],
        ['a mail link', (w) => w.click(w.link('mailto:someone@example.org'))],
        ['a data: link', (w) => w.click(w.link('data:text/html,hello'))],
        ['a modified click', (w) => w.click(w.link('/team'), { ctrlKey: true })],
        ['a middle click', (w) => w.click(w.link('/team'), { button: 1 })],
        [
            'a click a page script handled',
            (w) => w.click(w.link('/team'), { defaultPrevented: true }),
        ],
    ])('not for %s', (_what, act) => {
        const w = world();
        act(w);
        expect(w.classes.has('is-navigating')).toBe(false);
    });

    test('the bar waits 300 ms and respects reduced motion', () => {
        const css = read('public/css/horizon.css');
        expect(css).toMatch(
            /\.is-navigating \.nav-pending \{\s*animation: hz-nav-pending [^;]*300ms/
        );
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.nav-pending/);
    });
});

describe('the offline page comes back by itself', () => {
    test('on the online event, and by a quiet probe while visible', async () => {
        const handlers = {};
        let interval = null;
        let reloads = 0;
        let fetched = 0;
        let online = false;
        const document = { hidden: false, getElementById: () => null };
        const ctx = vm.createContext({
            document,
            location: { href: 'https://idevelop.test/dashboard', reload: () => (reloads += 1) },
            setInterval: (fn, ms) => {
                interval = { fn, ms };
            },
            fetch: (url, opts) => {
                fetched += 1;
                expect(opts.method).toBe('HEAD');
                expect(opts.cache).toBe('no-store');
                return online
                    ? Promise.resolve({ ok: true })
                    : Promise.reject(new Error('offline'));
            },
        });
        ctx.window = {
            fetch: ctx.fetch,
            addEventListener: (t, fn) => (handlers[t] = fn),
        };
        vm.runInContext(read('public/js/offline.js'), ctx);
        expect(interval.ms).toBe(30000);

        interval.fn();
        await new Promise((r) => setImmediate(r));
        expect(reloads).toBe(0); // still offline

        document.hidden = true;
        interval.fn();
        expect(fetched).toBe(1); // a background tab is not probed

        document.hidden = false;
        online = true;
        interval.fn();
        await new Promise((r) => setImmediate(r));
        expect(reloads).toBe(1);

        handlers.online();
        expect(reloads).toBe(2);
    });
});

describe('the board decisions page has its help', () => {
    test('help.js has an entry for /exec/decisions', () => {
        expect(read('public/js/help.js')).toMatch(/^\s{8}'\/exec\/decisions': \{/m);
    });
});
