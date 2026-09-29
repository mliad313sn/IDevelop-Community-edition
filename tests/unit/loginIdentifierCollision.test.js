'use strict';
/**
 * UN IDENTIFIANT, UNE IDENTITE — la collision entre un compte d'administration
 * et le login d'une personne.
 *
 * `admins.username` et `employees.username` vivent dans deux tables qu'aucune
 * contrainte ne relie. La strategie locale essaie la table des administrateurs
 * EN PREMIER : quand un compte d'administration porte le MEME identifiant qu'une
 * personne et que le mot de passe tape ouvre LES DEUX, la personne entrait sur
 * le compte d'administration — sa ligne hierarchique effacee, avec des
 * identifiants INCHANGES, et rien a l'ecran pour le dire.
 *
 * Mesure HTTP sur une base de developpement (port isole), identifiants inchanges
 * du debut a la fin : avant le compte homonyme, POST /login -> 302
 * /supervisor/dashboard et la file de ses deux rattaches ; apres, 302 /dashboard,
 * la file de l'habilitation du compte homonyme et 403 sur le detail de ses
 * propres rattaches.
 *
 * La regle posee ici : on tranche vers la MOINDRE autorite (la personne), le cas
 * est journalise, et un compte qui NOMME la personne (linked_employee_id) n'est
 * pas concerne — il n'y a la aucune ambiguite d'identite.
 *
 * La strategie passport est reellement EXECUTEE (son rappel de verification est
 * capture a l'enregistrement), pas lue comme du texte.
 */

const mockPassport = {
    use: jest.fn(),
    serializeUser: jest.fn(),
    deserializeUser: jest.fn(),
    authenticate: jest.fn(),
};
jest.mock('passport', () => mockPassport);

const mockBcrypt = { compare: jest.fn(), hash: jest.fn(async () => 'h') };
jest.mock('bcrypt', () => mockBcrypt);

const mockAuthService = { login: jest.fn() };
jest.mock('../../src/services/AuthService', () => mockAuthService);

const mockEmployeeAuth = { login: jest.fn() };
jest.mock('../../src/services/EmployeeAuthService', () => mockEmployeeAuth);

const mockEmployeeModel = {
    findByUsername: jest.fn(),
    findByIdWithOrganization: jest.fn(),
    governanceOf: jest.fn(async () => ({ governs: true, supervises: true, manages: false })),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmployeeModel);

jest.mock('../../src/models/AdminModel', () => ({
    findWithScopes: jest.fn(),
    findById: jest.fn(),
}));

const mockRecordLoginAttempt = jest.fn(async () => {});
jest.mock('../../src/middleware/rateLimiter', () => ({
    recordLoginAttempt: (...a) => mockRecordLoginAttempt(...a),
}));

const mockLog = { log: jest.fn(async () => {}) };
jest.mock('../../src/services/LogService', () => mockLog);

// AdminController (the upstream door, tested at the bottom) reaches the database
// module at load time; the guard under test never touches it.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

require('../../src/middleware/auth');

// The verify callback the strategy was registered with — run it for real.
const strategy = mockPassport.use.mock.calls[0][0];
const verify = strategy._verify;
const req = { ip: '10.0.0.7', get: () => 'jest' };

/** Run the local strategy and return what it handed to passport. */
function signIn(username, password) {
    return new Promise((resolve, reject) => {
        verify(req, username, password, (err, user, info) =>
            err ? reject(err) : resolve({ user, info })
        );
    });
}

const PERSON = {
    id: 136,
    username: 'uat.manager',
    firstName: 'A',
    lastName: 'B',
    passwordHash: 'hash-person',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockEmployeeModel.governanceOf.mockResolvedValue({
        governs: true,
        supervises: true,
        manages: false,
    });
});

describe('an identifier that names only ONE account is untouched', () => {
    test('an administration account signs in as admin, and no person is looked up', async () => {
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 5, username: 'boss', role: 'localadmin' },
        });
        mockEmployeeModel.findByUsername.mockResolvedValue(null);

        const { user } = await signIn('boss', 'pw');

        expect(user).toMatchObject({ id: 5, userType: 'admin' });
        expect(mockEmployeeAuth.login).not.toHaveBeenCalled();
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test('a person signs in as themselves when no administration account answers', async () => {
        mockAuthService.login.mockResolvedValue({ success: false });
        mockEmployeeAuth.login.mockResolvedValue({ success: true, employee: { ...PERSON } });

        const { user } = await signIn('uat.manager', 'pw');

        expect(user).toMatchObject({ id: 136, userType: 'manager', isManager: true });
        expect(mockLog.log).not.toHaveBeenCalled();
    });
});

