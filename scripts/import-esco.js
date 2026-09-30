'use strict';
/* eslint-disable no-console */
/**
 * Convert an ESCO v1.x CSV export (European Skills, Competences, Qualifications
 * and Occupations — https://esco.ec.europa.eu) into a capability-framework JSON
 * file with the SAME shape as db/postgres/seed-data/starter-framework.json, so
 * it can be loaded with:
 *
 *   npm run import:esco -- --dir ~/esco-v1.2.0 --group "digital" --out esco.json
 *   npm run db:seed:starter -- --file esco.json            # dry run
 *   npm run db:seed:starter -- --file esco.json --commit   # write it
 *
 * No ESCO data ships with this repository. Download the CSV package ("ESCO
 * dataset", classification = skills, format = CSV, language = English, and
 * optionally French) and point --dir at the folder that holds it.
 *
 * ESCO is published by the European Commission under CC BY 4.0: an
 * installation that imports it must display the attribution (see NOTICE). The
 * generated file carries the attribution in its "license" and "note" fields.
 *
 * Hierarchy mapping (ESCO skills pillar → IDevelop framework):
 *   ESCO skill group, depth 1 (e.g. S1 "communication, collaboration and
 *   creativity", or a knowledge field)              → pillar (domain)
 *   ESCO skill group, depth 2 (e.g. S1.1)           → sub-domain
 *   ESCO skill / competence / knowledge concept     → skill
 * Depth 0 holds the four ESCO roots (skills, knowledge, transversal skills,
 * language skills) and is skipped because it is too coarse to be useful.
 * Deeper groups (S1.1.1 …) fold into their depth-2 ancestor. A skill whose
 * broader concept is another skill inherits that skill's groups. A skill with
 * no group ancestor goes to "Other ESCO skills".
 *
 * Options:
 *   --dir <path>       folder holding the ESCO CSV files (required)
 *   --lang-fr <file>   skills_fr.csv for French descriptions (default: found in --dir)
 *   --out <file>       write the JSON there (default: stdout)
 *   --group <filter>   keep only skills under a group whose URI equals, or whose
 *                      label contains (case-insensitive), the filter; repeatable
 *   --limit <n>        keep at most n skills
 *   --type <t>         keep only skillType t ("skill/competence" or "knowledge")
 *   --include-obsolete also keep concepts whose status is not "released"
 */
const fs = require('fs');
const path = require('path');

const ESCO_ATTRIBUTION =
    'Contains data from ESCO (European Skills, Competences, Qualifications and Occupations), ' +
    '© European Union, https://esco.ec.europa.eu, licensed under CC BY 4.0 ' +
    '(https://creativecommons.org/licenses/by/4.0/). Converted and possibly filtered by IDevelop Community Edition.';
const OTHER_PILLAR = 'Other ESCO skills';
const OTHER_SUBDOMAIN = 'Ungrouped';
const ROOT_LABELS = new Set([
    'skills',
    'knowledge',
    'transversal skills and competences',
    'language skills and knowledge',
]);

/**
 * RFC 4180 CSV parser: quoted fields may hold commas, doubled quotes and line
 * breaks; CRLF or LF line endings; a leading UTF-8 BOM is dropped. Returns an
 * array of rows (arrays of strings).
 */
function parseCsv(text) {
    const src = String(text || '');
    const BOM = String.fromCharCode(0xfeff);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = src.charAt(0) === BOM ? 1 : 0;
    const n = src.length;
    while (i < n) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }
        if (ch === '"' && field === '') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            if (ch === '\r' && src[i + 1] === '\n') i += 1;
        } else {
            field += ch;
        }
        i += 1;
    }
    if (inQuotes) throw new Error('CSV: unterminated quoted field');
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    // Drop blank lines (a single empty field).
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV text into objects keyed by the header row. */
function parseCsvObjects(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
        const o = {};
        header.forEach((h, idx) => {
            o[h] = r[idx] !== undefined ? r[idx] : '';
        });
        return o;
    });
}

const clean = (s) =>
    String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
