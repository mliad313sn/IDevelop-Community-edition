'use strict';
/* eslint-disable no-console */
/**
 * Build the standalone HTML user guide for IDevelop — the full reference
 * covering EVERY profile (for distribution / print). The in-app contextual guide
 * (/guide) reuses the SAME content module, filtered to the signed-in user's
 * clearance.
 *
 * ONE DOCUMENT PER LANGUAGE. It used to be a single file carrying both
 * languages with CSS hiding one, which meant a French reader downloaded — and
 * printed, and searched, and Ctrl-F'd — the English manual too. Two documents
 * were chosen over a CSS/JS toggle for the same reason the in-app page now
 * renders server-side: the reader should only ever receive their own language.
 * Each document links to the other by RELATIVE href, so the pair keeps working
 * offline, next to each other in a folder, with JavaScript switched off. The
 * cost, stated plainly: the screenshots are embedded in both, so the two files
 * together weigh about twice one bilingual file.
 *
 * Content lives in src/config/userGuideContent.js (single source of truth).
 * Screenshots are embedded as base64 so each file is fully portable.
 *
 *   node scripts/build-user-guide.js
 */
const fs = require('fs');
const path = require('path');
const { PROFILES, GLOSSARY, FAQ, GETTING, FLOWS } = require('../src/config/userGuideContent');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'tests', 'uat', 'screenshots-min'); // compressed JPEGs
// FR keeps the historical /user-guide.html path (it is the product's primary
// language and the installer's HelpLink points at it); EN sits beside it.
const OUTPUTS = [
    { lang: 'fr', file: 'user-guide.html' },
    { lang: 'en', file: 'user-guide.en.html' },
];
// NOT `public/`. Anything under public/ is served by express.static, which is
// mounted BEFORE the session and therefore before any authentication - so the
// guide was readable by anyone who could reach the port. It names real
// colleagues and quotes their 9-box box labels, and 108 embedded screenshots
// carry more of the same where no text scanner can see it (// P2-01, 2026-09-15: GET /user-guide.html -> 200, 5 035 421 bytes, no cookie,
// 23 ACTIVE people from a test instance named).
//
// `private/` is served by nothing. The two files are handed out by an
// authenticated route instead, at the same URLs, so every link keeps working.
const OUT_DIRS = [path.join(ROOT, 'private', 'guides'), path.join(ROOT, 'docs')];

let shotFiles = [];
try {
    shotFiles = fs.readdirSync(SHOTS);
} catch (_) {}
// TEXT-ONLY MODE. The screenshot set is not part of the repository (it must be
// captured on invented data - see CONTRIBUTING.md). Without it the guide is
// built without pictures instead of failing; with it, a referenced picture
// that is missing is still a blocking error.
const TEXT_ONLY = shotFiles.length === 0;
if (TEXT_ONLY) console.log('No screenshots in ' + SHOTS + ' - building a text-only guide.');
// A referenced image with no file on disk is a BLOCKING error, not a silent gap:
// the build refuses rather than shipping a manual with holes where proof should be.
const missingImages = [];
const usedImages = new Set();
// Screenshots withdrawn because their PIXELS carried real names, staff numbers
// or brand tokens. Printed at the end of the build so the re-capture list is in
// front of whoever runs it, not buried in a report.
const retiredShots = new Set();
const picCache = new Map();
function pic(suffix) {
    if (!suffix || TEXT_ONLY) return null;
    if (picCache.has(suffix)) return picCache.get(suffix);
    const f =
        shotFiles.find((n) => n === suffix + '.jpg') ||
        shotFiles.find((n) => n.replace(/^[0-9]+-/, '') === suffix + '.jpg') ||
        shotFiles.find((n) => n.endsWith('-' + suffix + '.jpg'));
    if (!f) {
        missingImages.push(suffix);
        picCache.set(suffix, null);
        return null;
    }
    usedImages.add(f);
    let out = null;
    try {
        out = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(SHOTS, f)).toString('base64');
    } catch (_) {
        missingImages.push(suffix);
    }
    picCache.set(suffix, out);
    return out;
}
const esc = (s) =>
    String(s == null ? '' : s).replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]
    );

