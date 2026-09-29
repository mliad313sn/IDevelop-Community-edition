'use strict';

// Lot 0 F3 (L6-11 / L6-12 / L6-14 / L6-19 / L4-16 / L5C-10): one presentation toolkit.
const fs = require('fs');
const path = require('path');
const { enumLabel, kindLabel, KINDS } = require('../../src/utils/enumLabels');
const { fmtDate, fmtDateTime, UNMEASURED } = require('../../src/utils/dateFormat');

const frAdmin = require('../../locales/fr/admin.json');
const enAdmin = require('../../locales/en/admin.json');
const tFor = (dict) => (key) => {
    const k = key.replace(/^admin:/, '');
    return dict[k] != null ? dict[k] : key;
};

describe('enumLabel(kind, value, t)', () => {
    test('every KINDS value has an admin:enum_* key in BOTH locales', () => {
        Object.entries(KINDS).forEach(([kind, values]) =>
            values.forEach((v) => {
                expect(frAdmin[`enum_${kind}_${v}`]).toBeTruthy();
                expect(enAdmin[`enum_${kind}_${v}`]).toBeTruthy();
            })
        );
    });
    test('resolves through the translator in either language', () => {
        expect(enumLabel('cycle_status', 'closed', tFor(frAdmin))).toBe('Clôturée');
        expect(enumLabel('cycle_status', 'closed', tFor(enAdmin))).toBe('Closed');
        expect(enumLabel('admin_role', 'viewer', tFor(frAdmin))).toBe('Lecteur');
        expect(enumLabel('schedule_frequency', 'weekly', tFor(frAdmin))).toBe('Hebdomadaire');
        expect(enumLabel('api_key_status', 'revoked', tFor(enAdmin))).toBe('Revoked');
        expect(kindLabel('sa_state', 'UNDER_REVIEW', tFor(frAdmin))).toBe('En revue'); // case-insensitive
    });
    test('falls back to the generic dictionary when the key is missing, never the raw key', () => {
        const missing = (k) => k;
        expect(enumLabel('cycle_status', 'mystery_state', missing, 'fr')).toBe('Mystery State');
        expect(enumLabel('sa_state', 'approved', missing, 'fr')).toBe('Approuvé');
        expect(enumLabel('cycle_status', '', tFor(frAdmin))).toBe('');
    });
    test('the legacy (value, lang) shape still works for every existing view', () => {
        expect(enumLabel('draft', 'fr')).toBe('Brouillon');
        expect(enumLabel('under_review', 'en')).toBe('Under Review');
        expect(enumLabel('L2', 'fr')).toBe('N2 (RH)');
    });
});

describe('fmtDate / fmtDateTime', () => {
    const d = new Date(2026, 8, 10, 14, 5); // local time
    test('one format per language, day-first, year always present, no AM/PM', () => {
        expect(fmtDate(d, 'fr')).toBe('10/09/2026');
        expect(fmtDate(d, 'en')).toBe('10/09/2026');
        expect(fmtDateTime(d, 'fr')).toBe('10/09/2026 14:05');
        expect(fmtDateTime(d, 'en')).toBe('10/09/2026, 14:05');
        expect(fmtDateTime(d.toISOString(), 'fr')).toBe('10/09/2026 14:05');
    });
    test('absent or unreadable input renders as unmeasured, never "Invalid Date"', () => {
        [null, undefined, '', 'not a date'].forEach((x) => {
            expect(fmtDate(x, 'fr')).toBe(UNMEASURED);
            expect(fmtDateTime(x, 'en')).toBe(UNMEASURED);
        });
    });
    test('server.js exposes fmtDate/fmtDateTime/enumLabel in the locals block', () => {
        const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
        expect(server).toMatch(/res\.locals\.fmtDate = \(d\) => fmtDate\(d, lang\)/);
        expect(server).toMatch(/res\.locals\.fmtDateTime = \(d\) => fmtDateTime\(d, lang\)/);
        expect(server).toMatch(/enumLabel\(a, b, req\.t, lang\)/);
    });
});

