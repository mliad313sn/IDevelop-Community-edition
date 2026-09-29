'use strict';
/**
 * scripts/import-esco.js — ESCO CSV export → capability-framework JSON (the
 * shape of db/postgres/seed-data/starter-framework.json), and the --file
 * option of scripts/seed-starter-framework.js that loads it.
 *
 * The fixture under tests/fixtures/esco/ is SYNTHETIC (urn:test: URIs, own
 * wording): no ESCO data ships with the repository.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    parseCsv,
    parseCsvObjects,
    convertEsco,
    parseArgs,
    ESCO_ATTRIBUTION,
} = require('../../scripts/import-esco');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, '..', 'fixtures', 'esco');
const read = (f) => parseCsvObjects(fs.readFileSync(path.join(FIX, f), 'utf8'));
const fixture = () => ({
    skills: read('skills_en.csv'),
    groups: read('skillGroups_en.csv'),
    relations: read('broaderRelationsSkillPillar_en.csv'),
    skillsFr: read('skills_fr.csv'),
});
const allSkills = (fw) => fw.pillars.flatMap((p) => p.subDomains.flatMap((sd) => sd.skills));

describe('parseCsv', () => {
    test('plain rows, LF and CRLF endings, trailing newline', () => {
        expect(parseCsv('a,b\r\n1,2\n3,4\n')).toEqual([
            ['a', 'b'],
            ['1', '2'],
            ['3', '4'],
        ]);
    });

    test('quoted fields keep commas, doubled quotes and line breaks', () => {
        const rows = parseCsv('x,y\n"a, b","say ""hi""\r\nsecond line"\n');
        expect(rows).toEqual([
            ['x', 'y'],
            ['a, b', 'say "hi"\r\nsecond line'],
        ]);
    });

    test('empty fields, a final line without newline and a BOM', () => {
        expect(parseCsv(String.fromCharCode(0xfeff) + 'a,,c\n,,\nlast')).toEqual([
            ['a', '', 'c'],
            ['', '', ''],
            ['last'],
        ]);
    });

    test('blank lines are dropped', () => {
        expect(parseCsv('a\n\n\nb\n')).toEqual([['a'], ['b']]);
    });

    test('an unterminated quote is an error, not silent data loss', () => {
        expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
    });

    test('parseCsvObjects keys rows by the header', () => {
        expect(parseCsvObjects('conceptUri,preferredLabel\nu1,"x, y"\n')).toEqual([
            { conceptUri: 'u1', preferredLabel: 'x, y' },
        ]);
    });

    test('the fixture multi-line altLabels field parses into one row', () => {
        const skills = read('skills_en.csv');
        expect(skills).toHaveLength(7);
        expect(skills[0].altLabels).toBe('haggle\nbargain');
        expect(skills[0].description).toContain('"win-win"');
    });
});

describe('convertEsco', () => {
    test('has the starter-framework shape', () => {
        const fw = convertEsco(fixture());
        const starter = JSON.parse(
            fs.readFileSync(
                path.join(ROOT, 'db', 'postgres', 'seed-data', 'starter-framework.json'),
                'utf8'
            )
        );
        for (const k of Object.keys(starter)) expect(fw).toHaveProperty(k);
        expect(Array.isArray(fw.roleFamilies)).toBe(true);
        expect(Array.isArray(fw.roles)).toBe(true);
        expect(fw.familySkills).toEqual({});
        for (const p of fw.pillars) {
            expect(typeof p.name).toBe('string');
            for (const sd of p.subDomains) {
                expect(typeof sd.name).toBe('string');
                for (const sk of sd.skills) {
                    expect(typeof sk.name).toBe('string');
                    expect(['Technical', 'Behavioral']).toContain(sk.category);
                }
            }
        }
    });

    test('carries the CC BY 4.0 attribution', () => {
        const fw = convertEsco(fixture());
        expect(fw.license).toBe('CC-BY-4.0');
        expect(fw.attribution).toBe(ESCO_ATTRIBUTION);
        expect(fw.attribution).toMatch(/ESCO/);
        expect(fw.attribution).toMatch(/CC BY 4\.0/);
        expect(fw.note).toContain(ESCO_ATTRIBUTION);
    });

    test('depth-1 groups become pillars, depth-2 sub-domains; roots are skipped', () => {
        const fw = convertEsco(fixture());
        const names = fw.pillars.map((p) => p.name);
        expect(names).toEqual([
            'Communication, collaboration and creativity',
            'Thinking skills and competences',
            'Working with computers',
            'Other ESCO skills',
        ]);
        expect(names).not.toContain('Skills');
        const comm = fw.pillars[0];
        expect(comm.description).toBe('Communicating, collaborating and creating.');
        expect(comm.subDomains.map((s) => s.name)).toEqual(['Negotiating']);
        expect(comm.subDomains[0].definition).toBe('Reaching agreements.');
    });

    test('deeper groups fold into depth 2; skill→skill links inherit the groups', () => {
        const fw = convertEsco(fixture());
        const neg = fw.pillars[0].subDomains[0].skills.map((s) => s.name);
        // skill/2 sits under S1.1.1, skill/3 under skill/2.
        expect(neg).toEqual([
            'Negotiate supplier terms',
            'Draft sales contracts',
            'Draft framework agreements',
        ]);
    });

    test('a skill directly under a depth-1 group gets a sub-domain named after it', () => {
        const fw = convertEsco(fixture());
        const thinking = fw.pillars.find((p) => p.name === 'Thinking skills and competences');
        expect(thinking.subDomains).toHaveLength(1);
        expect(thinking.subDomains[0].name).toBe('Thinking skills and competences');
        // Transversal reuse level → Behavioral.
        expect(thinking.subDomains[0].skills[0].category).toBe('Behavioral');
        expect(thinking.category).toBe('Behavioral');
    });

    test('ungrouped skills go to "Other ESCO skills"; obsolete ones are dropped', () => {
        const fw = convertEsco(fixture());
        const other = fw.pillars.find((p) => p.name === 'Other ESCO skills');
        expect(other.subDomains[0].skills.map((s) => s.name)).toEqual(['Orphan skill']);
        expect(allSkills(fw).map((s) => s.name)).not.toContain('Retired skill');
        expect(
            allSkills(convertEsco(fixture(), { includeObsolete: true })).map((s) => s.name)
        ).toContain('Retired skill');
    });

    test('English and French descriptions, French label, URI', () => {
        const sk = allSkills(convertEsco(fixture())).find((s) => s.uri === 'urn:test:skill/1');
        expect(sk.en).toBe('Agree prices, delivery and quality with suppliers, the "win-win" way.');
        expect(sk.fr).toBe('Convenir des prix, des délais et de la qualité avec les fournisseurs.');
        expect(sk.nameFr).toBe('Négocier les conditions avec les fournisseurs');
        // No French description: fall back to the French label.
        const js = allSkills(convertEsco(fixture())).find((s) => s.uri === 'urn:test:skill/4');
        expect(js.fr).toBe('JavaScript');
        // No French file at all.
        const noFr = convertEsco({ ...fixture(), skillsFr: [] });
        expect(allSkills(noFr).every((s) => s.fr === null)).toBe(true);
    });

    test('--group filters by label (case-insensitive) or by exact URI', () => {
        const byLabel = convertEsco(fixture(), { group: 'NEGOTIATING' });
        expect(byLabel.pillars.map((p) => p.name)).toEqual([
            'Communication, collaboration and creativity',
        ]);
        expect(allSkills(byLabel)).toHaveLength(3);
        const byUri = convertEsco(fixture(), { group: ['urn:test:group/S5.1'] });
        expect(allSkills(byUri).map((s) => s.name)).toEqual(['JavaScript']);
        const deep = convertEsco(fixture(), { group: 'urn:test:group/S1.1.1' });
        expect(allSkills(deep).map((s) => s.name)).toEqual([
            'Draft sales contracts',
            'Draft framework agreements',
        ]);
        expect(byLabel.note).toMatch(/Filter: NEGOTIATING/);
    });

    test('--limit and --type', () => {
        expect(allSkills(convertEsco(fixture(), { limit: 2 }))).toHaveLength(2);
        expect(allSkills(convertEsco(fixture(), { type: 'knowledge' })).map((s) => s.name)).toEqual(
            ['JavaScript']
        );
    });

    test('duplicate labels within a pillar are kept once', () => {
        const f = fixture();
        f.skills.push({ ...f.skills[0], conceptUri: 'urn:test:skill/dup' });
        f.relations.push({ conceptUri: 'urn:test:skill/dup', broaderUri: 'urn:test:group/S1.1' });
        const names = allSkills(convertEsco(f)).map((s) => s.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
    });

    test('a cycle in the broader relations does not hang', () => {
        const fw = convertEsco({
            skills: [{ conceptUri: 'a', preferredLabel: 'a', status: 'released' }],
            groups: [],
            relations: [
                { conceptUri: 'a', broaderUri: 'b' },
                { conceptUri: 'b', broaderUri: 'a' },
            ],
        });
        expect(fw.pillars[0].name).toBe('Other ESCO skills');
    });
});

describe('command line', () => {
    test('parseArgs', () => {
        expect(
            parseArgs(['--dir', 'd', '--group', 'x', '--group', 'y', '--limit', '5', '--out', 'o'])
        ).toEqual({ dir: 'd', group: ['x', 'y'], limit: 5, out: 'o' });
        expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
        expect(() => parseArgs(['--dir'])).toThrow(/needs a value/);
    });

    test('--dir reads the CSVs (French file auto-detected) and prints JSON', () => {
        const out = execFileSync(
            process.execPath,
            [path.join(ROOT, 'scripts', 'import-esco.js'), '--dir', FIX],
            { encoding: 'utf8' }
        );
        const fw = JSON.parse(out);
        expect(allSkills(fw)).toHaveLength(6);
        expect(allSkills(fw).find((s) => s.uri === 'urn:test:skill/1').nameFr).toBeTruthy();
    });

    test('--out writes a file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esco-'));
        const out = path.join(dir, 'fw.json');
        try {
            execFileSync(
                process.execPath,
                [path.join(ROOT, 'scripts', 'import-esco.js'), '--dir', FIX, '--out', out],
                { encoding: 'utf8', stdio: 'pipe' }
            );
            expect(JSON.parse(fs.readFileSync(out, 'utf8')).pillars).toHaveLength(4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// Dry run only (rolled back): safe on any test database.
const HAS_DB = /_test/.test(String(process.env.DATABASE_URL || ''));
(HAS_DB ? describe : describe.skip)('seed-starter-framework --file (dry run)', () => {
    test('seeds the generated file and rolls back', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esco-'));
        const file = path.join(dir, 'fw.json');
        try {
            fs.writeFileSync(file, JSON.stringify(convertEsco(fixture())));
            const out = execFileSync(
                process.execPath,
                [path.join(ROOT, 'scripts', 'seed-starter-framework.js'), '--file', file],
                { encoding: 'utf8', env: process.env }
            );
            expect(out).toMatch(/ESCO skills \(imported\)/);
            expect(out).toMatch(/CC BY 4\.0/);
            expect(out).toMatch(/skills\s+6 new/);
            expect(out).toMatch(/DRY RUN/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);

    test('refuses a file that is not a framework', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esco-'));
        const file = path.join(dir, 'bad.json');
        try {
            fs.writeFileSync(file, '{"hello":1}');
            expect(() =>
                execFileSync(
                    process.execPath,
                    [path.join(ROOT, 'scripts', 'seed-starter-framework.js'), '--file', file],
                    { encoding: 'utf8', stdio: 'pipe', env: process.env }
                )
            ).toThrow(/not a framework file/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
});
