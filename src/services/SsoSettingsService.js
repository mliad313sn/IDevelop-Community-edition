'use strict';
/**
 * SSO settings bridge between the in-app Settings UI and the passport strategy
 * layer (config/sso.js).
 *
 * Stores each SSO config value in the `app_settings` table under category 'sso'
 * (so it is backed up/audited like every other setting), keyed `sso.<provider>.<field>`.
 * The strategy layer reads config by env-var name, so this service maps each DB
 * key to its env-var name: a non-empty DB value overrides the matching env var,
 * and a blank DB value falls back to env (.env). That mirrors the SMTP-settings
 * pattern (UI value wins; .env is the fallback) — see EmailService.
 *
 * Secrets (client secrets, SAML cert) are write-only in the UI: stored values are
 * never sent back to the browser, and a blank submission means "leave unchanged".
 *
 * @module services/SsoSettingsService
 */
const AppSettingsModel = require('../models/AppSettingsModel');
const secretBox = require('../utils/secretBox');

// Secrets are stored ENCRYPTED (secretBox, keyed on APP_KEY) — they used to be
// masked in the UI but written in clear to app_settings, where every backup and
// the SQL console could read them. A legacy clear value still reads (decrypt
// passes non-prefixed strings through) and is re-encrypted on the next save.
const _warned = new Set();
function readSecret(v, name) {
    if (v === null || v === undefined) return v;
    try {
        return secretBox.decrypt(String(v));
    } catch (_) {
        if (name && !_warned.has(name)) {
            _warned.add(name);
            console.warn(
                `[security] SSO setting ${name} is stored encrypted but cannot be decrypted (APP_KEY/SESSION_SECRET changed?). ` +
                    'The provider is disabled until it is re-entered in Settings > Single Sign-On, or rotate-app-key.js is run with the old key.'
            );
        }
        return null; // key changed: treated as unset rather than crashing the page
    }
}

/** Stored (non-empty) but undecryptable — distinct from "never set". */
function isUndecryptable(v) {
    return (
        v !== null && v !== undefined && String(v).startsWith('enc:v1:') && readSecret(v) === null
    );
}

const CATEGORY = 'sso';
const ENABLED = { db: 'sso.enabled', env: 'SSO_ENABLED' };

