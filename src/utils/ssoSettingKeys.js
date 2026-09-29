'use strict';
/**
 * 3.23.19 — ONE predicate for "is this app setting
 * an SSO setting?". SSO settings (the master switch, issuers, secrets, the
 * multi-factor acr list, the SSO-only password policy) decide who signs in and
 * what counts as MFA: they are written ONLY through the SuperAdmin SSO page
 * (/app-settings/sso). Every bulk or generic settings writer — the generic
 * settings form, the JSON system import — skips a key this predicate matches.
 * (The SuperAdmin-only snapshot restore is the exception: it restores a whole
 * database state the SuperAdmin took.)
 *
 * Matched: category 'sso'; any key 'sso.*' / 'sso_*' / 'SSO_*' (case-insensitive);
 * 'ssoDisablesLocalPassword'.
 */
function isSsoSettingKey(key, category = null) {
    const k = String(key == null ? '' : key);
    if (String(category || '').toLowerCase() === 'sso') return true;
    if (/^sso[._]/i.test(k)) return true;
    return k === 'ssoDisablesLocalPassword';
}

module.exports = { isSsoSettingKey };
