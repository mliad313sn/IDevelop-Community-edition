'use strict';
/**
 * Skills library (/framework/library): sector packs and the ESCO import.
 *
 *  · every pack file under db/postgres/seed-data/packs/ is valid content:
 *    metadata (id, title, sector, CC0 licence, version), FR + EN everywhere,
 *    unique skill names, roles reference existing skills, levels 0-4, anchors;
 *  · the service lists, previews and refuses an id that is not a pack;
 *  · the ESCO upload is parsed with the exported import-esco functions, as
 *    separate files or as one zip (through the zip-bomb guard), and the group
 *    selection honours the per-import cap;
 *  · every library string exists in FR and EN, and the page renders with the
 *    real translations (no bare key);
 *  · every library route refuses a caller without manage_domains_skills.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

jest.mock('../../src/utils/contactableAdmins', () => ({ contactableGranters: async () => [] }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ejs = require('ejs');
const httpMocks = require('node-mocks-http');

const ROOT = path.join(__dirname, '..', '..');
const PACKS_DIR = path.join(ROOT, 'db', 'postgres', 'seed-data', 'packs');
const FIX = path.join(__dirname, '..', 'fixtures', 'esco');
const Packs = require('../../src/services/FrameworkPackService');
const Esco = require('../../src/services/EscoImportService');
const { readZipEntries } = require('../../src/utils/importGuards');

const packFiles = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json'));
const loadPack = (f) => JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
const skillsOf = (fw) => fw.pillars.flatMap((p) => p.subDomains.flatMap((sd) => sd.skills));
const low = (s) => String(s).toLowerCase();

// Skill-count ranges asked for each sector.
const RANGES = {
    'mining-heavy-industry': [40, 60],
    'public-sector-administration': [30, 40],
    'healthcare-care': [30, 40],
    'office-digital-services': [30, 40],
};

describe('sector pack files', () => {
    test('the four sector packs are there', () => {
        expect(packFiles.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(
            Object.keys(RANGES).sort()
        );
    });

    describe.each(packFiles)('%s', (file) => {
        const fw = loadPack(file);

        test('metadata: id, bilingual title and description, sector, CC0 licence, version', () => {
            expect(fw.id).toBe(file.replace(/\.json$/, ''));
            expect(fw.title.fr).toMatch(/\S/);
            expect(fw.title.en).toMatch(/\S/);
            expect(fw.description.fr).toMatch(/\S/);
            expect(fw.description.en).toMatch(/\S/);
            expect(fw.sector).toMatch(/^[a-z]+$/);
            expect(fw.licence).toBe('CC0-1.0');
            expect(fw.version).toMatch(/^\d+\.\d+\.\d+$/);
            expect(typeof fw.name).toBe('string');
        });

        test('the loader finds nothing wrong', () => {
            expect(Packs.validateFramework(fw)).toEqual([]);
        });

        test('skill count is in the range asked for the sector', () => {
            const [min, max] = RANGES[fw.id];
            const n = skillsOf(fw).length;
            expect(n).toBeGreaterThanOrEqual(min);
            expect(n).toBeLessThanOrEqual(max);
        });

        test('FR and EN on every pillar, sub-domain, skill, role family and role', () => {
            for (const p of fw.pillars) {
                expect([p.name, p.nameFr, p.description, p.descriptionFr]).not.toContain(undefined);
                expect(['Technical', 'Behavioral', 'Safety', 'Compliance']).toContain(p.category);
                for (const sd of p.subDomains) {
                    for (const v of [sd.name, sd.nameFr, sd.definition, sd.definitionFr])
                        expect(v).toMatch(/\S/);
                    for (const sk of sd.skills) {
                        for (const v of [sk.name, sk.nameFr, sk.fr, sk.en]) expect(v).toMatch(/\S/);
                        expect(['Technical', 'Behavioral', 'Safety', 'Compliance']).toContain(
                            sk.category
                        );
                        expect(sk.fr.length).toBeLessThanOrEqual(2000);
                        expect(sk.en.length).toBeLessThanOrEqual(2000);
                        expect(sk.name.length).toBeLessThanOrEqual(120);
                    }
                }
            }
            for (const f of fw.roleFamilies) {
                for (const v of [f.name, f.nameFr, f.description, f.descriptionFr])
                    expect(v).toMatch(/\S/);
            }
            for (const r of fw.roles) {
                expect(r.name).toMatch(/\S/);
                expect(r.nameFr).toMatch(/\S/);
            }
        });

        test('skill names are unique in each pillar and in the whole pack', () => {
            const all = new Set();
            for (const p of fw.pillars) {
                const inPillar = new Set();
                for (const sk of p.subDomains.flatMap((sd) => sd.skills)) {
                    expect(inPillar.has(low(sk.name))).toBe(false);
                    inPillar.add(low(sk.name));
                    expect(all.has(low(sk.name))).toBe(false);
                    all.add(low(sk.name));
                }
            }
            const fr = skillsOf(fw).map((s) => low(s.nameFr));
            expect(new Set(fr).size).toBe(fr.length);
        });

        test('roles reference existing skills and families, levels 0-4, critical flags', () => {
            const names = new Set(skillsOf(fw).map((s) => low(s.name)));
            const families = new Set(fw.roleFamilies.map((f) => f.name));
            expect(fw.roles.length).toBeGreaterThanOrEqual(5);
            for (const r of fw.roles) {
                expect(families.has(r.family)).toBe(true);
                expect(r.requirements.length).toBeGreaterThanOrEqual(4);
                expect(r.requirements.some(([, , c]) => c === true)).toBe(true);
                const seen = new Set();
                for (const [n, level, critical] of r.requirements) {
                    expect(names.has(low(n))).toBe(true);
                    expect(seen.has(low(n))).toBe(false);
                    seen.add(low(n));
                    expect(Number.isInteger(level)).toBe(true);
                    expect(level).toBeGreaterThanOrEqual(0);
                    expect(level).toBeLessThanOrEqual(4);
                    expect(typeof critical).toBe('boolean');
                }
            }
            for (const [fam, list] of Object.entries(fw.familySkills)) {
                expect(families.has(fam)).toBe(true);
                for (const n of list) expect(names.has(low(n))).toBe(true);
            }
        });

        test('level anchors, where given, cover levels 0-4 in FR and EN within 600 characters', () => {
            const anchored = skillsOf(fw).filter((s) => s.levels);
            expect(anchored.length).toBeGreaterThanOrEqual(2);
            for (const sk of anchored) {
                expect(sk.levels.map((a) => a.level)).toEqual([0, 1, 2, 3, 4]);
                for (const a of sk.levels) {
                    expect(a.fr).toMatch(/\S/);
                    expect(a.en).toMatch(/\S/);
                    expect(a.fr.length).toBeLessThanOrEqual(600);
                    expect(a.en.length).toBeLessThanOrEqual(600);
                }
            }
        });

        test('no SFIA or other proprietary framework is cited as a source', () => {
            expect(JSON.stringify(fw)).not.toMatch(/\bSFIA\b/i);
        });
    });

    test('no role name collides with the starter framework or another pack', () => {
        // Roles are matched by name: a collision would merge requirements.
        const starter = JSON.parse(fs.readFileSync(Packs.STARTER_FILE, 'utf8'));
        const seen = new Map(starter.roles.map((r) => [low(r.name), 'starter']));
        for (const f of packFiles) {
            for (const r of loadPack(f).roles) {
                for (const n of [r.name, r.nameFr]) {
                    expect(seen.get(low(n))).toBeUndefined();
                }
                seen.set(low(r.name), f);
                seen.set(low(r.nameFr), f);
            }
        }
    });
});

describe('FrameworkPackService (no database)', () => {
    test('listPacks gives counts; getPack refuses anything but a pack id', () => {
        const list = Packs.listPacks();
        expect(list).toHaveLength(4);
        const mining = list.find((p) => p.id === 'mining-heavy-industry');
        expect(mining.counts.skills).toBe(skillsOf(loadPack('mining-heavy-industry.json')).length);
        expect(mining.counts.roles).toBeGreaterThan(0);
        expect(mining.licence).toBe('CC0-1.0');
        expect(Packs.getPack('../starter-framework')).toBeNull();
        expect(Packs.getPack('starter-framework')).toBeNull();
        expect(Packs.getPack('nope')).toBeNull();
        expect(Packs.getPack('healthcare-care').id).toBe('healthcare-care');
    });

    test('preview follows the chosen language', () => {
        const fw = Packs.getPack('healthcare-care');
        const fr = Packs.preview(fw, 'fr');
        const en = Packs.preview(fw, 'en');
        expect(fr.pillars[0].name).toBe('Sécurité des patients et qualité');
        expect(en.pillars[0].name).toBe('Patient Safety & Quality');
        expect(fr.roles[0].requirements[0].skill).toBe('Sécurité du circuit du médicament');
        expect(fr.pillars[0].subDomains[0].skills[0].anchors).toBe(5);
    });

    test('validateFramework reports broken references', () => {
        const errs = Packs.validateFramework({
            pillars: [
                { name: 'P', subDomains: [{ name: 'S', skills: [{ name: 'A' }, { name: 'a' }] }] },
            ],
            roleFamilies: [{ name: 'F' }],
            familySkills: { G: ['B'] },
            roles: [{ name: 'R', family: 'X', requirements: [['C', 7, true]] }],
        });
        expect(errs.join('\n')).toMatch(/duplicate skill "a"/);
        expect(errs.join('\n')).toMatch(/unknown role family "G"/);
        expect(errs.join('\n')).toMatch(/unknown skill "B"/);
        expect(errs.join('\n')).toMatch(/role "R": unknown role family "X"/);
        expect(errs.join('\n')).toMatch(/role "R": unknown skill "C"/);
        expect(errs.join('\n')).toMatch(/must be 0-4/);
        expect(Packs.validateFramework({ hello: 1 })).toEqual([
            'not a framework file (no "pillars" array)',
        ]);
    });
});

// ---------------------------------------------------------------- ESCO upload
const fixtureFiles = (names) =>
    names.map((n) => ({ originalname: n, buffer: fs.readFileSync(path.join(FIX, n)) }));
const ALL = [
    'skills_en.csv',
    'skillGroups_en.csv',
    'broaderRelationsSkillPillar_en.csv',
    'skills_fr.csv',
];

/** A minimal ZIP writer (deflate or store), enough for the reader under test. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data, store } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const body = store ? data : zlib.deflateRawSync(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(store ? 0 : 8, 8);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(store ? 0 : 8, 10);
        ch.writeUInt32LE(body.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt32LE(offset, 42);
        locals.push(lh, nameBuf, body);
        centrals.push(ch, nameBuf);
        offset += lh.length + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

describe('ESCO upload', () => {
    test('separate CSV files parse with the import-esco functions', () => {
        const parsed = Esco.parseUpload(fixtureFiles(ALL));
        expect(parsed.skills).toBe(6);
        expect(parsed.hasFrench).toBe(true);
        expect(parsed.files.sort()).toEqual([...ALL].sort());
        expect(parsed.fw.license).toBe('CC-BY-4.0');
        expect(parsed.fw.attribution).toBe(Esco.ESCO_ATTRIBUTION);
        const groups = Esco.groupsOf(parsed.fw);
        expect(groups.map((g) => g.name)).toEqual([
            'Communication, collaboration and creativity',
            'Thinking skills and competences',
            'Working with computers',
            'Other ESCO skills',
        ]);
        expect(groups[0].count).toBe(3);
        expect(groups[0].subDomains[0]).toEqual({
            key: 'urn:test:group/S1.1',
            name: 'Negotiating',
            count: 3,
        });
        expect(groups[3].key).toBe('other');
    });

    test('one zip holding the files (in a folder) gives the same result', () => {
        const zip = makeZip(
            ALL.map((n, i) => ({
                name: `esco-v1.2/${n}`,
                data: fs.readFileSync(path.join(FIX, n)),
                store: i === 1,
            })).concat([{ name: 'esco-v1.2/occupations_en.csv', data: Buffer.from('x') }])
        );
        const parsed = Esco.parseUpload([{ originalname: 'esco.zip', buffer: zip }]);
        expect(parsed.skills).toBe(6);
        expect(parsed.hasFrench).toBe(true);
    });

    test('the French file is optional; a required file missing is refused', () => {
        const noFr = Esco.parseUpload(fixtureFiles(ALL.slice(0, 3)));
        expect(noFr.hasFrench).toBe(false);
        expect(() => Esco.parseUpload(fixtureFiles(['skills_en.csv', 'skills_fr.csv']))).toThrow(
            expect.objectContaining({
                code: 'esco_missing_files',
                missing: ['groups', 'relations'],
            })
        );
    });

    test('a CSV without the ESCO columns is refused', () => {
        const files = fixtureFiles(ALL.slice(1, 3)).concat([
            { originalname: 'skills_en.csv', buffer: Buffer.from('a,b\n1,2\n') },
        ]);
        expect(() => Esco.parseUpload(files)).toThrow(
            expect.objectContaining({ code: 'esco_bad_columns' })
        );
    });

    test('a zip bomb is refused before it is inflated past the cap', () => {
        const bomb = makeZip([
            { name: 'skills_en.csv', data: Buffer.alloc(4 * 1024 * 1024, 0x41) },
        ]);
        expect(bomb.length).toBeLessThan(64 * 1024);
        expect(() => readZipEntries(bomb, () => true, { maxTotalBytes: 1024 * 1024 })).toThrow(
            /exceeds the limit/
        );
        // A lying size header is caught by the capped inflation itself.
        const lie = Buffer.from(bomb);
        lie.writeUInt32LE(10, lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
        expect(() => readZipEntries(lie, () => true, { maxTotalBytes: 1024 * 1024 })).toThrow(
            /exceeds the limit/
        );
        expect(() =>
            Esco.parseUpload([{ originalname: 'x.zip', buffer: Buffer.from('not a zip at all') }])
        ).toThrow(expect.objectContaining({ code: 'esco_zip_refused' }));
    });

    test('selection keeps the ticked sub-groups up to the cap', () => {
        const { fw } = Esco.parseUpload(fixtureFiles(ALL));
        const all = Esco.select(fw, ['urn:test:group/S1.1', 'urn:test:group/S5.1'], 500);
        expect(all.selected).toBe(4);
        expect(all.truncated).toBe(0);
        expect(all.fw.pillars.map((p) => p.name)).toEqual([
            'Communication, collaboration and creativity',
            'Working with computers',
        ]);
        expect(all.fw.attribution).toBe(Esco.ESCO_ATTRIBUTION);
        expect(Packs.validateFramework(all.fw)).toEqual([]);
        const capped = Esco.select(fw, ['urn:test:group/S1.1', 'urn:test:group/S5.1'], 2);
        expect(capped.selected).toBe(2);
        expect(capped.truncated).toBe(2);
        expect(Esco.select(fw, ['other#general'], 10).selected).toBe(1);
        expect(Esco.clampLimit('abc')).toBe(Esco.DEFAULT_LIMIT);
        expect(Esco.clampLimit(10 ** 9)).toBe(Esco.MAX_LIMIT);
    });

    test('the parked upload round-trips by token only', () => {
        const parsed = Esco.parseUpload(fixtureFiles(ALL));
        const token = Esco.store(parsed);
        expect(token).toMatch(/^[a-f0-9]{32}$/);
        const file = path.join(os.tmpdir(), 'idevelop-esco', `${token}.json`);
        expect(fs.statSync(file).mode & 0o077).toBe(0);
        expect(Esco.fetchStored(token).skills).toBe(6);
        expect(Esco.fetchStored('../../etc/passwd')).toBeNull();
        Esco.discard(token);
        expect(Esco.fetchStored(token)).toBeNull();
    });
});

// ---------------------------------------------------------------- i18n + view
const LOCALES = path.join(ROOT, 'locales');
const fwFr = JSON.parse(fs.readFileSync(path.join(LOCALES, 'fr', 'framework.json'), 'utf8'));
const fwEn = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en', 'framework.json'), 'utf8'));
const VIEW = path.join(ROOT, 'views', 'pages', 'framework', 'library.ejs');

describe('strings', () => {
    const sources = [
        VIEW,
        path.join(ROOT, 'views', 'pages', 'domains-skills', 'index.ejs'),
        path.join(ROOT, 'src', 'controllers', 'FrameworkLibraryController.js'),
        path.join(ROOT, 'src', 'routes', 'index.js'),
    ].map((f) => fs.readFileSync(f, 'utf8'));

    test('every library key used exists in FR and EN', () => {
        const used = new Set(sources.flatMap((s) => s.match(/framework:lib_[a-z_]+/g) || []));
        expect(used.size).toBeGreaterThan(50);
        for (const k of used) {
            const key = k.slice('framework:'.length);
            expect([key, fwFr[key]]).toEqual([key, expect.stringMatching(/\S/)]);
            expect([key, fwEn[key]]).toEqual([key, expect.stringMatching(/\S/)]);
        }
    });

    test('FR/EN parity of the lib_ keys, same placeholders', () => {
        const fr = Object.keys(fwFr).filter((k) => k.startsWith('lib_'));
        const en = Object.keys(fwEn).filter((k) => k.startsWith('lib_'));
        expect(fr.sort()).toEqual(en.sort());
        const vars = (s) => (s.match(/\{\{\w+\}\}|%\w+%/g) || []).sort();
        for (const k of fr) expect([k, vars(fwFr[k])]).toEqual([k, vars(fwEn[k])]);
    });

    test('only literal keys: no computed framework key in the library view', () => {
        const view = fs.readFileSync(VIEW, 'utf8');
        expect(view).not.toMatch(/__\(\s*['"`]framework:[^'"`]*['"`]\s*\+/);
        expect(view).not.toMatch(/__\(\s*`/);
    });
});

async function translator(lng) {
    const i18next = require('i18next').createInstance();
    await i18next.init({
        lng,
        fallbackLng: false,
        ns: ['framework'],
        defaultNS: 'framework',
        resources: { fr: { framework: fwFr }, en: { framework: fwEn } },
        interpolation: { escapeValue: false },
    });
    return (key, opts) => i18next.t(key, opts);
}

describe('library page renders with the real strings', () => {
    const base = (t) => ({
        __: t,
        csrfToken: 'tok',
        assetVersion: '1',
        cspNonce: 'n',
        tab: 'packs',
        uiLang: 'fr',
        packs: Packs.listPacks(),
        preview: null,
        report: null,
        kindLabels: {},
        kinds: Packs.KINDS,
        esco: null,
        escoMaxLimit: 2000,
        escoAttribution: Esco.ESCO_ATTRIBUTION,
        escoUrl: Esco.ESCO_URL,
        history: [],
        fmtDateTime: (d) => String(d),
    });
    const render = (data) => ejs.render(fs.readFileSync(VIEW, 'utf8'), data, { filename: VIEW });

    test('packs tab, preview and a dry-run report (FR)', async () => {
        const t = await translator('fr');
        const fw = Packs.getPack('mining-heavy-industry');
        const stats = {};
        const created = {};
        const existing = {};
        for (const k of Packs.KINDS) {
            stats[k] = { created: 2, existing: 1 };
            created[k] = ['<b>new</b>'];
            existing[k] = ['old'];
        }
        const html = render({
            ...base(t),
            preview: { id: fw.id, title: fw.title.fr, tree: Packs.preview(fw, 'fr') },
            report: {
                kind: 'pack',
                id: fw.id,
                title: 'Mines',
                lang: 'fr',
                stats,
                created,
                existing,
                totalNew: 16,
            },
            kindLabels: Object.fromEntries(Packs.KINDS.map((k) => [k, k])),
        });
        expect(html).not.toMatch(/framework:lib_/);
        expect(html).toContain('Mines et industrie lourde');
        expect(html).toContain('Permis de travail');
        expect(html).toContain('action="/framework/library/packs/mining-heavy-industry/commit"');
        expect(html).toContain('action="/framework/library/packs/mining-heavy-industry/dry-run"');
        expect(html).toContain('&lt;b&gt;new&lt;/b&gt;');
        expect(html).not.toContain('<b>new</b>');
        expect(html).toContain('Simulation');
    });

    test('ESCO tab shows the attribution, then the groups after an upload (EN)', async () => {
        const t = await translator('en');
        const before = render({ ...base(t), tab: 'esco', uiLang: 'en' });
        expect(before).toContain(Esco.ESCO_ATTRIBUTION);
        expect(before).toContain('id="libEscoUpload"');
        expect(before).not.toMatch(/framework:lib_/);
        const parsed = Esco.parseUpload(fixtureFiles(ALL));
        const after = render({
            ...base(t),
            tab: 'esco',
            uiLang: 'en',
            esco: {
                files: parsed.files,
                skills: parsed.skills,
                hasFrench: true,
                groups: Esco.groupsOf(parsed.fw),
                selected: ['urn:test:group/S1.1'],
                limit: 500,
                nameLang: 'en',
            },
        });
        expect(after).toContain(Esco.ESCO_ATTRIBUTION);
        expect(after).toContain('value="urn:test:group/S1.1"');
        expect(after).toContain('action="/framework/library/esco/dry-run"');
        expect(after).not.toContain('id="libEscoUpload"');
        expect(after).not.toMatch(/framework:lib_/);
    });
});

// ---------------------------------------------------------------- authorisation
describe('route authorisation', () => {
    const router = require('../../src/routes/index');
    const routes = router.stack
        .filter((l) => l.route && /^\/framework\/library/.test(l.route.path))
        .map((l) => ({
            path: l.route.path,
            method: Object.keys(l.route.methods)[0],
            guard: l.route.stack[0].handle,
        }));

    test('the page and every write are registered', () => {
        expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()).toEqual(
            [
                'GET /framework/library',
                'POST /framework/library/esco/commit',
                'POST /framework/library/esco/discard',
                'POST /framework/library/esco/dry-run',
                'POST /framework/library/esco/upload',
                'POST /framework/library/packs/:id/commit',
                'POST /framework/library/packs/:id/dry-run',
            ].sort()
        );
    });

    const run = async (guard, user) => {
        const req = httpMocks.createRequest({ method: 'GET', url: '/framework/library' });
        req.isAuthenticated = () => !!user;
        req.user = user;
        req.flash = jest.fn();
        req.t = (k) => k;
        const res = httpMocks.createResponse();
        res.render = jest.fn(function (view) {
            this.statusCode = this.statusCode || 200;
            this._view = view;
            return this;
        });
        const next = jest.fn();
        await guard(req, res, next);
        return { next, res };
    };

    test.each([
        ['anonymous', null],
        ['an employee', { id: 5, userType: 'employee' }],
        [
            'a local admin with read-only framework access',
            { id: 7, userType: 'admin', role: 'admin', permissions: ['view_domains_skills'] },
        ],
        [
            'a viewer even with the write grant',
            { id: 8, userType: 'admin', role: 'viewer', permissions: ['manage_domains_skills'] },
        ],
    ])('%s is refused (403 or redirect) on every library route', async (_, user) => {
        for (const r of routes) {
            const { next, res } = await run(r.guard, user);
            expect(next).not.toHaveBeenCalled();
            const code = res.statusCode;
            expect(code === 403 || code === 302).toBe(true);
        }
    });

    test.each([
        ['a SuperAdmin', { id: 1, userType: 'admin', role: 'superadmin', permissions: [] }],
        [
            'a local admin with manage_domains_skills',
            { id: 2, userType: 'admin', role: 'admin', permissions: ['manage_domains_skills'] },
        ],
    ])('%s passes the guard', async (_, user) => {
        for (const r of routes) {
            const { next } = await run(r.guard, user);
            expect(next).toHaveBeenCalled();
        }
    });

    test('the multipart upload is NOT exempt from the global CSRF check', () => {
        // The exemption list lives in src/middleware/httpHardening.js.
        const H = require('../../src/middleware/httpHardening');
        expect(
            H.csrfSkip({
                path: '/framework/library/esco/upload',
                method: 'POST',
                headers: { 'content-type': 'multipart/form-data; boundary=B' },
            })
        ).toBe(false);
        const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'framework-library.js'), 'utf8');
        expect(js).toMatch(/'x-csrf-token'/);
    });
});
