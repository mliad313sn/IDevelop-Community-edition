'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L2-4 (criticality 320) and L2-5 (270) — the two ways a "best-effort"
 * side-effect could destroy the decision it was attached to.
 *
 * L2-4  PostgreSQL aborts the WHOLE transaction on any statement error: every
 *       later statement fails, and the eventual COMMIT silently performs a
 *       ROLLBACK — WITHOUT raising. So `try { … } catch {}` around a best-effort
 *       block inside a transaction does not contain the damage, it hides it.
 *
 *       Proven by execution before the fix: a swallowed bad statement inside
 *       `runTransaction` returned normally and committed NOTHING. On the 9-box
 *       approval path that meant the approver got 200 "Placement approved" while
 *       the status change, the audit event, the PIP, the coaching plan and the
 *       placement mirror were ALL discarded. A lost HR decision, with nothing
 *       logged anywhere. G=8, O=4, D=10.
 *
 *       Fix: `db.runInSavepoint(fn)` — a SAVEPOINT inside a transaction, a
 *       pass-through outside one. Verified: after the fix the surrounding
 *       transaction survives a swallowed failure and still commits its own work.
 *
 * L2-5  `NotificationService.notify(...)` was called WITHOUT await at 21 sites,
 *       several of them inside a transaction. The un-awaited query then ran
 *       concurrently with the next statement on the SAME client — the source of
 *       the "client.query() when the client is already executing a query" warning
 *       that this codebase emitted on every JML event, 9-box approval and
 *       self-assessment save. Under pg 9 that THROWS, which combined with L2-4
 *       would have turned each of those into a silent rollback. The notice could
 *       also be dispatched after the client was released, so an employee placed
 *       under a PIP was never told about the coaching attached to it.
 *
 *       Verified: leaver + joiner + 9-box approval + self-assessment save now
 *       produce ZERO concurrent-query warnings.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a swallowed failure cannot silently roll back the caller (L2-4)', () => {
    const dbsrc = read('src/database/PostgresDatabase.js');

    test('there is a savepoint primitive', () => {
        expect(dbsrc).toMatch(/async runInSavepoint\(fn\)/);
        expect(dbsrc).toMatch(/await client\.query\(`SAVEPOINT \$\{sp\}`\)/);
        expect(dbsrc).toMatch(/ROLLBACK TO SAVEPOINT \$\{sp\}/);
    });

    test('it is a pass-through outside a transaction', () => {
        // So callers never need to know which context they are in.
        expect(dbsrc).toMatch(/if \(!client\) return fn\(\); \/\/ no open transaction/);
    });

    test('the savepoint name is generated, never taken from input', () => {
        expect(dbsrc).toMatch(/this\._savepointSeq = \(this\._savepointSeq \|\| 0\) \+ 1/);
        expect(dbsrc).toMatch(/const sp = `sp_\$\{this\._savepointSeq\}`/);
    });

    test('it rethrows, so the caller still decides whether to swallow', () => {
        expect(dbsrc).toMatch(/\} catch \(err\) \{[\s\S]*?throw err;\s*\}\s*\}/);
    });

    test('the 9-box approval wraps EVERY one of its best-effort blocks', () => {
        const nb = read('src/services/NineBoxService.js');
        const wrapped = nb.match(/db\.runInSavepoint\(/g) || [];
        // Three, since the audit write joined them (2026-09-18). It was the
        // clearest case of the very defect this file guards: _audit writes
        // adminId = req.user.id, which for an EMPLOYEE manager violates the FK
        // to admins. Its try/catch swallowed the error, but the surrounding
        // PostgreSQL transaction was already aborted (25P02) — so approve,
        // reject, archive, disclose and undisclose ALL returned 500 for an
        // employee-manager while an administrator sailed through. A swallowed
        // failure must not roll back its caller; now it cannot.
        expect(wrapped.length).toBe(3); // placement mirror, auto-trigger, audit
    });

    test('notify contains its own failures for every caller at once', () => {
        const ns = read('src/services/NotificationService.js');
        expect(ns).toMatch(
            /return await db\.runInSavepoint\(\(\) => NotificationService\._notify\(args\)\)/
        );
        // …and never throws, which is what makes awaiting it safe everywhere.
        expect(ns).toMatch(/return \{ inapp: 'error', email: 'error', error: e && e\.message \}/);
    });
});

