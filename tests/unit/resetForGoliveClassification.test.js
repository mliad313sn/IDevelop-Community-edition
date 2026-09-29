'use strict';
/**
 * Z-INST-2 — the go-live reset (Setup.bat option R) computed its wipe set as
 * "every table not in KEEP", so every configuration table added after the list
 * was written went with the assessment data: dry run on 2026-09-17 WIPED
 * country_aliases (25 rows, the seed of migration 85 - never re-seeded because
 * schema_meta says 85 is applied), coverage_rules, skill_certification_policies,
 * digest_subscriptions, review_delegations, admin_access_events, dsr_requests,
 * mfa_used_codes - while promising "KEEPS org, skill framework, employees and
 * admins". It also lifted EVERY BEFORE TRUNCATE immutability trigger it met.
 *
 * The contract is now two explicit lists and a refusal for anything in
 * neither; the append-only guard may be lifted for three named assessment
 * tables only. This file pins the lists against the schema the migrations
 * create, so a new CREATE TABLE fails here until it is classified.
 */
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const reset = require('../../scripts/reset-for-golive');
const { KEEP, WIPE, APPEND_ONLY_WIPE, CRITICAL, classify, triggerPlan } = reset;

const MIG_DIR = path.join(__dirname, '..', '..', 'db', 'postgres');

/** Every table the migrations leave in place: created, minus dropped / renamed away. */
function tablesFromMigrations() {
    const created = new Set();
    const removed = new Set();
    for (const f of fs
        .readdirSync(MIG_DIR)
        .filter((n) => /\.sql$/i.test(n) && !/_down\.sql$/i.test(n))) {
        const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
        // Only the public schema: the reset lists public tables (audit_guard.* is
        // the migration-124 guard registry, outside its reach).
        for (const m of sql.matchAll(
            /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:([a-z_]+)\.)?"?([a-z_][a-z0-9_]*)"?/gi
        )) {
            if (m[1] && m[1].toLowerCase() !== 'public') continue;
            created.add(m[2].toLowerCase());
        }
        for (const m of sql.matchAll(
            /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
        ))
            removed.add(m[1].toLowerCase());
        for (const m of sql.matchAll(
            /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+RENAME\s+TO\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
        )) {
            removed.add(m[1].toLowerCase());
            created.add(m[2].toLowerCase());
        }
    }
    return [...created].filter((t) => !removed.has(t) || KEEP.has(t) || WIPE.has(t)).sort();
}

describe('every table the migrations create is classified KEEP or WIPE', () => {
    const tables = tablesFromMigrations();

    test('the migrations create a real schema', () => {
        expect(tables.length).toBeGreaterThan(100);
    });

    test('no table is unclassified', () => {
        const { unknown } = classify(tables);
        expect(unknown).toEqual([]);
    });

    test('no table is in both lists', () => {
        expect([...KEEP].filter((t) => WIPE.has(t))).toEqual([]);
    });
});

describe('the configuration and register tables the old reset wiped are now kept', () => {
    test.each([
        'country_aliases',
        'coverage_rules',
        'skill_certification_policies',
        'digest_subscriptions',
        'review_delegations',
        'admin_access_events',
        'dsr_requests',
        'mfa_used_codes',
        'dept_brief_prefs',
        'org_objectives',
        'surveys',
        'survey_questions',
    ])('%s is KEEP', (t) => {
        expect(KEEP.has(t)).toBe(true);
        expect(WIPE.has(t)).toBe(false);
    });

    test('the assessment tables are still wiped (that is the point of the reset)', () => {
        for (const t of [
            'skill_assessments',
            'supervisor_reviews',
            'self_assessment_rounds',
            'nine_box_evaluations',
            'pips',
            'idp_plans',
        ])
            expect(WIPE.has(t)).toBe(true);
    });

    test('country_aliases and system_logs are critical - they can never enter the wipe set', () => {
        expect(CRITICAL).toEqual(
            expect.arrayContaining(['country_aliases', 'system_logs', 'schema_meta'])
        );
    });
});

describe('classify refuses the unknown instead of wiping it', () => {
    test('an unlisted table is reported, not silently wiped', () => {
        const r = classify(['employees', 'skill_assessments', 'brand_new_config_table']);
        expect(r.keep).toEqual(['employees']);
        expect(r.wipe).toEqual(['skill_assessments']);
        expect(r.unknown).toEqual(['brand_new_config_table']);
    });

    test('the script aborts on an unknown table before printing a plan', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'scripts', 'reset-for-golive.js'),
            'utf8'
        );
        const abort = src.indexOf('neither KEEP nor WIPE');
        const plan = src.indexOf('GO-LIVE RESET plan');
        expect(abort).toBeGreaterThan(-1);
        expect(abort).toBeLessThan(plan);
    });
});

describe('append-only guards are lifted for the three named assessment tables only', () => {
    test('the allow-list is exactly the three assessment ledgers, all in WIPE', () => {
        expect([...APPEND_ONLY_WIPE].sort()).toEqual([
            'assessment_history',
            'review_signatures',
            'self_assessment_events',
        ]);
        for (const t of APPEND_ONLY_WIPE) expect(WIPE.has(t)).toBe(true);
        expect(APPEND_ONLY_WIPE).not.toContain('system_logs');
    });

    test('a truncate guard on any other table is refused, not disabled', () => {
        const plan = triggerPlan([
            { tbl: 'assessment_history', tgname: 'trg_assessment_history_immutable' },
            { tbl: 'some_new_ledger', tgname: 'trg_some_new_ledger_immutable' },
        ]);
        expect(plan.disable.map((t) => t.tbl)).toEqual(['assessment_history']);
        expect(plan.refused.map((t) => t.tbl)).toEqual(['some_new_ledger']);
    });
});
