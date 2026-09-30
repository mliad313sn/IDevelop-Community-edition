'use strict';

/**
 * ESCO import from the skills library screen (/framework/library, tab
 * "Import ESCO").
 *
 * The administrator uploads the ESCO v1.x CSV files (skills_en.csv,
 * skillGroups_en.csv, broaderRelationsSkillPillar_en.csv, optionally
 * skills_fr.csv), as separate files or as one .zip. They are parsed with the
 * SAME exported functions as the command line (scripts/import-esco.js:
 * parseCsvObjects + convertEsco), so the screen and `npm run import:esco` build
 * the same framework. The converted framework is parked in a private temporary
 * file keyed by a random token that only the uploader's session holds; the
 * administrator then ticks the skill groups to import (capped per import) and
 * goes through FrameworkPackService's dry run → confirm.
 *
 * ESCO is © European Union, CC BY 4.0: the attribution is shown on the screen
 * and recorded in the audit row of every import.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    parseCsvObjects,
    convertEsco,
    ESCO_ATTRIBUTION,
    OTHER_PILLAR,
} = require('../../scripts/import-esco');
const { readZipEntries } = require('../utils/importGuards');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = Math.max(1, Number(process.env.ESCO_IMPORT_MAX_SKILLS) || 2000);
const TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const ESCO_URL = 'https://esco.ec.europa.eu';

/** base file name (lower case) → role in the conversion input. */
const FILE_ROLES = {
    'skills_en.csv': 'skills',
    'skills.csv': 'skills',
    'skillgroups_en.csv': 'groups',
    'skillgroups.csv': 'groups',
    'broaderrelationsskillpillar_en.csv': 'relations',
    'broaderrelationsskillpillar.csv': 'relations',
    'skills_fr.csv': 'skillsFr',
};
const REQUIRED = ['skills', 'groups', 'relations'];
const REQUIRED_COLUMNS = {
    skills: ['conceptUri', 'preferredLabel'],
    groups: ['conceptUri', 'preferredLabel'],
    relations: ['conceptUri', 'broaderUri'],
    skillsFr: ['conceptUri', 'preferredLabel'],
};

function httpError(code, extra = {}) {
    const e = new Error(code);
    e.code = code;
    e.status = 400;
    e.expose = true;
    Object.assign(e, extra);
    return e;
}

const roleOf = (name) => FILE_ROLES[String(name || '').toLowerCase()] || null;
const isZip = (f) =>
    /\.zip$/i.test(f.originalname || '') ||
    (Buffer.isBuffer(f.buffer) && f.buffer.length > 4 && f.buffer.readUInt32LE(0) === 0x04034b50);

/**
 * Uploaded files ([{ originalname, buffer }]) → the CSV texts by role. A .zip
 * is opened with the zip-bomb guard and only the four ESCO files are inflated.
 */
function collectCsv(files) {
    const texts = {};
    const names = {};
    const take = (base, buf) => {
        const role = roleOf(base);
        if (!role || texts[role] !== undefined) return;
        texts[role] = buf.toString('utf8');
        names[role] = base;
    };
    for (const f of files || []) {
        if (!f || !Buffer.isBuffer(f.buffer)) continue;
        if (isZip(f)) {
            let entries;
            try {
                entries = readZipEntries(f.buffer, (base) => !!roleOf(base));
            } catch (e) {
                throw httpError('esco_zip_refused', { detail: e.message });
            }
            for (const [base, buf] of entries) take(base, buf);
        } else {
            take(path.basename(String(f.originalname || '')), f.buffer);
        }
    }
    const missing = REQUIRED.filter((r) => texts[r] === undefined);
    if (missing.length) throw httpError('esco_missing_files', { missing });
    return { texts, names };
}

/** CSV texts → parsed rows, with the columns the conversion needs checked. */
function parseAll(texts) {
    const out = { skills: [], groups: [], relations: [], skillsFr: [] };
    for (const [role, text] of Object.entries(texts)) {
        let rows;
        try {
            rows = parseCsvObjects(text);
        } catch (e) {
            throw httpError('esco_bad_csv', { detail: `${role}: ${e.message}` });
        }
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const lack = REQUIRED_COLUMNS[role].filter((c) => !cols.includes(c));
        if (!rows.length || lack.length)
            throw httpError('esco_bad_columns', { detail: `${role}: ${lack.join(', ')}` });
        out[role] = rows;
    }
    return out;
}

