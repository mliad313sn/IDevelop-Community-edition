'use strict';

/**
 * SkillDescriptionService — the HR side of « what does this skill mean »
 * (release 3.23.21, D11-D13).
 *
 *   · Quality of the framework: skills used by at least one role that still have
 *     no description, or fewer than five level anchors of their own — sorted by
 *     how many active employees are asked to rate them.
 *   · Proposals (skill_description_proposals): drafts from the starter pack or
 *     from HR. An employee NEVER reads a proposal; approving one copies its text
 *     into skills.description (FR) / skills.description_en (EN), audited. A
 *     proposal's empty language never erases an existing description.
 *   · Starter pack loader: db/postgres/seed-data/skill-description-proposals.json,
 *     matched on skill name + pillar name (accent- and case-insensitive; the
 *     sub-domain narrows, a mismatch is tolerated), loaded as 'proposed' only for
 *     skills with no description and no earlier proposal. Idempotent.
 *   · Excel round-trip of the texts: Pillar, Sub-Domain, Skill, Category,
 *     Description FR/EN, Niveau 0-4 FR, Level 0-4 EN. An EMPTY cell never
 *     erases. Import never adds, removes or re-files a skill.
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const LogService = require('./LogService');
const SkillsIntelligenceService = require('./SkillsIntelligenceService');

const DESC_MAX = 2000;
const ANCHOR_MAX = 600;
const LEVELS = [0, 1, 2, 3, 4];
const STARTER_FILE = path.join(
    __dirname,
    '..',
    '..',
    'db',
    'postgres',
    'seed-data',
    'skill-description-proposals.json'
);

/** Accent-, case- and spacing-insensitive key. */
function norm(v) {
    return String(v == null ? '' : v)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[‘’ʼ]/g, "'")
        .replace(/[‐-―]/g, '-')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
function txt(v) {
    if (v == null) return '';
    if (typeof v === 'object' && v.richText)
        return v.richText
            .map((r) => r.text || '')
            .join('')
            .trim();
    if (typeof v === 'object' && v.text != null) return String(v.text).trim();
    return String(v).trim();
}
function adminIdOf(actor) {
    return actor && actor.userType === 'admin' && actor.id != null ? Number(actor.id) : null;
}
function actorRefOf(actor) {
    if (!actor || actor.id == null) return null;
    return `${actor.userType === 'admin' ? 'admin' : 'employee'}:${actor.id}`;
}
function httpError(code, status = 400) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    return e;
}

// Excel column model — the export writes the first label, the import accepts all.
const COLS = [
    { key: 'pillar', labels: ['Pillar', 'Pilier', 'Domain', 'Domaine'] },
    {
        key: 'subDomain',
        labels: ['Sub-Domain', 'Sub Domain', 'Subdomain', 'Sous-domaine', 'Sous domaine'],
    },
    { key: 'skill', labels: ['Skill', 'Skill Name', 'Compétence', 'Competence'] },
    { key: 'category', labels: ['Category', 'Catégorie', 'Categorie'] },
    { key: 'descFr', labels: ['Description FR', 'Description (FR)', 'Description'] },
    { key: 'descEn', labels: ['Description EN', 'Description (EN)'] },
    ...LEVELS.map((n) => ({
        key: `fr${n}`,
        labels: [`Niveau ${n} FR`, `Niveau ${n} (FR)`, `Level ${n} FR`, `Niveau ${n}`],
    })),
    ...LEVELS.map((n) => ({
        key: `en${n}`,
        labels: [`Level ${n} EN`, `Level ${n} (EN)`, `Niveau ${n} EN`, `Level ${n}`],
    })),
];

class SkillDescriptionService {
    constructor() {
        this.STARTER_FILE = STARTER_FILE;
        this.norm = norm;
        this.COLS = COLS;
    }