// UI-driving schema: order here is the render order. `secret:true` => masked.
const PROVIDERS = [
    {
        key: 'entra',
        label: 'Microsoft Entra ID (Azure AD)',
        icon: 'fab fa-microsoft',
        callbackHint: '/auth/sso/entra/callback',
        fields: [
            {
                name: 'tenantId',
                db: 'sso.entra.tenantId',
                env: 'AZURE_TENANT_ID',
                label: 'Directory (tenant) ID',
            },
            {
                name: 'clientId',
                db: 'sso.entra.clientId',
                env: 'AZURE_CLIENT_ID',
                label: 'Application (client) ID',
            },
            {
                name: 'clientSecret',
                db: 'sso.entra.clientSecret',
                env: 'AZURE_CLIENT_SECRET',
                label: 'Client secret',
                secret: true,
            },
            {
                name: 'redirectUrl',
                db: 'sso.entra.redirectUrl',
                env: 'SSO_ENTRA_REDIRECT_URL',
                label: 'Redirect URL',
                placeholder: 'https://your-host/auth/sso/entra/callback',
            },
            {
                name: 'label',
                db: 'sso.entra.label',
                env: 'SSO_ENTRA_LABEL',
                label: 'Button label',
                placeholder: 'Sign in with Microsoft',
            },
        ],
    },
    {
        key: 'oidc',
        label: 'Generic OpenID Connect (Okta, Auth0, Keycloak…)',
        icon: 'fab fa-openid',
        callbackHint: '/auth/sso/oidc/callback',
        fields: [
            { name: 'issuer', db: 'sso.oidc.issuer', env: 'OIDC_ISSUER', label: 'Issuer' },
            {
                name: 'authUrl',
                db: 'sso.oidc.authUrl',
                env: 'OIDC_AUTH_URL',
                label: 'Authorization URL',
            },
            {
                name: 'tokenUrl',
                db: 'sso.oidc.tokenUrl',
                env: 'OIDC_TOKEN_URL',
                label: 'Token URL',
            },
            {
                name: 'userInfoUrl',
                db: 'sso.oidc.userInfoUrl',
                env: 'OIDC_USERINFO_URL',
                label: 'UserInfo URL',
            },
            {
                name: 'clientId',
                db: 'sso.oidc.clientId',
                env: 'OIDC_CLIENT_ID',
                label: 'Client ID',
            },
            {
                name: 'clientSecret',
                db: 'sso.oidc.clientSecret',
                env: 'OIDC_CLIENT_SECRET',
                label: 'Client secret',
                secret: true,
            },
            {
                name: 'redirectUrl',
                db: 'sso.oidc.redirectUrl',
                env: 'OIDC_REDIRECT_URL',
                label: 'Redirect URL',
                placeholder: 'https://your-host/auth/sso/oidc/callback',
            },
            {
                name: 'scope',
                db: 'sso.oidc.scope',
                env: 'OIDC_SCOPE',
                label: 'Scopes',
                placeholder: 'openid profile email',
            },
            {
                name: 'label',
                db: 'sso.oidc.label',
                env: 'OIDC_LABEL',
                label: 'Button label',
                placeholder: 'Sign in with SSO',
            },
        ],
    },
    {
        key: 'saml',
        label: 'SAML 2.0 (ADFS, Shibboleth…)',
        icon: 'fas fa-key',
        callbackHint: '/auth/sso/saml/callback',
        fields: [
            {
                name: 'entryPoint',
                db: 'sso.saml.entryPoint',
                env: 'SAML_ENTRY_POINT',
                label: 'IdP SSO URL (entry point)',
            },
            {
                name: 'issuer',
                db: 'sso.saml.issuer',
                env: 'SAML_ISSUER',
                label: 'SP entity ID (issuer)',
                placeholder: 'https://your-host/saml/metadata',
            },
            {
                name: 'callbackUrl',
                db: 'sso.saml.callbackUrl',
                env: 'SAML_CALLBACK_URL',
                label: 'ACS / callback URL',
                placeholder: 'https://your-host/auth/sso/saml/callback',
            },
            {
                name: 'idpCert',
                db: 'sso.saml.idpCert',
                env: 'SAML_IDP_CERT',
                label: 'IdP signing certificate (PEM body)',
                secret: true,
                multiline: true,
            },
            // Filled by the metadata import (SSO facilitator, phase 1).
            {
                name: 'idpIssuer',
                db: 'sso.saml.idpIssuer',
                env: 'SAML_IDP_ISSUER',
                label: 'IdP entity ID (issuer)',
                placeholder: 'https://sts.windows.net/<tenant-id>/',
                // Written by the metadata import: a blank post (a form rendered before
                // the import) must not silently remove the issuer check.
                keepIfBlank: true,
            },
            {
                name: 'metadataUrl',
                db: 'sso.saml.metadataUrl',
                env: 'SAML_METADATA_URL',
                label: 'IdP federation metadata URL',
                placeholder:
                    'https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=<app-id>',
                keepIfBlank: true,
            },
            // Off by default: unsolicited (IdP-initiated) responses are refused unless allowed.
            {
                name: 'idpInitiated',
                db: 'sso.saml.idpInitiated',
                env: 'SAML_IDP_INITIATED',
                label: 'Allow sign-in launched from the IdP portal (My Apps / Okta dashboard)',
                bool: true,
            },
            {
                name: 'label',
                db: 'sso.saml.label',
                env: 'SAML_LABEL',
                label: 'Button label',
                placeholder: 'Sign in with SAML',
            },
        ],
    },
    {
        key: 'google',
        label: 'Google Workspace',
        icon: 'fab fa-google',
        callbackHint: '/auth/sso/google/callback',
        fields: [
            {
                name: 'clientId',
                db: 'sso.google.clientId',
                env: 'GOOGLE_CLIENT_ID',
                label: 'Client ID',
            },
            {
                name: 'clientSecret',
                db: 'sso.google.clientSecret',
                env: 'GOOGLE_CLIENT_SECRET',
                label: 'Client secret',
                secret: true,
            },
            {
                name: 'redirectUrl',
                db: 'sso.google.redirectUrl',
                env: 'GOOGLE_REDIRECT_URL',
                label: 'Redirect URL',
                placeholder: 'https://your-host/auth/sso/google/callback',
            },
            {
                name: 'hd',
                db: 'sso.google.hd',
                env: 'GOOGLE_HD',
                label: 'Restrict to Workspace domain (optional)',
                placeholder: 'example.com',
            },
            {
                name: 'label',
                db: 'sso.google.label',
                env: 'GOOGLE_LABEL',
                label: 'Button label',
                placeholder: 'Sign in with Google',
            },
        ],
    },
];

