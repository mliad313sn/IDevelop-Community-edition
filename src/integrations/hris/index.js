'use strict';

/**
 * HRIS connector registry — the twin of src/integrations/lms/index.js. A new
 * HRIS = one class + one line here (+ the provider in the CHECK constraint of
 * hris_connectors). The rest of the platform resolves connectors only through
 * getConnector, never by name.
 */
const HrisConnector = require('./HrisConnector');
const CsvConnector = require('./CsvConnector');
const PersonioConnector = require('./PersonioConnector');
const LuccaConnector = require('./LuccaConnector');

const REGISTRY = {
    csv: CsvConnector,
    personio: PersonioConnector,
    lucca: LuccaConnector,
};

/** Connectors whose export is the FULL population by default (absence = leaver). */
const API_PROVIDERS = ['personio', 'lucca'];

function getConnector(provider, config = {}, credentials = {}, opts = {}) {
    const Ctor = REGISTRY[String(provider || '').toLowerCase()];
    if (!Ctor) {
        const e = new Error(`Unknown HRIS provider: ${provider}`);
        e.code = 'hris_unknown_provider';
        throw e;
    }
    return new Ctor(config, credentials, opts);
}

function listProviders() {
    return Object.keys(REGISTRY);
}

module.exports = { getConnector, listProviders, HrisConnector, REGISTRY, API_PROVIDERS };
