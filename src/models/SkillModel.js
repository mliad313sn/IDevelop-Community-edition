const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SkillModel extends BaseModel {
    constructor() {
        super('skills');
    }

    async findByDomainId(domainId) {
        return await this.findAll({ domainId, isActive: 1 }, 'name ASC');
    }

    async findWithDomain(domainId = null) {
        let sql = `
            SELECT s.*, s.category, d.name as domainName, sd.name as subDomainName
            FROM skills s
            INNER JOIN domains d ON s.domainId = d.id
            LEFT JOIN subDomains sd ON sd.id = s.subDomainId
            WHERE s.isActive = 1 AND d.isActive = 1
        `;
        const params = [];

        if (domainId) {
            sql += ` AND s.domainId = ?`;
            params.push(domainId);
        }

        sql += ` ORDER BY d.name, s.name`;

        return await db.all(sql, params);
    }
}

module.exports = new SkillModel();
