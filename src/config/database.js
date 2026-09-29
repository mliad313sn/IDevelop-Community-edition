'use strict';

/**
 *   PostgreSQL database connection.
 *
 *   The application runs exclusively on PostgreSQL. Set DATABASE_URL in the
 *   environment (see .env.example). The driver exposes connect, run, get, all,
 *   runTransaction, migrate, seed and close.
 */

const PostgresDatabase = require('../database/PostgresDatabase');

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL is not set. This application requires PostgreSQL — ' +
            'configure DATABASE_URL (e.g. postgres://user:pass@localhost:5432/yourdb).'
    );
}

const db = new PostgresDatabase(process.env.DATABASE_URL);

module.exports = db;