    // ------------------------------------------------------------ quality
    async qualityReport({ limit = 500 } = {}) {
        const rows = await db.all(
            `SELECT s.id, s.name, s.category, d.name AS pillar, sd.name AS sub_domain,
                    (coalesce(btrim(s.description), '') <> '' OR coalesce(btrim(s.description_en), '') <> '') AS has_description,
                    (SELECT count(*) FROM proficiency_descriptors pd WHERE pd.skill_id = s.id)::int AS own_anchors,
                    (SELECT count(DISTINCT e.id) FROM employees e
                       JOIN role_skill_requirements r2 ON r2.role_id = e.role_id AND r2.skill_id = s.id
                      WHERE e.is_active = true)::int AS employees,
                    (SELECT count(DISTINCT r3.role_id) FROM role_skill_requirements r3 WHERE r3.skill_id = s.id)::int AS roles,
                    EXISTS (SELECT 1 FROM skill_description_proposals p
                             WHERE p.skill_id = s.id AND p.status = 'proposed') AS has_open_proposal
               FROM skills s
               JOIN domains d ON d.id = s.domain_id
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE s.is_active = true
                AND EXISTS (SELECT 1 FROM role_skill_requirements r WHERE r.skill_id = s.id)
              ORDER BY employees DESC, s.name, s.id`
        );
        const used = rows.length;
        const missingDescription = rows.filter((r) => !r.hasDescription).length;
        const fewAnchors = rows.filter((r) => Number(r.ownAnchors) < 5).length;
        const todo = rows.filter((r) => !r.hasDescription || Number(r.ownAnchors) < 5);
        return {
            counts: { used, missingDescription, fewAnchors, todo: todo.length },
            items: todo.slice(0, limit),
        };
    }

    // ---------------------------------------------------------- proposals
    async listProposals(status = 'proposed', { limit = 1000 } = {}) {
        const st = ['proposed', 'approved', 'rejected'].includes(status) ? status : 'proposed';
        return db.all(
            `SELECT p.id, p.skill_id, p.text_fr, p.text_en, p.source, p.status, p.created_at,
                    p.decided_at, p.reason, s.name AS skill_name, s.category,
                    d.name AS pillar, sd.name AS sub_domain,
                    s.description AS current_fr, s.description_en AS current_en
               FROM skill_description_proposals p
               JOIN skills s ON s.id = p.skill_id
               JOIN domains d ON d.id = s.domain_id
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE p.status = ?
              ORDER BY d.name, s.name, p.id
              LIMIT ?`,
            [st, limit]
        );
    }

    async countOpenProposals() {
        const r = await db.get(
            `SELECT count(*)::int AS n FROM skill_description_proposals WHERE status = 'proposed'`
        );
        return r ? Number(r.n) : 0;
    }

    _texts(textFr, textEn) {
        const fr = txt(textFr);
        const en = txt(textEn);
        if (!fr && !en) throw httpError('proposal_empty');
        if (fr.length > DESC_MAX || en.length > DESC_MAX) throw httpError('text_too_long');
        return { fr: fr || null, en: en || null };
    }

    async updateProposal(id, { textFr, textEn }, actor) {
        const t = this._texts(textFr, textEn);
        const row = await db.get(
            `UPDATE skill_description_proposals SET text_fr = ?, text_en = ?
              WHERE id = ? AND status = 'proposed' RETURNING id, skill_id`,
            [t.fr, t.en, id]
        );
        if (!row) throw httpError('proposal_not_open', 409);
        await this._audit(
            'SKILL_DESCRIPTION_PROPOSAL_EDITED',
            row.skillId,
            `proposal ${id} edited`,
            actor
        );
        return row;
    }

    /** Copy the proposal into the skill (FR → description, EN → description_en). */
    async approve(id, actor, { inTx = false } = {}) {
        const work = async () => {
            const p = await db.get(
                `SELECT id, skill_id, text_fr, text_en FROM skill_description_proposals
                  WHERE id = ? AND status = 'proposed' FOR UPDATE`,
                [id]
            );
            if (!p) throw httpError('proposal_not_open', 409);
            // An empty language in the proposal never erases the skill's text.
            await db.run(
                `UPDATE skills
                    SET description    = COALESCE(NULLIF(btrim(?), ''), description),
                        description_en = COALESCE(NULLIF(btrim(?), ''), description_en),
                        updated_at = now()
                  WHERE id = ?`,
                [p.textFr || '', p.textEn || '', p.skillId]
            );
            await db.run(
                `UPDATE skill_description_proposals
                    SET status = 'approved', decided_at = now(), decided_by = ?
                  WHERE id = ?`,
                [adminIdOf(actor), id]
            );
            return p;
        };
        const p = inTx ? await work() : await db.runTransaction(work);
        await this._audit(
            'SKILL_DESCRIPTION_APPROVED',
            p.skillId,
            `proposal ${id} approved → skill description`,
            actor
        );
        return p;
    }

