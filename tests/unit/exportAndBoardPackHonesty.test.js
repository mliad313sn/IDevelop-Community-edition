'use strict';

/**
 * (27) The board pack listed 25 sole-holder skills of 181 and then told the
 *      board to "Open a succession plan for the sole-holder skills listed
 *      above". A board acting on that addressed 14 % of the exposure believing
 *      it had covered all of it. The true total was already in the payload
 *      (keyPersonSummary.soleHolder = 181) and simply was not used.
 *
 *      The table stays capped — it is a printed document — but it now says
 *      what it is showing and of how many, and the action names the total.
 *
 * (30) organization_export.csv wrote its section markers raw. They begin with
 *      '=', so Excel treated "=== SITES ===" as a formula: the file could not
 *      be opened, corrected and saved back without mangling the markers this
 *      export's OWN re-import path matches on. The data cells already went
 *      through csvCell; the markers did not. It also had no UTF-8 BOM and no
 *      `sep=,` hint, so fr-FR Excel split on ';' and dropped every row into
 *      column A, with accented names mojibaked.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { csvCell } = require('../../src/utils/csvSafe');

describe('27 — the board pack says what it is showing', () => {
    const view = read('views/pages/exec/board-pack.ejs');

    test('the sole-holder table declares the truncation with the real total', () => {
        expect(view).toMatch(/KP\.length < KPS\.soleHolder/);
        expect(view).toMatch(/exec:kp_truncated/);
        expect(view).toMatch(/replace\('\{shown\}', KP\.length\)/);
        expect(view).toMatch(/replace\('\{total\}', KPS\.soleHolder\)/);
    });

    test('the action names the total, not "the skills listed above"', () => {
        expect(view).toMatch(/bp_action_bench'\)\.replace\('\{n\}'/);
        for (const lang of ['fr', 'en']) {
            const d = JSON.parse(read(`locales/${lang}/exec.json`));
            expect(d.bp_action_bench).toMatch(/\{n\}/);
            expect(d.kp_truncated).toMatch(/\{shown\}/);
            expect(d.kp_truncated).toMatch(/\{total\}/);
        }
        // the old wording promised completeness — it must be gone
        expect(JSON.parse(read('locales/en/exec.json')).bp_action_bench).not.toMatch(
            /listed above/i
        );
    });

    test('the cap itself is unchanged — this is a print document, not a data feed', () => {
        const ctrl = read('src/controllers/ExecDecisionController.js').replace(/\s+/g, ' ');
        expect(ctrl).toMatch(/band: 'sole_holder', limit: 25/);
    });

    test('F2 — every trend date is locale-formatted through d(), never raw ISO', () => {
        // The trend caption, the from/to line and the recorded-history table all
        // print the snapshot date; each must go through the same d() helper the
        // "generated on" line uses, not the bare ISO string.
        expect(view).toMatch(/replace\('\{a\}', d\(SERIES\[0\]\.date\)\)/);
        expect(view).toMatch(
            /replace\('\{a\}', d\(a\.date\)\)[\s\S]*replace\('\{b\}', d\(b\.date\)\)/
        );
        expect(view).toMatch(/<td><%= d\(p\.date\) %><\/td>/);
        // no raw .date interpolation survives in the trend block
        expect(view).not.toMatch(/replace\('\{a\}', SERIES\[0\]\.date\)/);
        expect(view).not.toMatch(/<td><%= p\.date %><\/td>/);
    });
});

describe('30 — the organization export is safe to open and still re-imports', () => {
    const ctrl = read('src/controllers/DataManagementController.js');

    test('section markers go through csvCell like every data cell', () => {
        expect(ctrl).toMatch(/const section = \(name\) => csvCell\(name\)/);
        expect(ctrl).toMatch(/csvLines\.push\(section\('=== SITES ==='\)\)/);
        expect(ctrl).toMatch(/csvLines\.push\(section\('=== DEPARTMENTS ==='\)\)/);
        expect(ctrl).toMatch(/csvLines\.push\(section\('=== SERVICES ==='\)\)/);
        // and none is pushed raw any more
        expect(ctrl).not.toMatch(/csvLines\.push\('=== SITES ==='\)/);
    });

    test('it carries the BOM, the separator hint and a charset', () => {
        // The controller writes the BOM as a literal U+FEFF, the same way
        // MovementController does. Match it with the ESCAPE, never by pasting
        // the character into this file: eslint's no-irregular-whitespace
        // rejects a literal U+FEFF in source, which is how this assertion made
        // the pre-commit hook refuse the whole commit.
        expect(ctrl).toMatch(/const csv = '\uFEFF' \+ 'sep=,\\r\\n'/);
        expect(ctrl).toMatch(/'text\/csv; charset=utf-8'/);
    });

    test('the neutralised marker is still what the importer matches on', () => {
        // csvCell prefixes an apostrophe; the importer uses includes(), so the
        // marker survives. If csvCell ever changed to strip or rewrite the
        // text, this export would stop round-tripping silently.
        const marker = csvCell('=== SITES ===');
        expect(marker).not.toMatch(/^=/); // no longer a formula
        expect(marker.includes('=== SITES ===')).toBe(true); // still matchable
    });

    test('a formula in a data cell is neutralised and an accent survives', () => {
        expect(csvCell('=SUM(A1)')).not.toMatch(/^"?=/);
        expect(csvCell('Lambért')).toContain('Lambért');
    });

    test('the full round-trip: export shape in, importer shape out', () => {
        const lines = [];
        const section = (n) => csvCell(n);
        lines.push(section('=== SITES ==='));
        lines.push('Name,Code,Description');
        lines.push(['Lambért', '=SUM(A1)', 'ok'].map(csvCell).join(','));
        lines.push('');
        lines.push(section('=== DEPARTMENTS ==='));
        lines.push('Site Name,Name,Code,Description');
        lines.push(['Lambért', 'IT', '', 'x'].map(csvCell).join(','));
        const csv = '\uFEFF' + 'sep=,\r\n' + lines.join('\r\n');

        // the importer's own loop, transcribed
        const data = { sites: [], departments: [] };
        let cur = null;
        let skip = false;
        for (const line of csv.split('\n').filter((l) => l.trim())) {
            if (line.includes('=== SITES ===')) {
                cur = 'sites';
                skip = true;
                continue;
            }
            if (line.includes('=== DEPARTMENTS ===')) {
                cur = 'departments';
                skip = true;
                continue;
            }
            if (line.startsWith('===') || !line.trim()) continue;
            if (skip) {
                skip = false;
                continue;
            }
            if (cur) data[cur].push(line.trim());
        }
        expect(data.sites).toHaveLength(1);
        expect(data.departments).toHaveLength(1);
        // the sep= hint and BOM fell through harmlessly, as designed
        expect(data.sites[0]).toContain('Lambért');
    });
});
