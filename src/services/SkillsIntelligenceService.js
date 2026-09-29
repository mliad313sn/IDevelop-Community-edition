'use strict';

/**
 * SkillsIntelligenceService — skills graph (adjacency/relationships), proficiency
 * descriptors, and gap→learning recommendations. The graph turns a flat skill
 * list into a network so gap analysis, mobility matching and reskilling can use
 * "nearest adjacent skill", and completions can suggest the next course.
 */
const db = require('../config/database');

class SkillsIntelligenceService {
    // ---- Graph -------------------------------------------------------------
    async relate(skillA, skillB, relation = 'related', weight = 0.5) {
        if (Number(skillA) === Number(skillB)) throw new Error('a skill cannot relate to itself');
        return db.get(
            `INSERT INTO skill_relationships (skill_a, skill_b, relation, weight)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (skill_a, skill_b, relation) DO UPDATE SET weight = EXCLUDED.weight
             RETURNING *`,
            [skillA, skillB, relation, Math.max(0, Math.min(1, Number(weight) || 0.5))]
        );
    }

    /** Skills adjacent to a given skill (both directions). */
    async adjacent(skillId, limit = 10) {
        return db.all(
            `SELECT s.id AS skill_id, s.name AS skill_name, r.relation, r.weight
             FROM skill_relationships r
             JOIN skills s ON s.id = CASE WHEN r.skill_a = ? THEN r.skill_b ELSE r.skill_a END
             WHERE (r.skill_a = ? OR r.skill_b = ?)
             ORDER BY r.weight DESC, s.name
             LIMIT ?`,
            [skillId, skillId, skillId, limit]
        );
    }

