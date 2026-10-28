'use strict';
/**
 * The two partials of the dashboard's data-visualisation layer, rendered with
 * the real locale files and the real number formatter (tests/helpers/vizRender):
 *   kpi-tile   value, status chip (icon + word), « of N », movement with its
 *              polarity, sparkline (≥ 3 points, a null is a gap), list link
 *              with its count; « Not measured » hatched, never 0, never green
 *              or red, never a movement; fewer than 5 people « 2 of 3 », no %;
 *              an empty state replaces the value; English formats;
 *   scope-bar  « You are viewing: … · N people · coverage », coverage not
 *              measured in words (never 0 %), amber below half (never red), a
 *              plain GET form offered only when there is a choice, the choice
 *              remembered for the account (said on the page).
 * No inline handler (CSP) anywhere.
 */
const { render } = require('../helpers/vizRender');

const tile = (k, lang = 'fr') => render('views/partials/kpi-tile.ejs', { vizKpi: k }, lang);
const scope = (s, lang = 'fr') => render('views/partials/scope-bar.ejs', { vizScope: s }, lang);
const text = (html) =>
    html
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t\r\n]+/g, ' ')
        .trim();
const INLINE_HANDLER = /\son[a-z]+\s*=/i;

describe('kpi-tile', () => {
    const base = {
        id: 'kpi-k1',
        label: 'Taux de préparation au poste',
        value: 63.2,
        unit: 'pct',
        numerator: 36,
        denominator: 57,
        status: 'warn',
        delta: 3.24,
        sparkline: [58, 61, 63.2],
        drillHref: '/dashboard/list?kpi=K1&part=not_ready',
        drillLabel: 'Voir qui n’est pas prêt',
        drillCount: 21,
        glossaryHref: '/kpi/glossary#K1',
        sub: 'sur 57 personnes avec un verdict',
    };

    test('value, chip with icon and word, movement, sparkline, list link with its count', () => {
        const html = tile(base);
        const t = text(html);
        expect(html).toMatch(/<article class="viz-kpi viz-kpi--warn" id="kpi-k1">/);
        expect(t).toContain('63,2 %');
        expect(html).toMatch(
            /viz-chip viz-chip--warn[\s\S]*?aria-hidden="true">!<[\s\S]*?À surveiller/
        );
        expect(t).toContain('sur 57 personnes avec un verdict');
        expect(html).toMatch(/class="viz-delta viz-delta--better"[^>]*>\+3,2 pts</);
        expect(html).toMatch(/<svg class="viz-kpi-spark"[^>]*role="img"/);
        expect(html).toContain('href="/dashboard/list?kpi=K1&amp;part=not_ready"');
        expect(t).toContain('Voir qui n’est pas prêt (21)');
        expect(html).toContain('href="/kpi/glossary#K1"');
        expect(html).not.toMatch(INLINE_HANDLER);
    });

    test('nothing measured ⇒ « Not measured » hatched: no %, no 0, no movement, no green or red', () => {
        const html = tile({
            ...base,
            value: null,
            numerator: null,
            denominator: null,
            status: 'good',
            delta: 2,
            sparkline: null,
        });
        const t = text(html);
        expect(t).toContain('Pas encore mesuré');
        expect(html).toContain('viz-kpi-value--unmeasured');
        expect(html).toContain('viz-hatch');
        expect(html).not.toMatch(/viz-chip--(good|warn|risk)/);
        expect(html).not.toContain('viz-delta');
        expect(t.replace('(21)', '')).not.toMatch(/%|\b0\b/);
    });

    test('a denominator of 0 is « Not measured » even if 0 is passed (never « 0 of 0 »)', () => {
        const html = tile({
            ...base,
            value: 0,
            numerator: 0,
            denominator: 0,
            status: 'risk',
            drillHref: null,
        });
        expect(text(html)).toContain('Pas encore mesuré');
        expect(text(html)).not.toMatch(/0 sur 0|\b0\b/);
        expect(html).not.toContain('viz-chip--risk');
    });

    test('fewer than 5 people ⇒ « 2 sur 3 », the small-n note, no %, chip, movement or sparkline', () => {
        const html = tile({ ...base, value: null, numerator: 2, denominator: 3, delta: 5 });
        const t = text(html);
        expect(t).toContain('2 sur 3');
        expect(t).toContain('Moins de 5 personnes');
        expect(t.replace(/\(21\)/, '')).not.toContain('%');
        expect(html).not.toContain('viz-chip');
        expect(html).not.toContain('viz-delta');
        expect(html).not.toContain('viz-kpi-spark');
    });

    test('movement: none when null (never « +0 »); lower-better rise = worse; counts are whole', () => {
        expect(tile({ ...base, delta: null })).not.toContain('viz-delta');
        const lb = tile({
            ...base,
            unit: 'count',
            value: 7,
            numerator: null,
            denominator: null,
            delta: 4,
            polarity: 'lower_better',
            status: 'risk',
        });
        expect(lb).toMatch(/viz-delta--worse[^>]*>\+4</);
        const down = tile({
            ...base,
            unit: 'count',
            value: 3,
            numerator: null,
            denominator: null,
            delta: -2,
            polarity: 'lower_better',
            status: 'risk',
        });
        expect(down).toMatch(/viz-delta--better[^>]*>−2</);
    });

    test('sparkline: only with ≥ 3 numeric points; a null is a gap', () => {
        expect(tile({ ...base, sparkline: [60, null, 61] })).not.toContain('viz-kpi-spark');
        const gap = tile({ ...base, sparkline: [60, 61, null, 62, 63] });
        expect((gap.match(/<polyline/g) || []).length).toBe(2);
    });

    test('an empty state replaces the value (not configured)', () => {
        const html = tile({
            id: 'kpi-k8',
            label: 'Habilitations',
            value: null,
            emptyState: { state: 'not_configured', message: 'Non paramétré' },
        });
        expect(text(html)).toContain('Non paramétré');
        expect(html).toContain('data-viz-empty="not_configured"');
        expect(html).not.toContain('viz-kpi-value');
    });

    test('extra counts and English formats', () => {
        const html = tile(
            {
                ...base,
                value: 1234.5,
                unit: 'num',
                decimals: 1,
                denominator: null,
                extra: [
                    { label: 'Not assessed', value: 12 },
                    { label: 'Partial', value: null },
                ],
            },
            'en'
        );
        const t = text(html);
        expect(t).toContain('1,234.5');
        expect(t).toContain('Not assessed 12');
        expect(t).toContain('Partial Not measured yet');
        expect(t).toContain('How is it calculated?');
    });
});

