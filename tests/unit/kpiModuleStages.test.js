'use strict';
/**
 * The KPI module is module-aware: at adoption stages 1, 2 and 3 no indicator
 * of a module that is off is shown, and no link of the indicator pages leads
 * into a module that is off.
 *
 * The REAL glossary template is rendered with ejs, with the real FR / EN
 * catalogues and the entries KpiGlossaryController computes from the view
 * locals (user, can, appModules), for every persona and every stage preset of
 * src/config/modules.js. No database.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const M = require('../../src/config/modules');
const NAV = require('../../src/config/navigation');
const K = require('../../src/services/KpiService');
const { entries } = require('../../src/controllers/KpiGlossaryController');

const TEMPLATE = fs.readFileSync(path.join(ROOT, 'views/pages/kpi/glossary.ejs'), 'utf8');

const PERSONAS = {
    manager: { user: { id: 2, userType: 'manager', username: 'mgr' }, perms: [] },
    hr: {
        user: { id: 3, userType: 'admin', role: 'localadmin', username: 'hr' },
        perms: ['view_employees', 'manage_cycles', 'view_continuity', 'view_compliance'],
    },
    superadmin: {
        user: { id: 7, userType: 'admin', role: 'superadmin', username: 'sa' },
        perms: '*',
    },
};

function translator(lang) {
    return (key, o) => {
        const str = String(key);
        const [ns, k] = str.includes(':') ? str.split(':') : ['common', str];
        // eslint-disable-next-line security/detect-non-literal-require
        const dict = require(`../../locales/${lang}/${ns}.json`);
        let out = dict[k] !== undefined ? dict[k] : str;
        if (o) for (const [a, b] of Object.entries(o)) out = out.split(`{{${a}}}`).join(String(b));
        return out;
    };
}

function flagsFor(stage) {
    const on = new Set(M.PRESETS[stage]);
    const f = {};
    for (const k of M.MODULE_KEYS) f[k] = on.has(k);
    return f;
}

function locals(persona, flags, lang = 'fr') {
    const p = PERSONAS[persona];
    return {
        user: p.user,
        can: (s) => p.perms === '*' || p.perms.includes(s),
        wsVisible: () => true,
        appModules: flags,
        featureLocalContent: false,
        currentPath: '/kpi/glossary',
        __: translator(lang),
        lang,
    };
}

function render(L) {
    return ejs.render(TEMPLATE, {
        ...L,
        entries: entries(L),
        threshold: 80,
        contractVersion: K.CONTRACT_VERSION,
    });
}

const hrefsIn = (html) => [...html.matchAll(/href="([^"#][^"]*)"/g)].map((m) => m[1]);
const kpisIn = (html) => [...html.matchAll(/data-kpi="(K\d+)"/g)].map((m) => m[1]);

describe('the indicator contract carries its module', () => {
    test('core: K1–K4, K8, K9, K16; campaigns: K11; talent: K5–K7; development: K12, K13, K15, K28, K30; mobility: K14; no K10', () => {
        const byModule = {};
        for (const [id, c] of Object.entries(K.CONTRACTS)) {
            const m = c.module === null ? 'core' : c.module;
            (byModule[m] = byModule[m] || []).push(id);
        }
        expect(byModule).toEqual({
            core: ['K1', 'K2', 'K3', 'K4', 'K8', 'K9', 'K16'],
            campaigns: ['K11'],
            talent: ['K5', 'K6', 'K7'],
            development: ['K12', 'K13', 'K15', 'K28', 'K30'],
            mobility: ['K14'],
        });
        expect(K.CONTRACTS.K10).toBeUndefined();
        expect(Object.keys(K.KPI_FUNCTIONS).sort()).toEqual(Object.keys(K.CONTRACTS).sort());
        for (const c of Object.values(K.CONTRACTS)) {
            if (c.module !== null) expect(M.MODULE_KEYS).toContain(c.module);
            if (c.list) expect(NAV.CATALOGUE[c.list]).toBeTruthy();
        }
    });

    test('an unknown indicator is never available', () => {
        expect(K.isAvailable('K10', flagsFor(3))).toBe(false);
        expect(K.isAvailable('constructor', flagsFor(3))).toBe(false);
        expect(K.moduleOf('__proto__')).toBeUndefined();
    });
});

describe.each(['1', '2', '3'])('stage %s', (stage) => {
    const flags = flagsFor(stage);
    const off = M.MODULE_KEYS.filter((k) => !flags[k]);
    const offPrefixes = off.flatMap((k) => M.MODULE_PREFIXES[k] || []);

    test('availableKpis omits every indicator of a module that is off', () => {
        const ids = K.availableKpis(flags);
        for (const id of Object.keys(K.CONTRACTS)) {
            const m = K.CONTRACTS[id].module;
            expect([id, ids.includes(id)]).toEqual([id, m === null || flags[m] === true]);
        }
        // K16 keeps only the plan types of the modules that are on
        const types = K.availablePlanTypes(flags).map((t) => t.type);
        expect(types.includes('pip')).toBe(flags.development === true);
        expect(types.includes('coaching')).toBe(flags.development === true);
        expect(types).toContain('idp');
    });

    test.each(Object.keys(PERSONAS))(
        'the glossary of a %s lists no indicator and no link of a module that is off',
        (persona) => {
            for (const lang of ['fr', 'en']) {
                const L = locals(persona, flags, lang);
                const html = render(L);
                // every listed indicator is available, every available one is listed
                expect(kpisIn(html)).toEqual(K.availableKpis(flags));
                // no link into a module that is off
                for (const href of hrefsIn(html)) {
                    for (const p of offPrefixes) {
                        expect([href, href.startsWith(p)]).toEqual([href, false]);
                    }
                }
                // every list link is a page the reader's navigation offers
                const offered = new Set(NAV.flatten(NAV.buildNav(L)).map((x) => x.node.href));
                for (const e of entries(L)) {
                    const links = [e.listHref, ...(e.planTypes || []).map((t) => t.listHref)];
                    for (const h of links.filter(Boolean)) {
                        expect([e.id, h, offered.has(h)]).toEqual([e.id, h, true]);
                    }
                }
                // no raw key leaks into the page
                expect(html).not.toMatch(/kpi:[a-z0-9_]+/);
                expect(html).not.toMatch(/reports:dr_/);
            }
        }
    );
});

describe('stage 1 in particular', () => {
    test('no succession, key-person, development-plan or coaching link; K16 without performance plans', () => {
        const L = locals('superadmin', flagsFor('1'), 'en');
        const html = render(L);
        expect(html).not.toMatch(
            /\/v2\/continuity|\/exec\/key-person|\/v2\/idp|\/v2\/pip|\/coaching\/plans/
        );
        expect(kpisIn(html)).not.toEqual(expect.arrayContaining(['K5']));
        expect(html).toContain('id="K11"'); // campaigns are on at stage 1
        const k16 = entries(L).find((e) => e.id === 'K16');
        expect(k16.planTypes.map((t) => t.type)).toEqual(['idp']);
        expect(k16.planTypes[0].listHref).toBeNull(); // /v2/idp/manage is a development page
    });

    test('stage 3 offers the lists the modules bring', () => {
        const L = locals('superadmin', flagsFor('3'), 'en');
        const byId = Object.fromEntries(entries(L).map((e) => [e.id, e]));
        expect(byId.K5.listHref).toBe('/v2/continuity');
        expect(byId.K7.listHref).toBe('/exec/key-person');
        expect(byId.K11.listHref).toBe('/cycles');
        expect(byId.K16.planTypes.map((t) => t.listHref)).toEqual([
            '/v2/pip',
            '/v2/idp/manage',
            '/coaching/plans',
        ]);
    });
});

describe('the kpi namespace', () => {
    test('identical FR / EN key sets; every listed indicator fully documented', () => {
        const fr = require('../../locales/fr/kpi.json');
        const en = require('../../locales/en/kpi.json');
        expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
        for (const id of Object.keys(K.CONTRACTS)) {
            const k = id.toLowerCase();
            for (const f of ['name', 'def', 'formula', 'den', 'incl', 'bands']) {
                expect([k, f, typeof en[`${k}_${f}`]]).toEqual([k, f, 'string']);
            }
            expect(typeof en[`owner_${K.CONTRACTS[id].owner}`]).toBe('string');
            expect(typeof en[`freshness_${K.CONTRACTS[id].freshness}`]).toBe('string');
        }
        for (const s of Object.values(require('../../src/utils/kpiPredicates').STATUS)) {
            expect(typeof en[`status_${s}`]).toBe('string');
        }
        for (const s of require('../../src/utils/kpiPredicates').READINESS_STATES) {
            expect(typeof en[`state_${s}`]).toBe('string');
        }
        expect(Object.keys(en).some((k) => k.startsWith('k10_'))).toBe(false);
    });
});
