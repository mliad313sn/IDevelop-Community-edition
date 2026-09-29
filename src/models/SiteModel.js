const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SiteModel extends BaseModel {
    constructor() {
        super('sites');
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        return await db.all(`SELECT * FROM sites WHERE id IN (${placeholders}) ORDER BY name`, ids);
    }
}

module.exports = new SiteModel();
