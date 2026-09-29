'use strict';

/**
 * UAT3 constat E-05 — la lecture des demandes de modification n'avait AUCUN
 * contrôle d'autorisation.
 *
 * `GET /api/self-assessment/:id/change-requests` ne portait qu'un `requireAuth`,
 * et l'identifiant est un entier énumérable : n'importe quel compte connecté
 * lisait le motif confidentiel, le demandeur et le décideur d'une demande
 * portée sur quelqu'un d'autre. Le comité l'a reproduit en session de
 * l'employé 138 sur une demande de l'employé 87, motif en clair compris. Seul
 * le jeu d'essai (toutes les lignes appartenaient au lecteur) le masquait.
 *
 * La garde vit dans le SERVICE, pas seulement sur la route, pour qu'un futur
 * appelant ne puisse pas la contourner en oubliant un middleware.
 */

const path = require('path');
const SERVICE = path.join(
    __dirname,
    '..',
    '..',
    'src',
    'services',
    'AssessmentChangeRequestService.js'
);
const WF_PATH = path.join(
    __dirname,
    '..',
    '..',
    'src',
    'services',
    'SelfAssessmentWorkflowService.js'
);
const DB_PATH = path.join(__dirname, '..', '..', 'src', 'config', 'database.js');

/** Recharge le service avec une base et un moteur d'états simulés. */
function load({
    auth,
    round = { id: 7, employeeId: 87, cycleId: null, workflowState: 'approved', status: 'approved' },
}) {
    jest.resetModules();
    const all = jest.fn(async () => [{ id: 1, reason: 'motif confidentiel' }]);
    const get = jest.fn(async () => round);
    jest.doMock(DB_PATH, () => ({
        all,
        get,
        run: jest.fn(async () => ({})),
        runTransaction: jest.fn(async (f) => f()),
    }));
    jest.doMock(WF_PATH, () => ({
        _auth: jest.fn(async () => auth),
        _actorRef: jest.fn(() => 'employee:1'),
        _assertCycleWritable: jest.fn(async () => {}),
    }));
    return { svc: require(SERVICE), all, get };
}

const STRANGER = {
    isSelf: false,
    canSupervise: false,
    canManage: false,
    isAdmin: false,
    actorType: 'employee',
};
const SUBJECT = {
    isSelf: true,
    canSupervise: false,
    canManage: false,
    isAdmin: false,
    actorType: 'employee',
};
const SUPERVISOR = {
    isSelf: false,
    canSupervise: true,
    canManage: false,
    isAdmin: false,
    actorType: 'employee',
};
const MANAGER = {
    isSelf: false,
    canSupervise: false,
    canManage: true,
    isAdmin: false,
    actorType: 'employee',
};

describe('E-05 — lire les demandes d une évaluation exige un droit sur cette évaluation', () => {
    test('un tiers connecté est refusé, et AUCUNE ligne ne lui est lue', async () => {
        const { svc, all } = load({ auth: STRANGER });
        await expect(
            svc.listForAssessment(7, { id: 138, userType: 'employee' })
        ).rejects.toMatchObject({
            code: 'forbidden',
        });
        // Le refus précède la lecture : rien ne doit avoir quitté la base.
        expect(all).not.toHaveBeenCalled();
    });

    test('le sujet, son superviseur et son manager sont servis', async () => {
        for (const auth of [SUBJECT, SUPERVISOR, MANAGER]) {
            const { svc, all } = load({ auth });
            const rows = await svc.listForAssessment(7, { id: 1, userType: 'employee' });
            expect(rows).toHaveLength(1);
            expect(all).toHaveBeenCalledTimes(1);
        }
    });

    test('une évaluation inexistante répond 404, pas 403 ni une liste vide', async () => {
        const { svc } = load({ auth: SUBJECT, round: null });
        await expect(
            svc.listForAssessment(999999, { id: 1, userType: 'employee' })
        ).rejects.toMatchObject({
            code: 'not_found',
        });
    });

    test('la garde est dans le SERVICE : appeler sans utilisateur ne passe pas', async () => {
        // `WF._auth(undefined, …)` doit mener au refus, jamais à une lecture.
        const { svc, all } = load({ auth: STRANGER });
        await expect(svc.listForAssessment(7, undefined)).rejects.toMatchObject({
            code: 'forbidden',
        });
        expect(all).not.toHaveBeenCalled();
    });

    test('le contrôleur transmet bien l utilisateur de session', () => {
        const fs = require('fs');
        const src = fs.readFileSync(
            path.join(
                __dirname,
                '..',
                '..',
                'src',
                'controllers',
                'AssessmentChangeRequestController.js'
            ),
            'utf8'
        );
        expect(src).toMatch(/listForAssessment\(id\(req\), req\.user\)/);
    });
});
