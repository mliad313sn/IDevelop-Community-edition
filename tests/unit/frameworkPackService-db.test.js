'use strict';
/**
 * FrameworkPackService on the REAL test database, every test inside ONE
 * transaction that is always rolled back:
 *
 *  · a dry run reports what a commit would create and writes nothing;
 *  · commit creates exactly what the dry run announced, then loading the same
 *    pack again creates NOTHING (every kind: 0 new) — idempotent;
 *  · loading with French names and then with English names matches the same
 *    rows (names are matched in both languages), and nothing existing is
 *    overwritten;
 *  · per-skill level anchors land in proficiency_descriptors (FR + EN), once;
 *  · an ESCO selection goes through the same dry run → commit and is audited
 *    with the CC BY 4.0 attribution.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');

// Rolled back: safe on the fixture database and on any *_test database.
const HAS_DB = /idevelop_fixtures|_test/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const Packs = require('../../src/services/FrameworkPackService');
const Esco = require('../../src/services/EscoImportService');

const ROLLBACK = '__pack_db_test_rollback__';
async function inRolledBackTx(fn) {
    let result = null;
    await db
        .runTransaction(async () => {
            result = await fn();
            throw new Error(ROLLBACK);
        })
        .catch((e) => {
            if (e.message !== ROLLBACK) throw e;
        });
    return result;
}
const count = async (table) => (await db.get(`SELECT count(*)::int AS n FROM ${table}`)).n;
const TABLES = [
    'domains',
    'sub_domains',
    'skills',
    'role_families',
    'roles',
    'role_skill_requirements',
    'skill_role_families',
    'proficiency_descriptors',
];
const snapshot = async () => {
    const o = {};
    for (const t of TABLES) o[t] = await count(t);
    return o;
};
const created = (r) => Object.fromEntries(Object.entries(r.stats).map(([k, s]) => [k, s.created]));

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('FrameworkPackService dry run vs commit (rolled back)', () => {
    jest.setTimeout(60000);

    test('dry run writes nothing; commit matches it; a second load creates nothing', async () => {
        const out = await inRolledBackTx(async () => {
            const fw = Packs.getPack('mining-heavy-industry');
            const before = await snapshot();
            const dry = await Packs.dryRun(fw, { lang: 'en' });
            const afterDry = await snapshot();
            const first = await Packs.commit(fw, { lang: 'en', audit: false });
            const afterCommit = await snapshot();
            const second = await Packs.commit(fw, { lang: 'en', audit: false });
            const afterSecond = await snapshot();
            const dryAgain = await Packs.dryRun(fw, { lang: 'en' });
            return { before, dry, afterDry, first, afterCommit, second, afterSecond, dryAgain };
        });
        const skills = Packs.summarise(Packs.getPack('mining-heavy-industry')).skills;
        expect(out.afterDry).toEqual(out.before);
        expect(created(out.dry)).toEqual(created(out.first));
        expect(out.first.stats.skills.created + out.first.stats.skills.existing).toBe(skills);
        expect(out.afterCommit.skills - out.before.skills).toBe(out.first.stats.skills.created);
        expect(out.afterCommit.roles - out.before.roles).toBe(out.first.stats.roles.created);
        expect(out.first.stats.roles.created).toBe(10);
        expect(out.first.stats['level anchors'].created).toBe(15);
        // Idempotent: nothing new the second time, every row counted as existing.
        for (const n of Object.values(created(out.second))) expect(n).toBe(0);
        expect(out.afterSecond).toEqual(out.afterCommit);
        expect(out.second.stats.skills.existing).toBe(skills);
        expect(out.second.stats['role requirements'].existing).toBe(
            out.first.stats['role requirements'].created +
                out.first.stats['role requirements'].existing
        );
        for (const n of Object.values(created(out.dryAgain))) expect(n).toBe(0);
    });

    test('French names then English names match the same rows; edits are never overwritten', async () => {
        const out = await inRolledBackTx(async () => {
            const fw = Packs.getPack('healthcare-care');
            const fr = await Packs.commit(fw, { lang: 'fr', audit: false });
            const skill = await db.get(
                'SELECT id, name, description, description_en, category FROM skills WHERE name = $1',
                ['Identitovigilance']
            );
            const anchors = await db.all(
                'SELECT level, anchor, anchor_en FROM proficiency_descriptors WHERE skill_id = $1 ORDER BY level',
                [skill.id]
            );
            await db.run(
                "UPDATE skills SET description = 'Texte modifié par la RH' WHERE id = $1",
                [skill.id]
            );
            const role = await db.get(
                `SELECT r.name, rf.name AS family FROM roles r JOIN role_families rf ON rf.id = r.role_family_id
                  WHERE r.name = $1`,
                ['Infirmier diplômé']
            );
            const en = await Packs.commit(fw, { lang: 'en', audit: false });
            const after = await db.get('SELECT name, description FROM skills WHERE id = $1', [
                skill.id,
            ]);
            return { fr, skill, anchors, role, en, after };
        });
        expect(out.fr.stats.skills.created).toBeGreaterThan(0);
        expect(out.skill.category).toBe('Safety');
        expect(out.skill.description).toMatch(/identifiants/);
        expect(out.skill.descriptionEn || out.skill.description_en).toMatch(/identifiers/);
        expect(out.anchors).toHaveLength(5);
        expect(out.anchors[4].anchor).toMatch(/\S/);
        expect(out.anchors[4].anchorEn || out.anchors[4].anchor_en).toMatch(/\S/);
        expect(out.role.family).toBe('Soins infirmiers');
        for (const n of Object.values(created(out.en))) expect(n).toBe(0);
        expect(out.after.name).toBe('Identitovigilance');
        expect(out.after.description).toBe('Texte modifié par la RH');
    });

    test('the refactored starter script still loads through the service', async () => {
        const out = await inRolledBackTx(async () => {
            const fw = Packs.readFramework(Packs.STARTER_FILE);
            const a = await Packs.commit(fw, { audit: false });
            const b = await Packs.dryRun(fw);
            return { a, b };
        });
        expect(out.a.stats.skills.created + out.a.stats.skills.existing).toBe(34);
        for (const n of Object.values(created(out.b))) expect(n).toBe(0);
    });

    test('ESCO selection: dry run, commit, audited with the attribution, idempotent', async () => {
        const FIX = path.join(__dirname, '..', 'fixtures', 'esco');
        const files = [
            'skills_en.csv',
            'skillGroups_en.csv',
            'broaderRelationsSkillPillar_en.csv',
            'skills_fr.csv',
        ].map((n) => ({ originalname: n, buffer: fs.readFileSync(path.join(FIX, n)) }));
        const out = await inRolledBackTx(async () => {
            const parsed = Esco.parseUpload(files);
            const sel = Esco.select(parsed.fw, ['urn:test:group/S1.1', 'other#general'], 500);
            const dry = await Packs.dryRun(sel.fw, { lang: 'fr' });
            const admin = await db.get('SELECT id FROM admins ORDER BY id LIMIT 1');
            const done = await Packs.commit(sel.fw, {
                lang: 'fr',
                actor: admin ? { id: admin.id, userType: 'admin' } : null,
                source: 'esco',
                action: 'FRAMEWORK_ESCO_IMPORTED',
                detail: 'test',
            });
            const log = await db.get(
                `SELECT details #>> '{}' AS details FROM system_logs
                  WHERE action = 'FRAMEWORK_ESCO_IMPORTED' ORDER BY id DESC LIMIT 1`
            );
            const again = await Packs.dryRun(sel.fw, { lang: 'en' });
            const history = await Packs.history(5);
            return { sel, dry, done, log, again, history };
        });
        expect(out.sel.selected).toBe(4);
        expect(created(out.dry)).toEqual(created(out.done));
        expect(out.done.stats.skills.created).toBe(4);
        expect(out.done.created.skills).toContain('Négocier les conditions avec les fournisseurs');
        expect(out.log.details).toContain('CC BY 4.0');
        expect(out.log.details).toContain('esco');
        for (const n of Object.values(created(out.again))) expect(n).toBe(0);
        expect(out.history[0].action).toBe('FRAMEWORK_ESCO_IMPORTED');
    });
});
