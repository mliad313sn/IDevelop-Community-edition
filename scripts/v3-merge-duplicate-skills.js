'use strict';

/**
 * v3-merge-duplicate-skills.js — merge duplicate skills within a sub-domain.
 *
 * Duplicate = same (sub_domain_id, lower(name)) with >1 member. For each group a
 * SURVIVOR is chosen (is_duplicate=false preferred, then lowest id); every other
 * member (LOSER) has its references re-pointed to the survivor and is then
 * SOFT-RETIRED (is_active=false, is_duplicate=true) — never deleted, so the
 * immutable assessment_history (append-only trigger) stays referentially intact.
 *
 * Collision handling per unique constraint:
 *   skill_assessments UNIQUE(employee_id, skill_id) — keep the newest assessed_at
 *     signal (survivor row upgraded from loser when the loser's is newer).
 *   role_skill_requirements UNIQUE(role_id, skill_id) — keep the STRICTER
 *     requirement (max level, OR of is_critical).
 *   self_assessments — one CURRENT measurement round per (employee, skill)
 *     (uq_sa_current_round, migration 113): colliding loser rows (and their
 *     dependent supervisor_reviews) are dropped; non-colliding move.
 *   junctions (skill_role_families, course_skill_map, action_skill_links) — move
 *     with NOT EXISTS guard, then drop remaining loser rows.
 *
 * Usage:  node scripts/v3-merge-duplicate-skills.js          (dry-run: report only)
 *         node scripts/v3-merge-duplicate-skills.js --apply  (execute in one tx)
 * DATABASE_URL selects the target DB (dev a development database via .env, or set explicitly for prod).
 */

require('dotenv').config();
const db = require('../src/config/database');

const APPLY = process.argv.includes('--apply');

// Plain re-point moves (no unique collision expected; FK-only tables).
const PLAIN_MOVES = [
    'coaching_plans',
    'coaching_sessions',
    'idp_objectives',
    'skill_suggestions',
    'training_plan_items',
];
// Junction-style: move with NOT EXISTS guard on the paired column, delete leftovers.
const JUNCTIONS = [
    { table: 'skill_role_families', pair: 'role_family_id' },
    { table: 'course_skill_map', pair: 'course_id' },
    { table: 'action_skill_links', pair: 'action_id' },
];

