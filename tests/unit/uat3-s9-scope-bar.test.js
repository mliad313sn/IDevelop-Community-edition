'use strict';

// UAT3 — M-12 (RÉSIDUEL de la passe 1, racine S9).
//
// Le premier correctif a bien fait suivre le FILTRE à la tuile (volet a) et
// restreint la phrase de garantie au périmètre (volet b). Restait le cas voisin,
// sur le MÊME écran et la MÊME phrase : pour un lecteur à périmètre RESTREINT et
// SANS filtre, le bandeau annonçait encore « Périmètre — Tous les sites · Tous
// les départements · Tous les services » pendant que la tuile du même onglet
// rendait `scoped=true`, `people 16`, `sites 1`, `depts 1`, `services 1`
// (mesuré en HTTP sur `uat.manager`). La garantie promettait donc PLUS LARGE que
// ce que les chiffres tenaient — la contradiction de la passe 1 avec les nombres
// inversés. Cause : `public/js/dashboard.js` (`updateScopeBar`) ne lisait que
// `state.filters` (vide à l'ouverture) et retombait sur le libellé « Tous les … »
// de la première option des listes ; et `scoped`, renvoyé « pour que la vue
// puisse l'écrire au lieu de l'affirmer », n'était lu NULLE PART.
//
// Règle tenue ici : le bandeau ne peut jamais annoncer plus large que la mesure.
// La base est simulée ; on pilote le code réel.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

let mockScopeIds = null; // ce que RBAC rend pour un lecteur restreint
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'superadmin',
    getFilteredEmployees: async () => (mockScopeIds || []).map((id) => ({ id })),
    scopeFilter: async () => ({ clause: '', params: [] }),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: async () => (mockScopeIds || []).slice(),
}));

const DashboardController = require('../../src/controllers/DashboardController');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const SUPER = { id: 666, userType: 'admin', role: 'superadmin' };
const MANAGER = { id: 136, userType: 'employee' };

// Banc d'essai : `occupied` = les entrées de catalogue réellement occupées par le
// périmètre (une ligne par entrée), `catalogue` = la taille du catalogue entier.
function bench({ occupied = {}, catalogue = {} } = {}) {
    mockDb.all.mockImplementation(async (sql) => {
        const s = flat(sql);
        const m = s.match(/FROM (sites|departments|services) t JOIN employees/i);
        if (m) return (occupied[m[1]] || []).map((name, i) => ({ id: i + 1, name }));
        return [];
    });
    mockDb.get.mockImplementation(async (sql) => {
        const s = flat(sql);
        const m = s.match(/COUNT\(\*\) AS n FROM (sites|departments|services)/i);
        if (m) return { n: catalogue[m[1]] === undefined ? 99 : catalogue[m[1]] };
        return { c: 7 };
    });
    return new DashboardController();
}

const req = (user) => ({ user, query: {}, t: (k) => k });

