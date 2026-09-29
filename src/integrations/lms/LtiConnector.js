'use strict';

const crypto = require('crypto');
const LmsConnector = require('./LmsConnector');
const { signRS256 } = require('./jwt');

/**
 * LtiConnector — LTI 1.3 Resource Link launch (Phase 4). IDevelop acts as the
 * Platform: it issues a signed `id_token` (RS256) so the LMS Tool launches the
 * mapped course with the user's identity — no separate LMS login.
 *
 * auth_config: { client_id, deployment_id, private_key (PEM), kid,
 *                login_url, target_link_uri, roles[] }
 */
class LtiConnector extends LmsConnector {
    get provider() {
        return 'lti';
    }

    /** OIDC third-party login-initiation URL (step 1 of the launch). */
    getLaunchUrl(employee, courseRef) {
        if (!this.base()) return null;
        const a = this.authConfig;
        const u = new URL(a.login_url || this.base() + '/lti/login');
        u.searchParams.set('iss', this.config.issuer || this.base());
        if (a.client_id) u.searchParams.set('client_id', a.client_id);
        u.searchParams.set(
            'login_hint',
            LmsConnector.str(employee && (employee.email || employee.id)) || ''
        );
        u.searchParams.set('target_link_uri', a.target_link_uri || this.base() + '/lti/launch');
        if (courseRef) u.searchParams.set('lti_message_hint', LmsConnector.str(courseRef));
        return u.toString();
    }

    /**
     * Build the signed LtiResourceLinkRequest id_token (step 3 of the launch).
     * Returns { idToken, state, nonce } ready to auto-POST to target_link_uri.
     */
    buildLaunch(employee, courseRef, { nonce, state, now } = {}) {
        const a = this.authConfig;
        if (!a.private_key) throw new Error('lti: private_key (PEM) not configured');
        const iat = Math.floor((now || Date.now()) / 1000);
        const C = 'https://purl.imsglobal.org/spec/lti/claim/';
        const payload = {
            iss: this.config.issuer || this.base(),
            aud: a.client_id,
            sub: LmsConnector.str(employee && (employee.email || employee.id)),
            iat,
            exp: iat + 300,
            nonce: nonce || crypto.randomBytes(16).toString('hex'),
            [C + 'message_type']: 'LtiResourceLinkRequest',
            [C + 'version']: '1.3.0',
            [C + 'deployment_id']: a.deployment_id,
            [C + 'target_link_uri']: a.target_link_uri || this.base() + '/lti/launch',
            [C + 'resource_link']: { id: LmsConnector.str(courseRef) },
            [C + 'roles']: a.roles || ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
        };
        return {
            idToken: signRS256(payload, a.private_key, { kid: a.kid }),
            state: state || crypto.randomBytes(12).toString('hex'),
            nonce: payload.nonce,
            targetLinkUri: payload[C + 'target_link_uri'],
        };
    }

    normalizeWebhook() {
        return null;
    }
}

module.exports = LtiConnector;
