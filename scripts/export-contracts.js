'use strict';
/* eslint-disable no-console */
/**
 * Export the product's LANGUAGE-NEUTRAL contracts to docs/contracts/ so an
 * alternative implementation (another framework, another language) can be
 * built and verified against the same interfaces without reading Node code:
 *
 *   openapi.json        — the versioned HTTP API (/api/v1)
 *   chart-identity.json — the chart palette / geometry table (design tokens)
 *   product.json        — the product identity constants
 *
 * The other neutral contracts already live as plain files:
 *   db/postgres/*.sql   — the database schema and migrations (source of truth)
 *   locales/<lang>/*.json — every user-visible string
 *   db/postgres/seed-data/starter-framework.json — starter content
 *   public/css/style.css :root — UI design tokens
 *
 *   npm run contracts:export
 */
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const OUT = path.join(__dirname, '..', 'docs', 'contracts');
fs.mkdirSync(OUT, { recursive: true });

const write = (name, obj) => {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');
    console.log('  wrote docs/contracts/' + name);
};

write('openapi.json', require('../src/api/v1/openapi'));
write('chart-identity.json', require('../src/utils/branding').CHART_IDENTITY);
write('product.json', require('../src/config/product'));
