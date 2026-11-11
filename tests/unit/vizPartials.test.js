'use strict';
/**
 * The partials of the data-visualisation layer (views/partials/viz/*.ejs):
 *   - chart: a container + a JSON config block escaped by json-script (no
 *     inline code, CSP-safe), the page-language copy for the script, a server
 *     table that prints "Not measured" for a null;
 *   - scripts: same-origin files in their load order, Chart.js only when a
 *     canvas is drawn;
 *   - the layout loads viz.css; no viz partial or script carries an inline
 *     handler, an inline style attribute or a markup sink.
 */
const fs = require('fs');
const path = require('path');
const { render, read, ROOT } = require('../helpers/vizRender');

const payload = (html) =>
    JSON.parse(
        html.match(/<script type="application\/json" class="viz-config">([\s\S]*?)<\/script>/)[1]
    );

describe('viz/chart', () => {
    const vizChart = {
        id: 'c1',
        title: 'Prêts par site',
        subtitle: '42 personnes',
        config: {
            kind: 'hbar',
            labels: ['Site A', '</script><b>x</b>'],
            series: [{ key: 'k1', data: [80, null] }],
        },
        table: {
            head: ['Site', 'Prêts'],
            rows: [
                ['Site A', '80 %'],
                ['Site B', null],
            ],
        },
        footer: { source: 'KPI', glossaryHref: '/kpi/glossary#K1' },
    };
    test('a container, a JSON block escaped, the copy for the script, « Show data »', () => {
        const h = render('views/partials/viz/chart.ejs', { vizChart });
        expect(h).toMatch(
            /<figure class="viz-chart" id="c1" data-viz-chart aria-labelledby="c1-title">/
        );
        const block = h.match(/class="viz-config">([\s\S]*?)<\/script>/)[1];
        expect(block).not.toMatch(/</);
        const p = payload(h);
        expect(p.config.labels[1]).toBe('</script><b>x</b>');
        expect(p.opts.lang).toBe('fr');
        expect(p.opts.i18n.toggle_show).toBe('Voir les données');
        expect(p.opts.i18n.summary_lowest).toBe('le plus bas : {{label}}, {{value}}');
        expect(p.opts.i18n.status.risk).toBe('À risque');
        expect(h).toMatch(/<span class="viz-count" aria-hidden="true">2<\/span>/);
        expect(h).toMatch(/<a href="\/kpi\/glossary#K1">Comment est-ce calculé \?<\/a>/);
    });
    test('the server table prints "Not measured" for a null cell', () => {
        const h = render('views/partials/viz/chart.ejs', { vizChart });
        expect(h).toMatch(/<td class="viz-num viz-unmeasured-cell">Pas encore mesuré<\/td>/);
    });
    test('English copy travels to the script', () => {
        const p = payload(render('views/partials/viz/chart.ejs', { vizChart }, 'en'));
        expect(p.opts.lang).toBe('en');
        expect(p.opts.i18n.toggle_show).toBe('Show data');
        expect(p.opts.i18n.status.unassessed).toBe('Not assessed');
    });
});

describe('viz/scripts', () => {
    const srcs = (h) => [...h.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]);
    test('the load order; Chart.js only when a canvas is drawn', () => {
        expect(srcs(render('views/partials/viz/scripts.ejs', { viz: { heat: true } }))).toEqual([
            '/js/fmt.js',
            '/js/chart-theme.js',
            '/js/viz-heat.js',
        ]);
        expect(
            srcs(
                render('views/partials/viz/scripts.ejs', {
                    viz: { chart: true, radar: true, dumbbell: true, axisFit: true },
                })
            )
        ).toEqual([
            '/vendor/chart.umd.min.js',
            '/js/fmt.js',
            '/js/chart-theme.js',
            '/js/chart-axis-fit.js',
            '/js/viz.js',
            '/js/profile-radar.js',
            '/js/dumbbell.js',
        ]);
    });
});

describe('CSP and markup hygiene', () => {
    const partials = fs
        .readdirSync(path.join(ROOT, 'views/partials/viz'))
        .map((f) => 'views/partials/viz/' + f);
    const scripts = ['fmt', 'chart-theme', 'viz', 'viz-heat', 'dumbbell', 'profile-radar'].map(
        (f) => `public/js/${f}.js`
    );
    test('the layout loads viz.css after the theme layer', () => {
        const layout = read('views/layouts/main.ejs');
        expect(layout.indexOf('/css/viz.css')).toBeGreaterThan(layout.indexOf('/css/horizon.css'));
    });
    test.each(partials)('%s: no inline handler, no style attribute, no inline code', (rel) => {
        const src = read(rel);
        expect(src).not.toMatch(/\son[a-z]+=/i);
        expect(src).not.toMatch(/\sstyle="/);
        for (const m of src.matchAll(/<script\b([^>]*)>/g))
            expect(m[1]).toMatch(/type="application\/json"|src="/);
    });
    test.each(scripts)('%s: no markup sink, no eval, no string timer', (rel) => {
        const src = read(rel);
        expect(src).not.toMatch(
            /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/
        );
        expect(src).not.toMatch(/setTimeout\(\s*['"]/);
    });
    test('the heatmap follows a server-rendered link, never a URL read from an attribute', () => {
        const src = read('public/js/viz-heat.js');
        expect(src).not.toMatch(/location\.(assign|href|replace)/);
        expect(src).toMatch(/a\.vh-drill\[href\]/);
    });
});
