'use strict';

/**
 * Re-audit L2 — a French-first product still shipped English literals in several
 * JS-rendered dashboard surfaces (the filter "All", the employee pager, the
 * benchmark/heatmap table tooltips and header, the PIP/IDP/coaching action-board
 * list) and in the talent-actions table (raw `kind` / `contextType` enums). These
 * now go through I18N (with an English fallback) or the shared enumLabel, and each
 * new key exists in BOTH locales.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const js = read('public/js/dashboard.js');
const en = JSON.parse(read('locales/en/dash.json'));
const fr = JSON.parse(read('locales/fr/dash.json'));

describe('L2 — the dashboard strings are localized, not hardcoded English', () => {
    test('the surfaced literals now read from I18N', () => {
        expect(js).toMatch(/esc\(I18N\.filterAll \|\| 'All'\)/);
        expect(js).toMatch(/I18N\.pagerPrev \|\| '« Prev'/);
        expect(js).toMatch(/I18N\.pagerNext \|\| 'Next »'/);
        expect(js).toMatch(/I18N\.heatmapDomain \|\| 'Domain'/);
        expect(js).toMatch(/I18N\.chartHeadcount \|\| 'Headcount'/);
        expect(js).toMatch(/I18N\.pipeAwaitingPip \|\| 'PIPs awaiting activation'/);
        expect(js).toMatch(
            /esc\(I18N\.tipCoverageShare \|\| 'Share of required skills assessed'\)/
        );
    });

    test('the raw English is gone from those spots', () => {
        expect(js).not.toMatch(/'<option value="">All<\/option>'/);
        expect(js).not.toMatch(/>Next »<\/button>`/);
        expect(js).not.toMatch(/<th>Domain<\/th>/);
        expect(js).not.toMatch(/label: 'Headcount'/);
        expect(js).not.toMatch(/\{ label: 'PIPs awaiting activation'/);
    });

    test('the talent-actions table labels its enums, not the raw value', () => {
        const ta = read('views/pages/talent/actions.ejs');
        expect(ta).toMatch(/<td><%= enumLabel\(c\.kind\) %><\/td>/);
        expect(ta).toMatch(/<%= enumLabel\(c\.contextType\) %>/);
        expect(ta).not.toMatch(/<%= c\.kind %>/);
        expect(ta).not.toMatch(/c\.contextType\.replace\('_',' '\)/);
    });

    test('every new key is present in BOTH locales and translated', () => {
        const keys = [
            'filter_all',
            'tip_coverage_share',
            'tip_crit_occupants',
            'chart_headcount',
            'chart_employees',
            'chart_ideal_distribution',
            'pipe_awaiting_pip',
            'pipe_draft_idp',
            'pipe_coaching_not_started',
            'pipe_all_in_motion',
            'pager_total',
            'pager_prev',
            'pager_next',
            'heatmap_domain',
        ];
        for (const k of keys) {
            expect(typeof en[k]).toBe('string');
            expect(typeof fr[k]).toBe('string');
        }
        // a sample really is translated, not copied
        expect(fr.chart_headcount).toBe('Effectif');
        expect(fr.heatmap_domain).toBe('Domaine');
    });
});
