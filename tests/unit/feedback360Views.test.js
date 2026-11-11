'use strict';
/**
 * 360° feedback and one-to-one pages — rendered for real (ejs + i18next, FR and
 * EN) with service-shaped models, so a template error, a missing key or a raw
 * key on screen fails here rather than in front of a user.
 *
 *   - every page renders in both languages, and no catalogue key leaks as text;
 *   - literal keys only (no computed `__()` key), each present in FR and EN;
 *   - FR/EN key parity for the namespaces these pages use;
 *   - no inline uppercase; new CSS is scoped under :root .hz-360 / .hz-oneone;
 *   - the report page never receives or prints a rater's identity (it is built
 *     from Feedback360Report, which has none to give).
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const Report = require('../../src/services/Feedback360Report');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VIEWS = [
    'views/pages/feedback360/index.ejs',
    'views/pages/feedback360/manage.ejs',
    'views/pages/feedback360/round.ejs',
    'views/pages/feedback360/subject.ejs',
    'views/pages/feedback360/answer.ejs',
    'views/pages/feedback360/report.ejs',
    'views/pages/oneonone/space.ejs',
    'views/pages/oneonone/_actions.ejs',
];
const NS = ['common', 'chrome', 'talentx', 'growth'];

let T;
beforeAll(async () => {
    const inst = i18next.createInstance();
    await inst.use(Backend).init({
        fallbackLng: 'fr',
        supportedLngs: ['fr', 'en'],
        preload: ['fr', 'en'],
        ns: NS,
        defaultNS: 'common',
        initImmediate: false,
        backend: { loadPath: path.join(ROOT, 'locales', '{{lng}}/{{ns}}.json') },
        interpolation: { escapeValue: false },
    });
    T = { fr: inst.getFixedT('fr'), en: inst.getFixedT('en') };
});

function render(file, lang, model) {
    const abs = path.join(ROOT, file);
    return ejs.render(
        fs.readFileSync(abs, 'utf8'),
        {
            __: (k, o) => T[lang](k, o),
            fmtDate: (d) => (d ? String(d).slice(0, 10) : ''),
            fmtDateTime: (d) => (d ? String(d).slice(0, 16) : ''),
            csrfToken: 'tok',
            cspNonce: 'n',
            lang,
            appModules: { development: true, engagement: true },
            ...model,
        },
        { filename: abs }
    );
}

const round = {
    id: 3,
    title: 'Q3 360',
    kind: 'individual',
    status: 'closed',
    deadline: '2026-10-20',
    minRaters: 3,
    threshold: 3,
    releaseMode: 'manager',
    behaviours: [],
    closedAt: '2026-10-21',
};
const subject = {
    id: 11,
    roundId: 3,
    employeeId: 5,
    managerEmployeeId: 4,
    status: 'closed',
    name: 'Ada Subject',
    managerName: 'Max Manager',
    releasedAt: null,
    round,
};
const subjectView = (over = {}) => ({
    subject,
    role: { isSubject: false, isManager: true, isHr: false, isLauncher: true, canWrite: true },
    counts: { self: 1, manager: 1, peer: 3, direct_report: 2, other: 0 },
    nominations: [
        {
            id: 1,
            employeeId: 6,
            name: 'Pat Peer',
            group: 'peer',
            status: 'approved',
            responded: true,
        },
        {
            id: 2,
            employeeId: 7,
            name: 'Dee Report',
            group: 'direct_report',
            status: 'proposed',
            responded: false,
        },
    ],
    canNominate: false,
    canApprove: true,
    canRelease: true,
    reportReady: true,
    reportVisible: true,
    ...over,
});
const items = [
    { type: 'skill', key: '1', label: 'Welding', required: 3 },
    { type: 'behaviour', key: 'b_listens', label: 'Listens' },
];
const resp = (group, a, b, c) => ({
    group,
    answers: [
        { itemType: 'skill', itemKey: '1', rating: a },
        { itemType: 'behaviour', itemKey: 'b_listens', rating: b },
        ...(c ? [{ itemType: 'comment', itemKey: 'keep', body: c }] : []),
    ],
});
const built = () =>
    Report.buildReport({
        items,
        threshold: 3,
        responses: [
            resp('self', 4, 3, 'mine'),
            resp('manager', 2, 'na'),
            resp('peer', 2, 2, 'good'),
            resp('peer', 2, 3),
            resp('peer', 3, 2),
            resp('direct_report', 0, 0, 'hidden'),
            resp('direct_report', 0, 0),
        ],
    });
const report = (isSubject) => ({
    subject: { id: 11, name: 'Ada Subject', managerName: 'Max Manager' },
    round: {
        id: 3,
        title: 'Q3 360',
        deadline: '2026-10-20',
        closedAt: '2026-10-21',
        releaseMode: 'manager',
    },
    released: isSubject,
    viewer: { isSubject },
    ...built(),
});
const space = (role) => ({
    role,
    canWrite: role !== 'hr',
    employee: { id: 5, name: 'Ada Subject' },
    manager: { id: 4, name: 'Max Manager' },
    next: {
        id: 21,
        status: 'scheduled',
        scheduledAt: '2026-10-02T09:00:00Z',
        occurredAt: null,
        withName: 'Max Manager',
        agenda: [
            { id: 1, body: 'Training budget', discussed: false, author: 'Ada Subject', mine: true },
        ],
        shared: [{ author: 'Max Manager', mine: false, body: 'Shared words', updatedAt: null }],
        mine: role === 'hr' ? null : { body: 'My private words', updatedAt: null },
        actions: [
            {
                id: 9,
                body: 'Book the course',
                done: false,
                dueOn: '2026-11-01',
                owner: 'Ada Subject',
                ownerId: 5,
                goal: { id: 1, title: 'Reduce rework' },
                objective: null,
            },
        ],
    },
    history: [
        {
            id: 20,
            status: 'completed',
            scheduledAt: null,
            occurredAt: '2026-09-01T09:00:00Z',
            withName: 'Max Manager',
            agenda: [],
            shared: [],
            mine: null,
            actions: [],
        },
    ],
    openActions: [],
    links: {
        objectives: [{ id: 2, text: 'Reach level 3 in Welding' }],
        goals: [{ id: 1, title: 'Reduce rework' }],
    },
});

const MODELS = {
    'views/pages/feedback360/index.ejs': () => ({
        isStaff: true,
        home: {
            toAnswer: [
                {
                    nominationId: 1,
                    group: 'peer',
                    subjectName: 'Ada Subject',
                    title: 'Q3',
                    deadline: '2026-10-20',
                },
                {
                    nominationId: 2,
                    group: 'self',
                    subjectName: null,
                    title: 'Q3',
                    deadline: '2026-10-20',
                },
            ],
            toApprove: [subject],
            asSubject: [{ ...subject, reportVisible: true }],
        },
    }),
    'views/pages/feedback360/manage.ejs': () => ({
        canLaunch: true,
        candidates: [{ id: 5, firstName: 'Ada', lastName: 'Subject', employeeNumber: 'E5' }],
        rounds: [
            {
                id: 3,
                title: 'Q3',
                kind: 'campaign',
                status: 'open',
                deadline: '2026-10-20',
                subjects: 4,
                raters: 20,
                responded: 7,
            },
        ],
        defaults: { deadline: '2026-10-20', minRaters: 3, threshold: 3 },
    }),
    'views/pages/feedback360/round.ejs': () => ({
        view: { round: { ...round, status: 'open' }, canClose: true, subjects: [subjectView()] },
    }),
    'views/pages/feedback360/subject.ejs': () => ({
        view: subjectView(),
        groups: ['peer', 'direct_report', 'other'],
    }),
    'views/pages/feedback360/answer.ejs': () => ({
        q: {
            nominationId: 1,
            group: 'peer',
            responded: false,
            open: true,
            subjectName: 'Ada Subject',
            round: { title: 'Q3', deadline: '2026-10-20' },
            skills: [{ key: '1', label: 'Welding' }],
            behaviours: [{ key: 'b_listens', label: 'Listens' }],
            comments: ['keep', 'start', 'stop'],
        },
    }),
    'views/pages/feedback360/report.ejs': () => ({
        report: report(true),
        view: subjectView({ canRelease: false }),
    }),
    'views/pages/oneonone/space.ejs': () => ({ space: space('employee') }),
    'views/pages/oneonone/_actions.ejs': () => ({ list: space('manager').next.actions, W: true }),
};

describe('the pages render in FR and EN, with no raw key on screen', () => {
    test.each(
        VIEWS.flatMap((v) => [
            [v, 'fr'],
            [v, 'en'],
        ])
    )('%s (%s)', (file, lang) => {
        const html = render(file, lang, MODELS[file]());
        expect(html.length).toBeGreaterThan(100);
        expect(html).not.toMatch(/\b(talentx|growth|chrome|common):[a-z0-9_]+/);
    });

    test('the manager’s report shows the release form; the subject’s the IDP form', () => {
        const mgr = render('views/pages/feedback360/report.ejs', 'en', {
            report: report(false),
            view: subjectView(),
        });
        expect(mgr).toContain('/feedback-360/subjects/11/release');
        expect(mgr).not.toContain('/feedback-360/subjects/11/idp');
        const own = render(
            'views/pages/feedback360/report.ejs',
            'en',
            MODELS['views/pages/feedback360/report.ejs']()
        );
        expect(own).toContain('/feedback-360/subjects/11/idp');
        expect(own).toContain('name="skillIds" value="1" checked'); // blind spot pre-ticked
        // The hidden direct-report group's comment never reaches the page.
        expect(own).not.toContain('hidden</li>');
        expect(own).toContain('Blind spot');
    });

    test('HR reads the one-to-one space without a single form', () => {
        const html = render('views/pages/oneonone/space.ejs', 'en', { space: space('hr') });
        expect(html).not.toMatch(/<form /);
        expect(html).not.toContain('My private words');
        expect(html).toContain('Shared words');
    });

    test('"Not observed" is an answer of its own on the questionnaire', () => {
        const html = render(
            'views/pages/feedback360/answer.ejs',
            'en',
            MODELS['views/pages/feedback360/answer.ejs']()
        );
        expect(html).toContain('name="r__skill__1" value="na" checked');
        expect(html).toContain('Not observed');
    });
});

describe('i18n discipline', () => {
    test.each(VIEWS)('%s: literal keys only, each in FR and EN', (file) => {
        const src = read(file);
        expect(src).not.toMatch(/__\(\s*[^'\s]/); // no computed key
        const keys = [...src.matchAll(/__\('([a-z]+):([A-Za-z0-9_]+)'/g)];
        expect(keys.length).toBeGreaterThan(0);
        for (const [, ns, k] of keys) {
            for (const lng of ['fr', 'en']) {
                const cat = JSON.parse(read(`locales/${lng}/${ns}.json`));
                expect(`${lng}/${ns}:${k}:${Boolean(cat[k])}`).toBe(`${lng}/${ns}:${k}:true`);
            }
        }
    });

    test.each(['talentx', 'growth', 'chrome'])('%s.json: FR and EN carry the same keys', (ns) => {
        const fr = Object.keys(JSON.parse(read(`locales/fr/${ns}.json`))).sort();
        const en = Object.keys(JSON.parse(read(`locales/en/${ns}.json`))).sort();
        expect(fr).toEqual(en);
    });

    test('UK English in the new strings', () => {
        const en = {
            ...JSON.parse(read('locales/en/talentx.json')),
            ...JSON.parse(read('locales/en/growth.json')),
        };
        const mine = Object.entries(en).filter(([k]) => /^(f360_|oo_)/.test(k));
        expect(mine.length).toBeGreaterThan(200);
        for (const [k, v] of mine)
            expect(
                `${k}: ${/\b(behavior|color|organization|favorite|center|analyze)/i.test(v)}`
            ).toBe(`${k}: false`);
    });
});

describe('styles', () => {
    test.each(VIEWS)('%s: no inline uppercase', (file) => {
        expect(read(file)).not.toMatch(/text-transform\s*:\s*uppercase/i);
    });

    test('the new rules of horizon.css are scoped under :root .hz-360 / .hz-oneone', () => {
        const css = read('public/css/horizon.css');
        const from = css.indexOf('/* ── 360° feedback (views/pages/feedback360)');
        // The 360 / one-to-one block ends where the next section header starts.
        const next = css.indexOf('/* ── SSO change page', from);
        const tail = css.slice(from, next > from ? next : undefined);
        expect(tail.length).toBeGreaterThan(500);
        const selectors = tail
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('}')
            .map((b) => b.split('{')[0].trim())
            .filter(Boolean)
            .flatMap((s) => s.split(',').map((x) => x.trim()));
        for (const s of selectors) expect(s).toMatch(/^:root \.hz-(360|oneone)/);
        expect(tail).not.toMatch(/text-transform\s*:\s*uppercase/i);
    });
});
