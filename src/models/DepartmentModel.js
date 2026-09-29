const BaseModel = require('./BaseModel');
const db = require('../config/database');

class DepartmentModel extends BaseModel {
    constructor() {
        super('departments');
    }

    async findBySiteId(siteId) {
        return await this.findAll({ siteId, isActive: 1 }, 'name ASC');
    }

    async findWithSite(siteId = null, ids = null) {
        let sql = `
            SELECT d.*, s.name as siteName 
            FROM departments d
            INNER JOIN sites s ON d.siteId = s.id
            WHERE d.isActive = 1 AND s.isActive = 1
        `;
        const params = [];

        if (siteId) {
            sql += ` AND d.siteId = ?`;
            params.push(siteId);
        }

        if (ids && ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            sql += ` AND d.id IN (${placeholders})`;
            params.push(...ids);
        }

        sql += ` ORDER BY s.name, d.name`;

        return await db.all(sql, params);
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        return await db.all(
            `SELECT * FROM departments WHERE id IN (${placeholders}) ORDER BY name`,
            ids
        );
    }

    async findBySiteIds(siteIds) {
        if (!siteIds || siteIds.length === 0) return [];
        const placeholders = siteIds.map(() => '?').join(',');
        return await db.all(
            `SELECT * FROM departments WHERE siteId IN (${placeholders}) ORDER BY name`,
            siteIds
        );
    }

    // Array variant of findWithSite — one query for many sites (kills the RBAC N+1
    // that looped findWithSite per scoped site on every org/dashboard page load).
    async findWithSites(siteIds) {
        if (!siteIds || siteIds.length === 0) return [];
        const placeholders = siteIds.map(() => '?').join(',');
        return await db.all(
            `
            SELECT d.*, s.name as siteName
            FROM departments d
            INNER JOIN sites s ON d.siteId = s.id
            WHERE d.isActive = 1 AND s.isActive = 1 AND d.siteId IN (${placeholders})
            ORDER BY d.name`,
            siteIds
        );
    }
}

module.exports = new DepartmentModel();
