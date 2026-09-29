const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SkillAssessmentModel extends BaseModel {
    constructor() {
        super('skillAssessments');
    }

    async findByEmployeeId(employeeId) {
        return await db.all(
            `
            SELECT sa.*, s.name as skillName, s.domainId, d.name as domainName
            FROM skillAssessments sa
            INNER JOIN skills s ON sa.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sa.employeeId = ?
            ORDER BY d.name, s.name
        `,
            [employeeId]
        );
    }

    async findByEmployeeIds(employeeIds) {
        if (!employeeIds || employeeIds.length === 0) return [];
        const placeholders = employeeIds.map(() => '?').join(',');
        return await db.all(
            `
            SELECT sa.*, s.name as skillName, s.domainId, d.name as domainName
            FROM skillAssessments sa
            INNER JOIN skills s ON sa.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sa.employeeId IN (${placeholders})
            ORDER BY sa.employeeId, d.name, s.name
        `,
            employeeIds
        );
    }

    async findByEmployeeIdAndSkillId(employeeId, skillId) {
        return await db.get('SELECT * FROM skillAssessments WHERE employeeId = ? AND skillId = ?', [
            employeeId,
            skillId,
        ]);
    }

    async upsert(data) {
        const existing = await this.findByEmployeeIdAndSkillId(data.employeeId, data.skillId);

        if (existing) {
            return await this.update(existing.id, {
                currentLevel: data.currentLevel,
                assessedBy: data.assessedBy,
                assessedAt: new Date().toISOString(),
                notes: data.notes || null,
            });
        } else {
            return await this.create(data);
        }
    }

    /**
     * @param {number[]} [employeeIds]  restrict to these employees.
     *
     * Both callers were loading the WHOLE table into Node and then filtering it in
     * JavaScript against the caller's clearance. At the 4 000-person target that is
     * roughly 141 000 rows materialised per HTTP request (35 assessments per person
     * measured here) to keep a fraction of them — an export that gets slower and
     * heavier exactly as the customer grows. Filtering in SQL also makes the
     * clearance structural rather than something each caller must remember.
     */
    async findAll({ employeeIds } = {}) {
        const scoped = Array.isArray(employeeIds);
        if (scoped && employeeIds.length === 0) return [];
        const where = scoped
            ? `WHERE sa.employeeId IN (${employeeIds.map(() => '?').join(',')})`
            : '';
        return await db.all(
            `
            SELECT sa.*, s.name as skillName, s.domainId, d.name as domainName
            FROM skillAssessments sa
            INNER JOIN skills s ON sa.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            ${where}
            ORDER BY sa.employeeId, d.name, s.name
        `,
            scoped ? employeeIds : []
        );
    }

    /** How many assessments these employees have, without materialising any. */
    async countForEmployees(employeeIds) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return 0;
        const r = await db.get(
            `SELECT COUNT(*)::int AS n FROM skillAssessments
              WHERE employeeId IN (${employeeIds.map(() => '?').join(',')})`,
            employeeIds
        );
        return r ? Number(r.n) : 0;
    }
}

module.exports = new SkillAssessmentModel();
