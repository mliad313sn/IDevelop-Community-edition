'use strict';
/**
 * Where is a Chromium the browser suites can drive?
 *
 * The browser suites (Playwright from @playwright/test, no server, no database)
 * need a Chromium binary. The one Playwright expects for its own revision may be
 * absent while another revision is installed under PLAYWRIGHT_BROWSERS_PATH; any
 * of them is fine for page.setContent(). Never downloads anything: when no
 * binary is found the suites are skipped (`launchOptions()` returns null).
 */
const fs = require('fs');
const path = require('path');

let _resolved;

function candidates(root) {
    let dirs = [];
    try {
        dirs = fs.readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d));
    } catch (_) {
        return [];
    }
    // Newest revision first, the full browser before the headless shell.
    dirs.sort((a, b) => {
        const ra = Number(a.split('-').pop());
        const rb = Number(b.split('-').pop());
        if (ra !== rb) return rb - ra;
        return a.startsWith('chromium_headless') ? 1 : -1;
    });
    const out = [];
    for (const d of dirs) {
        for (const rel of [
            'chrome-linux/chrome',
            'chrome-linux64/chrome',
            'chrome-headless-shell-linux64/chrome-headless-shell',
            'chrome-linux/headless_shell',
        ]) {
            out.push(path.join(root, d, rel));
        }
    }
    return out;
}

/** { executablePath } for chromium.launch(), {} for Playwright's default, or null. */
function launchOptions() {
    if (_resolved !== undefined) return _resolved;
    let chromium = null;
    try {
        ({ chromium } = require('@playwright/test'));
    } catch (_) {
        _resolved = null;
        return _resolved;
    }
    try {
        const def = chromium.executablePath();
        if (def && fs.existsSync(def)) {
            _resolved = {};
            return _resolved;
        }
    } catch (_) {
        /* no default browser */
    }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const found = candidates(root).find((p) => fs.existsSync(p));
    _resolved = found ? { executablePath: found } : null;
    return _resolved;
}

/** The chromium BrowserType, or null when no binary can be driven. */
function chromiumOrNull() {
    if (!launchOptions()) return null;
    return require('@playwright/test').chromium;
}

module.exports = { launchOptions, chromiumOrNull };
