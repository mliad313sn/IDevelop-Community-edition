'use strict';
/**
 * Guard — locale coverage of every database state value, and of every static key.
 *
 * Why: a badge built as `__('idp:st_' + p.status)` prints the raw value (or the
 * key itself) for every database value that has no label. That is how an
 * « cancelled » development plan, the four reserved administrator roles and the
 * antivirus verdicts reached the screen unlabelled, and how
 * `t('flash:emp_place_incomplete')` flashed its own key.
 *
 * What: (1) MACHINES maps a constrained column to every label prefix the views
 * and services build a key from; for each value of the column's enum type or
 * CHECK IN-list, FR and EN both need `prefix + value` (plural-aware). (2) Every
 * static `__('ns:key')` / `t('ns:key')` / `req.t(…)` in views, src and public
 * (and 'ns:key' literals passed as data) exists in FR and EN. (3) FR and EN have
 * the same key set and no empty value.
 *
 * Extend: when a state column gets a label prefix, add it to MACHINES.
 * Exceptions: allowlist.json → localeStates (table, col, prefix, value) and
 * staticLocaleKeys (key), each with a reason.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.setTimeout(120000);

const { loadSchema, hasTestDb } = require('../helpers/guards/schema');
const S = require('../helpers/guards/scans');
const A = require('../helpers/guards/allowlist');
const R = require('../helpers/guards/repo');

const db = hasTestDb() ? require('../../src/config/database') : null;
const FR = R.locales('fr');
const EN = R.locales('en');
let schema;

/** table.column → every prefix a view or a service builds a label key from */
const MACHINES = {
    'self_assessment_rounds.status': ['employee:state_', 'talentx:sar_st_'],
    'self_assessment_rounds.workflow_state': ['employee:state_', 'talentx:sar_st_'],
    'assessment_cycles.status': ['admin:cyc_status_', 'admin:enum_cycle_status_'],
    'nine_box_evaluations.movement_direction': ['talentx:nb_mv_'],
    'pips.state': ['pip:st_'],
    'idp_plans.status': ['idp:st_'],
    'idp_actions.type': ['idp:act_'],
    'coaching_plans.state': ['employee:mc_st_'],
    'coaching_plans.kind': ['employee:mc_kind_', 'admin:cx_type_'],
    'training_plans.status': ['employee:mc_st_'],
    'notifications.state': ['admin:notif_state_'],
    'notifications.channel': ['admin:notif_channel_'],
    'notifications.user_type': ['admin:notif_type_'],
    'notifications.email_status': ['admin:notif_es_'],
    'maker_checker_requests.state': ['admin:mcq_state_'],
    'post_approval_reviews.state': ['admin:par_state_', 'admin:cx_state_'],
    'cancellation_requests.state': ['admin:cx_state_'],
    'cancellation_requests.entity_type': ['admin:cx_type_'],
    'assessment_change_requests.status': ['assess:acr_status_'],
    'cycle_closure_proposals.state': ['admin:cyc_proposal_state_'],
    'cycle_participants.exclusion_category': ['admin:cyc_cat_'],
    'safety_gate_status.status': ['safety:status_'],
    'safety_gate_status.enforced_status': ['safety:status_'],
    'safety_gate_contests.state': ['safety:contest_state_'],
    'safety_gate_contests.contested_as': ['safety:contested_as_'],
    'safety_gate_webhook_deliveries.state': ['safety:delivery_'],
    'safety_gate_rules.mode': ['safety:mode_'],
    'safety_gate_waivers.granted_via': ['safety:via_'],
    'surveys.kind': ['talentx:cap_svy_kind_'],
    'planned_absences.kind': ['compliance:kind_'],
    'employee_movements.kind': ['admin:mv_kind_'],
    'lc_regulatory_packs.state': ['localcontent:pack_state_'],
    'persona_digest_prefs.cadence': ['chrome:notif_prefs_digest_', 'dash:dg_cadence_'],
    'notification_user_settings.digest_cadence': ['chrome:notif_prefs_digest_'],
    'dept_brief_prefs.cadence': ['reports:db_cadence_'],
    'skill_description_proposals.status': ['framework:sq_status_'],
    'skill_description_proposals.source': ['framework:sq_source_'],
    'sso_migration_invites.status': ['admin:acc_sso_status_'],
    'sso_migration_announcements.status': ['admin:acc_sso_status_'],
    'account_requests.kind': ['admin:acc_request_'],
    'admins.role': ['admin:enum_admin_role_'],
    'report_schedules.frequency': ['admin:enum_schedule_frequency_'],
    'employee_certifications.av_status': ['common:av_status_'],
    'opportunity_applications.status': ['growth:app_st_'],
    // IDevelop's own modules: 360° feedback and HRIS synchronisation
    'feedback360_subjects.status': ['talentx:f360_st_'],
    'feedback360_nominations.rater_group': ['talentx:f360_group_'],
    'feedback360_nominations.status': ['talentx:f360_nom_'],
    'feedback360_rounds.status': ['talentx:f360_round_'],
    'feedback360_rounds.kind': ['talentx:f360_kind_'],
    'hris_sync_runs.status': ['admin:hris_st_'],
    'hris_sync_runs.mode': ['admin:hris_mode_'],
    'hris_connectors.provider': ['admin:hris_provider_'],
};

