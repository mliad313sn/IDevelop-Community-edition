'use strict';

/**
 *   MfaService — TOTP setup, verification, backup codes.
 *   Privileged profiles MUST complete setup before access is granted:
 *       superadmin, regional_admin, country_admin, site_admin, hr_bp.
 *
 *   This file is a Phase-2 skeleton — it documents the public API
 *   and implements the parts that don't require external packages.
 *   The TOTP math is delegated to `otplib` (added in Phase 2 deps).
 */

const PRODUCT = require('../config/product');
const crypto = require('crypto');
const db = require('../config/database');

// Accept the previous/next 30s step too (standard tolerance for clock skew
// between the server and the user's phone). otplib 13 replaced the v12
// `authenticator.check(code, secret)` + `{ window: 1 }` with verifySync and an
// epoch tolerance in seconds: 30s either side is exactly the previous, current
// and next step, as before. Defaults are unchanged (SHA1, 6 digits, 30s,
// base32 secret), so secrets stored under v12 keep verifying. v13 throws on a
// malformed token or secret where v12 returned false, hence the catch. The
// require stays outside it: a module that fails to load must surface as an
// error, never read as "wrong code". (otplib 13 pulls ES-module plugins, loaded
// with require(esm): Node >= 20.19, as package.json engines already demand.)
const TOTP_TOLERANCE_SECONDS = 30;
function totpCheck(code, secret) {
    const { verifySync } = require('otplib');
    try {
        return verifySync({
            secret,
            token: String(code == null ? '' : code),
            epochTolerance: TOTP_TOLERANCE_SECONDS,
        }).valid;
    } catch {
        return false;
    }
}

// Every admin account is privileged and must use MFA (admins authenticate with
// password + a second factor; employees authenticate via SSO). 'localadmin' and
// 'viewer' are the V3 admin roles; the others are retained for legacy installs.
const PRIVILEGED_ROLES = new Set([
    'superadmin',
    'localadmin',
    'viewer',
    'regional_admin',
    'country_admin',
    'site_admin',
    'hr_bp',
]);

const APP_KEY = (() => {
    const k = process.env.APP_KEY || '';
    if (k.length >= 32) return Buffer.from(k.slice(0, 32));
    // Phase-2 dev fallback: derive from SESSION_SECRET to avoid hard crashes;
    // production deployments MUST set APP_KEY (≥ 32 bytes).
    return crypto
        .createHash('sha256')
        .update(process.env.SESSION_SECRET || 'dev-key')
        .digest();
})();

const IV_LEN = 12;

function encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', APP_KEY, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]); // [iv|tag|ct]
}

