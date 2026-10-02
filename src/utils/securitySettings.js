'use strict';
/**
 * Which App Settings are SECURITY-CLASS.
 *
 * The general /app-settings page stays visible (and operational settings stay
 * editable) for administrators holding manage_app_settings, but a setting that
 * decides who gets in, how long a session lives, where data is sent or how long
 * it is kept is editable by a SuperAdmin only: authentication, session, MFA,
 * SSO, onboarding, data retention, AI / copilot, API, backup, the public base
 * URL (password-reset links are built from it) and the outgoing mail server
 * (every reset link travels through it).
 *
 * One list, read by AppSettingsController.update (server-side refusal) and by
 * the settings page (read-only badge instead of the edit button).
 */

/** Whole categories that are security-class. */
const SECURITY_CATEGORIES = new Set([
    'security',
    'auth',
    'session',
    'mfa',
    'sso',
    'onboarding',
    'copilot',
    'ai',
    'api',
    'backup',
    'retention',
    'privacy',
]);

/**
 * Keys that are security-class whatever category they were filed under (the
 * job-tunable 'jobs' category mixes operational hours with backup and
 * retention). `retentionRecomputeHour` (the flight-risk job) is operational and
 * deliberately NOT matched: data-retention keys end in RetentionDays / Purge.
 */
const SECURITY_KEY_PATTERNS = [
    /^session/i,
    /^maxLoginAttempts$/i,
    /^loginLockout/i,
    /^mfa/i,
    /^sso/i,
    /^saml/i,
    /^oidc/i,
    /^scim/i,
    /^password/i,
    /^invitation/i,
    /^dormantAccount/i,
    /^copilot/i,
    /^companion\./i,
    /^llm/i,
    /^ai[A-Z]/,
    /^api[A-Z]/,
    /^backup/i,
    /RetentionDays$/i,
    /^retentionPurge/i,
    /^dsr/i,
    /^erasure/i,
    /^kiosk/i,
    /^appBaseUrl$/i,
    /^trustedHosts$/i,
    // Where every password-reset link and notification is sent from.
    /^smtp/i,
    // HRIS synchronisation: who is placed, moved or deprovisioned automatically.
    /^hris/i,
];

/** @returns {boolean} true when the setting is security-class. */
function isSecurityClassSetting(settingKey, category) {
    const k = String(settingKey || '');
    const c = String(category || '').toLowerCase();
    if (SECURITY_CATEGORIES.has(c)) return true;
    return SECURITY_KEY_PATTERNS.some((re) => re.test(k));
}

/** May this user change this setting? SuperAdmin: all; others: not security-class. */
function canEditSetting(user, settingKey, category) {
    if (user && user.role === 'superadmin') return true;
    return !isSecurityClassSetting(settingKey, category);
}

module.exports = { SECURITY_CATEGORIES, isSecurityClassSetting, canEditSetting };