let gaps; // [{table,col,prefix,value,fr,en}] after allow-list
let staticGaps; // [{key, where}] after allow-list

// The state values are read from the test database (see helpers/guards/schema.js);
// the static keys and the FR / EN parity need none.
const suite = db ? describe : describe.skip;

beforeAll(() => {
    staticGaps = [];
    for (const [key, where] of S.staticLocaleKeys(FR)) {
        if (R.hasKey(FR, key) && R.hasKey(EN, key)) continue;
        if (A.allowed('staticLocaleKeys', { key })) continue;
        staticGaps.push({ key, where: where[0] });
    }
});

beforeAll(async () => {
    if (!db) return;
    await db.connect();
    schema = await loadSchema(db);
    const sets = schema.valueSets();
    gaps = [];
    for (const [tc, prefixes] of Object.entries(MACHINES)) {
        const [table, col] = tc.split('.');
        const set = sets[table] && sets[table][col];
        if (!set) {
            gaps.push({
                table,
                col,
                prefix: '(no CHECK/enum on this column: fix MACHINES)',
                value: '',
                fr: false,
                en: false,
            });
            continue;
        }
        for (const prefix of prefixes)
            for (const value of set) {
                const fr = R.hasKey(FR, prefix + value),
                    en = R.hasKey(EN, prefix + value);
                if (fr && en) continue;
                if (A.allowed('localeStates', { table, col, prefix, value })) continue;
                gaps.push({ table, col, prefix, value, fr, en });
            }
    }
});
afterAll(async () => {
    if (db) await db.close();
});

const fmt = (g) =>
    `${g.table}.${g.col} '${g.value}' → ${g.prefix}${g.value} (fr ${g.fr ? 'ok' : 'MISSING'}, en ${g.en ? 'ok' : 'MISSING'})`;

describe('FR / EN parity', () => {
    test('same key set, no empty value, allow-list reasoned', () => {
        expect([...FR.keys()].filter((k) => !EN.has(k))).toEqual([]);
        expect([...EN.keys()].filter((k) => !FR.has(k))).toEqual([]);
        expect([...FR].filter(([, v]) => v === '').map(([k]) => k)).toEqual([]);
        expect([...EN].filter(([, v]) => v === '').map(([k]) => k)).toEqual([]);
        expect(A.unreasoned('localeStates')).toEqual([]);
        expect(A.unreasoned('staticLocaleKeys')).toEqual([]);
    });
});

suite('every database state value has a FR and an EN label under each prefix', () => {
    test('MACHINES names only constrained columns', () => {
        expect(gaps.filter((g) => !g.value).map(fmt)).toEqual([]);
    });
    test('no unlabelled state value', () => {
        expect(gaps.filter((g) => g.value).map(fmt)).toEqual([]);
    });
    test('regression: IDP « cancelled », the seven administrator roles, every antivirus verdict', () => {
        const sets = schema.valueSets();
        expect(sets.idp_plans.status.has('cancelled')).toBe(true);
        expect(sets.admins.role.size).toBe(7);
        expect(sets.employee_certifications.av_status.has('quarantined')).toBe(true);
        for (const [k, set, prefix] of [
            ['idp', sets.idp_plans.status, 'idp:st_'],
            ['admins', sets.admins.role, 'admin:enum_admin_role_'],
            ['av', sets.employee_certifications.av_status, 'common:av_status_'],
        ])
            for (const v of set)
                expect(`${k}:${R.hasKey(FR, prefix + v) && R.hasKey(EN, prefix + v)}`).toBe(
                    `${k}:true`
                );
    });
});

describe('every static locale key used by the code exists in FR and EN (plural-aware)', () => {
    test('no missing key', () => {
        expect(staticGaps.map((g) => `${g.key} ← ${g.where}`)).toEqual([]);
    });
    test('regression: the placement, IDP signature and re-authentication flashes exist', () => {
        for (const key of [
            'flash:emp_place_incomplete',
            'flash:emp_place_inconsistent',
            'flash:idp_activated',
            'flash:idp_signed_waiting',
            'flash:account_reauth_rate_limited',
        ]) {
            expect(`${key}:${R.hasKey(FR, key)}`).toBe(`${key}:true`);
            expect(`${key}:${R.hasKey(EN, key)}`).toBe(`${key}:true`);
        }
    });
    test('mutation self-check: a key present only as a plural form is accepted, a missing one is not', () => {
        const m = new Map([
            ['x:a_one', '1'],
            ['x:a_other', 'n'],
        ]);
        expect(R.hasKey(m, 'x:a')).toBe(true);
        expect(R.hasKey(m, 'x:b')).toBe(false);
    });
});
