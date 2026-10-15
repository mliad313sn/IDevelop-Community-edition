'use strict';
/**
 * The sensitive-settings band on /app-settings: nationality (the localContent
 * module, featureLocalContent), shared-computer mode and mandatory MFA are shown
 * FIRST, in a band of their own, each with a « Sensitive setting » chip and the
 * consequence of switching it, and a change of state asks for confirmation. The
 * same keys are not repeated in their ordinary category.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = path.join(ROOT, 'views/pages/app-settings/index.ejs');
const json = (l, ns) => JSON.parse(fs.readFileSync(path.join(ROOT, `locales/${l}/${ns}.json`)));

const row = (id, settingKey, settingValue, category, extra = {}) => ({
    id,
    settingKey,
    settingValue,
    settingType: 'boolean',
    category,
    description: '',
    rule: {},
    locked: false,
    ...extra,
});

function render() {
    const settings = [
        row(1, 'kioskModeEnabled', 'false', 'security'),
        row(2, 'mfaRequiredForPrivileged', 'true', 'security'),
        row(3, 'mfaRequiredForManagers', 'true', 'security'),
        row(4, 'featureLocalContent', '0', 'modules'),
        row(5, 'sessionIdleMinutes', '30', 'security', { settingType: 'number' }),
    ];
    const settingsByCategory = {};
    for (const s of settings) (settingsByCategory[s.category] ||= []).push(s);
    return ejs.render(
        fs.readFileSync(VIEW, 'utf8'),
        {
            __: (k) => k,
            can: () => true,
            user: { role: 'superadmin' },
            csrfToken: 't',
            cspNonce: 'n',
            settings,
            settingsByCategory,
            jobState: [],
            fmtDateTime: () => 'x',
        },
        { filename: VIEW }
    );
}

describe('sensitive-settings band', () => {
    let html;
    beforeAll(() => {
        html = render();
    });

    test('the band comes first and holds the four sensitive switches', () => {
        const band = html.indexOf('data-sensitive-band');
        expect(band).toBeGreaterThan(0);
        expect(band).toBeLessThan(html.indexOf('id="set-security"'));
        for (const k of [
            'featureLocalContent',
            'kioskModeEnabled',
            'mfaRequiredForPrivileged',
            'mfaRequiredForManagers',
        ]) {
            expect(html).toContain(`data-sensitive="${k}"`);
            expect(html).toContain(`admin:set_sensitive_consequence_${k}`);
        }
        expect((html.match(/class="setting-chip"/g) || []).length).toBe(4);
    });

    test('a sensitive key is not repeated in its category; the others stay there', () => {
        const security = html.slice(html.indexOf('id="set-security"'));
        expect(security).toContain('sessionIdleMinutes');
        expect(security.split('id="set-modules"')[0]).not.toContain('data-sensitive=');
        expect(html).not.toContain('id="set-modules"'); // its only row moved to the band
    });

    test("a stored '0' reads OFF, '1' / 'true' read ON", () => {
        const lc = html.slice(html.indexOf('data-sensitive="featureLocalContent"'));
        expect(lc.slice(0, lc.indexOf('</tr>'))).toMatch(/badge-secondary[\s\S]*admin:disabled/);
    });

    test('the edit dialog arms a confirmation on a change of state, with the consequence', () => {
        const src = fs.readFileSync(VIEW, 'utf8');
        expect(src).toMatch(/const SENS = <%- include\('\.\.\/\.\.\/partials\/json-script'/);
        expect(src).toMatch(/if \(wantOn === wasOn\) return;/);
        expect(src).toMatch(
            /_form\.setAttribute\('data-confirm', lc \? SENS_LC\.body : _s\.consequence\)/
        );
    });

    test('the modules page confirms a change of the localContent module too', () => {
        const src = fs.readFileSync(path.join(ROOT, 'views/pages/admin/modules.ejs'), 'utf8');
        expect(src).toMatch(/after\.localContent !== !!CURRENT\.localContent/);
        expect(src).toMatch(/admin:set_lc_toggle_confirm/);
    });

    test('every key the band uses exists in FR and EN', () => {
        for (const l of ['fr', 'en']) {
            const a = json(l, 'admin');
            const c = json(l, 'common');
            expect(typeof c.sensitive_setting).toBe('string');
            for (const k of [
                'set_sensitive_band_title',
                'set_sensitive_band_intro',
                'set_lc_toggle_confirm',
                'set_lc_toggle_confirm_title',
            ])
                expect([l, k, typeof a[k]]).toEqual([l, k, 'string']);
            for (const s of [
                'featureLocalContent',
                'kioskModeEnabled',
                'mfaRequiredForPrivileged',
                'mfaRequiredForManagers',
            ])
                for (const p of ['consequence', 'on', 'off'])
                    expect([l, s, p, typeof a[`set_sensitive_${p}_${s}`]]).toEqual([
                        l,
                        s,
                        p,
                        'string',
                    ]);
        }
    });
});