describe('THE COLLISION — the same identifier names an administration account AND a person', () => {
    test('the password opens both: the PERSON wins, and the anomaly is written to the trail', async () => {
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 962, username: 'uat.manager', role: 'localadmin', linkedEmployeeId: null },
        });
        mockEmployeeModel.findByUsername.mockResolvedValue({ ...PERSON });
        mockBcrypt.compare.mockResolvedValue(true); // the typed password opens the person's account too
        mockEmployeeAuth.login.mockResolvedValue({ success: true, employee: { ...PERSON } });

        const { user } = await signIn('uat.manager', 'Uat3-Committee!');

        // The reporting line is NOT erased: the person signs in, as a manager.
        expect(user).toMatchObject({ id: 136, userType: 'manager', isManager: true });
        expect(user.role).toBeUndefined(); // not the administration account
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'LOGIN_IDENTIFIER_COLLISION',
                entityType: 'employee',
                entityId: 136,
                actorRef: 'employee:136',
            })
        );
    });

    test('the password opens only the administration account: nothing changes, and no noise in the trail', async () => {
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 962, username: 'jdupont', role: 'localadmin', linkedEmployeeId: null },
        });
        mockEmployeeModel.findByUsername.mockResolvedValue({
            id: 42,
            username: 'jdupont',
            passwordHash: 'other',
        });
        mockBcrypt.compare.mockResolvedValue(false); // an unrelated namesake, different password

        const { user } = await signIn('jdupont', 'admin-password');

        expect(user).toMatchObject({ id: 962, userType: 'admin' });
        expect(mockEmployeeAuth.login).not.toHaveBeenCalled(); // no spurious failed-login row for the namesake
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test('an account that NAMES the person (linked_employee_id) keeps its administration session', async () => {
        // The legitimate case: "grant admin access" links the two accounts, so
        // there is no ambiguity about who signs in — and GovernanceService
        // .actingPersonId already gives that session the person's reporting line.
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 700, username: 'uat.manager', role: 'localadmin', linkedEmployeeId: 136 },
        });
        mockBcrypt.compare.mockResolvedValue(true);

        const { user } = await signIn('uat.manager', 'Uat3-Committee!');

        expect(user).toMatchObject({ id: 700, userType: 'admin' });
        expect(mockEmployeeModel.findByUsername).not.toHaveBeenCalled();
        expect(mockEmployeeAuth.login).not.toHaveBeenCalled();
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test("the person's own account is closed (policy/deactivated): the administration session is kept, nobody is locked out", async () => {
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 962, username: 'uat.manager', role: 'localadmin', linkedEmployeeId: null },
        });
        mockEmployeeModel.findByUsername.mockResolvedValue({ ...PERSON });
        mockBcrypt.compare.mockResolvedValue(true);
        mockEmployeeAuth.login.mockResolvedValue({
            success: false,
            policyRefusal: true,
            code: 'INVITATION_EXPIRED',
        });

        const { user } = await signIn('uat.manager', 'Uat3-Committee!');

        expect(user).toMatchObject({ id: 962, userType: 'admin' });
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test('a failing audit write never blocks the sign-in', async () => {
        mockAuthService.login.mockResolvedValue({
            success: true,
            admin: { id: 962, username: 'uat.manager', role: 'localadmin', linkedEmployeeId: null },
        });
        mockEmployeeModel.findByUsername.mockResolvedValue({ ...PERSON });
        mockBcrypt.compare.mockResolvedValue(true);
        mockEmployeeAuth.login.mockResolvedValue({ success: true, employee: { ...PERSON } });
        mockLog.log.mockRejectedValueOnce(new Error('trail unavailable'));

        const { user } = await signIn('uat.manager', 'Uat3-Committee!');

        expect(user).toMatchObject({ id: 136, userType: 'manager' });
    });
});

describe("the door upstream: an administration account may not be created on a person's login", () => {
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

    test('the guard itself answers on the person, and exempts the account that NAMES them', async () => {
        const { employeeLoginExists } = require('../../src/controllers/AdminController')._internals;

        mockEmployeeModel.findByUsername.mockResolvedValue(null);
        await expect(employeeLoginExists('brand.new')).resolves.toBe(false);

        mockEmployeeModel.findByUsername.mockResolvedValue({ id: 136, username: 'uat.manager' });
        await expect(employeeLoginExists('uat.manager')).resolves.toBe(true);
        await expect(employeeLoginExists('  uat.manager  ')).resolves.toBe(true); // trimmed, not bypassable
        // the linked account keeps its own login: it is not a collision with itself
        await expect(employeeLoginExists('uat.manager', 136)).resolves.toBe(false);
        await expect(employeeLoginExists('uat.manager', 999)).resolves.toBe(true);

        // never turns administration into a dead end when the lookup itself breaks
        mockEmployeeModel.findByUsername.mockRejectedValue(new Error('db down'));
        await expect(employeeLoginExists('uat.manager')).resolves.toBe(false);
        await expect(employeeLoginExists('')).resolves.toBe(false);
    });

    test('AdminController calls it at BOTH doors — creation AND rename — and says why', () => {
        const ctrl = read('src/controllers/AdminController.js');
        expect(ctrl).toMatch(/if \(await _employeeLoginExists\(username\)\) \{/); // create
        expect(ctrl).toMatch(/if \(await _employeeLoginExists\(wanted, linkedTo\)\) \{/); // rename
        expect(ctrl).toMatch(/flash:adm_username_is_employee_login/);
    });

    test('the refusal exists in BOTH languages', () => {
        const fr = JSON.parse(read('locales/fr/flash.json'));
        const en = JSON.parse(read('locales/en/flash.json'));
        expect(typeof fr.adm_username_is_employee_login).toBe('string');
        expect(typeof en.adm_username_is_employee_login).toBe('string');
        expect(fr.adm_username_is_employee_login).toContain('{{username}}');
        expect(en.adm_username_is_employee_login).toContain('{{username}}');
        expect(fr.adm_username_is_employee_login).not.toBe(en.adm_username_is_employee_login);
    });
});
