'use strict';
/**
 * LOT UAT3 « parité » — FINITION (P2-20, EmployeePortalController:878, P2-03 miroir).
 * =========================================================================
 * CE QUI ÉTAIT CASSÉ, MESURÉ PAR EXÉCUTION SUR LA BASE DE DÉVELOPPEMENT
 * (serveur du lot sur :3506, comptes `uat.*`, `/lang/fr` puis `/lang/en`) :
 *
 *  P2-20  `POST /v2/slf/disputes` sans motif répondait la phrase de la NOTE DE
 *         RÉSOLUTION — celle destinée au manager qui TRANCHE — à l'employé qui
 *         DÉPOSE :
 *             FR → 400 {"code":"DISPUTE_REASON_REQUIRED",
 *                       "error":"Une note de résolution est obligatoire."}
 *             EN → « A resolution note is required. »
 *         Ni clé nue, ni défaut de parité : une phrase de SENS FAUX. Cause :
 *         `DisputeServiceV2` lève le MÊME code à deux endroits qui ne parlent
 *         pas de la même chose (`_requireReason` pour la note de résolution,
 *         `open()` pour le motif du dépôt) et `src/routes/v2-slf.js` mappait
 *         l'unique code sur une seule phrase, pour les QUATRE usages.
 *
 *  Portail employé  `POST /employee/reviews/:id/dispute` sans motif
 *         court-circuitait avec une chaîne ANGLAISE codée en dur :
 *             FR → 400 {"error":"Dispute reason is required"}
 *         `views/pages/employee/supervisor-reviews.ejs:175` affiche
 *         `result.error` tel quel dans un toast. Trois voisines partaient de
 *         même (« Review not found », « Not authorized to dispute this review »,
 *         et le 500 « Could not submit your dispute. Please try again. »).
 *
 *  Même geste, mesuré au passage  Les refus DIRECTS de la file des
 *         contestations (`views/pages/slf/disputes.ejs:64` affiche `j.error`)
 *         partaient tous en anglais, octet pour octet identiques en FR et en EN :
 *             404 « dispute not found » · 403 « HR arbitration permission required »
 *             409 « This dispute was already resolved or escalated. » (et ses
 *             deux sœurs L1/L2). Ces routes RÉPONDENT au lieu de lancer : aucun
 *             `sendDisputeRefusal` ne pouvait les atteindre.
 *
 *  P2-03 miroir  Le correctif de la passe 2 a rendu bilingue la voie ROUGE (le
 *         plan de coaching ouvert avec le PIP) et a laissé la voie BLEUE — les
 *         objectifs du PDI que le produit écrit lui-même — en FRANÇAIS CODÉ EN
 *         DUR : `_triggerBlue` ne recevait même pas `req`, donc aucune locale ne
 *         pouvait l'atteindre. Un lecteur anglophone recevait un plan de
 *         développement rédigé en français : le constat exactement retourné.
 *
 * CE QUE CES TESTS EMPÊCHENT DE REVENIR
 *   1. qu'un seul code d'erreur reparte avec la phrase d'un AUTRE acte — la
 *      surcharge par chemin est vérifiée dans les deux sens (dépôt ≠ résolution) ;
 *   2. qu'une phrase de refus rendue visible reparte en anglais figé sur une
 *      session française — chaque refus est comparé FR contre EN ;
 *   3. qu'une phrase existe dans une seule langue (les DEUX catalogues sont lus) ;
 *   4. qu'un texte écrit EN BASE par la machine redevienne unilingue — les deux
 *      voies du déclencheur de développement sont épinglées ensemble ;
 *   5. qu'une absence de mesure se rende comme un niveau 0 (garde F5), dans les
 *      deux langues.
 */

const path = require('path');

// ---- doublures ----------------------------------------------------------
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

jest.mock('../../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireEmployee: (req, res, next) => next(),
    requireManager: (req, res, next) => next(),
    requireManagerOrAdmin: (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
    wantsJson: () => true,
}));

const mockDispute = {
    open: jest.fn(),
    resolveL0: jest.fn(),
    resolveL1: jest.fn(),
    resolveL2: jest.fn(),
    employeeFor: jest.fn(),
    listForManager: jest.fn(),
    listForEmployee: jest.fn(),
};
jest.mock('../../src/services/DisputeServiceV2', () => mockDispute);

const mockRbac = {
    isSuperAdmin: jest.fn(() => false),
    getFilteredEmployees: jest.fn(async () => []),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => null) }));

const mockNotif = { notify: jest.fn(async () => null) };
jest.mock('../../src/services/NotificationService', () => mockNotif);

