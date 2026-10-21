'use strict';
/**
 * The review console must never LIST a person it then refuses the DETAIL of.
 *
 * Reported from PRODUCTION (2026-09-15): "some supervisors and managers cannot
 * see the detail on the SA review". The "some" was the clue.
 *
 * What was happening: the queue is scoped by `middleware/rbac.js` through
 * `EmployeeModel.findGovernedIds`, a transitive BFS over the whole reporting
 * sub-tree — reports, reports-of-reports, and so on. But
 * `SelfAssessmentWorkflowService.resolveAuthority` recognised only the DIRECT
 * link (`user.id === employee.supervisorId || user.id === employee.managerId`).
 * An N+2 reviewer therefore saw their indirect reports listed in the console and
 * was refused 403 on every detail and every action behind it. A first-line
 * supervisor never met it, which is exactly why only "some" reviewers reported
 * the fault.
 *
 * `CoachingPlanService.resolveAuthority` already carried this fix — the
 * self-assessment workflow simply never received it. The rule taken from that
 * precedent, deliberately: **the sub-tree grants READ, never the right to ACT.**
 * Approving, requesting changes and arbitrating stay with the direct
 * supervisor/manager.
 *
 * 4.0.0 port (wave 2) — the AUTHORITY LADDER (services/AuthorityService). The
 * facts (the person behind the account, the discriminator, the clearance, the
 * sub-tree) are now resolved once, by AuthorityService.relation, for every
 * review service. The rule above is STRICT mode, the default on new installs
 * and upgrades, and this file still pins it. Only the SuperAdmin setting
 * `authority.ladder = extended` lets the line above act, as the manager, and
 * that widening lives in AuthorityService alone.
 *
 * Two further holes in the same function are pinned here:
 *   - `manager_id` is POLYMORPHIC (employee or admin) and the id spaces overlap.
 *     Without `manager_type`, the employee whose id equalled the ADMIN id
 *     managing someone was handed canSupervise AND canManage over a stranger —
 *     while the list, which does filter it, excluded them. The list and the
 *     authority disagreed in the dangerous direction.
 *   - Reads must gate on `canView`, never on `canSupervise`.
 *
 * Source-level, deliberately: it runs with no database, on every developer
 * machine, in under a second.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SVC = ['src', 'services', 'SelfAssessmentWorkflowService.js'];

const AUTH = () => read('src', 'services', 'AuthorityService.js');

const authority = () => {
    const src = read(...SVC);
    const start = src.indexOf('async resolveAuthority(');
    const end = src.indexOf('actorType,', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
};

describe('the reviewer scope is the sub-tree, like the list beside it', () => {
    test('inScope falls back to the transitive governs() test, for the PERSON acting', () => {
        // The sub-tree is resolved for the PERSON acting, which for an
        // administration account is `admins.linked_employee_id`, not the admin
        // row id — in the one resolver every review service shares.
        expect(AUTH()).toContain('await EmployeeModel.governs(personId, eid)');
        expect(AUTH()).toContain('await GovernanceService.actingPersonId(user)');
        expect(authority()).toContain('AuthorityService.relation(user, employee)');
        expect(authority()).toMatch(/const inScope = Boolean\([\s\S]{0,160}rel\.inLine/);
    });

    test('it is the SAME helper the queue is scoped by', () => {
        // If these two ever resolve differently, the console lists one
        // population and authorises another — the defect, exactly.
        expect(read('src', 'middleware', 'rbac.js')).toMatch(
            /EmployeeModel\.findGovernedIds\(req\.user\.id\)/
        );
        expect(read('src', 'models', 'EmployeeModel.js')).toMatch(
            /async governs\(managerId, employeeId\)[\s\S]{0,400}findGovernedIds\(mid\)/
        );
    });

    test('the coaching service, the precedent, resolves through the same relation', () => {
        // Named so that if someone "simplifies" the coaching one away, this test
        // says why it was there: coaching reads the same sub-tree, for the same
        // person, through the same resolver.
        const coaching = read('src', 'services', 'CoachingPlanService.js');
        expect(coaching).toContain('AuthorityService.relation(user, employee)');
        expect(coaching).toMatch(/rel\.inLine/);
    });
});

describe('the sub-tree grants reading, never acting', () => {
    test('canView exists and is returned', () => {
        const a = authority();
        expect(a).toMatch(/const canView =/);
        expect(a).toMatch(/canView,/);
    });

    test('canSupervise and canManage still require the DIRECT link (strict mode)', () => {
        const a = authority();
        // The INVARIANT, not one literal spelling. The strict half of each
        // act-level right (today's rule, the default) is built from the DIRECT
        // flags isSupervisor / isManager, never from the transitive sub-tree; a
        // Viewer never acts; a local admin acts only inside their clearance.
        const canSupervise = a.slice(
            a.indexOf('const strictSupervise ='),
            a.indexOf('const strictManage =')
        );
        const canManage = a.slice(
            a.indexOf('const strictManage ='),
            a.indexOf('const supervise =')
        );

        expect(canSupervise).toMatch(/isSupervisor/);
        expect(canSupervise).toMatch(/isManager/);
        expect(canSupervise).toMatch(/!isViewer/);
        expect(canSupervise).toMatch(/isLocalAdmin && inClearance/);
        // THE line that must never appear here: the sub-tree grants reading only.
        expect(canSupervise).not.toMatch(/governs|inScope|inLine|isLineAbove/);

        expect(canManage).toMatch(/isManager/);
        expect(canManage).toMatch(/!isViewer/);
        expect(canManage).toMatch(/isLocalAdmin && inClearance/);
        // Managing is narrower than supervising: the supervisor flag is absent.
        expect(canManage).not.toMatch(/isSupervisor/);
        expect(canManage).not.toMatch(/governs|inScope|inLine|isLineAbove/);

        // The rights handed out are the strict ones, plus the ladder ONLY in
        // extended mode — decided in AuthorityService, never here.
        expect(a).toMatch(
            /AuthorityService\.allows\(rel, 'sa\.approve', \{\s*strict: strictSupervise/
        );
        expect(a).toMatch(
            /AuthorityService\.allows\(rel, 'sa\.validate', \{ strict: strictManage \}\)/
        );
        expect(AUTH()).toMatch(/rel\.mode === 'extended' && def\.widens !== false/);
    });

    test('the read gates use canView, and the write gates do not', () => {
        const src = read(...SVC);
        // _assertCanView is the shared read gate behind the thread, the events
        // and the detail panel.
        const guard = src.slice(
            src.indexOf('async _assertCanView('),
            src.indexOf('async getThread(')
        );
        expect(guard).toMatch(/if \(!auth\.canView\)/);
        expect(guard).not.toMatch(/auth\.canSupervise/);

        // Commenting is an ACT: it must NOT have been widened along with the reads.
        const commentGate = src.slice(
            src.indexOf('Not authorized to comment') - 400,
            src.indexOf('Not authorized to comment')
        );
        expect(commentGate).toMatch(/auth\.canSupervise \|\| auth\.canManage/);
    });
});

describe('manager_id is polymorphic and must be read with its discriminator', () => {
    test('isManager requires manager_type === employee', () => {
        expect(AUTH()).toMatch(/employee\.managerType === 'employee'/);
        expect(AUTH()).toMatch(/employee\.managerType === 'admin'/);
        expect(authority()).toMatch(
            /const isManager = Boolean\(rel\.isDirectManager \|\| rel\.isAdminManager\)/
        );
    });

    test('the list-side helper has always required it, and still does', () => {
        expect(read('src', 'models', 'EmployeeModel.js')).toMatch(
            /manager_id = ANY\(\?\) AND manager_type = 'employee'/
        );
    });

    test('the two login-time helpers agree with it', () => {
        // governsAnyone and governanceOf decide whether someone is classed a
        // manager at all. All three must apply the same rule or they disagree
        // about who governs whom.
        const m = read('src', 'models', 'EmployeeModel.js');
        const occurrences = (m.match(/manager_type = 'employee'/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });
});
