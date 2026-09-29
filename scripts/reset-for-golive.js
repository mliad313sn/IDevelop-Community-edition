'use strict';
/**
 * Production GO-LIVE reset.
 *
 * Wipes ALL assessment / talent / performance / workflow data so a production
 * instance starts from a clean slate, while PRESERVING exactly:
 *   • the organization         (countries + aliases, regions, sites, departments, services)
 *   • the skill framework       (domains, sub-domains, skills, roles, role families,
 *                                role skill requirements, proficiency descriptors,
 *                                certification policies, coverage rules, …)
 *   • the list of employees     (employees + employee_demographics)
 *   • admin accounts + auth      (admins, scopes, permissions, MFA, SSO identities, API keys,
 *                                review delegations, the admin access register)
 *   • system configuration       (app_settings, report templates/schedules, LMS config,
 *                                digest subscriptions, department-brief preferences,
 *                                organisation objectives, survey definitions, …)
 *   • migration bookkeeping       (schema_meta), the admin audit trail (system_logs)
 *                                and the GDPR request register (dsr_requests)
 *
 * It NEVER touches the .env file (this is a database-only operation) and never
 * touches DB configuration rows in app_settings.
 *
 * THE CONTRACT IS TWO EXPLICIT LISTS, NOT ONE. Until 2026-09-17 the wipe set was
 * "every table not in KEEP", so every configuration table a migration added
 * after the list was written (country_aliases, coverage_rules,
 * skill_certification_policies, digest_subscriptions, review_delegations,
 * admin_access_events, dsr_requests, mfa_used_codes) was silently truncated -
 * while Setup.bat promised "KEEPS org, skill framework, employees and admins".
 * country_aliases is the seed of migration 85 and is never re-seeded, because
 * schema_meta says 85 was applied. Now a table in NEITHER list aborts the run:
 * a new table must be classified here, out loud, before a go-live reset can run.
 *
 * SAFETY
 *   • Dry-run by DEFAULT: prints the full keep/wipe plan with row counts and changes
 *     nothing. You must pass --confirm to execute.
 *   • Before wiping (unless --skip-backup) it takes a pg_dump backup to backups/.
 *   • Refuses to run if any critical table landed in the wipe set, if any table is
 *     unclassified, or if any PRESERVED table has a foreign key pointing INTO the
 *     wipe set (which a TRUNCATE ... CASCADE would drag in).
 *   • Append-only (BEFORE TRUNCATE trigger) tables: the trigger is lifted ONLY for
 *     the three assessment tables named in APPEND_ONLY_WIPE - a go-live decision
 *     the owner takes knowingly. Any OTHER table with such a trigger in the wipe
 *     set aborts the run instead of being quietly disarmed.
 *
 * Usage:
 *   node scripts/reset-for-golive.js                 # dry-run: print the plan only
 *   node scripts/reset-for-golive.js --confirm       # execute (pg_dump backup first)
 *   node scripts/reset-for-golive.js --confirm --skip-backup   # execute without backup (NOT advised)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Tables to PRESERVE.
const KEEP = new Set([
    // migration bookkeeping — must never be touched
    'schema_meta',
    // organization
    'countries',
    'country_aliases',
    'regions',
    'sites',
    'departments',
    'services',
    // skill framework / catalogue
    'domains',
    'sub_domains',
    'skills',
    'roles',
    'role_families',
    'role_skill_requirements',
    'skill_relationships',
    'skill_role_families',
    'proficiency_descriptors',
    'skill_description_proposals', // 3.23.21: framework texts awaiting HR approval
    'role_criticality',
    'skill_certification_policies',
    'coverage_rules',
    // employees (identity + core profile)
    'employees',
    'employee_demographics',
    // admin accounts + authentication + identity + delegation of authority
    'admins',
    'admin_scopes',
    'admin_permissions',
    'password_history',
    'mfa_secrets',
    'mfa_backup_codes',
    'mfa_used_codes',
    // one-time MFA enrolment codes for admin SSO (migration 152): an account
    // preparation artefact, kept with the accounts (they expire after 24 h).
    'admin_mfa_enrol_codes',
    'user_identities',
    // SSO-migration mappings prepared before go-live + their batch history
    // (migration 144): identity preparation, kept like user_identities.
    'sso_pending_links',
    'sso_remap_batches',
    'sso_remap_rows',
    // SSO migration invitation outbox + ledger (migration 153): kept with the
    // identities it describes, so a go-live reset never re-sends an invitation.
    'sso_migration_invites',
    // 3.23.21: SSO announcement ledger (once per account) — kept like the invites.
    'sso_migration_announcements',
    'api_keys',
    'admin_access_events',
    'review_delegations',
    // sessions + security
    'session',
    'login_attempts',
    // system configuration
    'app_settings',
    'report_templates',
    'report_schedules',
    'notification_preferences',
    'webhook_subscriptions',
    'lms_integrations',
    'lms_courses',
    'course_skill_map',
    'digest_subscriptions',
    'dept_brief_prefs',
    'org_objectives',
    'surveys',
    'survey_questions',
    // 3.23.18: safety-gate configuration (rules per role/site, thresholds, webhook)
    'safety_gate_rules',
    'safety_gate_settings',
    // registers kept as history (hash-chained audit trail, GDPR requests)
    'system_logs',
    'dsr_requests',
    // 3.23.18: an erasure must never be forgotten (re-applied after any restore),
    // and the retention ledger is the record of what the purge did.
    'erasure_tombstones',
    'retention_ledger',
]);

// Tables to WIPE: assessment, talent, performance, workflow and operational data.
const WIPE = new Set([
    'account_requests',
    'action_effectiveness',
    'action_evidence',
    'action_skill_links',
    'assessment_change_requests',
    'assessment_cycles',
    'assessment_disputes',
    'assessment_evidence',
    'assessment_history',
    'benchmark_fit_history',
    'bias_alerts',
    'calibration_adjustments',
    'calibration_sessions',
    'cancellation_requests',
    'check_in_items',
    'check_ins',
    'coaching_grow',
    'coaching_objectives',
    'coaching_plan_actions',
    'coaching_plans',
    'coaching_sessions',
    'coaching_signoffs',
    'cycle_closure_proposals',
    'cycle_participants',
    'dept_briefs',
    'emergency_cover',
    'employee_aspirations',
    'employee_certifications',
    'employee_movements',
    'feedback_notes',
    'goal_alignment',
    'goals',
    'handover_items',
    'handover_plans',
    'idp_actions',
    'idp_objectives',
    'idp_plans',
    // IDP lifecycle journal (migration 146): follows its plans.
    'idp_plan_events',
    'idp_signoffs',
    'job_runs',
    'kpi_snapshots',
    // SAML replay protection (migration 145): short-lived operational state.
    'saml_request_cache',
    'saml_assertion_seen',
    'lifecycle_events',
    'lms_completions',
    'lms_enrollments',
    'maker_checker_requests',
    'merit_recommendations',
    'nine_box_evaluations',
    'nine_box_events',
    'notifications',
    'nudge_log',
    'onboarding_requests',
    'opportunities',
    'opportunity_applications',
    'password_reset_tokens',
    'perf_events',
    'pii_cleanup_jobs',
    'pip_milestones',
    'pips',
    'planned_absences',
    'post_approval_reviews',
    'readiness_snapshots',
    'recognitions',
    'reminder_log',
    'retention_risk',
    'review_signatures',
    'review_summaries',
    'self_assessment_comments',
    'self_assessment_events',
    'self_assessment_rounds',
    'skill_assessments',
    'skill_suggestions',
    'snapshots',
    'succession_plans',
    // 3.23.18: nationalisation plans + regulator packs built on pre-go-live data
    'lc_nationalisation_plans',
    'lc_nationalisation_successors',
    'lc_nationalisation_events',
    'lc_regulatory_packs',
    // 3.23.18: safety-gate computed state (recomputed from assessments/certs)
    'safety_gate_status',
    'safety_gate_status_history',
    'safety_gate_webhook_deliveries',
    'successors',
    'supervisor_reviews',
    // Who a survey was sent to (migration 147): follows its responses.
    'survey_audience',
    'survey_responses',
    'talent_manager_tasks',
    'talent_placements',
    'talent_ratings',
    'training_plan_items',
    'training_plans',
    'webhook_deliveries',
]);

// Append-only assessment tables whose BEFORE TRUNCATE guard may be lifted for
// the go-live wipe - and ONLY these. system_logs is append-only too and is in KEEP.
const APPEND_ONLY_WIPE = ['assessment_history', 'review_signatures', 'self_assessment_events'];

// Belt-and-braces: these can never be in the wipe set, whatever the lists say.
const CRITICAL = [
    'schema_meta',
    'admins',
    'employees',
    'skills',
    'roles',
    'sites',
    'departments',
    'services',
    'domains',
    'sub_domains',
    'role_families',
    'role_skill_requirements',
    'app_settings',
    'countries',
    'country_aliases',
    'regions',
    'system_logs',
];

/**
 * Classify the live table list against the two explicit lists.
 * @param {string[]} tables public schema table names
 * @returns {{keep:string[], wipe:string[], unknown:string[], overlap:string[]}}
 */