// ---------------------------------------------------------------------------
// Everything below renders ONE language: `L` is 'fr' or 'en' and `p(en, fr)`
// picks the matching literal. No element carries the other language.
// ---------------------------------------------------------------------------
function document_(L) {
    const p = (en, fr) => (L === 'en' ? en : fr);
    const T = (o) => o[L];
    const ol = (arr) => '<ol>' + arr.map((s) => `<li>${s}</li>`).join('') + '</ol>';
    const ul = (arr) => '<ul>' + arr.map((s) => `<li>${s}</li>`).join('') + '</ul>';
    const tip = (t) => `<div class="tip"><span class="tipi">💡</span> ${T(t)}</div>`;

    function feature(f) {
        const im = f.img ? pic(f.img) : null;
        // A card whose screenshot was PULLED says so, rather than looking like a
        // card that never had one. The reader is owed the reason: the previous
        // edition shipped 108 screenshots of a test instance, and a third of
        // them showed colleagues by name, staff number and 9-box placement -
        // inside base64, where the text scanners that guard this document are
        // blind. The words stay; only the picture is missing, and only until it
        // is re-taken on invented data.
        if (f.imgRetired) retiredShots.add(f.imgRetired);
        const gap = f.imgRetired
            ? `<div class="shot-gap">${p(
                  '🔒 Screenshot withheld — the original showed real colleagues by name. It returns once re-taken on invented data.',
                  '🔒 Copie d’écran retirée — l’originale montrait de vrais collaborateurs nommément. Elle reviendra une fois reprise sur des données fictives.'
              )}</div>`
            : '';
        return `<article class="feat">
    <header class="feat-h"><span class="feat-ic">${f.icon}</span>
      <div><h3>${T(f.title)}</h3>
      <div class="feat-where">${p('Where: ', 'Où : ')}${T(f.where)}</div></div></header>
    <div class="feat-body">
      <div class="feat-text">
        <p class="feat-what">${T(f.what)}</p>
        ${f.steps ? ol(f.steps[L]) : ''}
        ${f.tip ? tip(f.tip) : ''}
        ${gap}
      </div>
      ${im ? `<figure class="feat-img"><img loading="lazy" src="${im}" alt="${esc(f.title[L])}"></figure>` : ''}
    </div>
  </article>`;
    }
    function profileSection(pr) {
        return `<section id="${pr.id}" class="profile">
    <div class="profile-head" style="--c:${pr.color}">
      <span class="profile-ic">${pr.icon}</span>
      <div><h2>${T(pr.name)}</h2><p>${T(pr.tagline)}</p></div>
    </div>
    ${pr.features.map(feature).join('')}
  </section>`;
    }
    function flow(f) {
        return `<article class="feat flow">
    <header class="feat-h"><span class="feat-ic">${f.icon}</span>
      <div><h3>${T(f.title)}</h3>
      <div class="feat-where">${p('Who: ', 'Qui : ')}${T(f.actors)}</div>
      <div class="feat-where">${p('When: ', 'Quand : ')}${T(f.when)}</div></div></header>
    <div class="feat-body"><div class="feat-text">
      ${ol(f.steps[L])}
      <div class="flow-ex">${T(f.example)}</div>
      <div class="flow-gp"><b>${p('Good practices', 'Bonnes pratiques')}</b>
        ${ul(f.practices[L])}</div>
    </div></div>
  </article>`;
    }
    const glossary = () =>
        GLOSSARY.map((g) => (L === 'en' ? [g[0], g[2]] : [g[1], g[3]]))
            .map(([term, def]) => `<tr><td><b>${term}</b></td><td>${def}</td></tr>`)
            .join('');
    const faq = () =>
        FAQ.map((f) => (L === 'en' ? [f[0], f[2]] : [f[1], f[3]]))
            .map(
                ([q, a]) =>
                    `<details class="faq"><summary>${q}</summary><div class="faq-a">${a}</div></details>`
            )
            .join('');
    const profileNav = PROFILES.map(
        (pr) =>
            `<a class="pnav" href="#${pr.id}" style="--c:${pr.color}">${pr.icon} ${T(pr.name)}</a>`
    ).join('');
    const other = OUTPUTS.find((o) => o.lang !== L);

    return `<!DOCTYPE html>
<html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IDevelop Community Edition — ${p('User Guide', 'Guide utilisateur')}</title>
<style>
:root{--brand:#5B4BE0;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--bg:#f8fafc;--card:#fff}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:1080px;margin:0 auto;padding:24px}
header.hero{background:linear-gradient(135deg,#5B4BE0,#7C6CFF 60%,#FF7A59);color:#fff;border-radius:18px;padding:30px 32px;margin-bottom:20px;box-shadow:0 12px 32px rgba(2,32,71,.2)}
header.hero h1{margin:0 0 6px;font-size:27px}header.hero p{margin:0;opacity:.95;font-size:15px}
.langbar{position:sticky;top:0;z-index:50;background:rgba(248,250,252,.92);backdrop-filter:blur(6px);padding:10px 0;margin-bottom:14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.langbtn{display:inline-block;text-decoration:none;border:1px solid var(--brand);background:#fff;color:var(--brand);padding:6px 16px;border-radius:999px;font-weight:700;cursor:pointer;font-size:14px}
.langbtn.on{background:var(--brand);color:#fff}
.printbtn{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 14px;cursor:pointer;font-size:13px;color:var(--mut)}
.pnavwrap{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
.pnav{text-decoration:none;border:1px solid var(--c);color:var(--c);background:#fff;border-radius:10px;padding:8px 14px;font-weight:700;font-size:14px}
.pnav:hover{background:var(--c);color:#fff}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:8px 22px 18px;margin:16px 0}
h2{font-size:21px;margin:14px 0 6px}
.intro h2{border-bottom:2px solid #eff6ff;padding-bottom:8px}
.profile-head{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:3px solid var(--c);margin-bottom:8px}
.profile-ic{font-size:34px;background:color-mix(in srgb,var(--c) 14%,#fff);width:58px;height:58px;border-radius:14px;display:flex;align-items:center;justify-content:center}
.profile-head h2{margin:0;color:var(--c)}.profile-head p{margin:2px 0 0;color:var(--mut);font-size:14px}
.feat{border:1px solid var(--line);border-radius:12px;margin:14px 0;overflow:hidden}
.feat-h{display:flex;gap:12px;align-items:flex-start;background:#f8fafc;padding:12px 16px;border-bottom:1px solid var(--line)}
.feat-ic{font-size:22px}.feat-h h3{margin:0;font-size:16px}
.feat-where{color:var(--mut);font-size:12.5px;margin-top:2px}
.feat-body{display:flex;gap:18px;padding:14px 16px}
.feat-text{flex:1;min-width:0}
.feat-what{margin:0 0 8px}
.feat ol{margin:6px 0;padding-left:20px}.feat li{margin:5px 0}
.feat-img{margin:0;flex:0 0 320px;max-width:42%}
.feat-img img{width:100%;border:1px solid var(--line);border-radius:8px;cursor:zoom-in;background:#0f172a}
.tip{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;margin-top:10px;font-size:13.5px;color:#92400e}
.flow-ex{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 12px;margin:10px 0;font-size:13.5px;color:#1e3a8a}
.flow-gp{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-top:8px;font-size:13.5px;color:#14532d}
.flow-gp ul{margin:6px 0 0;padding-left:18px}
.shot-gap{background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:8px;padding:7px 12px;margin-top:10px;font-size:12.5px;color:#475569}
.tipi{margin-right:4px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child{width:230px}
.faq{border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:4px 12px;background:#fff}
.faq summary{cursor:pointer;font-weight:600;padding:8px 0}
.faq-a{color:var(--mut);padding:0 0 10px;font-size:14px}
footer{color:var(--mut);font-size:12.5px;text-align:center;margin:22px 0}
@media(max-width:760px){.feat-body{flex-direction:column}.feat-img{max-width:100%;flex-basis:auto}}
@media print{.langbar,.printbtn,.pnavwrap{display:none}.feat-img img{max-height:320px}}
</style></head>
<body>
<div class="wrap">

<div class="langbar">
  <strong style="margin-right:6px">🌐</strong>
  <a class="langbtn${L === 'en' ? ' on' : ''}" href="${L === 'en' ? '#' : other.file}" hreflang="en" lang="en"${L === 'en' ? ' aria-current="true"' : ''}>English</a>
  <a class="langbtn${L === 'fr' ? ' on' : ''}" href="${L === 'fr' ? '#' : other.file}" hreflang="fr" lang="fr"${L === 'fr' ? ' aria-current="true"' : ''}>Français</a>
  <button class="printbtn" onclick="window.print()">🖨 ${p('Print / Save PDF', 'Imprimer / PDF')}</button>
</div>

<header class="hero">
  <h1>IDevelop Community Edition — ${p('User Guide', 'Guide utilisateur')}</h1>
  <p>${p(
      'A simple, step-by-step manual for everyone. Find your profile below and follow the cards. The French edition is one click away, in the bar above.',
      'Un manuel simple, étape par étape, pour tous. Trouvez votre profil ci-dessous et suivez les cartes. L’édition anglaise est à un clic, dans la barre ci-dessus.'
  )}</p>
</header>

<section class="intro">
  <h2>${p('Start here', 'Commencer ici')}</h2>
  ${p(
      '<p>IDevelop helps your organisation track skills, run fair assessments, calibrate talent and drive development. What you can do depends on your <b>profile</b>.</p>',
      '<p>IDevelop aide votre organisation à suivre les compétences, mener des évaluations équitables, calibrer les talents et piloter le développement. Ce que vous pouvez faire dépend de votre <b>profil</b>.</p>'
  )}
  ${GETTING.map(feature).join('')}
  <h2 style="margin-top:18px">${p('Which profile am I?', 'Quel est mon profil ?')}</h2>
  ${p(
      '<p>Pick the one that matches you (admins also have the manager tools):</p>',
      '<p>Choisissez celui qui vous correspond (les administrateurs ont aussi les outils du manager) :</p>'
  )}
  <div class="pnavwrap">${profileNav}</div>
</section>

${PROFILES.map(profileSection).join('')}

<section id="flows">
  <h2>${p('How the processes fit together', 'Comment les processus s’articulent')}</h2>
  ${p(
      '<p>Each page of the app plays a part in a larger process. These are the end-to-end flows — who does what, in what order, a concrete example, and the practices that make each one work.</p>',
      '<p>Chaque page de l’application joue un rôle dans un processus plus large. Voici les flux de bout en bout — qui fait quoi, dans quel ordre, un exemple concret, et les pratiques qui font fonctionner chacun.</p>'
  )}
  ${FLOWS.map(flow).join('')}
</section>

<section>
  <h2>${p('Glossary', 'Glossaire')}</h2>
  <table>${glossary()}</table>
</section>

<section>
  <h2>${p('Frequently asked questions', 'Questions fréquentes')}</h2>
  ${faq()}
</section>

<footer>IDevelop Community Edition — ${p('User Guide', 'Guide utilisateur')} · ${p('Free software under the GNU AGPL v3.0 or later', 'Logiciel libre sous licence GNU AGPL v3.0 ou ultérieure')}</footer>
</div>
</body></html>`;
}

