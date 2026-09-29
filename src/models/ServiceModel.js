const BaseModel = require('./BaseModel');
const db = require('../config/database');

class ServiceModel extends BaseModel {
    constructor() {
        super('services');
    }

    async findByDepartmentId(departmentId) {
        return await this.findAll({ departmentId, isActive: 1 }, 'name ASC');
    }

    async findWithDepartment(departmentId = null, ids = null) {
        let sql = `
            SELECT s.*, d.name as departmentName, d.siteId, st.name as siteName
            FROM services s
            INNER JOIN departments d ON s.departmentId = d.id
            INNER JOIN sites st ON d.siteId = st.id
            WHERE s.isActive = 1
        `;
        const params = [];

        if (departmentId) {
            sql += ` AND s.departmentId = ?`;
            params.push(departmentId);
        }

        if (ids && ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            sql += ` AND s.id IN (${placeholders})`;
            params.push(...ids);
        }

        sql += ` ORDER BY st.name, d.name, s.name`;

        return await db.all(sql, params);
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        return await db.all(
            `SELECT * FROM services WHERE id IN (${placeholders}) ORDER BY name`,
            ids
        );
    }

    async findByDepartmentIds(departmentIds) {
        if (!departmentIds || departmentIds.length === 0) return [];
        const placeholders = departmentIds.map(() => '?').join(',');
        return await db.all(
            `SELECT * FROM services WHERE departmentId IN (${placeholders}) ORDER BY name`,
            departmentIds
        );
    }

    // Array variant of findWithDepartment (with the site/department joins) — one query
    // for many departments, replacing the per-department loop in RBAC scope resolution.
    async findWithDepartments(departmentIds) {
        if (!departmentIds || departmentIds.length === 0) return [];
        const placeholders = departmentIds.map(() => '?').join(',');
        return await db.all(
            `
            SELECT s.*, d.name as departmentName, d.siteId, st.name as siteName
            FROM services s
            INNER JOIN departments d ON s.departmentId = d.id
            INNER JOIN sites st ON d.siteId = st.id
            WHERE s.isActive = 1 AND s.departmentId IN (${placeholders})
            ORDER BY st.name, d.name, s.name`,
            departmentIds
        );
    }
}

module.exports = new ServiceModel();