function classify(tables) {
    const keep = [],
        wipe = [],
        unknown = [];
    for (const t of tables) {
        if (KEEP.has(t) && WIPE.has(t)) {
            unknown.push(t);
            continue;
        }
        if (KEEP.has(t)) keep.push(t);
        else if (WIPE.has(t)) wipe.push(t);
        else unknown.push(t);
    }
    const overlap = [...KEEP].filter((t) => WIPE.has(t));
    return { keep, wipe, unknown, overlap };
}

/**
 * Which TRUNCATE-guard triggers may be disabled: only those on APPEND_ONLY_WIPE
 * tables. Any other guarded table in the wipe set is returned as `refused`.
 * @param {{tbl:string,tgname:string}[]} triggers
 */
function triggerPlan(triggers) {
    const disable = [],
        refused = [];
    for (const t of triggers) {
        if (APPEND_ONLY_WIPE.includes(t.tbl)) disable.push(t);
        else refused.push(t);
    }
    return { disable, refused };
}

module.exports = { KEEP, WIPE, APPEND_ONLY_WIPE, CRITICAL, classify, triggerPlan };

function mask(url) {
    return String(url || '').replace(/:[^:@/]+@/, ':****@');
}

async function count(client, t) {
    try {
        const r = await client.query(`SELECT count(*)::int AS c FROM "${t}"`);
        return r.rows[0].c;
    } catch (_) {
        return '?';
    }
}

