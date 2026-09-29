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

const authority = () => {
    const src = read(...SVC);
    const start = src.indexOf('async resolveAuthority(');
    const end = src.indexOf('actorType,', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
};

describe('the reviewer scope is the sub-tree, like the list beside it', () => {
    test('inScope falls back to the transitive governs() test', () => {
        // Spelled `governs(personId, …)` since the lot "autorité" (2026-09-15):
        // the sub-tree is resolved for the PERSON acting, which for an
        // administration account is `admins.linked_employee_id`, not the admin
        // row id. Same predicate, same transitivity — the id handed to it is now
        // the human's, so a supervisor signed in on their admin account keeps
        // their own sub-tree instead of losing it.
        expect(authority()).toMatch(/await EmployeeModel\.governs\(personId, employeeId\)/);
        expect(authority()).toMatch(
            /const personId = await GovernanceService\.actingPersonId\(user\)/
        );
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

    test('the coaching service, the precedent, still does the same thing', () => {
        // Named so that if someone "simplifies" the coaching one away, this test
        // says why it was there.
        //
        // Spelled `governs(personId, …)` since the lot "talent" (2026-09-18)
        // brought coaching into line with this service: the sub-tree is resolved
        // for the PERSON acting, which for an administration account is
        // admins.linked_employee_id, not the admin row id. Same predicate, same
        // transitivity — what is asserted is that coaching still consults the
        // transitive helper at all, not which variable name holds the id.
        const coaching = read('src', 'services', 'CoachingPlanService.js');
        expect(coaching).toMatch(/await GovernanceService\.actingPersonId\(user\)/);
        expect(coaching).toMatch(/await EmployeeModel\.governs\(personId, employeeId\)/);
    });
});

describe('the sub-tree grants reading, never acting', () => {
    test('canView exists and is returned', () => {
        const a = authority();
        expect(a).toMatch(/const canView =/);
        expect(a).toMatch(/canView,/);
    });

    test('canSupervise and canManage still require the DIRECT link', () => {
        const a = authority();
        // Re-expressed as the INVARIANT rather than one literal spelling, when
        // the lot "autorité" split `inScope` (clearance UNION reporting line —
        // what may be READ) from `inClearance` (admin scopes alone — what a
        // bounded admin may ACT on). The rule protected here has not moved:
        //   * the two act-level rights are built from the DIRECT flags
        //     isSupervisor / isManager, never from the transitive sub-tree;
        //   * a Viewer never acts;
        //   * a local admin acts only inside their own clearance.
        const canSupervise = a.slice(
            a.indexOf('const canSupervise ='),
            a.indexOf('const canManage =')
        );
        const canManage = a.slice(a.indexOf('const canManage ='), a.indexOf('const canView ='));

        expect(canSupervise).toMatch(/isSupervisor/);
        expect(canSupervise).toMatch(/isManager/);
        expect(canSupervise).toMatch(/!isViewer/);
        expect(canSupervise).toMatch(/isLocalAdmin && inClearance/);
        // THE line that must never appear here: the sub-tree grants reading only.
        expect(canSupervise).not.toMatch(/governs|inScope/);

        expect(canManage).toMatch(/isManager/);
        expect(canManage).toMatch(/!isViewer/);
        expect(canManage).toMatch(/isLocalAdmin && inClearance/);
        // Managing is narrower than supervising: the supervisor flag is absent.
        expect(canManage).not.toMatch(/isSupervisor/);
        expect(canManage).not.toMatch(/governs|inScope/);
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
        expect(authority()).toMatch(/employee\.managerType === 'employee'/);
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
