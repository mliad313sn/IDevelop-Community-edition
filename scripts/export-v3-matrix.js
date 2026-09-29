'use strict';
/* eslint-disable no-console */
/**
 * Export the unified V3 capability framework to Excel for HR review:
 *   Sheet 1 "Capability Matrix" — Pillar > Sub-Domain > Skill, with source,
 *           category, role families, strategic link, duplicate flag.
 *   Sheet 2 "Sub-Domains"       — 49 competency elements + definitions + counts.
 *   Sheet 3 "Role Families"      — 56 families (standard/legacy) + skill counts.
 *   Sheet 4 "Summary".
 *
 *   node scripts/export-v3-matrix.js [outputPath.xlsx]
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../src/config/database');

const OUT = process.argv[2] || path.join(__dirname, '..', 'IDevelop-V3-Capability-Matrix.xlsx');
const HEADER = 'FF1D4ED8';
const SRC_FILL = { standard: 'FFDBEAFE', legacy: 'FFFEF3C7' };

function styleHeader(ws, lastCol) {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } };
    r.alignment = { vertical: 'middle', wrapText: true };
    r.height = 26;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: lastCol } };
}

(async () => {
    await db.connect();

    const skills = await db.all(`
        SELECT d.name AS domain, sd.name AS sub_domain, sd.position,
               s.name AS skill, s.category, s.source, s.is_duplicate,
               COALESCE(s.strategic_link, '') AS strategic_link,
               COALESCE((SELECT string_agg(rf.name, ', ' ORDER BY rf.name)
                         FROM skill_role_families srf JOIN role_families rf ON rf.id = srf.role_family_id
                         WHERE srf.skill_id = s.id), '') AS role_families
        FROM skills s
        JOIN sub_domains sd ON sd.id = s.sub_domain_id
        JOIN domains d ON d.id = sd.domain_id
        WHERE s.is_active = true
        ORDER BY d.name, sd.position, s.source DESC, s.name`);

    const subs = await db.all(`
        SELECT d.name AS domain, sd.name AS sub_domain, COALESCE(sd.definition,'') AS definition,
               (SELECT COUNT(*) FROM skills s WHERE s.sub_domain_id = sd.id AND s.is_active) AS skill_count
        FROM sub_domains sd JOIN domains d ON d.id = sd.domain_id
        ORDER BY d.name, sd.position`);

    const fams = await db.all(`
        SELECT rf.name, rf.origin,
               (SELECT COUNT(*) FROM skill_role_families srf WHERE srf.role_family_id = rf.id) AS skill_count
        FROM role_families rf ORDER BY rf.origin, rf.name`);

    await db.close();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'IDevelop';

    // ---- Sheet 1: Capability Matrix --------------------------------------
    const ws = wb.addWorksheet('Capability Matrix', { properties: { tabColor: { argb: HEADER } } });
    ws.columns = [
        { header: 'Pillar (Domain)', key: 'domain', width: 30 },
        { header: 'Sub-Domain', key: 'sub_domain', width: 32 },
        { header: 'Skill / Capability Item', key: 'skill', width: 46 },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Source', key: 'source', width: 10 },
        { header: 'Role Families', key: 'role_families', width: 40 },
        { header: 'Strategic Link', key: 'strategic_link', width: 34 },
        { header: 'Dup?', key: 'is_duplicate', width: 7 },
    ];
    for (const s of skills) {
        const row = ws.addRow({
            domain: s.domain,
            sub_domain: s.subDomain,
            skill: s.skill,
            category: s.category,
            source: s.source,
            role_families: s.roleFamilies,
            strategic_link: s.strategicLink,
            is_duplicate: s.isDuplicate ? 'yes' : '',
        });
        const f = SRC_FILL[s.source];
        if (f)
            row.getCell('source').fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: f },
            };
        row.getCell('skill').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('role_families').alignment = { wrapText: true, vertical: 'top' };
    }
    styleHeader(ws, 8);

    // ---- Sheet 2: Sub-Domains --------------------------------------------
    const wd = wb.addWorksheet('Sub-Domains');
    wd.columns = [
        { header: 'Pillar (Domain)', key: 'domain', width: 30 },
        { header: 'Sub-Domain (Competency Element)', key: 'sub_domain', width: 34 },
        { header: 'Definition', key: 'definition', width: 70 },
        { header: '# Skills', key: 'skill_count', width: 10 },
    ];
    for (const s of subs) {
        const row = wd.addRow({
            domain: s.domain,
            sub_domain: s.subDomain,
            definition: s.definition,
            skill_count: Number(s.skillCount),
        });
        row.getCell('definition').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('skill_count').alignment = { horizontal: 'center' };
    }
    styleHeader(wd, 4);

    // ---- Sheet 3: Role Families ------------------------------------------
    const wf = wb.addWorksheet('Role Families');
    wf.columns = [
        { header: 'Role Family', key: 'name', width: 40 },
        { header: 'Origin', key: 'origin', width: 12 },
        { header: '# Skills', key: 'skill_count', width: 10 },
    ];
    for (const f of fams) {
        const row = wf.addRow({
            name: f.name,
            origin: f.origin,
            skill_count: Number(f.skillCount),
        });
        row.getCell('skill_count').alignment = { horizontal: 'center' };
        const fill = SRC_FILL[f.origin];
        if (fill)
            row.getCell('origin').fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: fill },
            };
    }
    styleHeader(wf, 3);

    // ---- Sheet 4: Summary -------------------------------------------------
    const wsum = wb.addWorksheet('Summary');
    wsum.addRow(['IDevelop — Unified Capability Framework']).font = { bold: true, size: 14 };
    wsum.addRow([
        `Pillars: 6 · Sub-Domains: ${subs.length} · Role Families: ${fams.length} · Skills: ${skills.length}`,
    ]);
    wsum.addRow([
        `Standard items: ${skills.filter((s) => s.source === 'standard').length} · Legacy redistributed: ${skills.filter((s) => s.source === 'legacy').length} · Flagged duplicates: ${skills.filter((s) => s.isDuplicate).length}`,
    ]);
    wsum.addRow([]);
    const h = wsum.addRow(['Pillar', 'Sub-Domains', 'Skills']);
    h.font = { bold: true };
    const byDomain = {};
    for (const s of subs) {
        byDomain[s.domain] = byDomain[s.domain] || { subs: 0, skills: 0 };
        byDomain[s.domain].subs++;
        byDomain[s.domain].skills += Number(s.skillCount);
    }
    Object.entries(byDomain)
        .sort()
        .forEach(([d, v]) => wsum.addRow([d, v.subs, v.skills]));
    wsum.getColumn(1).width = 34;
    wsum.getColumn(2).width = 14;
    wsum.getColumn(3).width = 10;

    await wb.xlsx.writeFile(OUT);
    console.log(`✓ Wrote ${OUT}`);
    console.log(
        `  ${skills.length} skills · ${subs.length} sub-domains · ${fams.length} role families`
    );
})().catch((e) => {
    console.error('ERR', e.stack || e.message);
    process.exit(1);
});
