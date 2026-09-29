'use strict';
/**
 * FAMILLE « ÉCRAN », étape 2 — UN APPEL JSON REDIRIGÉ (302) COMPTÉ COMME UN SUCCÈS.
 *
 * CE QUI ÉTAIT CASSÉ (mesuré le 16/09/2026 sur une base de développement,
 * serveur de la famille sur un port dédié, comptes uat.admin / uat.manager /
 * uat.employee — jamais supposé) :
 *
 *  1. CÔTÉ SERVEUR, la cause racine. Un visiteur NON CONNECTÉ portant les
 *     en-têtes JSON les plus explicites qu'une page puisse envoyer
 *     (`Content-Type` + `Accept` + `X-Requested-With` + `Origin`) recevait
 *     `302 → /login` sur LES 7 routes sondées : POST /api/coaching,
 *     POST /api/coaching/1/session, GET /api/coaching/1, GET /api/ninebox/roster,
 *     POST /cancellations, GET /api/coaching/mine, GET /admin/api-keys.
 *     `middleware/sessionActivity.js` portait SA PROPRE copie de `wantsJson`,
 *     qui ne regardait que `req.xhr` et `Accept` : les assistants fetch() des
 *     pages n'envoient que `Content-Type: application/json`, donc la branche
 *     `440 {"expired":true}` — qui existait déjà — n'était JAMAIS atteinte.
 *     `requireAuth`, `requireEmployeeOrManager`, `requireAdmin` et
 *     `requireSuperAdmin` n'avaient, eux, aucune branche JSON du tout.
 *
 *  2. CÔTÉ ÉCRAN, la conséquence. Un `fetch()` de navigateur SUIT la
 *     redirection : la page de connexion arrive en `200 text/html`, `r.ok` vaut
 *     donc `true`, `r.json()` échoue et neuf écrans l'avalaient en `{}` avec
 *     `r.json().catch(()=>({}))`. Le test `if(!r.ok||j.ok===false)` ne voyait
 *     rien. Mesure d'exécution sur 10 appelants : 10 fois « erreur levée ? NON /
 *     valeur rendue : {} ». Deux d'entre eux ANNONCENT un acte : la console des
 *     plans affichait `toast[success] Plan de coaching créé` et
 *     `toast[success] Annulation demandée` — sur une ANNULATION, donc sur la
 *     règle des deux personnes — pendant que `coaching_plans` et
 *     `cancellation_requests` restaient à 0 avant / 0 après.
 *
 *  3. Trois appels fetch() nus supplémentaires dans les mêmes fichiers : le
 *     copilote du cadre de compétences affichait `undefined` comme une réponse,
 *     et les deux lectures du hub d'apprentissage rendaient `j.list` indéfini —
 *     donc « tout est associé » et « aucune association », un REFUS affiché
 *     comme un RÉSULTAT POSITIF.
 *
 *  4. Enfin, l'en-tête de `public/js/sa-console-net.js` renvoyait le lecteur vers
 *     `tests/unit/saConsoleNet.test.js` — un fichier que l'arbre n'a jamais
 *     porté (`ls` : « No such file or directory »). La suite réelle est
 *     `tests/unit/saConsoleRefusals.test.js`.
 *
 * CE QUE CES TESTS EMPÊCHENT DE REVENIR
 *   1. qu'une garde renvoie un 3xx à un appel JSON, quelle que soit la
 *      combinaison d'en-têtes — y compris `Content-Type` SEUL ;
 *   2. qu'un second `wantsJson` incomplet réapparaisse hors de middleware/auth.js ;
 *   3. qu'une navigation de PAGE cesse de rediriger comme avant (les deux sens
 *      sont épinglés : le 302 du visiteur non connecté doit SURVIVRE) ;
 *   4. qu'un écran recopie une variante de l'assistant réseau au lieu d'appeler
 *      `SAConsoleNet` — le motif exact `r.json().catch(()=>({}))` est banni des
 *      neuf fichiers, et `fetch(` avec lui ;
 *   5. qu'un acte soit annoncé « fait » sur autre chose que la preuve renvoyée
 *      par le serveur ;
 *   6. qu'une source cite un fichier de test qui n'existe pas.
 */

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/** Commentaires retirés : un marqueur dans un commentaire ne prouve rien. */
const live = (s) =>
    s
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

