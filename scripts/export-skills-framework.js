'use strict';
/* eslint-disable no-console */
/**
 * Export the current skills framework to Excel, structured for MERGING with an
 * external framework. Each skill carries its Section (Domain) + Category, usage
 * signal (how many roles require it, at what level), and EMPTY mapping columns to
 * fill in while reconciling against the other framework.
 *
 *   node scripts/export-skills-framework.js [outputPath.xlsx]
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../src/config/database');

const OUT = process.argv[2] || path.join(__dirname, '..', 'IDevelop-Skills-Framework-Matrix.xlsx');

// Category → fill colour (ARGB).
const CAT_FILL = {
    Technical: 'FFDBEAFE', // blue-100
    Behavioral: 'FFD1FAE5', // green-100
    Compliance: 'FFEDE9FE', // violet-100
    Safety: 'FFFEF3C7', // amber-100
};
const HEADER_FILL = 'FF1D4ED8';

function styleHeader(ws, lastCol) {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    r.alignment = { vertical: 'middle', wrapText: true };
    r.height = 28;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: lastCol } };
}

(async () => {
    await db.connect();

    const skills = await db.all(
        `SELECT s.id, s.name AS skill, COALESCE(s.description, '') AS description,
                d.name AS domain, s.category,
                (SELECT COUNT(*) FROM role_skill_requirements r WHERE r.skill_id = s.id) AS roles_requiring,
                (SELECT COALESCE(ROUND(AVG(r.required_level), 1), 0) FROM role_skill_requirements r WHERE r.skill_id = s.id) AS avg_required,
                (SELECT COALESCE(MAX(r.required_level), 0) FROM role_skill_requirements r WHERE r.skill_id = s.id) AS max_required
         FROM skills s JOIN domains d ON d.id = s.domain_id
         WHERE s.is_active = true
         ORDER BY s.category, d.name, s.name`
    );
    const domains = await db.all(
        `SELECT d.name AS domain,
                (SELECT string_agg(DISTINCT s.category, ', ' ORDER BY s.category)
                   FROM skills s WHERE s.domain_id = d.id AND s.is_active = true) AS categories,
                (SELECT COUNT(*) FROM skills s WHERE s.domain_id = d.id AND s.is_active = true) AS skill_count
         FROM domains d WHERE d.is_active = true
         ORDER BY d.name`
    );
    const cats = await db.all(
        'SELECT category, COUNT(*)::int n FROM skills WHERE is_active = true GROUP BY category ORDER BY n DESC'
    );
    await db.close();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'IDevelop';
    wb.created = new Date('2026-06-28T00:00:00Z');

    // ---- Sheet 1: Skills (the matrix) -------------------------------------
    const ws = wb.addWorksheet('Skills', { properties: { tabColor: { argb: HEADER_FILL } } });
    ws.columns = [
        { header: 'Category', key: 'category', width: 15 },
        { header: 'Section (Domain)', key: 'domain', width: 34 },
        { header: 'Skill', key: 'skill', width: 44 },
        { header: 'Description', key: 'description', width: 50 },
        { header: 'Roles Requiring', key: 'roles', width: 14 },
        { header: 'Avg Req. Level', key: 'avg', width: 13 },
        { header: 'Max Req. Level', key: 'max', width: 13 },
        { header: 'Skill ID', key: 'id', width: 9 },
        // --- MERGE columns (fill these while reconciling the other framework) ---
        { header: '▶ Target Category', key: 'tCat', width: 18 },
        { header: '▶ Target Section', key: 'tSec', width: 28 },
        { header: '▶ Target Skill', key: 'tSkill', width: 36 },
        {
            header: '▶ Mapping (exact / partial / split / merge / new / drop)',
            key: 'tMap',
            width: 30,
        },
        { header: '▶ Notes', key: 'tNotes', width: 40 },
    ];
    for (const s of skills) {
        const row = ws.addRow({
            category: s.category,
            domain: s.domain,
            skill: s.skill,
            description: s.description,
            roles: Number(s.rolesRequiring),
            avg: Number(s.avgRequired),
            max: Number(s.maxRequired),
            id: Number(s.id),
        });
        const fill = CAT_FILL[s.category];
        if (fill)
            row.getCell('category').fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: fill },
            };
        row.getCell('description').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('skill').alignment = { wrapText: true, vertical: 'top' };
        ['roles', 'avg', 'max', 'id'].forEach((k) => {
            row.getCell(k).alignment = { horizontal: 'center' };
        });
        // tint the merge columns so they're visually "to fill"
        ['tCat', 'tSec', 'tSkill', 'tMap', 'tNotes'].forEach((k) => {
            row.getCell(k).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFafafa' },
            };
            row.getCell(k).border = { left: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
        });
    }
    styleHeader(ws, 13);
    // shade the merge header block differently
    ['I1', 'J1', 'K1', 'L1', 'M1'].forEach((c) => {
        ws.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    });

    // ---- Sheet 2: Sections (Domains) --------------------------------------
    const wd = wb.addWorksheet('Sections (Domains)');
    wd.columns = [
        { header: 'Section (Domain)', key: 'domain', width: 38 },
        { header: 'Categories present', key: 'categories', width: 36 },
        { header: '# Skills', key: 'n', width: 10 },
        { header: '▶ Target Framework Section', key: 'tSec', width: 34 },
        { header: '▶ Mapping', key: 'tMap', width: 22 },
        { header: '▶ Notes', key: 'tNotes', width: 44 },
    ];
    for (const d of domains) {
        const row = wd.addRow({
            domain: d.domain,
            categories: d.categories,
            n: Number(d.skillCount),
        });
        row.getCell('n').alignment = { horizontal: 'center' };
        ['tSec', 'tMap', 'tNotes'].forEach((k) => {
            row.getCell(k).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFAFAFA' },
            };
        });
    }
    styleHeader(wd, 6);
    ['D1', 'E1', 'F1'].forEach((c) => {
        wd.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    });

    // ---- Sheet 3: Summary -------------------------------------------------
    const wsum = wb.addWorksheet('Summary');
    wsum.addRow(['IDevelop — Current Skills Framework']).font = { bold: true, size: 14 };
    wsum.addRow([
        `Generated 2026-06-28 · ${skills.length} active skills · ${domains.length} sections (domains) · ${cats.length} categories`,
    ]);
    wsum.addRow([]);
    wsum.addRow(['Skills by Category']).font = { bold: true };
    const ch = wsum.addRow(['Category', '# Skills', '% of total']);
    ch.font = { bold: true };
    const total = skills.length;
    for (const c of cats) {
        const r = wsum.addRow([c.category, c.n, `${Math.round((c.n / total) * 1000) / 10}%`]);
        const fill = CAT_FILL[c.category];
        if (fill)
            r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    }
    wsum.addRow([]);
    const how = wsum.addRow(['How to merge with another framework']);
    how.font = { bold: true };
    [
        '1. Use the "Skills" sheet as the authoritative list of what exists today. Section = Domain; Category is a cross-cutting tag (a domain may contain several categories).',
        '2. For each row, fill the purple ▶ Target columns: which Category/Section/Skill in the OTHER framework it maps to, and the Mapping type (exact / partial / split / merge / new / drop).',
        '3. Use the "Sections (Domains)" sheet to first reconcile the higher-level grouping (your 49 domains ↔ their sections), then drill into individual skills.',
        '4. "Roles Requiring / Avg / Max Req. Level" show how load-bearing each skill is — prioritise reconciling the high-usage ones; rarely-used skills are easier to drop or merge.',
        '5. Rows the other framework adds (no current equivalent) get appended at the bottom with Mapping = "new".',
    ].forEach((t) => {
        const r = wsum.addRow([t]);
        r.getCell(1).alignment = { wrapText: true };
        wsum.mergeCells(`A${r.number}:F${r.number}`);
    });
    wsum.getColumn(1).width = 24;
    wsum.getColumn(2).width = 12;
    wsum.getColumn(3).width = 12;

    await wb.xlsx.writeFile(OUT);
    console.log(`✓ Wrote ${OUT}`);
    console.log(
        `  Skills: ${skills.length} · Sections (domains): ${domains.length} · Categories: ${cats.map((c) => c.category + ':' + c.n).join(', ')}`
    );
})().catch((e) => {
    console.error('ERR', e.stack || e.message);
    process.exit(1);
});