/** Stable keys for the tick boxes: the ESCO group URI, else a fixed fallback. */
const pillarKey = (p) => p.uri || (p.name === OTHER_PILLAR ? 'other' : `name:${p.name}`);
const subKey = (p, sd) => sd.uri || `${pillarKey(p)}#general`;

/** The group tree shown on the screen (depth 1 → depth 2, with skill counts). */
function groupsOf(fw) {
    return fw.pillars.map((p) => ({
        key: pillarKey(p),
        name: p.name,
        description: p.description || null,
        count: p.subDomains.reduce((a, sd) => a + sd.skills.length, 0),
        subDomains: p.subDomains.map((sd) => ({
            key: subKey(p, sd),
            name: sd.name,
            count: sd.skills.length,
        })),
    }));
}

function countSkills(fw) {
    return fw.pillars.reduce(
        (a, p) => a + p.subDomains.reduce((b, sd) => b + sd.skills.length, 0),
        0
    );
}

/**
 * Parse an upload into the full converted framework (no filter, no cap).
 * Returns { fw, files, skills, groups }.
 */
function parseUpload(files) {
    const { texts, names } = collectCsv(files);
    const rows = parseAll(texts);
    const fw = convertEsco(rows, {});
    if (!fw.pillars.length) throw httpError('esco_no_skills');
    return {
        fw,
        files: Object.values(names),
        hasFrench: !!rows.skillsFr.length,
        skills: countSkills(fw),
    };
}

function clampLimit(raw) {
    const n = parseInt(String(raw == null ? '' : raw), 10);
    if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}

/**
 * Keep the ticked sub-groups (keys from groupsOf), in screen order, up to
 * `limit` skills. Returns { fw, selected, truncated } where fw has the file
 * shape FrameworkPackService loads.
 */
function select(full, keys, limit) {
    const want = new Set([].concat(keys || []).map(String));
    const cap = clampLimit(limit);
    let kept = 0;
    let truncated = 0;
    const pillars = [];
    for (const p of full.pillars) {
        const subs = [];
        for (const sd of p.subDomains) {
            if (!want.has(subKey(p, sd))) continue;
            const room = Math.max(0, cap - kept);
            const skills = sd.skills.slice(0, room);
            truncated += sd.skills.length - skills.length;
            kept += skills.length;
            if (skills.length) subs.push({ name: sd.name, definition: sd.definition, skills });
        }
        if (subs.length)
            pillars.push({
                name: p.name,
                description: p.description,
                category: p.category,
                subDomains: subs,
            });
    }
    const fw = {
        ...full,
        id: 'esco',
        name: full.name,
        licence: 'CC-BY-4.0',
        pillars,
        roleFamilies: [],
        familySkills: {},
        roles: [],
    };
    return { fw, selected: kept, truncated, limit: cap };
}

// ---------------------------------------------------------------------------
// Parking the parsed upload between requests: a private temporary file, keyed
// by a random token held only in the uploader's session. Old files are purged.
// ---------------------------------------------------------------------------
function storeDir() {
    const dir = path.join(os.tmpdir(), 'idevelop-esco');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function purgeOld(now = Date.now()) {
    try {
        const dir = storeDir();
        for (const f of fs.readdirSync(dir)) {
            if (!/^[a-f0-9]{32}\.json$/.test(f)) continue;
            const p = path.join(dir, f);
            try {
                if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
            } catch (_) {
                /* raced with another purge */
            }
        }
    } catch (_) {
        /* best effort */
    }
}

function store(parsed) {
    purgeOld();
    const token = crypto.randomBytes(16).toString('hex');
    const payload = { ...parsed, storedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(storeDir(), `${token}.json`), JSON.stringify(payload), {
        mode: 0o600,
    });
    return token;
}

function fetchStored(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const p = path.join(storeDir(), `${token}.json`);
    try {
        if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) {
            fs.unlinkSync(p);
            return null;
        }
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
        return null;
    }
}

function discard(token) {
    if (!TOKEN_RE.test(String(token || ''))) return;
    try {
        fs.unlinkSync(path.join(storeDir(), `${token}.json`));
    } catch (_) {
        /* already gone */
    }
}

module.exports = {
    ESCO_ATTRIBUTION,
    ESCO_URL,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    FILE_ROLES,
    collectCsv,
    parseUpload,
    groupsOf,
    select,
    clampLimit,
    countSkills,
    store,
    fetchStored,
    discard,
    purgeOld,
};
