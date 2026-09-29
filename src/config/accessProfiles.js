'use strict';

/**
 * ACCESS PROFILES — the PRIMARY granting control for delegated administration.
 *
 * The granular permission catalogue (`config/permissions.js`) is the source of
 * truth for what a delegate MAY do, but it is a 29-checkbox surface: on the live
 * install `admin_permissions` held ZERO rows, because granting capability meant
 * hand-ticking two dozen boxes for each of 25 local admins. Nobody did it, so 25
 * scoped admins had scope and no capability at all.
 *
 * A profile is a NAMED, REVIEWABLE bundle of slugs matching a real HR job on a
 * industrial site ("Chargé RH de site", "Coordinateur formation", …). Picking one
 * ticks its slugs in the existing checkbox grid and posts them through the
 * existing `permissions[]` field — a SNAPSHOT, not a live link. There is
 * deliberately NO new storage path and NO per-profile table: the grant that
 * lands in `admin_permissions` is exactly what the reviewer saw and could have
 * ticked by hand, so the access review, the anti-escalation clamp
 * (`_assignableSlugs`) and the viewer write-filter all keep working unchanged.
 * Editing a profile here therefore never silently re-grants anyone: it only
 * changes what the NEXT application of that profile proposes.
 *
 * Fields
 *   key              stable identifier posted as `accessProfile` (audit only)
 *   label / description  {fr, en} — FR is primary, EN mirrors
 *   role             the account role the profile is meant for (localadmin|viewer)
 *   slugs            the capability bundle (validated against the catalogue below)
 *   defaultScopeType site | department | country — the scope grain that fits the job
 *   defaultDays      access duration proposed by the form (re-certification cadence)
 */

const { isValidSlug, ALL_SLUGS } = require('./permissions');

/** Sentinel key for "no profile — leave the grid free". Never a stored value. */
const CUSTOM_KEY = 'custom';

const ACCESS_PROFILES = [
    {
        key: 'site_hr',
        label: { fr: 'Chargé RH de site', en: 'Site HR officer' },
        description: {
            fr: 'Gère les collaborateurs, les évaluations et leur approbation, les revues de talents et l’intégration des nouveaux arrivants, sur un site.',
            en: 'Runs employees, assessments and their approval, talent reviews and onboarding for one site.',
        },
        role: 'localadmin',
        defaultScopeType: 'site',
        defaultDays: 365,
        slugs: [
            'manage_employees',
            'manage_assessments',
            'approve_assessments',
            'manage_talent_reviews',
            'manage_onboarding',
            'view_domains_skills',
            'view_roles',
            'view_continuity',
            'view_compliance',
            'export_data',
        ],
    },
    {
        key: 'dept_lead',
        label: {
            fr: 'Chef de département (admin délégué)',
            en: 'Department head (delegated admin)',
        },
        description: {
            fr: 'Met à jour les fiches de ses collaborateurs, saisit et approuve leurs évaluations. Ne réinitialise aucun mot de passe.',
            en: 'Updates their own staff records and records/approves their assessments. Cannot reset any password.',
        },
        role: 'localadmin',
        defaultScopeType: 'department',
        defaultDays: 365,
        slugs: [
            'edit_employees',
            'manage_assessments',
            'approve_assessments',
            'view_domains_skills',
            'view_roles',
            'view_compliance',
        ],
    },
    {
        key: 'training_coord',
        label: { fr: 'Coordinateur formation', en: 'Training coordinator' },
        description: {
            fr: 'Pilote le LMS, les évaluations de compétences et la conformité opérationnelle (habilitations, VOC) sur un site.',
            en: 'Runs the LMS, skill assessments and operational compliance (certifications, VOC) for one site.',
        },
        role: 'localadmin',
        defaultScopeType: 'site',
        defaultDays: 365,
        slugs: [
            'view_employees',
            'manage_assessments',
            'configure_lms',
            'view_domains_skills',
            'view_roles',
            'manage_compliance',
            'view_compliance',
            'export_data',
        ],
    },
    {
        key: 'country_hrbp',
        label: { fr: 'Responsable RH pays (HRBP)', en: 'Country HR business partner (HRBP)' },
        description: {
            fr: 'Profil le plus large : RH complet sur un pays — approbations, revues de talents, mobilité, enquêtes, arbitrage des litiges, succession et journal d’audit.',
            en: 'The widest profile: full HR for one country — approvals, talent reviews, mobility, surveys, dispute arbitration, succession and the audit trail.',
        },
        role: 'localadmin',
        defaultScopeType: 'country',
        defaultDays: 365,
        slugs: [
            'manage_employees',
            'manage_assessments',
            'approve_assessments',
            'manage_talent_reviews',
            'manage_mobility',
            'manage_surveys',
            'arbitrate_disputes',
            'manage_onboarding',
            'view_continuity',
            'manage_succession',
            'view_retention_risk',
            'manage_retention_risk',
            'view_compliance',
            'export_data',
            'view_system_logs',
        ],
    },
    {
        key: 'governance_read',
        label: { fr: 'Auditeur (lecture seule)', en: 'Auditor (read-only)' },
        description: {
            fr: 'Consultation seule : référentiel, continuité, risque de perte, conformité et journal d’audit. Aucune écriture possible.',
            en: 'Read-only: framework, continuity, risk-of-loss, compliance and the audit trail. No write capability at all.',
        },
        role: 'viewer',
        defaultScopeType: 'site',
        defaultDays: 180,
        slugs: [
            'view_domains_skills',
            'view_roles',
            'view_continuity',
            'view_retention_risk',
            'view_compliance',
            'view_system_logs',
            'export_data',
        ],
    },
    {
        key: 'data_steward',
        label: { fr: 'Gestionnaire de données', en: 'Data steward' },
        description: {
            fr: 'Provisionne et exporte les données, et tient à jour la structure organisationnelle (sites, départements, services).',
            en: 'Provisions and exports data, and maintains the organisation structure (sites, departments, services).',
        },
        role: 'localadmin',
        defaultScopeType: 'site',
        defaultDays: 365,
        slugs: [
            'view_employees',
            'import_data',
            'export_data',
            'view_domains_skills',
            'view_roles',
            'manage_organization',
        ],
    },
];

