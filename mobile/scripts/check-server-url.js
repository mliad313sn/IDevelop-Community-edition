'use strict';
/**
 * Mobile shell: the build-time security gate.
 *
 * capacitor.config.ts takes every security-relevant value from this file, and
 * the build fails when a rule is broken:
 *  - SERVER_URL must be https://. http:// is accepted only for localhost,
 *    127.0.0.1 or [::1] in an explicit DEVELOPMENT build (MOBILE_BUILD=dev);
 *    every other build is a release build, the safe default.
 *  - SERVER_URL carries no credentials, no query and no fragment.
 *  - Cleartext traffic and mixed content are off; navigation inside the
 *    WebView is limited to the configured host (anything else, the identity
 *    provider included, opens in the system browser); WebView debugging is on
 *    only in a development build.
 *  - Once `npx cap add android|ios` has generated the native projects, their
 *    files are checked too: Android allowBackup="false", no cleartext traffic,
 *    not debuggable in a release build; iOS App Transport Security on.
 *  - Certificate pinning is off until a native build exists (see PINNING).
 *
 * Run it on its own:
 *   SERVER_URL=https://app.example.com node mobile/scripts/check-server-url.js
 *   node mobile/scripts/check-server-url.js https://app.example.com
 */
const fs = require('fs');
const path = require('path');

/** Hosts a development build may reach over http://. */
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Certificate pinning: OFF until the first native build. Then pin the SHA-256
 * of the SubjectPublicKeyInfo of the issuing CA (or of the leaf plus a backup
 * key) per deployment, through a native plugin, always with two pins so a
 * certificate renewal never locks people out, and never in a development build.
 */
const PINNING = Object.freeze({ enabled: false, pins: Object.freeze([]) });

/** A build is a release build unless MOBILE_BUILD=dev is set. */
function isRelease(env) {
    return (
        String((env && env.MOBILE_BUILD) || '')
            .trim()
            .toLowerCase() !== 'dev'
    );
}

/**
 * Check the deployment address.
 * @returns {{ok: boolean, errors: string[], url?: string, host?: string, cleartext: boolean}}
 */
function checkServerUrl(raw, { release = true } = {}) {
    const errors = [];
    const out = { ok: false, errors, cleartext: false };
    const text = raw == null ? '' : String(raw).trim();
    if (!text) {
        errors.push('SERVER_URL is required (for example SERVER_URL=https://app.example.com).');
        return out;
    }
    let u;
    try {
        u = new URL(text);
    } catch (_) {
        errors.push('SERVER_URL is not an absolute address (for example https://app.example.com).');
        return out;
    }
    if (u.username || u.password) errors.push('SERVER_URL must not carry a user name or password.');
    if (u.search || u.hash) errors.push('SERVER_URL must not carry a query or a fragment.');
    let cleartext = false;
    if (u.protocol === 'http:') {
        if (!DEV_HOSTS.has(u.hostname))
            errors.push(
                `SERVER_URL must be https:// (http:// is accepted only for localhost in a development build): ${u.origin}`
            );
        else if (release)
            errors.push(
                'http://localhost is a development address and is refused in a release build (set MOBILE_BUILD=dev for a local test build).'
            );
        else cleartext = true;
    } else if (u.protocol !== 'https:') {
        errors.push(`SERVER_URL must be https:// (got ${u.protocol}).`);
    }
    let base = u.pathname;
    while (base.endsWith('/')) base = base.slice(0, -1);
    out.url = u.origin + base;
    out.host = u.host;
    out.ok = errors.length === 0;
    out.cleartext = out.ok && cleartext;
    return out;
}

// The files `npx cap add android|ios` generates, next to this folder.
const ANDROID_MANIFEST = path.join(
    __dirname,
    '..',
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml'
);
const IOS_INFO_PLIST = path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');

/** The generated native files: their text, or null while they do not exist. */
function readNativeProjects() {
    return {
        manifest: fs.existsSync(ANDROID_MANIFEST)
            ? fs.readFileSync(ANDROID_MANIFEST, 'utf8')
            : null,
        plist: fs.existsSync(IOS_INFO_PLIST) ? fs.readFileSync(IOS_INFO_PLIST, 'utf8') : null,
    };
}

/** Checks of the generated native projects ({ manifest, plist } texts; null = absent). */
function checkNativeProjects(native, { release = true } = {}) {
    const errors = [];
    const x = native && typeof native.manifest === 'string' ? native.manifest : null;
    if (x !== null) {
        if (!/android:allowBackup\s*=\s*"false"/.test(x))
            errors.push(
                'AndroidManifest.xml: set android:allowBackup="false" on <application> (the session and WebView data must not reach device or cloud backups).'
            );
        if (/android:usesCleartextTraffic\s*=\s*"true"/.test(x))
            errors.push('AndroidManifest.xml: android:usesCleartextTraffic="true" is not allowed.');
        if (release && /android:debuggable\s*=\s*"true"/.test(x))
            errors.push('AndroidManifest.xml: android:debuggable="true" in a release build.');
    }
    const p = native && typeof native.plist === 'string' ? native.plist : null;
    if (p !== null) {
        if (/<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(p))
            errors.push(
                'Info.plist: NSAllowsArbitraryLoads=true is not allowed (App Transport Security must stay on).'
            );
    }
    return errors;
}

/**
 * The security part of the Capacitor configuration. Throws when the gate
 * fails, so no build can produce an app pointed at an unsafe address.
 * `native` defaults to the generated files next to this folder.
 */
function buildMobileSecurity(env, native = readNativeProjects()) {
    const release = isRelease(env);
    const r = checkServerUrl(env && env.SERVER_URL, { release });
    const errors = r.errors.concat(checkNativeProjects(native, { release }));
    if (errors.length) throw new Error('Mobile build refused:\n - ' + errors.join('\n - '));
    return {
        release,
        pinning: PINNING,
        server: {
            url: r.url,
            // On only for an explicit development build pointed at localhost.
            cleartext: r.cleartext,
            androidScheme: 'https',
            // The configured host only; every other host opens in the system browser.
            allowNavigation: [r.host],
        },
        android: { allowMixedContent: false, webContentsDebuggingEnabled: !release },
        ios: { webContentsDebuggingEnabled: !release },
    };
}

module.exports = {
    checkServerUrl,
    checkNativeProjects,
    readNativeProjects,
    buildMobileSecurity,
    isRelease,
    PINNING,
    DEV_HOSTS,
};

if (require.main === module) {
    const env = { ...process.env };
    if (process.argv[2]) env.SERVER_URL = process.argv[2];
    try {
        const s = buildMobileSecurity(env);
        console.log(
            `OK ${s.release ? 'release' : 'DEVELOPMENT'} build -> ${s.server.url} ` +
                `(cleartext ${s.server.cleartext ? 'on, localhost only' : 'off'}; ` +
                `navigation: ${s.server.allowNavigation.join(', ')}; ` +
                `WebView debugging ${s.android.webContentsDebuggingEnabled ? 'on' : 'off'}; ` +
                `certificate pinning ${s.pinning.enabled ? 'on' : 'off'})`
        );
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
