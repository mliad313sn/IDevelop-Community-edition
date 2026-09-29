'use strict';

/**
 * Granular admin permission catalog — the single source of truth for what a
 * LOCAL ADMIN can be delegated. A SuperAdmin implicitly holds every permission;
 * a Viewer can only hold read-type permissions (write grants are ignored for
 * viewers). Local admins hold exactly the permissions an administrator grants
 * them, and every action remains constrained to their assigned scope
 * (site / department / service) by the existing RBAC scope mechanism.
 *
 * The goal is to minimise the need for SuperAdmin accounts: routine governance
 * (configuration, provisioning, audit) can be delegated to scoped local admins.
 *
 * `write: true`  → mutating capability; never effective for the read-only Viewer role.
 * `group`        → a stable GROUP KEY (never display text) used purely to group
 *                  the checkboxes in the admin UI.
 *
 * This file is STRUCTURE-ONLY and deliberately English: the French-first UI never
 * prints `label` / `description` directly. They are the last-resort fallback and
 * the canonical statement of what each slug means; the displayed strings live in
 * locales/{fr,en}/admin.json under `perm.<slug>.label` / `perm.<slug>.desc` and
 * `permgroup.<groupKey>`, resolved in the controller (never in SQL, never in a view).
 * Adding a slug therefore means adding its two keys to BOTH locale files.
 */