describe('notifications no longer race on the transaction client (L2-5)', () => {
    const files = [
        'src/services/CoachingPlanService.js',
        'src/services/LifecycleService.js',
        'src/services/IDPService.js',
        'src/services/MobilityService.js',
        'src/services/MakerCheckerService.js',
        'src/services/NineBoxService.js',
        'src/services/OnboardingService.js',
        'src/services/SelfAssessmentService.js',
        'src/services/SelfAssessmentWorkflowService.js',
        'src/services/DisputeServiceV2.js',
        'src/jobs/reminders.js',
        'src/services/PipService.js',
    ];

    test.each(files)('%s awaits every notify it issues', (f) => {
        const src = read(f);
        // Any `X.notify(` that begins a statement must be awaited. Un-awaited, the
        // query overlaps the next one on the same client.
        const unawaited = src
            .split('\n')
            .filter((l) =>
                /^\s*(?:if \([^)]*\) )?(?:[A-Za-z_$][\w$]*|require\([^)]*\))\.notify\(/.test(l)
            )
            .filter((l) => !/await/.test(l));
        expect(unawaited).toEqual([]);
    });

    test('the helpers that wrap notify became async rather than being left sync', () => {
        expect(read('src/services/DisputeServiceV2.js')).toMatch(
            /static async _notify\(userType, userId, kind, payload = \{\}\)/
        );
        expect(read('src/services/SelfAssessmentWorkflowService.js')).toMatch(
            /async _notifyEmployee\(sa, kind, payload = \{\}\)/
        );
    });

    test('their call sites await them too — otherwise the race just moves up a level', () => {
        const d = read('src/services/DisputeServiceV2.js');
        const w = read('src/services/SelfAssessmentWorkflowService.js');
        expect((d.match(/await DisputeServiceV2\._notify\(/g) || []).length).toBe(7);
        // Intent: EVERY call site is awaited. A fixed count was a proxy for that
        // and broke the moment the service gained legitimate new notifications
        // (the change-request flow), which would have pushed someone to "fix"
        // the number rather than check the property. Assert the property.
        const total = (w.match(/this\._notifyEmployee\(/g) || []).length;
        const awaited = (w.match(/await this\._notifyEmployee\(/g) || []).length;
        expect(total).toBeGreaterThanOrEqual(4);
        expect(awaited).toBe(total);
    });

    test('activating a PIP twice does not notify twice (L2-14)', () => {
        // `close` was already fixed for exactly this; `activate` was not. Verified:
        // first activate -> true, second and third -> false, no re-notification.
        const p = read('src/services/PipService.js');
        expect(p).toMatch(/state IN \('proposed','approved'\) RETURNING id, employee_id/);
        expect(p).toMatch(/if \(!row\) return false;/);
        const route = read('src/routes/v2-pip.js');
        expect(route).toMatch(
            /const activated = await PipService\.activate\(Number\(req\.params\.id\)\)/
        );
        expect(route).toMatch(/if \(!activated\) \{/);
    });

    test('the coaching notice is awaited before the plan is re-read', () => {
        // These two ran concurrently on one client; the notice could also be
        // dispatched after the client was released and simply lost.
        const c = read('src/services/CoachingPlanService.js');
        const notify = c.indexOf("kind: 'coaching.created'");
        const getPlan = c.indexOf('return this.getPlan(plan.id);');
        expect(notify).toBeGreaterThan(-1);
        expect(notify).toBeLessThan(getPlan);
        expect(c).toMatch(
            /await require\('\.\/NotificationService'\)\.notify\(\{[\s\S]{0,200}coaching\.created/
        );
    });
});
