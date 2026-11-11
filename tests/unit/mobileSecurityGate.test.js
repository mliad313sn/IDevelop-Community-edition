'use strict';
/**
 * The mobile shell starts safe: mobile/scripts/check-server-url.js (the build
 * gate) is RUN, including its command-line form, and capacitor.config.ts is
 * checked to take every security value from it.
 *   - https only (http://localhost only in an explicit development build), no
 *     credentials, query or fragment in SERVER_URL;
 *   - cleartext and mixed content off, navigation limited to the host,
 *     WebView debugging only in a development build, pinning off for now;
 *   - generated native projects: Android allowBackup="false", no cleartext,
 *     not debuggable in a release build; iOS App Transport Security on.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GATE = path.join(ROOT, 'mobile', 'scripts', 'check-server-url.js');
const CONFIG = path.join(ROOT, 'mobile', 'capacitor.config.ts');
const { checkServerUrl, checkNativeProjects, buildMobileSecurity, isRelease, PINNING } = require(
    GATE
);

/** No generated native project (the state of the repository today). */
const tmpMobile = () => ({ manifest: null, plist: null });

describe('checkServerUrl', () => {
    test('https is accepted: origin kept, trailing slashes dropped, host for navigation', () => {
        const r = checkServerUrl('https://app.example.com/', { release: true });
        expect(r).toMatchObject({
            ok: true,
            url: 'https://app.example.com',
            host: 'app.example.com',
            cleartext: false,
        });
        expect(
            checkServerUrl('https://app.example.com:8443/talent//', { release: true })
        ).toMatchObject({
            ok: true,
            url: 'https://app.example.com:8443/talent',
            host: 'app.example.com:8443',
        });
    });

    test.each([
        ['http://app.example.com', true],
        ['http://app.example.com', false],
        ['http://10.0.0.5:3000', false],
        ['http://localhost:3000', true],
        ['ftp://app.example.com', true],
        ['javascript:alert(1)', true],
        ['https://user:pw@app.example.com', true],
        ['https://app.example.com/?x=1', true],
        ['https://app.example.com/#a', true],
        ['app.example.com', true],
        ['', true],
        [undefined, true],
    ])('refused: %p (release=%p)', (url, release) => {
        const r = checkServerUrl(url, { release });
        expect(r.ok).toBe(false);
        expect(r.cleartext).toBe(false);
        expect(r.errors.length).toBeGreaterThan(0);
    });

    test.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
        'development build: %p accepted with cleartext on',
        (url) => {
            expect(checkServerUrl(url, { release: false })).toMatchObject({
                ok: true,
                cleartext: true,
            });
        }
    );

    test('a build is a release build unless MOBILE_BUILD=dev', () => {
        expect(isRelease({})).toBe(true);
        expect(isRelease(undefined)).toBe(true);
        expect(isRelease({ MOBILE_BUILD: 'release' })).toBe(true);
        expect(isRelease({ MOBILE_BUILD: 'debug' })).toBe(true);
        expect(isRelease({ MOBILE_BUILD: 'dev' })).toBe(false);
        expect(isRelease({ MOBILE_BUILD: ' DEV ' })).toBe(false);
    });
});

describe('buildMobileSecurity', () => {
    test('release: cleartext off, mixed content off, navigation = host, debugging off, pinning off', () => {
        const s = buildMobileSecurity({ SERVER_URL: 'https://hr.example.org' }, tmpMobile());
        expect(s.release).toBe(true);
        expect(s.server).toEqual({
            url: 'https://hr.example.org',
            cleartext: false,
            androidScheme: 'https',
            allowNavigation: ['hr.example.org'],
        });
        expect(s.android).toEqual({ allowMixedContent: false, webContentsDebuggingEnabled: false });
        expect(s.ios).toEqual({ webContentsDebuggingEnabled: false });
        expect(s.pinning.enabled).toBe(false);
        expect(PINNING.enabled).toBe(false);
        expect(Object.isFrozen(PINNING)).toBe(true);
    });

    test('development build on localhost: cleartext and debugging on, never mixed content', () => {
        const s = buildMobileSecurity(
            { SERVER_URL: 'http://localhost:3000', MOBILE_BUILD: 'dev' },
            tmpMobile()
        );
        expect(s.server.cleartext).toBe(true);
        expect(s.android.webContentsDebuggingEnabled).toBe(true);
        expect(s.android.allowMixedContent).toBe(false);
    });

    test('throws (build refused) on http in a release build and on a missing address', () => {
        expect(() =>
            buildMobileSecurity({ SERVER_URL: 'http://localhost:3000' }, tmpMobile())
        ).toThrow(/Mobile build refused/);
        expect(() => buildMobileSecurity({}, tmpMobile())).toThrow(/SERVER_URL is required/);
    });
});

