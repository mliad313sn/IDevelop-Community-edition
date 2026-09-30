'use strict';
/**
 * /admin/integrations/hris — the page renders in French and English with every
 * key present in BOTH catalogues, never shows a stored credential, and the new
 * keys keep FR / EN parity. The setup step stays OPTIONAL.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = path.join(ROOT, 'views/pages/admin/hris.ejs');
const CAT = {
    fr: require('../../locales/fr/admin.json'),
    en: require('../../locales/en/admin.json'),
};

function translator(lang, missing) {
    return (k, o = {}) => {
        const [ns, key] = k.includes(':') ? k.split(':') : ['admin', k];
        const cat = ns === 'admin' ? CAT[lang] : null;
        const s = cat ? cat[key] : null;
        if (ns === 'admin' && (s == null || s === '')) missing.push(k);
        return String(s == null ? k : s).replace(/\{\{(\w+)\}\}/g, (_, n) =>
            o[n] == null ? '' : o[n]
        );
    };
}

const plan = {
    counts: {
        joiners: 1,
        movers: 1,
        updates: 0,
        leavers: 1,
        links: 0,
        blocked: 1,
        unmapped: 2,
        errors: 1,
        unchanged: 4,
    },
    guard: {
        tripped: true,
        reason: 'too_many_leavers',
        leavers: 1,
        population: 5,
        pct: 20,
        limitPct: 10,
    },
    joiners: [
        {
            externalId: 'J1',
            name: 'Ana Diallo',
            siteId: 1,
            departmentId: 10,
            serviceId: 100,
            roleId: 1,
            email: 'a@x.test',
        },
    ],
    movers: [
        {
            externalId: 'M1',
            employeeId: 4,
            name: 'Ben',
            changes: { roleId: { from: 1, to: 2 } },
            profile: { email: 'b@x.test' },
        },
    ],
    updates: [],
    leavers: [{ externalId: 'L1', employeeId: 5, name: 'Cy', reason: 'missing' }],
    blocked: [{ externalId: 'B1', name: 'Dee', reasons: ['unmapped_role', 'role_missing'] }],
    review: [{ externalId: 'R1', name: 'Eve', reason: 'inactive_here' }],
    unmapped: [
        { field: 'role', value: 'Astronaut', count: 2, people: ['Dee'] },
        { field: 'manager', value: 'X9', count: 1, people: ['Ana'] },
    ],
    errors: [{ row: 7, externalId: 'A', code: 'duplicate_external_id' }],
    upcoming: [{ externalId: 'U1' }],
};

function locals(lang, missing, over = {}) {
    return {
        __: translator(lang, missing),
        csrfToken: 'tok',
        fmtDateTime: (d) => String(d),
        provider: 'personio',
        providers: ['csv', 'personio', 'lucca'],
        connector: {
            provider: 'personio',
            exists: true,
            enabled: true,
            autoApply: false,
            leaverGuardPct: 10,
            scheduleHour: 2,
            config: {
                base_url: 'https://api.personio.de',
                attributes: { employeeNumber: 'dynamic_1' },
            },
            credentialsStored: { client_id: true, client_secret: true },
        },
        connectors: {
            csv: { enabled: false },
            personio: { enabled: true, autoApply: false },
            lucca: { enabled: false },
        },
        credentialKeys: ['client_id', 'client_secret'],
        csvColumns: require('../../src/integrations/hris/CsvConnector').DEFAULT_COLUMNS,
        personioAttributes: require('../../src/integrations/hris/PersonioConnector')
            .DEFAULT_ATTRIBUTES,
        runs: [
            {
                id: 3,
                provider: 'personio',
                mode: 'dry_run',
                status: 'aborted',
                trigger: 'schedule',
                startedAt: 'd',
                counts: plan.counts,
                actorRef: 'system:hris',
            },
        ],
        run: {
            id: 3,
            provider: 'personio',
            mode: 'dry_run',
            status: 'planned',
            trigger: 'manual',
            startedAt: 'd',
            errors: [],
            plan,
        },
        plan,
        mappings: [
            { id: 1, kind: 'role', externalValue: 'Soudeur', targetId: 1, targetName: 'Welder' },
        ],
        refs: {
            sites: [{ id: 1, name: 'Stonebridge' }],
            departments: [{ id: 10, name: 'Mining', siteName: 'Stonebridge' }],
            services: [
                { id: 100, name: 'Open Pit', departmentName: 'Mining', siteName: 'Stonebridge' },
            ],
            roles: [
                { id: 1, name: 'Welder' },
                { id: 2, name: 'Foreman' },
            ],
        },
        scimAutoPlace: true,
        hrisBase: '/admin/integrations/hris',
        ...over,
    };
}

describe('HRIS admin page', () => {
    test.each(['fr', 'en'])('renders in %s with every key present', (lang) => {
        const missing = [];
        const html = ejs.render(fs.readFileSync(VIEW, 'utf8'), locals(lang, missing), {
            filename: VIEW,
        });
        expect(missing).toEqual([]);
        expect(html).toContain('Welder → Foreman');
        expect(html).toContain('action="/admin/integrations/hris/connector"');
        expect(html).toContain('name="currentPassword"');
        // write-only: the password inputs are always empty
        expect(html).toMatch(/name="credentials\[client_secret\]" value=""/);
        // the guard is said out loud
        expect(html).toContain(CAT[lang].hris_guard_tripped_title);
        // no inline uppercase styling
        expect(html).not.toMatch(/text-transform\s*:\s*uppercase/i);
    });

    test('empty states render (no run, no mapping, no history) — CSV connector', () => {
        const missing = [];
        const html = ejs.render(
            fs.readFileSync(VIEW, 'utf8'),
            locals('fr', missing, {
                provider: 'csv',
                connector: {
                    provider: 'csv',
                    exists: false,
                    enabled: false,
                    autoApply: false,
                    leaverGuardPct: 10,
                    scheduleHour: 2,
                    config: {},
                    credentialsStored: {},
                },
                credentialKeys: [],
                runs: [],
                run: null,
                plan: null,
                mappings: [],
            }),
            { filename: VIEW }
        );
        expect(missing).toEqual([]);
        expect(html).toContain('id="hris-upload"');
        expect((html.match(/class="hz-empty"/g) || []).length).toBe(3);
    });

    test('every hris_* key exists in both catalogues (parity)', () => {
        const keys = (o) =>
            Object.keys(o)
                .filter((k) => /^hris_|^setup_hris|^integrations_|hris_scimAutoPlace$/.test(k))
                .sort();
        expect(keys(CAT.fr)).toEqual(keys(CAT.en));
        expect(keys(CAT.fr).length).toBeGreaterThan(150);
    });
});

describe('setup and app settings link the page', () => {
    test('the HRIS step is OPTIONAL: the required steps are unchanged', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/controllers/SetupController.js'), 'utf8');
        const block = src.slice(src.indexOf("key: 'hris'"), src.indexOf("key: 'hris'") + 200);
        expect(block).toMatch(/optional: true/);
        expect(block).toMatch(/href: '\/admin\/integrations\/hris'/);
        const view = fs.readFileSync(path.join(ROOT, 'views/pages/setup/index.ejs'), 'utf8');
        expect(view).toContain("__('admin:setup_hris')");
    });

    test('app settings carries an Integrations section linking the page', () => {
        const view = fs.readFileSync(path.join(ROOT, 'views/pages/app-settings/index.ejs'), 'utf8');
        expect(view).toContain('href="/admin/integrations/hris"');
        expect(view).toContain("__('admin:integrations_h')");
    });
});
