const BaseModel = require('./BaseModel');
const db = require('../config/database');

class RoleSkillRequirementModel extends BaseModel {
    constructor() {
        super('roleSkillRequirements');
    }

    async findByRoleId(roleId) {
        return await db.all(
            `
            SELECT rsr.*, s.name as skillName, s.domainId, d.name as domainName
            FROM roleSkillRequirements rsr
            INNER JOIN skills s ON rsr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE rsr.roleId = ?
            ORDER BY d.name, s.name
        `,
            [roleId]
        );
    }

    async findByRoleIds(roleIds) {
        if (!roleIds || roleIds.length === 0) return [];
        const placeholders = roleIds.map(() => '?').join(',');
        return await db.all(
            `
            SELECT rsr.*, s.name as skillName, s.domainId, d.name as domainName
            FROM roleSkillRequirements rsr
            INNER JOIN skills s ON rsr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE rsr.roleId IN (${placeholders})
            ORDER BY rsr.roleId, d.name, s.name
        `,
            roleIds
        );
    }

    async findByRoleIdAndSkillId(roleId, skillId) {
        return await db.get(
            'SELECT * FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
            [roleId, skillId]
        );
    }

    async deleteByRoleId(roleId) {
        return await db.run('DELETE FROM roleSkillRequirements WHERE roleId = ?', [roleId]);
    }

    async findById(id) {
        return await db.get('SELECT * FROM roleSkillRequirements WHERE id = ?', [id]);
    }
}

module.exports = new RoleSkillRequirementModel();