const PERMISSIONS = [
    // People & assessments — day-to-day operational delegation within scope.
    // Employee administration is split into three tiers — READ (view_employees),
    // EDIT (edit_employees) and CREDENTIALS (reset_employee_password) — so a
    // delegate can read staff without editing them, or edit them WITHOUT the
    // sensitive power to reset passwords. The coarse `manage_employees` grant
    // remains and IMPLIES the finer ones, so existing delegations are unchanged:
    // every admin already holding edit_/manage_employees is backfilled with
    // view_employees by expandSlugs (auth.js deserializeUser), with no data
    // migration and nothing to re-grant by hand.
    {
        slug: 'view_employees',
        label: 'View employees',
        group: 'people_assessments',
        write: false,
        description:
            'Browse the employee directory and open an employee record (identity, org placement, role) — within the assigned scope. Read-only, and withholdable: an admin delegated only configuration or reporting work never needs to read staff PII.',
    },
    {
        slug: 'edit_employees',
        label: 'Edit employees',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'Create and edit employees and activate accounts — within the assigned scope. Does NOT include resetting passwords.',
    },
    // every WRITE that acts on an employee record IMPLIES the
    // scoped read. A delegate holding only reset_employee_password had the power
    // to reset 42 passwords and could not open /employees to do it (403) — a
    // "capability without reach". `actsOn: 'employees'` marks these slugs so
    // assertCatalogConsistent refuses a future one that forgets the read.
    {
        slug: 'reset_employee_password',
        label: 'Reset employee passwords / set credentials',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        // the invitations console was gated on THIS slug, so
        // "can send an invitation" and "can reset a password" were the same
        // delegation. `manage_invitations` splits them WITHOUT changing any
        // existing perimeter: a password-resetter still reaches the console
        // through this implication, and an admin can now delegate invitations
        // alone (account provisioning) without handing out password resets.
        implies: ['view_employees', 'manage_invitations'],
        description:
            'Reset an employee’s password or set their login credentials — a sensitive action, delegated separately from general editing.',
    },
    {
        slug: 'manage_invitations',
        label: 'Send account invitations',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'Open the account/invitations console and send or re-send sign-in invitations — within the assigned scope. Does NOT include resetting an existing password.',
    },
    {
        slug: 'manage_employees',
        label: 'Manage employees (full)',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees', 'edit_employees', 'reset_employee_password'],
        description:
            'Full employee administration: read, create/edit, activate accounts and reset passwords — within the assigned scope.',
    },
    {
        slug: 'manage_assessments',
        label: 'Manage skill assessments',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'Record and adjust employee skill assessments in the matrix — within the assigned scope.',
    },
    {
        slug: 'manage_cycles',
        label: 'Manage assessment cycles',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'View and manage assessment cycles (create, open, lock, close the campaign windows). Admins only.',
    },
    {
        slug: 'manage_onboarding',
        label: 'Manage onboarding',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'Review self-onboarded users (open signup / SSO) and place them into a site, department, service and role with a supervisor or manager — which creates their account.',
    },

    // Configuration — the organisational framework. The catalogue areas whose
    // read pages are permission-gated now have a read-only `view_*` variant so
    // config can be exposed without edit rights; the `manage_*` grant implies it.
    {
        slug: 'manage_organization',
        label: 'Manage organization',
        group: 'configuration',
        write: true,
        description: 'Create and edit sites, departments and services.',
    },
    {
        slug: 'view_domains_skills',
        label: 'View domains & skills',
        group: 'configuration',
        write: false,
        description: 'Browse the competency catalogue (domains and skills). Read-only.',
    },
    {
        slug: 'manage_domains_skills',
        label: 'Manage domains & skills',
        group: 'configuration',
        write: true,
        implies: ['view_domains_skills'],
        description: 'Maintain the competency catalogue (domains and skills).',
    },
    {
        slug: 'view_roles',
        label: 'View roles & requirements',
        group: 'configuration',
        write: false,
        description: 'View job roles and their required skills/levels. Read-only.',
    },
    {
        slug: 'manage_roles',
        label: 'Manage roles & requirements',
        group: 'configuration',
        write: true,
        implies: ['view_roles'],
        description: 'Define job roles and the skills/levels each role requires.',
    },
    {
        slug: 'view_app_settings',
        label: 'View settings',
        group: 'configuration',
        write: false,
        description: 'View global application settings. Read-only.',
    },
    {
        slug: 'manage_app_settings',
        label: 'Manage settings',
        group: 'configuration',
        write: true,
        implies: ['view_app_settings'],
        description: 'Change global application settings (e.g. the readiness threshold).',
    },

    // Data — provisioning and reporting exports.
    {
        slug: 'export_data',
        label: 'Export data',
        group: 'data',
        write: false,
        description:
            'Download exports and report packs (employees, assessments, organization, templates).',
    },
    {
        slug: 'import_data',
        label: 'Import / provision data',
        group: 'data',
        write: true,
        description:
            'Bulk-import and provision data from workbooks. Does NOT include the destructive factory reset.',
    },

    // Governance — oversight and delegated administration.
    {
        slug: 'view_system_logs',
        label: 'View system logs',
        group: 'governance',
        write: false,
        description:
            "Read the audit trail and security analytics. Data is scoped to the holder's clearance: SuperAdmins see all logs; a scope-restricted admin sees only their governed employees' activity (global infra signals stay SuperAdmin-only).",
    },
    {
        slug: 'manage_admins',
        label: 'Manage local admins',
        group: 'governance',
        write: true,
        description:
            'Create and manage local admins and viewers. Cannot create or edit SuperAdmins, and cannot grant a permission the granter does not hold.',
    },
    {
        slug: 'arbitrate_disputes',
        label: 'Arbitrate assessment disputes (HR role)',
        group: 'governance',
        write: true,
        description:
            'Act as the final-level (L2) arbiter for assessment disputes that a manager did not resolve in time. This is how an HR business partner is modelled: a scoped local admin holding this grant handles the HR arbitration step inside the system. Decisions are audited and finalise the assessment.',
    },

    // Talent continuity & learning — the most sensitive talent data; delegated
    // sparingly. Managers reach these for their own reports regardless; these
    // grants extend access to scoped local admins.
    {
        slug: 'view_continuity',
        label: 'View continuity & succession',
        group: 'continuity_learning',
        write: false,
        description:
            'View succession plans, the bench and coverage of critical roles — within the assigned scope.',
    },
    {
        slug: 'manage_succession',
        label: 'Manage succession & bench',
        group: 'continuity_learning',
        write: true,
        description:
            'Designate critical roles, open succession plans, and manage successors / emergency cover.',
    },
    {
        slug: 'view_retention_risk',
        label: 'View risk-of-loss',
        group: 'continuity_learning',
        write: false,
        description:
            'View and recompute retention / risk-of-loss for employees in scope. Never includes one’s own record.',
    },
    {
        // The WRITE counterpart of view_retention_risk. Overriding somebody's
        // risk-of-loss rating is a judgement recorded against a named person;
        // before this slug existed the override route was reachable by anyone
        // the /v2/continuity mount admitted, including holders of the
        // read-only view_continuity grant.
        slug: 'manage_retention_risk',
        label: 'Override risk-of-loss',
        group: 'continuity_learning',
        write: true,
        description:
            'Override the computed retention / risk-of-loss rating for employees in scope. Never includes one’s own record.',
    },
    {
        slug: 'manage_handover',
        label: 'Manage knowledge handover',
        group: 'continuity_learning',
        write: true,
        description: 'Create and run knowledge-handover plans for leavers and movers.',
    },
    {
        slug: 'configure_lms',
        label: 'Configure LMS integration',
        group: 'continuity_learning',
        write: true,
        description:
            'Configure LMS providers (Cornerstone, MyPath, xAPI/LTI), map courses to skills, and manage assignments.',
    },

    // Operational compliance — certifications/VOC and position-coverage rules.
    {
        slug: 'view_compliance',
        label: 'View operational compliance',
        group: 'operational_compliance',
        write: false,
        description:
            'View certification/VOC status, expiring certifications, skill-currency lapses and position-coverage rule status — within the assigned scope.',
    },
    {
        slug: 'manage_compliance',
        label: 'Manage operational compliance',
        group: 'operational_compliance',
        write: true,
        implies: ['view_compliance'],
        description:
            'Define certification policies, record/revoke employee certifications (VOC), and manage position-coverage rules.',
    },

    // --- Talent DECISION rights -------------------------------------------
    // These four close a real authorization gap: the routes that approve
    // assessments, approve/publish 9-box placements, finalize calibrations,
    // decide mobility applications and run engagement surveys were gated on
    // ROLE SHAPE only (requireAdmin / requireManagerOrAdmin), so a read-only
    // Viewer and the zero-permission local admins could all exercise them.
    // Making them slugs puts every admin write under the same catalogue that
    // the access review and the anti-escalation clamp already govern.
    // A MANAGER keeps these implicitly for their own reports (the routes use
    // requireManagerOrAnyPermission), so nothing changes for line management.
    {
        slug: 'approve_assessments',
        label: 'Approve skill assessments',
        group: 'people_assessments',
        write: true,
        actsOn: 'employees',
        implies: ['view_employees'],
        description:
            'Approve submitted self-assessments (including bulk approval) and decide post-approval re-reviews — within the assigned scope. The approved rating becomes the employee’s official level.',
    },
    {
        slug: 'manage_talent_reviews',
        label: 'Manage talent reviews (9-box & calibration)',
        group: 'people_assessments',
        write: true,
        description:
            'Create, approve, disclose and archive 9-box placements, and finalize calibration sessions — confidential talent decisions, within the assigned scope.',
    },
    {
        slug: 'manage_mobility',
        label: 'Manage internal mobility',
        group: 'continuity_learning',
        write: true,
        description:
            'Post internal opportunities, decide applications (accept/decline) and decide cancellation requests — within the assigned scope.',
    },
    {
        slug: 'manage_surveys',
        label: 'Manage engagement surveys',
        group: 'governance',
        write: true,
        description:
            'Create engagement/eNPS surveys, open and close them, and read aggregated results (individual responses stay anonymous when the survey is anonymous).',
    },
];