function decrypt(blob) {
    const iv = blob.slice(0, IV_LEN);
    const tag = blob.slice(IV_LEN, IV_LEN + 16);
    const ct = blob.slice(IV_LEN + 16);
    // Pin the tag length (see utils/secretBox): unpinned, Node would accept a
    // truncated tag and weaken forgery resistance on the stored MFA secret.
    if (tag.length !== 16) throw new Error('MfaService: bad auth tag length');
    const decipher = crypto.createDecipheriv('aes-256-gcm', APP_KEY, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function generateBase32Secret(bytes = 20) {
    // RFC 4648 base32, no padding
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const raw = crypto.randomBytes(bytes);
    let bits = '';
    for (const b of raw) bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
        out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
    }
    return out;
}

/**
 * A one-way, per-user digest of a used TOTP code. Salted with the user id so the
 * same six digits used by two people are distinct rows, and hashed so the table
 * never holds a live code.
 */
function hashCode(userId, code) {
    return crypto
        .createHash('sha256')
        .update(`${userId}:${String(code).trim()}`)
        .digest('hex');
}

class MfaService {
    static isPrivileged(role) {
        return PRIVILEGED_ROLES.has(role);
    }

    /** mfa_secrets discriminates on user_type: admins vs employee accounts
     *  (managers ARE employee records, so they map to 'employee'). */
    static mfaUserType(user) {
        return user.userType === 'admin' || !user.userType ? 'admin' : 'employee';
    }

    /** Enrolment state: { enrolled, confirmed, backupCodesLeft }. */
    static async status({ userType, userId }) {
        const row = await db.get(
            `SELECT confirmed_at FROM mfa_secrets WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        const codes = await db.get(
            `SELECT COUNT(*)::int AS n FROM mfa_backup_codes
             WHERE user_type = ? AND user_id = ? AND used_at IS NULL`,
            [userType, userId]
        );
        return {
            enrolled: !!row,
            confirmed: !!(row && row.confirmedAt),
            backupCodesLeft: codes ? Number(codes.n) : 0,
        };
    }

    /** True when the account has CONFIRMED MFA (login must ask for a code). */
    static async isActive({ userType, userId }) {
        const row = await db.get(
            `SELECT confirmed_at FROM mfa_secrets WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        return !!(row && row.confirmedAt);
    }

    /** Removes the secret and all backup codes (turns MFA off). */
    static async disable({ userType, userId }) {
        // One transaction (CQ-11): a failure between the two DELETEs used to
        // leave a confirmed secret with its backup codes gone — MFA still
        // demanded at login, the recovery path erased.
        await db.runTransaction(async () => {
            await db.run(`DELETE FROM mfa_backup_codes WHERE user_type = ? AND user_id = ?`, [
                userType,
                userId,
            ]);
            await db.run(`DELETE FROM mfa_secrets WHERE user_type = ? AND user_id = ?`, [
                userType,
                userId,
            ]);
        });
        // The privileged-MFA policy gate caches POSITIVE enrolment for 5 minutes
        // (negative results are never cached, so finishing setup unblocks at once).
        // Without this line a privileged admin who switched MFA off kept walking
        // through that gate for the rest of the cached window, while the policy
        // says they must not.
        MfaService.forgetEnrolment(userType, userId);
    }

    /**
     * SuperAdmin-side reset: the person lost their phone AND their backup
     * codes, so the self-service `disable` (which demands a valid code) cannot
     * help them and, under `mfa_required`, the account is dead. Removes the
     * secret, the backup codes and the used-code trail so the next sign-in
     * starts a fresh enrolment. Authorisation, reason, audit and session revoke
     * are the CALLER's (AdminController.resetMfa) — this only knows the tables.
     * @returns {Promise<{hadSecret: boolean, backupCodesRemoved: number}>}
     */
    static async adminReset({ userType, userId }) {
        const had = await db.get(
            `SELECT 1 AS ok FROM mfa_secrets WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        const codes = await db.run(
            `DELETE FROM mfa_backup_codes WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        await db.run(`DELETE FROM mfa_secrets WHERE user_type = ? AND user_id = ?`, [
            userType,
            userId,
        ]);
        try {
            await db.run(`DELETE FROM mfa_used_codes WHERE user_type = ? AND user_id = ?`, [
                userType,
                userId,
            ]);
        } catch (_) {
            /* housekeeping only */
        }
        MfaService.forgetEnrolment(userType, userId);
        return { hadSecret: Boolean(had), backupCodesRemoved: (codes && codes.changes) || 0 };
    }

    // ---- enrolment cache (shared with the policy gate in server.js) ----------
    // Positive-only, short-lived. It lives here rather than in server.js so the
    // one place that can invalidate it — `disable` above — actually can.
    static _enrolled = new Map();

    static _enrolKey(userType, userId) {
        return `${userType}:${userId}`;
    }

    /** Cache "this user IS enrolled", with the time it was observed. */
    static rememberEnrolment(userType, userId, at = Date.now()) {
        MfaService._enrolled.set(MfaService._enrolKey(userType, userId), at);
    }

    /** True when a positive result was cached within `ttlMs`. */
    static hasFreshEnrolment(userType, userId, ttlMs) {
        const at = MfaService._enrolled.get(MfaService._enrolKey(userType, userId));
        return at != null && Date.now() - at < ttlMs;
    }

    static forgetEnrolment(userType, userId) {
        MfaService._enrolled.delete(MfaService._enrolKey(userType, userId));
    }

    /**
     * Begin enrolment. Returns { started, secret (base32, for QR), otpauthUrl }.
     *
     * An ALREADY CONFIRMED enrolment is never touched: the upsert is guarded on
     * `confirmed_at IS NULL` and the caller gets `started: false`.
     *
     * Why the guard is the fix and not a caller-side check: this ran from
     * `GET /v2/uam/mfa/setup`, and the old statement ended
     * `DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL`.
     * So merely LOADING that page rotated the live secret and cleared the
     * confirmation — and `isEnabled`/`verifyAtLogin` both read `confirmed_at`,
     * so the account silently dropped to a single factor and the authenticator
     * already on the user's phone stopped working. A GET carries no CSRF token
     * and needs no form, so any top-level navigation a third-party page can
     * cause — a link, a redirect, a prefetch — disabled a victim's second
     * factor. A GET must be safe; the destructive step belongs to
     * `POST /mfa/disable`, which already demands a current code.
     *
     * Changing authenticator is therefore deactivate-then-enrol, not a
     * side effect of opening a page.
     */
    static async beginSetup({ userType, userId, accountLabel, issuer = PRODUCT.name }) {
        const secret = generateBase32Secret();
        const otpauth =
            `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}` +
            `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

        // store unconfirmed — but never over a confirmed enrolment
        const enc = encrypt(secret);
        const { changes } = await db.run(
            `INSERT INTO mfa_secrets (user_type, user_id, secret_enc)
             VALUES (?, ?, ?)
             ON CONFLICT (user_type, user_id)
             DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL
             WHERE mfa_secrets.confirmed_at IS NULL`,
            [userType, userId, enc]
        );
        if (!changes) return { started: false, secret: null, otpauthUrl: null };

        return { started: true, secret, otpauthUrl: otpauth };
    }

    /** Confirms enrolment given a user-supplied 6-digit code. */
    static async verifyAndConfirm({ userType, userId, code }) {
        const row = await db.get(
            `SELECT secret_enc FROM mfa_secrets WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        if (!row) throw new Error('MFA not initialised');
        // The PG driver camelizes row keys: secret_enc → secretEnc.
        const secret = decrypt(row.secretEnc);
        const ok = totpCheck(code, secret);
        if (!ok) return false;
        await db.run(
            `UPDATE mfa_secrets SET confirmed_at = now() WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        return true;
    }

    /** Verifies a TOTP code during login (after successful password check). */
    static async verifyAtLogin({ userType, userId, code }) {
        const row = await db.get(
            `SELECT secret_enc, confirmed_at FROM mfa_secrets
             WHERE user_type = ? AND user_id = ?`,
            [userType, userId]
        );
        if (!row || !row.confirmedAt) return false;
        const secret = decrypt(row.secretEnc);
        if (!totpCheck(code, secret)) return false;

        // CONSUME the code. A TOTP code stayed valid for its whole window (and the
        // +/-1 step tolerance, so ~90 seconds), and nothing recorded that it had been
        // used — so a code observed over someone's shoulder, or replayed from a
        // proxy, worked a second time. A second factor has to be single-use, or it
        // only proves possession at some point in the last minute and a half.
        //
        // The insert IS the consumption: the unique index makes a replay lose the
        // race rather than be checked-then-used.
        const consumed = await db.get(
            `INSERT INTO mfa_used_codes (user_type, user_id, code_hash)
             VALUES (?, ?, ?)
             ON CONFLICT (user_type, user_id, code_hash) DO NOTHING
             RETURNING id`,
            [userType, userId, hashCode(userId, code)]
        );
        // Housekeeping: a code can only ever be accepted inside its own window, so
        // nothing older than a few minutes can be replayed and the row has no
        // further purpose. Done here (best-effort, cheap on the used_at index)
        // rather than as another scheduled job.
        try {
            await db.run(
                "DELETE FROM mfa_used_codes WHERE used_at < now() - interval '10 minutes'"
            );
        } catch (_) {
            /* housekeeping only — never fail a login over it */
        }

        return Boolean(consumed);
    }

    /** Generates N single-use backup codes. */
    static async issueBackupCodes({ userType, userId, count = 10 }) {
        const bcrypt = require('bcrypt');
        const codes = [];
        for (let i = 0; i < count; i++) {
            const plain = crypto.randomBytes(5).toString('hex'); // 10 hex chars
            codes.push(plain);
            const hash = await bcrypt.hash(plain, 10);
            await db.run(
                `INSERT INTO mfa_backup_codes (user_type, user_id, code_hash) VALUES (?, ?, ?)`,
                [userType, userId, hash]
            );
        }
        return codes;
    }

    static async consumeBackupCode({ userType, userId, code }) {
        const bcrypt = require('bcrypt');
        const rows = await db.all(
            `SELECT id, code_hash FROM mfa_backup_codes
             WHERE user_type = ? AND user_id = ? AND used_at IS NULL`,
            [userType, userId]
        );
        for (const r of rows) {
            if (await bcrypt.compare(code, r.codeHash)) {
                // Claim-then-trust (CQ-11): two concurrent logins with the same
                // code both passed the SELECT above; only the one whose UPDATE
                // actually flips used_at wins. A code is single-use, so the
                // loser is refused rather than trying the next row.
                const claim = await db.run(
                    `UPDATE mfa_backup_codes SET used_at = now() WHERE id = ? AND used_at IS NULL`,
                    [r.id]
                );
                return Boolean(claim && Number(claim.changes) === 1);
            }
        }
        return false;
    }
}

module.exports = MfaService;
module.exports.PRIVILEGED_ROLES = PRIVILEGED_ROLES;