jest.mock('../../src/services/LmsService', () => ({
    autoAssignForSkills: jest.fn(async () => null),
}));

const mockReviewModel = { findById: jest.fn() };
jest.mock('../../src/models/SupervisorReviewModel', () => mockReviewModel);

// ---- traducteur d'essai : il lit les VRAIS fichiers de locales -----------
const CAT = {
    fr: {
        talentx: require('../../locales/fr/talentx.json'),
        employee: require('../../locales/fr/employee.json'),
    },
    en: {
        talentx: require('../../locales/en/talentx.json'),
        employee: require('../../locales/en/employee.json'),
    },
};
const t =
    (lang) =>
    (key, opts = {}) => {
        const [ns, k] = String(key).split(':');
        const s = CAT[lang] && CAT[lang][ns] && CAT[lang][ns][k];
        if (s == null) return opts.defaultValue !== undefined ? opts.defaultValue : key;
        return s;
    };

// ---- un petit banc pour les routes express ------------------------------
function fakeRes() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => {
        r.statusCode = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    r.redirect = (u) => {
        r.body = { redirect: u };
        return r;
    };
    r.render = (v, d) => {
        r.body = { view: v, data: d };
        return r;
    };
    return r;
}

/** Joue la chaîne d'une route du routeur, comme le ferait express. */
async function runRoute(router, method, routePath, req, res) {
    const layer = router.stack.find(
        (l) =>
            l.route &&
            (Array.isArray(l.route.path)
                ? l.route.path.includes(routePath)
                : l.route.path === routePath) &&
            l.route.methods[method.toLowerCase()]
    );
    if (!layer) throw new Error(`route absente du routeur : ${method} ${routePath}`);
    for (const h of layer.route.stack) {
        let advanced = false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
            const next = (e) => {
                advanced = true;
                return e ? reject(e) : resolve();
            };
            try {
                const out = h.handle(req, res, next);
                if (out && typeof out.then === 'function')
                    out.then(() => {
                        if (!advanced) resolve();
                    }, reject);
                else if (!advanced) setImmediate(resolve);
            } catch (e) {
                reject(e);
            }
        });
        if (res.body !== null) return res; // la route a répondu
    }
    return res;
}

const slfRouter = require('../../src/routes/v2-slf');
const EmployeePortalController = require('../../src/controllers/EmployeePortalController');
const DevelopmentTriggerService = require('../../src/services/DevelopmentTriggerService');

function reqFor(lang, extra = {}) {
    return Object.assign(
        {
            t: t(lang),
            language: lang,
            i18n: { language: lang },
            user: { id: 136, userType: 'manager', role: 'manager' },
            params: {},
            body: {},
            ip: '127.0.0.1',
            get: () => '',
        },
        extra
    );
}

/** L'erreur que lève réellement DisputeServiceV2 : status + code + phrase. */
function refusal(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    return e;
}

beforeEach(() => {
    for (const m of Object.values(mockDb)) m.mockReset();
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue({ changes: 1, lastID: 1 });
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    for (const m of Object.values(mockDispute)) m.mockReset();
    mockDispute.employeeFor.mockResolvedValue(138);
    mockRbac.isSuperAdmin.mockReset().mockReturnValue(true);
    mockRbac.getFilteredEmployees.mockReset().mockResolvedValue([{ id: 138 }]);
    mockReviewModel.findById.mockReset();
    mockNotif.notify.mockReset().mockResolvedValue(null);
});

