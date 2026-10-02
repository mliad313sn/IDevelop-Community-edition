'use strict';

/**
 * The installer payload must not carry CI or container build configuration:
 * `.gitleaks.toml` (the secret-scan allow-list, which tells a reader what the
 * scanner ignores) and `.dockerignore` have no consumer on an installed server.
 * Build-Package.ps1 copies every top-level entry that is not excluded, so both
 * must be on the excluded-files list.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../installer/Build-Package.ps1'), 'utf8');

function excludeFilesList() {
    const code = src.replace(/#[^\n]*/g, ''); // comments may hold parentheses
    const m = /\$excludeFiles\s*=\s*@\(([\s\S]*?)\)/.exec(code);
    if (!m) throw new Error('$excludeFiles not found in Build-Package.ps1');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test.each(['.gitleaks.toml', '.dockerignore'])('%s is excluded from the package', (name) => {
    expect(excludeFilesList()).toContain(name);
});
