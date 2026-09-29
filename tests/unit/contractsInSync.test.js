'use strict';
/**
 * docs/contracts/ holds the language-neutral contracts an alternative
 * implementation builds against (see docs/ARCHITECTURE.md). They are generated
 * by `npm run contracts:export`; this guard fails when the code moves and the
 * published contract does not.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'docs', 'contracts');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const normalise = (o) => JSON.parse(JSON.stringify(o));

describe('published contracts match the code (run `npm run contracts:export` if this fails)', () => {
    test('openapi.json', () => {
        expect(read('openapi.json')).toEqual(normalise(require('../../src/api/v1/openapi')));
    });
    test('chart-identity.json', () => {
        expect(read('chart-identity.json')).toEqual(
            normalise(require('../../src/utils/branding').CHART_IDENTITY)
        );
    });
    test('product.json', () => {
        expect(read('product.json')).toEqual(normalise(require('../../src/config/product')));
    });
});
