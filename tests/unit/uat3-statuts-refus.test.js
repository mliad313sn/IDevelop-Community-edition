'use strict';
/**
 * LOT UAT3 « statuts » — UN REFUS DE RÈGLE MÉTIER N'EST PAS UNE PANNE DE SERVEUR.
 *
 * CE QUI ÉTAIT CASSÉ (comité UAT3, passe 2 — mesuré, pas supposé)
 *
 *   P2-14  `POST /admin/maintenance/reopen-assessment` sur une évaluation d'une
 *          campagne VERROUILLÉE répondait **500**, corps `{"error":"La campagne
 *          2026-Q3 est verrouillée …"}` — sans `ok`, sans `code` — alors que le
 *          MÊME point d'entrée répond 400 `{"ok":false,…,"code":…}` pour un id
 *          introuvable. La règle, elle, était bien appliquée (0 écriture).
 *          Cause : `CycleService._gateError` porte `code` + `gate` + une phrase
 *          déjà rédigée mais AUCUN `status`, et `asyncHandler.domainRefusal`
 *          exige un 4xx pour reconnaître un refus.
 *
 *   P2-19  `POST /v2/uam/maker-checker/:id/decide` renvoyait **500** pour les
 *          trois refus de la règle des quatre yeux (demande absente, initiateur
 *          qui s'auto-approuve, demande déjà décidée). Le cas atteignable sans
 *          rien forger : deux administrateurs sur la file, A décide, B clique le
 *          bouton que sa page affiche encore → 500 « Request already applied ».
 *
 *   P2-21  `requireEmployee` et `requireManager` répondaient `302 → /login` à un
 *          appel JSON d'une session VIVANTE du mauvais type — même avec
 *          `Accept: application/json` et `X-Requested-With`. Côté navigateur :
 *          une page qui ne se remplit jamais, sans erreur visible. Et un
 *          utilisateur connecté renvoyé vers /login y perdait le motif du refus.
 *
 * CE QUE CES TESTS EMPÊCHENT DE REVENIR
 *   1. qu'un refus décidé par le produit reparte sans le statut que le produit
 *      s'est lui-même fixé (409 porte de campagne, 403/404/409 quatre yeux,
 *      403 mauvais type de compte) ;
 *   2. qu'une VRAIE faute technique soit maquillée en refus poli — l'inverse
 *      est un mensonge aussi : les deux sens sont épinglés ici ;
 *   3. qu'un refus redevienne une ligne `REQUEST_ERROR`/severity `error` dans
 *      `system_logs` (table en AJOUT SEUL : un faux incident y est définitif) —
 *      `server.js` classe sur le seul `statusCode`, donc le statut EST la trace ;
 *   4. qu'une phrase de refus nouvellement rendue visible n'existe que dans une
 *      langue (parité FR/EN vérifiée sur les fichiers de locales eux-mêmes) ;
 *   5. qu'une navigation de page ordinaire cesse de rediriger comme avant — le
 *      visiteur NON CONNECTÉ doit garder exactement l'ancien `302 → /login`.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = { log: jest.fn() };
jest.mock('../../src/services/LogService', () => mockLog);

const mockWF = { requestChanges: jest.fn(), withdrawReview: jest.fn() };
jest.mock('../../src/services/SelfAssessmentWorkflowService', () => mockWF);

const mockCycle = { assertCycleWritable: jest.fn() };
jest.mock('../../src/services/CycleService', () => mockCycle);

const MaintenanceService = require('../../src/services/MaintenanceService');
const MaintenanceController = require('../../src/controllers/MaintenanceController');
const MakerCheckerService = require('../../src/services/MakerCheckerService');

const FR = {
    flash: require('../../locales/fr/flash.json'),
    admin: require('../../locales/fr/admin.json'),
};
const EN = {
    flash: require('../../locales/en/flash.json'),
    admin: require('../../locales/en/admin.json'),
};

/** Traducteur d'essai : il lit les VRAIS fichiers de locales (fr par défaut). */
const translator =
    (lang = 'fr') =>
    (key, opts = {}) => {
        const dict = lang === 'en' ? EN : FR;
        const [ns, k] = String(key).includes(':') ? String(key).split(':') : ['flash', String(key)];
        let s = dict[ns] && dict[ns][k];
        if (s == null) return opts.defaultValue !== undefined ? opts.defaultValue : key;
        for (const [n, v] of Object.entries(opts)) s = s.split(`{{${n}}}`).join(String(v));
        return s;
    };

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };

