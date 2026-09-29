'use strict';
/**
 * RACINE S2 / constat M-06 — la console 9-box n'offre que ce qui passera, et
 * son refus est écrit dans la langue lue.
 *
 * PREUVE D'ORIGINE, reproduite à l'identique avant la correction (serveur propre
 * sur :3212, base idevelop, session `uat.manager` = employé 136, SUPERVISEUR de
 * l'employé 139 dont le manager est 137) :
 *   · GET /api/ninebox/4042 → 200, 28 clés, AUCUNE de forme /^can[A-Z]/ ;
 *   · POST /4042/{approve,reject,archive,disclose} → 403 « Not authorized:
 *     manager/admin only » les quatre fois, 0 écriture ;
 *   · GET /talent/nine-box → 200, 85 775 octets, `<html lang="fr">`, et le JS
 *     servi construisait les boutons sur le seul `ev.status` ; le panneau de
 *     détail rendait « Approuver (manager) », « Rejeter », « Archiver »,
 *     « Communiquer au collaborateur » à ce superviseur.
 *
 * Le 403 est l'ARBITRAGE A4 (le superviseur propose, le manager décide), pas le
 * défaut : rien ici n'accorde ces droits. Le défaut était l'affordance, et la
 * phrase anglaise de service affichée par `alert(j.error)` sur une page française.
 *
 * APRÈS (re-mesuré sur le même serveur) : la charge porte `canDraft`/`canApprove`,
 * le panneau rend 0 bouton pour le superviseur et 2 pour le manager sur la même
 * évaluation, les quatre commandes rendent toujours 403 — avec une phrase FR sur
 * la page FR et EN sur la page EN.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

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
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: () => false,
    isViewer: () => false,
    hasPermission: () => true,
    canAccessEmployeeData: async () => true,
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    // Employé 139 : superviseur 136, manager 137 — la configuration exacte du constat.
    //
    // `managerType` fait PARTIE de la ligne réelle, ce n'est pas une décoration :
    // `manager_id` est polymorphe (employé ou admin) et les deux espaces
    // d'identifiants se recouvrent, donc la garde lit le discriminant avant
    // d'accorder l'autorité de manager. La contrainte chk_employees_manager_pair
    // rend la paire obligatoire en base : une fixture sans elle décrivait un état
    // que la production ne peut pas atteindre, et le manager 137 perdait
    // canApprove pour une raison qui n'existe que dans ce fichier.
    findById: jest.fn(async () => ({
        id: 139,
        supervisorId: 136,
        managerId: 137,
        managerType: 'employee',
    })),
    governs: jest.fn(async () => false),
}));
jest.mock('../../src/services/GovernanceService', () => ({
    // La PERSONNE derrière le compte : un employé est lui-même. La garde
    // l'appelle avant d'éprouver la ligne hiérarchique ; un mock partiel échoue
    // en « actingPersonId is not a function ».
    actingPersonId: jest.fn(async (u) => (u && u.id != null ? Number(u.id) : null)),
}));

const NineBoxService = require('../../src/services/NineBoxService');

const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const FR = require('../../locales/fr/talentx.json');
const EN = require('../../locales/en/talentx.json');

const SUPERVISOR = { id: 136, userType: 'manager' };
const MANAGER = { id: 137, userType: 'manager' };
const ROW = {
    id: 4042,
    employeeId: 139,
    status: 'under_review',
    box: 5,
    performance: 'medium',
    potential: 'medium',
    clearance: 'confidential',
    disclosedToEmployee: false,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue({ ...ROW });
    mockDb.run.mockResolvedValue(undefined);
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
});

// ---------------------------------------------------------------------------
describe('M-06 — la charge dit au lecteur ce qu’il a le droit de faire', () => {
    test('un SUPERVISEUR reçoit canDraft=true et canApprove=false', async () => {
        const ev = await NineBoxService.get(4042, SUPERVISOR);
        expect(ev.canDraft).toBe(true);
        expect(ev.canApprove).toBe(false);
    });

    test('le MANAGER de la personne reçoit les deux', async () => {
        const ev = await NineBoxService.get(4042, MANAGER);
        expect(ev.canDraft).toBe(true);
        expect(ev.canApprove).toBe(true);
    });

    test('les drapeaux sont ceux de la garde : A4 n’est pas touché', async () => {
        // Le superviseur reste refusé sur les quatre commandes, et rien n’écrit.
        for (const call of [
            () => NineBoxService.approve(SUPERVISOR, 4042),
            () => NineBoxService.reject(SUPERVISOR, 4042, 'motif'),
            () => NineBoxService.archive(SUPERVISOR, 4042),
            () => NineBoxService.setDisclosure(SUPERVISOR, 4042, true, 'motif'),
        ]) {
            await expect(call()).rejects.toThrow(/Not authorized: manager\/admin only/);
        }
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('la charge ne perd aucune colonne de la ligne', async () => {
        const ev = await NineBoxService.get(4042, SUPERVISOR);
        for (const k of Object.keys(ROW)) expect(ev[k]).toEqual(ROW[k]);
    });
});

// ---------------------------------------------------------------------------
describe('M-06 — la console ne construit plus ses boutons sur le seul état', () => {
    const view = SRC('views/pages/talent/nine-box-console.ejs');

    test('approve / reject / archive / disclose sont conditionnés par canApprove', () => {
        expect(view).toMatch(/const mayApprove = ev\.canApprove === true/);
        expect(view).toMatch(/open && mayApprove\?'<button[^']*NB\.act\('\+id\+',\\'approve/);
        expect(view).toMatch(
            /ev\.status==='approved' && mayApprove\?'<button[^']*NB\.act\('\+id\+',\\'archive/
        );
        // La divulgation est dans la MÊME branche que l'archivage.
        const approvedBranch = view.slice(view.indexOf("ev.status==='approved' && mayApprove"));
        expect(approvedBranch.slice(0, 600)).toMatch(/NB\.disclose\('\+id\+'/);
    });

    test('submit est conditionné par canDraft', () => {
        expect(view).toMatch(
            /const mayApprove = ev\.canApprove === true, mayDraft = ev\.canDraft === true/
        );
        expect(view).toMatch(
            /ev\.status==='draft' && mayDraft\?'<button[^']*NB\.act\('\+id\+',\\'submit/
        );
    });

    test('une charge SANS drapeau n’ouvre aucune commande (=== true, pas de défaut permissif)', () => {
        expect(view).not.toMatch(/ev\.canApprove\s*!==\s*false/);
        expect(view).not.toMatch(/ev\.canApprove\s*\|\|/);
    });

    test('le superviseur lit POURQUOI il n’y a rien à cliquer', () => {
        expect(view).toMatch(/NB_T\.managerDecides/);
        expect(view).toMatch(/talentx:nb_manager_decides/);
        expect(FR.nb_manager_decides).toBeTruthy();
        expect(EN.nb_manager_decides).toBeTruthy();
        expect(FR.nb_manager_decides).not.toBe(EN.nb_manager_decides);
    });
});

// ---------------------------------------------------------------------------
describe('M-06 — le refus est écrit dans la langue lue (même classe que M-02)', () => {
    const KEYS = [
        'nb_err_not_found',
        'nb_err_employee_not_found',
        'nb_err_not_authorized_view',
        'nb_err_not_authorized_supervisor',
        'nb_err_not_authorized_manager',
        'nb_err_not_authorized_employee',
        'nb_err_reject_reason_required',
        'nb_err_cannot_edit_from',
        'nb_err_cannot_submit_from',
        'nb_err_cannot_approve_from',
        'nb_err_cannot_reject_from',
        'nb_err_disclose_not_approved',
        'nb_err_disclose_reason_required',
        'nb_err_hide_reason_required',
    ];

    test('chaque clé existe en FR et en EN, et les deux diffèrent', () => {
        for (const k of KEYS) {
            expect(typeof FR[k]).toBe('string');
            expect(typeof EN[k]).toBe('string');
            expect(FR[k].length).toBeGreaterThan(0);
            expect(EN[k].length).toBeGreaterThan(0);
            expect(FR[k]).not.toBe(EN[k]);
        }
    });

    test('aucune phrase du catalogue n’expose une valeur d’énumération brute', () => {
        for (const k of KEYS) {
            for (const dict of [FR, EN]) {
                expect(dict[k]).not.toMatch(/'(draft|under_review|approved|rejected|archived)'/);
            }
        }
    });

    test('les refus du service portent la clé sans changer la phrase de référence', async () => {
        const grab = async (fn) => {
            try {
                await fn();
                return null;
            } catch (e) {
                return e;
            }
        };

        const e403 = await grab(() => NineBoxService.approve(SUPERVISOR, 4042));
        expect(e403.message).toBe('Not authorized: manager/admin only'); // phrase de RÉFÉRENCE intacte
        expect(e403.i18n).toEqual({ key: 'talentx:nb_err_not_authorized_manager' });

        mockDb.get.mockResolvedValue({ ...ROW, status: 'approved' });
        const e409 = await grab(() => NineBoxService.approve(MANAGER, 4042));
        expect(e409.message).toBe("Cannot approve from 'approved'");
        expect(e409.i18n).toEqual({
            key: 'talentx:nb_err_cannot_approve_from',
            vars: { statusRaw: 'approved' },
        });

        const e400 = await grab(() => NineBoxService.setDisclosure(MANAGER, 4042, true, '   '));
        expect(e400.message).toMatch(/motif écrit est obligatoire/i);
        expect(e400.i18n).toEqual({ key: 'talentx:nb_err_disclose_reason_required' });

        mockDb.get.mockResolvedValue(null);
        const e404 = await grab(() => NineBoxService.get(4042, MANAGER));
        expect(e404.message).toBe('Evaluation not found');
        expect(e404.i18n).toEqual({ key: 'talentx:nb_err_not_found' });
    });

    test('le contrôleur rend la clé et fige le statut AVANT de traduire', () => {
        const ctl = SRC('src/controllers/NineBoxController.js');
        expect(ctl).toMatch(/e\.i18n && e\.i18n\.key/);
        expect(ctl).toMatch(/if \(!e\.status\) e\.status = domainStatus\(/);
        expect(ctl).toMatch(/vars\.statusRaw/); // jamais l'énum brute dans la phrase
        expect(ctl).toMatch(/enumLabel\(/);
        expect(ctl).toMatch(/defaultValue: String\(e\.message/); // clé manquante → phrase d'avant
        expect(ctl).toMatch(/e\.expose = true/);
    });
});