const auth = require('../../src/middleware/auth');
const sessionActivity = require('../../src/middleware/sessionActivity');

// ---------------------------------------------------------------------------
// Doublures : une requête et une réponse qui enregistrent ce qui a été décidé.
// ---------------------------------------------------------------------------
function fakeRes() {
    const res = {
        statusCode: 200,
        body: null,
        redirectedTo: null,
        rendered: null,
        cleared: [],
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
        redirect(u) {
            this.redirectedTo = u;
            return this;
        },
        render(v, d) {
            this.rendered = { view: v, data: d };
            return this;
        },
        clearCookie(n) {
            this.cleared.push(n);
            return this;
        },
    };
    return res;
}
function reqOf({
    userType,
    role,
    authed = true,
    headers = {},
    xhr = false,
    p = '/api/coaching',
} = {}) {
    return {
        flashes: [],
        path: p,
        originalUrl: p,
        method: 'POST',
        isAuthenticated: () => authed,
        user: authed ? { id: 1, userType, role } : undefined,
        xhr,
        headers,
        get: () => '',
        flash(k, m) {
            this.flashes.push([k, m]);
        },
        t: (key, opts) => (opts && opts.defaultValue) || key,
    };
}

/** Les quatre formes d'appel JSON qu'un écran peut produire. */
const FORMES_JSON = [
    [
        'Content-Type SEUL (ce que les assistants des pages envoient)',
        { 'content-type': 'application/json' },
        false,
    ],
    ['Accept seul', { accept: 'application/json' }, false],
    ['req.xhr seul', {}, true],
    [
        'les trois ensemble',
        {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
        },
        false,
    ],
];

