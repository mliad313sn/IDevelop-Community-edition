/**
 * Build-Package: the data snapshot a fresh install restores must not carry the
 * dev machine's runtime rows. Found 2026-09-25: the dump shipped every live web
 * session (cookies), password-reset tokens and the SAML request / replay caches.
 */
const fs = require('fs');
const path = require('path');

const ps = fs
    .readFileSync(path.join(__dirname, '..', '..', 'installer', 'Build-Package.ps1'), 'utf8')
    .replace(/\r\n/g, '\n');

describe('Build-Package.ps1 — runtime-only rows stay out of the snapshot', () => {
    test('each runtime table is excluded from the data (schema still ships)', () => {
        for (const t of [
            'public.session',
            'public.password_reset_tokens',
            'public.saml_request_cache',
            'public.saml_assertion_seen',
        ]) {
            expect(ps).toContain(`'${t}'`);
        }
        expect(ps).toMatch(/"--exclude-table-data=\$_"/);
        expect(ps).not.toMatch(/--exclude-table(?!-data)/);
    });
    test('pg_dump is actually given the exclusions', () => {
        expect(ps).toMatch(
            /& \$pgDump --no-owner --no-privileges @excludeData --file \$dumpFile \$dbUrl/
        );
    });
});
