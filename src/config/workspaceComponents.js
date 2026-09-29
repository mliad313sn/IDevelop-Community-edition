'use strict';
/**
 * Workspace components a SuperAdmin can show/hide PER ADMIN — the dashboard tabs
 * and the sidebar sections. Visibility resolves as:
 *
 *     explicit override (admins.workspace_prefs[key])  ??  permission-aware default
 *
 * The permission-aware default mirrors what the admin could already reach: a tab or
 * section whose `permAny` the admin doesn't hold is hidden by default (SuperAdmins
 * hold everything). A SuperAdmin can then force it on/off for a specific admin.
 *
 * Only applies to admins; employees/managers are never affected (isVisible → true).
 *
 * @module config/workspaceComponents
 */

// key -> { key, group, label(i18n slug), permAny[] }. permAny empty = always default-on.
const COMPONENTS = [
    // Dashboard tabs
    { key: 'tab:executive', group: 'tab', label: 'ws_tab_executive', permAny: [] },
    {
        key: 'tab:training',
        group: 'tab',
        label: 'ws_tab_training',
        permAny: ['manage_assessments', 'configure_lms', 'view_domains_skills'],
    },
    {
        key: 'tab:talentdev',
        group: 'tab',
        label: 'ws_tab_talentdev',
        permAny: [
            'view_continuity',
            'manage_succession',
            'view_retention_risk',
            'manage_handover',
            'manage_assessments',
        ],
    },
    {
        key: 'tab:team',
        group: 'tab',
        label: 'ws_tab_team',
        permAny: ['manage_employees', 'edit_employees', 'view_domains_skills'],
    },
    {
        key: 'tab:capability',
        group: 'tab',
        label: 'ws_tab_capability',
        permAny: ['view_domains_skills', 'manage_domains_skills', 'view_roles'],
    },
    {
        key: 'tab:comparator',
        group: 'tab',
        label: 'ws_tab_comparator',
        permAny: ['view_roles', 'manage_roles'],
    },
    // Sidebar sections (match the existing per-section capability gating in sidebar.ejs)
    { key: 'nav:main', group: 'nav', label: 'ws_nav_main', permAny: [] },
    { key: 'nav:team', group: 'nav', label: 'ws_nav_team', permAny: [] },
    { key: 'nav:talent', group: 'nav', label: 'ws_nav_talent', permAny: [] },
    {
        key: 'nav:configuration',
        group: 'nav',
        label: 'ws_nav_configuration',
        permAny: [
            'manage_organization',
            'view_domains_skills',
            'manage_domains_skills',
            'view_roles',
            'manage_roles',
            'view_app_settings',
            'manage_app_settings',
        ],
    },
    {
        key: 'nav:administration',
        group: 'nav',
        label: 'ws_nav_administration',
        permAny: ['manage_admins', 'view_system_logs', 'manage_onboarding', 'manage_cycles'],
    },
    { key: 'nav:tools', group: 'nav', label: 'ws_nav_tools', permAny: [] },
];

const BY_KEY = new Map(COMPONENTS.map((c) => [c.key, c]));
const VALID_KEYS = new Set(COMPONENTS.map((c) => c.key));

function _prefs(user) {
    const p = (user && (user.workspacePrefs || user.workspace_prefs)) || {};
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/** Permission-aware default (ignores explicit overrides). */
function defaultVisible(comp, user) {
    if (!user) return true;
    if (user.role === 'superadmin') return true;
    if (!comp.permAny || comp.permAny.length === 0) return true;
    const grants = Array.isArray(user.permissions) ? user.permissions : [];
    return comp.permAny.some((s) => grants.includes(s));
}

/**
 * Is a component visible on this user's workspace?
 * Non-admins are unaffected (always true). Unknown keys default to visible.
 */
function isVisible(key, user) {
    if (!user || user.userType !== 'admin') return true;
    const comp = BY_KEY.get(key);
    if (!comp) return true;
    const o = _prefs(user)[key];
    if (o === true || o === false) return o;
    return defaultVisible(comp, user);
}

/**
 * For the admin edit UI: each component with its current state for a TARGET admin —
 * `state` is 'show' | 'hide' when explicitly overridden, else 'default', and
 * `defaultVisible` is what the permission-aware default resolves to.
 */
function describeFor(targetAdmin) {
    const prefs = _prefs(targetAdmin);
    return COMPONENTS.map((c) => {
        const o = prefs[c.key];
        const state = o === true ? 'show' : o === false ? 'hide' : 'default';
        return {
            key: c.key,
            group: c.group,
            label: c.label,
            state,
            defaultVisible: defaultVisible(c, targetAdmin),
        };
    });
}

/**
 * Build the stored deviation map from a submitted { key: 'default'|'show'|'hide' }.
 * Only non-default choices are persisted, so later permission changes still flow
 * through for untouched components. Ignores unknown keys.
 */
function buildPrefsFromForm(form) {
    const out = {};
    if (!form || typeof form !== 'object') return out;
    for (const [key, choice] of Object.entries(form)) {
        if (!VALID_KEYS.has(key)) continue;
        if (choice === 'show') out[key] = true;
        else if (choice === 'hide') out[key] = false;
        // 'default' (or anything else) → omit
    }
    return out;
}

module.exports = {
    COMPONENTS,
    isVisible,
    defaultVisible,
    describeFor,
    buildPrefsFromForm,
    VALID_KEYS,
};
