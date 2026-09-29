'use strict';

/**
 * SkillHelpService — what a skill and each of its levels mean, for the people
 * who RATE it (self-assessment) and REVIEW it (reviewer console, review page).
 *
 * Two queries for any number of skills, never one per row:
 *   1. the skills' FR/EN descriptions, category and sub-domain (name + definition);
 *   2. every level anchor that can apply — the skills' own rows and the
 *      category rows (skill_id IS NULL) — in one pass.
 *
 * What is NEVER read here: skills.strategic_link (not a description), the
 * person's validated level (anti-anchoring), and skill_description_proposals —
 * a draft is not a description until HR approves it.
 */
const db = require('../config/database');

function ids(list) {
    const out = [];
    const seen = new Set();
    for (const v of list || []) {
        const n = Number(v);
        if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) {
            seen.add(n);
            out.push(n);
        }
    }
    return out;
}

class SkillHelpService {
    /**
     * @param {Array<number|string>} skillIds
     * @returns {Promise<Map<string, object>>} skillId (string) → raw help
     *   { descriptionFr, descriptionEn, subDomainName, subDomainDefinition,
     *     category, anchors: { skill: {N:{fr,en}}, category: {N:{fr,en}} } }
     */
    async forSkills(skillIds) {
        const list = ids(skillIds);
        const out = new Map();
        if (!list.length) return out;
        const skills = await db.all(
            `SELECT s.id, s.category, s.description AS description_fr, s.description_en,
                    sd.name AS sub_domain_name, sd.definition AS sub_domain_definition
               FROM skills s
               LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
              WHERE s.id = ANY(?::bigint[])`,
            [list]
        );
        const anchors = await db.all(
            `SELECT skill_id, category, level, anchor, anchor_en
               FROM proficiency_descriptors
              WHERE skill_id = ANY(?::bigint[]) OR skill_id IS NULL`,
            [list]
        );
        const own = new Map();
        const byCat = new Map();
        for (const a of anchors || []) {
            const entry = { fr: a.anchor, en: a.anchorEn };
            if (a.skillId != null) {
                const k = String(a.skillId);
                if (!own.has(k)) own.set(k, {});
                own.get(k)[Number(a.level)] = entry;
            } else if (a.category) {
                if (!byCat.has(a.category)) byCat.set(a.category, {});
                byCat.get(a.category)[Number(a.level)] = entry;
            }
        }
        for (const s of skills || []) {
            const k = String(s.id);
            out.set(k, {
                descriptionFr: s.descriptionFr || null,
                descriptionEn: s.descriptionEn || null,
                subDomainName: s.subDomainName || null,
                subDomainDefinition: s.subDomainDefinition || null,
                category: s.category || null,
                anchors: { skill: own.get(k) || {}, category: byCat.get(s.category) || {} },
            });
        }
        return out;
    }

    /**
     * Attach `skillHelp` (raw, both languages) to each row that names a skill.
     * Best-effort: a failure leaves the rows untouched — the page then shows
     * the generic scale, never an error in place of the ratings.
     */
    async attach(rows, key = 'skillId') {
        if (!Array.isArray(rows) || !rows.length) return rows;
        try {
            const map = await this.forSkills(rows.map((r) => r && r[key]));
            for (const r of rows) {
                if (r && r[key] != null) r.skillHelp = map.get(String(r[key])) || null;
            }
        } catch (e) {
            console.error('SkillHelpService.attach:', e.message);
        }
        return rows;
    }
}

module.exports = new SkillHelpService();
