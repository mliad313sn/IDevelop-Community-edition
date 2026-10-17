'use strict';

/**
 * The LMS completion webhook as a machine credential for the origin guard.
 *
 * The public LMS webhook (POST /integrations/lms/:provider/webhook) is a
 * server-to-server JSON call with no Origin, so the global origin guard refused
 * it (403 origin_required) before the route could check its secret: no real LMS
 * could deliver a completion. Its per-provider secret, sent in
 * `X-Webhook-Secret`, now stands in for the Origin, but ONLY once it validates
 * against the stored secret (LmsService.verifyWebhookSecret). The route checks
 * it again before ingesting anything.
 *
 * @param {object} req  Express request (uses req.path and the header)
 * @param {(provider: string, secret: string) => Promise<boolean>} [verify]
 * @returns {Promise<boolean|null>}
 *   null:  not the LMS webhook path, the caller applies its other credentials;
 *   true:  the provider's secret validated;
 *   false: LMS webhook path, but the secret is missing, wrong or unverifiable.
 *   On the webhook path the secret is the only machine credential that counts.
 */
const LMS_WEBHOOK_PATH = /^\/integrations\/lms\/([^/]+)\/webhook\/?$/;
const SECRET_HEADER = 'x-webhook-secret';

function defaultVerify(provider, secret) {
    return require('../services/LmsService').verifyWebhookSecret(provider, secret);
}

function headerOf(req, name) {
    if (typeof req.get === 'function') return req.get(name);
    const h = req.headers || {};
    return h[name];
}

async function lmsWebhookCredential(req, verify = defaultVerify) {
    const m = LMS_WEBHOOK_PATH.exec((req && req.path) || '');
    if (!m) return null;
    const secret = headerOf(req, SECRET_HEADER);
    if (!secret || typeof secret !== 'string') return false;
    try {
        return (await verify(String(m[1]).toLowerCase(), secret)) === true;
    } catch (_) {
        return false;
    }
}

module.exports = { lmsWebhookCredential, LMS_WEBHOOK_PATH, SECRET_HEADER };
