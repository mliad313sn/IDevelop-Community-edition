'use strict';

/**
 * D4 — several CSV exports shipped without a UTF-8 BOM, so Excel opened accented
 * French names as mojibake ("Morèn" → "KonÃ©").
 *
 * The shared csvResponse()/excelCsv() helpers and the org-export and movements
 * exports already prepend U+FEFF; the benchmark matrix, the local-content export
 * and four data-management exports built the CSV by hand and sent it raw. Each now
 * prepends the BOM, matching the rest of the product.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const BOM = '﻿';

describe('every CSV export carries a UTF-8 BOM (D4)', () => {
    test('the benchmark matrix export prepends the BOM', () => {
        const src = read('src/controllers/BenchmarkController.js');
        expect(src).toContain(`res.send('${BOM}' + lines.join`);
        expect(src).not.toMatch(/res\.send\(lines\.join\('\\r\\n'\)\)/);
    });

    test('the local-content export prepends the BOM', () => {
        const src = read('src/controllers/LocalContentController.js');
        expect(src).toContain(`res.send('${BOM}' + lines.join`);
    });

    test('every data-management CSV variable starts with the BOM', () => {
        const src = read('src/controllers/DataManagementController.js');
        const csvVars = (src.match(/const csv =/g) || []).length;
        const bommed = (src.match(new RegExp(BOM, 'g')) || []).length;
        expect(csvVars).toBeGreaterThan(0);
        // one BOM per CSV variable (the org export already had one)
        expect(bommed).toBe(csvVars);
    });

    test('the movements export still has its BOM (guard against regression)', () => {
        expect(read('src/controllers/MovementController.js')).toContain(`res.send('${BOM}'`);
    });
});
