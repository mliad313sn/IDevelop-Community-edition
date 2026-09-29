'use strict';
/* eslint-disable no-console */
/**
 * Icon-consistency guard: the app UI uses Font Awesome, not pictographic emoji.
 * Fails (exit 1) if a view introduces a colored emoji icon, so the icon system
 * can't silently fragment again.
 *
 * Allowed on purpose:
 *   - plain typographic glyphs (✓ ✗ ★ → · — ◤ ↗ …) — theme-safe text
 *   - the mood scale in employees/show.ejs (😟🙁😐🙂😀 IS the content)
 *   - the user guide (guide.ejs + userGuideContent.js) — deliberate doc style
 *
 * Run: node scripts/check-icons.js   (also wired as `npm run lint:icons`)
 */
const fs = require('fs');
const path = require('path');

// Pictographic ranges only — deliberately NOT matching text glyphs/arrows.
const EMOJI = /[☀-➿⬀-⯿️]|[\uD83C-\uD83E][\uDC00-\uDFFF]/; // eslint-disable-line no-misleading-character-class
const TEXT_GLYPHS = /[✓✗★☆→←↔↗↘·—–▸▾▲▼◤◢…°]/g;

const ALLOW_FILES = [
    path.join('views', 'pages', 'guide.ejs'), // doc style — emoji intentional
];
const ALLOW_LINES = [
    /MOOD\s*=|ci-new-sentiment/, // mood scale is content (employees/show.ejs)
];

let violations = [];
function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p);
            continue;
        }
        if (!e.name.endsWith('.ejs')) continue;
        if (ALLOW_FILES.some((a) => p.endsWith(a))) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (/^\s*(\/\/|<!--|\*)/.test(line)) return; // comments
            if (ALLOW_LINES.some((re) => re.test(line))) return; // content emoji
            const stripped = line.replace(TEXT_GLYPHS, '');
            if (EMOJI.test(stripped)) {
                violations.push(`${p}:${i + 1}  ${line.trim().slice(0, 110)}`);
            }
        });
    }
}
walk(path.join(__dirname, '..', 'views'));

if (violations.length) {
    console.error(
        `✗ ${violations.length} pictographic emoji icon(s) in views — use Font Awesome (<i class="fas fa-…" aria-hidden="true">) instead:`
    );
    violations.forEach((v) => console.error('  ' + v));
    process.exit(1);
}
console.log('✓ icon consistency: no pictographic emoji in app views (Font Awesome everywhere)');
