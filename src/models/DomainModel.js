const BaseModel = require('./BaseModel');

class DomainModel extends BaseModel {
    constructor() {
        super('domains');
    }
}

module.exports = new DomainModel();
