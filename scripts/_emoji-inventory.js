'use strict';
const fs = require('fs'),
    path = require('path');
const rx =
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{20E3}]/gu; // eslint-disable-line no-misleading-character-class
const root = path.join(__dirname, '..', 'views');
const counts = {};
const sample = {};
function walk(d) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const s = fs.statSync(p);
        if (s.isDirectory()) walk(p);
        else if (/\.ejs$/.test(f)) {
            const text = fs.readFileSync(p, 'utf8');
            // strip <script> blocks so we only inventory display emoji
            const display = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            let m;
            const seen = display.matchAll(rx);
            for (const mm of seen) {
                const e = mm[0];
                if (e === '️') continue; // variation selector alone
                counts[e] = (counts[e] || 0) + 1;
                if (!sample[e]) {
                    const idx = display.indexOf(e);
                    sample[e] = display
                        .slice(Math.max(0, idx - 25), idx + 25)
                        .replace(/\s+/g, ' ')
                        .trim();
                }
            }
        }
    }
}
walk(root);
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log('distinct display emoji:', sorted.length);
sorted.forEach(([e, c]) =>
    console.log(`${c}\t${e}\t${e.codePointAt(0).toString(16)}\t${sample[e]}`)
);
