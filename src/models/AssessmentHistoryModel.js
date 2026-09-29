const BaseModel = require('./BaseModel');
const db = require('../config/database');

class AssessmentHistoryModel extends BaseModel {
    constructor() {
        super('assessmentHistory');
    }

    async findByEmployeeId(employeeId, skillId = null) {
        let sql = `
            SELECT ah.*, s.name as skillName, d.name as domainName
            FROM assessmentHistory ah
            INNER JOIN skills s ON ah.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE ah.employeeId = ?
        `;
        const params = [employeeId];

        if (skillId) {
            sql += ` AND ah.skillId = ?`;
            params.push(skillId);
        }

        sql += ` ORDER BY ah.assessedAt DESC`;

        return await db.all(sql, params);
    }
}

module.exports = new AssessmentHistoryModel();
