'use strict';

/**
 * LTI 1.3 Platform endpoints (public). IDevelop acts as the Platform that
 * launches an LMS Tool course with the user's identity:
 *   1. /v2/lms/lti/:provider/launch (authed)  → redirect to the Tool's OIDC init
 *   2. GET /lti/:provider/auth      (public)  → return the signed id_token form
 *   3. GET /.well-known/lms-jwks.json (public)→ the Platform's public keys
 *
 * The authorization endpoint uses GET (OIDC query params) so it never collides
 * with csurf, and the auto-POST it returns targets the Tool (not us).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const ah = require('../utils/asyncHandler');

function gated(res) {
    if (process.env.V2_FEATURES !== '1') {
        res.status(404).end();
        return true;
    }
    return false;
}

function esc(s) {
    return String(s == null ? '' : s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

// --- JWKS: expose the LTI provider's public key(s) -------------------------
router.get(
    '/.well-known/lms-jwks.json',
    ah(async (req, res) => {
        if (gated(res)) return;
        const db = require('../config/database');
        const LmsService = require('../services/LmsService');
        const keys = [];
        const rows = await db.all(
            "SELECT provider, auth_config FROM lms_integrations WHERE provider = 'lti' AND enabled = true"
        );
        for (const r of rows) {
            const auth = LmsService._decryptAuth(r.authConfig);
            if (!auth.public_key) continue;
            try {
                const jwk = crypto.createPublicKey(auth.public_key).export({ format: 'jwk' });
                keys.push({ ...jwk, use: 'sig', alg: 'RS256', kid: auth.kid || 'lti-1' });
            } catch (_) {
                /* skip malformed key */
            }
        }
        res.json({ keys });
    })
);

// --- Authorization endpoint: return the signed LtiResourceLinkRequest -------
router.get(
    '/lti/:provider/auth',
    ah(async (req, res) => {
        if (gated(res)) return;
        // SECURITY: the Platform asserts the identity of the AUTHENTICATED user, never an
        // identity echoed from the query. Without this, anyone could mint a Platform-signed
        // id_token for an arbitrary email (login_hint) and replay it to impersonate that user
        // in the downstream LMS. Require a live IDevelop session and derive the identity from it.
        if (!req.user)
            return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
        const db = require('../config/database');
        let identityEmail = null;
        let identityId = null;
        if (req.user.userType === 'admin') {
            const a = await db.get('SELECT id, email FROM admins WHERE id = ?', [
                Number(req.user.id),
            ]);
            if (a) {
                identityEmail = a.email;
                identityId = 'admin:' + a.id;
            }
        } else {
            const e = await db.get('SELECT id, email FROM employees WHERE id = ?', [
                Number(req.user.id),
            ]);
            if (e) {
                identityEmail = e.email;
                identityId = String(e.id);
            }
        }
        if (!identityEmail)
            return res.status(400).send('The signed-in account has no email for an LTI launch');

        const LmsService = require('../services/LmsService');
        const { lti_message_hint: courseRef, nonce, state, redirect_uri: redirectUri } = req.query;
        if (!redirectUri) return res.status(400).send('redirect_uri required');
        let launch;
        try {
            const { connector } = await LmsService._getConnectorFor(req.params.provider);
            if (typeof connector.buildLaunch !== 'function')
                return res.status(400).send('provider is not an LTI tool');
            // Validate redirect_uri so a signed identity token can never be POSTed to
            // an attacker-controlled URL. Prefer an explicit allow-list; otherwise
            // require the same origin as the configured tool base_url.
            const auth = connector.authConfig || {};
            let allowed = false;
            if (Array.isArray(auth.redirect_uris) && auth.redirect_uris.length) {
                allowed = auth.redirect_uris.includes(redirectUri);
            } else {
                try {
                    allowed = new URL(redirectUri).origin === new URL(connector.base()).origin;
                } catch {
                    allowed = false;
                }
            }
            if (!allowed)
                return res.status(400).send('redirect_uri is not registered for this tool');
            // Per OIDC/LTI 1.3 the Tool supplies the nonce and the Platform echoes it
            // back in the id_token; the Tool stores it for replay protection.
            launch = connector.buildLaunch({ email: identityEmail, id: identityId }, courseRef, {
                nonce,
                state,
            });
        } catch (e) {
            return res.status(400).send('LTI launch error: ' + esc(e.message));
        }

        // Auto-submitting form POSTs the id_token to the Tool's redirect_uri.
        res.set('Content-Type', 'text/html').send(
            `<!doctype html><html><body onload="document.forms[0].submit()">
         <form method="post" action="${esc(redirectUri)}">
           <input type="hidden" name="id_token" value="${esc(launch.idToken)}">
           <input type="hidden" name="state" value="${esc(launch.state)}">
         </form><noscript><button type="submit">Continue</button></noscript></body></html>`
        );
    })
);

module.exports = router;
