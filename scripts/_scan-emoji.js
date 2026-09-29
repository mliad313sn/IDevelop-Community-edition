'use strict';
const fs = require('fs'),
    path = require('path');
const rx =
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/u;
const root = path.join(__dirname, '..', 'views');
function walk(d, acc) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const s = fs.statSync(p);
        if (s.isDirectory()) walk(p, acc);
        else if (/\.ejs$/.test(f)) {
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            let c = 0;
            lines.forEach((l) => {
                if (rx.test(l)) c++;
            });
            if (c) acc.push([p.split('views')[1].replace(/\\/g, '/'), c]);
        }
    }
    return acc;
}
const r = walk(root, []).sort((a, b) => b[1] - a[1]);
console.log(
    'EJS files with emoji:',
    r.length,
    '| total emoji-lines:',
    r.reduce((s, x) => s + x[1], 0)
);
r.slice(0, 20).forEach((x) => console.log('  ' + String(x[1]).padStart(3) + '  views' + x[0]));