// ===========================================================================
// (1) SERVEUR — un appel JSON ne reçoit JAMAIS de 3xx
// ===========================================================================
describe('(1) serveur · un appel JSON ne reçoit jamais de 3xx', () => {
    const GARDES_ANONYME = [
        ['requireAuth', auth.requireAuth],
        ['requireEmployee', auth.requireEmployee],
        ['requireManager', auth.requireManager],
        ['requireEmployeeOrManager', auth.requireEmployeeOrManager],
        ['requireAdmin', auth.requireAdmin],
        ['requireManagerOrAdmin', auth.requireManagerOrAdmin],
        ['requireSuperAdmin', auth.requireSuperAdmin],
        ['requireReadWrite', auth.requireReadWrite],
    ];

    test.each(GARDES_ANONYME)(
        '%s · visiteur NON connecté : 401 JSON, jamais une redirection',
        (_n, guard) => {
            for (const [forme, headers, xhr] of FORMES_JSON) {
                const req = reqOf({ authed: false, headers, xhr });
                const res = fakeRes();
                guard(req, res, () => {
                    throw new Error('ne doit pas passer : ' + forme);
                });
                expect({ forme, redir: res.redirectedTo }).toEqual({ forme, redir: null });
                expect({ forme, code: res.statusCode }).toEqual({ forme, code: 401 });
                expect(typeof res.body).toBe('object');
                expect(typeof res.body.error).toBe('string');
                expect(res.body.error.trim()).not.toBe('');
            }
        }
    );

    const GARDES_MAUVAIS_PROFIL = [
        ['requireEmployee', auth.requireEmployee, { userType: 'manager' }],
        ['requireManager', auth.requireManager, { userType: 'admin', role: 'admin' }],
        [
            'requireEmployeeOrManager',
            auth.requireEmployeeOrManager,
            { userType: 'admin', role: 'admin' },
        ],
        ['requireAdmin', auth.requireAdmin, { userType: 'manager' }],
        ['requireManagerOrAdmin', auth.requireManagerOrAdmin, { userType: 'employee' }],
        ['requireSuperAdmin', auth.requireSuperAdmin, { userType: 'admin', role: 'admin' }],
        ['requireReadWrite', auth.requireReadWrite, { userType: 'admin', role: 'viewer' }],
    ];

    test.each(GARDES_MAUVAIS_PROFIL)(
        '%s · session VIVANTE du mauvais profil : 403 JSON, jamais une redirection',
        (_n, guard, who) => {
            for (const [forme, headers, xhr] of FORMES_JSON) {
                const req = reqOf({ ...who, headers, xhr });
                const res = fakeRes();
                guard(req, res, () => {
                    throw new Error('ne doit pas passer : ' + forme);
                });
                expect({ forme, redir: res.redirectedTo }).toEqual({ forme, redir: null });
                expect({ forme, code: res.statusCode }).toEqual({ forme, code: 403 });
                expect(typeof res.body).toBe('object');
            }
        }
    );

    test('le refus JSON dit POURQUOI : 401 = session, 403 = périmètre — jamais l’inverse', () => {
        const h = { 'content-type': 'application/json' };
        const anon = fakeRes();
        auth.requireAdmin(reqOf({ authed: false, headers: h }), anon, () => {});
        expect(anon.statusCode).toBe(401);
        expect(anon.body.code).toBe('session_expired');

        const vivant = fakeRes();
        auth.requireAdmin(reqOf({ userType: 'manager', headers: h }), vivant, () => {});
        expect(vivant.statusCode).toBe(403);
        expect(vivant.body.code).toBe('admin_access_required');
    });

    test('le bon profil passe — la garde ne coûte pas sans protéger', () => {
        let passes = 0;
        const h = { 'content-type': 'application/json' };
        auth.requireAuth(reqOf({ userType: 'admin', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireEmployee(reqOf({ userType: 'employee', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireManager(reqOf({ userType: 'manager', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireEmployeeOrManager(reqOf({ userType: 'manager', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireAdmin(reqOf({ userType: 'admin', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireManagerOrAdmin(reqOf({ userType: 'admin', headers: h }), fakeRes(), () => {
            passes += 1;
        });
        auth.requireSuperAdmin(
            reqOf({ userType: 'admin', role: 'superadmin', headers: h }),
            fakeRes(),
            () => {
                passes += 1;
            }
        );
        auth.requireReadWrite(
            reqOf({ userType: 'admin', role: 'admin', headers: h }),
            fakeRes(),
            () => {
                passes += 1;
            }
        );
        expect(passes).toBe(8);
    });
});

// ===========================================================================
// (2) SERVEUR — la NAVIGATION DE PAGE ne change pas d'un octet
// ===========================================================================
describe('(2) serveur · la navigation de page garde exactement son ancien 302', () => {
    const HTML = { accept: 'text/html,application/xhtml+xml' };

    test.each([
        ['requireAuth', auth.requireAuth, '/login'],
        ['requireEmployeeOrManager', auth.requireEmployeeOrManager, '/login'],
        ['requireAdmin', auth.requireAdmin, '/login'],
        ['requireManagerOrAdmin', auth.requireManagerOrAdmin, '/login'],
        ['requireSuperAdmin', auth.requireSuperAdmin, '/dashboard'],
    ])('%s · visiteur non connecté → 302 %s + message', (_n, guard, where) => {
        const req = reqOf({ authed: false, headers: HTML });
        const res = fakeRes();
        guard(req, res, () => {
            throw new Error('ne doit pas passer');
        });
        expect(res.redirectedTo).toBe(where);
        expect(res.statusCode).toBe(200); // aucun statut posé : c'est une redirection
        expect(req.flashes).toHaveLength(1); // le motif est dit
    });

    test('un en-tête Accept qui ne nomme pas json ne déclenche pas la branche JSON', () => {
        // `text/html` contient « htm », pas « json » : le reniflage doit rester strict.
        const req = reqOf({ authed: false, headers: { accept: 'text/html' } });
        const res = fakeRes();
        auth.requireAuth(req, res, () => {});
        expect(res.body).toBeNull();
        expect(res.redirectedTo).toBe('/login');
    });
});

// ===========================================================================
// (3) SERVEUR — un seul wantsJson, et il regarde bien le Content-Type
// ===========================================================================
describe('(3) serveur · UN SEUL wantsJson, complet', () => {
    test('il reconnaît les trois signaux, et rien d’autre', () => {
        expect(auth.wantsJson({ headers: { 'content-type': 'application/json' } })).toBe(true);
        expect(auth.wantsJson({ headers: { accept: 'application/json' } })).toBe(true);
        expect(auth.wantsJson({ xhr: true, headers: {} })).toBe(true);
        expect(auth.wantsJson({ headers: { accept: 'text/html' } })).toBe(false);
        expect(auth.wantsJson({ headers: {} })).toBe(false);
    });

    test('aucun autre middleware ne redéfinit son propre reniflage', () => {
        // C'est la copie locale de sessionActivity.js qui a laissé passer 302 sur
        // un appel JSON pendant tout ce temps : le reniflage vit à UN SEUL endroit.
        const dir = path.join(ROOT, 'src', 'middleware');
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'auth.js')) {
            const src = live(R('src', 'middleware', f));
            expect({
                f,
                copie: /wantsJson\s*=\s*(\(|function)[^=]*=>?[^;]*headers/.test(src),
            }).toEqual({ f, copie: false });
        }
        // Et sessionActivity emprunte bien celui d'auth.js.
        expect(live(R('src', 'middleware', 'sessionActivity.js'))).toMatch(
            /require\('\.\/auth'\)\.wantsJson/
        );
    });
});

// ===========================================================================
// (4) SERVEUR — la session expirée répond 440 JSON à un appel JSON
// ===========================================================================
describe('(4) serveur · session expirée · la branche 440 est enfin atteinte', () => {
    const TROIS_HEURES = 3 * 60 * 60 * 1000;
    const reqExpire = (headers) => ({
        path: '/api/coaching',
        headers,
        xhr: false,
        ip: '127.0.0.1',
        get: () => '',
        isAuthenticated: () => true,
        session: {
            lastActivity: Date.now() - TROIS_HEURES,
            createdAt: Date.now() - TROIS_HEURES,
            cookie: {},
            destroy(cb) {
                cb();
            },
        },
    });

    test('Content-Type: application/json SEUL → 440 {"expired":true}, aucune redirection', async () => {
        const res = fakeRes();
        await sessionActivity(reqExpire({ 'content-type': 'application/json' }), res, () => {
            throw new Error('la session expirée ne doit pas passer');
        });
        expect(res.redirectedTo).toBeNull();
        expect(res.statusCode).toBe(440);
        expect(res.body).toMatchObject({ expired: true });
    });

    test('une navigation de page garde son 302 /login?expired=1', async () => {
        const res = fakeRes();
        await sessionActivity(reqExpire({ accept: 'text/html' }), res, () => {
            throw new Error('la session expirée ne doit pas passer');
        });
        expect(res.statusCode).toBe(200);
        expect(res.redirectedTo).toBe('/login?expired=1');
    });
});

// ===========================================================================
// (5) ÉCRANS — les neuf fichiers APPELLENT le module, ils ne le recopient plus
// ===========================================================================
const NEUF = [
    'views/pages/coaching/plans-console.ejs',
    'views/pages/talent/nine-box-console.ejs',
    'views/pages/pip/index.ejs',
    'views/pages/lms/index.ejs',
    'views/pages/continuity/index.ejs',
    'views/pages/admin/api-keys.ejs',
    'views/pages/capability/index.ejs',
    'views/pages/employee/my-coaching.ejs',
    'views/pages/employee/assessment-status.ejs',
];

describe('(5) écrans · les neuf appellent SAConsoleNet, ils n’en recopient plus une variante', () => {
    test.each(NEUF)('%s charge le module AVANT son propre script et le configure', (rel) => {
        const raw = R(...rel.split('/'));
        const iMod = raw.indexOf('/js/sa-console-net.js');
        const iPage = raw.indexOf('<script nonce=');
        expect(iMod).toBeGreaterThan(-1);
        expect(iPage).toBeGreaterThan(-1);
        // Non différé et AVANT : sinon SAConsoleNet n'existe pas au premier appel.
        expect(iMod).toBeLessThan(iPage);
        expect(raw).toContain('SAConsoleNet.configure(');
    });

    test.each(NEUF)('%s : plus un seul fetch() ni le motif qui avalait la réponse', (rel) => {
        const src = live(R(...rel.split('/')));
        // LE motif exact mesuré : `{}` passait pour une réponse valide.
        expect(src).not.toContain('r.json().catch');
        // Et plus aucun appel réseau direct : tout passe par le module.
        expect(src).not.toMatch(/\bfetch\s*\(/);
        expect(src).toMatch(/SAConsoleNet\.(call|api)\(/);
    });

    test.each(NEUF)('%s configure le catalogue complet, dans la langue de la page', (rel) => {
        const raw = R(...rel.split('/'));
        for (const k of [
            'err_session',
            'err_forbidden',
            'err_notfound',
            'err_server',
            'err_http',
            'err_ref',
            'err_network',
            'err_format',
            'load_failed',
            'retry',
            'relogin',
        ]) {
            expect({ rel, k, present: raw.includes(k + ':') }).toEqual({ rel, k, present: true });
        }
        // Les libellés viennent des fichiers de locales, jamais écrits en dur.
        expect(raw).toMatch(/err_session:\s*__\('/);
    });

    test('chaque phrase du catalogue existe en FR ET en EN, et est bien traduite', () => {
        const fr = {
            ...require('../../locales/fr/talentx.json'),
            ...require('../../locales/fr/dash.json'),
        };
        const en = {
            ...require('../../locales/en/talentx.json'),
            ...require('../../locales/en/dash.json'),
        };
        const cles = [
            'sar_err_session',
            'sar_err_forbidden',
            'sar_err_notfound',
            'sar_err_server',
            'sar_err_http',
            'sar_err_ref',
            'sar_err_network',
            'sar_err_format',
            'sar_retry',
            'sar_relogin',
            'unable_to_load',
        ];
        for (const k of cles) {
            expect({ k, fr: typeof fr[k] }).toEqual({ k, fr: 'string' });
            expect({ k, en: typeof en[k] }).toEqual({ k, en: 'string' });
            expect({ k, traduit: fr[k] !== en[k] }).toEqual({ k, traduit: true });
        }
        // Le gabarit {code} / {id} survit des deux côtés, sinon l'accolade s'affiche.
        expect(fr.sar_err_http).toContain('{code}');
        expect(en.sar_err_http).toContain('{code}');
    });
});

// ===========================================================================
// (6) ÉCRANS — un acte n'est annoncé que sur la PREUVE
// ===========================================================================
describe('(6) écrans · « créé » et « annulation demandée » seulement sur la preuve du serveur', () => {
    const src = live(R('views', 'pages', 'coaching', 'plans-console.ejs'));

    test('la création vérifie le plan renvoyé avant d’afficher le toast vert', () => {
        expect(src).toMatch(/SAConsoleNet\.confirmed\(created,\s*'plan'\)/);
        expect(src.indexOf("SAConsoleNet.confirmed(created,'plan')")).toBeLessThan(
            src.indexOf('CP_T.toastCreated')
        );
    });

    test('l’ANNULATION — règle des deux personnes — vérifie le ok:true du contrôleur', () => {
        expect(src).toMatch(/SAConsoleNet\.confirmed\(r,\s*'ok'\)/);
        expect(src.indexOf("SAConsoleNet.confirmed(r,'ok')")).toBeLessThan(
            src.indexOf('CP_T.cancelRequested')
        );
        // `if(r)` était vrai pour `{}` : ce test-là est le cœur du constat.
        expect(src).not.toMatch(/if\(r\)\s*\(window\.toast/);
    });
});

// ===========================================================================
// (7) MODULE — SAConsoleNet.call : un 200 qui porte ok:false est un REFUS
// ===========================================================================
describe('(7) module · SAConsoleNet.call', () => {
    const NET = require('../../public/js/sa-console-net.js');
    const originalFetch = globalThis.fetch;
    const response = ({
        status = 200,
        contentType = 'application/json',
        body = {},
        redirected = false,
    }) => ({
        status,
        redirected,
        type: 'basic',
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        json: async () => {
            if (contentType.indexOf('json') === -1) throw new SyntaxError("Unexpected token '<'");
            return body;
        },
    });
    const serve = (r) => {
        globalThis.fetch = () => Promise.resolve(r);
    };
    beforeEach(() => NET.configure({ err_session: 'SESSION_FR', err_http: 'HTTP_FR {code}' }));
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('200 + ok:false est un refus, pas une réussite', async () => {
        serve(response({ body: { ok: false, error: 'Motif métier' } }));
        await expect(NET.call('/x', 'POST', {})).rejects.toMatchObject({ message: 'Motif métier' });
    });

    test('200 + success:false aussi', async () => {
        serve(response({ body: { success: false, error: 'Refus' } }));
        await expect(NET.call('/x', 'POST', {})).rejects.toBeTruthy();
    });

    test('la page de connexion servie en 200 après un 302 SUIVI ne passe pas', async () => {
        serve(response({ status: 200, contentType: 'text/html; charset=utf-8', redirected: true }));
        await expect(NET.call('/x', 'POST', {})).rejects.toMatchObject({
            code: 'session',
            message: 'SESSION_FR',
        });
    });

    test('le 440 du serveur ressort dans la langue de la page, pas en anglais', async () => {
        // Le serveur écrit « Session expired due to inactivity » : un écran
        // français ne l'affiche pas. Le catalogue gagne sur le code stable.
        serve(
            response({
                status: 440,
                body: { error: 'Session expired due to inactivity', expired: true },
            })
        );
        await expect(NET.call('/x', 'GET')).rejects.toMatchObject({
            code: 'session',
            message: 'SESSION_FR',
        });
    });

    test('le 401 de la garde aussi', async () => {
        serve(
            response({
                status: 401,
                body: { ok: false, error: 'Please log in', code: 'session_expired' },
            })
        );
        await expect(NET.call('/x', 'GET')).rejects.toMatchObject({
            code: 'session',
            message: 'SESSION_FR',
        });
    });

    test('une vraie réussite passe, et l’en-tête Accept est bien envoyé', async () => {
        let vu = null;
        globalThis.fetch = (url, opts) => {
            vu = opts;
            return Promise.resolve(response({ body: { ok: true, plan: { id: 7 } } }));
        };
        await expect(NET.call('/x', 'POST', { a: 1 })).resolves.toMatchObject({ plan: { id: 7 } });
        // Sans Accept, le serveur ne pouvait pas distinguer l'appel d'une navigation.
        expect(vu.headers.Accept).toContain('json');
        expect(vu.headers['X-Requested-With']).toBe('XMLHttpRequest');
    });

    test('`{}` n’est jamais une preuve', () => {
        expect(NET.confirmed({}, 'plan')).toBe(false);
        expect(NET.confirmed({ plan: { id: 1 } }, 'plan')).toBe(true);
        expect(NET.confirmed({ ok: true }, 'ok')).toBe(true);
        expect(NET.confirmed(null, 'ok')).toBe(false);
    });
});

// ===========================================================================
// (8) La source ne promet pas un fichier que l'arbre ne porte pas
// ===========================================================================
describe('(8) une source ne cite pas un fichier de test qui n’existe pas', () => {
    test('tout chemin tests/… cité dans public/js/*.js existe réellement', () => {
        const dir = path.join(ROOT, 'public', 'js');
        const manquants = [];
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            for (const m of src.matchAll(/tests\/[\w./-]+\.test\.js/g)) {
                if (!fs.existsSync(path.join(ROOT, m[0]))) manquants.push(`${f} → ${m[0]}`);
            }
        }
        expect(manquants).toEqual([]);
    });

    test('l’en-tête de sa-console-net.js nomme bien la suite qui l’exécute', () => {
        const head = R('public', 'js', 'sa-console-net.js').split('*/')[0];
        expect(head).toContain('tests/unit/saConsoleRefusals.test.js');
        expect(fs.existsSync(path.join(ROOT, 'tests', 'unit', 'saConsoleRefusals.test.js'))).toBe(
            true
        );
        // Le chemin fantôme ne doit revenir sous AUCUNE forme — le test générique
        // ci-dessus le rattraperait, celui-ci le nomme.
        expect(head).not.toContain('saConsoleNet.test.js');
    });
});