const capitalise = (s) => {
    const t = clean(s);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

function isReleased(row, includeObsolete) {
    if (includeObsolete) return true;
    const st = clean(row.status).toLowerCase();
    return !st || st === 'released';
}

function categoryOf(skill) {
    const reuse = clean(skill.reuseLevel).toLowerCase();
    if (reuse === 'transversal') return 'Behavioral';
    return 'Technical';
}

/**
 * Pure conversion: ESCO rows (already parsed into objects) → framework JSON.
 *
 * @param {object} input
 * @param {object[]} input.skills      rows of skills_en.csv
 * @param {object[]} input.groups      rows of skillGroups_en.csv
 * @param {object[]} input.relations   rows of broaderRelationsSkillPillar_en.csv
 * @param {object[]} [input.skillsFr]  rows of skills_fr.csv (optional)
 * @param {object} [opts] { group: string|string[], limit, type, includeObsolete, version }
 */
function convertEsco({ skills = [], groups = [], relations = [], skillsFr = [] }, opts = {}) {
    const includeObsolete = !!opts.includeObsolete;
    const groupMap = new Map();
    for (const g of groups) {
        const uri = clean(g.conceptUri);
        if (!uri || !isReleased(g, includeObsolete)) continue;
        groupMap.set(uri, {
            uri,
            label: capitalise(g.preferredLabel),
            description: clean(g.description || g.scopeNote) || null,
            code: clean(g.code) || null,
        });
    }
    // Every broader edge, child → [parents]. ESCO is a poly-hierarchy: we keep
    // the first parent listed, which is stable across exports.
    const broader = new Map();
    for (const r of relations) {
        const child = clean(r.conceptUri);
        const parent = clean(r.broaderUri);
        if (!child || !parent || child === parent) continue;
        if (!broader.has(child)) broader.set(child, []);
        broader.get(child).push(parent);
    }

    // Group chain root → … → nearest group, following skill→skill links too.
    const chainCache = new Map();
    function chainOf(uri, seen = new Set()) {
        if (chainCache.has(uri)) return chainCache.get(uri);
        if (seen.has(uri)) return [];
        seen.add(uri);
        const parents = broader.get(uri) || [];
        let chain = [];
        for (const p of parents) {
            const up = chainOf(p, seen);
            const c = groupMap.has(p) ? up.concat(p) : up;
            if (c.length) {
                chain = c;
                break;
            }
        }
        chainCache.set(uri, chain);
        return chain;
    }

    // The four ESCO roots: code S / K / T / L, or a known root label, with no
    // broader group of their own.
    const isRoot = (uri) => {
        const g = groupMap.get(uri);
        if (!g) return false;
        if ((broader.get(uri) || []).some((p) => groupMap.has(p))) return false;
        return (g.code && /^[A-Z]$/.test(g.code)) || ROOT_LABELS.has(g.label.toLowerCase());
    };

    const filters = []
        .concat(opts.group || [])
        .map((f) => clean(f))
        .filter(Boolean);
    const matchesFilter = (chain) => {
        if (!filters.length) return true;
        return chain.some((uri) => {
            const g = groupMap.get(uri);
            return filters.some(
                (f) => f === uri || (g && g.label.toLowerCase().includes(f.toLowerCase()))
            );
        });
    };

    const fr = new Map();
    for (const r of skillsFr) {
        const uri = clean(r.conceptUri);
        if (uri) fr.set(uri, r);
    }

    const limit =
        Number.isInteger(Number(opts.limit)) && Number(opts.limit) > 0
            ? Number(opts.limit)
            : Infinity;
    const type = opts.type ? clean(opts.type).toLowerCase() : null;

    const pillars = new Map(); // key → pillar
    let kept = 0;
    for (const s of skills) {
        if (kept >= limit) break;
        const uri = clean(s.conceptUri);
        const name = capitalise(s.preferredLabel);
        if (!uri || !name || !isReleased(s, includeObsolete)) continue;
        if (type && clean(s.skillType).toLowerCase() !== type) continue;
        const chain = chainOf(uri);
        if (!matchesFilter(chain)) continue;

        // Drop the ESCO root (depth 0) when the export includes it.
        const groupPath = chain.length && isRoot(chain[0]) ? chain.slice(1) : chain;
        const pillarUri = groupPath[0] || null;
        const subUri = groupPath[1] || null;
        const pg = pillarUri ? groupMap.get(pillarUri) : null;
        const sg = subUri ? groupMap.get(subUri) : null;
        const pKey = pg ? pg.uri : OTHER_PILLAR;
        if (!pillars.has(pKey)) {
            pillars.set(pKey, {
                uri: pg ? pg.uri : null,
                name: pg ? pg.label : OTHER_PILLAR,
                description: pg
                    ? pg.description
                    : 'ESCO skills without a skill group in this export.',
                category: 'Technical',
                subDomains: new Map(),
                _names: new Set(),
            });
        }
        const pillar = pillars.get(pKey);
        const sKey = sg ? sg.uri : '__general__';
        if (!pillar.subDomains.has(sKey)) {
            pillar.subDomains.set(sKey, {
                uri: sg ? sg.uri : null,
                name: sg ? sg.label : pg ? pg.label : OTHER_SUBDOMAIN,
                definition: sg ? sg.description : pg ? pg.description : null,
                skills: [],
            });
        }
        // Skills are matched by name within a pillar on seed: skip duplicates.
        const low = name.toLowerCase();
        if (pillar._names.has(low)) continue;
        pillar._names.add(low);

        const f = fr.get(uri);
        const skill = {
            name,
            fr: f ? clean(f.description) || capitalise(f.preferredLabel) || null : null,
            en: clean(s.description) || null,
            category: categoryOf(s),
            uri,
        };
        if (f && clean(f.preferredLabel)) skill.nameFr = capitalise(f.preferredLabel);
        pillar.subDomains.get(sKey).skills.push(skill);
        kept += 1;
    }

    const out = [...pillars.values()]
        .map((p) => {
            const subDomains = [...p.subDomains.values()]
                .filter((sd) => sd.skills.length)
                .sort((a, b) => a.name.localeCompare(b.name));
            const cats = subDomains.flatMap((sd) => sd.skills.map((k) => k.category));
            const behavioural = cats.filter((c) => c === 'Behavioral').length;
            return {
                uri: p.uri,
                name: p.name,
                description: p.description || null,
                category: behavioural * 2 > cats.length ? 'Behavioral' : 'Technical',
                subDomains,
            };
        })
        .filter((p) => p.subDomains.length)
        .sort((a, b) => {
            if (a.name === OTHER_PILLAR) return 1;
            if (b.name === OTHER_PILLAR) return -1;
            return a.name.localeCompare(b.name);
        });

    return {
        name: 'ESCO skills (imported)',
        version: opts.version || 1,
        license: 'CC-BY-4.0',
        attribution: ESCO_ATTRIBUTION,
        note:
            'Generated by scripts/import-esco.js from an ESCO CSV export. ' +
            ESCO_ATTRIBUTION +
            (filters.length ? ` Filter: ${filters.join(', ')}.` : ''),
        pillars: out,
        roleFamilies: [],
        familySkills: {},
        roles: [],
    };
}

/** Find an ESCO CSV in a folder: "skills_en.csv", "skills.csv", any case. */
function findCsv(dir, base, lang) {
    const files = fs.readdirSync(dir);
    const want = [`${base}_${lang}.csv`, `${base}.csv`].map((f) => f.toLowerCase());
    for (const w of want) {
        const hit = files.find((f) => f.toLowerCase() === w);
        if (hit) return path.join(dir, hit);
    }
    return null;
}

function parseArgs(argv) {
    const o = { group: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--dir') o.dir = next();
        else if (a === '--lang-fr') o.langFr = next();
        else if (a === '--out') o.out = next();
        else if (a === '--group') o.group.push(next());
        else if (a === '--limit') o.limit = parseInt(next(), 10);
        else if (a === '--type') o.type = next();
        else if (a === '--include-obsolete') o.includeObsolete = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`Unknown option: ${a}`);
    }
    return o;
}

