/**
 * Password Validator — NIST SP 800-63B / OWASP ASVS 4.0.3 V2.1.
 *
 * Applied to every NEW or CHANGED password (sign-up, change, reset, an
 * administrator setting one). Sign-in never re-validates a stored password,
 * so accounts created under an older policy keep working until the next change.
 *
 *   - 12 characters minimum (ASVS 2.1.1), up to 128 (2.1.2: at least 64 must be
 *     allowed). bcrypt only reads the first 72 bytes, which is well past any
 *     guessable prefix.
 *   - Every character is allowed, spaces and Unicode included (2.1.3, 2.1.4).
 *   - No composition rule by default (ASVS 2.1.9, NIST 5.1.1.2): requiring an
 *     upper-case letter, a digit and a symbol pushes people to "Password1!",
 *     which every cracking dictionary tries first. Length, the common/breached
 *     list below and the repeat/sequence checks do the job instead. An
 *     organisation whose written policy still mandates character classes sets
 *     PASSWORD_REQUIRE_CHAR_CLASSES=1 to restore them.
 *   - An offline list of common and breached passwords (2.1.7), in
 *     src/data/common-passwords.txt (provenance in its header). The lookup is
 *     made on the whole password AND on its "base word": lower case, leetspeak
 *     undone, leading/trailing digits and symbols removed. So "Sunshine2024!"
 *     and "P@ssw0rd123456" are refused, while a passphrase such as
 *     "violet tram umbrella" is not.
 *
 * `validate` returns English sentences; callers map them to FR/EN keys by
 * their stable wording (AuthController PW_RULE_KEYS, OnboardingService).
 */
const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/** Substrings refused anywhere in the password (the words people build on). */
const FORBIDDEN_SUBSTRINGS = [
    'password',
    'passw0rd',
    'p@ssw0rd',
    'p@ssword',
    'p@$$w0rd',
    'motdepasse',
    'qwerty',
    'azerty',
    'letmein',
    'iloveyou',
    'changeme',
];

const LIST_FILE = path.join(__dirname, '..', 'data', 'common-passwords.txt');
let _list = null;

/** The bundled list, loaded once (lower case, comments and blanks dropped). */
function commonList() {
    if (_list) return _list;
    const set = new Set();
    try {
        for (const line of fs.readFileSync(LIST_FILE, 'utf8').split(/\r?\n/)) {
            const w = line.trim().toLowerCase();
            if (w && !w.startsWith('#')) set.add(w);
        }
    } catch (_) {
        /* list missing: the other rules still apply */
    }
    _list = set;
    return _list;
}

const LEET = {
    '@': 'a',
    4: 'a',
    3: 'e',
    0: 'o',
    $: 's',
    5: 's',
    7: 't',
    '!': 'i',
    1: 'i',
    '|': 'l',
};

function deLeet(s) {
    return s.replace(/[@430$57!1|]/g, (c) => LEET[c] || c);
}

/**
 * The forms of a password that are looked up in the list: itself, its
 * leetspeak reading, and the same after trimming digits/symbols at both ends
 * (with "1" read as "i" and as "l").
 */
function candidates(password) {
    const lower = String(password).normalize('NFKC').toLowerCase();
    const out = new Set([lower, lower.replace(/\s+/g, '')]);
    const trimmed = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    for (const s of [lower, trimmed]) {
        if (!s) continue;
        out.add(s);
        out.add(deLeet(s));
        out.add(deLeet(s.replace(/1/g, 'l')));
    }
    // "Password2024!" → the letters inside the digits/symbols run.
    const core = deLeet(lower).replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (core) out.add(core);
    return [...out].filter(Boolean);
}

/** True when a word of the list is the password, its base word, or that word repeated. */
function isCommonPassword(password) {
    const list = commonList();
    for (const c of candidates(password)) {
        if (list.has(c)) return true;
        const rep = /^(.{3,}?)\1+$/.exec(c); // "soleilsoleil"
        if (rep && list.has(rep[1])) return true;
    }
    const lower = String(password).toLowerCase();
    return FORBIDDEN_SUBSTRINGS.some((w) => lower.includes(w) || deLeet(lower).includes(w));
}

function requireCharClasses() {
    return process.env.PASSWORD_REQUIRE_CHAR_CLASSES === '1';
}

