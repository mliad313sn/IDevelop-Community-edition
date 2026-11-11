'use strict';
/**
 * « Shared computer » is switchable and OFF by default: the login page renders
 * the box only when kioskModeEnabled is ON, and the setting ships OFF.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..', '..');
const view = fs.readFileSync(path.join(root, 'views/pages/auth/login.ejs'), 'utf8');
const model = fs.readFileSync(path.join(root, 'src/models/AppSettingsModel.js'), 'utf8');

describe('kioskModeEnabled — login view and default', () => {
    test('the box block is wrapped in the kioskEnabled condition', () => {
        const i = view.indexOf('data-kiosk-box');
        const guard = view.lastIndexOf('kioskEnabled', i);
        expect(i).toBeGreaterThan(0);
        expect(guard).toBeGreaterThan(0);
        expect(view.slice(guard, i)).toMatch(/kioskEnabled\s*\)\s*\{\s*%>/);
    });

    test('the box markup renders only when the switch is ON', () => {
        const start = view.lastIndexOf(
            '<%',
            view.lastIndexOf('kioskEnabled', view.indexOf('data-kiosk-box'))
        );
        const end = view.indexOf('<% } %>', view.indexOf('data-kiosk-box')) + '<% } %>'.length;
        const tpl =
            '<% const _kioskChecked = false, _kioskForced = false; %>' + view.slice(start, end);
        const __ = (k) => k;
        const on = ejs.render(tpl, { kioskEnabled: true, __ });
        const off = ejs.render(tpl, { kioskEnabled: false, __ });
        const missing = ejs.render(tpl, { __ });
        expect(on).toMatch(/id="sharedDevice"/);
        expect(off).not.toMatch(/sharedDevice/);
        expect(missing).not.toMatch(/sharedDevice/);
    });

    test('the setting is seeded OFF, security class', () => {
        const m = model.match(
            /key: 'kioskModeEnabled',\s*value: '(\w+)',\s*type: '(\w+)',[\s\S]*?category: '(\w+)'/
        );
        expect(m).not.toBeNull();
        expect(m[1]).toBe('false');
        expect(m[2]).toBe('boolean');
        expect(m[3]).toBe('security');
        const { isSecurityClassSetting } = require('../../src/utils/securitySettings');
        expect(isSecurityClassSetting('kioskModeEnabled', 'modules')).toBe(true);
    });
});

describe('the session layout loads shared-device.js only for a shared-computer session', () => {
    const layout = fs.readFileSync(path.join(root, 'views/layouts/main.ejs'), 'utf8');
    test('guarded by sharedDevice, with the beacon token and the labels', () => {
        const i = layout.indexOf('/js/shared-device.js');
        expect(i).toBeGreaterThan(0);
        expect(layout.slice(layout.lastIndexOf('<%', i), i)).toMatch(/sharedDevice/);
        expect(layout).toMatch(/data-mode="session"/);
        expect(layout).toMatch(/data-beacon-token="<%= sharedDevice\.beaconToken %>"/);
    });
    test('the login page loads it in login mode, with draft-store.js for the sign-out wipe', () => {
        expect(view).toMatch(/shared-device\.js\?v=<%= assetVersion %>" defer data-mode="login"/);
        expect(view).toMatch(/draft-store\.js\?v=<%= assetVersion %>"/);
        expect(view).toMatch(/form="loginForm"/);
        expect(view).toMatch(/id="loginForm"/);
    });
});
