'use strict';
/* eslint-disable no-console */
/**
 * Rotate APP_KEY safely.
 *
 * APP_KEY encrypts two families of secrets with DIFFERENT derivations:
 *   - mfa_secrets.secret_enc (MfaService): v2 blobs ['MFA2'|iv|tag|ct] keyed by
 *     HKDF over the whole APP_KEY, and legacy v1 blobs [iv|tag|ct] keyed by
 *     APP_KEY[:32] (or SHA-256(SESSION_SECRET) when APP_KEY was short). Both
 *     are read; every one is written back as v2 under the NEW key.
 *   - secretBox values ('enc:v2:<purpose>:…', legacy 'enc:v1:…'), see
 *     src/utils/secretBox.js; every one is re-encrypted to v2 under the NEW key:
 *       · appSettings rows whose value is sealed (SSO client secrets and SAML
 *         certificates, SMTP password, AI provider key: any 'enc:' value)
 *       · lms_integrations.auth_config._enc and lms_integrations.webhook_secret
 *       · webhook_subscriptions.secret
 *       · safety_gate_settings.webhook_secret
 *       · hris_connectors.credentials
 *
 * Hot-swapping APP_KEY without re-encrypting would make every one of them
 * undecryptable. This script decrypts each with the OLD key and re-encrypts
 * with the NEW key, in ONE transaction, verifying each value before it is
 * written.
 *
 *   NEW_APP_KEY='<>=32 char key>' node scripts/rotate-app-key.js [--commit]
 *
 * Without --commit it runs a DRY RUN (re-encrypts in a transaction, verifies,
 * then ROLLS BACK) so you can confirm it works before the real rotation.
 * After a real run: set APP_KEY=<new> in .env and restart the service.
 */
const secretBox = require('../src/utils/secretBox');

/** MfaService's own primitives (the derivations live in ONE place). */
function mfaCrypto() {
    return require('../src/services/MfaService')._crypto;
}

/**
 * Re-encrypt one secretBox value from the OLD key set to the NEW APP_KEY and
 * verify the round-trip before handing it back. Clear/empty values give null
 * (nothing to rotate: the owner encrypts them on its next write).
 */
function rotateBoxValue(value, keys, purpose) {
    if (!secretBox.isEncrypted(value)) return null;
    const from = { appKey: keys.oldAppKey, sessionSecret: keys.sessionSecret };
    const plain = secretBox.decryptWithKeys(value, from);
    const out = secretBox.rotateValue(value, { from, toAppKey: keys.newAppKey, purpose });
    if (secretBox.decryptWithKeys(out, { appKey: keys.newAppKey, production: true }) !== plain)
        throw new Error('verify failed');
    return out;
}

/** Purpose label for a v1 value that carries none (a v2 value keeps its own). */
function settingPurpose(key) {
    let isSso = false;
    try {
        isSso = require('../src/utils/ssoSettingKeys').isSsoSettingKey(key);
    } catch (_) {
        isSso = /^sso\./.test(String(key || ''));
    }
    if (isSso) return 'sso';
    return require('../src/models/AppSettingsModel').isSecretKey(key) ? 'app_settings' : null;
}

/** Read every row of a table, or [] when the table does not exist (older schema). */
async function rowsOf(db, sql) {
    try {
        return (await db.all(sql)) || [];
    } catch (_) {
        return [];
    }
}

/**
 * Rotate every secretBox store. Runs INSIDE the caller's transaction; an
 * undecryptable value is skipped (counted, warned), a verify failure throws.
 * @returns {Promise<object>} per-store { done, skipped } counters
 */
async function rotateSecretBoxStores(db, keys, log = console) {
    const stats = {};
    const bump = (k, f) => {
        stats[k] = stats[k] || { done: 0, skipped: 0 };
        stats[k][f]++;
    };
    const one = async (store, label, value, purpose, write) => {
        if (!secretBox.isEncrypted(value)) return;
        let out;
        try {
            out = rotateBoxValue(value, keys, purpose);
        } catch (e) {
            if (e.message === 'verify failed') throw new Error(`${label} verify failed`);
            bump(store, 'skipped');
            log.warn(`  ${label}: cannot decrypt with current key (${e.message}), skipped`);
            return;
        }
        await write(out);
        bump(store, 'done');
    };

    // 1. App settings (SSO and every secret setting): any sealed value.
    const settings = await rowsOf(
        db,
        "SELECT id, settingKey, settingValue FROM appSettings WHERE settingValue LIKE 'enc:%'"
    );
    for (const r of settings) {
        await one(
            'appSettings',
            `setting ${r.settingKey}`,
            r.settingValue,
            settingPurpose(r.settingKey),
            (v) => db.run('UPDATE appSettings SET settingValue = ? WHERE id = ?', [v, r.id])
        );
    }

    // 2. LMS integrations: auth_config._enc and webhook_secret.
    const lms = await rowsOf(db, 'SELECT id, auth_config, webhook_secret FROM lms_integrations');
    for (const r of lms) {
        let ac = r.authConfig;
        if (typeof ac === 'string') {
            try {
                ac = JSON.parse(ac);
            } catch (_) {
                ac = null;
            }
        }
        if (ac && ac._enc)
            await one('lmsAuthConfig', `lms id=${r.id} auth_config`, ac._enc, 'lms', (v) =>
                db.run('UPDATE lms_integrations SET auth_config = ? WHERE id = ?', [
                    JSON.stringify({ ...ac, _enc: v }),
                    r.id,
                ])
            );
        await one(
            'lmsWebhookSecret',
            `lms id=${r.id} webhook_secret`,
            r.webhookSecret,
            'lms',
            (v) => db.run('UPDATE lms_integrations SET webhook_secret = ? WHERE id = ?', [v, r.id])
        );
    }

    // 3. Outbound webhook subscriptions.
    const subs = await rowsOf(db, 'SELECT id, secret FROM webhook_subscriptions');
    for (const r of subs) {
        await one('webhookSubscriptions', `webhook id=${r.id}`, r.secret, 'webhook', (v) =>
            db.run('UPDATE webhook_subscriptions SET secret = ? WHERE id = ?', [v, r.id])
        );
    }

    // 4. Safety gate outbound webhook.
    const gate = await rowsOf(db, 'SELECT id, webhook_secret FROM safety_gate_settings');
    for (const r of gate) {
        await one('safetyGate', `safety_gate id=${r.id}`, r.webhookSecret, 'safety_gate', (v) =>
            db.run('UPDATE safety_gate_settings SET webhook_secret = ? WHERE id = ?', [v, r.id])
        );
    }

    // 5. HRIS connectors (API credentials of the HRIS synchronisation).
    const hris = await rowsOf(db, 'SELECT id, credentials FROM hris_connectors');
    for (const r of hris) {
        await one('hrisConnectors', `hris_connector id=${r.id}`, r.credentials, 'hris', (v) =>
            db.run('UPDATE hris_connectors SET credentials = ? WHERE id = ?', [v, r.id])
        );
    }
    return stats;
}

