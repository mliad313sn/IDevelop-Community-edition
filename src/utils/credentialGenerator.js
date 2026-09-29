'use strict';

/**
 * Credential generation for bulk-imported accounts (employees / admins).
 * Produces a deterministic-ish username from identity fields and a strong
 * random temporary password that satisfies the password policy.
 */

const UP = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LO = 'abcdefghijkmnpqrstuvwxyz';
const NU = '23456789';
const SY = '!@#$%&*?';

function pick(set) {
    // Math.random is acceptable here — these are one-time temp passwords the
    // user is expected to rotate, not long-lived secrets.
    return set[Math.floor(Math.random() * set.length)];
}

/** One candidate: >=12 chars, all four classes, shuffled. */
function candidatePassword() {
    let chars = [pick(UP), pick(LO), pick(NU), pick(SY)];
    const all = UP + LO + NU + SY;
    while (chars.length < 12) chars.push(pick(all));
    // Fisher-Yates-ish shuffle
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// Composing from the four classes guarantees the CLASS rules but not the
// SEQUENCE rules. The policy also rejects runs ("kLMN", "ihgf") and 4+ repeated
// characters ("6666"), which a uniform random draw produces about once every
// 6 700 passwords. That was enough to email a policy-invalid temp credential to
// roughly one new joiner in every 6 700 — and to make the test suite flaky,
// which is the more corrosive cost. Validate against the REAL policy and redraw.
const MAX_DRAWS = 50;

/**
 * Strong temporary password that genuinely satisfies the password policy.
 * At the observed reject rate, needing more than a handful of draws is already
 * vanishingly unlikely; exhausting all 50 means the policy has been changed to
 * something this alphabet cannot express, and failing loudly is far better than
 * silently issuing credentials the user's own account rules will reject.
 */
function generatePassword() {
    const validator = require('./passwordValidator');
    let last = '';
    for (let draw = 0; draw < MAX_DRAWS; draw++) {
        last = candidatePassword();
        const result = validator.validate(last);
        if (result && result.valid) return last;
    }
    throw new Error(
        `credentialGenerator: could not produce a policy-valid password in ${MAX_DRAWS} draws. ` +
            'The password policy and the generator alphabet have diverged — update credentialGenerator.'
    );
}

/** Base username from identity, sanitized to [a-z0-9._-]. */
function baseUsername({ employeeNumber, firstName, lastName, username }) {
    if (username) return String(username).trim();
    let base = '';
    if (firstName && lastName) {
        base = `${firstName}.${lastName}`;
    } else if (employeeNumber) {
        base = String(employeeNumber);
    } else {
        base = 'user';
    }
    base = base
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip accents
        .replace(/[^a-z0-9._-]/g, '')
        .replace(/^[._-]+|[._-]+$/g, '');
    return base || 'user';
}

/**
 * Resolve a unique username given a base and an async existence-check.
 * isTaken(name) -> Promise<boolean>
 */
async function uniqueUsername(base, isTaken) {
    let candidate = base;
    let n = 1;
    /* eslint-disable no-await-in-loop */
    while (await isTaken(candidate)) {
        candidate = `${base}${n}`;
        n += 1;
    }
    /* eslint-enable no-await-in-loop */
    return candidate;
}

module.exports = { generatePassword, baseUsername, uniqueUsername };
