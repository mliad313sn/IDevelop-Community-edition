'use strict';

/**
 * THE ERASURE REGISTRY: every place in the schema that holds data about an
 * employee, and what erasure (and export) does with it. GDPR art. 15, 17, 20.
 *
 * Two lists, both pinned to the REAL schema by
 * tests/unit/erasureRegistry-db.test.js:
 *
 *   SUBJECT_DATA_REGISTRY   one entry per (table, column) that references an
 *                           employee (every foreign key to `employees` and every
 *                           employee-id-like column: …employee_id, subject_id,
 *                           user_id, actor/author/reviewer/coach/mentor/manager/
 *                           supervisor ids, actor_ref, requester_ref, …_by_ref),
 *                           plus `scope` entries for rows reached through
 *                           another table (the evidence of the person's own
 *                           assessment rounds, the items of their check-ins…).
 *   TABLES_WITHOUT_SUBJECT_COLUMN
 *                           every OTHER table of the schema, with the reason it
 *                           needs no per-subject treatment (configuration,
 *                           catalogue, aggregate, reached through a parent,
 *                           administrator accounts, short-lived telemetry…).
 *
 * A new table, or a new employee column, that is in neither list fails the
 * test: nothing can silently escape the erasure.
 *
 * Treatments of a SUBJECT_DATA_REGISTRY entry:
 *   - 'redacted'  : handled by the hand-written statements of DSRService.erase();
 *                   `key` names the REDACTED_ON_ERASURE category that pins the
 *                   columns (the export returns it under that key);
 *   - 'disclosed' : kept on erasure and exported (DISCLOSED_ABOUT_SUBJECT `key`);
 *   - 'erase'     : generic UPDATE run by erase(); `set` maps each column to
 *                   'null', 'marker' ('[erased]') or 'marker_if_set' (marker
 *                   only where a value exists: CHECK and NOT NULL constraints);
 *   - 'delete'    : generic DELETE of the rows, run by erase();
 *   - 'custom'    : a dedicated statement in erase() (named in `why`);
 *   - 'keep'      : left as is; `why` says why (the column holds the id of an
 *                   ACTOR on someone else's record, an append-only trail, a
 *                   legal ledger…). An id alone resolves to the pseudonymised row.
 * `where` narrows the rows (e.g. the employee side of a polymorphic table);
 * `scopeSql` replaces `<column> = ?` (every `?` is bound to the employee id).
 * `files` lists columns holding a path on disk: those files are deleted after
 * the erasure commits, only when the path resolves inside the uploads folder.
 * `export` is the key the export returns the rows under, or false with
 * `exportWhy`.
 */

const ERASED_MARKER = '[erased]';

const ACTOR =
    'actor on another person’s record: an opaque id that resolves to the pseudonymised row';
const IMMUTABLE =
    'append-only trail protected by a database trigger: rows are never rewritten; they carry ids that resolve to the pseudonymised row';
const EMP_TYPE = "user_type::text IN ('employee', 'manager')";
const SUBJ_EMP = "subject_type = 'employee'";
const OWN_ROUNDS =
    'self_assessment_id IN (SELECT id FROM self_assessment_rounds WHERE employee_id = ?)';

const keep = (table, column, why, extra = {}) => ({
    table,
    column,
    treatment: 'keep',
    why,
    export: false,
    exportWhy: why,
    ...extra,
});
const red = (table, column, key) => ({ table, column, treatment: 'redacted', key, export: key });
const dis = (table, column, key) => ({ table, column, treatment: 'disclosed', key, export: key });

