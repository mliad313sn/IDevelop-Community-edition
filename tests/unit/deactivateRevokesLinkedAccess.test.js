'use strict';
/**
 * CODE-REVIEW-2026-09-17 [BLOQUANT/security]: « "Désactiver" un collaborateur
 * (POST /employees/:id/deactivate) annonce "login disabled" mais laisse vivre
 * son compte administrateur lié et sa clé Power BI, sans événement de cycle
 * de vie. »
 *
 * Real, and the asymmetry was the giveaway: the route did
 * `update(id, { isActive: 0, isAccountActive: 0 })` and nothing else, while
 * the NEXT route in the same file — `reactivate` — already went through
 * `LifecycleService.reinstate` expressly "so linked admin accounts / API keys
 * come back too". The undo restored something the do had never done.
 *
 * An employee promoted to admin owns a SECOND account
 * (admins.linked_employee_id). `deserializeUser` gates on `admins.is_active`
 * and `ApiKeyService.validate` resolves through the OWNING ADMIN's is_active,
 * so both survived: a "deactivated" person kept a working admin login with
 * full HR reach and a working Power BI key, under an audit line that said
 * "login disabled".
 *
 * PROVEN BY EXECUTION on the dev database in a rolled-back transaction
 * (scratchpad/probe-deactivate.js), with the exact shape the finding
 * describes — employee + linked active admin + un-revoked API key:
 *
 *   before fix (mutation re-run): linked admin is_active stays TRUE,
 *                                 api_keys.revoked_at stays NULL
 *   after  fix: 14/14 — admin disabled, key revoked, lifecycle event written,
 *               and reinstate() brings back exactly those two and nothing else
 *
 * The fix reuses onLeaver's revocation rather than copying it, and passes
 * `departure: false` so an administrative switch-off does NOT acquire the
 * consequences of a real departure: no PII erasure clock, no handover plan,
 * no manager notification. That distinction is the point of this test — the
 * cheap fix (route the toggle through a full departure) would have started a
 * GDPR erasure countdown on a reversible action.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/SessionService', () => ({
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/ApiKeyService', () => ({
    revokeByOwner: jest.fn().mockResolvedValue(1),
}));
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));

const Lifecycle = require('../../src/services/LifecycleService');
const ApiKeyService = require('../../src/services/ApiKeyService');
const NotificationService = require('../../src/services/NotificationService');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const EMP = 84;
const LINKED_ADMIN = 7;
const OWNED_KEY = 21;

/** Route each query by its SQL so the order of calls is not pinned. */
function arrange() {
    mockDb.get.mockImplementation(async (sql) => {
        if (/FROM employees e/.test(sql)) return { id: EMP, countryCode: 'CI', dsrSlaDays: 30 };
        return null;
    });
    mockDb.all.mockImplementation(async (sql) => {
        // ReportingLineService.linesFor — the leaver's ACTIVE supervisor is 99.
        if (/LEFT JOIN employees sup/.test(sql)) {
            return [{ employeeId: EMP, employeeActive: false, supId: 99, supName: 'Sup Ervisor' }];
        }
        if (/FROM admins WHERE linked_employee_id/.test(sql)) return [{ id: LINKED_ADMIN }];
        if (/FROM api_keys WHERE owner_admin_id/.test(sql)) return [{ id: OWNED_KEY }];
        return [];
    });
    mockDb.run.mockResolvedValue({ changes: 1 });
}

const ranSql = () => mockDb.run.mock.calls.map((c) => String(c[0]));
const ranMatching = (re) => ranSql().filter((s) => re.test(s));

beforeEach(() => {
    jest.clearAllMocks();
    arrange();
});

describe('an administrative deactivation revokes every way back in', () => {
    test('the linked admin account is disabled and its API keys revoked', async () => {
        const out = await Lifecycle.onLeaver({ employeeId: EMP, departure: false });

        expect(ranMatching(/UPDATE admins SET is_active = false/)).toHaveLength(1);
        expect(ApiKeyService.revokeByOwner).toHaveBeenCalledWith(LINKED_ADMIN);
        expect(out.revoked.adminIds).toEqual([LINKED_ADMIN]);
        expect(out.revoked.apiKeyIds).toEqual([OWNED_KEY]);
    });

    test('the employee flags are cleared too', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP, departure: false });
        expect(
            ranMatching(/UPDATE employees SET is_active = false, is_account_active = false/)
        ).toHaveLength(1);
    });

    test('what was revoked is recorded on the event, so the undo can be exact', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP, departure: false });
        const stamp = mockDb.run.mock.calls.find((c) =>
            /UPDATE lifecycle_events/.test(String(c[0]))
        );
        expect(stamp).toBeDefined();
        // The ids travel as JSON in the payload — a blanket un-revoke on
        // reinstate would resurrect keys killed for unrelated reasons.
        expect(JSON.parse(stamp[1][0])).toEqual([LINKED_ADMIN]);
        expect(JSON.parse(stamp[1][1])).toEqual([OWNED_KEY]);
    });
});

