'use strict';
/**
 * UNE HABILITATION RETIREE NE COUVRE PLUS PERSONNE — sur les QUATRE surfaces.
 *
 * `admin_scopes` garde les lignes retirees (« Désactiver », migration 110, ecrit
 * `revoked_at` et un motif : rien n'est supprime). Le fragment partage
 * `utils/reviewerGapSql.hasCoveringAdminScopeSql` ne filtrait que `expires_at`,
 * alors que `GovernanceService` et `AdminModel.findWithScopes` filtraient les
 * deux. Les surfaces avaient donc DIVERGE une seconde fois, ce que ce module
 * existe precisement pour empecher.
 *
 * Mesure sur une base de developpement : UNE SEULE habilitation, REVOQUEE, posee
 * sur un site, et la personne 102 QUITTE la liste des orphelins —
 * orphanedEmployees 6 -> 5, coverageSummary {byPerson:61, byAdmin:9, orphaned:6}
 * -> {byPerson:61, byAdmin:10, orphaned:5} — pendant que canReview(ce compte, 102)
 * restait FALSE. La liste des orphelins et la checklist d'installation
 * SOUS-DECLARAIENT les personnes sans relecteur.
 *
 * Le predicat est desormais DEFINI UNE FOIS (liveAdminScopeSql) et consomme par
 * tout le monde ; ces tests echouent si l'une des surfaces le perd de nouveau.
 */

const mockDb = {
    get: jest.fn(async () => ({})),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({ findGovernedIds: jest.fn(async () => []) }));
jest.mock('../../src/services/RBACService', () => ({
    getFilteredEmployees: jest.fn(async () => []),
}));

const {
    liveAdminScopeSql,
    hasCoveringAdminScopeSql,
    missingReviewerSql,
} = require('../../src/utils/reviewerGapSql');
const GovernanceService = require('../../src/services/GovernanceService');
const AdminModel = require('../../src/models/AdminModel');

/** Both halves of "live": neither revoked nor expired. */
function expectLivePredicate(sql, alias) {
    expect(sql).toMatch(new RegExp(`${alias}\\.revoked_at IS NULL`));
    expect(sql).toMatch(
        new RegExp(`${alias}\\.expires_at IS NULL OR ${alias}\\.expires_at > now\\(\\)`)
    );
}

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue({});
    mockDb.all.mockReset().mockResolvedValue([]);
});

describe('the predicate itself', () => {
    test('says BOTH things, on the alias it is given', () => {
        expectLivePredicate(liveAdminScopeSql('sc'), 'sc');
        expectLivePredicate(liveAdminScopeSql('acs'), 'acs');
        expect(liveAdminScopeSql()).toBe(liveAdminScopeSql('sc')); // default alias
    });

    test('a REVOKED clearance covers nobody in the shared "who reviews this person" rule', () => {
        expectLivePredicate(hasCoveringAdminScopeSql('e'), 'sc');
        expectLivePredicate(missingReviewerSql('e'), 'sc');
        // and the fragment is still one expression the callers can inline
        expect(missingReviewerSql('e')).toContain('NOT EXISTS (SELECT 1 FROM admin_scopes sc');
    });

    test('no SQL comment inside — a `--` in a SELECT list breaks GROUP BY expansion', () => {
        expect(missingReviewerSql('e')).not.toMatch(/--/);
        expect(liveAdminScopeSql('sc')).not.toMatch(/--/);
    });
});

describe('every surface consumes it — the three that had diverged, and the authority read', () => {
    test('the orphan worklist / Setup checklist rule (EmployeeModel + SetupController share this exact string)', () => {
        const fs = require('fs');
        const path = require('path');
        const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
        for (const f of ['src/models/EmployeeModel.js', 'src/controllers/SetupController.js']) {
            expect(read(f)).toMatch(/require\('\.\.\/utils\/reviewerGapSql'\)/);
        }
        // neither re-writes the rule by hand
        expect(read('src/controllers/SetupController.js')).not.toMatch(/admin_scopes/);
    });

    test('GovernanceService.orphanedEmployees keeps a revoked clearance out of the cover', async () => {
        await GovernanceService.orphanedEmployees();
        expectLivePredicate(mockDb.all.mock.calls[0][0], 'sc');
    });

    test('GovernanceService.coverageSummary counts the same people as the worklist', async () => {
        mockDb.get.mockResolvedValue({ byPerson: 61, byAdmin: 9, orphaned: 6 });
        await expect(GovernanceService.coverageSummary()).resolves.toEqual({
            byPerson: 61,
            byAdmin: 9,
            orphaned: 6,
        });
        expectLivePredicate(mockDb.get.mock.calls[0][0], 'sc');
    });

    test('GovernanceService.coveringAdmins and fallbackEmployeeIdsForAdmin too', async () => {
        await GovernanceService.coveringAdmins(102);
        expectLivePredicate(mockDb.all.mock.calls[0][0], 'sc');
        mockDb.all.mockClear();
        await GovernanceService.fallbackEmployeeIdsForAdmin(827);
        expectLivePredicate(mockDb.all.mock.calls[0][0], 'sc');
    });

    test('AdminModel.findWithScopes — the authority read behind req.user — uses the SAME predicate', async () => {
        jest.spyOn(AdminModel, 'findById').mockResolvedValue({ id: 827, username: 'x' });
        await AdminModel.findWithScopes(827);
        expectLivePredicate(mockDb.all.mock.calls[0][0], 'acs');
        AdminModel.findById.mockRestore();
    });
});
