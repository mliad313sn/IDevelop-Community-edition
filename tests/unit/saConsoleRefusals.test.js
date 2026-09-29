'use strict';
/**
 * CE QUE L'ÉCRAN FAIT DES REFUS ET DES REDIRECTIONS — console de revue
 * d'auto-évaluation (/supervisor/self-assessment-reviews).
 *
 * CE QUI ÉTAIT CASSÉ, mesuré le 2026-09-15 sur une base de développement, avec une
 * vraie session de superviseur et le vrai bouton « Approuver » :
 *
 *  (a) BLOQUANT — un appel JSON REDIRIGÉ était compté comme un SUCCÈS. L'assistant
 *      api() de la page envoyait `Content-Type: application/json` et rien d'autre.
 *      Une session inactive depuis 2 h fait répondre au serveur
 *      `302 → /login?expired=1` ; `fetch` SUIT la redirection, la page de connexion
 *      arrive en `200 text/html`, donc `r.ok === true`, `r.json()` échoue et était
 *      avalé en `{}`. Mesure : `{"ok":true,"status":200,"redirected":true,
 *      "url":".../login?expired=1","j":"{}"}` → la page affichait le toast VERT
 *      « Terminé » pendant que `workflow_state` restait `submitted` en base.
 *      Le produit MENTAIT sur un acte.
 *  (b) MAJEUR — tout refus (403/404/500) laissait la zone de la file sur
 *      « Chargement… » à vie ; le seul signal était un toast de 6 s, en ANGLAIS
 *      pour le 403 des gardes, sur une page dont <html lang> vaut "fr".
 *  (c) MAJEUR — le bandeau décoratif « pipeline » et la file étaient dans le même
 *      `Promise.all` : un refus sur /api/self-assessment/analytics vidait TOUTE la
 *      console alors que la file, elle, avait répondu.
 *  (d) MAJEUR — la console se filtrait d'office sur `cycles[0]`, une campagne que
 *      personne n'avait choisie (sur la base d'essai : VERROUILLÉE et échue), et
 *      masquait les auto-évaluations hors campagne pendant que le bandeau du haut,
 *      lui, en comptait une.
 *
 * CE QUE CES TESTS EMPÊCHENT : que l'une de ces quatre lignes revienne. La
 * discipline vit dans public/js/sa-console-net.js (testée ici en exécution) et la
 * vue doit l'appeler (vérifié sur la source, commentaires retirés).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/** Commentaires EJS / HTML / JS retirés : un marqueur dans un commentaire ne prouve rien. */
const live = (s) =>
    s
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

const NET = require('../../public/js/sa-console-net.js');

/** Une réponse fetch, comme le navigateur la rend. */
function response({
    status = 200,
    contentType = 'application/json',
    body = {},
    redirected = false,
    type = 'basic',
}) {
    return {
        status,
        redirected,
        type,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        json: async () => {
            if (contentType.indexOf('json') === -1) throw new SyntaxError("Unexpected token '<'");
            return body;
        },
    };
}

const FR = {
    err_session: 'Votre session a expiré — reconnectez-vous.',
    err_forbidden: 'Accès refusé : cet élément est hors de votre périmètre.',
    err_notfound: 'Élément introuvable.',
    err_server: 'Le serveur a rencontré une erreur. Réessayez.',
    err_http: 'La requête a échoué (code {code}).',
    err_network: 'Le serveur est injoignable. Vérifiez votre connexion.',
    err_format: 'Réponse inattendue du serveur : une page a été renvoyée à la place des données.',
    load_failed: 'La file de revue n’a pas pu être chargée.',
    retry: 'Réessayer',
    relogin: 'Se reconnecter',
};

let calls;
const originalFetch = globalThis.fetch;
beforeEach(() => {
    calls = [];
    NET.configure(FR);
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});

const serve = (r) => {
    globalThis.fetch = (url, opts) => {
        calls.push({ url, opts });
        return Promise.resolve(r);
    };
};

