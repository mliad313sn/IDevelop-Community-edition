'use strict';
/* Replace structural emoji with Font Awesome <i> icons — SAFELY.
   Dry-run by default; pass --apply to write. Guards:
   - never touch <script>...</script> regions
   - skip lines with <option   (mood faces / option arrows are content)
   - skip lines with  icon:'   or  icon: "   (JS config strings)
   - skip an emoji that sits inside an attribute value ( ="...EMOJI..." )
   - only a curated SAFE_MAP of decorative/structural emoji is converted;
     semantic content (→ ← ↑ ↓ ✓ ✗ ✅ ❌ ★ ⏳ mood faces) is left as-is. */
const fs = require('fs'),
    path = require('path');

const MAP = {
    '📊': 'chart-column',
    '📈': 'chart-line',
    '📉': 'chart-line',
    '📥': 'file-import',
    '📤': 'file-export',
    '🗑': 'trash-can',
    '✏': 'pen',
    '➕': 'plus',
    '🎯': 'bullseye',
    '🏢': 'building',
    '📚': 'book',
    '💾': 'floppy-disk',
    '👥': 'users',
    '🧭': 'compass',
    '⚙': 'gear',
    '🧬': 'dna',
    '🌱': 'seedling',
    '🔐': 'lock',
    '💡': 'lightbulb',
    '📄': 'file-lines',
    '🔍': 'magnifying-glass',
    '📸': 'camera',
    '🧩': 'puzzle-piece',
    '🖨': 'print',
    '🔑': 'key',
    '🔄': 'arrows-rotate',
    '📜': 'scroll',
    '📋': 'clipboard',
    '🚀': 'rocket',
    '🗂': 'folder-tree',
    '🧾': 'receipt',
    '📝': 'pen-to-square',
    '🤝': 'handshake',
    '⏱': 'stopwatch',
    '🏛': 'landmark',
    '👔': 'user-tie',
    '🔒': 'lock',
    '🔔': 'bell',
    '🔥': 'fire',
    '🏆': 'trophy',
    '📦': 'box',
    '📂': 'folder-open',
    '💎': 'gem',
    '📁': 'folder',
    '🛠': 'screwdriver-wrench',
    '📒': 'book',
    '🗓': 'calendar-days',
    '📘': 'book',
    '📕': 'file-pdf',
    '📍': 'location-dot',
    '📖': 'book-open',
    '👁': 'eye',
    '📌': 'thumbtack',
    '❓': 'circle-question',
    '🔎': 'magnifying-glass',
    '📐': 'ruler',
};
const VS = '️'; // variation selector that may follow an emoji
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => a.startsWith('--only='));
const onlyFilter = ONLY ? ONLY.slice('--only='.length) : null;

function insideAttr(line, idx) {
    // true if position idx is within an attribute value (last unbalanced =" or =' before it)
    const before = line.slice(0, idx);
    const m = before.match(/=\s*(["'])(?:(?!\1).)*$/);
    return !!m;
}

function processText(text, report) {
    const parts = text.split(/(<script[\s\S]*?<\/script>)/gi);
    for (let pi = 0; pi < parts.length; pi++) {
        if (/^<script/i.test(parts[pi])) continue; // leave script blocks
        const lines = parts[pi].split('\n');
        for (let li = 0; li < lines.length; li++) {
            let line = lines[li];
            if (/<option\b/i.test(line)) continue;
            if (/\bicon:\s*['"]/.test(line)) continue;
            for (const [emoji, fa] of Object.entries(MAP)) {
                let pos;
                while ((pos = line.indexOf(emoji)) !== -1) {
                    if (insideAttr(line, pos)) {
                        break;
                    } // don't loop forever; skip this emoji on this line
                    let end = pos + emoji.length;
                    if (line[end] === VS) end++; // swallow trailing VS-16
                    if (line[end] === ' ') {
                        /* keep following space */
                    }
                    const repl = `<i class="fas fa-${fa}" aria-hidden="true"></i>`;
                    report.push({
                        emoji,
                        fa,
                        ctx: line
                            .slice(Math.max(0, pos - 18), end + 18)
                            .replace(/\s+/g, ' ')
                            .trim(),
                    });
                    line = line.slice(0, pos) + repl + line.slice(end);
                }
            }
            lines[li] = line;
        }
        parts[pi] = lines.join('\n');
    }
    return parts.join('');
}

const root = path.join(__dirname, '..', 'views');
let files = [];
(function walk(d) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const s = fs.statSync(p);
        if (s.isDirectory()) walk(p);
        else if (/\.ejs$/.test(f)) files.push(p);
    }
})(root);
if (onlyFilter) files = files.filter((f) => f.replace(/\\/g, '/').includes(onlyFilter));

let total = 0;
const perFile = [];
for (const f of files) {
    const orig = fs.readFileSync(f, 'utf8');
    const report = [];
    const out = processText(orig, report);
    if (report.length) {
        total += report.length;
        perFile.push([f.split('views')[1].replace(/\\/g, '/'), report.length]);
        if (APPLY && out !== orig) fs.writeFileSync(f, out);
        if (!APPLY)
            report.slice(0, 6).forEach((r) => console.log(`   ${r.emoji}→fa-${r.fa}  | ${r.ctx}`));
    }
}
console.log(
    `\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${total} replacements across ${perFile.length} files`
);
perFile
    .sort((a, b) => b[1] - a[1])
    .forEach((x) => console.log('  ' + String(x[1]).padStart(3) + '  views' + x[0]));
