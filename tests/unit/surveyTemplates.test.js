'use strict';
/**
 * Survey templates (db/postgres/seed-data/survey-templates.json) and
 * SurveyService.templates / template / createFromTemplate, plus the
 * "Start from a template" select of the talent-suite survey builder.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const Sv = require('../../src/services/SurveyService');

const ROOT = path.join(__dirname, '..', '..');
const RAW = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'db', 'postgres', 'seed-data', 'survey-templates.json'), 'utf8')
);

describe('survey-templates.json', () => {
    test('has the four expected templates with a supported kind', () => {
        const ids = RAW.templates.map((t) => t.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                'enps',
                'engagement-pulse',
                'onboarding-checkin',
                'manager-effectiveness',
            ])
        );
        expect(new Set(ids).size).toBe(ids.length);
        for (const t of RAW.templates) {
            expect(['engagement', 'enps', 'pulse', 'onboarding', 'exit']).toContain(t.kind);
        }
        expect(RAW.license).toBe('CC0-1.0');
    });

    test('every title, description and question is bilingual FR/EN and non-empty', () => {
        for (const t of RAW.templates) {
            for (const field of [t.title, t.description]) {
                expect(Object.keys(field).sort()).toEqual(['en', 'fr']);
                expect(field.fr.trim()).not.toBe('');
                expect(field.en.trim()).not.toBe('');
            }
            for (const q of t.questions) {
                expect(Object.keys(q.text).sort()).toEqual(['en', 'fr']);
                expect(q.text.fr.trim()).not.toBe('');
                expect(q.text.en.trim()).not.toBe('');
                expect(q.text.fr.length).toBeLessThanOrEqual(500);
                expect(q.text.en.length).toBeLessThanOrEqual(500);
                expect(['scale', 'nps', 'text']).toContain(q.qtype);
            }
        }
    });

    test('the engagement pulse has 8 to 10 items; eNPS has an nps question', () => {
        const pulse = RAW.templates.find((t) => t.id === 'engagement-pulse');
        expect(pulse.questions.length).toBeGreaterThanOrEqual(8);
        expect(pulse.questions.length).toBeLessThanOrEqual(10);
        const enps = RAW.templates.find((t) => t.id === 'enps');
        expect(enps.questions.some((q) => q.qtype === 'nps')).toBe(true);
    });

    test('every template passes the service question validation', () => {
        for (const lang of ['fr', 'en']) {
            for (const t of Sv.templates(lang)) {
                expect(() => Sv.normaliseQuestions(t.questions)).not.toThrow();
            }
        }
    });

    test('UK English spelling in the English strings', () => {
        const en = JSON.stringify(
            RAW.templates.map((t) => [
                t.title.en,
                t.description.en,
                t.questions.map((q) => q.text.en),
            ])
        );
        expect(en).not.toMatch(
            /\b(organization|recognized|recognizes|recognize|center|program)\b/i
        );
    });
});

describe('SurveyService templates', () => {
    test('templates() localises to French by default and to English for en-*', () => {
        const fr = Sv.templates();
        const en = Sv.templates('en-GB');
        expect(fr).toHaveLength(RAW.templates.length);
        const fe = fr.find((t) => t.id === 'engagement-pulse');
        const ee = en.find((t) => t.id === 'engagement-pulse');
        expect(fe.title).toBe("Baromètre d'engagement");
        expect(ee.title).toBe('Engagement pulse');
        expect(ee.questions[0]).toEqual({
            text: 'I clearly understand what is expected of me in my role.',
            qtype: 'scale',
            category: 'clarity',
        });
        expect(Sv.templates('de')[0].title).toBe(fr[0].title);
    });

    test('templates() returns copies a caller cannot use to corrupt the cache', () => {
        Sv.templates('en')[0].questions.length = 0;
        expect(Sv.templates('en')[0].questions.length).toBeGreaterThan(0);
    });

    test('template(id) finds one, or null', () => {
        expect(Sv.template('enps', 'en').kind).toBe('enps');
        expect(Sv.template('nope')).toBeNull();
    });

    test('createFromTemplate inserts a draft with the template kind and questions', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 77, minResponses: 5 });
        mockDb.run.mockResolvedValue({ changes: 1 });
        const s = await Sv.createFromTemplate('manager-effectiveness', {
            lang: 'en',
            createdByAdminId: 3,
            anonymous: true,
        });
        expect(s.id).toBe(77);
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO surveys/);
        expect(params).toEqual(['pulse', 'Manager effectiveness', true, 5, 3, null]);
        const tpl = RAW.templates.find((t) => t.id === 'manager-effectiveness');
        expect(mockDb.run).toHaveBeenCalledTimes(tpl.questions.length);
        const first = mockDb.run.mock.calls[0][1];
        expect(first).toEqual([
            77,
            0,
            'My manager gives me regular, useful feedback.',
            'scale',
            'feedback',
        ]);
    });

    test('createFromTemplate: a given title wins, the anonymity floor still applies', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 78 });
        mockDb.run.mockResolvedValue({ changes: 1 });
        await Sv.createFromTemplate('enps', { lang: 'fr', title: '  eNPS T4  ', minResponses: 1 });
        const params = mockDb.get.mock.calls[0][1];
        expect(params[0]).toBe('enps');
        expect(params[1]).toBe('eNPS T4');
        expect(params[3]).toBe(5);
    });

    test('createFromTemplate refuses an unknown template with 404', async () => {
        await expect(Sv.createFromTemplate('does-not-exist')).rejects.toMatchObject({
            status: 404,
            code: 'survey_template_not_found',
        });
        expect(mockDb.get).not.toHaveBeenCalled();
    });
});

describe('survey builder view', () => {
    const view = fs.readFileSync(
        path.join(ROOT, 'views', 'pages', 'capability', 'index.ejs'),
        'utf8'
    );

    test('offers "Start from a template" and every key it uses exists in fr and en', () => {
        expect(view).toMatch(/id="svy-template"/);
        expect(view).toMatch(/applyTemplate/);
        const keys = ['cap_svy_template', 'cap_svy_template_none', 'cap_svy_template_hint'];
        for (const lang of ['fr', 'en']) {
            const loc = JSON.parse(
                fs.readFileSync(path.join(ROOT, 'locales', lang, 'talentx.json'), 'utf8')
            );
            for (const k of keys) {
                expect(view).toContain(`talentx:${k}`);
                expect(typeof loc[k]).toBe('string');
                expect(loc[k].trim()).not.toBe('');
            }
        }
    });
});