/** L'erreur que lève réellement `CycleService._gateError` : code + gate + phrase, PAS de status. */
function gateErrorAsThrown() {
    const e = new Error(
        'La campagne 2026-Q3 est verrouillée (échéance du 31/08/2026) : ' +
            'les revues en cours se terminent, aucune nouvelle saisie n’est acceptée.'
    );
    e.code = 'cycle_write_locked';
    e.gate = {
        writable: false,
        status: 'locked',
        code: 'cycle_write_locked',
        scope: 'campagne',
        cycle: {
            id: 9,
            code: '2026-Q3',
            label: '2026-Q3',
            status: 'locked',
            closesAt: '2026-08-31',
        },
    };
    return e;
}

function fakeRes() {
    const r = { statusCode: 200, body: null, redirectedTo: null, rendered: null };
    r.status = (c) => {
        r.statusCode = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    r.redirect = (u) => {
        r.redirectedTo = u;
        return r;
    };
    r.render = (v, d) => {
        r.rendered = { view: v, data: d };
        return r;
    };
    return r;
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1, lastID: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockLog.log.mockReset().mockResolvedValue(null);
    mockWF.requestChanges.mockReset().mockResolvedValue(null);
    mockCycle.assertCycleWritable.mockReset().mockResolvedValue({ writable: true });
});