describe('checkNativeProjects (once `cap add` has generated them)', () => {
    const withNative = (manifest, plist) => ({ manifest, plist });

    test('the repository has no generated native project yet, and the default reads it', () => {
        const { readNativeProjects } = require(GATE);
        const exists = (p) => fs.existsSync(path.join(ROOT, 'mobile', p));
        expect(readNativeProjects()).toEqual({
            manifest: exists('android') ? expect.any(String) : null,
            plist: exists('ios') ? expect.any(String) : null,
        });
    });
    const good =
        '<manifest><application android:allowBackup="false" android:label="x"></application></manifest>';

    test('no native project: nothing to check', () => {
        expect(checkNativeProjects(withNative(null, null))).toEqual([]);
    });
    test('a compliant manifest and plist: no error', () => {
        expect(
            checkNativeProjects(
                withNative(good, '<dict><key>NSAllowsArbitraryLoads</key><false/></dict>')
            )
        ).toEqual([]);
    });
    test('the Capacitor default allowBackup="true" is refused', () => {
        const e = checkNativeProjects(withNative('<application android:allowBackup="true">', null));
        expect(e.join(' ')).toMatch(/allowBackup="false"/);
    });
    test('cleartext, debuggable and App Transport Security off are refused', () => {
        const e = checkNativeProjects(
            withNative(
                '<application android:allowBackup="false" android:usesCleartextTraffic="true" android:debuggable="true">',
                '<dict><key>NSAllowsArbitraryLoads</key>\n  <true/></dict>'
            ),
            { release: true }
        );
        expect(e).toHaveLength(3);
        // a development build may be debuggable, never cleartext
        const dev = checkNativeProjects(
            withNative(
                '<application android:allowBackup="false" android:usesCleartextTraffic="true" android:debuggable="true">',
                null
            ),
            { release: false }
        );
        expect(dev).toHaveLength(1);
    });
    test('the gate refuses a build whose manifest lacks allowBackup="false"', () => {
        const dir = withNative('<application>', null);
        expect(() => buildMobileSecurity({ SERVER_URL: 'https://a.example.com' }, dir)).toThrow(
            /allowBackup/
        );
    });
});

describe('command line and capacitor.config.ts wiring', () => {
    test('command line: exit 0 for https, exit 1 for http', () => {
        const ok = spawnSync(process.execPath, [GATE, 'https://app.example.com'], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH },
        });
        expect(ok.status).toBe(0);
        expect(ok.stdout).toMatch(/OK release build -> https:\/\/app\.example\.com/);
        const ko = spawnSync(process.execPath, [GATE, 'http://app.example.com'], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH },
        });
        expect(ko.status).toBe(1);
        expect(ko.stderr).toMatch(/must be https/);
    });

    test('capacitor.config.ts takes server, android and ios security values from the gate only', () => {
        const ts = fs.readFileSync(CONFIG, 'utf8');
        expect(ts).toMatch(/require\('\.\/scripts\/check-server-url'\)/);
        expect(ts).toMatch(/buildMobileSecurity\(process\.env\)/);
        expect(ts).toMatch(/server: sec\.server/);
        expect(ts).toMatch(/\.\.\.sec\.android/);
        expect(ts).toMatch(/\.\.\.sec\.ios/);
        expect(ts).not.toMatch(/cleartext:\s*true/);
        expect(ts).not.toMatch(/webContentsDebuggingEnabled:\s*true/);
        expect(ts).not.toMatch(/allowNavigation:\s*\[\s*['"]\*/);
        expect(ts).not.toMatch(/https?:\/\/(?!app\.example\.com)[a-z0-9.-]+\.[a-z]{2,}/i);
    });
});