const ALL_SLUGS = PERMISSIONS.map((p) => p.slug);
const WRITE_SLUGS = new Set(PERMISSIONS.filter((p) => p.write).map((p) => p.slug));
const BY_SLUG = Object.fromEntries(PERMISSIONS.map((p) => [p.slug, p]));

/**
 * Stable group KEYS, in render order for the admin form. These are identifiers,
 * never display text: the UI resolves them through `admin:permgroup.<key>`
 * (see AdminController._permissionGroupsFor). Never rename a key — it is part of
 * the i18n contract, exactly like a permission slug.
 */
const GROUPS = [
    'people_assessments',
    'configuration',
    'data',
    'governance',
    'continuity_learning',
    'operational_compliance',
];

/** English group titles — the last-resort fallback when a locale lacks the key. */
const GROUP_LABELS = {
    people_assessments: 'People & Assessments',
    configuration: 'Configuration',
    data: 'Data',
    governance: 'Governance',
    continuity_learning: 'Talent Continuity & Learning',
    operational_compliance: 'Operational Compliance',
};

function isValidSlug(slug) {
    return Object.prototype.hasOwnProperty.call(BY_SLUG, slug);
}

function isWrite(slug) {
    return WRITE_SLUGS.has(slug);
}

/**
 * Expand a set of granted slugs to include everything they IMPLY (transitively).
 * Holding a coarse `manage_*` grant therefore satisfies a guard that checks the
 * finer `view_*` / `edit_*` slug — so the split is backward-compatible: an admin
 * who was granted `manage_employees` still passes every employee route, and a new
 * admin can be granted just `view_employees` for read-only access.
 */
