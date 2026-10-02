'use strict';

/**
 * Jest test environment = the stock `node` environment plus one global,
 * `__nativeRequire(id)`: Node's own require, resolved from the project root.
 *
 * Why: some production dependencies are ES modules (openid-client, jose,
 * otplib's crypto/base32 plugins).
 * Production loads them with require(esm) (Node >= 20.19); Jest's CommonJS
 * loader cannot evaluate them on Node < 24.9.
 * Under Jest 29 a test reached Node's loader through
 * `process.getBuiltinModule('module').createRequire(...)`, but Jest 30
 * sandboxes that too, so the escape hatch now lives here, outside the sandbox.
 * Use it only inside a `jest.mock(id, () => globalThis.__nativeRequire(id))`
 * factory (babel-jest-hoist only lets factories reach globals via globalThis).
 */
const { createRequire } = require('module');
const path = require('path');
const { TestEnvironment } = require('jest-environment-node');

const nativeRequire = createRequire(path.join(__dirname, '..', '..', 'package.json'));

class NativeEsmEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        this.global.__nativeRequire = (id) => nativeRequire(id);
    }
}

module.exports = NativeEsmEnvironment;
