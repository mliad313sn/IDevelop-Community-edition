'use strict';
/* eslint-disable no-console */
/**
 * Rotate APP_KEY safely.
 *
 * APP_KEY encrypts two secret stores with DIFFERENT derivations:
 *   - mfa_secrets.secret_enc  (MfaService: AES-256-GCM, key = APP_KEY[:32] raw
 *                              when len>=32, else sha256(SESSION_SECRET||'dev-key');
 *                              blob = [iv(12)|tag(16)|ct] bytea)
 *   - lms_integrations.auth_config._enc (secretBox: AES-256-GCM, key =
 *                              sha256(APP_KEY||SESSION_SECRET); 'enc:v1:iv:tag:ct' b64)
 *   - appSettings 'sso.*' secrets (secretBox, same format — SSO client secrets
 *                              and the SAML IdP certificates, encrypted since the SSO facilitator, migration 145)
 *
 * Hot-swapping APP_KEY without re-encrypting would make every MFA secret and LMS
 * credential undecryptable. This script decrypts each with the OLD key and
 * re-encrypts with the NEW key, in ONE transaction, verifying before commit.
 *
 *   NEW_APP_KEY='<>=32 char key>' node scripts/rotate-app-key.js [--commit]
 *
 * Without --commit it runs a DRY RUN (re-encrypts in a transaction, verifies,
 * then ROLLS BACK) so you can confirm it works before the real rotation.
 * After a real run: set APP_KEY=<new> in .env and restart the service.
 */
require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/config/database');

const OLD_APP_KEY = process.env.APP_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const NEW_APP_KEY =
    process.env.NEW_APP_KEY || process.argv.find((a) => a.startsWith('--new='))?.slice(6) || '';
const COMMIT = process.argv.includes('--commit');

// --- key derivations (must match MfaService + secretBox exactly) -----------
function mfaKey(appKey) {
    if (appKey && appKey.length >= 32) return Buffer.from(appKey.slice(0, 32));
    return crypto
        .createHash('sha256')
        .update(SESSION_SECRET || 'dev-key')
        .digest();
}
function boxKey(appKey) {
    const secret = appKey || SESSION_SECRET || '';
    return crypto.createHash('sha256').update(secret).digest();
}

