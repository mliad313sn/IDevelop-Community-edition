'use strict';

const BaseModel = require('./BaseModel');

/** Pending self-onboarding requests (open signup / SSO JIT) awaiting placement. */
class OnboardingRequestModel extends BaseModel {
    constructor() {
        super('onboarding_requests');
    }

    async findPending() {
        return await this.findAll({ status: 'pending' }, 'requestedAt ASC');
    }
}

module.exports = new OnboardingRequestModel();
