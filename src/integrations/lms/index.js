'use strict';

/**
 * LMS connector registry. New LMS of the market = add one line here. The rest of
 * the platform resolves connectors only through getConnector, never by name.
 */
const LmsConnector = require('./LmsConnector');
const XapiLrsConnector = require('./XapiLrsConnector');
const LtiConnector = require('./LtiConnector');
const CornerstoneConnector = require('./CornerstoneConnector');
const MyPathConnector = require('./MyPathConnector');

const REGISTRY = {
    xapi: XapiLrsConnector,
    lti: LtiConnector,
    cornerstone: CornerstoneConnector,
    mypath: MyPathConnector,
};

function getConnector(provider, config = {}) {
    const Ctor = REGISTRY[String(provider || '').toLowerCase()];
    if (!Ctor) throw new Error(`Unknown LMS provider: ${provider}`);
    return new Ctor(config);
}

function listProviders() {
    return Object.keys(REGISTRY);
}

module.exports = { getConnector, listProviders, LmsConnector, REGISTRY };