// =========================================================================
// P2-20 — un code, deux actes, deux phrases
// =========================================================================
describe('P2-20 · « motif obligatoire » ne se dit pas comme « note de résolution obligatoire »', () => {
    const REASON_REQUIRED = () =>
        refusal(400, 'DISPUTE_REASON_REQUIRED', 'A dispute reason is required.');

    test.each(['fr', 'en'])('le DÉPÔT rend la phrase du dépôt (%s)', async (lang) => {
        mockDispute.open.mockRejectedValue(REASON_REQUIRED());
        const res = await runRoute(
            slfRouter,
            'post',
            '/disputes',
            reqFor(lang, { body: { supervisorReviewId: 1023, reason: '' } }),
            fakeRes()
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('DISPUTE_REASON_REQUIRED');
        expect(res.body.error).toBe(CAT[lang].talentx.dsp_open_reason_required);
        // Le défaut exact du constat : la phrase de la résolution servie au dépôt.
        expect(res.body.error).not.toBe(CAT[lang].talentx.dsp_note_required);
        expect(res.body.error).not.toMatch(/note de résolution|resolution note/i);
    });

    test.each(['fr', 'en'])(
        'la RÉSOLUTION garde, elle, la phrase de la note (%s)',
        async (lang) => {
            mockDispute.resolveL0.mockRejectedValue(
                refusal(400, 'DISPUTE_REASON_REQUIRED', 'A resolution note is required.')
            );
            const res = await runRoute(
                slfRouter,
                'post',
                '/disputes/:id/resolve-l0',
                reqFor(lang, { params: { id: '75' }, body: { decidedRating: 2 } }),
                fakeRes()
            );

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe(CAT[lang].talentx.dsp_note_required);
        }
    );

    test('les deux phrases existent dans les deux langues, et ne sont pas la même', () => {
        for (const lang of ['fr', 'en']) {
            expect(CAT[lang].talentx.dsp_open_reason_required).toBeTruthy();
            expect(CAT[lang].talentx.dsp_note_required).toBeTruthy();
            expect(CAT[lang].talentx.dsp_open_reason_required).not.toBe(
                CAT[lang].talentx.dsp_note_required
            );
        }
        expect(CAT.fr.talentx.dsp_open_reason_required).not.toBe(
            CAT.en.talentx.dsp_open_reason_required
        );
    });
});

// =========================================================================
// Les refus DIRECTS de la file des contestations
// =========================================================================
describe('La file des contestations : chaque refus est une phrase de la session', () => {
    test.each(['fr', 'en'])('contestation introuvable → 404 localisé (%s)', async (lang) => {
        mockDispute.employeeFor.mockResolvedValue(null);
        const res = await runRoute(
            slfRouter,
            'post',
            '/disputes/:id/resolve-l0',
            reqFor(lang, { params: { id: '99999999' }, body: { decidedRating: 2, reason: 'x' } }),
            fakeRes()
        );

        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('DISPUTE_NOT_FOUND');
        expect(res.body.error).toBe(CAT[lang].talentx.dsp_err_not_found);
        expect(res.body.error).not.toBe('dispute not found');
    });

    test.each(['fr', 'en'])('hors périmètre → 403 localisé (%s)', async (lang) => {
        mockRbac.isSuperAdmin.mockReturnValue(false);
        mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 999 }]);
        const res = await runRoute(
            slfRouter,
            'post',
            '/disputes/:id/resolve-l1',
            reqFor(lang, { params: { id: '75' }, body: { decidedRating: 2, reason: 'x' } }),
            fakeRes()
        );

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('DISPUTE_OUT_OF_SCOPE');
        expect(res.body.error).toBe(CAT[lang].talentx.dsp_err_out_of_scope);
    });

    test.each(['fr', 'en'])('arbitrage RH sans habilitation → 403 localisé (%s)', async (lang) => {
        const res = await runRoute(
            slfRouter,
            'post',
            '/disputes/:id/resolve-l2',
            reqFor(lang, { params: { id: '75' }, body: { decidedRating: 2, reason: 'x' } }),
            fakeRes()
        );

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('DISPUTE_ARBITRATION_FORBIDDEN');
        expect(res.body.error).toBe(CAT[lang].talentx.dsp_err_arbitration_permission);
        expect(res.body.error).not.toBe('HR arbitration permission required');
    });

    // Les trois échelons disent des choses DIFFÉRENTES : « déjà résolue ou
    // escaladée », « … escaladée aux RH », « … finalisée automatiquement ».
    const LADDER = [
        ['/disputes/:id/resolve-l0', 'resolveL0', 'dsp_err_already_decided_l0'],
        ['/disputes/:id/resolve-l1', 'resolveL1', 'dsp_err_already_decided_l1'],
        ['/disputes/:id/resolve-l2', 'resolveL2', 'dsp_err_already_decided_l2'],
    ];
    for (const [routePath, method, key] of LADDER) {
        test.each(['fr', 'en'])(
            `${method} sur une décision déjà prise → 409 localisé (%s)`,
            async (lang) => {
                mockDispute[method].mockResolvedValue({ resolved: false });
                const req = reqFor(lang, {
                    params: { id: '75' },
                    body: { decidedRating: 2, reason: 'x' },
                });
                // L2 n'est ouvert qu'à l'arbitre RH.
                if (method === 'resolveL2')
                    req.user = { id: 666, userType: 'admin', role: 'superadmin' };
                const res = await runRoute(slfRouter, 'post', routePath, req, fakeRes());

                expect(res.statusCode).toBe(409);
                expect(res.body.code).toBe('DISPUTE_ALREADY_DECIDED');
                expect(res.body.error).toBe(CAT[lang].talentx[key]);
                // La session FRANÇAISE ne doit plus recevoir la phrase anglaise
                // d'origine ; la session ANGLAISE, elle, la conserve volontairement.
                if (lang === 'fr') expect(res.body.error).not.toMatch(/^This dispute was already/);
                else expect(res.body.error).toMatch(/^This dispute was already/);
            }
        );
    }

    test('aucune de ces phrases n est identique entre les deux langues', () => {
        const KEYS = [
            'dsp_err_not_found',
            'dsp_err_out_of_scope',
            'dsp_err_arbitration_permission',
            'dsp_err_already_decided_l0',
            'dsp_err_already_decided_l1',
            'dsp_err_already_decided_l2',
            'dsp_open_reason_required',
        ];
        for (const k of KEYS) {
            expect(CAT.fr.talentx[k]).toBeTruthy();
            expect(CAT.en.talentx[k]).toBeTruthy();
            expect(CAT.fr.talentx[k]).not.toBe(CAT.en.talentx[k]);
        }
        // Les trois échelons ne disent pas la même chose.
        const l = ['l0', 'l1', 'l2'].map((n) => CAT.fr.talentx[`dsp_err_already_decided_${n}`]);
        expect(new Set(l).size).toBe(3);
    });
});

