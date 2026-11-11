'use strict';

/**
 * Anti-enumeration timing helpers.
 *
 * A refused identifier (unknown, inactive, locked, not activated) must cost the
 * same bcrypt comparison as a real account with a wrong password. Otherwise the
 * sign-in answers a non-existent name about one bcrypt faster, which is an
 * account-enumeration oracle.
 *
 * One bcrypt hash of a random secret per cost, built on first use and kept for
 * the life of the process. Nobody knows the secret, so a comparison is always
 * false.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');

/** The cost every password is hashed with (AuthService, resets). */
const APP_BCRYPT_COST = 10;

const _dummyHashes = new Map();

/** A promise of a bcrypt hash of an unknown secret at `cost`. */
function dummyHash(cost = APP_BCRYPT_COST) {
    if (!_dummyHashes.has(cost))
        _dummyHashes.set(cost, bcrypt.hash(crypto.randomBytes(18).toString('base64'), cost));
    return _dummyHashes.get(cost);
}

/** Burn one bcrypt comparison against a hash nobody knows. Always false; never throws. */
async function dummyCompare(password, cost = APP_BCRYPT_COST) {
    try {
        await bcrypt.compare(String(password || ''), await dummyHash(cost));
    } catch (_) {
        /* timing only */
    }
    return false;
}

module.exports = { APP_BCRYPT_COST, dummyHash, dummyCompare };
