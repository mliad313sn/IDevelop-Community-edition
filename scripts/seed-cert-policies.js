'use strict';

/**
 * seed-cert-policies.js — apply a default certification/currency policy across
 * every skill of a pillar (default: the "Compliance & Certification"
 * pillar), so expiry tracking starts working org-wide instead of skill-by-skill.
 *
 * SAFE BY DEFAULT:
 *   - dry-run unless --commit is passed (prints exactly what would change)
 *   - never overwrites an existing per-skill policy (manual tuning wins);
 *     pass --force to update existing rows too
 *
 * Usage:
 *   node scripts/seed-cert-policies.js                       # dry-run, defaults
 *   node scripts/seed-cert-policies.js --commit              # apply
 *   node scripts/seed-cert-policies.js --pillar "Compliance" --validity 24 --window 90 --decay 24 --commit
 *   node scripts/seed-cert-policies.js --force --commit      # also update existing policies
 *
 * Defaults: validity 24 months · revalidation window 90 days · decay 24 months.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}

(async () => {
    const db = require('../src/config/database');
    await db.connect();

    const pillar = String(arg('pillar', 'Compliance & Certification'));
    const validity = parseInt(arg('validity', 24), 10);
    const windowDays = parseInt(arg('window', 90), 10);
    const decay = parseInt(arg('decay', 24), 10);
    const commit = process.argv.includes('--commit');
    const force = process.argv.includes('--force');

    if (!Number.isFinite(validity) || validity < 1 || validity > 120)
        throw new Error('--validity must be 1..120 months');
    if (!Number.isFinite(windowDays) || windowDays < 7 || windowDays > 365)
        throw new Error('--window must be 7..365 days');
    if (!Number.isFinite(decay) || decay < 1 || decay > 120)
        throw new Error('--decay must be 1..120 months');

    const dom = await db.get(
        'SELECT id, name FROM domains WHERE name ILIKE ? ORDER BY id LIMIT 1',
        ['%' + pillar + '%']
    );
    if (!dom) throw new Error(`No pillar/domain matching "${pillar}"`);

    // Skills of the pillar: V3 primary path is skill → sub_domain → domain;
    // legacy direct skill.domain_id rows are included as a fallback union.
    const skills = await db.all(
        `SELECT DISTINCT s.id, s.name,
                (p.skill_id IS NOT NULL) AS "hasPolicy"
           FROM skills s
           LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
           LEFT JOIN skill_certification_policies p ON p.skill_id = s.id
          WHERE sd.domain_id = ? OR s.domain_id = ?
          ORDER BY s.name`,
        [dom.id, dom.id]
    );

    const toCreate = skills.filter((s) => !s.hasPolicy);
    const toUpdate = force ? skills.filter((s) => s.hasPolicy) : [];
    const skipped = force ? [] : skills.filter((s) => s.hasPolicy);

    console.log(`Pillar   : ${dom.name} (domain ${dom.id})`);
    console.log(
        `Policy   : validity ${validity}mo · revalidation window ${windowDays}d · decay ${decay}mo`
    );
    console.log(
        `Skills   : ${skills.length} in pillar — ${toCreate.length} to create, ${toUpdate.length} to update (--force), ${skipped.length} kept (existing policy)`
    );
    if (!commit) {
        for (const s of toCreate.slice(0, 15)) console.log(`  + ${s.name}`);
        if (toCreate.length > 15) console.log(`  … and ${toCreate.length - 15} more`);
        console.log('\nDRY-RUN — nothing written. Re-run with --commit to apply.');
        await db.close();
        return;
    }

    let created = 0,
        updated = 0;
    for (const s of [...toCreate, ...toUpdate]) {
        await db.run(
            `INSERT INTO skill_certification_policies
                (skill_id, is_certification, validity_months, revalidation_window_days, decay_months)
             VALUES (?, true, ?, ?, ?)
             ON CONFLICT (skill_id) DO UPDATE SET
                validity_months = EXCLUDED.validity_months,
                revalidation_window_days = EXCLUDED.revalidation_window_days,
                decay_months = EXCLUDED.decay_months,
                updated_at = now()`,
            [s.id, validity, windowDays, decay]
        );
        if (s.hasPolicy) updated++;
        else created++;
    }
    console.log(
        `APPLIED — ${created} policies created, ${updated} updated, ${skipped.length} left untouched.`
    );
    await db.close();
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