async function main() {
    await db.connect();

    const groups = await db.all(`
        SELECT sub_domain_id, lower(name) AS lname,
               array_agg(id ORDER BY (is_duplicate)::int, id) AS ids
        FROM skills
        GROUP BY sub_domain_id, lower(name)
        HAVING count(*) > 1
        ORDER BY sub_domain_id`);

    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${groups.length} duplicate group(s)`);
    if (!groups.length) {
        await db.close();
        return;
    }

    const stats = { moved: 0, upgraded: 0, dropped: 0, retired: 0 };

    const work = async () => {
        for (const g of groups) {
            const ids = g.ids.map(Number);
            const survivor = ids[0]; // non-flagged first, then lowest id
            const losers = ids.slice(1);
            console.log(
                `\n[${g.lname}] (sub_domain ${g.subDomainId}) survivor=${survivor} losers=${losers.join(',')}`
            );

            for (const loser of losers) {
                // -- skill_assessments: newest-signal merge ------------------------
                const upg = await db.run(
                    `
                    UPDATE skill_assessments s
                       SET current_level = l.current_level, assessed_at = l.assessed_at,
                           assessed_by = l.assessed_by, notes = l.notes
                      FROM skill_assessments l
                     WHERE s.skill_id = ? AND l.skill_id = ?
                       AND s.employee_id = l.employee_id
                       AND l.assessed_at > s.assessed_at`,
                    [survivor, loser]
                );
                stats.upgraded += upg.changes || 0;
                const mvSA = await db.run(
                    `
                    UPDATE skill_assessments SET skill_id = ? WHERE skill_id = ?
                       AND NOT EXISTS (SELECT 1 FROM skill_assessments k
                                        WHERE k.employee_id = skill_assessments.employee_id
                                          AND k.skill_id = ?)`,
                    [survivor, loser, survivor]
                );
                stats.moved += mvSA.changes || 0;
                const delSA = await db.run('DELETE FROM skill_assessments WHERE skill_id = ?', [
                    loser,
                ]);
                stats.dropped += delSA.changes || 0;

                // -- role_skill_requirements: keep stricter ------------------------
                await db.run(
                    `
                    UPDATE role_skill_requirements s
                       SET required_level = GREATEST(s.required_level, l.required_level),
                           is_critical = (s.is_critical OR l.is_critical)
                      FROM role_skill_requirements l
                     WHERE s.skill_id = ? AND l.skill_id = ? AND s.role_id = l.role_id`,
                    [survivor, loser]
                );
                const mvR = await db.run(
                    `
                    UPDATE role_skill_requirements SET skill_id = ? WHERE skill_id = ?
                       AND NOT EXISTS (SELECT 1 FROM role_skill_requirements k
                                        WHERE k.role_id = role_skill_requirements.role_id
                                          AND k.skill_id = ?)`,
                    [survivor, loser, survivor]
                );
                stats.moved += mvR.changes || 0;
                const delR = await db.run(
                    'DELETE FROM role_skill_requirements WHERE skill_id = ?',
                    [loser]
                );
                stats.dropped += delR.changes || 0;

                // -- self_assessments (+ dependent supervisor_reviews) -------------
                // Migration 113 replaced UNIQUE(employee_id, skill_id, status) with
                // "at most ONE CURRENT round per (employee, skill)". The collision
                // guard has to match THAT key, so it no longer compares `status`:
                // moving a loser row onto a survivor the person already holds is
                // what would violate uq_sa_current_round. `self_assessments` is the
                // current-round view, so the merge moves the live measurement and
                // the earlier rounds follow the skill's own ON DELETE CASCADE.
                const mvSelf = await db.run(
                    `
                    UPDATE self_assessments SET skill_id = ? WHERE skill_id = ?
                       AND NOT EXISTS (SELECT 1 FROM self_assessments k
                                        WHERE k.employee_id = self_assessments.employee_id
                                          AND k.skill_id = ?)`,
                    [survivor, loser, survivor]
                );
                stats.moved += mvSelf.changes || 0;
                const delRev = await db.run(
                    `
                    DELETE FROM supervisor_reviews WHERE self_assessment_id IN
                        (SELECT id FROM self_assessment_rounds WHERE skill_id = ?)`,
                    [loser]
                );
                const delSelf = await db.run(
                    'DELETE FROM self_assessment_rounds WHERE skill_id = ?',
                    [loser]
                );
                stats.dropped += (delRev.changes || 0) + (delSelf.changes || 0);
                // supervisor_reviews that survived via their moved self_assessment: fix skill_id
                await db.run(
                    `
                    UPDATE supervisor_reviews SET skill_id = ? WHERE skill_id = ?`,
                    [survivor, loser]
                );

                // -- plain moves ---------------------------------------------------
                for (const t of PLAIN_MOVES) {
                    const r = await db.run(`UPDATE ${t} SET skill_id = ? WHERE skill_id = ?`, [
                        survivor,
                        loser,
                    ]);
                    stats.moved += r.changes || 0;
                }

                // -- junctions -----------------------------------------------------
                for (const j of JUNCTIONS) {
                    const mv = await db.run(
                        `
                        UPDATE ${j.table} SET skill_id = ? WHERE skill_id = ?
                           AND NOT EXISTS (SELECT 1 FROM ${j.table} k
                                            WHERE k.${j.pair} = ${j.table}.${j.pair}
                                              AND k.skill_id = ?)`,
                        [survivor, loser, survivor]
                    );
                    stats.moved += mv.changes || 0;
                    const del = await db.run(`DELETE FROM ${j.table} WHERE skill_id = ?`, [loser]);
                    stats.dropped += del.changes || 0;
                }

                // -- proficiency_descriptors: guard on (skill_id, level) -----------
                const mvPd = await db.run(
                    `
                    UPDATE proficiency_descriptors SET skill_id = ? WHERE skill_id = ?
                       AND NOT EXISTS (SELECT 1 FROM proficiency_descriptors k
                                        WHERE k.skill_id = ? AND k.level = proficiency_descriptors.level)`,
                    [survivor, loser, survivor]
                );
                stats.moved += mvPd.changes || 0;
                const delPd = await db.run(
                    'DELETE FROM proficiency_descriptors WHERE skill_id = ?',
                    [loser]
                );
                stats.dropped += delPd.changes || 0;

                // -- skill_relationships (both columns; drop self-relations) -------
                await db.run(
                    `
                    UPDATE skill_relationships SET skill_a = ? WHERE skill_a = ?
                       AND NOT EXISTS (SELECT 1 FROM skill_relationships k
                                        WHERE k.skill_a = ? AND k.skill_b = skill_relationships.skill_b)`,
                    [survivor, loser, survivor]
                );
                await db.run(
                    `
                    UPDATE skill_relationships SET skill_b = ? WHERE skill_b = ?
                       AND NOT EXISTS (SELECT 1 FROM skill_relationships k
                                        WHERE k.skill_b = ? AND k.skill_a = skill_relationships.skill_a)`,
                    [survivor, loser, survivor]
                );
                await db.run('DELETE FROM skill_relationships WHERE skill_a = ? OR skill_b = ?', [
                    loser,
                    loser,
                ]);
                await db.run('DELETE FROM skill_relationships WHERE skill_a = skill_b');

                // -- soft-retire the loser (assessment_history keeps its FK target)
                await db.run(
                    'UPDATE skills SET is_active = false, is_duplicate = true WHERE id = ?',
                    [loser]
                );
                stats.retired++;
            }
        }
    };

    if (APPLY) {
        await db.runTransaction(work);
    } else {
        // Dry-run: run the same work inside a transaction and roll it back.
        try {
            await db.runTransaction(async () => {
                await work();
                throw new Error('__DRYRUN_ROLLBACK__');
            });
        } catch (e) {
            if (e.message !== '__DRYRUN_ROLLBACK__') throw e;
        }
    }

    console.log(
        `\n${APPLY ? 'APPLIED' : 'DRY-RUN (rolled back)'} — moved:${stats.moved} upgraded:${stats.upgraded} dropped:${stats.dropped} retired:${stats.retired}`
    );

    // Post-check: remaining ACTIVE duplicate groups must be zero after apply.
    const remain = await db.all(`
        SELECT count(*)::int AS n FROM (
            SELECT 1 FROM skills WHERE is_active GROUP BY sub_domain_id, lower(name) HAVING count(*) > 1
        ) x`);
    console.log('active duplicate groups remaining:', remain[0].n);
    await db.close();
}

main().catch((e) => {
    console.error('MERGE FAILED:', e.message);
    process.exit(1);
});
