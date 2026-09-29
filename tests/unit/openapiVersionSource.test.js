'use strict';
// The OpenAPI contract's info.version comes from ONE place — package.json, read
// through src/config/product.js — never from a hard-coded fallback literal.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('openapi info.version equals the product (package.json) version', () => {
    const spec = require('../../src/api/v1/openapi');
    const PRODUCT = require('../../src/config/product');
    const pkg = require('../../package.json');
    expect(spec.info.version).toBe(PRODUCT.version);
    expect(spec.info.version).toBe(pkg.version);
});

test('no hard-coded version fallback remains in the contract source', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/api/v1/openapi.js'), 'utf8');
    expect(src).not.toMatch(/'2\.0\.0'/);
    expect(src).toMatch(/require\('\.\.\/\.\.\/config\/product'\)/);
});