const docs = OUTPUTS.map((o) => ({ ...o, html: document_(o.lang) }));

if (missingImages.length) {
    console.error(
        'BLOCKING: ' +
            missingImages.length +
            ' referenced screenshot(s) have no file in ' +
            SHOTS +
            ':'
    );
    [...new Set(missingImages)].sort().forEach((s) => console.error('  - ' + s + '.jpg'));
    process.exit(1);
}

for (const dir of OUT_DIRS) fs.mkdirSync(dir, { recursive: true });
// A stale copy left in public/ would still be served by express.static, with no
// authentication, and would silently win over the authenticated route. Removing
// it here means a single `npm run build:guide` repairs a tree that has one.
for (const d of OUTPUTS) {
    const stale = path.join(ROOT, 'public', d.file);
    if (fs.existsSync(stale)) {
        fs.unlinkSync(stale);
        console.log(`  removed unauthenticated copy: ${stale}`);
    }
}
const written = [];
for (const d of docs) {
    for (const dir of OUT_DIRS) {
        const out = path.join(dir, d.file);
        fs.writeFileSync(out, d.html);
        written.push({
            out,
            kb: Math.round(Buffer.byteLength(d.html) / 1024),
            imgs: (d.html.match(/data:image\/(png|jpeg);base64,/g) || []).length,
        });
    }
}
const unused = shotFiles.filter((n) => /\.jpg$/i.test(n) && !usedImages.has(n));
console.log('User guide written — one document per language, every referenced image resolved:');
written.forEach((w) => console.log(`  ${w.out}  (${w.kb} KB, ${w.imgs} embedded screenshots)`));
console.log('  served at /user-guide.html (FR) and /user-guide.en.html (EN)');
if (unused.length)
    console.log(
        `  note: ${unused.length} file(s) in screenshots-min are not referenced by the content model.`
    );
if (retiredShots.size) {
    console.log(
        `\n  ${retiredShots.size} screenshot(s) WITHHELD — their pixels carry data no text scanner sees.`
    );
    console.log('  Re-capture each on invented data (DEMO-* staff numbers, the cast in');
    console.log('  src/config/userGuideContent.js), then swap imgRetired back to img:');
    [...retiredShots].sort().forEach((s) => console.log(`    - ${s}`));
}
