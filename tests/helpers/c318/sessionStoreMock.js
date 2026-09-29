'use strict';
/**
 * 3.23.18 lane T — test double for src/config/sessionStore.
 *
 * The production store is connect-pg-simple (one row per session in the
 * `session` table). The route matrix must not write persistent rows, and it
 * mints sessions directly instead of logging in (no password needed, no
 * last_login_at / lockout / audit side effects), so it needs a store it can
 * reach: express-session's own MemoryStore, exposed as `.store` once built.
 *
 * Usage (in a test file):
 *   jest.mock('../../src/config/sessionStore', () =>
 *       require('../helpers/c318/sessionStoreMock'));
 */
const state = { store: null };

function buildSessionStore(session) {
    state.store = new session.MemoryStore();
    return { store: state.store, label: 'MemoryStore (c318 test double)' };
}

module.exports = { buildSessionStore, state };