const SPECIAL = /[^\p{L}\p{N}]/u;

class PasswordValidator {
    /**
     * Validate a new password.
     * @param {string} password
     * @returns {{valid: boolean, errors: string[], score: number}}
     */
    validate(password) {
        const errors = [];

        if (!password) {
            errors.push('Password is required');
            return { valid: false, errors, score: 0 };
        }
        password = String(password);

        if ([...password].length < MIN_LENGTH) {
            errors.push(`Password must be at least ${MIN_LENGTH} characters long`);
        }
        if (password.length > MAX_LENGTH) {
            errors.push(`Password must not exceed ${MAX_LENGTH} characters`);
        }

        if (requireCharClasses()) {
            if (!/\p{Ll}/u.test(password))
                errors.push('Password must contain at least one lowercase letter');
            if (!/\p{Lu}/u.test(password))
                errors.push('Password must contain at least one uppercase letter');
            if (!/[0-9]/.test(password)) errors.push('Password must contain at least one number');
            if (!SPECIAL.test(password))
                errors.push(
                    'Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)'
                );
        }

        if (isCommonPassword(password)) {
            errors.push('Password is too common. Please choose a stronger password');
        }

        // "aaaa", "1111", or a short unit repeated ("abcabcabcabc", "202420242024").
        if (/(.)\1{3,}/.test(password) || /^(.{1,4})\1{2,}$/i.test(password)) {
            errors.push('Password must not contain more than 3 repeated characters in a row');
        }

        const lowerPassword = password.toLowerCase();
        const sequences = [
            'abcdefghijklmnopqrstuvwxyz',
            'zyxwvutsrqponmlkjihgfedcba',
            '0123456789',
            '9876543210',
            'qwertyuiop',
            'poiuytrewq',
            'azertyuiop',
            'asdfghjkl',
            'lkjhgfdsa',
            'zxcvbnm',
            'mnbvcxz',
        ];
        let sequential = false;
        for (const seq of sequences) {
            for (let i = 0; i <= seq.length - 4 && !sequential; i++) {
                if (lowerPassword.includes(seq.substring(i, i + 4))) sequential = true;
            }
            if (sequential) break;
        }
        if (sequential) {
            errors.push(
                'Password must not contain sequential characters (e.g., "abcd", "1234", "qwerty")'
            );
        }

        const keyboardPatterns = [
            'qwerty',
            'azerty',
            'asdfgh',
            'zxcvbn',
            'qazwsx',
            '1qaz2wsx',
            '!qaz@wsx',
        ];
        if (keyboardPatterns.some((p) => lowerPassword.includes(p))) {
            errors.push('Password must not contain common keyboard patterns');
        }

        const score = this.calculateStrength(password);
        return { valid: errors.length === 0, errors, score };
    }

    /**
     * Strength score 0-100, length first (the same idea as the browser meter in
     * public/js/password-strength.js).
     * @param {string} password
     * @returns {number}
     */
    calculateStrength(password) {
        if (!password) return 0;
        password = String(password);
        const len = [...password].length;
        let score = Math.min(70, len * 4); // 12 chars → 48, 18+ → 70
        const classes = [/\p{Ll}/u, /\p{Lu}/u, /[0-9]/, SPECIAL].filter((r) =>
            r.test(password)
        ).length;
        score += classes * 5;
        if (/\s/.test(password.trim()) && len >= 16) score += 10; // passphrase
        score += Math.min(10, Math.floor(new Set(password).size / 2));
        if (/(.)\1{2,}/.test(password)) score -= 15;
        if (isCommonPassword(password)) score = Math.min(score, 10);
        return Math.max(0, Math.min(100, score));
    }

    /**
     * @param {number} score
     * @returns {'Weak'|'Fair'|'Good'|'Strong'}
     */
    getStrengthLabel(score) {
        if (score < 40) return 'Weak';
        if (score < 60) return 'Fair';
        if (score < 80) return 'Good';
        return 'Strong';
    }
}

const instance = new PasswordValidator();
instance.isCommonPassword = isCommonPassword;
instance.requireCharClasses = requireCharClasses;
instance.MIN_LENGTH = MIN_LENGTH;
instance.MAX_LENGTH = MAX_LENGTH;
module.exports = instance;