const SUBJECT_DATA_REGISTRY = [
    // ---- the person's own record, accounts and identities -----------------------
    keep('employees', 'manager_id', 'org link on another person’s row: ' + ACTOR),
    keep('employees', 'supervisor_id', 'org link on another person’s row: ' + ACTOR),
    red('admins', 'linked_employee_id', 'linkedAdminAccounts'),
    red('user_identities', 'subject_id', 'userIdentities'),
    red('sso_pending_links', 'employee_id', 'ssoMappings'),
    red('sso_pending_links', 'match_employee_id', 'ssoMappings'),
    red('sso_remap_rows', 'employee_id', 'ssoMigrationRows'),
    {
        table: 'sso_migration_invites',
        column: 'subject_id',
        treatment: 'delete',
        where: SUBJ_EMP,
        export: false,
        exportWhy: 'delivery ledger of a sign-in invitation, no content about the person',
    },
    {
        table: 'sso_migration_announcements',
        column: 'subject_id',
        treatment: 'delete',
        where: SUBJ_EMP,
        export: false,
        exportWhy: 'delivery ledger of an announcement, no content about the person',
    },
    {
        table: 'password_reset_tokens',
        column: 'subject_id',
        treatment: 'delete',
        where: SUBJ_EMP,
        export: false,
        exportWhy: 'authentication secret (token hash)',
    },
    {
        table: 'mfa_secrets',
        column: 'user_id',
        treatment: 'delete',
        where: EMP_TYPE,
        export: false,
        exportWhy: 'authentication secret',
    },
    {
        table: 'mfa_backup_codes',
        column: 'user_id',
        treatment: 'delete',
        where: EMP_TYPE,
        export: false,
        exportWhy: 'authentication secret',
    },
    {
        table: 'mfa_used_codes',
        column: 'user_id',
        treatment: 'delete',
        where: EMP_TYPE,
        export: false,
        exportWhy: 'authentication secret',
    },
    {
        table: 'notification_preferences',
        column: 'user_id',
        treatment: 'delete',
        where: EMP_TYPE,
        export: false,
        exportWhy: 'channel settings, no content about the person',
    },
    // The person's OWN notifications go; those sent to OTHER people about them
    // are stripped of name, e-mail and free text by a custom statement.
    red('notifications', 'user_id', 'notifications'),
    {
        scope: 'notifications about the subject sent to others',
        table: 'notifications',
        treatment: 'custom',
        why: 'payload naming the subject (employeeId / e-mail) stripped of name, e-mail and free text; the recipient keeps the notice',
        export: false,
        exportWhy: 'addressed to other people',
    },
    {
        scope: 'sign-in history',
        table: 'login_attempts',
        treatment: 'custom',
        why: 'matched by the ORIGINAL login name / e-mail (no id column): the login typed is replaced by the pseudonym and the address dropped',
        export: false,
        exportWhy: 'security log',
    },
    {
        table: 'onboarding_requests',
        column: 'created_employee_id',
        treatment: 'custom',
        why: 'the sign-up application (by created account or original e-mail) is pseudonymised: name, e-mail, password hash, IdP subject and decision note',
        export: false,
        exportWhy: 'the application became the employee record, exported as the profile',
    },
    red('hris_links', 'employee_id', 'hrisLinks'),
    {
        scope: 'HRIS import lines naming the subject',
        table: 'hris_sync_runs',
        treatment: 'custom',
        why: 'the stored plan / records of an HRIS run whose text carries the subject’s e-mail, employee number or HRIS id are dropped; the run, its counts and errors stay',
        export: false,
        exportWhy: 'import log of the HR system',
    },
    keep('hris_sync_runs', 'actor_ref', ACTOR),
    {
        scope: 'movement labels naming the subject on other people’s history',
        table: 'employee_movements',
        treatment: 'custom',
        why: 'a manager / supervisor change on someone else names the subject in from_label / to_label: relabelled to the pseudonym',
        export: false,
        exportWhy: 'other people’s history',
    },
    {
        table: 'employee_movements',
        column: 'employee_id',
        treatment: 'erase',
        set: { note: 'null' },
        export: false,
        exportWhy: 'org moves are restated by the lifecycle events',
    },
    keep('employee_movements', 'actor_ref', ACTOR),
    {
        table: 'account_requests',
        column: 'employee_id',
        treatment: 'erase',
        set: { note: 'null' },
        export: false,
        exportWhy: 'administrative access-request ledger',
    },
    keep('account_requests', 'requested_by', ACTOR),

    // ---- assessment ----------------------------------------------------------------
    red('skill_assessments', 'employee_id', 'skillAssessments'),
    red('self_assessment_rounds', 'employee_id', 'selfAssessments'),
    keep('self_assessment_rounds', 'approved_by', ACTOR),
    keep('self_assessment_rounds', 'approved_by_ref', ACTOR),
    keep('self_assessment_rounds', 'cancelled_by_ref', ACTOR),
    keep('self_assessment_rounds', 'current_reviewer_id', ACTOR),
    keep('self_assessment_rounds', 'reviewed_by', ACTOR),
    keep('self_assessment_rounds', 'reviewed_by_ref', ACTOR),
    {
        scope: 'evidence of the subject’s own assessment rounds',
        table: 'assessment_evidence',
        treatment: 'erase',
        scopeSql: OWN_ROUNDS,
        set: { original_name: 'marker', file_uri: 'marker', quarantine_uri: 'null' },
        files: ['file_uri', 'quarantine_uri'],
        export: false,
        exportWhy:
            'evidence files are read in the application; their names are listed with the rounds',
    },
    keep('assessment_evidence', 'uploaded_by', ACTOR),
    {
        scope: 'comments on the subject’s own assessment rounds',
        table: 'self_assessment_comments',
        treatment: 'erase',
        scopeSql: OWN_ROUNDS,
        set: { body: 'marker' },
        export: false,
        exportWhy: 'review conversation, restated by the reviews and change requests',
    },
    {
        table: 'self_assessment_comments',
        column: 'author_id',
        treatment: 'erase',
        where: "author_type IN ('employee', 'manager')",
        set: { body: 'marker' },
        export: false,
        exportWhy: 'written on other people’s rounds',
    },
    keep('self_assessment_events', 'actor_id', IMMUTABLE),
    keep('assessment_history', 'employee_id', IMMUTABLE),
    keep('review_signatures', 'user_id', IMMUTABLE),
    red('supervisor_reviews', 'employee_id', 'supervisorReviews'),
    keep('supervisor_reviews', 'reviewed_by', ACTOR),
    red('assessment_disputes', 'employee_id', 'disputes'),
    keep('assessment_disputes', 'decided_by', ACTOR),
    red('assessment_change_requests', 'employee_id', 'changeRequests'),
    keep('assessment_change_requests', 'decided_by_ref', ACTOR),
    keep('assessment_change_requests', 'requester_ref', ACTOR),
    {
        table: 'post_approval_reviews',
        column: 'employee_id',
        treatment: 'erase',
        set: { reason: 'marker', decision_note: 'marker_if_set' },
        export: false,
        exportWhy: 'restated by the assessment rounds',
    },
    {
        table: 'cycle_participants',
        column: 'employee_id',
        treatment: 'erase',
        set: { exclusion_reason: 'marker_if_set', last_exclusion_reason: 'marker_if_set' },
        export: false,
        exportWhy: 'campaign enrolment, restated by the assessment rounds',
    },
    keep('cycle_participants', 'supervisor_id', ACTOR),
    keep('cycle_participants', 'reviewer_assigned_by_ref', ACTOR),
    {
        table: 'skill_suggestions',
        column: 'employee_id',
        treatment: 'erase',
        set: { evidence: 'null' },
        export: false,
        exportWhy: 'machine suggestions, not a record about the person',
    },
    keep(
        'readiness_snapshots',
        'employee_id',
        'computed figures (percentages, counts), no free text: the readiness history of a role'
    ),

    // ---- certifications, learning, safety ---------------------------------------
    {
        table: 'employee_certifications',
        column: 'employee_id',
        treatment: 'redacted',
        key: 'certifications',
        export: 'certifications',
        files: ['file_uri', 'quarantine_uri'],
    },
    dis('lms_enrollments', 'employee_id', 'lmsEnrollments'),
    dis('lms_completions', 'employee_id', 'lmsCompletions'),
    {
        scope: 'raw LMS payload of the subject’s completions',
        table: 'lms_completions',
        treatment: 'erase',
        scopeSql: 'employee_id = ?',
        set: { raw: 'null', review_reason: 'null' },
        export: false,
        exportWhy: 'raw provider payload; the completion itself is exported',
    },
    {
        table: 'safety_gate_status',
        column: 'employee_id',
        treatment: 'delete',
        export: false,
        exportWhy: 'computed state, recomputed from certifications',
    },
    keep(
        'safety_gate_status_history',
        'employee_id',
        'clearance history (status and skill codes, no free text): a safety record'
    ),
    {
        table: 'safety_gate_webhook_deliveries',
        column: 'employee_id',
        treatment: 'erase',
        set: { payload: 'marker', last_error: 'null' },
        export: false,
        exportWhy: 'outbound delivery log',
    },

    // ---- talent -----------------------------------------------------------------------
    red('nine_box_evaluations', 'employee_id', 'nineBox'),
    {
        table: 'nine_box_events',
        column: 'employee_id',
        treatment: 'erase',
        set: { detail: 'null' },
        export: false,
        exportWhy: 'workflow journal of the 9-box decision (confidential)',
    },
    keep('nine_box_events', 'actor_id', ACTOR),
    red('calibration_adjustments', 'employee_id', 'calibrationAdjustments'),
    keep('calibration_adjustments', 'actor_employee_id', ACTOR),
    keep('calibration_sessions', 'actor_employee_id', ACTOR),
    {
        table: 'talent_placements',
        column: 'employee_id',
        treatment: 'erase',
        set: { override_reason: 'marker_if_set' },
        export: false,
        exportWhy: 'confidential talent decision, restated by the 9-box category',
    },
    keep(
        'talent_ratings',
        'employee_id',
        'decision structure (performance and potential bands), no free text'
    ),
    keep('talent_ratings', 'reviewer_id', ACTOR),
    {
        table: 'talent_manager_tasks',
        column: 'employee_id',
        treatment: 'erase',
        set: { resolution_reason: 'marker_if_set' },
        export: false,
        exportWhy: 'manager follow-up task (confidential)',
    },
    keep('talent_manager_tasks', 'assignee_employee_id', ACTOR),
    keep('talent_manager_tasks', 'resolved_by_employee_id', ACTOR),
    red('retention_risk', 'employee_id', 'retentionRisk'),
    keep(
        'succession_plans',
        'incumbent_employee_id',
        'a plan for the POSITION; the incumbent id resolves to the pseudonymised row'
    ),
    {
        table: 'successors',
        column: 'candidate_employee_id',
        treatment: 'delete',
        export: false,
        exportWhy: 'confidential bench position',
    },
    {
        table: 'merit_recommendations',
        column: 'employee_id',
        treatment: 'erase',
        set: { rationale: 'null' },
        export: false,
        exportWhy: 'compensation proposal (confidential)',
    },
    {
        table: 'review_summaries',
        column: 'employee_id',
        treatment: 'erase',
        set: { narrative: 'null' },
        export: false,
        exportWhy: 'annual summary, restated by the reviews',
    },
    keep(
        'handover_plans',
        'outgoing_employee_id',
        'a handover of the WORK of a role; items describe tasks, not the person'
    ),
    keep('handover_plans', 'incoming_employee_id', ACTOR),
    {
        table: 'emergency_cover',
        column: 'cover_employee_id',
        treatment: 'erase',
        set: { note: 'null' },
        export: false,
        exportWhy: 'cover arrangement of a role',
    },
    {
        table: 'lc_nationalisation_plans',
        column: 'incumbent_employee_id',
        treatment: 'erase',
        set: { notes: 'null', state_reason: 'marker_if_set' },
        export: false,
        exportWhy: 'workforce plan of a role',
    },
    keep('lc_nationalisation_plans', 'created_by_ref', ACTOR),
    keep('lc_nationalisation_plans', 'state_changed_by_ref', ACTOR),
    {
        table: 'lc_nationalisation_successors',
        column: 'employee_id',
        treatment: 'erase',
        set: { state_reason: 'marker_if_set' },
        export: false,
        exportWhy: 'workforce plan of a role',
    },
    keep('lc_nationalisation_successors', 'added_by_ref', ACTOR),
    keep('lc_nationalisation_successors', 'state_changed_by_ref', ACTOR),
    keep('lc_nationalisation_events', 'actor_ref', IMMUTABLE),
    keep('lc_regulatory_packs', 'generated_by_ref', IMMUTABLE),
    keep('lc_regulatory_packs', 'published_by_ref', IMMUTABLE),
    keep('lc_regulatory_packs', 'state_changed_by_ref', IMMUTABLE),
    {
        table: 'employee_aspirations',
        column: 'employee_id',
        treatment: 'redacted',
        key: 'aspirations',
        export: 'aspirations',
    },
    red('opportunity_applications', 'employee_id', 'opportunityApplications'),
    keep('opportunity_applications', 'actor_employee_id', ACTOR),
    keep('opportunities', 'actor_employee_id', ACTOR),
    keep('opportunities', 'state_changed_by_employee_id', ACTOR),
    {
        table: 'cancellation_requests',
        column: 'employee_id',
        treatment: 'erase',
        set: { reason: 'marker', decision_note: 'marker_if_set' },
        export: false,
        exportWhy: 'restated by the plans they concern',
    },
    keep('cancellation_requests', 'requested_by_employee_id', ACTOR),

    // ---- development -------------------------------------------------------------------
    red('coaching_sessions', 'employee_id', 'coachingSessions'),
    keep('coaching_sessions', 'coach_id', ACTOR),
    keep('coaching_signoffs', 'user_id', 'signature of a session (who and when, no text)'),
    {
        scope: 'objectives of the subject’s coaching sessions',
        table: 'coaching_objectives',
        treatment: 'erase',
        scopeSql: 'session_id IN (SELECT id FROM coaching_sessions WHERE employee_id = ?)',
        set: { smart_text: 'marker' },
        export: false,
        exportWhy: 'restated by the coaching sessions',
    },
    red('coaching_plans', 'employee_id', 'coachingPlans'),
    keep('coaching_plans', 'mentor_id', ACTOR),
    {
        scope: 'actions of the subject’s coaching plans',
        table: 'coaching_plan_actions',
        treatment: 'erase',
        scopeSql: 'plan_id IN (SELECT id FROM coaching_plans WHERE employee_id = ?)',
        set: { description: 'marker', progress_note: 'null' },
        export: false,
        exportWhy: 'restated by the coaching plans',
    },
    red('goals', 'employee_id', 'goals'),
    red('check_ins', 'employee_id', 'checkins'),
    keep('check_ins', 'manager_id', ACTOR),
    {
        scope: 'items of the subject’s check-ins',
        table: 'check_in_items',
        treatment: 'erase',
        scopeSql: 'check_in_id IN (SELECT id FROM check_ins WHERE employee_id = ?)',
        set: { body: 'marker' },
        export: false,
        exportWhy: 'restated by the check-ins',
    },
    {
        table: 'check_in_items',
        column: 'author_employee_id',
        treatment: 'erase',
        set: { body: 'marker' },
        export: false,
        exportWhy: 'written in other people’s check-ins',
    },
    keep('check_in_items', 'owner_employee_id', ACTOR),
    red('one_on_one_agenda_items', 'author_employee_id', 'oneOnOneAgenda'),
    red('one_on_one_notes', 'author_employee_id', 'oneOnOneNotes'),
    dis('feedback360_subjects', 'employee_id', 'feedback360'),
    keep('feedback360_subjects', 'manager_employee_id', ACTOR),
    {
        table: 'feedback360_responses',
        column: 'subject_id',
        treatment: 'custom',
        why: 'the free-text comments of the anonymous answers about the subject are deleted; the anonymous ratings, which name nobody, stay',
        export: false,
        exportWhy: 'anonymous answers: the person reads their released report',
    },
    keep(
        'feedback360_nominations',
        'subject_id',
        'who was asked to rate the subject: the structure of the round, ids only'
    ),
    keep(
        'feedback360_nominations',
        'rater_employee_id',
        'the subject as an anonymous rater of someone else: ' + ACTOR
    ),
    {
        table: 'feedback_notes',
        column: 'about_employee_id',
        treatment: 'erase',
        set: { body: 'marker' },
        export: false,
        exportWhy: 'private notes of the line',
    },
    keep('feedback_notes', 'author_employee_id', 'notes about another person: ' + ACTOR),
    dis('idp_plans', 'employee_id', 'idp'),
    {
        scope: 'actions of the subject’s development plans',
        table: 'idp_actions',
        treatment: 'erase',
        scopeSql: 'idp_id IN (SELECT id FROM idp_plans WHERE employee_id = ?)',
        set: { title: 'marker', description: 'null', completion_notes: 'null' },
        export: false,
        exportWhy: 'restated by the development objectives',
    },
    {
        scope: 'evidence of the subject’s development actions',
        table: 'action_evidence',
        treatment: 'erase',
        scopeSql:
            'action_id IN (SELECT a.id FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id WHERE p.employee_id = ?)',
        set: { original_name: 'marker', file_uri: 'marker', quarantine_uri: 'null' },
        files: ['file_uri', 'quarantine_uri'],
        export: false,
        exportWhy: 'evidence files are read in the application',
    },
    keep('action_evidence', 'uploaded_by', ACTOR),
    {
        scope: 'journal of the subject’s development plans',
        table: 'idp_plan_events',
        treatment: 'erase',
        scopeSql: 'idp_id IN (SELECT id FROM idp_plans WHERE employee_id = ?)',
        set: { reason: 'marker_if_set', detail: 'null' },
        export: false,
        exportWhy: 'workflow journal, restated by the plan state',
    },
    keep('idp_plan_events', 'actor_id', ACTOR),
    keep('idp_signoffs', 'user_id', 'signature of a plan (who and when, no text)'),
    red('pips', 'employee_id', 'pips'),
    keep('pips', 'closed_by_ref', ACTOR),
    {
        scope: 'milestones of the subject’s performance plans',
        table: 'pip_milestones',
        treatment: 'erase',
        scopeSql: 'pip_id IN (SELECT id FROM pips WHERE employee_id = ?)',
        set: { description: 'marker', notes: 'null' },
        export: false,
        exportWhy: 'restated by the performance plans',
    },
    {
        table: 'training_plans',
        column: 'employee_id',
        treatment: 'erase',
        set: { description: 'null' },
        export: false,
        exportWhy: 'training catalogue of a plan; the skills are exported with the assessments',
    },
    keep('training_plans', 'created_by', ACTOR),
    keep('training_plans', 'approved_by', ACTOR),
    {
        scope: 'items of the subject’s training plans',
        table: 'training_plan_items',
        treatment: 'erase',
        scopeSql: 'training_plan_id IN (SELECT id FROM training_plans WHERE employee_id = ?)',
        set: { completion_notes: 'null' },
        export: false,
        exportWhy: 'restated by the training plans',
    },
    red('planned_absences', 'employee_id', 'plannedAbsences'),

    // ---- engagement --------------------------------------------------------------------
    red('survey_responses', 'employee_id', 'surveyResponses'),
    {
        table: 'survey_audience',
        column: 'employee_id',
        treatment: 'delete',
        export: false,
        exportWhy: 'invitation ledger, no content',
    },
    keep('surveys', 'actor_employee_id', ACTOR),
    keep('org_objectives', 'actor_employee_id', ACTOR),
    red('recognitions', 'to_employee_id', 'recognitions'),
    red('recognitions', 'from_employee_id', 'recognitions'),
    red('employee_demographics', 'employee_id', 'demographics'),
    keep('review_delegations', 'grantor_id', ACTOR),
    keep('review_delegations', 'grantee_id', ACTOR),

    // ---- employment, privacy and legal registers --------------------------------------
    dis('lifecycle_events', 'employee_id', 'lifecycleEvents'),
    {
        table: 'pii_cleanup_jobs',
        column: 'employee_id',
        treatment: 'custom',
        why: 'the retention job is marked completed by the erasure',
        export: false,
        exportWhy: 'retention schedule',
    },
    red('profiling_objections', 'employee_id', 'profilingObjections'),
    {
        table: 'privacy_paused_triggers',
        column: 'employee_id',
        treatment: 'custom',
        why: 'held development triggers are deleted with the objections',
        export: false,
        exportWhy: 'restated by the objections',
    },
    dis('privacy_notice_acks', 'subject_id', 'privacyNoticeAcks'),
    keep(
        'privacy_self_exports',
        'subject_id',
        'ledger of the person’s own downloads (format and date, no content): accountability'
    ),
    keep(
        'dsr_requests',
        'employee_id',
        'register of the rights the person exercised: accountability'
    ),
    keep(
        'erasure_override_requests',
        'employee_id',
        'register of the legal-hold override that allowed this erasure (ids only)'
    ),
    keep(
        'erasure_tombstones',
        'subject_id',
        'the erasure’s own receipt, re-applied after any restore'
    ),
    keep('retention_ledger', 'subject_id', 'record of what the retention purge did (ids only)'),
    keep('system_logs', 'actor_ref', IMMUTABLE),
    keep('job_runs', 'actor_ref', ACTOR),
];