function backup() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set — cannot back up.');
    let pgDump = 'pg_dump';
    try {
        const base = 'C:\\Program Files\\PostgreSQL';
        for (const d of fs.readdirSync(base).sort().reverse()) {
            const p = path.join(base, d, 'bin', 'pg_dump.exe');
            if (fs.existsSync(p)) {
                pgDump = p;
                break;
            }
        }
    } catch (_) {
        /* fall back to PATH */
    }
    const outDir = path.resolve(__dirname, '..', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(outDir, `pre-golive-reset-${stamp}.sql`);
    console.log(`\nBacking up (pg_dump) -> ${out}`);
    execFileSync(pgDump, ['--no-owner', '--no-privileges', '-f', out, url], { stdio: 'inherit' });
    const mb = (fs.statSync(out).size / 1048576).toFixed(2);
    console.log(`Backup complete (${mb} MB). Keep this until the go-live is confirmed good.`);
    return out;
}

async function main() {
    require('dotenv').config();
    const db = require('../src/config/database');
    const args = process.argv.slice(2);
    const CONFIRM = args.includes('--confirm');
    const SKIP_BACKUP = args.includes('--skip-backup');

    await db.connect();
    const client = db._client();

    const { rows: tblRows } = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    const tables = tblRows.map((r) => r.tablename);
    const { keep, wipe, unknown, overlap } = classify(tables);

    // Guard 0: every table is classified, and no table is in both lists.
    if (overlap.length) throw new Error(`ABORT: table(s) in BOTH lists: ${overlap.join(', ')}`);
    if (unknown.length) {
        throw new Error(
            'ABORT: ' +
                unknown.length +
                ' table(s) are in neither KEEP nor WIPE: ' +
                unknown.join(', ') +
                '. Classify each one in scripts/reset-for-golive.js ' +
                '(configuration/identity/framework -> KEEP; assessment/talent/operational data -> WIPE) and retry.'
        );
    }

    // Guard 1: no critical table in the wipe set.
    const critIn = wipe.filter((t) => CRITICAL.includes(t));
    if (critIn.length)
        throw new Error(`ABORT: critical tables would be wiped: ${critIn.join(', ')}`);

    // Guard 2: no PRESERVED table may FK into the wipe set (TRUNCATE CASCADE would
    // otherwise drag preserved rows out).
    const { rows: badFk } = await client.query(
        `
        SELECT ch.relname AS child, par.relname AS parent
        FROM pg_constraint con
        JOIN pg_class ch  ON ch.oid = con.conrelid
        JOIN pg_class par ON par.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE con.contype='f' AND n.nspname='public'
          AND ch.relname  = ANY($1::text[])
          AND par.relname = ANY($2::text[])
          AND ch.relname <> par.relname`,
        [keep, wipe]
    );
    if (badFk.length) {
        throw new Error(
            'ABORT: preserved tables reference wiped tables (TRUNCATE CASCADE would ' +
                'delete preserved data): ' +
                badFk.map((r) => `${r.child} -> ${r.parent}`).join(', ') +
                '. Move those parents into KEEP or the children into WIPE, then retry.'
        );
    }

    // Guard 3: append-only guards may be lifted on the named assessment tables only.
    const { rows: trg } = await client.query(
        `
        SELECT c.relname AS tbl, t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal
          AND (t.tgtype & 32) > 0           -- fires on TRUNCATE (bit 32; bit 8 is DELETE)
          AND c.relname = ANY($1::text[])`,
        [wipe]
    );
    const tp = triggerPlan(trg);
    if (tp.refused.length) {
        throw new Error(
            'ABORT: append-only table(s) in the wipe set whose guard this script may NOT lift: ' +
                tp.refused.map((t) => `${t.tbl} (${t.tgname})`).join(', ') +
                '. Either move them to KEEP or add them to APPEND_ONLY_WIPE deliberately.'
        );
    }

    // Plan
    console.log('\n=== IDevelop — GO-LIVE RESET plan ===');
    console.log('Database :', mask(process.env.DATABASE_URL));
    console.log('Wipes assessment/talent/performance/workflow data; PRESERVES organization,');
    console.log(
        'skill framework, employees, admins and configuration. The .env file is NOT touched.\n'
    );

    console.log(`PRESERVED (${keep.length} tables):`);
    for (const t of keep) console.log(`  keep  ${t.padEnd(30)} ${await count(client, t)} rows`);

    console.log(`\nWIPED (${wipe.length} tables):`);
    let total = 0;
    for (const t of wipe) {
        const c = await count(client, t);
        if (typeof c === 'number') total += c;
        const tag = APPEND_ONLY_WIPE.includes(t) ? '  (append-only guard lifted for the wipe)' : '';
        console.log(`  WIPE  ${t.padEnd(30)} ${c} rows${tag}`);
    }
    console.log(`\n≈ ${total} rows will be deleted across ${wipe.length} tables.`);

    if (!CONFIRM) {
        console.log(
            '\nDRY RUN — nothing was changed. Re-run with --confirm to execute' +
                (SKIP_BACKUP ? '' : ' (a pg_dump backup is taken first)') +
                '.'
        );
        await db.close();
        return;
    }

    // Execute
    if (!SKIP_BACKUP) backup();
    else console.log('\n[!] --skip-backup: NO backup will be taken.');

    console.log('\nExecuting reset...');
    for (const { tbl, tgname } of tp.disable) {
        await client.query(`ALTER TABLE public."${tbl}" DISABLE TRIGGER "${tgname}"`);
    }
    try {
        const list = wipe.map((t) => `public."${t}"`).join(', ');
        await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    } finally {
        for (const { tbl, tgname } of tp.disable) {
            await client.query(`ALTER TABLE public."${tbl}" ENABLE TRIGGER "${tgname}"`);
        }
    }

    const emp = await count(client, 'employees');
    const sk = await count(client, 'skills');
    const rl = await count(client, 'roles');
    const ad = await count(client, 'admins');
    const st = await count(client, 'sites');
    const ca = await count(client, 'country_aliases');
    console.log('\n✓ Reset complete.');
    console.log(
        `  Preserved: employees=${emp}, skills=${sk}, roles=${rl}, admins=${ad}, sites=${st}, country_aliases=${ca}.`
    );
    console.log(`  Wiped ${wipe.length} assessment/talent tables. schema_meta + .env untouched.`);
    await db.close();
}

if (require.main === module) {
    main().catch(async (e) => {
        console.error('\nRESET FAILED:', e.message);
        try {
            await require('../src/config/database').close();
        } catch (_) {
            /* ignore */
        }
        process.exit(1);
    });
}