// --- Fail fast at boot -----------------------------------------------------
// A profile that names a slug the catalogue does not define would silently grant
// nothing (the sanitizer drops unknown slugs), leaving an admin who LOOKS
// provisioned and is not. That is precisely the failure this module exists to
// end, so a typo must stop the process at require time, not at grant time.
(function validateProfiles() {
    const seen = new Set();
    const VALID_ROLES = new Set(['localadmin', 'viewer']);
    const VALID_SCOPES = new Set(['site', 'department', 'service', 'country']);
    for (const p of ACCESS_PROFILES) {
        if (!p.key || seen.has(p.key)) {
            throw new Error(`accessProfiles: duplicate or missing profile key "${p.key}"`);
        }
        seen.add(p.key);
        if (p.key === CUSTOM_KEY) {
            throw new Error(
                `accessProfiles: "${CUSTOM_KEY}" is reserved for the no-profile option`
            );
        }
        if (
            !p.label ||
            !p.label.fr ||
            !p.label.en ||
            !p.description ||
            !p.description.fr ||
            !p.description.en
        ) {
            throw new Error(`accessProfiles: profile "${p.key}" needs fr+en label and description`);
        }
        if (!VALID_ROLES.has(p.role)) {
            throw new Error(
                `accessProfiles: profile "${p.key}" has role "${p.role}" (expected localadmin|viewer)`
            );
        }
        if (!VALID_SCOPES.has(p.defaultScopeType)) {
            throw new Error(
                `accessProfiles: profile "${p.key}" has an unknown defaultScopeType "${p.defaultScopeType}"`
            );
        }
        if (!Number.isInteger(p.defaultDays) || p.defaultDays <= 0) {
            throw new Error(
                `accessProfiles: profile "${p.key}" needs a positive integer defaultDays`
            );
        }
        if (!Array.isArray(p.slugs) || p.slugs.length === 0) {
            throw new Error(`accessProfiles: profile "${p.key}" grants nothing`);
        }
        for (const slug of p.slugs) {
            if (!isValidSlug(slug)) {
                throw new Error(
                    `accessProfiles: profile "${p.key}" names unknown permission "${slug}" — ` +
                        `it is not in the catalogue (${ALL_SLUGS.length} slugs). Fix the profile or add the slug.`
                );
            }
        }
        if (new Set(p.slugs).size !== p.slugs.length) {
            throw new Error(`accessProfiles: profile "${p.key}" lists a slug twice`);
        }
    }
})();

const BY_KEY = Object.fromEntries(ACCESS_PROFILES.map((p) => [p.key, p]));
const PROFILE_KEYS = ACCESS_PROFILES.map((p) => p.key);

/** @returns {boolean} true when `key` names a real profile (never true for 'custom'). */
function isProfileKey(key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(BY_KEY, key);
}

/** @returns {object|null} the profile definition, or null for an unknown/custom key. */
function byKey(key) {
    return isProfileKey(key) ? BY_KEY[key] : null;
}

/** The slug bundle of a profile (a fresh copy), or [] when the key is unknown. */
function slugsFor(key) {
    const p = byKey(key);
    return p ? [...p.slugs] : [];
}

/**
 * Profiles rendered for one locale, with the granter's clamp applied so the form
 * never offers a bundle the granter cannot actually hand out.
 * @param {string} lng 'fr' (default) or 'en'
 * @param {string[]} [assignableSlugs] slugs the granter may grant; omit for "all"
 */
function localize(lng, assignableSlugs) {
    const l = lng === 'en' ? 'en' : 'fr';
    const clamp = Array.isArray(assignableSlugs) ? new Set(assignableSlugs) : null;
    return ACCESS_PROFILES.map((p) => {
        const grantable = clamp ? p.slugs.filter((s) => clamp.has(s)) : [...p.slugs];
        return {
            key: p.key,
            label: p.label[l],
            description: p.description[l],
            role: p.role,
            defaultScopeType: p.defaultScopeType,
            defaultDays: p.defaultDays,
            slugs: grantable,
            // The bundle's full size, so the form can say "you may grant 6 of 10"
            // instead of quietly proposing a thinner profile under the same name.
            total: p.slugs.length,
            // true when the granter cannot hand out the whole bundle — the form
            // says so rather than silently applying a thinner grant.
            partial: grantable.length !== p.slugs.length,
            unavailable: grantable.length === 0,
        };
    });
}

module.exports = {
    ACCESS_PROFILES,
    PROFILE_KEYS,
    BY_KEY,
    CUSTOM_KEY,
    isProfileKey,
    byKey,
    slugsFor,
    localize,
};
