'use strict';

const crypto = require('crypto');

/**
 * The first-run superadmin password.
 *
 * SECURITY — this must never be a constant. Shipping a fixed default (the old
 * 'admin123') gave every deployment of this product the SAME guessable
 * superadmin credential. `force_password_change` prevents that default
 * PERSISTING, but it does not prevent an attacker being the one who performs
 * the change: whoever reaches the login page first, before the operator's first
 * sign-in, takes ownership of the account.
 *
 * Resolution order:
 *   1. BOOTSTRAP_ADMIN_PASSWORD — lets the installer or an automated deploy pin
 *      a known value. Rejected if it is too short or is a known weak password,
 *      because a pinned-but-guessable value reintroduces the exact problem.
 *   2. A cryptographically random 24-character value (~144 bits), printed once
 *      by the caller for the operator to copy out of the install log.
 *
 * Either way the seeded account carries force_password_change, so the bootstrap
 * value is only ever good for the single sign-in that replaces it.
 *
 * @returns {{password: string, generated: boolean}} generated=false when it came
 *          from BOOTSTRAP_ADMIN_PASSWORD (caller should NOT echo it to the log).
 */
function seedAdminPassword() {
    const pinned = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();
    if (pinned) {
        // Held to the SAME policy as any password a user would set (length,
        // composition, common-password blocklist) — a pinned but guessable value
        // reintroduces exactly the problem this function exists to remove.
        const reasons = weaknessesIn(pinned);
        if (reasons.length) {
            throw new Error(
                'BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy (' +
                    reasons.join('; ') +
                    '). Refusing to seed a weak superadmin credential — ' +
                    'unset it to have a strong one generated instead.'
            );
        }
        return { password: pinned, generated: false };
    }
    // base64url over 18 bytes → 24 chars, no padding, no shell-hostile characters.
    return { password: crypto.randomBytes(18).toString('base64url'), generated: true };
}

/**
 * Runs the app's own PasswordValidator so this stays in step with the policy
 * users are held to, instead of duplicating a blocklist that would drift.
 */
function weaknessesIn(candidate) {
    try {
        const validator = require('./passwordValidator');
        const result = validator.validate(candidate);
        if (result && result.valid === false) return result.errors || ['does not meet policy'];
        return [];
    } catch (_) {
        // Validator unavailable (early boot / trimmed deploy) — apply a minimum bar
        // rather than silently accepting anything.
        const weak = ['admin', 'admin123', 'password', 'changeme', 'letmein'];
        if (candidate.length < 12) return ['must be at least 12 characters long'];
        if (weak.includes(candidate.toLowerCase())) return ['is a well-known password'];
        return [];
    }
}

module.exports = { seedAdminPassword };
