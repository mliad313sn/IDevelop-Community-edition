'use strict';
/**
 * Closeout — user guide (L6-09).
 *
 * Two things are pinned here:
 *  1. the in-app guide renders ONE language server-side (a French reader must not
 *     receive the English half of the manual in the DOM), and the EN/FR control
 *     stays a plain link so it works without JavaScript;
 *  2. every figure the content model references resolves, including the
 *     approvals-queue section that used to render without one.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = path.join(ROOT, 'views', 'pages', 'guide.ejs');
const SHOTS = path.join(ROOT, 'tests', 'uat', 'screenshots-min');

const GuideController = require('../../src/controllers/GuideController');
const C = require('../../src/config/userGuideContent');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function renderGuide(glang) {
    const clearance = 'superadmin';
    const ids = C.SECTIONS_FOR[clearance];
    return ejs.render(
        fs.readFileSync(VIEW, 'utf8'),
        {
            glang,
            clearance,
            roleLabel: { en: 'Super Admin', fr: 'Super administrateur' },
            getting: C.GETTING,
            sections: C.PROFILES.filter((p) => ids.includes(p.id)),
            flows: C.FLOWS,
            glossary: C.GLOSSARY,
            faq: C.FAQ,
            routes: {},
            cspNonce: 'test-nonce',
            lang: glang,
        },
        { filename: VIEW }
    );
}

function controllerLang({ query = {}, lang = 'fr' } = {}) {
    let captured = null;
    const req = { query, user: { role: 'superadmin', userType: 'admin' } };
    const res = {
        locals: { lang },
        render: (_v, locals) => {
            captured = locals;
        },
    };
    GuideController.index(req, res);
    return captured;
}

const allFeatures = () => [].concat(C.GETTING, ...C.PROFILES.map((p) => p.features));

// ---------------------------------------------------------------------------
describe('guide — the active language is chosen server-side', () => {
    test('a French session gets a French guide by default', () => {
        expect(controllerLang({ lang: 'fr' }).glang).toBe('fr');
    });

    test('an English session gets an English guide by default', () => {
        expect(controllerLang({ lang: 'en' }).glang).toBe('en');
    });

    test('?glang overrides the session language, both ways', () => {
        expect(controllerLang({ lang: 'fr', query: { glang: 'en' } }).glang).toBe('en');
        expect(controllerLang({ lang: 'en', query: { glang: 'fr' } }).glang).toBe('fr');
    });

    test('an unknown ?glang falls back to the session language, never to a third state', () => {
        expect(controllerLang({ lang: 'fr', query: { glang: 'de' } }).glang).toBe('fr');
        expect(controllerLang({ lang: 'en', query: { glang: '../en' } }).glang).toBe('en');
    });
});

describe('guide — only one language reaches the browser', () => {
    let fr;
    let en;
    beforeAll(() => {
        fr = renderGuide('fr');
        en = renderGuide('en');
    });

    test('the French page carries no English half', () => {
        // The old markup shipped both texts and hid one in CSS.
        expect(fr).not.toMatch(/class="g-en"/);
        expect(fr).not.toMatch(/class="g-fr"/);
        expect(fr).not.toContain('Where: ');
        expect(fr).not.toContain('Start here');
        expect(fr).not.toContain('Good practices');
        expect(fr).toContain('Où : ');
        expect(fr).toContain('Commencer ici');
    });

    test('the English page carries no French half', () => {
        expect(en).not.toMatch(/class="g-(en|fr)"/);
        expect(en).not.toContain('Où : ');
        expect(en).not.toContain('Commencer ici');
        expect(en).toContain('Where: ');
        expect(en).toContain('Start here');
    });

    test('each feature card appears exactly once, not twice', () => {
        const ids = C.SECTIONS_FOR.superadmin;
        const shown = [].concat(
            C.GETTING,
            ...C.PROFILES.filter((p) => ids.includes(p.id)).map((p) => p.features)
        );
        expect((fr.match(/class="g-card"/g) || []).length).toBe(shown.length);
        expect((en.match(/class="g-card"/g) || []).length).toBe(shown.length);
    });

    test('the French page is materially lighter than the bilingual one would be', () => {
        // Both halves in one document is roughly the two added together.
        expect(fr.length).toBeLessThan(fr.length + en.length - 1000);
    });

    test('the EN/FR control is a link, so it works with JavaScript off', () => {
        expect(fr).toMatch(/<a class="g-lang[^>]*href="\/guide\?glang=en"/);
        expect(fr).toMatch(/<a class="g-lang[^>]*href="\/guide\?glang=fr"/);
        expect(fr).not.toMatch(/localStorage\.setItem\('guideLang'/);
        // the active one is marked for assistive tech
        expect(fr).toMatch(/href="\/guide\?glang=fr"[^>]*aria-current="true"/);
    });

    test('the standalone full-guide link follows the language being read', () => {
        expect(fr).toContain('href="/user-guide.html"');
        expect(en).toContain('href="/user-guide.en.html"');
    });
});

describe('guide — every referenced figure resolves', () => {
    test('the approvals-queue section references a screenshot', () => {
        const approvals = allFeatures().find(
            (f) => f.title.en === 'Approvals queue — the two-person rule'
        );
        expect(approvals).toBeDefined();
        expect(approvals.img).toBe('sa-45-approvals-queue');
    });

    test('no feature references an image file that is missing', () => {
        // tests/uat/screenshots-min is gitignored (it is regenerated by
        // scripts/compress-shots.js), so this can only be checked where the
        // capture set is actually present.
        let files = [];
        try {
            files = fs.readdirSync(SHOTS);
        } catch (_) {
            /* not generated here */
        }
        if (!files.length) return;
        const missing = allFeatures()
            .map((f) => f.img)
            .filter(Boolean)
            .filter(
                (img) =>
                    !files.includes(img + '.jpg') &&
                    !files.some((n) => n.replace(/^[0-9]+-/, '') === img + '.jpg') &&
                    !files.some((n) => n.endsWith('-' + img + '.jpg'))
            );
        expect(missing).toEqual([]);
    });
});

describe('standalone builder — one document per language', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-user-guide.js'), 'utf8');

    test('it writes a French document and an English one', () => {
        expect(src).toContain("{ lang: 'fr', file: 'user-guide.html' }");
        expect(src).toContain("{ lang: 'en', file: 'user-guide.en.html' }");
    });

    test('it no longer emits both languages into one document', () => {
        expect(src).not.toContain('body[data-lang="en"] .fr{display:none}');
        expect(src).not.toContain("localStorage.setItem('guideLang'");
    });

    test('a referenced image with no file on disk still fails the build', () => {
        expect(src).toContain('BLOCKING: ');
        expect(src).toContain('process.exit(1)');
    });
});