describe('but it does NOT acquire the consequences of a real departure', () => {
    test('no PII erasure is scheduled', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP, departure: false });
        expect(ranMatching(/INSERT INTO pii_cleanup_jobs/)).toHaveLength(0);
    });

    test('no handover plan is opened and the manager is not summoned', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP, departure: false });
        expect(ranMatching(/handover_plans/)).toHaveLength(0);
        expect(NotificationService.notify).not.toHaveBeenCalled();
    });

    test('a REAL departure still does all three — the gate cuts one way only', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP, departure: true });
        expect(ranMatching(/INSERT INTO pii_cleanup_jobs/)).toHaveLength(1);
        // The LIVE line (3.23.18 R2) is told: the active supervisor 99.
        expect(NotificationService.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userType: 'employee', userId: 99, kind: 'lifecycle.leaver' })
        );
        // and the revocation is unchanged for a departure
        expect(ranMatching(/UPDATE admins SET is_active = false/)).toHaveLength(1);
    });

    test('departure defaults to true, so every existing caller is unaffected', async () => {
        await Lifecycle.onLeaver({ employeeId: EMP });
        expect(ranMatching(/INSERT INTO pii_cleanup_jobs/)).toHaveLength(1);
    });
});

describe('deprovision records the event and passes the flag through', () => {
    test('the event payload says whether this was a departure', async () => {
        await Lifecycle.deprovision(EMP, { source: 'admin_deactivate', departure: false });
        const ins = mockDb.run.mock.calls.find((c) =>
            /INSERT INTO lifecycle_events/.test(String(c[0]))
        );
        expect(ins).toBeDefined();
        const payload = JSON.parse(ins[1][1]);
        expect(payload.departure).toBe(false);
        expect(payload.source).toBe('admin_deactivate');
    });

    test('an ordinary deprovision is still a departure', async () => {
        await Lifecycle.deprovision(EMP, { source: 'scim' });
        const ins = mockDb.run.mock.calls.find((c) =>
            /INSERT INTO lifecycle_events/.test(String(c[0]))
        );
        expect(JSON.parse(ins[1][1]).departure).toBe(true);
    });
});

describe('the route no longer claims more than it does', () => {
    const src = read('src/routes/index.js');
    const at = (re) => {
        const m = re.exec(src);
        expect(m).not.toBeNull();
        return m.index;
    };
    const route = src.slice(
        at(/router\.post\(\s*'\/employees\/:id\/deactivate'/),
        at(/router\.post\(\s*'\/employees\/:id\/reactivate'/)
    );

    test('it goes through the lifecycle service, not a bare flag update', () => {
        // Scope to the CALL, not the route text: the comment above the call
        // quotes `departure: false` while explaining the fix, and an assertion
        // against the whole slice was satisfied by that prose — flipping the
        // real argument to `true` left the test green. Found by mutation.
        const callAt = route.indexOf('LifecycleService.deprovision(');
        expect(callAt).toBeGreaterThan(-1);
        const call = route.slice(callAt, route.indexOf(');', callAt));
        expect(call).toMatch(/departure:\s*false/);
        expect(call).not.toMatch(/departure:\s*true/);
        // The old two-flag shortcut must not come back.
        expect(route).not.toMatch(/EmployeeModel\.update\([^)]*isActive:\s*0/);
    });

    test('the audit line reports what was actually switched off', () => {
        // Scope to the `details:` VALUE. Matching the whole route text catches
        // the comment that explains the old bug, which quotes the very phrase
        // being banned — the assertion would then fail on the fix's own
        // documentation.
        const details = route.slice(route.indexOf('details:'), route.indexOf('ipAddress:'));
        expect(details.length).toBeGreaterThan(20);
        // It used to claim "login disabled" while an admin login stayed open.
        expect(details).not.toMatch(/login disabled/);
        expect(details).toMatch(/linked admin account\(s\) and \$\{nKeys\} API key\(s\) disabled/);
    });
});