/** Rotate the MFA secrets: read v2 or v1 under the old keys, write v2 under the new key. */
async function rotateMfa(db, keys, log = console) {
    const stats = { done: 0, skipped: 0 };
    const M = mfaCrypto();
    const oldIkm = keys.oldAppKey || keys.sessionSecret || 'dev-key';
    const from = {
        v2Key: M.v2KeyFrom(oldIkm),
        legacyKeys: M.legacyKeysFor(keys.oldAppKey, keys.sessionSecret),
    };
    const toKey = M.v2KeyFrom(keys.newAppKey);
    const mfaRows = await rowsOf(db, 'SELECT id, secret_enc FROM mfa_secrets');
    for (const r of mfaRows) {
        const blob = Buffer.isBuffer(r.secretEnc) ? r.secretEnc : Buffer.from(r.secretEnc);
        let plain;
        try {
            plain = M.decryptWithKeys(blob, from).secret;
        } catch (e) {
            stats.skipped++;
            log.warn(`  mfa id=${r.id}: cannot decrypt with current key (${e.message}), skipped`);
            continue;
        }
        const reb = M.encryptWithKey(toKey, plain);
        // verify the round-trip with the NEW key before persisting
        if (M.decryptWithKeys(reb, { v2Key: toKey, legacyKeys: [] }).secret !== plain)
            throw new Error(`mfa id=${r.id} verify failed`);
        await db.run('UPDATE mfa_secrets SET secret_enc = ? WHERE id = ?', [reb, r.id]);
        stats.done++;
    }
    return stats;
}

function summary(mfa, box) {
    const parts = [`${mfa.done} MFA secret(s) (${mfa.skipped} skipped)`];
    for (const [k, v] of Object.entries(box)) parts.push(`${v.done} ${k} (${v.skipped} skipped)`);
    return parts.join(', ');
}

async function main() {
    require('dotenv').config();
    const db = require('../src/config/database');
    const keys = {
        oldAppKey: process.env.APP_KEY || '',
        sessionSecret: process.env.SESSION_SECRET || '',
        newAppKey:
            process.env.NEW_APP_KEY ||
            process.argv.find((a) => a.startsWith('--new='))?.slice(6) ||
            '',
    };
    const COMMIT = process.argv.includes('--commit');

    if (!keys.newAppKey || secretBox.isWeakAppKey(keys.newAppKey)) {
        console.error(
            'ERROR: provide a strong NEW_APP_KEY (>=32 random chars, e.g. `openssl rand -hex 32`) via env NEW_APP_KEY=... or --new=...'
        );
        process.exit(2);
    }
    if (keys.newAppKey === keys.oldAppKey) {
        console.error('ERROR: new key equals current APP_KEY, nothing to do.');
        process.exit(2);
    }
    if (!keys.oldAppKey)
        console.warn(
            'WARN: current APP_KEY is empty: MFA/secretBox used the SESSION_SECRET fallback; rotating to a real APP_KEY.'
        );

    await db.connect();
    let mfa = { done: 0, skipped: 0 };
    let box = {};
    try {
        await db.runTransaction(async () => {
            mfa = await rotateMfa(db, keys);
            box = await rotateSecretBoxStores(db, keys);
            if (!COMMIT) {
                throw new Error('__DRYRUN_ROLLBACK__');
            }
        });
        console.log(`\n✓ COMMITTED. Re-encrypted ${summary(mfa, box)}.`);
        console.log('  NEXT: set APP_KEY to the new value in .env and restart the service.');
    } catch (e) {
        if (e.message === '__DRYRUN_ROLLBACK__') {
            console.log(`\n✓ DRY RUN OK (rolled back). Would re-encrypt ${summary(mfa, box)}.`);
            console.log('  Re-run with --commit to apply, then set APP_KEY in .env and restart.');
        } else {
            console.error('\n✗ ROTATION FAILED (rolled back):', e.message);
            await db.close().catch(() => {});
            process.exit(1);
        }
    }
    await db.close().catch(() => {});
}

if (require.main === module) main();

module.exports = { rotateSecretBoxStores, rotateMfa, rotateBoxValue };
