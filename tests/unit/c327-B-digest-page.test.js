'use strict';
/**
 * « My summaries » pages (/digests, /digests/:id): the real templates with the
 * real FR / EN catalogues (no database), and the controller's link guard.
 *   - the archive says when the summaries are not switched on, offers the
 *     frequency (CSRF token, no inline handler) and « Restore » after a
 *     step-down;
 *   - one summary prints its stored sentences, a polarity said in words for
 *     screen readers, only app-relative links; forbidden / not found /
 *     out-of-scope modes print no content.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const tr = (lang) => (key, o) => {
    const [ns, k] = String(key).split(':');
    // eslint-disable-next-line security/detect-non-literal-require
    const dict = require(`../../locales/${lang}/${ns}.json`);
    let out = dict[k] !== undefined ? dict[k] : key;
    if (o) for (const [a, b] of Object.entries(o)) out = out.split(`{{${a}}}`).join(String(b));
    return out;
};
const render = (file, locals, lang = 'en') => {
    const f = path.join(ROOT, 'views/pages/digests', file);
    return ejs.render(
        fs.readFileSync(f, 'utf8'),
        { __: tr(lang), lang, csrfToken: 'tok-1', ...locals },
        { filename: f }
    );
};

describe('the archive', () => {
    const base = {
        enabled: true,
        rows: [{ id: 12, title: 'What changed this week', date: '12/10/2026', opened: false }],
        cadence: 'weekly',
        cadences: ['daily', 'weekly', 'off'],
        stepdown: null,
    };
    test('rows link to the summary; the frequency form has the CSRF token and no handler', () => {
        const h = render('index.ejs', base);
        expect(h).toMatch(/<a href="\/digests\/12">What changed this week<\/a>/);
        expect(h).toMatch(/name="_csrf" value="tok-1"/);
        expect(h).toMatch(/value="weekly" checked/);
        expect(h).not.toMatch(/\son[a-z]+="/i);
        expect(h).not.toMatch(/<script/i);
        expect(h).not.toMatch(/id="dg-off"/);
    });
    test('switched off in the organisation: said, in French and English', () => {
        expect(render('index.ejs', { ...base, enabled: false }, 'fr')).toMatch(
            /ne sont pas activés dans votre organisation/
        );
        expect(render('index.ejs', { ...base, enabled: false })).toMatch(
            /not switched on in your organisation/
        );
    });
    test('after a step-down: the notice and « Restore »', () => {
        const h = render('index.ejs', { ...base, stepdown: { date: '01/10/2026' } });
        expect(h).toMatch(/frequency was reduced on 01\/10\/2026/);
        expect(h).toMatch(/name="restore" value="1"/);
    });
    test('an empty archive says so', () => {
        expect(render('index.ejs', { ...base, rows: [] })).toMatch(/No summary yet/);
    });
});

describe('one summary', () => {
    const D = {
        id: 12,
        persona: 'executive',
        title: 'What changed this month',
        period: '30-day period ending on 12/10/2026',
        line: 'Since 12/09/2026:',
        changes: [
            {
                text: 'Role-ready rate: 63% (+4 pts), over 57 people with a verdict.',
                href: '/dashboard/list?kpi=K1&part=not_ready',
                polarity: 'better',
            },
        ],
        actions: [{ text: '2 people have a required certificate expired.', href: null }],
        history: [],
    };
    test('prints the stored sentences with their polarity in words and app links only', () => {
        const h = render('show.ejs', { mode: 'one', digest: D });
        expect(h).toMatch(/Role-ready rate: 63% \(\+4 pts\)/);
        expect(h).toMatch(/improving: /);
        expect(h).toMatch(/href="\/dashboard\/list\?kpi=K1&amp;part=not_ready"/);
        expect(h).toMatch(/2 people have a required certificate expired\./);
        expect(h).not.toMatch(/\son[a-z]+="/i);
    });
    test.each([
        ['forbidden', /written for someone else/],
        ['notfound', /does not exist/],
    ])('mode %s prints no content', (mode, re) => {
        const h = render('show.ejs', { mode, digest: null });
        expect(h).toMatch(re);
        expect(h).not.toMatch(/Role-ready/);
    });
    test('out of scope prints no content', () => {
        const h = render('show.ejs', { mode: 'out_of_scope', digest: D });
        expect(h).toMatch(/no longer entirely within your rights/);
        expect(h).not.toMatch(/Role-ready/);
    });
    test('the controller keeps app-relative links only', () => {
        const C = require('../../src/controllers/DigestController');
        const { safeHref } = C._test;
        expect(safeHref('/dashboard/list?kpi=K1&part=ready')).toBe(
            '/dashboard/list?kpi=K1&part=ready'
        );
        expect(safeHref('//evil.example/x')).toBeNull();
        expect(safeHref('/\\evil.example')).toBeNull();
        expect(safeHref('https://evil.example')).toBeNull();
        expect(safeHref('javascript:alert(1)')).toBeNull();
        expect(safeHref(null)).toBeNull();
    });
});

describe('routes and catalogue', () => {
    test('/digests is mounted for every signed-in account; the kinds are declared', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
        expect(src).toMatch(/router\.get\('\/digests', requireAuth,/);
        expect(src).toMatch(/router\.post\('\/digests\/preferences', requireAuth,/);
        expect(src).toMatch(/router\.get\('\/digests\/:id', requireAuth,/);
        const cat = require('../../src/services/notificationCatalogue');
        for (const p of ['executive', 'hr', 'manager', 'employee', 'paused'])
            expect(cat.isDeclared('digest.persona.' + p)).toBe(true);
        expect(cat.tierOf('digest.persona.employee')).toBe('none');
        expect(cat.webhookOf('digest.persona.executive')).toBe('never');
    });
});
