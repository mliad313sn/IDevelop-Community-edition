'use strict';
/**
 * 3.23.21 — skill descriptions on the REAL test database (idevelop_fixtures), every
 * test inside ONE transaction that is always rolled back.
 *
 *  · migration 154 applies from scratch AND twice: description_en, anchor_en,
 *    the proposals table, and exactly 20 generic category anchors (5 levels ×
 *    the 4 categories stored in skills.category);
 *  · SkillHelpService reads any number of skills in exactly TWO queries, a
 *    skill's own anchor wins over its category's, and a PROPOSAL is never
 *    returned (employees only ever see approved text);
 *  · approving copies the text into the skill (an empty language never erases),
 *    rejecting needs a reason, a decided proposal cannot be decided again;
 *  · the starter loader matches accent/case-insensitively, tolerates a
 *    sub-domain mismatch, skips described skills, is idempotent, reports misses;
 *  · the Excel export → import round-trip writes the new columns, an empty cell
 *    never erases, the skill count never moves;
 *  · setDescriptor treats empty as delete; descriptorsForSkills is batched.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');

// Runs against the opt-in fixture database (see CONTRIBUTING.md).
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '154_skill_descriptions.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn, { fresh = false } = {}) {
    let result = null;
    await db
        .runTransaction(async () => {
            const c = db._client();
            if (fresh) {
                // Simulate a database that never saw 154 (all inside the rolled-back tx).
                await c.query('DROP TABLE IF EXISTS skill_description_proposals');
                await c.query(
                    'ALTER TABLE skills DROP CONSTRAINT IF EXISTS chk_skills_description_len'
                );
                await c.query(
                    'ALTER TABLE skills DROP CONSTRAINT IF EXISTS chk_skills_description_en_len'
                );
                await c.query('ALTER TABLE skills DROP COLUMN IF EXISTS description_en');
                await c.query(
                    'ALTER TABLE proficiency_descriptors DROP CONSTRAINT IF EXISTS chk_prof_anchor_len'
                );
                await c.query(
                    'ALTER TABLE proficiency_descriptors DROP CONSTRAINT IF EXISTS chk_prof_anchor_en_len'
                );
                await c.query(
                    'ALTER TABLE proficiency_descriptors DROP COLUMN IF EXISTS anchor_en'
                );
                await c.query('DELETE FROM proficiency_descriptors WHERE skill_id IS NULL');
            }
            await c.query(MIGRATION);
            result = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return result;
}

async function admin() {
    const a = await db.get("SELECT id FROM admins ORDER BY (role = 'superadmin') DESC, id LIMIT 1");
    return { id: Number(a.id), userType: 'admin', role: 'superadmin' };
}
async function skillsOf(category, n) {
    return db.all(
        `SELECT s.id, s.name, d.name AS pillar, sd.name AS sub_domain
           FROM skills s JOIN domains d ON d.id = s.domain_id
           LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
          WHERE s.is_active = true AND s.category = ? AND sd.id IS NOT NULL
          ORDER BY s.id LIMIT ?`,
        [category, n]
    );
}

suite('migration 154 (rolled back)', () => {
    jest.setTimeout(60000);
    test('fresh AND re-applied: columns, table, 20 category anchors in FR + EN', async () => {
        const out = await inRolledBackTx(
            async () => {
                await db._client().query(MIGRATION); // second application: idempotent
                const cats = await db.all(
                    'SELECT DISTINCT category FROM skills WHERE category IS NOT NULL'
                );
                const anchors = await db.all(
                    `SELECT category, count(*)::int AS n,
                            bool_and(coalesce(anchor, '') <> '' AND coalesce(anchor_en, '') <> '') AS both_langs,
                            max(array_length(regexp_split_to_array(anchor, '\\s+'), 1)) AS max_words
                       FROM proficiency_descriptors WHERE skill_id IS NULL GROUP BY category`
                );
                const cols = await db.all(
                    `SELECT table_name, column_name FROM information_schema.columns
                      WHERE (table_name = 'skills' AND column_name = 'description_en')
                         OR (table_name = 'proficiency_descriptors' AND column_name = 'anchor_en')
                         OR (table_name = 'skill_description_proposals' AND column_name = 'status')`
                );
                let tooLong = null;
                try {
                    await db._client().query('SAVEPOINT s1');
                    await db
                        ._client()
                        .query(
                            "UPDATE skills SET description_en = repeat('x', 2001) WHERE id = (SELECT min(id) FROM skills)"
                        );
                } catch (e) {
                    tooLong = e.code;
                }
                await db._client().query('ROLLBACK TO SAVEPOINT s1');
                return { cats: cats.map((c) => c.category).sort(), anchors, cols, tooLong };
            },
            { fresh: true }
        );
        expect(out.cols).toHaveLength(3);
        expect(out.anchors.map((a) => a.category).sort()).toEqual(out.cats);
        expect(out.anchors.reduce((s, a) => s + a.n, 0)).toBe(20);
        out.anchors.forEach((a) => {
            expect(a.n).toBe(5);
            expect(a.bothLangs).toBe(true);
            expect(a.maxWords).toBeLessThanOrEqual(25);
        });
        expect(out.tooLong).toBe('23514');
    });
});

suite('SkillHelpService on the real schema (rolled back)', () => {
    jest.setTimeout(60000);
    const Help = () => require('../../src/services/SkillHelpService');
    const Desc = () => require('../../src/services/SkillDescriptionService');

    test('two queries for 40 skills; own anchor wins; a proposal is never returned', async () => {
        const out = await inRolledBackTx(async () => {
            const sk = await skillsOf('Technical', 40);
            const [first] = sk;
            await db.run(
                'UPDATE skills SET description = NULL, description_en = NULL WHERE id = ?',
                [first.id]
            );
            await db.run(
                "INSERT INTO proficiency_descriptors (skill_id, level, anchor, anchor_en) VALUES (?, 2, 'own FR', 'own EN')",
                [first.id]
            );
            await db.run(
                "INSERT INTO skill_description_proposals (skill_id, text_fr, text_en, source) VALUES (?, 'SECRET DRAFT', 'SECRET', 'hr')",
                [first.id]
            );
            const spy = jest.spyOn(db, 'all');
            const map = await Help().forSkills(sk.map((s) => s.id));
            const calls = spy.mock.calls.length;
            spy.mockRestore();
            return { calls, size: map.size, h: map.get(String(first.id)), n: sk.length };
        });
        expect(out.calls).toBe(2);
        expect(out.size).toBe(out.n);
        expect(out.h.anchors.skill[2]).toEqual({ fr: 'own FR', en: 'own EN' });
        expect(out.h.anchors.category[2].fr).toMatch(/\S/);
        expect(out.h.descriptionFr).toBeNull();
        expect(JSON.stringify(out.h)).not.toMatch(/SECRET/);
        const r = require('../../src/utils/skillHelp').resolve(out.h, 'fr', {
            words: [],
            titles: [],
        });
        expect(r.levels[2].text).toBe('own FR');
        expect(r.levels[0].source).toBe('category');
    });

    test('approve copies the text; an empty language never erases; reject needs a reason', async () => {
        const out = await inRolledBackTx(async () => {
            const actor = await admin();
            const [a, b] = await skillsOf('Safety', 2);
            await db.run(
                "UPDATE skills SET description = 'ancien FR', description_en = 'old EN' WHERE id = ?",
                [a.id]
            );
            const p1 = await db.get(
                "INSERT INTO skill_description_proposals (skill_id, text_fr, text_en) VALUES (?, 'nouveau FR', NULL) RETURNING id",
                [a.id]
            );
            await Desc().approve(p1.id, actor);
            const sa = await db.get('SELECT description, description_en FROM skills WHERE id = ?', [
                a.id,
            ]);
            const p1r = await db.get(
                'SELECT status, decided_by FROM skill_description_proposals WHERE id = ?',
                [p1.id]
            );
            let again = null;
            try {
                await Desc().approve(p1.id, actor);
            } catch (e) {
                again = e.code;
            }
            const p2 = await db.get(
                "INSERT INTO skill_description_proposals (skill_id, text_fr) VALUES (?, 'x') RETURNING id",
                [b.id]
            );
            let noReason = null;
            try {
                await Desc().reject(p2.id, '  ', actor);
            } catch (e) {
                noReason = e.code;
            }
            await Desc().reject(p2.id, 'hors sujet', actor);
            const p2r = await db.get(
                'SELECT status, reason FROM skill_description_proposals WHERE id = ?',
                [p2.id]
            );
            const sb = await db.get('SELECT description FROM skills WHERE id = ?', [b.id]);
            // An EN-only proposal keeps the French text.
            const p3 = await db.get(
                "INSERT INTO skill_description_proposals (skill_id, text_fr, text_en) VALUES (?, NULL, 'EN only') RETURNING id",
                [a.id]
            );
            await Desc().approve(p3.id, actor);
            const sa3 = await db.get(
                'SELECT description, description_en FROM skills WHERE id = ?',
                [a.id]
            );
            const log = await db.get(
                "SELECT count(*)::int AS n FROM system_logs WHERE action = 'SKILL_DESCRIPTION_APPROVED' AND entity_id = ?",
                [a.id]
            );
            return { sa, sa3, p1r, again, noReason, p2r, sb, log, actor };
        });
        expect(out.sa).toEqual({ description: 'nouveau FR', descriptionEn: 'old EN' });
        expect(out.sa3).toEqual({ description: 'nouveau FR', descriptionEn: 'EN only' });
        expect(out.p1r.status).toBe('approved');
        expect(Number(out.p1r.decidedBy)).toBe(out.actor.id);
        expect(out.again).toBe('proposal_not_open');
        expect(out.noReason).toBe('reason_required');
        expect(out.p2r).toEqual({ status: 'rejected', reason: 'hors sujet' });
        expect(out.sb.description).not.toBe('x');
        expect(out.log.n).toBe(2);
    });

    test('saveSkillTexts: import mode never erases; dialog mode clears an emptied field', async () => {
        const out = await inRolledBackTx(async () => {
            const [s] = await skillsOf('Technical', 1);
            await db.run(
                "UPDATE skills SET description = 'FR', description_en = 'EN' WHERE id = ?",
                [s.id]
            );
            await db.run(
                "INSERT INTO proficiency_descriptors (skill_id, level, anchor, anchor_en) VALUES (?, 2, 'a2', 'b2')",
                [s.id]
            );
            await Desc().saveSkillTexts(
                s.id,
                { descFr: '', descEn: '  ', fr2: '', en2: '' },
                { eraseEmpty: false, audit: false }
            );
            const kept = await db.get(
                'SELECT description, description_en FROM skills WHERE id = ?',
                [s.id]
            );
            const keptA = await db.get(
                'SELECT anchor, anchor_en FROM proficiency_descriptors WHERE skill_id = ? AND level = 2',
                [s.id]
            );
            await Desc().saveSkillTexts(
                s.id,
                { descEn: '', fr2: '', en2: '' },
                { eraseEmpty: true, audit: false }
            );
            const cleared = await db.get(
                'SELECT description, description_en FROM skills WHERE id = ?',
                [s.id]
            );
            const clearedA = await db.get(
                'SELECT count(*)::int AS n FROM proficiency_descriptors WHERE skill_id = ?',
                [s.id]
            );
            let tooLong = null;
            try {
                await Desc().saveSkillTexts(
                    s.id,
                    { fr1: 'x'.repeat(601) },
                    { eraseEmpty: true, audit: false }
                );
            } catch (e) {
                tooLong = e.code;
            }
            return { kept, keptA, cleared, clearedA: clearedA.n, tooLong };
        });
        expect(out.kept).toEqual({ description: 'FR', descriptionEn: 'EN' });
        expect(out.keptA).toEqual({ anchor: 'a2', anchorEn: 'b2' });
        expect(out.cleared).toEqual({ description: 'FR', descriptionEn: null });
        expect(out.clearedA).toBe(0);
        expect(out.tooLong).toBe('anchor_too_long');
    });

    test('bulk approve approves the open ones only', async () => {
        const out = await inRolledBackTx(async () => {
            const actor = await admin();
            const sk = await skillsOf('Behavioral', 3);
            const ids = [];
            for (const s of sk)
                ids.push(
                    (
                        await db.get(
                            "INSERT INTO skill_description_proposals (skill_id, text_fr) VALUES (?, 'bulk') RETURNING id",
                            [s.id]
                        )
                    ).id
                );
            await Desc().reject(ids[2], 'non', actor);
            const r = await Desc().bulkApprove(ids, actor);
            const n = await db.get(
                "SELECT count(*)::int AS n FROM skills WHERE id = ANY(?::bigint[]) AND description = 'bulk'",
                [sk.map((s) => s.id)]
            );
            return { r, n: n.n };
        });
        expect(out.r).toEqual({ approved: 2, skipped: 1 });
        expect(out.n).toBe(2);
    });

    test('starter loader: accent/case-insensitive, sub-domain tolerant, idempotent, reports misses', async () => {
        const out = await inRolledBackTx(async () => {
            const actor = await admin();
            const [a, b, c] = await skillsOf('Compliance', 3);
            await db.run(
                'UPDATE skills SET description = NULL, description_en = NULL WHERE id = ANY(?::bigint[])',
                [[a.id, b.id]]
            );
            await db.run("UPDATE skills SET description = 'déjà décrit' WHERE id = ?", [c.id]);
            const shout = (s) => s.toUpperCase();
            const accentless = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
            const data = {
                version: 1,
                items: [
                    {
                        pillar: shout(a.pillar),
                        subDomain: a.subDomain,
                        skill: accentless(shout(a.name)),
                        category: 'Compliance',
                        fr: 'FR a',
                        en: 'EN a',
                    },
                    {
                        pillar: b.pillar,
                        subDomain: 'un autre sous-domaine',
                        skill: b.name,
                        category: 'Compliance',
                        fr: 'FR b',
                        en: '',
                    },
                    {
                        pillar: c.pillar,
                        subDomain: c.subDomain,
                        skill: c.name,
                        fr: 'FR c',
                        en: 'EN c',
                    },
                    {
                        pillar: 'Nulle part',
                        subDomain: 'x',
                        skill: 'Compétence inconnue',
                        fr: 'y',
                        en: 'y',
                    },
                ],
            };
            const first = await Desc().loadStarter({ data, actor });
            const second = await Desc().loadStarter({ data, actor });
            const rows = await db.all(
                'SELECT skill_id, text_fr, text_en, status, source FROM skill_description_proposals WHERE skill_id = ANY(?::bigint[]) ORDER BY skill_id',
                [[a.id, b.id, c.id]]
            );
            const visible = await db.get('SELECT description FROM skills WHERE id = ?', [a.id]);
            return { first, second, rows, a, b, visible };
        });
        // b may share its name with another skill of the pillar; then it is ambiguous.
        expect(out.first.inserted).toBeGreaterThanOrEqual(1);
        expect(out.first.skippedDescribed).toBe(1);
        expect(out.first.unmatched.map((u) => u.skill)).toContain('Compétence inconnue');
        expect(out.second.inserted).toBe(0);
        expect(out.rows.every((r) => r.status === 'proposed' && r.source === 'starter')).toBe(true);
        expect(out.rows.find((r) => Number(r.skillId) === Number(out.a.id))).toEqual(
            expect.objectContaining({ textFr: 'FR a', textEn: 'EN a' })
        );
        // Never published by loading.
        expect(out.visible.description).toBeNull();
    });

    test('Excel export → import round-trip; an empty cell never erases; no skill added', async () => {
        const out = await inRolledBackTx(async () => {
            const actor = await admin();
            const [s] = await skillsOf('Technical', 1);
            await db.run(
                "UPDATE skills SET description = 'garder FR', description_en = NULL WHERE id = ?",
                [s.id]
            );
            await db.run(
                "INSERT INTO proficiency_descriptors (skill_id, level, anchor, anchor_en) VALUES (?, 1, 'n1 FR', 'n1 EN')",
                [s.id]
            );
            const before = await db.get('SELECT count(*)::int AS n FROM skills');
            const buf = await Desc().exportWorkbook();
            const ExcelJS = require('exceljs');
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buf);
            const ws = wb.getWorksheet('Skill_Texts');
            const header = ws.getRow(1).values.slice(1);
            let target = null;
            ws.eachRow((row, i) => {
                if (
                    i > 1 &&
                    row.getCell(3).value === s.name &&
                    row.getCell(1).value === s.pillar &&
                    row.getCell(2).value === (s.subDomain || '')
                )
                    target = target || row;
            });
            const col = (label) => header.indexOf(label) + 1;
            const exported = {
                descFr: target.getCell(col('Description FR')).value,
                fr1: target.getCell(col('Niveau 1 FR')).value,
                en1: target.getCell(col('Level 1 EN')).value,
            };
            target.getCell(col('Description FR')).value = ''; // empty: must NOT erase
            target.getCell(col('Description EN')).value = 'EN from Excel';
            target.getCell(col('Niveau 3 FR')).value = 'N3 depuis Excel';
            target.getCell(col('Level 1 EN')).value = ''; // empty: keeps 'n1 EN'
            const extra = ws.addRow([]);
            extra.getCell(1).value = 'Pilier inconnu';
            extra.getCell(3).value = 'Compétence inconnue';
            extra.getCell(col('Description FR')).value = 'rien';
            const out2 = await wb.xlsx.writeBuffer();
            const report = await Desc().importWorkbook(Buffer.from(out2), actor);
            const after = await db.get('SELECT count(*)::int AS n FROM skills');
            const sk = await db.get('SELECT description, description_en FROM skills WHERE id = ?', [
                s.id,
            ]);
            const an = await db.all(
                'SELECT level, anchor, anchor_en FROM proficiency_descriptors WHERE skill_id = ? ORDER BY level',
                [s.id]
            );
            return { header, exported, report, before, after, sk, an };
        });
        expect(out.header.slice(0, 6)).toEqual([
            'Pillar',
            'Sub-Domain',
            'Skill',
            'Category',
            'Description FR',
            'Description EN',
        ]);
        expect(out.header).toEqual(
            expect.arrayContaining(['Niveau 0 FR', 'Niveau 4 FR', 'Level 0 EN', 'Level 4 EN'])
        );
        expect(out.exported).toEqual({ descFr: 'garder FR', fr1: 'n1 FR', en1: 'n1 EN' });
        expect(out.sk).toEqual({ description: 'garder FR', descriptionEn: 'EN from Excel' });
        expect(out.an).toEqual([
            { level: 1, anchor: 'n1 FR', anchorEn: 'n1 EN' },
            { level: 3, anchor: 'N3 depuis Excel', anchorEn: null },
        ]);
        expect(out.report.unmatched).toEqual([
            expect.objectContaining({ skill: 'Compétence inconnue' }),
        ]);
        expect(out.after.n).toBe(out.before.n);
    });

    test('setDescriptor: empty is delete; descriptorsForSkills is one query, own anchor first', async () => {
        const out = await inRolledBackTx(async () => {
            const SIS = require('../../src/services/SkillsIntelligenceService');
            const [s, t] = await skillsOf('Safety', 2);
            await SIS.setDescriptor(s.id, null, 2, 'propre', 'own');
            const spy = jest.spyOn(db, 'all');
            const map = await SIS.descriptorsForSkills([s.id, t.id]);
            const calls = spy.mock.calls.length;
            spy.mockRestore();
            const cleared = await SIS.setDescriptor(s.id, null, 2, '  ', '');
            const left = await db.get(
                'SELECT count(*)::int AS n FROM proficiency_descriptors WHERE skill_id = ?',
                [s.id]
            );
            return {
                calls,
                own: map.get(String(s.id)),
                other: map.get(String(t.id)),
                cleared,
                left: left.n,
            };
        });
        expect(out.calls).toBe(1);
        expect(out.own).toHaveLength(5);
        expect(out.own[2]).toEqual(
            expect.objectContaining({ anchor: 'propre', anchorEn: 'own', source: 'skill' })
        );
        expect(out.own[0].source).toBe('category');
        expect(out.other.every((d) => d.source === 'category')).toBe(true);
        expect(out.cleared).toBeNull();
        expect(out.left).toBe(0);
    });
});
