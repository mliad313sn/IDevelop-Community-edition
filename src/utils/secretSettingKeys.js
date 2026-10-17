'use strict';
/**
 * ONE predicate for "does this app setting hold a credential?".
 *
 * Matched by the LAST dot-segment of the key: …password / …secret / …token /
 * …apiKey / …privateKey / …passphrase / …pass (smtpPassword, copilotApiSecret,
 * sso.entra.clientSecret…). AppSettingsModel encrypts these at rest and masks
 * them in listings; the JSON export omits them and the JSON import never
 * writes them; snapshots never copy them. Dependency-free on purpose, so every
 * reader (including those whose tests mock the model) shares it.
 */
const SECRET_KEY_RE =
    /(password|secret|token|apikey|api_key|privatekey|private_key|passphrase|pass)$/i;

/**
 * @param {string} key
 * @param {string} [type] the stored settingType when known: a boolean or a
 *        number is never a credential (ssoDisablesLocalPassword is a switch).
 */
function isSecretKey(key, type) {
    const k = String(key == null ? '' : key);
    if (!k) return false;
    const t = String(type || '').toLowerCase();
    if (t === 'boolean' || t === 'number') return false;
    if (k === 'ssoDisablesLocalPassword') return false;
    return SECRET_KEY_RE.test(k.split('.').pop());
}

module.exports = { isSecretKey, SECRET_KEY_RE };