    async bulkApprove(ids, actor) {
        const list = [
            ...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)),
        ];
        const done = [];
        const skipped = [];
        await db.runTransaction(async () => {
            for (const id of list) {
                const open = await db.get(
                    `SELECT id FROM skill_description_proposals WHERE id = ? AND status = 'proposed'`,
                    [id]
                );
                if (!open) {
                    skipped.push(id);
                    continue;
                }
                await this.approve(id, actor, { inTx: true });
                done.push(id);
            }
        });
        return { approved: done.length, skipped: skipped.length };
    }

    async reject(id, reason, actor) {
        const why = txt(reason);
        if (!why) throw httpError('reason_required');
        const row = await db.get(
            `UPDATE skill_description_proposals
                SET status = 'rejected', decided_at = now(), decided_by = ?, reason = ?
              WHERE id = ? AND status = 'proposed' RETURNING id, skill_id`,
            [adminIdOf(actor), why.slice(0, 1000), id]
        );
        if (!row) throw httpError('proposal_not_open', 409);
        await this._audit(
            'SKILL_DESCRIPTION_REJECTED',
            row.skillId,
            `proposal ${id} rejected: ${why.slice(0, 200)}`,
            actor
        );
        return row;
    }

    // ------------------------------------------------------- starter pack
    /**
     * @param {{file?: string, data?: object, actor?: object}} opts
     * @returns report { total, inserted, skippedDescribed, skippedExisting,
     *                   invalid, unmatched: [{skill, pillar, subDomain, reason}] }
     */
    async loadStarter({ file, data, actor } = {}) {
        let json = data;
        if (!json) {
            const f = file || STARTER_FILE;
            if (!fs.existsSync(f)) throw httpError('starter_file_missing', 404);
            json = JSON.parse(fs.readFileSync(f, 'utf8'));
        }
        if (!json || !Array.isArray(json.items)) throw httpError('starter_file_invalid');

        const skills = await db.all(
            `SELECT s.id, s.name, s.description, s.description_en, d.name AS pillar, sd.name AS sub_domain,
                    EXISTS (SELECT 1 FROM skill_description_proposals p
                             WHERE p.skill_id = s.id AND (p.status = 'proposed' OR p.source = 'starter')) AS has_proposal
               FROM skills s
               JOIN domains d ON d.id = s.domain_id
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE s.is_active = true`
        );
        const index = new Map();
        for (const s of skills) {
            const k = `${norm(s.name)}|${norm(s.pillar)}`;
            if (!index.has(k)) index.set(k, []);
            index.get(k).push(s);
        }

        const report = {
            total: json.items.length,
            matched: 0,
            inserted: 0,
            skippedDescribed: 0,
            skippedExisting: 0,
            invalid: 0,
            unmatched: [],
        };
        const taken = new Set();
        await db.runTransaction(async () => {
            for (const it of json.items) {
                const item = it || {};
                const cands = index.get(`${norm(item.skill)}|${norm(item.pillar)}`) || [];
                let targets = cands.filter((c) => norm(c.subDomain) === norm(item.subDomain));
                if (!targets.length && cands.length === 1) targets = cands; // sub-domain mismatch tolerated
                if (!targets.length) {
                    report.unmatched.push({
                        skill: item.skill || null,
                        pillar: item.pillar || null,
                        subDomain: item.subDomain || null,
                        reason: cands.length > 1 ? 'ambiguous' : 'not_found',
                    });
                    continue;
                }
                report.matched++;
                const fr = txt(item.fr);
                const en = txt(item.en);
                if ((!fr && !en) || fr.length > DESC_MAX || en.length > DESC_MAX) {
                    report.invalid++;
                    continue;
                }
                for (const s of targets) {
                    if (txt(s.description) || txt(s.descriptionEn)) {
                        report.skippedDescribed++;
                        continue;
                    }
                    if (s.hasProposal || taken.has(Number(s.id))) {
                        report.skippedExisting++;
                        continue;
                    }
                    await db.run(
                        `INSERT INTO skill_description_proposals (skill_id, text_fr, text_en, source, status, created_by)
                         VALUES (?, ?, ?, 'starter', 'proposed', ?)`,
                        [s.id, fr || null, en || null, adminIdOf(actor)]
                    );
                    taken.add(Number(s.id));
                    report.inserted++;
                }
            }
        });
        await this._audit(
            'SKILL_DESCRIPTION_STARTER_LOADED',
            null,
            `starter pack: ${report.inserted} proposal(s) loaded, ${report.skippedDescribed} already described, ` +
                `${report.skippedExisting} already proposed, ${report.unmatched.length} unmatched, ${report.invalid} invalid`,
            actor
        );
        return report;
    }

    // --------------------------------------------------- direct edit (HR)
    /**
     * Write a skill's texts. `eraseEmpty`: the admin dialog (an emptied field
     * clears the text); false for the Excel import (an empty cell never erases).
     * A field that is `undefined` is never touched.
     * texts { descFr, descEn, fr0..fr4, en0..en4 }
     */
    async saveSkillTexts(skillId, texts, { eraseEmpty = false, actor = null, audit = true } = {}) {
        const id = Number(skillId);
        const t = texts || {};
        const changes = { description: false, anchors: 0 };
        const has = (k) => t[k] !== undefined;
        const set = [];
        const params = [];
        for (const [k, col] of [
            ['descFr', 'description'],
            ['descEn', 'description_en'],
        ]) {
            if (!has(k)) continue;
            const v = txt(t[k]);
            if (v.length > DESC_MAX) throw httpError('text_too_long');
            if (!v && !eraseEmpty) continue;
            set.push(`${col} = ?`);
            params.push(v || null);
        }
        // Validate every text BEFORE the first write: a refused row writes nothing.
        for (const n of LEVELS)
            for (const k of [`fr${n}`, `en${n}`])
                if (has(k) && txt(t[k]).length > ANCHOR_MAX) throw httpError('anchor_too_long');
        const work = async () => {
            if (set.length) {
                await db.run(
                    `UPDATE skills SET ${set.join(', ')}, updated_at = now() WHERE id = ?`,
                    [...params, id]
                );
                changes.description = true;
            }
            const touched = LEVELS.filter((n) => has(`fr${n}`) || has(`en${n}`));
            if (!touched.length) return;
            const current = await db.all(
                'SELECT level, anchor, anchor_en FROM proficiency_descriptors WHERE skill_id = ?',
                [id]
            );
            const cur = new Map((current || []).map((r) => [Number(r.level), r]));
            for (const n of touched) {
                const fr = has(`fr${n}`) ? txt(t[`fr${n}`]) : null;
                const en = has(`en${n}`) ? txt(t[`en${n}`]) : null;
                const old = cur.get(n) || {};
                let nfr;
                let nen;
                if (eraseEmpty) {
                    nfr = fr === null ? txt(old.anchor) : fr;
                    nen = en === null ? txt(old.anchorEn) : en;
                } else {
                    nfr = fr || txt(old.anchor);
                    nen = en || txt(old.anchorEn);
                }
                if (nfr === txt(old.anchor) && nen === txt(old.anchorEn)) continue;
                await SkillsIntelligenceService.setDescriptor(id, null, n, nfr, nen);
                changes.anchors++;
            }
        };
        await db.runTransaction(work);
        if (audit && (changes.description || changes.anchors))
            await this._audit(
                'SKILL_TEXTS_UPDATED',
                id,
                `skill texts updated (description: ${changes.description ? 'yes' : 'no'}, level anchors: ${changes.anchors})`,
                actor
            );
        return changes;
    }

    /** The five own anchors of each listed skill (admin dialog). One query. */
    async ownAnchors(skillIds) {
        const ids = [
            ...new Set(
                (skillIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
            ),
        ];
        const out = new Map();
        if (!ids.length) return out;
        const rows = await db.all(
            'SELECT skill_id, level, anchor, anchor_en FROM proficiency_descriptors WHERE skill_id = ANY(?::bigint[])',
            [ids]
        );
        for (const r of rows || []) {
            const k = String(r.skillId);
            if (!out.has(k)) out.set(k, {});
            out.get(k)[Number(r.level)] = { fr: r.anchor || '', en: r.anchorEn || '' };
        }
        return out;
    }

    // --------------------------------------------------------------- Excel
    async exportWorkbook() {
        const ExcelJS = require('exceljs');
        const rows = await db.all(
            `SELECT s.id, s.name, s.category, s.description, s.description_en,
                    d.name AS pillar, sd.name AS sub_domain
               FROM skills s
               JOIN domains d ON d.id = s.domain_id
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE s.is_active = true AND d.is_active = true
              ORDER BY d.name, sd.position NULLS LAST, sd.name, s.name, s.id`
        );
        const anchors = await this.ownAnchors(rows.map((r) => r.id));
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Skill_Texts');
        ws.columns = COLS.map((c) => ({
            header: c.labels[0],
            key: c.key,
            width: /^(desc|fr|en)/.test(c.key) ? 48 : 26,
        }));
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        for (const r of rows) {
            const a = anchors.get(String(r.id)) || {};
            const line = {
                pillar: r.pillar,
                subDomain: r.subDomain || '',
                skill: r.name,
                category: r.category || '',
                descFr: r.description || '',
                descEn: r.descriptionEn || '',
            };
            for (const n of LEVELS) {
                line[`fr${n}`] = (a[n] && a[n].fr) || '';
                line[`en${n}`] = (a[n] && a[n].en) || '';
            }
            ws.addRow(line);
        }
        return wb.xlsx.writeBuffer();
    }

    /** Header row → { key: columnIndex } using the aliases. */
    _mapHeader(row) {
        const map = {};
        const lookup = new Map();
        for (const c of COLS)
            for (const l of c.labels) if (!lookup.has(norm(l))) lookup.set(norm(l), c.key);
        row.eachCell({ includeEmpty: false }, (cell, col) => {
            const key = lookup.get(norm(txt(cell.value)));
            if (key && map[key] === undefined) map[key] = col;
        });
        return map;
    }

    async importWorkbook(buffer, actor) {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        try {
            require('../utils/importGuards').assertSafeXlsxBuffer(buffer); // zip-bomb guard (SA-09)
            await wb.xlsx.load(buffer);
        } catch (_) {
            throw httpError('workbook_unreadable');
        }
        const ws = wb.worksheets.find((w) => w.name === 'Skill_Texts') || wb.worksheets[0];
        if (!ws) throw httpError('workbook_empty');
        const head = this._mapHeader(ws.getRow(1));
        if (head.skill === undefined || head.pillar === undefined)
            throw httpError('workbook_missing_columns');
        if (ws.rowCount > 5001) throw httpError('workbook_too_large');

        const skills = await db.all(
            `SELECT s.id, s.name, d.name AS pillar, sd.name AS sub_domain
               FROM skills s
               JOIN domains d ON d.id = s.domain_id
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE s.is_active = true`
        );
        const full = new Map();
        const loose = new Map();
        for (const s of skills) {
            const kf = `${norm(s.pillar)}|${norm(s.subDomain)}|${norm(s.name)}`;
            const kl = `${norm(s.pillar)}|${norm(s.name)}`;
            if (!full.has(kf)) full.set(kf, []);
            full.get(kf).push(s);
            if (!loose.has(kl)) loose.set(kl, []);
            loose.get(kl).push(s);
        }

        const report = {
            rows: 0,
            skillsUpdated: 0,
            descriptions: 0,
            anchors: 0,
            unchanged: 0,
            unmatched: [],
            errors: [],
        };
        const cell = (row, key) =>
            head[key] === undefined ? undefined : txt(row.getCell(head[key]).value);
        await db.runTransaction(async () => {
            for (let i = 2; i <= ws.rowCount; i++) {
                const row = ws.getRow(i);
                const pillar = cell(row, 'pillar');
                const name = cell(row, 'skill');
                if (!pillar && !name) continue;
                report.rows++;
                const sub = cell(row, 'subDomain') || '';
                let targets = full.get(`${norm(pillar)}|${norm(sub)}|${norm(name)}`) || [];
                if (!targets.length) {
                    const l = loose.get(`${norm(pillar)}|${norm(name)}`) || [];
                    if (l.length === 1) targets = l;
                }
                if (!targets.length) {
                    report.unmatched.push({ row: i, pillar, subDomain: sub, skill: name });
                    continue;
                }
                const texts = {};
                for (const k of [
                    'descFr',
                    'descEn',
                    ...LEVELS.map((n) => `fr${n}`),
                    ...LEVELS.map((n) => `en${n}`),
                ]) {
                    const v = cell(row, k);
                    if (v) texts[k] = v; // an empty cell never erases
                }
                if (!Object.keys(texts).length) {
                    report.unchanged++;
                    continue;
                }
                for (const s of targets) {
                    try {
                        const ch = await this.saveSkillTexts(s.id, texts, {
                            eraseEmpty: false,
                            audit: false,
                        });
                        if (ch.description || ch.anchors) report.skillsUpdated++;
                        else report.unchanged++;
                        if (ch.description) report.descriptions++;
                        report.anchors += ch.anchors;
                    } catch (e) {
                        report.errors.push({ row: i, skill: name, code: e.code || 'error' });
                    }
                }
            }
        });
        await this._audit(
            'SKILL_TEXTS_IMPORTED',
            null,
            `skill texts import: ${report.rows} row(s), ${report.skillsUpdated} skill(s) updated ` +
                `(${report.descriptions} description(s), ${report.anchors} anchor(s)), ` +
                `${report.unmatched.length} unmatched, ${report.errors.length} error(s)`,
            actor
        );
        return report;
    }

    async _audit(action, skillId, details, actor) {
        try {
            await LogService.log({
                adminId: adminIdOf(actor),
                actorRef: actorRefOf(actor),
                action,
                entityType: 'skill',
                entityId: skillId || null,
                details,
            });
        } catch (_) {
            /* the audit trail is best-effort here; LogService already reports its own failures */
        }
    }
}

module.exports = new SkillDescriptionService();
