'use strict';
/**
 * Set the default `admin` account's password and force a change at next login.
 * Used by the installer to replace the seed default (admin123) with a strong
 * random password on a fresh database.
 *
 * Usage: node scripts/set-admin-password.js <newPassword> [username]
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/config/database');

const pw = process.argv[2];
const username = process.argv[3] || 'admin';
if (!pw || pw.length < 8) {
    console.error('A password of at least 8 characters is required.');
    process.exit(1);
}

(async () => {
    await db.connect();
    const hash = await bcrypt.hash(pw, 10);
    const r = await db.run(
        'UPDATE admins SET passwordHash = ?, forcePasswordChange = true WHERE username = ?',
        [hash, username]
    );
    await db.close();
    if (!r.changes) {
        console.error(`No admin account named '${username}' found.`);
        process.exit(2);
    }
    console.log(`Password set for '${username}'; change required at first login.`);
})().catch((e) => {
    console.error('Failed:', e.message);
    process.exit(1);
});
