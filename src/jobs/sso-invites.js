'use strict';
/**
 * sso-invites — 3.23.20 (Amendment C3c). Every 5 minutes: dispatch the SSO
 * migration invitations queued by the migration-153 triggers (see
 * services/SsoInviteService). Rows wait while SSO is not live; concurrent runs
 * never send one row twice (claimed with FOR UPDATE SKIP LOCKED); a missing
 * outbox table (database not yet migrated) is a no-op.
 */
async function tick() {
    return require('../services/SsoInviteService').dispatch();
}

module.exports = { tick };