// =========================================================================
// Le portail employé — le court-circuit anglais
// =========================================================================
describe('Portail employé · déposer une contestation parle la langue de la session', () => {
    const call = async (lang, body, reviewRow) => {
        if (reviewRow !== undefined) mockReviewModel.findById.mockResolvedValue(reviewRow);
        const req = reqFor(lang, {
            params: { reviewId: '1023' },
            body,
            user: { id: 138, userType: 'employee' },
        });
        const res = fakeRes();
        await EmployeePortalController.disputeReview(req, res);
        return res;
    };

    test.each(['fr', 'en'])('motif vide → 400, la phrase du catalogue (%s)', async (lang) => {
        const res = await call(lang, { disputeReason: '' });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('DISPUTE_REASON_REQUIRED');
        expect(res.body.error).toBe(CAT[lang].employee.sr_err_reason_required);
        // La chaîne anglaise codée en dur du constat.
        expect(res.body.error).not.toBe('Dispute reason is required');
    });

    test('un motif fait uniquement d espaces est refusé comme un motif vide', async () => {
        const res = await call('fr', { disputeReason: '   \n\t ' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe(CAT.fr.employee.sr_err_reason_required);
    });

    test.each(['fr', 'en'])('revue introuvable → 404 localisé (%s)', async (lang) => {
        const res = await call(lang, { disputeReason: 'ma preuve n a pas été lue' }, null);
        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe(CAT[lang].employee.sr_err_review_not_found);
        expect(res.body.error).not.toBe('Review not found');
    });

    test.each(['fr', 'en'])('revue d autrui → 403 localisé (%s)', async (lang) => {
        const res = await call(lang, { disputeReason: 'motif' }, { id: 1023, employeeId: 999 });
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe(CAT[lang].employee.sr_err_not_own_review);
        expect(res.body.error).not.toBe('Not authorized to dispute this review');
    });

    test.each(['fr', 'en'])(
        'dépôt accepté → le message de succès est localisé (%s)',
        async (lang) => {
            mockDispute.open.mockResolvedValue(81);
            const res = await call(lang, { disputeReason: 'motif' }, { id: 1023, employeeId: 138 });
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe(CAT[lang].employee.sr_toast_disputed);
            expect(res.body.message).not.toMatch(/Review disputed successfully/);
            // La FORME de la réponse ne bouge pas : le gabarit lit `success` et `error`.
            expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
        }
    );

    test('le refus du SERVICE prend aussi la phrase du dépôt, jamais l invite à motif', async () => {
        mockDispute.open.mockRejectedValue(
            refusal(400, 'DISPUTE_REASON_REQUIRED', 'A dispute reason is required.')
        );
        const res = await call('fr', { disputeReason: 'motif' }, { id: 1023, employeeId: 138 });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe(CAT.fr.employee.sr_err_reason_required);
        // `sr_prompt_reason` est une INVITE (« Veuillez expliquer… : »), pas une
        // phrase de refus : elle ne doit plus servir de message d'erreur.
        expect(res.body.error).not.toBe(CAT.fr.employee.sr_prompt_reason);
        expect(res.body.error).not.toMatch(/:$/);
    });

    test.each(['fr', 'en'])(
        'une panne reste une panne, mais la phrase est localisée (%s)',
        async (lang) => {
            mockDispute.open.mockRejectedValue(new Error('ECONNRESET'));
            const res = await call(lang, { disputeReason: 'motif' }, { id: 1023, employeeId: 138 });
            expect(res.statusCode).toBe(500);
            expect(res.body.error).toBe(CAT[lang].employee.sr_err_dispute_failed);
            // Jamais le texte brut du pilote.
            expect(res.body.error).not.toMatch(/ECONNRESET/);
        }
    );

    test('les deux clés neuves existent dans les DEUX catalogues et diffèrent', () => {
        for (const k of ['sr_err_reason_required', 'sr_err_dispute_failed']) {
            expect(CAT.fr.employee[k]).toBeTruthy();
            expect(CAT.en.employee[k]).toBeTruthy();
            expect(CAT.fr.employee[k]).not.toBe(CAT.en.employee[k]);
        }
    });
});

// =========================================================================
// P2-03 miroir — la voie BLEUE du déclencheur de développement
// =========================================================================
describe('P2-03 miroir · le PDI que le produit ouvre lui-même suit la langue, comme le coaching', () => {
    const GAPS = [
        { skillId: 11, skillName: 'Work Permits', current: 1, required: 3 },
        { skillId: 12, skillName: 'Working at Height', current: null, required: 2 },
    ];

    /** Déclenche un placement BLEU et rend les textes réellement INSÉRÉS. */
    async function objectivesWritten(lang) {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM nine_box_evaluations/i.test(sql)) return null; // provenance
            if (/FROM idp_plans/i.test(sql)) return null; // aucun PDI ouvert
            if (/INSERT INTO idp_plans/i.test(sql)) return { id: 900 };
            if (/FROM employees/i.test(sql)) return { sid: 136 }; // supérieur
            return null;
        });
        mockDb.all.mockResolvedValue(GAPS);
        const req = lang ? { language: lang, i18n: { language: lang } } : null;
        const out = await DevelopmentTriggerService.triggerForPlacement(
            { id: 666, userType: 'admin', role: 'superadmin' },
            { employeeId: 85, performance: 'medium', potential: 'high', label: 'high-medium' },
            req
        );
        expect(out.zone).toBe('blue');
        return mockDb.run.mock.calls
            .filter(([sql]) => /INSERT INTO idp_objectives/i.test(sql))
            .map(([, params]) => params[2]);
    }

    test('en session FRANÇAISE, le texte est exactement celui écrit jusqu ici', async () => {
        expect(await objectivesWritten('fr')).toEqual([
            'Développer « Work Permits » du niveau 1 au niveau 3',
            'Atteindre le niveau 2 en « Working at Height » (niveau actuel non évalué)',
        ]);
    });

    test('en session ANGLAISE, le texte est anglais — c était le défaut miroir', async () => {
        expect(await objectivesWritten('en')).toEqual([
            'Develop "Work Permits" from level 1 to 3',
            'Reach level 2 in "Working at Height" (current level not assessed)',
        ]);
    });

    test('sans requête (tâche de fond), le produit retombe en FRANÇAIS, jamais en anglais', async () => {
        const written = await objectivesWritten(null);
        expect(written[0]).toBe('Développer « Work Permits » du niveau 1 au niveau 3');
    });

    test('une absence de mesure reste NON MESURÉE dans les deux langues, jamais un niveau 0', async () => {
        const fr = await objectivesWritten('fr');
        mockDb.run.mockClear();
        const en = await objectivesWritten('en');
        expect(fr[1]).toContain('niveau actuel non évalué');
        expect(fr[1]).not.toMatch(/du niveau 0|du niveau null/);
        expect(en[1]).toContain('current level not assessed');
        expect(en[1]).not.toMatch(/from level 0|from level null/);
    });

    test('les deux voies écrivent LA MÊME phrase d écart : elles décrivent le même écart', () => {
        const src = require('fs').readFileSync(
            path.join(__dirname, '../../src/services/DevelopmentTriggerService.js'),
            'utf8'
        );
        const blue = src.slice(src.indexOf('async _triggerBlue'));
        // La voie bleue ne doit plus porter sa propre copie du texte.
        expect(blue).toContain('COACHING_PIP_TEMPLATES[planLocale(req)].action');
        expect(blue).not.toMatch(/`Développer « \$\{g\.skillName\}/);
        expect(blue).not.toMatch(/`Atteindre le niveau \$\{g\.required\}/);
        // Et elle reçoit bien la locale : c'est ce qui manquait.
        expect(src).toContain('this._triggerBlue(employeeId, label, originEvaluationId, req)');
    });
});