function allFields() {
    const out = [];
    for (const p of PROVIDERS) for (const f of p.fields) out.push(f);
    return out;
}

function truthy(v) {
    const s = String(v == null ? '' : v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Build the env-var-keyed override map for config/sso.js. Only includes values
 * actually set in the DB; everything else falls back to process.env there.
 */
async function getOverrides() {
    const ov = {};
    const enabled = await AppSettingsModel.getValue(ENABLED.db, null);
    if (enabled !== null && enabled !== undefined && String(enabled) !== '') {
        ov[ENABLED.env] = enabled === true || truthy(enabled) ? '1' : '0';
    }
    for (const f of allFields()) {
        let v = await AppSettingsModel.getValue(f.db, null);
        if (f.secret) {
            // An undecryptable stored secret NEVER falls back to .env (an older,
            // possibly retired value): the provider stays unconfigured.
            if (isUndecryptable(v)) {
                readSecret(v, f.db); // one warning naming the setting
                (ov.__undecryptable = ov.__undecryptable || []).push(f.env);
                continue;
            }
            v = readSecret(v);
        }
        if (f.bool) {
            if (v !== null && v !== undefined && String(v) !== '')
                ov[f.env] = v === true || truthy(v) ? '1' : '0';
            continue;
        }
        if (v !== null && v !== undefined && String(v).trim() !== '') ov[f.env] = String(v);
    }
    return ov;
}

/**
 * this file is STRUCTURE-ONLY and deliberately English, like
 * config/permissions.js — the FR/EN wording lives in locales/{fr,en}/admin.json
 * under `sso_f_<field>` (or `sso_f_<provider>_<field>` where two providers give
 * the same field name a different meaning), with the English `label` below as
 * the view's defaultValue so a field added later still renders.
 */
const SSO_FIELD_KEY_OVERRIDES = { 'saml.issuer': 'sso_f_saml_issuer' };
function labelKeyFor(providerKey, fieldName) {
    return SSO_FIELD_KEY_OVERRIDES[`${providerKey}.${fieldName}`] || `sso_f_${fieldName}`;
}

/**
 * View model for the settings page: effective (DB-or-env) values for non-secret
 * fields, a boolean "isSet" for secrets, a "fromEnv" flag where the value is
 * currently coming from .env (not the UI), and which providers are live now.
 */
async function getFormModel() {
    const sso = require('../config/sso');
    const liveKeys = new Set(sso.getEnabledProviders().map((p) => p.key));

    const dbEnabled = await AppSettingsModel.getValue(ENABLED.db, null);
    const enabledFromEnv =
        dbEnabled === null || dbEnabled === undefined || String(dbEnabled) === '';
    const enabled = enabledFromEnv
        ? truthy(process.env[ENABLED.env])
        : dbEnabled === true || truthy(dbEnabled);

    const providers = [];
    for (const p of PROVIDERS) {
        const fields = [];
        for (const f of p.fields) {
            const dbVal = await AppSettingsModel.getValue(f.db, null);
            const hasDb = dbVal !== null && dbVal !== undefined && String(dbVal).trim() !== '';
            const envVal = (process.env[f.env] || '').trim();
            if (f.bool) {
                const on = hasDb ? dbVal === true || truthy(dbVal) : truthy(envVal);
                fields.push({
                    name: f.name,
                    label: f.label,
                    labelKey: labelKeyFor(p.key, f.name),
                    bool: true,
                    checked: on,
                    fromEnv: !hasDb && !!envVal,
                });
            } else if (f.secret) {
                fields.push({
                    name: f.name,
                    label: f.label,
                    labelKey: labelKeyFor(p.key, f.name),
                    secret: true,
                    multiline: !!f.multiline,
                    placeholder: f.placeholder || '',
                    isSet: (hasDb && !isUndecryptable(dbVal)) || (!hasDb && !!envVal),
                    undecryptable: hasDb && isUndecryptable(dbVal),
                    fromEnv: !hasDb && !!envVal,
                });
            } else {
                fields.push({
                    name: f.name,
                    label: f.label,
                    labelKey: labelKeyFor(p.key, f.name),
                    multiline: !!f.multiline,
                    placeholder: f.placeholder || '',
                    value: hasDb ? String(dbVal) : envVal,
                    fromEnv: !hasDb && !!envVal,
                });
            }
        }
        providers.push({
            key: p.key,
            label: p.label,
            labelKey: `sso_p_${p.key}`,
            icon: p.icon,
            callbackHint: p.callbackHint,
            active: liveKeys.has(p.key),
            // UX-1: the test sign-in also works on a SAVED connection while the
            // master switch is off (registered for the test only).
            testable:
                liveKeys.has(p.key) ||
                !!(typeof sso.getTestProvider === 'function' && sso.getTestProvider(p.key)),
            fields,
        });
    }
    // Kept in the model for compatibility; no longer shown (UX-2).
    const ssoOnly = truthy(await AppSettingsModel.getValue('ssoDisablesLocalPassword', false));
    // ANN (3.23.21): the planned go-live and the announcement counters.
    let announcement = null;
    try {
        announcement = await require('./SsoInviteService').announcementStatus();
    } catch (_) {
        announcement = null;
    }
    // 3.23.19 (amendment A5): SSO is enforced while a provider is enabled — the
    // readiness report lists who would have no way in. Never blocks the page.
    let readiness = null;
    try {
        readiness = await require('./AdminSsoService').readiness();
    } catch (e) {
        console.warn(`[sso] readiness report unavailable: ${e.message}`);
        readiness = null;
    }
    // the operator's extra multi-factor acr / AuthnContextClassRef values.
    const mfaAcrValues = String((await AppSettingsModel.getValue('sso.mfaAcrValues', '')) || '');
    // C3e/C3h (3.23.20): who to contact for a sign-in problem (login page + invitation).
    const helpContact = String((await AppSettingsModel.getValue('sso.helpContact', '')) || '');
    return {
        enabled,
        enabledFromEnv,
        providers,
        ssoOnly,
        readiness,
        mfaAcrValues,
        helpContact,
        announcement,
        saml: await samlModel(),
    };
}

/** Effective (DB-or-env) value of one field, secrets decrypted. */
async function effective(dbKey, envKey, secret) {
    let v = await AppSettingsModel.getValue(dbKey, null);
    if (secret && isUndecryptable(v)) return ''; // never the .env fallback (see getOverrides)
    if (secret) v = readSecret(v);
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v);
    return (process.env[envKey] || '').trim();
}

/**
 * The SAML facts the "connect your identity provider" panel shows: what is
 * configured (issuer, callback), the IdP certificates currently trusted with
 * their fingerprint and expiry, and the IdP-initiated switch.
 */
async function samlModel() {
    const Md = require('./SamlMetadataService');
    const cert = await effective('sso.saml.idpCert', 'SAML_IDP_CERT', true);
    return {
        issuer: await effective('sso.saml.issuer', 'SAML_ISSUER'),
        callbackUrl: await effective('sso.saml.callbackUrl', 'SAML_CALLBACK_URL'),
        entryPoint: await effective('sso.saml.entryPoint', 'SAML_ENTRY_POINT'),
        idpIssuer: await effective('sso.saml.idpIssuer', 'SAML_IDP_ISSUER'),
        metadataUrl: await effective('sso.saml.metadataUrl', 'SAML_METADATA_URL'),
        certs: Md.splitCerts(cert)
            .map(Md.describeCert)
            .map((c) => ({ sha256: c.sha256, notAfter: c.notAfter, subject: c.subject })),
    };
}

/**
 * Apply parsed IdP metadata: SSO URL, IdP issuer, EVERY signing certificate
 * (rollover-safe), the metadata URL; and our own Entity ID / ACS URL when they
 * were never set (derived from the trusted base URL — the values the IdP admin
 * was told to paste).
 */
async function applyMetadata({ parsed, metadataUrl, base }, adminId) {
    const Md = require('./SamlMetadataService');
    const set = (key, value, desc, secret) =>
        AppSettingsModel.setValue(
            key,
            secret ? secretBox.encrypt(value) : value,
            'string',
            desc,
            CATEGORY,
            adminId
        );
    await set('sso.saml.entryPoint', parsed.ssoUrl, 'SSO saml entryPoint (from metadata)');
    await set('sso.saml.idpIssuer', parsed.entityId, 'SSO saml idpIssuer (from metadata)');
    await set(
        'sso.saml.idpCert',
        parsed.certs.map((c) => Md.toPem(c.body)).join('\n'),
        'SSO saml idpCert (from metadata)',
        true
    );
    if (metadataUrl) await set('sso.saml.metadataUrl', String(metadataUrl), 'SSO saml metadataUrl');
    const sp = Md.spValues(base);
    if (!(await effective('sso.saml.issuer', 'SAML_ISSUER')))
        await set('sso.saml.issuer', sp.entityId, 'SSO saml issuer (SP entity ID)');
    if (!(await effective('sso.saml.callbackUrl', 'SAML_CALLBACK_URL')))
        await set('sso.saml.callbackUrl', sp.acsUrl, 'SSO saml callbackUrl (ACS)');
}

/**
 * N3 (3.23.19) — the operator's extra multi-factor acr / AuthnContextClassRef
 * values. Accepted: a URI (scheme:…, e.g. urn:…, https://…) or an explicit name
 * (at least 3 characters, at least one letter, no spaces), up to 20 values of
 * 300 characters. Refused: bare numbers ('0', '1', '2' — Entra v1 puts acr "1"
 * on EVERY non-anonymous sign-in, so listing it would make every admin sign-in
 * count as MFA), and anything shorter or with spaces.
 * @returns {{ok:boolean, values:string[], bad:string[]}}
 */
function validateMfaAcrValues(raw) {
    const items = String(raw == null ? '' : raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const bad = [];
    const values = [];
    for (const s of items) {
        const isUri = /^[a-z][a-z0-9+.-]*:\S+$/i.test(s);
        const isName = /^[^\s,]{3,}$/.test(s) && /[a-z]/i.test(s);
        // the same "never MFA" rule as on read (digits only, password refs).
        const weak = require('./AdminSsoService').isWeakAcrValue(s);
        if (s.length > 300 || weak || !(isUri || isName)) bad.push(s);
        else values.push(s);
    }
    if (values.length > 20) bad.push(...values.splice(20));
    return { ok: bad.length === 0, values, bad };
}

/** The master switch as stored (DB value, else .env). */
async function isSwitchOn() {
    const v = await AppSettingsModel.getValue(ENABLED.db, null);
    if (v === null || v === undefined || String(v) === '') return truthy(process.env[ENABLED.env]);
    return v === true || truthy(v);
}

/**
 * Persist a settings-form submission. Body shape: `enabled` (checkbox) plus
 * `<provider>.<field>` keys (e.g. `entra.tenantId`). Blank secret = unchanged.
 */
async function save(body, adminId) {
    // validate BEFORE writing anything — a refused form changes nothing.
    if (body.mfaAcrValues !== undefined) {
        const pre = validateMfaAcrValues(body.mfaAcrValues);
        if (!pre.ok) {
            const err = new Error(`invalid sso.mfaAcrValues: ${pre.bad.join(', ')}`);
            err.code = 'sso_mfa_acr_invalid';
            err.bad = pre.bad;
            throw err;
        }
    }
    // ANN (3.23.21): the planned go-live — validated before anything is written.
    let goLive = null;
    if (body.goLiveAt !== undefined) {
        const raw = String(body.goLiveAt == null ? '' : body.goLiveAt).trim();
        const Inv = require('./SsoInviteService');
        if (raw && !Inv.parseGoLive(raw)) {
            const err = new Error(`invalid sso.goLiveAt: ${raw.slice(0, 40)}`);
            err.code = 'sso_golive_invalid';
            throw err;
        }
        goLive = raw.replace(' ', 'T');
    }
    // UX-1 (3.23.21): switching SSO ON (from off) makes sign-in SSO-only for
    // everyone but the super administrator — it is a decision taken knowingly.
    // EVERY save that turns the switch on must carry the explicit confirmation of
    // the readiness count, or nothing is saved (this service is the only writer
    // of the switch: the generic settings handler and imports refuse SSO keys).
    const wasOn = await isSwitchOn();
    if (truthy(body.enabled) && !wasOn && !truthy(body.confirmEnforce)) {
        const err = new Error('switching SSO on needs the readiness confirmation');
        err.code = 'sso_enable_confirm_required';
        throw err;
    }
    await AppSettingsModel.setValue(
        ENABLED.db,
        truthy(body.enabled),
        'boolean',
        'Master SSO switch',
        CATEGORY,
        adminId
    );
    // UX-2 (3.23.21): 'ssoDisablesLocalPassword' is no longer on the form and is
    // no longer written here — the stored value is kept as it is (inert for SSO
    // exceptions, whose password is never switched off).
    if (goLive !== null) {
        await AppSettingsModel.setValue(
            'sso.goLiveAt',
            goLive,
            'string',
            'Planned SSO go-live (local date and time).',
            CATEGORY,
            adminId
        );
    }
    if (body.announceLeadHours !== undefined && String(body.announceLeadHours).trim() !== '') {
        await AppSettingsModel.setValue(
            'sso.announceLeadHours',
            require('./SsoInviteService').clampLeadHours(body.announceLeadHours),
            'number',
            'Hours before the planned SSO go-live when the announcement is sent (24-168).',
            CATEGORY,
            adminId
        );
    }
    // S6 (3.23.19): written only when the form carries the field; N3: a list with
    // one invalid value (a bare number such as Entra v1's acr "1", which every
    // sign-in carries) is refused as a whole — never silently trimmed.
    if (body.mfaAcrValues !== undefined) {
        const v = validateMfaAcrValues(body.mfaAcrValues);
        if (!v.ok) {
            const err = new Error(`invalid sso.mfaAcrValues: ${v.bad.join(', ')}`);
            err.code = 'sso_mfa_acr_invalid';
            err.bad = v.bad;
            throw err;
        }
        const list = v.values.join(', ');
        await AppSettingsModel.setValue(
            'sso.mfaAcrValues',
            list,
            'string',
            'Optional comma-separated acr / AuthnContextClassRef values your IdP uses for a multi-factor sign-in.',
            CATEGORY,
            adminId
        );
    }
    // C3e/C3h (3.23.20): the help contact — plain text, one line, 200 characters.
    if (body.helpContact !== undefined) {
        const contact = String(body.helpContact == null ? '' : body.helpContact)
            .replace(/[\u0000-\u001F\u007F]+/g, ' ') // eslint-disable-line no-control-regex
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        await AppSettingsModel.setValue(
            'sso.helpContact',
            contact,
            'string',
            'Who to contact for a sign-in problem (login page and SSO migration invitation).',
            CATEGORY,
            adminId
        );
    }
    for (const p of PROVIDERS) {
        for (const f of p.fields) {
            const formName = `${p.key}.${f.name}`;
            const raw = body[formName];
            if (f.bool) {
                await AppSettingsModel.setValue(
                    f.db,
                    truthy(raw),
                    'boolean',
                    `SSO ${p.key} ${f.name}`,
                    CATEGORY,
                    adminId
                );
            } else if (f.secret) {
                // Blank/absent => leave the stored secret untouched.
                if (raw === undefined || String(raw).trim() === '') continue;
                await AppSettingsModel.setValue(
                    f.db,
                    secretBox.encrypt(String(raw)),
                    'string',
                    `SSO ${p.key} ${f.name}`,
                    CATEGORY,
                    adminId
                );
            } else if (f.keepIfBlank && (raw === undefined || String(raw).trim() === '')) {
                continue;
            } else {
                // Store (possibly empty => clears the override, falling back to env).
                await AppSettingsModel.setValue(
                    f.db,
                    raw === undefined ? '' : String(raw),
                    'string',
                    `SSO ${p.key} ${f.name}`,
                    CATEGORY,
                    adminId
                );
            }
        }
    }
}

module.exports = {
    getOverrides,
    getFormModel,
    save,
    applyMetadata,
    samlModel,
    effective,
    readSecret,
    validateMfaAcrValues,
    isUndecryptable,
    PROVIDERS,
    ENABLED,
    CATEGORY,
};