describe('ui-feedback.js — FR-aware detectType, i18n labels, declarative confirm', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-feedback.js'), 'utf8');
    // Evaluate detectType in isolation: extract the two regexes and the function body.
    // \s* after the `=` on purpose: prettier may break a long regex assignment
    // onto the next line, and a failed match here was `null[1]` — which crashed
    // the WHOLE suite at load instead of failing one test with a reason.
    const pick = (name) => {
        const m = src.match(new RegExp('var ' + name + ' =\\s*\\/(.+?)\\/;'));
        if (!m) throw new Error(name + ' regex literal not found in the client source');
        return new RegExp(m[1]);
    };
    const errRe = pick('ERR_FR');
    const okRe = pick('OK_FR');
    test('French error / success words are recognised', () => {
        [
            'Erreur lors de la sauvegarde',
            'Échec de l’envoi',
            'Action impossible',
            'Accès refusé',
        ].forEach((m) => expect(errRe.test(m.toLowerCase())).toBe(true));
        ['Enregistré', 'Succès !', 'Terminé', 'Plan créé'].forEach((m) =>
            expect(okRe.test(m.toLowerCase())).toBe(true)
        );
        expect(errRe.test('enregistré')).toBe(false);
        expect(okRe.test('erreur')).toBe(false);
    });
    test('labels are read from window.__UIF_I18N__ at call time; the layout sets it from __()', () => {
        expect(src).toMatch(/function L\(\)\s*\{\s*return window\.__UIF_I18N__ \|\| \{\};\s*\}/);
        const layout = fs.readFileSync(
            path.join(__dirname, '../../views/layouts/main.ejs'),
            'utf8'
        );
        // Either spelling: the original inline JSON.stringify, or the
        // `json-script` partial that replaced it across the views (it escapes
        // `<`, so a value carrying `</script>` can no longer break out). What is
        // pinned is that the layout injects the catalogue, not how it is spelt.
        expect(layout).toMatch(
            /window\.__UIF_I18N__ = <%- (?:JSON\.stringify\(\{|include\('[^']*json-script'[^%]*\{)/
        );
        [
            'uif_confirm_title',
            'uif_prompt_title',
            'uif_confirm',
            'uif_cancel',
            'uif_ok',
            'uif_reason_required',
            'uif_reset_filters',
            'uif_sort_by',
        ].forEach((k) => {
            expect(layout).toContain(`chrome:${k}`);
            expect(require('../../locales/fr/chrome.json')[k]).toBeTruthy();
            expect(require('../../locales/en/chrome.json')[k]).toBeTruthy();
        });
        expect(layout.indexOf('__UIF_I18N__')).toBeLessThan(layout.indexOf('/js/ui-feedback.js'));
    });
    test('promptDialog supports a required (mandatory reason) field and form[data-confirm] is handled', () => {
        expect(src).toMatch(/opts\.required/);
        expect(src).toMatch(/data-confirm-reason/);
        expect(src).toMatch(/hasAttribute\('data-confirm'\)/);
        expect(src).toMatch(/HTMLFormElement\.prototype\.submit\.call\(form\)/);
    });
    test('the double-submit guard and the loading overlay skip a submit a dialog has stopped', () => {
        expect(
            fs.readFileSync(path.join(__dirname, '../../public/js/table-search.js'), 'utf8')
        ).toMatch(/if \(e\.defaultPrevented\) return;/);
        expect(fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8')).toMatch(
            /if \(e && e\.defaultPrevented\) return;/
        );
    });
});

describe('0 native confirm()/prompt() left in the views Lot 0 owns', () => {
    const OWNED = [
        'employees/index.ejs',
        'employees/create.ejs',
        'employees/edit.ejs',
        'admins/create.ejs',
        'admins/show.ejs',
        'organization/index.ejs',
        'organization/sites.ejs',
        'organization/departments.ejs',
        'organization/services.ejs',
        'organization/_unit-actions.ejs',
        'organization/_deactivated-panel.ejs',
        'roles/index.ejs',
        'roles/show.ejs',
    ];
    const NATIVE = /(^|[^A-Za-z_.])(confirm|prompt)\(/;
    test.each(OWNED)('%s', (v) => {
        const src = fs
            .readFileSync(path.join(__dirname, '../../views/pages', v), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '') // JS block comments
            .replace(/<%#[\s\S]*?%>/g, '') // EJS comments
            .replace(/<!--[\s\S]*?-->/g, ''); // HTML comments
        const lines = src.split('\n').filter((l) => !/^\s*\/\//.test(l));
        const hits = lines.filter((l) => NATIVE.test(l.replace(/confirmDialog|promptDialog/g, '')));
        expect(hits).toEqual([]);
    });
    test('the migrated forms use data-confirm', () => {
        // ≥ 6: Lot 0 migrated six; Lot C added the deactivate / reactivate /
        // MFA-reset / revoke-sessions forms, which use the same attribute.
        expect(
            fs
                .readFileSync(path.join(__dirname, '../../views/pages/admins/show.ejs'), 'utf8')
                .match(/data-confirm="/g).length
        ).toBeGreaterThanOrEqual(6);
        expect(
            fs
                .readFileSync(path.join(__dirname, '../../views/pages/roles/index.ejs'), 'utf8')
                .match(/data-confirm="/g).length
        ).toBe(2);
        expect(
            fs
                .readFileSync(path.join(__dirname, '../../views/pages/roles/show.ejs'), 'utf8')
                .match(/data-confirm="/g).length
        ).toBe(1);
        expect(
            fs.readFileSync(path.join(__dirname, '../../views/pages/employees/edit.ejs'), 'utf8')
        ).toMatch(/await window\.confirmDialog\(EMP_T\.deactivateConfirm/);
    });
});
