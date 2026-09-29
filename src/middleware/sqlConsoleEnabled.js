'use strict';

/**
 * Separation of duties for the super-admin SQL console.
 *
 * The console is OFF unless whoever operates the server sets
 * SQL_CONSOLE_ENABLED=1 in the environment (see SqlConsoleService.isEnabled).
 * While it is off, every console route answers 404 — mounted BEFORE the role
 * check, so the console does not even reveal to a super admin that it exists
 * behind a switch they cannot reach from the application.
 */
function requireSqlConsoleEnabled(req, res, next) {
    if (require('../services/SqlConsoleService').isEnabled()) return next();
    return require('./errorHandler').notFoundHandler(req, res);
}

module.exports = { requireSqlConsoleEnabled };