describe('(a) une redirection est un ÉCHEC, jamais un succès', () => {
    test('la page de connexion servie en 200 après un 302 suivi ne peut pas passer pour une réponse', async () => {
        // Exactement ce qui était mesuré : 302 suivi, 200 text/html, r.ok true.
        serve(
            response({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                redirected: true,
                body: {},
            })
        );
        await expect(
            NET.api('/api/self-assessment/223932/approve', 'POST', {})
        ).rejects.toMatchObject({ code: 'session', message: FR.err_session });
    });

    test('une réponse opaque de redirection (redirect:manual) est traitée pareil', () => {
        expect(
            NET.classify({ status: 0, type: 'opaqueredirect', headers: { get: () => null } })
        ).toBe('session');
        expect(NET.classify({ status: 302, redirected: false, headers: { get: () => null } })).toBe(
            'session'
        );
    });

    test("un 200 HTML sans redirection n'est pas non plus une réponse valide", async () => {
        serve(response({ status: 200, contentType: 'text/html', redirected: false }));
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'format',
            message: FR.err_format,
        });
    });

    test('440 (session expirée côté serveur) et 401 sont des fins de session', async () => {
        serve(
            response({
                status: 440,
                body: { error: 'Session expired due to inactivity', expired: true },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'session',
            message: FR.err_session,
        });
        serve(response({ status: 401, body: { error: 'x' } }));
        await expect(NET.api('/x')).rejects.toMatchObject({ code: 'session' });
    });

    test("l'appel porte Accept: application/json — c'est ce qui fait répondre 440 au lieu de 302", async () => {
        serve(response({ status: 200, body: { success: true, items: [] } }));
        await NET.api('/api/self-assessment/queue');
        expect(calls[0].opts.headers.Accept).toBe('application/json');
        expect(calls[0].opts.headers['X-Requested-With']).toBe('XMLHttpRequest');
        expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
    });

    test('une réponse JSON 2xx passe et rend le corps', async () => {
        serve(response({ status: 200, body: { success: true, employees: [{ employeeId: 1 }] } }));
        await expect(NET.api('/api/self-assessment/queue-by-employee')).resolves.toEqual({
            success: true,
            employees: [{ employeeId: 1 }],
        });
    });

    test("un acte n'est « fait » que si le serveur en a renvoyé la preuve", () => {
        // `{}` est EXACTEMENT ce que rendait `r.json().catch(()=>({}))`.
        expect(NET.confirmed({}, 'assessment')).toBe(false);
        expect(NET.confirmed({ success: true }, 'assessment')).toBe(false);
        expect(NET.confirmed({ success: false, assessment: null }, 'assessment')).toBe(false);
        expect(
            NET.confirmed(
                { success: true, assessment: { id: 1, workflowState: 'approved' } },
                'assessment'
            )
        ).toBe(true);
    });
});

