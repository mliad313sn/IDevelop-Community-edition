'use strict';
/**
 * The shared components on IDevelop's tokens.
 *
 * A. Rendered partials (ejs): the status badge (icon + text, every value
 *    escaped — the className too), the form field (label ↔ id, hint and error
 *    in aria-describedby, attributes as an escaped map, no handler accepted),
 *    the legend, the bulk bar (hidden until a selection, no markup passed in),
 *    the skeleton and the page table of contents.
 * B. ui-feedback.js and status-badge.js in a real Chromium (page.setContent:
 *    no server, no database): the confirmation dialog — role=dialog,
 *    aria-modal, labelled and described, Tab trapped both ways, Escape and a
 *    backdrop click cancel, the focus returns to the opener, a destructive
 *    dialog opens on its cancel button, « OK / Oui / Yes » refused for an
 *    action — and the toast (both argument orders, icon + spoken kind, errors
 *    persist, layers on the --z-* scale, the brand primary). Skipped when no
 *    Chromium binary is installed.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { chromiumOrNull, launchOptions } = require('../helpers/chromium');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const P = (f) => path.join(ROOT, 'views/partials', f);
const render = (f, locals) =>
    ejs.render(
        fs.readFileSync(P(f), 'utf8'),
        { __: (k, o) => (o ? k + JSON.stringify(o) : k), ...locals },
        { filename: P(f) }
    );
const EVIL = '"><img src=x onerror=alert(1)>';

describe('A. partials', () => {
    test('status badge: icon + text, tone from a workflow state, everything escaped', () => {
        const html = render('status-badge.ejs', {
            state: 'changes_requested',
            label: EVIL,
            n: 3,
            title: EVIL,
            className: 'x" onmouseover="y',
        });
        expect(html).toMatch(
            /class="badge badge--warn x&#34; onmouseover=&#34;y" data-tone="warn"/
        );
        expect(html).toMatch(
            /<i class="fas fa-triangle-exclamation badge-ic" aria-hidden="true"><\/i>/
        );
        expect(html).toContain('<span class="badge-n">3</span>');
        expect(html).not.toContain('<img');
        expect(render('status-badge.ejs', { tone: 'unmeasured', label: 'x' })).toMatch(
            /badge--unmeasured/
        );
        expect(render('status-badge.ejs', { tone: 'nonsense', label: 'x' })).toMatch(
            /badge--neutral/
        );
        // a hostile icon name falls back to the tone's own icon
        expect(
            render('status-badge.ejs', { tone: 'ok', label: 'x', icon: 'fa-x" onclick="y' })
        ).toMatch(/fa-circle-check/);
    });

    test('form field: label ↔ id, hint + error described, attributes escaped, no handler', () => {
        const html = render('form-field.ejs', {
            id: 'email',
            label: 'Adresse',
            type: 'email',
            required: true,
            hint: 'h',
            error: 'e',
            value: EVIL,
            attrs: { autocomplete: 'off', onfocus: 'alert(1)', id: 'other', maxlength: 120 },
        });
        expect(html).toMatch(
            /<label class="form-field-label is-required" for="email">Adresse<\/label>/
        );
        expect(html).toMatch(
            /id="email" name="email" required aria-describedby="email-hint email-err" aria-invalid="true" autocomplete="off" maxlength="120"/
        );
        expect(html).not.toMatch(/onfocus/);
        expect(html).not.toContain('id="other"');
        expect(html).not.toContain('<img');
        expect(html).toMatch(/id="email-err" role="alert"/);
        // no error, no red: the control is not marked invalid
        expect(render('form-field.ejs', { id: 'a', label: 'A' })).not.toMatch(/aria-invalid/);
        // the partial prints nothing unescaped
        expect(read('views/partials/form-field.ejs')).not.toMatch(/<%-/);
    });

    test('the required marker is drawn by CSS once; the legend explains it', () => {
        expect(render('form-legend.ejs', {})).toMatch(
            /<span class="form-legend-star" aria-hidden="true">\*<\/span> common:form_required_legend/
        );
        const css = read('public/css/style.css');
        expect(css).toMatch(
            /\.form-field-label\.is-required::after,\s*label\.required::after \{\s*content: ' \*';/
        );
    });

    test('bulk bar: hidden until a selection, actions as data (escaped), no raw markup', () => {
        const html = render('bulk-bar.ejs', {
            scope: '#t',
            actions: [
                {
                    label: EVIL,
                    icon: 'fa-trash',
                    form: 'f1',
                    name: 'op',
                    value: 'delete',
                    danger: true,
                },
            ],
        });
        expect(html).toMatch(
            /<div class="bulk-bar" id="bulkBar" hidden role="region" aria-live="polite"/
        );
        expect(html).toMatch(/data-bulk-scope="#t"/);
        expect(html).toMatch(
            /<button type="submit" class="btn btn-sm btn-danger" form="f1" name="op" value="delete">/
        );
        expect(html).not.toContain('<img');
        expect(read('views/partials/bulk-bar.ejs')).not.toMatch(/<%-/);
        const js = read('public/js/list-tools.js');
        expect(js).toMatch(/bar\.hidden = n === 0;/);
        expect(js).toMatch(/bar\.focus\(\{ preventScroll: true \}\)/);
    });

    test('skeleton: announced once, shapes only; page TOC: anchors cleaned, icons checked', () => {
        const sk = render('skeleton.ejs', { rows: 2, cols: 3, table: true });
        expect(sk).toMatch(/role="status" aria-live="polite"/);
        expect((sk.match(/class="skeleton-line"/g) || []).length).toBe(6);
        const toc = render('page-toc.ejs', {
            tocItems: [
                { id: 'set-a', label: 'A', icon: 'fa-gear' },
                { id: 'x" onclick="y', label: EVIL, icon: 'bad icon' },
            ],
        });
        expect(toc).toMatch(/<nav class="page-toc" id="pageToc" aria-labelledby="pageTocH">/);
        expect(toc).toContain('href="#set-a"');
        expect(toc).toContain('href="#xonclicky"');
        expect(toc).toContain('fa-circle-dot');
        expect(toc).not.toContain('<img');
    });

    test('the settings page carries « Sur cette page »', () => {
        expect(read('views/pages/app-settings/index.ejs')).toMatch(
            /include\('\.\.\/\.\.\/partials\/page-toc', \{ tocId: 'settingsToc'/
        );
    });

    test('status-badge.js escapes like the partial (no user-keyed object writes)', () => {
        const SB = require('../../public/js/status-badge.js');
        const html = SB.html('rejected', EVIL, '<b>', {
            className: 'a" b',
            title: EVIL,
            icon: 'x y',
        });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<b>');
        expect(html).toMatch(/class="badge badge--risk a&quot; b"/);
        expect(html).toMatch(/fa-circle-xmark/);
        expect(SB.tone('__proto__')).toBe('neutral');
        expect(SB.tone('arbitration')).toBe('accent');
    });
});

const chromium = chromiumOrNull();
const d = chromium ? describe : describe.skip;
jest.setTimeout(120000);

const STYLE = read('public/css/style.css');
const HORIZON = read('public/css/horizon.css');
const UIF = read('public/js/ui-feedback.js');
const PAGE = (
    theme
) => `<!doctype html><html lang="fr"${theme === 'light' ? ' data-theme="light"' : ''}><head>
<style>${STYLE}</style><style>${HORIZON}</style></head>
<body class="no-sidebar">
<main><button id="opener" class="btn btn-primary">Ouvrir</button><a href="#" id="after">après</a></main>
<script>${UIF}</script></body></html>`;

d('B. ui-feedback in Chromium', () => {
    let browser;
    beforeAll(async () => {
        browser = await chromium.launch(launchOptions());
    });
    afterAll(async () => {
        if (browser) await browser.close();
    });
    async function fresh(opts = {}) {
        const ctx = await browser.newContext(
            Object.assign({ viewport: { width: 1200, height: 800 } }, opts.context || {})
        );
        const page = await ctx.newPage();
        const warnings = [];
        page.on('console', (m) => {
            if (m.type() === 'warning') warnings.push(m.text());
        });
        await page.setContent(PAGE(opts.theme || 'dark'));
        return { ctx, page, warnings };
    }

    test('confirmDialog (object form): dialog semantics, focus trap, Escape → false, focus returns', async () => {
        const { ctx, page } = await fresh();
        await page.focus('#opener');
        const resultP = page.evaluate(() =>
            window.confirmDialog({
                title: 'Retirer le périmètre ?',
                body: 'Le site est retiré du périmètre.',
                confirmLabel: 'Retirer le périmètre',
            })
        );
        const dlg = page.locator('.uif-modal[role="dialog"]');
        await dlg.waitFor();
        expect(await dlg.getAttribute('aria-modal')).toBe('true');
        const labelledby = await dlg.getAttribute('aria-labelledby');
        expect(await page.locator('#' + labelledby).textContent()).toBe('Retirer le périmètre ?');
        const describedby = await dlg.getAttribute('aria-describedby');
        expect(await page.locator('#' + describedby).textContent()).toBe(
            'Le site est retiré du périmètre.'
        );
        expect(await page.evaluate(() => document.activeElement.textContent)).toBe(
            'Retirer le périmètre'
        );
        const styles = await page.evaluate(() => {
            const b = document.querySelector('.uif-btn-primary');
            const bd = document.querySelector('.uif-backdrop');
            const root = getComputedStyle(document.documentElement);
            return {
                bg: getComputedStyle(b).backgroundColor,
                brand: root.getPropertyValue('--brand').trim(),
                z: getComputedStyle(bd).zIndex,
                zModal: root.getPropertyValue('--z-modal').trim(),
            };
        });
        // the brand primary of the active theme, on the modal layer
        expect(styles.z).toBe(styles.zModal);
        expect(styles.brand).not.toBe('');
        // Tab cycles inside, both ways, and never leaves the dialog
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.hasAttribute('data-no'))).toBe(
            true
        );
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.hasAttribute('data-yes'))).toBe(
            true
        );
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => document.activeElement.hasAttribute('data-no'))).toBe(
            true
        );
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => document.activeElement.hasAttribute('data-yes'))).toBe(
            true
        );
        expect(await page.evaluate(() => !!document.activeElement.closest('.uif-modal'))).toBe(
            true
        );
        await page.keyboard.press('Escape');
        expect(await resultP).toBe(false);
        expect(await page.locator('.uif-modal').count()).toBe(0);
        expect(await page.evaluate(() => document.activeElement.id)).toBe('opener');
        await ctx.close();
    });

    test('the verb button resolves true; a destructive dialog opens on CANCEL; a backdrop click cancels', async () => {
        const { ctx, page } = await fresh();
        let p = page.evaluate(() =>
            window.confirmDialog({
                title: 'T',
                body: 'B',
                confirmLabel: 'Supprimer le plan',
                danger: true,
            })
        );
        await page.locator('.uif-modal').waitFor();
        expect(await page.evaluate(() => document.activeElement.hasAttribute('data-no'))).toBe(
            true
        );
        expect(await page.locator('.uif-btn-danger').textContent()).toBe('Supprimer le plan');
        await page.click('[data-yes]');
        expect(await p).toBe(true);
        p = page.evaluate(() => window.confirmDialog('legacy message', { confirmText: 'Envoyer' }));
        await page.locator('.uif-modal').waitFor();
        expect(await page.locator('.uif-modal p').textContent()).toBe('legacy message');
        expect(await page.locator('[data-yes]').textContent()).toBe('Envoyer');
        await page.mouse.click(5, 5); // backdrop
        expect(await p).toBe(false);
        await ctx.close();
    });

    test('verb-first: « OK », « Oui », « yes » are refused and replaced by the default verb', async () => {
        const { ctx, page, warnings } = await fresh();
        for (const bad of ['OK', 'Oui', 'yes']) {
            const p = page.evaluate(
                (l) => window.confirmDialog({ title: 'T', body: 'B', confirmLabel: l }),
                bad
            );
            await page.locator('.uif-modal').waitFor();
            expect(await page.locator('[data-yes]').textContent()).toBe('Confirmer');
            await page.keyboard.press('Escape');
            await p;
        }
        expect(warnings.filter((w) => /verb-first/.test(w)).length).toBe(3);
        const p = page.evaluate(() =>
            window.confirmDialog({ title: 'T', body: 'B', confirmLabel: 'Archiver la campagne' })
        );
        await page.locator('.uif-modal').waitFor();
        expect(await page.locator('[data-yes]').textContent()).toBe('Archiver la campagne');
        await page.keyboard.press('Escape');
        await p;
        // the prompt's action button too: no bare « OK » by default
        const q = page.evaluate(() => window.promptDialog('Pourquoi ?', '', { required: true }));
        await page.locator('.uif-modal input').waitFor();
        expect(await page.locator('[data-yes]').textContent()).toBe('Confirmer');
        await page.keyboard.press('Escape');
        expect(await q).toBeNull();
        await ctx.close();
    });

    test('reason:true asks a required reason with a real label and resolves the text', async () => {
        const { ctx, page } = await fresh();
        let p = page.evaluate(() =>
            window.confirmDialog({
                title: 'Retirer',
                body: 'Pourquoi ?',
                confirmLabel: 'Retirer le périmètre',
                reason: true,
            })
        );
        await page.locator('.uif-modal textarea').waitFor();
        expect(await page.locator('[data-yes]').isDisabled()).toBe(true);
        expect(await page.locator('.uif-modal label').getAttribute('for')).toBe(
            await page.locator('.uif-modal textarea').getAttribute('id')
        );
        expect(await page.locator('.uif-modal textarea').getAttribute('aria-required')).toBe(
            'true'
        );
        await page.keyboard.type('Site fermé');
        expect(await page.locator('[data-yes]').isDisabled()).toBe(false);
        await page.click('[data-yes]');
        expect(await p).toBe('Site fermé');
        p = page.evaluate(() =>
            window.confirmDialog({ title: 'R', body: 'B', confirmLabel: 'Retirer', reason: true })
        );
        await page.locator('.uif-modal textarea').waitFor();
        await page.keyboard.press('Escape');
        expect(await p).toBeNull();
        await ctx.close();
    });

    test('toast: both argument orders, icon + spoken kind, the toast layer, errors persist', async () => {
        const { ctx, page } = await fresh();
        await page.evaluate(() => {
            window.toast('success', 'Enregistré');
            window.toast('Enregistré aussi', 'success');
            window.toast('error', 'Échec');
        });
        await page.waitForTimeout(50);
        const info = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.uif-toast')).map((t) => ({
                type: t.getAttribute('data-type'),
                msg: t.querySelector('.uif-msg').lastChild.textContent,
                sr: t.querySelector('.uif-sr').textContent,
                icon: !!t.querySelector('.uif-ic'),
                role: t.getAttribute('role'),
            }))
        );
        expect(info.map((i) => [i.type, i.msg])).toEqual([
            ['success', 'Enregistré'],
            ['success', 'Enregistré aussi'],
            ['error', 'Échec'],
        ]);
        expect(info[0].sr).toBe('Succès : ');
        expect(info[2].sr).toBe('Erreur : ');
        expect(info[2].role).toBe('alert');
        expect(info.every((i) => i.icon)).toBe(true);
        const layer = await page.evaluate(() => [
            getComputedStyle(document.getElementById('uifToasts')).zIndex,
            getComputedStyle(document.documentElement).getPropertyValue('--z-toast').trim(),
            document.getElementById('uifToasts').getAttribute('aria-live'),
        ]);
        expect(layer[0]).toBe(layer[1]);
        expect(layer[2]).toBe('polite');
        expect(await page.locator('.uif-toast button.uif-x[aria-label]').count()).toBe(3);
        await page.waitForTimeout(3900);
        expect(await page.locator('.uif-toast').count()).toBe(1); // only the error remains
        expect(await page.locator('.uif-toast').getAttribute('data-type')).toBe('error');
        await ctx.close();
    });

    test('prefers-reduced-motion: nothing auto-dismisses', async () => {
        const { ctx, page } = await fresh({ context: { reducedMotion: 'reduce' } });
        expect(
            await page.evaluate(() => [window.MOTION.reduce, window.MOTION.autoDismiss(3500)])
        ).toEqual([true, 0]);
        await ctx.close();
    });

    test('light theme: the dialog surface and primary follow the light tokens', async () => {
        const { ctx, page } = await fresh({ theme: 'light' });
        const p = page.evaluate(() =>
            window.confirmDialog({ title: 'T', body: 'B', confirmLabel: 'Valider la demande' })
        );
        await page.locator('.uif-modal').waitFor();
        const s = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const probe = document.createElement('div');
            probe.style.background = root.getPropertyValue('--brand');
            probe.style.color = root.getPropertyValue('--bg-elevated');
            document.body.appendChild(probe);
            const want = getComputedStyle(probe);
            return {
                bg: getComputedStyle(document.querySelector('.uif-btn-primary')).backgroundColor,
                wantBg: want.backgroundColor,
                surface: getComputedStyle(document.querySelector('.uif-modal')).backgroundColor,
                wantSurface: want.color,
            };
        });
        expect(s.bg).toBe(s.wantBg);
        expect(s.surface).toBe(s.wantSurface);
        await page.keyboard.press('Escape');
        await p;
        await ctx.close();
    });
});