/**
 * Every table with no employee column, and why it needs no per-subject
 * treatment. Classes:
 *   config      configuration or catalogue (org units, skills, settings, keys)
 *   aggregate   computed figures over many people, no per-person row
 *   via         rows reached through a parent the registry already covers
 *   admin       administrator accounts and their own security data
 *   telemetry   short-lived operational data, pruned on a schedule
 *   ledger      operational or legal ledger with ids only
 */
const TABLES_WITHOUT_SUBJECT_COLUMN = {
    action_effectiveness: ['aggregate', 'pre/post ratings of an action, numbers only'],
    action_skill_links: ['config', 'links actions to skills'],
    admin_access_events: ['admin', 'access changes of administrator accounts'],
    admin_mfa_enrol_codes: ['admin', 'administrator MFA enrolment codes'],
    admin_permissions: ['admin', 'administrator grants'],
    admin_scopes: ['admin', 'administrator scopes'],
    api_keys: ['admin', 'API keys of administrator profiles'],
    app_settings: ['config', 'application settings'],
    assessment_cycles: ['config', 'campaign definitions'],
    benchmark_fit_history: ['aggregate', 'role fit per day, no person'],
    bias_alerts: ['aggregate', 'group statistics of a campaign'],
    coaching_grow: ['via', 'GROW notes of the subject’s sessions: redacted with coachingGrow'],
    coaching_objectives: ['via', 'objectives of the subject’s sessions: registry scope entry'],
    coaching_plan_actions: ['via', 'actions of the subject’s plans: registry scope entry'],
    countries: ['config', 'countries and their retention periods'],
    country_aliases: ['config', 'country name aliases'],
    course_skill_map: ['config', 'course to skill mapping'],
    coverage_rules: ['config', 'coverage rules of skills per unit'],
    cycle_closure_proposals: ['aggregate', 'campaign closure snapshot (counts)'],
    departments: ['config', 'org units'],
    dept_brief_prefs: ['config', 'recipients’ brief preferences'],
    dept_briefs: ['aggregate', 'department brief: counts only, never a name'],
    digest_subscriptions: ['config', 'digest settings of recipients'],
    domains: ['config', 'skills framework'],
    feedback360_answers: ['via', 'anonymous answers: comments about the subject deleted (custom)'],
    feedback360_rounds: ['config', '360° round definitions'],
    goal_alignment: ['via', 'goal to objective links, no text'],
    handover_items: ['via', 'tasks of a role handover, not about the person'],
    hris_connectors: ['config', 'HRIS connector settings (encrypted credentials)'],
    hris_value_mappings: ['config', 'HRIS value to org-unit mappings'],
    idp_actions: ['via', 'actions of the subject’s plans: registry scope entry'],
    idp_objectives: ['via', 'objectives of the subject’s plans: redacted with idpObjectives'],
    kpi_snapshots: ['aggregate', 'KPI figures per scope and day'],
    lms_courses: ['config', 'course catalogue'],
    lms_integrations: ['config', 'LMS connector settings'],
    login_attempts: ['ledger', 'sign-in log matched by login name: custom statement'],
    maker_checker_requests: [
        'ledger',
        'administrator change requests; the payload of a decided request is the change record',
    ],
    nudge_log: ['telemetry', 'campaign nudge ledger (target ids), pruned with the reminders'],
    password_history: ['admin', 'administrator password history'],
    perf_events: ['telemetry', 'performance telemetry, pruned on a schedule'],
    pip_milestones: ['via', 'milestones of the subject’s plans: registry scope entry'],
    privacy_notice_versions: ['config', 'privacy notice texts'],
    proficiency_descriptors: ['config', 'skill level descriptors'],
    regions: ['config', 'org units'],
    reminder_log: ['telemetry', 'reminder ledger (target ids), pruned on a schedule'],
    report_schedules: ['config', 'report schedules'],
    report_templates: ['config', 'report templates'],
    role_criticality: ['config', 'role criticality'],
    role_families: ['config', 'role families'],
    role_skill_requirements: ['config', 'role requirements'],
    roles: ['config', 'roles'],
    safety_gate_rules: ['config', 'safety-gate rules'],
    safety_gate_settings: ['config', 'safety-gate settings'],
    saml_assertion_seen: ['telemetry', 'SAML replay protection, short-lived'],
    saml_request_cache: ['telemetry', 'SAML request cache, short-lived'],
    schema_meta: ['config', 'migration ledger'],
    services: ['config', 'org units'],
    session: ['telemetry', 'session store: the subject’s sessions are revoked by the erasure'],
    sites: ['config', 'org units'],
    skill_certification_policies: ['config', 'certification policies'],
    skill_description_proposals: ['config', 'skills library proposals'],
    skill_relationships: ['config', 'skills framework'],
    skill_role_families: ['config', 'skills framework'],
    skills: ['config', 'skills framework'],
    snapshots: [
        'ledger',
        'administrator data snapshots: the erasure tombstones are re-applied after any restore',
    ],
    sso_remap_batches: ['ledger', 'SSO migration batch headers; their rows are redacted'],
    sub_domains: ['config', 'skills framework'],
    survey_questions: ['config', 'survey questions'],
    training_plan_items: ['via', 'items of the subject’s training plans: registry scope entry'],
    webhook_deliveries: ['telemetry', 'outbound webhook log'],
    webhook_subscriptions: ['config', 'webhook settings'],
};

/** WHERE clause and params for a registry entry, for one subject. */
function registryWhere(entry, employeeId) {
    let sql;
    let params;
    if (entry.scopeSql) {
        sql = entry.scopeSql;
        params = (entry.scopeSql.match(/\?/g) || []).map(() => employeeId);
    } else {
        sql = `${entry.column} = ?`;
        params = [employeeId];
    }
    if (entry.where) sql = `(${sql}) AND (${entry.where})`;
    return { sql, params };
}

/** SET list of a generic 'erase' entry. */
function registrySet(entry) {
    return Object.entries(entry.set)
        .map(([col, how]) => {
            if (how === 'null') return `${col} = NULL`;
            if (how === 'marker') return `${col} = '${ERASED_MARKER}'`;
            if (how === 'marker_if_set')
                return `${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE '${ERASED_MARKER}' END`;
            throw new Error(`registry: unknown set rule ${how} for ${entry.table}.${col}`);
        })
        .join(', ');
}

module.exports = {
    SUBJECT_DATA_REGISTRY,
    TABLES_WITHOUT_SUBJECT_COLUMN,
    ERASED_MARKER,
    registryWhere,
    registrySet,
};