describe('(b) un refus se dit, dans la langue de la page, et DANS la zone', () => {
    test("le 403 anglais d'une garde de middleware est remplacé par la phrase du catalogue", async () => {
        // requireManagerOrAdmin répond {error} SANS `success` : ce n'est pas une
        // phrase traduite par utils/apiErrors, on ne la réaffiche pas telle quelle.
        serve(
            response({
                status: 403,
                body: { error: 'Access denied. Manager or admin privileges required.' },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'forbidden',
            message: FR.err_forbidden,
        });
    });

    test('le refus métier, lui, est DÉJÀ traduit par le serveur : on le garde mot pour mot', async () => {
        serve(
            response({
                status: 403,
                body: {
                    success: false,
                    error: "Vous n'êtes pas autorisé à consulter cette évaluation.",
                },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({
            message: "Vous n'êtes pas autorisé à consulter cette évaluation.",
        });
    });

    test('les trois autres marqueurs de refus métier sont respectés (ok:false, code, statut 400/409)', async () => {
        // EmployeePortalController.disputeReview : {error localisé, code}
        serve(
            response({
                status: 404,
                body: { error: 'Revue introuvable.', code: 'DISPUTE_REVIEW_NOT_FOUND' },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({ message: 'Revue introuvable.' });
        // auth.denyUserType : {ok:false, error localisé, code}
        serve(
            response({
                status: 403,
                body: {
                    ok: false,
                    error: 'Accès manager requis.',
                    code: 'manager_access_required',
                },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({ message: 'Accès manager requis.' });
        // SupervisorReviewController : 400 sans marqueur, mais un statut que seules
        // les règles métier produisent — la phrase précise vaut mieux que « code 400 ».
        serve(response({ status: 400, body: { error: 'Identifiant invalide' } }));
        await expect(NET.api('/x')).rejects.toMatchObject({
            message: 'Identifiant invalide',
            code: 'http',
        });
    });

    test("la référence d'incident d'un 500 est gardée dans le message, pas seulement dans un toast", async () => {
        serve(
            response({
                status: 500,
                body: {
                    success: false,
                    error: 'Une erreur technique est survenue.',
                    requestId: 'abc123',
                },
            })
        );
        await expect(NET.api('/x')).rejects.toMatchObject({
            message: 'Une erreur technique est survenue. (réf. abc123)',
        });
    });

    test('404 et 500 ont chacun leur phrase', async () => {
        serve(response({ status: 404, body: { error: 'nope' } }));
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'notfound',
            message: FR.err_notfound,
        });
        serve(response({ status: 500, body: { error: 'boom' } }));
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'server',
            message: FR.err_server,
        });
    });

    test('le réseau injoignable ne devient pas un « HTTP undefined »', async () => {
        globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        await expect(NET.api('/x')).rejects.toMatchObject({
            code: 'network',
            message: FR.err_network,
        });
    });

    test("la carte d'échec porte le motif ET une sortie, pas un toast qui s'efface", () => {
        const card = NET.failureCard(NET.fail('server', null, 500), 'queue');
        expect(card).toContain(FR.load_failed);
        expect(card).toContain(FR.err_server);
        expect(card).toContain('data-sa-retry="queue"');
        expect(card).toContain('role="alert"');
        // Une fin de session ne propose pas « Réessayer » : elle propose de se reconnecter.
        const gone = NET.failureCard(NET.fail('session', null, 440), 'queue');
        expect(gone).toContain('/login?expired=1');
        expect(gone).not.toContain('data-sa-retry');
    });

    test("le message du serveur est échappé avant d'atterrir dans la carte", () => {
        const card = NET.failureCard(
            NET.fail('forbidden', { success: false, error: '<img src=x onerror=alert(1)>' }, 403),
            'queue'
        );
        expect(card).not.toContain('<img');
        expect(card).toContain('&lt;img');
    });
});

describe("(c) l'ornement n'emporte pas l'essentiel", () => {
    test('un rejet du compteur laisse la file intacte', () => {
        const [queue, stats] = NET.settled([
            { status: 'fulfilled', value: { employees: [{ employeeId: 1 }] } },
            { status: 'rejected', reason: NET.fail('forbidden', null, 403) },
        ]);
        expect(queue.error).toBeNull();
        expect(queue.value.employees).toHaveLength(1);
        expect(stats.value).toBeNull();
        expect(stats.error.code).toBe('forbidden');
    });

    test("la vue charge les deux en parallèle SANS Promise.all (qui rejetait l'ensemble)", () => {
        const view = live(R('views', 'pages', 'supervisor', 'self-assessment-review.ejs'));
        expect(view).toMatch(
            /Promise\.allSettled\(\[[\s\S]{0,400}queue-by-employee[\s\S]{0,400}analytics/
        );
        expect(view).not.toMatch(/Promise\.all\(\[[\s\S]{0,400}queue-by-employee/);
    });
});

describe("(d) aucune campagne pré-sélectionnée que personne n'a choisie", () => {
    test("sans paramètre d'URL, aucun filtre — même quand une campagne tourne", () => {
        const cycles = [{ id: '9', code: '2026-Q3', status: 'locked' }];
        expect(NET.preselectedCycle('', cycles)).toBe('');
        expect(NET.preselectedCycle('?sort=gap', cycles)).toBe('');
    });

    test("le filtre demandé par l'URL est respecté", () => {
        expect(NET.preselectedCycle('?cycleId=9', [{ id: '9' }, { id: '10' }])).toBe('9');
    });

    test("une campagne demandée qui n'existe pas ne filtre rien", () => {
        expect(NET.preselectedCycle('?cycleId=42', [{ id: '9' }])).toBe('');
    });

    test('la vue passe par ce calcul et non par cycles[0]', () => {
        const view = live(R('views', 'pages', 'supervisor', 'self-assessment-review.ejs'));
        expect(view).toMatch(/SAConsoleNet\.preselectedCycle\(location\.search, this\.cycles\)/);
        expect(view).not.toMatch(/this\.cycles\[0\] \? String\(this\.cycles\[0\]\.id\)/);
    });
});

describe('la vue appelle bien cette discipline (et non plus le fetch nu)', () => {
    const view = () => live(R('views', 'pages', 'supervisor', 'self-assessment-review.ejs'));

    test('le module est chargé avant le script de la page', () => {
        const raw = R('views', 'pages', 'supervisor', 'self-assessment-review.ejs');
        expect(raw.indexOf('/js/sa-console-net.js')).toBeGreaterThan(-1);
        expect(raw.indexOf('/js/sa-console-net.js')).toBeLessThan(raw.indexOf('const SA_T = {'));
    });

    test('api() délègue au module et ne rattrape plus un json cassé en objet vide', () => {
        expect(view()).toMatch(/return await SAConsoleNet\.api\(path, method, body\)/);
        expect(view()).not.toMatch(/await r\.json\(\)\.catch\(\(\)=>\(\{\}\)\)/);
    });

    test("act() n'annonce « Terminé » qu'après confirmation", () => {
        const v = view();
        expect(v).toMatch(/SAConsoleNet\.confirmed\(j, 'assessment'\)/);
        // la ligne de succès arrive APRÈS la garde, jamais avant
        expect(v.indexOf("SAConsoleNet.confirmed(j, 'assessment')")).toBeLessThan(
            v.indexOf('SA_T.done')
        );
    });

    test('un refus est écrit dans la zone de la file et dans le tableau « en attente »', () => {
        const v = view();
        expect(v).toMatch(/failureCard\(res\.error, 'queue', 'load_failed'\)/);
        expect(v).toMatch(/failureRow\(err, 'pending', 5, 'pending_failed'\)/);
    });

    test('le catalogue de refus est passé au module dans la langue de la page', () => {
        const raw = R('views', 'pages', 'supervisor', 'self-assessment-review.ejs');
        expect(raw).toMatch(/SAConsoleNet\.configure\(/);
        expect(raw).toMatch(/err_session: __\('talentx:sar_err_session'\)/);
    });

    test('les trois autres appels JSON de mes écrans passent par le même module', () => {
        [
            'views/pages/slf/disputes.ejs',
            'views/pages/supervisor/review.ejs',
            'views/pages/employee/supervisor-reviews.ejs',
        ].forEach((p) => {
            const v = live(R(...p.split('/')));
            expect(v).toMatch(/SAConsoleNet\.api\(/);
            expect(v).not.toMatch(/fetch\([^)]*\{\s*method:\s*'POST'/);
        });
    });
});

describe('parité FR/EN des phrases de refus', () => {
    const fr = require('../../locales/fr/talentx.json');
    const en = require('../../locales/en/talentx.json');
    const KEYS = [
        'sar_err_session',
        'sar_err_forbidden',
        'sar_err_notfound',
        'sar_err_server',
        'sar_err_http',
        'sar_err_network',
        'sar_err_format',
        'sar_load_failed',
        'sar_pending_failed',
        'sar_retry',
        'sar_relogin',
        'sar_not_confirmed',
        'sar_stats_unavailable',
        'sar_stats_all_cycles',
        'sar_nothing_awaiting_cycle',
        'sar_see_all_cycles',
        'sar_server_rendered',
    ];

    test.each(KEYS)('%s est servi dans les deux langues', (k) => {
        expect(typeof fr[k]).toBe('string');
        expect(typeof en[k]).toBe('string');
        expect(fr[k].length).toBeGreaterThan(0);
        expect(en[k].length).toBeGreaterThan(0);
    });

    test('les variables des phrases paramétrées sont les mêmes des deux côtés', () => {
        ['sar_err_http', 'sar_nothing_awaiting_cycle'].forEach((k) => {
            const vars = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
            expect(vars(fr[k])).toBe(vars(en[k]));
        });
    });
});
