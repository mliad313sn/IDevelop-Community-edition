'use strict';
/**
 * Set the default `admin` account's password and force a change at next login.
 * Used by the installer to replace the seed default (admin123) with a strong
 * random password on a fresh database.
 *
 * Usage: SET_ADMIN_PASSWORD=<newPassword> node scripts/set-admin-password.js [username]
 *        (legacy: node scripts/set-admin-password.js <newPassword> [username])
 *
 * The password comes from the environment. On the command line it was readable
 * by any local user in the process list (Get-CimInstance Win32_Process,
 * tasklist /v, ps) for the life of the process. The variable is removed from
 * this process's environment as soon as it is read.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/config/database');

const fromEnv = process.env.SET_ADMIN_PASSWORD;
const pw = fromEnv || process.argv[2];
const username = (fromEnv ? process.argv[2] : process.argv[3]) || 'admin';
delete process.env.SET_ADMIN_PASSWORD;
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
