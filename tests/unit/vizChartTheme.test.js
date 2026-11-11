'use strict';
/**
 * public/js/chart-theme.js, the data-visualisation half:
 *   - colours bound to the CATEGORY key, never to an array position;
 *   - status colours fixed, in the order ready · partial · not ready · not
 *     assessed; the KPI module's English codes map onto them;
 *   - changes coloured by polarity (worse = amber, never the risk red); an
 *     unknown status is never green and never red;
 *   - ONE observer re-renders every Chart.js instance from the tokens when the
 *     mode, the colour theme or the language changes;
 *   - the page's number locale, reduced motion, an empty state built with DOM
 *     nodes (a message is text, never markup).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CT = require('../../public/js/chart-theme');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/js/chart-theme.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../../public/css/viz.css'), 'utf8');

describe('colorFor / colorsFor — bound to the category key', () => {
    test('the same key has the same colour whatever its position or neighbours', () => {
        expect(CT.colorsFor(['Site A', 'Site B', 'Site C'], 'dark')).toEqual(
            CT.colorsFor(['Site C', 'Site A', 'Site B'], 'dark')
        );
    });
    test('distinct keys of one chart never share a colour (up to 6)', () => {
        const cols = Object.values(
            CT.colorsFor(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'], 'light')
        );
        expect(new Set(cols).size).toBe(6);
    });
    test('a 7th free category is neutral ("Others"), never a recycled colour', () => {
        const vals = Object.values(CT.colorsFor(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'dark'));
        expect(vals.filter((c) => c === CT.VIZ_FALLBACK.dark.neutral)).toHaveLength(1);
    });
    test('role keys are fixed: focus, org / reference = neutral, target', () => {
        expect(CT.colorFor('focus', 'light')).toBe(CT.VIZ_FALLBACK.light.focus);
        expect(CT.colorFor('org', 'dark')).toBe(CT.VIZ_FALLBACK.dark.neutral);
        expect(CT.colorFor('target', 'dark')).toBe(CT.VIZ_FALLBACK.dark.target);
    });
    test('registerCategories pins a key to a slot app-wide', () => {
        CT.registerCategories({ Stonebridge: 4 });
        expect(CT.colorFor('stonebridge', 'light')).toBe(CT.VIZ_FALLBACK.light.cat4);
    });
    test('a key such as "__proto__" is an ordinary category', () => {
        const out = CT.colorsFor(['__proto__', 'constructor'], 'light');
        expect(Object.keys(out).sort()).toEqual(['__proto__', 'constructor']);
        expect({}.polluted).toBeUndefined();
    });
    test('a free category is never the risk red', () => {
        for (let i = 0; i < 200; i++)
            expect(CT.colorFor('k' + i, 'light')).not.toBe(CT.VIZ_FALLBACK.light.risk);
    });
});

describe('status colours and order', () => {
    test('fixed order ready · partial · not ready · not assessed', () => {
        expect(CT.STATUS_ORDER).toEqual(['ready', 'partial', 'not_ready', 'unassessed']);
        expect(CT.sortByStatus(['not_assessed', 'Not ready', 'ready', 'partial'])).toEqual([
            'ready',
            'partial',
            'Not ready',
            'not_assessed',
        ]);
    });
    test('the KPI module codes and the French labels map onto the tones', () => {
        const L = CT.VIZ_FALLBACK.light;
        expect(CT.statusColor('compliant', 'light')).toBe(L.good);
        expect(CT.statusColor('watch', 'light')).toBe(L.warn);
        expect(CT.statusColor('at_risk', 'light')).toBe(L.risk);
        expect(CT.statusColor('not_measured', 'light')).toBe(L.unmeasured);
        expect(CT.statusColor('Non évalué', 'light')).toBe(L.unmeasured);
        expect(CT.statusColor('NOT_READY', 'light')).toBe(L.risk);
        expect(CT.statusMeta('unassessed').hatch).toBe(true);
        expect(CT.statusMeta('partial', 'en').label).toBe('Partially assessed');
    });
    test('an unknown or absent status is neutral — never green, never red', () => {
        for (const s of [null, undefined, '', 'whatever', '__proto__'])
            expect(CT.statusColor(s, 'dark')).toBe(CT.VIZ_FALLBACK.dark.neutral);
    });
    test('every status chip carries text and an icon', () => {
        for (const s of [
            'good',
            'warn',
            'risk',
            'unmeasured',
            'ready',
            'partial',
            'not_ready',
            'unassessed',
        ]) {
            const m = CT.statusMeta(s, 'fr');
            expect(m.icon).toBeTruthy();
            expect(m.label).toBeTruthy();
        }
    });
    test('bands: 80 / 50, safety 100 / 95, null ⇒ unmeasured (never a failing band)', () => {
        expect(CT.bandStatus(80)).toBe('good');
        expect(CT.bandStatus(79.9)).toBe('warn');
        expect(CT.bandStatus(49.9)).toBe('risk');
        expect(CT.bandStatus(0)).toBe('risk');
        for (const v of [null, undefined, '', true]) expect(CT.bandStatus(v)).toBe('unmeasured');
        expect(CT.bandStatus(97, { good: 100, warn: 95 })).toBe('warn');
    });
});

describe('changes coloured by polarity, not direction', () => {
    test('higher-better: up = better; lower-better: up = worse', () => {
        expect(CT.deltaTone(3.2, 'higher_better')).toBe('better');
        expect(CT.deltaTone(-3.2, 'higher_better')).toBe('worse');
        expect(CT.deltaTone(3, 'lower_better')).toBe('worse');
        expect(CT.deltaTone(0.01)).toBe('neutral');
        expect(CT.deltaTone(null)).toBeNull();
    });
    test('a worse change is amber, never the risk red', () => {
        const L = CT.VIZ_FALLBACK.light;
        expect(CT.deltaColor(-5, 'higher_better', 'light')).toBe(L.warn);
        expect(CT.deltaColor(5, 'higher_better', 'light')).toBe(L.good);
    });
});

test('percentage ticks follow the page language (French in node)', () => {
    expect(CT.pctTick(80)).toBe('80 %');
    expect(CT.pctTick(12.5)).toBe('12,5 %');
});

// ---- a minimal browser: <html data-theme>, getComputedStyle from viz.css, a Chart stub ----
function cssBlock(selector) {
    const i = CSS.indexOf(selector + ' {');
    const out = {};
    for (const d of CSS.slice(i, CSS.indexOf('}', i)).matchAll(
        /(--viz-[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g
    ))
        out[d[1]] = d[2];
    return out;
}
const THEME_VARS = {
    dark: { ...cssBlock(':root'), '--text-primary': '#F2F1FA', '--text-secondary': '#C4C2DA' },
    light: {
        ...cssBlock(":root[data-theme='light']"),
        '--text-primary': '#1F1D3A',
        '--text-secondary': '#514F6B',
    },
};

function makeBrowser({ reduce = false, lang = 'fr' } = {}) {
    const attrs = { lang };
    const observers = [];
    let created = 0;
    const html = {
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        setAttribute: (k, v) => {
            attrs[k] = String(v);
            observers.forEach((cb) => cb([{ attributeName: k }]));
        },
        removeAttribute: (k) => {
            delete attrs[k];
            observers.forEach((cb) => cb([{ attributeName: k }]));
        },
    };
    const theme = () => (attrs['data-theme'] === 'light' ? 'light' : 'dark');
    const win = {
        document: {
            documentElement: html,
            createElement: () => ({ getContext: () => null }),
            dispatchEvent: () => true,
        },
        getComputedStyle: () => ({ getPropertyValue: (n) => THEME_VARS[theme()][n] || '' }),
        MutationObserver: function MO(cb) {
            created++;
            this.observe = () => observers.push(cb);
        },
        requestAnimationFrame: (fn) => fn(),
        matchMedia: () => ({ matches: reduce, addEventListener: () => {} }),
        CustomEvent: function CE(type, init) {
            this.type = type;
            this.detail = init && init.detail;
        },
        setTimeout,
    };
    win.window = win;
    win.Chart = {
        defaults: {
            font: {},
            animation: { duration: 1000 },
            plugins: { tooltip: {}, legend: { labels: {} } },
            elements: { line: {}, point: {}, bar: {}, arc: {} },
        },
        instances: {},
    };
    return { win, html, load: () => vm.runInNewContext(SRC, win), observersCreated: () => created };
}

describe('a theme switch re-renders every chart from the tokens', () => {
    test('a chart that did not register: token colours remapped (alpha kept), update() called', () => {
        const b = makeBrowser();
        b.load();
        const T = b.win.ChartTheme;
        const darkGood = T.viz.good;
        const legacy = {
            canvas: {},
            config: {
                data: {
                    datasets: [
                        {
                            backgroundColor: [darkGood, '#123456'],
                            borderColor: T.alpha(T.viz.cat1, 0.2),
                        },
                    ],
                },
                options: { scales: { x: { ticks: { color: T.viz.textDim } } } },
            },
            options: {},
            update: jest.fn(),
        };
        b.win.Chart.instances = { 1: legacy };
        b.html.setAttribute('data-theme', 'light');
        const L = CT.VIZ_FALLBACK.light;
        const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16)).join(', ');
        expect(legacy.update).toHaveBeenCalledWith('none');
        expect(legacy.config.data.datasets[0].backgroundColor[0]).toBe(`rgb(${rgb(L.good)})`);
        expect(legacy.config.data.datasets[0].backgroundColor[1]).toBe('#123456');
        expect(legacy.config.data.datasets[0].borderColor).toBe(`rgba(${rgb(L.cat1)}, 0.2)`);
        expect(b.win.Chart.defaults.color).toBe('#514F6B');
        expect(T.theme()).toBe('light');
    });
    test('a registered chart is rebuilt by its own callback; a palette change refreshes too', () => {
        const b = makeBrowser();
        b.load();
        const T = b.win.ChartTheme;
        const chart = {
            canvas: {},
            config: { data: { datasets: [] } },
            options: {},
            update: jest.fn(),
        };
        const seen = [];
        T.register(chart, () => seen.push(T.viz.focus));
        b.win.Chart.instances = { 7: chart };
        b.html.setAttribute('data-theme', 'light');
        b.html.setAttribute('data-palette', 'ocean');
        expect(seen).toEqual([CT.VIZ_FALLBACK.light.focus, CT.VIZ_FALLBACK.light.focus]);
        b.html.removeAttribute('data-theme');
        expect(seen[2]).toBe(CT.VIZ_FALLBACK.dark.focus);
        expect(T.all()).toContain(chart);
    });
    test('ONE observer even when the file is included twice; the first instance is kept', () => {
        const b = makeBrowser();
        b.load();
        const first = b.win.ChartTheme;
        b.load();
        expect(b.observersCreated()).toBe(1);
        expect(b.win.ChartTheme).toBe(first);
    });
    test('motion is merged into the default animation; reduced motion ⇒ none', () => {
        const a = makeBrowser();
        a.load();
        expect(a.win.Chart.defaults.animation.duration).toBe(400);
        const r = makeBrowser({ reduce: true });
        r.load();
        expect(r.win.Chart.defaults.animation).toBe(false);
        expect(r.win.Chart.defaults.animations).toBe(false);
    });
    test('the Chart.js number locale follows the page language; text never under 12 px', () => {
        const fr = makeBrowser();
        fr.load();
        expect(fr.win.Chart.defaults.locale).toBe('fr-FR');
        expect(fr.win.Chart.defaults.font.size).toBeGreaterThanOrEqual(12);
        const en = makeBrowser({ lang: 'en' });
        en.load();
        expect(en.win.Chart.defaults.locale).toBe('en-GB');
    });
});

test('the empty state is built with DOM nodes: its message is text, never markup', () => {
    expect(SRC).not.toMatch(/innerHTML|insertAdjacentHTML/);
    expect(SRC).toMatch(/span\.textContent = String\(message \|\| dflt\)/);
});