function readFromDir(opts) {
    const dir = path.resolve(opts.dir);
    const need = (base) => {
        const f = findCsv(dir, base, 'en');
        if (!f) throw new Error(`${base}_en.csv not found in ${dir}`);
        return parseCsvObjects(fs.readFileSync(f, 'utf8'));
    };
    const frFile = opts.langFr ? path.resolve(opts.langFr) : findCsv(dir, 'skills', 'fr');
    return {
        skills: need('skills'),
        groups: need('skillGroups'),
        relations: need('broaderRelationsSkillPillar'),
        skillsFr: frFile ? parseCsvObjects(fs.readFileSync(frFile, 'utf8')) : [],
    };
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help || !opts.dir) {
        console.error(
            'Usage: node scripts/import-esco.js --dir <esco-csv-folder> [--lang-fr skills_fr.csv]\n' +
                '         [--out file.json] [--group <uri|label>]... [--limit n] [--type knowledge|skill/competence]'
        );
        process.exit(opts.help ? 0 : 2);
    }
    const fw = convertEsco(readFromDir(opts), opts);
    const json = JSON.stringify(fw, null, 2) + '\n';
    if (opts.out) {
        fs.writeFileSync(opts.out, json);
        const n = fw.pillars.reduce(
            (a, p) => a + p.subDomains.reduce((b, sd) => b + sd.skills.length, 0),
            0
        );
        const sds = fw.pillars.reduce((a, p) => a + p.subDomains.length, 0);
        console.error(
            `Wrote ${opts.out}: ${fw.pillars.length} pillars, ${sds} sub-domains, ${n} skills.\n` +
                'ESCO is CC BY 4.0 - keep the attribution (see NOTICE).'
        );
    } else {
        process.stdout.write(json);
    }
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error('ESCO import failed:', e.message);
        process.exit(1);
    }
}

module.exports = {
    parseCsv,
    parseCsvObjects,
    convertEsco,
    parseArgs,
    findCsv,
    ESCO_ATTRIBUTION,
    OTHER_PILLAR,
};