describe('scope-bar', () => {
    test('« Vous voyez : … · N personnes · couverture » with no inline handler', () => {
        const html = scope({
            scopeLabel: 'Site Nord',
            people: 1234,
            coverage: 64,
            asOf: '2026-10-02',
        });
        const t = text(html);
        expect(t).toContain('Vous voyez : Site Nord');
        expect(t).toContain('1 234 personnes');
        expect(t).toContain('64,0 % des compétences exigées évaluées à ce jour');
        expect(html).not.toContain('viz-chip--warn');
        expect(html).not.toMatch(INLINE_HANDLER);
    });

    test('coverage not measured is said in words (never 0 %); below half is amber, never red', () => {
        const un = text(scope({ scopeLabel: 'Mon équipe', people: 1, coverage: null }));
        expect(un).toContain('compétences évaluées : pas encore mesuré');
        expect(un).toContain('1 personne');
        expect(un).not.toMatch(/0\s*%/);
        const low = scope({ scopeLabel: 'Mon équipe', people: 12, coverage: 42 });
        expect(low).toContain('viz-chip--warn');
        expect(text(low)).toContain('Moins de la moitié évaluée');
        expect(low).not.toContain('viz-chip--risk');
    });

    test('the form is a plain GET, offered only when there is a choice, and says where it is kept', () => {
        const one = scope({
            scopeLabel: 'Tout mon périmètre',
            people: 9,
            coverage: 80,
            form: {
                action: '/dashboard',
                sites: [{ id: 1, name: 'Nord' }],
                departments: [{ id: 3, label: 'Ops', siteId: 1 }],
                noSite: false,
            },
        });
        expect(one).not.toContain('<form');
        const two = scope({
            scopeLabel: 'Tout mon périmètre',
            people: 9,
            coverage: 80,
            form: {
                action: '/dashboard',
                sites: [
                    { id: 1, name: 'Nord' },
                    { id: 2, name: 'Sud' },
                ],
                departments: [],
                noSite: true,
                site: 2,
                keep: { tab: 'safety' },
            },
        });
        expect(two).toMatch(/<form method="get" action="\/dashboard"/);
        expect(two).toMatch(/<option value="2" selected>Sud<\/option>/);
        expect(two).toMatch(/<option value="none">Sans site<\/option>/);
        expect(two).toMatch(/<input type="hidden" name="tab" value="safety">/);
        expect(text(two)).toContain(
            'Votre choix est mémorisé pour votre compte, pas sur cet ordinateur.'
        );
        expect(two).not.toMatch(INLINE_HANDLER);
    });

    test('English', () => {
        const t = text(scope({ scopeLabel: 'All of my scope', people: 2, coverage: 80.25 }, 'en'));
        expect(t).toContain('You are viewing: All of my scope');
        expect(t).toContain('2 people');
        expect(t).toContain('80.3% of required skills assessed to date');
    });
});