describe('M-12 (résiduel) — le bandeau « Périmètre » ne promet jamais plus large que la mesure', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockScopeIds = null;
    });

    test('un SuperAdmin sans périmètre est le SEUL cas « non borné »', async () => {
        const ctl = bench();
        const scope = await ctl._readerScope(req(SUPER));
        expect(scope).toEqual({ restricted: false });
        // aucune requête de périmètre n'est même émise
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('un lecteur borné à UN site / UN département / UN service les voit NOMMÉS, pas « Tous les … »', async () => {
        mockScopeIds = [138, 139, 140];
        const ctl = bench({
            occupied: { sites: ['Riverside'], departments: ['IT'], services: ['Data & Insights'] },
            catalogue: { sites: 9, departments: 10, services: 17 },
        });
        const scope = await ctl._readerScope(req(MANAGER));
        expect(scope.restricted).toBe(true);
        expect(scope.empty).toBe(false);
        expect(scope.site).toBe('Riverside');
        expect(scope.department).toBe('IT');
        expect(scope.service).toBe('Data & Insights');
        // `null` = « le libellé Tous les … est VRAI » : interdit ici.
        expect(scope.site).not.toBeNull();
    });

    test('plusieurs entrées → un COMPTE, dans l’unité de la tuile (entrées de catalogue, pas noms distincts)', async () => {
        mockScopeIds = [1, 2];
        const ctl = bench({
            // deux départements HOMONYMES sur deux sites : cas réel du jeu de
            // données (cf. src/utils/orgFilters.js). Le bandeau doit dire « 2 »,
            // comme la carte « Départements 2 », jamais « IT » au singulier.
            occupied: {
                sites: ['Riverside', 'Eastgate'],
                departments: ['IT', 'IT'],
                services: ['Data & Insights'],
            },
            catalogue: { sites: 9, departments: 10, services: 17 },
        });
        const scope = await ctl._readerScope(req(MANAGER));
        expect(scope.site).toBe('dash:scope_n_sites'); // libellé {n}, traduit
        expect(scope.department).toBe('dash:scope_n_departments');
        expect(scope.service).toBe('Data & Insights');
    });

    test('« Tous les … » n’est rendu que lorsqu’il est VRAI (le périmètre couvre tout le catalogue)', async () => {
        mockScopeIds = [1, 2, 3];
        const ctl = bench({
            occupied: { sites: ['A', 'B'], departments: ['D1'], services: ['S1', 'S2'] },
            catalogue: { sites: 2, departments: 10, services: 2 },
        });
        const scope = await ctl._readerScope(req(MANAGER));
        expect(scope.site).toBeNull(); // 2 sites occupés sur 2 → « Tous les sites » est vrai
        expect(scope.service).toBeNull();
        expect(scope.department).toBe('D1'); // 1 sur 10 → nommé
    });

    test('zéro entrée occupée n’est pas « toutes » : c’est écrit', async () => {
        mockScopeIds = [1];
        const ctl = bench({ occupied: {}, catalogue: { sites: 9, departments: 10, services: 17 } });
        const scope = await ctl._readerScope(req(MANAGER));
        expect(scope.site).toBe('dash:scope_no_site');
        expect(scope.department).toBe('dash:scope_no_department');
        expect(scope.service).toBe('dash:scope_no_service');
    });

    test('un périmètre VIDE le dit, et n’interroge aucun catalogue', async () => {
        mockScopeIds = [];
        const ctl = bench();
        const scope = await ctl._readerScope({
            user: { id: 70, userType: 'admin', role: 'viewer' },
            query: {},
            t: (k) => k,
        });
        expect(scope.restricted).toBe(true);
        expect(scope.empty).toBe(true);
        expect(scope.emptyLabel).toBe('dash:scope_empty');
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('le périmètre du bandeau est celui de la tuile : MÊME prédicat, MÊME unité', async () => {
        mockScopeIds = [138];
        const ctl = bench({ occupied: { sites: ['Riverside'] }, catalogue: { sites: 9 } });
        await ctl._readerScope(req(MANAGER));
        const sql = mockDb.all.mock.calls
            .map((c) => flat(c[0]))
            .find((s) => /FROM sites t JOIN employees/i.test(s));
        // la tuile compte `COUNT(DISTINCT t.id) … JOIN employees e ON e.site_id = t.id`
        // sans prédicat d'état ; le bandeau nomme EXACTEMENT ces entrées-là.
        expect(sql).toMatch(
            /SELECT DISTINCT t\.id AS id, t\.name AS name FROM sites t JOIN employees e ON e\.site_id = t\.id WHERE e\.id = ANY\(\?\)/
        );
        expect(sql).not.toMatch(/is_active/);
        // un SEUL paramètre tableau (le PÉRIMÈTRE gouverné — les rapports, PAS le
        // manager lui-même, F1), jamais une liste de N marqueurs. Le bandeau et la
        // tuile comptent désormais exactement ce que compte le KPI d'effectif.
        expect(mockDb.all.mock.calls[0][1]).toEqual([[138]]);
    });

    test('un périmètre irrésolu ne devient JAMAIS un périmètre ouvert', async () => {
        // RBAC lève : le contrôleur ne doit pas renvoyer « non borné » par défaut
        // pour un non-superadmin — il renvoie un périmètre non nommé.
        const ctl = bench();
        ctl._scopeEmployeeIds = async () => [];
        const scope = await ctl._readerScope(req(MANAGER));
        expect(scope.restricted).toBe(true);
    });
});

describe('M-12 (résiduel) — la vue et le script écrivent ce périmètre au lieu de l’affirmer', () => {
    const view = () => read('views/pages/dashboard.ejs');
    const js = () => read('public/js/dashboard.js');

    test('le bandeau est rendu par le SERVEUR depuis readerScope (vrai même sans JavaScript)', () => {
        const v = view();
        expect(v).toMatch(/readerScope/);
        expect(v).toMatch(/exec-scope-value"[^>]*><%=\s*_scopeParts\.join/);
        // le libellé « Tous les … » n'est plus la valeur inconditionnelle du bandeau
        expect(v).not.toMatch(/id="exec-scope-value"><%=\s*__\('dash:all_sites'\)/);
    });

    test('le périmètre est injecté pour le script, et le script le lit', () => {
        // Either spelling of the injection: the original inline JSON.stringify,
        // or the `json-script` partial that replaced it across the views. The
        // partial exists because a bare JSON.stringify leaves `<` alone, so a
        // value carrying `</script>` breaks out of the block — the escaping is
        // strictly safer here, and what matters is that readerScope is what the
        // script receives.
        expect(view()).toMatch(
            /scope:\s*<%-\s*(?:JSON\.stringify\(\(typeof readerScope|include\('[^']*json-script'[^%]*readerScope)/
        );
        const s = js();
        expect(s).toMatch(/const SCOPE = INIT\.scope \|\| \{\}/);
        expect(s).toMatch(/if \(perimeter\) return String\(perimeter\)/);
    });

    test('`scoped` de /api/dashboard/measures est CONSOMMÉ, pas seulement renvoyé', () => {
        expect(view()).toMatch(/Dashboard\.setMeasuresScoped\(!!\(d && d\.scoped\)\)/);
        const s = js();
        expect(s).toMatch(/function setMeasuresScoped/);
        expect(s).toMatch(
            /return \{ init, changePage, copyToClipboard, loadComparator, setMeasuresScoped \}/
        );
        // `const Dashboard` est une liaison lexicale : sans publication explicite,
        // `window.Dashboard` reste undefined dans un navigateur et le branchement
        // ci-dessus ne s'exécuterait jamais.
        expect(s).toMatch(/window\.Dashboard = Dashboard;/);
    });

    test('les deux locales portent les mêmes clés de périmètre, traduites', () => {
        const fr = JSON.parse(read('locales/fr/dash.json'));
        const en = JSON.parse(read('locales/en/dash.json'));
        for (const k of [
            'scope_limited',
            'scope_your_perimeter',
            'scope_empty',
            'scope_n_sites',
            'scope_n_departments',
            'scope_n_services',
            'scope_no_site',
            'scope_no_department',
            'scope_no_service',
        ]) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
            expect(fr[k].length).toBeGreaterThan(0);
        }
        for (const k of [
            'scope_limited',
            'scope_your_perimeter',
            'scope_empty',
            'scope_n_departments',
            'scope_no_site',
        ]) {
            expect(fr[k]).not.toBe(en[k]); // traduit, pas recopié
        }
        for (const k of ['scope_n_sites', 'scope_n_departments', 'scope_n_services']) {
            expect(fr[k]).toContain('{n}');
            expect(en[k]).toContain('{n}');
        }
    });
});