    // ---- Proficiency descriptors ------------------------------------------
    /**
     * One anchor per (skill, level) or (category, level): any prior one is
     * replaced, never accumulated. 3.23.21: `anchorEn` is the English text;
     * BOTH texts empty means "no anchor for this level" — the row is removed and
     * the level falls back to the category anchor, then to the generic scale.
     * Returns the stored row, or null when the level was cleared.
     */
    async setDescriptor(skillId, category, level, anchor, anchorEn) {
        const lvl = Number(level);
        if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4) throw new Error('level must be 0-4');
        if (!skillId && !category) throw new Error('a descriptor needs a skill or a category');
        const fr = anchor == null ? '' : String(anchor).trim();
        const en = anchorEn == null ? '' : String(anchorEn).trim();
        if (fr.length > 600 || en.length > 600)
            throw new Error('anchor longer than 600 characters');
        return db.runTransaction(async () => {
            if (skillId)
                await db.run(
                    'DELETE FROM proficiency_descriptors WHERE skill_id = ? AND level = ?',
                    [skillId, lvl]
                );
            else
                await db.run(
                    'DELETE FROM proficiency_descriptors WHERE skill_id IS NULL AND category = ? AND level = ?',
                    [category, lvl]
                );
            if (!fr && !en) return null;
            return db.get(
                'INSERT INTO proficiency_descriptors (skill_id, category, level, anchor, anchor_en) VALUES (?, ?, ?, ?, ?) RETURNING *',
                [skillId || null, skillId ? null : category, lvl, fr, en || null]
            );
        });
    }
    /** The anchors that apply to one skill, one per level — the skill's own wins. */
    async descriptorsForSkill(skillId) {
        const map = await this.descriptorsForSkills([skillId]);
        return map.get(String(skillId)) || [];
    }
    /**
     * Batched: ONE query for any number of skills (skill_id = ANY(?) OR the
     * category rows), deduplicated per level — a skill's own anchor wins over
     * its category's. Map skillId → [{ level, anchor, anchorEn, source }].
     */
    async descriptorsForSkills(skillIds) {
        const ids = [
            ...new Set(
                (skillIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
            ),
        ];
        const out = new Map();
        if (!ids.length) return out;
        const rows = await db.all(
            `SELECT pd.skill_id, pd.category, pd.level, pd.anchor, pd.anchor_en, s.id AS for_skill
               FROM skills s
               JOIN proficiency_descriptors pd
                 ON pd.skill_id = s.id OR (pd.skill_id IS NULL AND pd.category = s.category)
              WHERE s.id = ANY(?::bigint[])
              ORDER BY s.id, pd.level`,
            [ids]
        );
        const acc = new Map();
        for (const r of rows || []) {
            const k = String(r.forSkill);
            if (!acc.has(k)) acc.set(k, new Map());
            const lv = acc.get(k);
            const own = r.skillId != null;
            const prev = lv.get(Number(r.level));
            if (!prev || (own && prev.source !== 'skill'))
                lv.set(Number(r.level), {
                    level: Number(r.level),
                    anchor: r.anchor,
                    anchorEn: r.anchorEn || null,
                    source: own ? 'skill' : 'category',
                });
        }
        for (const [k, lv] of acc)
            out.set(
                k,
                [...lv.values()].sort((a, b) => a.level - b.level)
            );
        return out;
    }

    // ---- gap → learning recommendation ------------------------------------
    /**
     * For an employee, find the skills they're short on (vs their role) and, for
     * each, recommend a mapped LMS course (plus adjacent skills they already have
     * that make it learnable). Closes the loop the other way from LmsService.
     *
     * A required skill with NO assessment is not a gap of size `required`: the
     * level is unknown, so the right next step is to MEASURE it, not to train
     * it. Such skills come back as separate items `{ status: 'not_assessed',
     * gap: null, recommendedAction: 'assessment' }` after the measured gaps
     * (`status: 'gap'`, `recommendedAction: 'training'`) and never carry a course.
     */
    async recommendLearning(employeeId, limit = 10) {
        const gaps = await db.all(
            `SELECT s.id AS skill_id, s.name AS skill_name, rsr.required_level AS required,
                    sa.current_level AS current
             FROM employees e
             JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
             JOIN skills s ON s.id = rsr.skill_id
             JOIN skill_assessments sa ON sa.employee_id = e.id AND sa.skill_id = rsr.skill_id
             WHERE e.id = ? AND rsr.required_level > sa.current_level
             ORDER BY (rsr.required_level - sa.current_level) DESC, rsr.is_critical DESC
             LIMIT ?`,
            [employeeId, limit]
        );
        const notAssessed = await db.all(
            `SELECT s.id AS skill_id, s.name AS skill_name, rsr.required_level AS required
             FROM employees e
             JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
             JOIN skills s ON s.id = rsr.skill_id
             WHERE e.id = ? AND rsr.required_level > 0
               AND NOT EXISTS (SELECT 1 FROM skill_assessments sa
                                WHERE sa.employee_id = e.id AND sa.skill_id = rsr.skill_id)
             ORDER BY rsr.is_critical DESC, s.name
             LIMIT ?`,
            [employeeId, limit]
        );
        const out = [];
        for (const g of gaps) {
            // best mapped course for this skill, preferring an enabled provider
            const course = await db.get(
                `SELECT c.id, c.title, c.provider, c.url FROM course_skill_map m
                 JOIN lms_courses c ON c.id = m.course_id
                 LEFT JOIN lms_integrations i ON i.provider = c.provider
                 WHERE m.skill_id = ?
                 ORDER BY (i.enabled IS TRUE) DESC, m.level_delta DESC, c.id LIMIT 1`,
                [g.skillId]
            );
            out.push({
                skillId: g.skillId,
                skillName: g.skillName,
                status: 'gap',
                recommendedAction: 'training',
                required: Number(g.required),
                current: Number(g.current),
                gap: Number(g.required) - Number(g.current),
                course: course
                    ? {
                          id: course.id,
                          title: course.title,
                          provider: course.provider,
                          url: course.url,
                      }
                    : null,
            });
        }
        for (const n of notAssessed || []) {
            out.push({
                skillId: n.skillId,
                skillName: n.skillName,
                status: 'not_assessed',
                recommendedAction: 'assessment',
                required: Number(n.required),
                current: null,
                gap: null,
                course: null,
            });
        }
        return out;
    }

    // ---- Skills inference (on-prem, no LLM) --------------------------------
    /**
     * Infer skills an employee likely has but isn't assessed on, from existing
     * signals: a current certification on the skill (strongest), completed
     * courses → mapped skills (strong), IDP development
     * objectives (medium), and skills-graph adjacency to skills they already hold
     * at level ≥2 (weaker). Upserts pending `skill_suggestions` for human review;
     * excludes skills already assessed (>0) or previously decided. Returns the
     * ranked suggestions.
     */
    async inferSkills(employeeId) {
        const cand = new Map(); // skillId -> { confidence, sources:Set }
        const add = (id, conf, src) => {
            id = Number(id);
            if (!id) return;
            const e = cand.get(id) || { confidence: 0, sources: new Set() };
            e.confidence = Math.max(e.confidence, conf);
            e.sources.add(src);
            cand.set(id, e);
        };

        // 0) The certification register — the strongest evidence there is: a
        //    certificate / VOC sign-off recorded against the skill itself. Only a
        //    CURRENT one counts: v_certification_current already keeps the latest
        //    non-revoked, non-future-dated record per (employee, skill); an
        //    expired one is not evidence the person holds the skill today.
        //    Still only a SUGGESTION — a human accepts it (never an official level).
        try {
            const rows = await db.all(
                `SELECT DISTINCT cc.skill_id FROM v_certification_current cc
                 WHERE cc.employee_id = ? AND cc.cert_status IN ('valid', 'expiring', 'no_expiry')`,
                [employeeId]
            );
            rows.forEach((r) => add(r.skillId, 0.95, 'certification'));
        } catch (_) {
            /* certification register optional (pre-migration-56 schema) */
        }

        // 1) Completed courses → the skills those courses build.
        try {
            const rows = await db.all(
                `SELECT DISTINCT m.skill_id FROM lms_completions c
                 JOIN course_skill_map m ON m.course_id = c.course_id
                 WHERE c.employee_id = ?`,
                [employeeId]
            );
            rows.forEach((r) => add(r.skillId, 0.9, 'completed_course'));
        } catch (_) {
            /* lms optional */
        }

        // 2) IDP objectives referencing a skill (active development intent).
        try {
            const rows = await db.all(
                `SELECT DISTINCT o.skill_id FROM idp_objectives o
                 JOIN idp_plans p ON p.id = o.idp_id
                 WHERE p.employee_id = ? AND o.skill_id IS NOT NULL`,
                [employeeId]
            );
            rows.forEach((r) => add(r.skillId, 0.55, 'idp_objective'));
        } catch (_) {
            /* idp optional */
        }

        // 3) Adjacency: skills adjacent to ones held at level ≥2 are "learnable".
        try {
            const held = await db.all(
                'SELECT skill_id FROM skill_assessments WHERE employee_id = ? AND current_level >= 2',
                [employeeId]
            );
            for (const h of held) {
                const adj = await this.adjacent(h.skillId, 5);
                adj.forEach((a) => add(a.skillId, 0.3 + 0.4 * Number(a.weight || 0.5), 'adjacent'));
            }
        } catch (_) {
            /* graph optional */
        }

        // Exclude already-assessed (>0) and already-decided skills.
        const assessed = new Set(
            (
                await db
                    .all(
                        'SELECT skill_id FROM skill_assessments WHERE employee_id = ? AND current_level > 0',
                        [employeeId]
                    )
                    .catch(() => [])
            ).map((r) => Number(r.skillId))
        );
        const decided = new Set(
            (
                await db
                    .all(
                        "SELECT skill_id FROM skill_suggestions WHERE employee_id = ? AND status IN ('accepted','dismissed')",
                        [employeeId]
                    )
                    .catch(() => [])
            ).map((r) => Number(r.skillId))
        );

        const results = [];
        for (const [skillId, info] of cand) {
            if (assessed.has(skillId) || decided.has(skillId)) continue;
            const sk = await db.get('SELECT name FROM skills WHERE id = ?', [skillId]);
            if (!sk) continue;
            const src = [...info.sources].join(',');
            const conf = Math.min(0.99, info.confidence);
            try {
                await db.run(
                    `INSERT INTO skill_suggestions (employee_id, skill_id, confidence, source, status)
                     VALUES (?, ?, ?, ?, 'pending')
                     ON CONFLICT (employee_id, skill_id) WHERE status = 'pending'
                     DO UPDATE SET confidence = EXCLUDED.confidence, source = EXCLUDED.source`,
                    [employeeId, skillId, conf.toFixed(2), src]
                );
            } catch (_) {
                /* skip dup */
            }
            results.push({
                skillId,
                skillName: sk.name,
                confidence: Number(conf.toFixed(2)),
                source: src,
            });
        }
        return results.sort((a, b) => b.confidence - a.confidence);
    }

    async listSuggestions(employeeId) {
        return db.all(
            `SELECT ss.id, ss.skill_id, s.name AS skill_name, ss.confidence, ss.source, ss.status, ss.created_at
             FROM skill_suggestions ss JOIN skills s ON s.id = ss.skill_id
             WHERE ss.employee_id = ? AND ss.status = 'pending'
             ORDER BY ss.confidence DESC, s.name`,
            [employeeId]
        );
    }

    /** Which employee a suggestion is about — for route-level scope checks. */
    async suggestionEmployeeId(suggestionId) {
        const s = await db.get('SELECT employee_id FROM skill_suggestions WHERE id = ?', [
            suggestionId,
        ]);
        return s ? Number(s.employeeId ?? s.employee_id) : null;
    }

    /** Accept a suggestion → write a skill assessment (never lowers an existing level). */
    async acceptSuggestion(suggestionId, { level = 1, adminId = null } = {}) {
        const s = await db.get(
            "SELECT employee_id, skill_id FROM skill_suggestions WHERE id = ? AND status = 'pending'",
            [suggestionId]
        );
        if (!s) throw new Error('Suggestion not found or already decided');
        await db.runTransaction(async () => {
            // Resolve the actor once and attribute BOTH the decision and the
            // resulting skill assessment to it (previously decided_by could be NULL
            // while assessed_by used the fallback admin — an inconsistent trail).
            const by =
                adminId ||
                (await db.get("SELECT id FROM admins WHERE username = 'admin'"))?.id ||
                null;
            await db.run(
                "UPDATE skill_suggestions SET status = 'accepted', decided_at = now(), decided_by = ? WHERE id = ?",
                [by, suggestionId]
            );
            await db.run(
                `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
                 VALUES (?, ?, ?, ?, 'Accepted skill suggestion')
                 ON CONFLICT (employee_id, skill_id) DO UPDATE SET
                   current_level = GREATEST(skill_assessments.current_level, EXCLUDED.current_level),
                   assessed_by = EXCLUDED.assessed_by, assessed_at = now()`,
                [s.employeeId, s.skillId, Math.max(0, Math.min(4, Number(level) || 1)), by]
            );
        });
        return { ok: true };
    }

    async dismissSuggestion(suggestionId, adminId = null) {
        await db.run(
            "UPDATE skill_suggestions SET status = 'dismissed', decided_at = now(), decided_by = ? WHERE id = ? AND status = 'pending'",
            [adminId, suggestionId]
        );
        return { ok: true };
    }
}

module.exports = new SkillsIntelligenceService();