// =====================================================================
// P2-14 — la porte de campagne depuis le panneau de maintenance
// =====================================================================
describe('P2-14 · le refus de la porte de campagne sort en 409, pas en 500', () => {
    const APPROVED = {
        id: 222258,
        employeeId: 138,
        workflowState: 'approved',
        cycleId: 9,
        skillName: 'Data Platform',
    };

    test('le refus de la porte repart avec status 409 + expose, sa phrase intacte', async () => {
        mockDb.get.mockResolvedValue(APPROVED);
        mockCycle.assertCycleWritable.mockRejectedValue(gateErrorAsThrown());

        const e = await MaintenanceService.reopenAssessment(SUPER, {
            assessmentId: 222258,
            reason: 'motif',
        }).then(
            () => null,
            (err) => err
        );

        expect(e).toBeTruthy();
        // 409 « conflit d'état », le statut que le produit s'est fixé pour CETTE
        // erreur dans CycleController.STATUS_BY_CODE et dans
        // SelfAssessmentWorkflowService._assertCycleWritable.
        expect(e.status).toBe(409);
        expect(e.expose).toBe(true);
        expect(e.code).toBe('cycle_write_locked');
        // La phrase n'est PAS remplacée : elle nomme la campagne et sa date.
        expect(e.message).toContain('2026-Q3');
        expect(e.message).toContain('31/08/2026');
    });

    test('la règle tient : rien n’est écrit, aucune trace d’action', async () => {
        mockDb.get.mockResolvedValue(APPROVED);
        mockCycle.assertCycleWritable.mockRejectedValue(gateErrorAsThrown());

        await expect(
            MaintenanceService.reopenAssessment(SUPER, { assessmentId: 222258, reason: 'motif' })
        ).rejects.toMatchObject({ code: 'cycle_write_locked' });

        expect(mockWF.requestChanges).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test('une VRAIE faute technique n’est PAS déguisée en refus poli', async () => {
        // Le sens inverse du même mensonge : une panne du pilote ne porte ni
        // `gate` ni `code` métier, elle doit rester un 500 non classé.
        mockDb.get.mockResolvedValue(APPROVED);
        const boom = new Error('connection terminated unexpectedly');
        mockCycle.assertCycleWritable.mockRejectedValue(boom);

        const e = await MaintenanceService.reopenAssessment(SUPER, {
            assessmentId: 222258,
            reason: 'motif',
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toBe(boom);
        expect(e.status).toBeUndefined();
        expect(e.expose).toBeUndefined();
    });

    test('la route rend l’enveloppe complète : ok:false, code stable, campagne nommée', async () => {
        jest.spyOn(MaintenanceService, 'reopenAssessment').mockImplementation(() => {
            const e = gateErrorAsThrown();
            e.status = 409;
            e.expose = true;
            throw e;
        });
        const res = fakeRes();
        await MaintenanceController.reopenAssessment(
            { body: { assessmentId: 222258, reason: 'motif' }, user: SUPER, t: translator('fr') },
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body.ok).toBe(false);
        expect(res.body.code).toBe('cycle_write_locked');
        expect(res.body.error).toContain('2026-Q3');
        expect(res.body.cycle).toMatchObject({ id: 9, code: '2026-Q3', status: 'locked' });
    });

    test('le refus « introuvable » de la MÊME route n’a pas changé de forme (400 + code)', async () => {
        // Sonde de contrôle du comité : c'est elle qui prouvait que la route SAIT
        // répondre proprement, et donc que le 500 était bien une anomalie.
        mockDb.get.mockResolvedValue(null);
        const res = fakeRes();
        await MaintenanceController.reopenAssessment(
            { body: { assessmentId: 99999999, reason: 'motif' }, user: SUPER, t: translator('fr') },
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ ok: false, code: 'maintenance_assessment_not_found' });
    });

    test('la phrase de la porte existe en FR ET en EN', () => {
        for (const k of ['cyc_err_cycle_write_locked', 'cyc_err_cycle_write_closed']) {
            expect(typeof FR.admin[k]).toBe('string');
            expect(typeof EN.admin[k]).toBe('string');
        }
    });
});

// =====================================================================
// P2-19 — la règle des quatre yeux
// =====================================================================
describe('P2-19 · les trois refus de la règle des quatre yeux portent un statut', () => {
    const CHECKER = 7;

    test('demande absente → 404 mc_not_found', async () => {
        mockDb.get.mockResolvedValue(null);
        const e = await MakerCheckerService.decide({
            id: 42,
            checkerId: CHECKER,
            approve: true,
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toMatchObject({ status: 404, code: 'mc_not_found', expose: true });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('demande déjà décidée → 409 mc_already_decided, et l’état décidé voyage avec', async () => {
        // LE cas mesuré sans rien forger : A décide, B clique le bouton que sa
        // page affiche encore.
        mockDb.get.mockResolvedValue({
            id: 11,
            kind: 'pip.create',
            payload: {},
            maker_id: 5,
            state: 'applied',
        });
        const e = await MakerCheckerService.decide({
            id: 11,
            checkerId: CHECKER,
            approve: true,
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toMatchObject({
            status: 409,
            code: 'mc_already_decided',
            mcState: 'applied',
            expose: true,
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('l’initiateur ne peut pas s’approuver → 403 mc_maker_is_checker, zéro écriture', async () => {
        mockDb.get.mockResolvedValue({
            id: 12,
            kind: 'pip.create',
            payload: {},
            maker_id: CHECKER,
            state: 'pending',
        });
        const e = await MakerCheckerService.decide({
            id: 12,
            checkerId: CHECKER,
            approve: true,
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toMatchObject({ status: 403, code: 'mc_maker_is_checker', expose: true });
        // La RÈGLE marchait déjà, et elle doit continuer : rien n'est écrit.
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    test('un rejet doublé par un autre vérificateur → 409, et rien n’est notifié', async () => {
        mockDb.get.mockResolvedValue({
            id: 13,
            kind: 'pip.create',
            payload: {},
            maker_id: 5,
            state: 'pending',
        });
        mockDb.run.mockResolvedValue({ changes: 0 }); // l'autre a décidé entre-temps
        const e = await MakerCheckerService.decide({
            id: 13,
            checkerId: CHECKER,
            approve: false,
            reason: 'non',
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toMatchObject({ status: 409, code: 'mc_already_decided' });
    });

    test('une vraie faute reste une faute : type sans gestionnaire → pas de statut 4xx', async () => {
        mockDb.get.mockResolvedValue({
            id: 14,
            kind: 'kind.inconnu',
            payload: {},
            maker_id: 5,
            state: 'pending',
        });
        const e = await MakerCheckerService.decide({
            id: 14,
            checkerId: CHECKER,
            approve: true,
        }).then(
            () => null,
            (err) => err
        );
        expect(e).toBeTruthy();
        expect(e.status).toBeUndefined();
        expect(e.message).toContain('No handler for kind');
    });

    test('chaque refus a sa phrase en FR ET en EN', () => {
        for (const k of [
            'mcq_err_not_found',
            'mcq_err_maker_is_checker',
            'mcq_err_already_decided',
        ]) {
            expect(typeof FR.admin[k]).toBe('string');
            expect(typeof EN.admin[k]).toBe('string');
            expect(FR.admin[k]).not.toBe(EN.admin[k]); // traduit, pas recopié
        }
        // `{{state}}` est interpolé des deux côtés, sinon l'anglais afficherait
        // l'accolade brute sur l'écran de l'administrateur.
        expect(FR.admin.mcq_err_already_decided).toContain('{{state}}');
        expect(EN.admin.mcq_err_already_decided).toContain('{{state}}');
    });

    test('la route associe chaque code à une clé de traduction, et rien d’autre', () => {
        // La table de correspondance est le seul endroit où le code du service
        // devient une phrase : si un code y manque, le refus repart en anglais
        // technique sur une session française.
        const src = require('fs').readFileSync(
            require.resolve('../../src/routes/v2-uam.js'),
            'utf8'
        );
        for (const code of ['mc_not_found', 'mc_maker_is_checker', 'mc_already_decided']) {
            expect(src).toMatch(new RegExp(`${code}:\\s*'admin:mcq_err_`));
        }
    });
});

// =====================================================================
// P2-21 — un appel JSON n'est jamais renvoyé vers une page HTML
// =====================================================================
describe('P2-21 · requireEmployee / requireManager répondent au format demandé', () => {
    const { requireEmployee, requireManager } = require('../../src/middleware/auth');

    const reqOf = ({ userType, authed = true, headers = {}, xhr = false, lang = 'fr' }) => {
        const flashes = [];
        return {
            flashes,
            isAuthenticated: () => authed,
            user: authed ? { id: 1, userType } : undefined,
            xhr,
            headers,
            flash: (kind, msg) => flashes.push([kind, msg]),
            t: translator(lang),
        };
    };

    test('appel JSON d’une session vivante du mauvais type → 403 JSON, jamais 302', () => {
        for (const headers of [
            { accept: 'application/json' },
            { 'content-type': 'application/json' },
            { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        ]) {
            const req = reqOf({ userType: 'manager', headers });
            const res = fakeRes();
            requireEmployee(req, res, () => {
                throw new Error('ne doit pas passer');
            });
            expect(res.statusCode).toBe(403);
            expect(res.redirectedTo).toBeNull();
            expect(res.body).toMatchObject({ ok: false, code: 'employee_access_required' });
            expect(res.body.error).toBe(FR.flash.employee_access_required);
        }
    });

    test('même chose pour requireManager, y compris pour un ADMIN connecté', () => {
        for (const userType of ['employee', 'admin']) {
            const req = reqOf({ userType, headers: { accept: 'application/json' } });
            const res = fakeRes();
            requireManager(req, res, () => {
                throw new Error('ne doit pas passer');
            });
            expect(res.statusCode).toBe(403);
            expect(res.body).toMatchObject({ ok: false, code: 'manager_access_required' });
        }
    });

    test('le bon type passe, dans les deux gardes', () => {
        let passed = 0;
        requireEmployee(reqOf({ userType: 'employee' }), fakeRes(), () => {
            passed += 1;
        });
        requireManager(reqOf({ userType: 'manager' }), fakeRes(), () => {
            passed += 1;
        });
        expect(passed).toBe(2);
    });

    test('NAVIGATION DE PAGE, visiteur NON CONNECTÉ : exactement comme avant — 302 vers /login', () => {
        for (const guard of [requireEmployee, requireManager]) {
            const req = reqOf({
                userType: undefined,
                authed: false,
                headers: { accept: 'text/html' },
            });
            const res = fakeRes();
            guard(req, res, () => {
                throw new Error('ne doit pas passer');
            });
            expect(res.statusCode).toBe(200); // aucun statut posé : c'est une redirection
            expect(res.redirectedTo).toBe('/login');
            expect(req.flashes).toHaveLength(1);
        }
    });

    test('NAVIGATION DE PAGE, connecté du mauvais type : le motif ne se perd plus en route', () => {
        // Avant : /login → /dashboard → /employee/dashboard, et l'alerte était
        // avalée par la redirection de /login. On vise donc SON tableau de bord.
        const admin = reqOf({ userType: 'admin', headers: { accept: 'text/html' } });
        const resA = fakeRes();
        requireManager(admin, resA, () => {
            throw new Error('ne doit pas passer');
        });
        expect(resA.redirectedTo).toBe('/dashboard');
        expect(admin.flashes[0]).toEqual(['error', FR.flash.manager_access_required]);

        const mgr = reqOf({ userType: 'manager', headers: { accept: 'text/html' } });
        const resM = fakeRes();
        requireEmployee(mgr, resM, () => {
            throw new Error('ne doit pas passer');
        });
        expect(resM.redirectedTo).toBe('/employee/dashboard');
        expect(mgr.flashes[0]).toEqual(['error', FR.flash.employee_access_required]);
    });

    test('la phrase du refus existe en FR et en EN', () => {
        for (const k of ['employee_access_required', 'manager_access_required']) {
            expect(typeof FR.flash[k]).toBe('string');
            expect(typeof EN.flash[k]).toBe('string');
        }
        const en = reqOf({
            userType: 'manager',
            headers: { accept: 'application/json' },
            lang: 'en',
        });
        const res = fakeRes();
        requireEmployee(en, res, () => {});
        expect(res.body.error).toBe(EN.flash.employee_access_required);
    });
});
