'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L2-8 (224), L4-11 (162), L2-15 (120) and L5-13 (112).
 *
 * L2-8  `COALESCE(sa.current_level, 0)` turned "never assessed" into "level 0",
 *       and that 0 was written into the IDP objective the employee SIGNS:
 *       "Développer X du niveau 0 au niveau 3" asserts a measured incompetence on
 *       a competency nobody has ever evaluated. This is the same class the product
 *       has already corrected elsewhere (suggestPosition, readiness, the report
 *       builder), reappearing in its most contractual form.
 *       The unmeasured requirement is still SELECTED as a development need — it is
 *       one — so nothing is dropped from the department-designed requirement set.
 *       Only the claim about the starting point changes. G=4, O=7, D=8.
 *
 * L4-11 `exportLocalAdmins` serialised only site/department/service, so every
 *       REGION- and COUNTRY-scoped grant was silently lost. Re-imported elsewhere,
 *       that admin has no scope at all — and the downstream behaviour fails closed
 *       (the `-1` sentinel), so they see nothing, with no message. G=6, O=3, D=9.
 *
 * L2-15 `POST /handover/:id/status` accepted 'completed' with no check, and
 *       `listDue` filters `status IN ('open','in_progress')` — so a handover marked
 *       complete with open knowledge items left the queue and the weekly tick never
 *       chased it again. The knowledge left with the person. Verified: refused with
 *       5 open items, accepted once they were settled. G=5, O=3, D=8.
 *
 * L5-13 The onboarding merge guard read `reqEmail && tgtEmail && reqEmail !==
 *       tgtEmail`, so it evaporated when the TARGET had no e-mail — and 7 of the
 *       77 people here have none. An admin with manage_onboarding could graft a
 *       pending SSO identity onto such an account, and that person could then sign
 *       in as them. G=7, O=2, D=8.
 */

const fs = require('fs');
const path = require('path');
const { flat } = require('../helpers/flatSource');
// Layout-proof: prettier reflows the sources these assertions read.
const read = (p) => flat(fs.readFileSync(path.join(__dirname, '../..', p), 'utf8'));

describe('an unmeasured competency is not reported as level 0 (L2-8)', () => {
    const trig = read('src/services/DevelopmentTriggerService.js');
    const idp = read('src/services/IDPService.js');

    test('the trigger reads the true level, not a coalesced zero', () => {
        // Re-audit T4 moved this from raw skill_assessments to the resolved view
        // (+ the cert-lapse degrade) so the objectives agree with the profile the
        // employee sees. `current` is still the TRUE level — ra.level is NULL when
        // unmeasured, degraded to 0 only on a lapse — and is never coalesced to 0
        // in the SELECT, so the objective text can still say "non évalué".
        expect(trig).toMatch(
            /CASE WHEN cl\.employee_id IS NOT NULL THEN 0 ELSE ra\.level END AS current/
        );
        expect(trig).toMatch(/LEFT JOIN v_resolved_assessments ra/);
        expect(trig).not.toMatch(/COALESCE\([^)]*\) AS current\b/);
    });

    test('the objective text states an unmeasured start as unmeasured', () => {
        expect(trig).toMatch(/g\.current == null/);
        expect(trig).toMatch(/niveau actuel non évalué/);
    });

    test('the IDP SMART templates handle it in both languages', () => {
        expect(idp).toMatch(/current == null/);
        expect(idp).toMatch(/niveau actuel non évalué/);
        expect(idp).toMatch(/current level not assessed/);
    });

    test('the IDP query no longer coalesces the level to zero', () => {
        expect(idp).toMatch(/sa\.current_level AS current_level/);
        expect(idp).not.toMatch(/COALESCE\(sa\.current_level, 0\) AS current_level/);
    });

    test('the templates produce the right sentence for each case', () => {
        // Evaluates the literal, so it needs the RAW source (line breaks intact).
        const rawIdp = fs.readFileSync(
            path.join(__dirname, '../../src/services/IDPService.js'),
            'utf8'
        );
        const body = rawIdp.match(/const SMART_TEMPLATES = (\{[\s\S]*?\n\});/)[1];
        // eslint-disable-next-line no-eval
        const T = eval(`(${body})`);
        expect(T.fr('Soudage', 1, 3, '31/12/2026')).toMatch(/du niveau 1 au niveau 3/);
        expect(T.fr('Soudage', null, 3, '31/12/2026')).toMatch(
            /atteindre le niveau 3 .*non évalué/
        );
        expect(T.en('Welding', null, 3, '2026-12-31')).toMatch(/reach level 3 .*not assessed/);
        // The old wording must not survive for the unmeasured case.
        expect(T.fr('Soudage', null, 3, '31/12/2026')).not.toMatch(/du niveau 0/);
    });

    test('an unmeasured requirement is still treated as a development need', () => {
        // Selecting only measured gaps would quietly shrink the requirement set,
        // which is department-designed and must never be reduced. The effective
        // level (lapse degraded to 0) is coalesced to 0 in the WHERE, so an
        // unmeasured requirement (effective NULL) still passes required > 0.
        expect(trig).toMatch(
            /rsr\.required_level > COALESCE\(CASE WHEN cl\.employee_id IS NOT NULL THEN 0 ELSE ra\.level END, 0\)/
        );
    });
});

describe('an admin export carries every scope type (L4-11)', () => {
    test('region and country are serialised', () => {
        const svc = read('src/services/ImportExportService.js');
        expect(svc).toMatch(/regionId: s\.regionId,/);
        expect(svc).toMatch(/countryId: s\.countryId,/);
    });
});

describe('a handover cannot be completed with knowledge still open (L2-15)', () => {
    const svc = read('src/services/HandoverService.js');

    test('completion checks the items', () => {
        expect(svc).toMatch(/if \(status === 'completed'\)/);
        expect(svc).toMatch(/NOT IN \('completed', 'cancelled'\)/);
    });

    test('it reports why rather than failing silently', () => {
        expect(svc).toMatch(/return \{ ok: false, reason: 'open_items', openItems: open \}/);
        const route = read('src/routes/v2-continuity.js');
        expect(route).toMatch(/knowledge item\(s\) are still open/);
        expect(route).toMatch(/res\.status\(409\)/);
    });

    test('other statuses are unaffected', () => {
        // Re-opening or cancelling must stay possible whatever the items say.
        expect(svc).toMatch(
            /await db\.run\('UPDATE handover_plans SET status = \?, updated_at = now\(\) WHERE id = \?', \[status, handoverId\]\)/
        );
    });
});

describe('the onboarding merge guard cannot be sidestepped (L5-13)', () => {
    test('a target with no e-mail is refused, not waved through', () => {
        const svc = read('src/services/AccountLinkService.js');
        expect(svc).toMatch(/if \(reqEmail && !tgtEmail\) \{/);
        expect(svc).toMatch(/has no email address to verify against/);
    });

    test('the mismatch check still applies when both are present', () => {
        const svc = read('src/services/AccountLinkService.js');
        expect(svc).toMatch(/if \(reqEmail && tgtEmail && reqEmail !== tgtEmail\)/);
    });
});