// --- MFA blob [iv|tag|ct] ---------------------------------------------------
function mfaDec(key, blob) {
    const iv = blob.slice(0, 12),
        tag = blob.slice(12, 28),
        ct = blob.slice(28);
    if (tag.length !== 16) throw new Error('rotate-app-key: bad MFA auth tag length');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function mfaEnc(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// --- secretBox 'enc:v1:iv:tag:ct' (base64) ----------------------------------
const PREFIX = 'enc:v1:';
function boxDec(key, value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // legacy clear
    const [ivB, tagB, ...ctRest] = value.slice(PREFIX.length).split(':');
    const tag = Buffer.from(tagB, 'base64');
    if (tag.length !== 16) throw new Error('rotate-app-key: bad secretBox auth tag length');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'), {
        authTagLength: 16,
    });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(ctRest.join(':'), 'base64')), d.final()]).toString(
        'utf8'
    );
}
function boxEnc(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return (
        PREFIX +
        [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
    );
}

(async () => {
    if (!NEW_APP_KEY || NEW_APP_KEY.length < 32) {
        console.error(
            'ERROR: provide NEW_APP_KEY (>=32 chars) via env NEW_APP_KEY=... or --new=...'
        );
        process.exit(2);
    }
    if (NEW_APP_KEY === OLD_APP_KEY) {
        console.error('ERROR: new key equals current APP_KEY — nothing to do.');
        process.exit(2);
    }
    if (!OLD_APP_KEY)
        console.warn(
            'WARN: current APP_KEY is empty — MFA/secretBox used the SESSION_SECRET fallback; rotating to a real APP_KEY.'
        );

    const oldMfa = mfaKey(OLD_APP_KEY),
        newMfa = mfaKey(NEW_APP_KEY);
    const oldBox = boxKey(OLD_APP_KEY),
        newBox = boxKey(NEW_APP_KEY);

    await db.connect();
    const stats = { mfa: 0, lms: 0, sso: 0, mfaSkipped: 0, lmsSkipped: 0, ssoSkipped: 0 };
    try {
        await db.runTransaction(async () => {
            // MFA secrets
            const mfaRows = await db.all('SELECT id, secret_enc FROM mfa_secrets');
            for (const r of mfaRows) {
                const blob = Buffer.isBuffer(r.secretEnc) ? r.secretEnc : Buffer.from(r.secretEnc);
                let plain;
                try {
                    plain = mfaDec(oldMfa, blob);
                } catch (e) {
                    stats.mfaSkipped++;
                    console.warn(
                        `  mfa id=${r.id}: cannot decrypt with current key (${e.message}) — skipped`
                    );
                    continue;
                }
                const reb = mfaEnc(newMfa, plain);
                // verify round-trip with the NEW key before persisting
                if (mfaDec(newMfa, reb) !== plain) throw new Error(`mfa id=${r.id} verify failed`);
                await db.run('UPDATE mfa_secrets SET secret_enc = ? WHERE id = ?', [reb, r.id]);
                stats.mfa++;
            }
            // LMS integration auth_config._enc
            const lmsRows = await db.all('SELECT id, auth_config FROM lms_integrations');
            for (const r of lmsRows) {
                const ac = r.authConfig;
                if (!ac || !ac._enc) {
                    stats.lmsSkipped++;
                    continue;
                }
                let plain;
                try {
                    plain = boxDec(oldBox, ac._enc);
                } catch (e) {
                    stats.lmsSkipped++;
                    console.warn(
                        `  lms id=${r.id}: cannot decrypt with current key (${e.message}) — skipped`
                    );
                    continue;
                }
                const reEnc = boxEnc(newBox, plain);
                if (boxDec(newBox, reEnc) !== plain)
                    throw new Error(`lms id=${r.id} verify failed`);
                await db.run('UPDATE lms_integrations SET auth_config = ? WHERE id = ?', [
                    JSON.stringify({ _enc: reEnc }),
                    r.id,
                ]);
                stats.lms++;
            }
            // SSO secrets in appSettings (only the encrypted ones; clear legacy
            // values are left for the next settings save to encrypt).
            const ssoRows = await db.all(
                "SELECT id, settingKey, settingValue FROM appSettings WHERE settingKey LIKE 'sso.%' AND settingValue LIKE 'enc:v1:%'"
            );
            for (const r of ssoRows) {
                let plain;
                try {
                    plain = boxDec(oldBox, r.settingValue);
                } catch (e) {
                    stats.ssoSkipped++;
                    console.warn(
                        `  sso ${r.settingKey}: cannot decrypt with current key (${e.message}) — skipped`
                    );
                    continue;
                }
                const reEnc = boxEnc(newBox, plain);
                if (boxDec(newBox, reEnc) !== plain)
                    throw new Error(`sso ${r.settingKey} verify failed`);
                await db.run('UPDATE appSettings SET settingValue = ? WHERE id = ?', [reEnc, r.id]);
                stats.sso++;
            }
            if (!COMMIT) {
                throw new Error('__DRYRUN_ROLLBACK__');
            }
        });
        console.log(
            `\n✓ COMMITTED. Re-encrypted ${stats.mfa} MFA secret(s), ${stats.lms} LMS credential(s), ${stats.sso} SSO secret(s).`
        );
        console.log('  NEXT: set APP_KEY to the new value in .env and restart the service:');
        console.log(`        APP_KEY=${NEW_APP_KEY}`);
    } catch (e) {
        if (e.message === '__DRYRUN_ROLLBACK__') {
            console.log(
                `\n✓ DRY RUN OK (rolled back). Would re-encrypt ${stats.mfa} MFA secret(s) (${stats.mfaSkipped} skipped), ${stats.lms} LMS credential(s) (${stats.lmsSkipped} skipped), ${stats.sso} SSO secret(s) (${stats.ssoSkipped} skipped).`
            );
            console.log('  Re-run with --commit to apply, then set APP_KEY in .env and restart.');
        } else {
            console.error('\n✗ ROTATION FAILED (rolled back):', e.message);
            await db.close().catch(() => {});
            process.exit(1);
        }
    }
    await db.close().catch(() => {});
})();
