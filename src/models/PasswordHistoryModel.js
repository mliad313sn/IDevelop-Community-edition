const BaseModel = require('./BaseModel');
const db = require('../config/database');

class PasswordHistoryModel extends BaseModel {
    constructor() {
        super('password_history');
    }

    /**
     * Add password to history
     */
    async addPassword(adminId, passwordHash) {
        return await db.run(
            `INSERT INTO password_history (adminId, passwordHash, changedAt) VALUES (?, ?, datetime('now'))`,
            [adminId, passwordHash]
        );
    }

    /**
     * Get password history for admin (last N passwords)
     */
    async getRecentPasswords(adminId, limit = 5) {
        return await db.all(
            `SELECT passwordHash, changedAt FROM password_history 
             WHERE adminId = ? 
             ORDER BY changedAt DESC 
             LIMIT ?`,
            [adminId, limit]
        );
    }

    /**
     * Check if password was used before
     */
    async isPasswordReused(adminId, newPasswordHash, bcrypt) {
        const history = await this.getRecentPasswords(adminId, 5);

        for (const record of history) {
            const matches = await bcrypt.compare(newPasswordHash, record.passwordHash);
            if (matches) {
                return true;
            }
        }

        return false;
    }

    /**
     * Clean up old password history (keep only last 5 per user)
     */
    async cleanupOldPasswords(adminId) {
        return await db.run(
            `DELETE FROM password_history 
             WHERE adminId = ? 
             AND id NOT IN (
                 SELECT id FROM password_history 
                 WHERE adminId = ? 
                 ORDER BY changedAt DESC 
                 LIMIT 5
             )`,
            [adminId, adminId]
        );
    }
}

module.exports = new PasswordHistoryModel();
