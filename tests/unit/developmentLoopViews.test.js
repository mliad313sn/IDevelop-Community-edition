'use strict';
/**
 * The development loop's views (4.0.0 port, wave 4), rendered from the real
 * templates with the real catalogues, no database:
 *   - the action controls: the person starts and reports, the line validates
 *     (default "cannot judge yet", never a preselected level), a closed action
 *     says what was observed; plain forms with the CSRF token, no inline handler;
 *   - the proposal page lists the person's proposals with the answer;
 *   - the development outcomes block says « not entered », never 0 hours;
 *   - a machine-written objective is printed in the reader's language, a
 *     person's text as stored (no regular expression over the stored text).
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const KF = require('../../src/utils/kpiFormat');
const OT = require('../../src/utils/idpObjectiveText');

const tr = (lang) => (key, vars) => {
    const [ns, k] = String(key).split(':');
    // eslint-disable-next-line security/detect-non-literal-require
    const dict = require(`../../locales/${lang}/${ns}.json`);
    let v = dict[k];
    if (typeof v !== 'string') v = (vars && vars.defaultValue) || k;
    return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) => (vars && vars[x] != null ? vars[x] : ''));
};
const render = (rel, locals, lang = 'en') =>
    ejs.render(
        fs.readFileSync(path.join(ROOT, rel), 'utf8'),
        {
            __: tr(lang),
            lang,
            numFmt: KF.forLang(lang),
            csrfToken: 'tok123',
            colon: lang === 'fr' ? ' :' : ':',
            fmtDate: (d) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10),
            ...locals,
        },
        { filename: path.join(ROOT, rel) }
    );

const CTL = 'views/partials/idp-action-controls.ejs';

describe('the action controls', () => {
    const base = { id: 7, status: 'pending', type: 'training', title: 'x' };

    test('the person starts and reports done; no validate form for them', () => {
        const html = render(CTL, {
            action: base,
            info: { skillId: 3, skillName: 'Welding' },
            canAct: false,
            isSubject: true,
            planStatus: 'active',
            back: 'mine',
        });
        expect(html).toContain('action="/v2/idp/actions/7/start"');
        expect(html).toContain('action="/v2/idp/actions/7/done"');
        expect(html).not.toContain('/validate"');
        expect(html).toContain('name="back" value="mine"');
        expect(html).toContain('value="tok123"');
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    test('the line validates: "cannot judge yet" is the default, the required level is named', () => {
        const html = render(
            CTL,
            {
                action: {
                    ...base,
                    status: 'in_progress',
                    reportedDoneAt: '2027-01-05',
                    reportedNote: 'Done',
                },
                info: { skillId: 3, skillName: 'Welding', required: 3, current: 1 },
                canAct: true,
                isSubject: false,
                planStatus: 'active',
                courses: { list: [{ id: 11, title: 'Basics' }], bySkill: { 3: { 11: 2 } } },
            },
            'fr'
        );
        expect(html).toContain('action="/v2/idp/actions/7/validate"');
        expect(html).toMatch(/<option value="" selected>Je ne peux pas encore juger/);
        expect(html).not.toMatch(/<option value="[0-4]" selected/);
        expect(html).toContain('Niveau 3 — requis');
        expect(html).toContain('En attente de validation');
        expect(html).toContain('action="/v2/idp/actions/7/training"');
        expect(html).toContain('propose le niveau 2');
        expect(html).not.toContain('/done"');
    });

    test('a closed action says what was observed, and before what', () => {
        const html = render(CTL, {
            action: { ...base, status: 'completed', actualHours: 4 },
            info: { ratingPre: null, ratingPost: 3, validatedByName: 'A. Manager' },
            canAct: true,
            isSubject: false,
            planStatus: 'active',
        });
        expect(html).toContain('Observed level 3');
        expect(html).toContain('before: not assessed');
        expect(html).toContain('validated by A. Manager');
        expect(html).toContain('spent: 4 h');
        expect(html).not.toContain('<form');
    });
});

describe('the proposal page', () => {
    test('the form and the answers, the reason the person reads', () => {
        const html = render('views/pages/idp/propose.ejs', {
            skills: [{ id: 3, name: 'Welding', required: 3, current: null }],
            proposals: [
                {
                    id: 1,
                    status: 'declined',
                    actionType: 'mentoring',
                    text: 'Pair with a senior colleague',
                    createdAt: '2027-01-01',
                    decidedAt: '2027-01-03',
                    decisionReason: 'Next quarter',
                    decidedByName: 'A. Manager',
                    routedTo: 'line',
                },
            ],
            preSkillId: 3,
            actionTypes: ['training', 'mentoring'],
        });
        expect(html).toContain('action="/v2/idp/proposals"');
        expect(html).toContain(
            '<option value="3" selected>Welding — not assessed / required 3</option>'
        );
        expect(html).toContain('Declined');
        expect(html).toContain('« Next quarter »');
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });
});

describe('the development outcomes block', () => {
    test('« not entered », never 0 hours; counts only', () => {
        const O = {
            value: null,
            status: 'small_n',
            idp: { achieved: 2, notAchieved: 1, cancelled: 0, medianDays: 41 },
            coaching: { achieved: 1, cancelled: 1, medianDays: null },
            ageing: { upTo30: 1, upTo90: 0, over90: 2 },
            effort: {
                plannedHours: null,
                plannedMissing: 4,
                doneHours: null,
                doneMissing: 3,
                levelsValidated: 2,
                levelsPer100h: null,
            },
            lms: { status: 'not_configured' },
        };
        for (const lang of ['en', 'fr']) {
            const html = render('views/pages/dashboard/_dev-outcomes.ejs', { O }, lang);
            expect(html).toContain(lang === 'en' ? 'not entered' : 'non saisi');
            expect(html).not.toMatch(/>\s*0 h/);
            expect(html).not.toMatch(/kpi:[a-z0-9_]+/);
            expect(html).toContain(lang === 'en' ? 'To be set up' : 'À paramétrer');
        }
    });
});

describe('a machine-written objective in the reader’s language', () => {
    const t = tr('en');
    test('the four machine templates are recognised, a person’s text is kept', () => {
        expect(OT.parse('Développer « Soudure » du niveau 1 au niveau 3')).toEqual({
            skill: 'Soudure',
            from: 1,
            to: 3,
        });
        expect(OT.parse('Atteindre le niveau 2 en « Soudure » (niveau actuel non évalué)')).toEqual(
            { skill: 'Soudure', from: null, to: 2 }
        );
        expect(OT.display('Développer « Soudure » du niveau 1 au niveau 3', t)).toBe(
            'Develop "Soudure" from level 1 to 3'
        );
        expect(
            OT.display('Reach level 2 in "Lifting" (current level not assessed)', tr('fr'))
        ).toBe('Atteindre le niveau 2 en « Lifting » (niveau actuel non évalué)');
        expect(OT.display('Lead two inductions by March', t)).toBe('Lead two inductions by March');
        expect(OT.parse('Develop "X" from level 9 to 3')).toBeNull();
        expect(OT.parse('Develop "' + 'a'.repeat(5000))).toBeNull();
    });
});
