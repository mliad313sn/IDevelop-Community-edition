'use strict';

/**
 *   PostgreSQL-backed session store (connect-pg-simple).
 *
 *   Returns { store, label } where store is the express-session-compatible
 *   instance and label is a short string for boot-time logging.
 */

function buildSessionStore(session /*, appConfig */) {
    const PgStore = require('connect-pg-simple')(session);
    const { Pool } = require('pg');
    // This pool is on the critical path of EVERY request (express-session runs
    // before the router and, with rolling:true, writes the expire column on each
    // authenticated response). It must have the same timeouts as the main app pool
    // so a saturated/slow Postgres can't pin all connections forever and stall the
    // whole front door — the main pool is protected from exactly this; the session
    // pool must be too. node-pg defaults connectionTimeoutMillis=0 (wait forever)
    // and no statement_timeout, so these are set explicitly.
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.PG_SESSION_POOL_MAX || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: Number(process.env.PG_SESSION_CONN_TIMEOUT_MS || 10000),
        statement_timeout: Number(process.env.PG_SESSION_STMT_TIMEOUT_MS || 15000),
        query_timeout: Number(process.env.PG_SESSION_QUERY_TIMEOUT_MS || 15000),
        keepAlive: true,
    });
    // Without an 'error' listener, a node-pg idle-client failure surfaces as an
    // uncaughtException and kills the process. Log it instead; the pool recovers.
    pool.on('error', (err) =>
        console.error('[sessionStore pool error]', err && err.message ? err.message : err)
    );
    return {
        store: new PgStore({
            pool,
            tableName: 'session',
            createTableIfMissing: false,
        }),
        label: 'connect-pg-simple',
    };
}

module.exports = { buildSessionStore };
