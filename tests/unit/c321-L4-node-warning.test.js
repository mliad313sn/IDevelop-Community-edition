'use strict';
/**
 * 3.23.21 lane L4 — ST-1 boot warning. The shipped server.js helper is
 * extracted and EXECUTED (server.js boots the whole app on require).
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const start = src.indexOf('function nodeTooOldForEntraWarning');
const end = src.indexOf('\n}\n', start);
// eslint-disable-next-line no-new-func
const fn = new Function(`${src.slice(start, end + 2)}; return nodeTooOldForEntraWarning;`)();

describe('ST-1 — Node < 20.19 + Entra configured warns at boot', () => {
    const entra = { AZURE_CLIENT_ID: 'x', AZURE_TENANT_ID: 't' };
    test('old runtimes warn when Entra is configured', () => {
        for (const v of ['v20.18.1', 'v21.7.3', 'v22.11.0', 'v18.20.0']) {
            expect(fn(v, entra)).toMatch(/Entra SSO/);
        }
        expect(fn('v20.18.1', { AZURE_API_CLIENT_ID: 'api' })).toMatch(/20\.19/);
    });
    test('supported runtimes never warn', () => {
        for (const v of ['v20.19.0', 'v22.12.0', 'v22.23.3', 'v24.1.0'])
            expect(fn(v, entra)).toBeNull();
    });
    test('no Entra provider configured → no warning even on an old runtime', () => {
        expect(fn('v20.18.1', {})).toBeNull();
        expect(fn('v20.18.1', { AZURE_CLIENT_ID: '  ' })).toBeNull();
    });
    test('the warning is emitted after the SSO reload in startServer', () => {
        const boot = src.slice(src.indexOf('async function startServer'));
        expect(boot.indexOf('nodeTooOldForEntraWarning(process.version')).toBeGreaterThan(
            boot.indexOf('reloadSso(passport)')
        );
    });
});