function expandSlugs(slugs) {
    const out = new Set();
    const visit = (slug) => {
        if (!slug || out.has(slug)) return;
        out.add(slug);
        const def = BY_SLUG[slug];
        if (def && Array.isArray(def.implies)) def.implies.forEach(visit);
    };
    (Array.isArray(slugs) ? slugs : []).forEach(visit);
    return [...out];
}

/** The read slug a write marked `actsOn: '<subject>'` must imply. */
const READ_FOR_SUBJECT = { employees: 'view_employees' };

/** Write slugs that act on employee records (each implies view_employees). */
const EMPLOYEE_ACTING_WRITES = PERMISSIONS.filter((p) => p.write && p.actsOn === 'employees').map(
    (p) => p.slug
);

/**
 * Catalogue lint: a write slug that acts on a subject MUST imply that
 * subject's read slug, transitively — otherwise the grant is a capability with no
 * reachable page. Also refuses an `implies` target or `actsOn` subject that does
 * not exist. Runs at require time so a bad catalogue never boots.
 */
function assertCatalogConsistent(catalog = PERMISSIONS) {
    const bySlug = Object.fromEntries(catalog.map((p) => [p.slug, p]));
    const expand = (slug) => {
        const out = new Set();
        const visit = (s) => {
            if (!s || out.has(s)) return;
            out.add(s);
            (bySlug[s]?.implies || []).forEach(visit);
        };
        visit(slug);
        return out;
    };
    for (const p of catalog) {
        (p.implies || []).forEach((t) => {
            if (!bySlug[t]) throw new Error(`permissions: "${p.slug}" implies unknown slug "${t}"`);
        });
        if (!p.actsOn) continue;
        const read = READ_FOR_SUBJECT[p.actsOn];
        if (!read)
            throw new Error(`permissions: "${p.slug}" acts on unknown subject "${p.actsOn}"`);
        if (p.write && !expand(p.slug).has(read)) {
            throw new Error(
                `permissions: write slug "${p.slug}" acts on ${p.actsOn} but does not imply "${read}"`
            );
        }
    }
    return true;
}
assertCatalogConsistent();

/**
 * Employee-acting writes in `slugs` that would arrive WITHOUT view_employees if
 * implication did not exist. The grant form warns on these (the implication makes
 * the grant work anyway; the warning explains the read that comes with it).
 */
function missingReadImplications(slugs) {
    const set = new Set(Array.isArray(slugs) ? slugs : []);
    if (set.has('view_employees')) return [];
    return EMPLOYEE_ACTING_WRITES.filter((s) => set.has(s));
}

module.exports = {
    PERMISSIONS,
    ALL_SLUGS,
    WRITE_SLUGS,
    BY_SLUG,
    GROUPS,
    GROUP_LABELS,
    EMPLOYEE_ACTING_WRITES,
    isValidSlug,
    isWrite,
    expandSlugs,
    assertCatalogConsistent,
    missingReadImplications,
};
