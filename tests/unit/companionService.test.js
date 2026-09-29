'use strict';
/**
 * AI companion (CompanionService + /api/companion) — database faked.
 *
 *  - intent routing, FR and EN (capabilities, next, page, self, data, concept, howto);
 *  - role filtering: an employee never gets a manager/admin link, never reaches the
 *    copilot, and every personal query is keyed on their OWN id only;
 *  - deterministic by default (no LLM configured → no outbound call);
 *  - a non-EU provider with copilot.eu_only_providers on → deterministic, no call;
 *  - with an allowed model: rephrased answer + disclaimer, fallback on error, and
 *    the prompt carries no personal data;
 *  - managers/admins' data questions are delegated to CopilotService.ask;
 *  - audit without raw text;
 *  - knowledge-base integrity: fr+en everywhere, every link a real route, every
 *    canonical question routes back to its entry;
 *  - routes: auth, validation, disabled switch, suggestions;
 *  - locale parity + namespace registration + the settings row.
 */
const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { findByKey: jest.fn(), getValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn().mockResolvedValue(null) }));

const ROOT = path.resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const Companion = require('../../src/services/CompanionService');
const Copilot = require('../../src/services/CopilotService');
const K = require('../../src/config/companionKnowledge');

const EMPLOYEE = {
    id: 41,
    userType: 'employee',
    firstName: 'Mireille',
    lastName: 'QUASIMODO',
    username: 'mquasimodo',
    email: 'mireille.quasimodo@example.test',
};
const MANAGER = { id: 42, userType: 'manager', firstName: 'Ode', lastName: 'VANTER' };
const SUPERADMIN = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCALADMIN = { id: 7, userType: 'admin', role: 'localadmin', permissions: ['view_roles'] };

/** Settings map → mocked AppSettingsModel. */
function settings(map = {}) {
    mockSettings.findByKey.mockImplementation(async (k) =>
        k in map ? { settingKey: k, settingValue: String(map[k]) } : null
    );
    mockSettings.getValue.mockImplementation(async (k, fb) => (k in map ? map[k] : fb));
}

/** A database where the employee has to-dos, a role, readiness and gaps. */
function wireEmployeeData() {
    mockDb.get.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/workflow_state = 'changes_requested'/.test(s)) return { c: 2 };
        if (/JOIN roles r/.test(s)) return { roleName: 'Field Technician' };
        if (/v_employee_assessment_coverage/.test(s))
            return { readinessAssessedOnly: 72.4, assessedSkills: 8, expectedSkills: 10 };
        return { c: 0 };
    });
    mockDb.all.mockImplementation(async (sql) => {
        if (/v_employee_skill_gaps/.test(String(sql)))
            return [
                { skillName: 'Blasting', isAssessed: 1, isCritical: true, gap: 2 },
                { skillName: 'Drilling', isAssessed: 1, isCritical: false, gap: 1 },
                { skillName: 'Welding', isAssessed: 1, isCritical: false, gap: 0 },
                { skillName: 'Budget', isAssessed: 0, isCritical: false, gap: null },
            ];
        return [];
    });
}

const allHrefs = (out) => (out.links || []).map((l) => l.href);

beforeEach(() => {
    process.env.V2_FEATURES = '1';
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockLog.log.mockReset().mockResolvedValue(undefined);
    settings({});
    Copilot.invalidate();
});
afterAll(() => {
    delete process.env.V2_FEATURES;
});

// ─────────────────────────────────────────────────────────────────────────
describe('intent routing (FR + EN)', () => {
    const cases = [
        ['What can you do?', 'capabilities'],
        ['Que peux-tu faire ?', 'capabilities'],
        ['What should I do next?', 'next'],
        ['Que dois-je faire maintenant ?', 'next'],
        ['Explain this page', 'page'],
        ['Explique-moi cette page', 'page'],
        ['What is my readiness?', 'self'],
        ['Quelle est ma préparation ?', 'self'],
        ['What is readiness?', 'concept'],
        ['Que veut dire « non mesuré » ?', 'concept'],
        ['Qu’est-ce qu’un écart de compétence ?', 'concept'],
        ['What is a critical skill?', 'concept'],
        ['C’est quoi le 9-box ?', 'concept'],
        ['What is a dispute?', 'concept'],
        ['Qu’est-ce qu’une campagne ?', 'concept'],
        ['What is an IDP?', 'concept'],
        ['What is succession planning?', 'concept'],
        ['How do I change my password?', 'howto'],
        ['Comment faire mon auto-évaluation ?', 'howto'],
        ['zzzz qwerty', 'fallback'],
    ];
    test.each(cases)('%s → %s', (q, intent) => {
        expect(Companion.detectIntent(MANAGER, q).intent).toBe(intent);
    });

    test('concepts resolve to the right definition', () => {
        const c = (q) => Companion.detectIntent(EMPLOYEE, q).concept.id;
        expect(c('What is readiness?')).toBe('readiness');
        expect(c('Que veut dire « non mesuré » ?')).toBe('not_measured');
        expect(c('What is a skill gap?')).toBe('gap');
        expect(c('Qu’est-ce qu’une compétence critique ?')).toBe('critical');
        expect(c('What is the 9-box?')).toBe('ninebox');
        expect(c('Qu’est-ce qu’une contestation ?')).toBe('dispute');
        expect(c('What is a campaign?')).toBe('campaign');
        expect(c('Qu’est-ce qu’un PDI ?')).toBe('idp');
        expect(c('What is succession?')).toBe('succession');
    });

    test('a population question is data for a manager, refused for an employee', () => {
        for (const q of [
            'What is the readiness by site?',
            'Who is at flight risk?',
            'Quels sont nos principaux écarts de compétences ?',
            'Combien de personnes ne sont pas évaluées ?',
        ]) {
            expect(Companion.detectIntent(MANAGER, q).intent).toBe('data');
            expect(Companion.detectIntent(SUPERADMIN, q).intent).toBe('data');
            expect(Companion.detectIntent(EMPLOYEE, q).intent).toBe('data_denied');
        }
    });

    test('answers follow the requested language', async () => {
        const fr = await Companion.ask(EMPLOYEE, 'How do I change my password?', { lng: 'fr' });
        const en = await Companion.ask(EMPLOYEE, 'How do I change my password?', { lng: 'en' });
        expect(fr.answer).toMatch(/mot de passe/);
        expect(en.answer).toMatch(/password/);
        expect(en.links[0]).toEqual({ label: 'Change my password', href: '/change-password' });
        expect(fr.source).toBe('kb');
        expect(fr.disclaimer).toBeNull();
    });

    test('"explain this page" uses the current path (ids ignored)', async () => {
        const out = await Companion.ask(SUPERADMIN, 'Explain this page', {
            lng: 'en',
            path: '/roles/12?tab=x',
        });
        expect(out.intent).toBe('page');
        expect(out.answer).toMatch(/^You are on “Roles & requirements”\./);
        const unknown = await Companion.ask(EMPLOYEE, 'Explain this page', {
            lng: 'en',
            path: '/nowhere/at/all',
        });
        expect(unknown.answer).toMatch(/no specific guide/);
    });

    test('every answer has the documented shape', async () => {
        for (const q of ['What can you do?', 'What is a gap?', 'blah', 'What should I do next?']) {
            const out = await Companion.ask(MANAGER, q, { lng: 'en', path: '/dashboard' });
            expect(Object.keys(out).sort()).toEqual(
                ['answer', 'disclaimer', 'intent', 'links', 'source', 'suggestions'].sort()
            );
            expect(['kb', 'actions', 'copilot', 'llm']).toContain(out.source);
            expect(Array.isArray(out.suggestions)).toBe(true);
            expect(typeof out.answer).toBe('string');
            expect(out.answer.length).toBeGreaterThan(0);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('next best actions', () => {
    test('employee: their own to-dos, from their own id only', async () => {
        wireEmployeeData();
        const out = await Companion.ask(EMPLOYEE, 'What should I do next?', {
            lng: 'en',
            translate: (k, fb) => fb,
        });
        expect(out.source).toBe('actions');
        expect(out.answer).toMatch(/Self-assessment changes requested: 2/);
        expect(allHrefs(out)).toContain('/employee/self-assessment');
        for (const [, params] of mockDb.get.mock.calls) expect(params).toEqual([EMPLOYEE.id]);
    });

    test('superadmin: remaining setup steps with links', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM sites WHERE is_active/.test(String(sql)))
                return {
                    sites: 1,
                    departments: 1,
                    services: 1,
                    skills: 5,
                    roles: 0,
                    rolesWithReq: 0,
                    employees: 0,
                    noReviewer: 0,
                    noEmail: 0,
                    openCycles: 0,
                    assessments: 0,
                };
            return { c: 0 };
        });
        const out = await Companion.ask(SUPERADMIN, 'Que dois-je faire maintenant ?', {
            lng: 'fr',
        });
        expect(out.answer).toMatch(/Mise en route : 2 étape\(s\) obligatoire\(s\) sur 6/);
        expect(out.answer).toMatch(/Créer les postes et fixer leurs exigences/);
        expect(allHrefs(out)).toEqual(expect.arrayContaining(['/roles', '/employees']));
    });

    test('nothing pending → a role-appropriate next step', async () => {
        mockDb.get.mockResolvedValue({ c: 0 });
        const out = await Companion.ask(EMPLOYEE, 'What should I do next?', { lng: 'en' });
        expect(out.answer).toMatch(/Nothing is waiting for you right now/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('role filtering — an employee never gets admin links or other people’s data', () => {
    const MANAGER_OR_ADMIN_LINKS = new Set(
        K.ENTRIES.filter((e) => !e.roles.includes('employee')).map((e) => e.link)
    );
    const employeeQuestions = () => [
        ...K.ENTRIES.flatMap((e) => [e.ask.fr, e.ask.en]),
        ...K.CONCEPTS.flatMap((c) => [`What is ${c.title.en}?`, `Qu’est-ce que ${c.title.fr} ?`]),
        'What is the readiness by site?',
        'Who is at flight risk?',
        'Qui sont les plus faibles de mon équipe ?',
        'Combien de PIP ouverts ?',
        'Show me Alan TURING readiness',
        'What can you do?',
        'Explain this page',
    ];

    test('no manager/admin link, no copilot, whatever the question', async () => {
        wireEmployeeData();
        const spy = jest.spyOn(Copilot, 'ask');
        for (const q of employeeQuestions()) {
            const out = await Companion.ask(EMPLOYEE, q, {
                lng: 'en',
                path: '/employee/dashboard',
            });
            for (const h of allHrefs(out)) {
                expect(MANAGER_OR_ADMIN_LINKS.has(h)).toBe(false);
                expect(h).not.toMatch(
                    /^\/(admin|app-settings|setup|organization|roles|system-logs|data-management|cycles|employees|dashboard|v2\/pip|talent)/
                );
            }
            expect(out.source).not.toBe('copilot');
        }
        expect(spy).not.toHaveBeenCalled();
    });

    test('every personal query is keyed on the employee’s own id', async () => {
        wireEmployeeData();
        await Companion.ask(EMPLOYEE, 'What is my readiness?', { lng: 'en' });
        await Companion.ask(EMPLOYEE, 'What should I do next?', { lng: 'en' });
        await Companion.ask(EMPLOYEE, 'Who is at flight risk?', { lng: 'en' });
        const calls = [...mockDb.get.mock.calls, ...mockDb.all.mock.calls];
        expect(calls.length).toBeGreaterThan(0);
        for (const [sql, params] of calls) {
            expect(params).toEqual([EMPLOYEE.id]);
            expect(String(sql)).not.toMatch(/ANY\(\?\)|getFilteredEmployees/);
        }
    });

    test('own summary: readiness with its denominator, gaps vs not measured', async () => {
        wireEmployeeData();
        const out = await Companion.ask(EMPLOYEE, 'Quelle est ma préparation ?', { lng: 'fr' });
        expect(out.source).toBe('actions');
        expect(out.answer).toMatch(/Poste : Field Technician\./);
        expect(out.answer).toMatch(/72 % sur les 8 exigences évaluées sur 10/);
        expect(out.answer).toMatch(
            /2 écart\(s\) mesuré\(s\), dont 1 critique\(s\) ; 2 exigence\(s\) pas encore mesurée\(s\)/
        );
        expect(out.answer).toMatch(/Blasting, Drilling/);
        expect(out.answer).not.toMatch(/Budget/); // unmeasured is never a gap
    });

    test('nothing assessed → "not measured", never 0 %', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /v_employee_assessment_coverage/.test(String(sql))
                ? { readinessAssessedOnly: null, assessedSkills: 0, expectedSkills: 12 }
                : null
        );
        const out = await Companion.ask(EMPLOYEE, 'What is my readiness?', { lng: 'en' });
        expect(out.answer).toMatch(/not measured yet: none of your 12 requirements/);
        expect(out.answer).not.toMatch(/readiness is 0|0 % over/);
        expect(out.answer).toMatch(/0 measured gap\(s\).*12 requirement\(s\) not measured/);
    });

    test('a local admin only gets links their permissions open', () => {
        const hrefs = K.ENTRIES.filter((e) => Companion.canSee(LOCALADMIN, e)).map((e) => e.link);
        expect(hrefs).toContain('/roles');
        expect(hrefs).not.toContain('/app-settings');
        expect(hrefs).not.toContain('/setup');
        expect(hrefs).not.toContain('/employee/self-assessment');
        const sa = K.ENTRIES.filter((e) => Companion.canSee(SUPERADMIN, e)).map((e) => e.link);
        expect(sa).toEqual(expect.arrayContaining(['/app-settings', '/setup', '/admin/health']));
    });

    test('V2-only screens are not offered when V2 features are off', () => {
        process.env.V2_FEATURES = '0';
        const hrefs = K.ENTRIES.filter((e) => Companion.canSee(MANAGER, e)).map((e) => e.link);
        expect(hrefs).not.toContain('/v2/pip');
        expect(hrefs).toContain('/coaching/plans');
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('data questions — managers/admins delegate to the copilot', () => {
    test('manager: CopilotService.ask answers, with the AI disclaimer', async () => {
        const spy = jest.spyOn(Copilot, 'ask').mockResolvedValue({
            answer: 'Average readiness is 70%.',
            mode: 'deterministic',
            disclaimer: Copilot.AI_DISCLAIMER.en,
            disclaimerKey: Copilot.AI_DISCLAIMER.key,
        });
        const out = await Companion.ask(MANAGER, 'What is the readiness by site?', {
            lng: 'en',
            translate: (k, fb) => (k === 'talentx:cap_ai_disclaimer' ? 'LABEL-' + k : fb),
        });
        expect(spy).toHaveBeenCalledWith(MANAGER, 'What is the readiness by site?');
        expect(out.source).toBe('copilot');
        expect(out.answer).toBe('Average readiness is 70%.');
        expect(out.disclaimer).toBe('LABEL-talentx:cap_ai_disclaimer');
    });

    test('a copilot failure degrades to a friendly message', async () => {
        jest.spyOn(Copilot, 'ask').mockRejectedValue(new Error('db down'));
        const out = await Companion.ask(SUPERADMIN, 'Who is at flight risk?', { lng: 'en' });
        expect(out.answer).toMatch(/could not answer just now/);
        expect(out.source).toBe('kb');
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('optional LLM mode', () => {
    test('no LLM configured (default) → deterministic, nothing is called', async () => {
        const spy = jest.spyOn(Copilot, '_callLlm');
        const out = await Companion.ask(EMPLOYEE, 'How do I change my password?', { lng: 'en' });
        expect(out.source).toBe('kb');
        expect(out.disclaimer).toBeNull();
        expect(spy).not.toHaveBeenCalled();
    });

    test('non-EU provider with copilot.eu_only_providers on → deterministic, nothing is called', async () => {
        settings({ copilotProvider: 'openai', copilotApiSecret: 'sk-x' });
        const spy = jest.spyOn(Copilot, '_callLlm');
        const out = await Companion.ask(EMPLOYEE, 'What is a skill gap?', { lng: 'en' });
        expect(out.source).toBe('kb');
        expect(spy).not.toHaveBeenCalled();
        expect(await Copilot.llmUsable()).toBe(false);
    });

    test('allowed model → rephrased answer with the disclaimer; error → deterministic', async () => {
        settings({ copilotProvider: 'ollama' });
        jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(true);
        const spy = jest.spyOn(Copilot, '_callLlm').mockResolvedValue('Rephrased answer.');
        const out = await Companion.ask(EMPLOYEE, 'How do I change my password?', { lng: 'en' });
        expect(out.source).toBe('llm');
        expect(out.answer).toBe('Rephrased answer.');
        expect(out.disclaimer).toMatch(/decision support only/);
        expect(out.links[0].href).toBe('/change-password');
        spy.mockRejectedValue(new Error('LLM timed out after 10000ms'));
        const fb = await Companion.ask(EMPLOYEE, 'How do I change my password?', { lng: 'en' });
        expect(fb.source).toBe('kb');
        expect(fb.answer).toMatch(/at least 12 characters/);
        expect(fb.disclaimer).toBeNull();
    });

    test('the prompt carries the question, the snippets and the path — no personal data', async () => {
        settings({ copilotProvider: 'ollama' });
        wireEmployeeData();
        jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(false);
        const spy = jest.spyOn(Copilot, '_callLlm').mockResolvedValue('ok');
        await Companion.ask(
            EMPLOYEE,
            'Hi, I am Mireille QUASIMODO (mireille.quasimodo@example.test, staff 123456): how do I change my password?',
            { lng: 'en', path: '/employees/41/assessments' }
        );
        expect(spy).toHaveBeenCalledTimes(1);
        const [, system, prompt] = spy.mock.calls[0];
        const sent = system + '\n' + prompt;
        for (const forbidden of [
            'Mireille',
            'QUASIMODO',
            'mquasimodo',
            'mireille.quasimodo@example.test',
            '123456',
            '/employees/41',
            'Field Technician',
            'Blasting',
            '72',
        ])
            expect(sent).not.toContain(forbidden);
        expect(prompt).toMatch(/Page: \/employees\/:id\/assessments/);
        expect(prompt).toMatch(/at least 12 characters/); // the knowledge snippet
        expect(prompt).toMatch(/how do I change my password\?/);
    });

    test('personal answers (to-dos, own readiness) never go to the model', async () => {
        settings({ copilotProvider: 'ollama' });
        wireEmployeeData();
        jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(true);
        const spy = jest.spyOn(Copilot, '_callLlm').mockResolvedValue('nope');
        const a = await Companion.ask(EMPLOYEE, 'What should I do next?', { lng: 'en' });
        const b = await Companion.ask(EMPLOYEE, 'What is my readiness?', { lng: 'en' });
        expect(a.source).toBe('actions');
        expect(b.source).toBe('actions');
        expect(spy).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('audit', () => {
    test('each question is logged as COMPANION_QUERY without its raw text', async () => {
        await Companion.ask(EMPLOYEE, 'How do I change my password? secret-phrase', {
            lng: 'en',
            path: '/employees/41',
        });
        const entries = mockLog.log.mock.calls.map(([e]) => e);
        const audit = entries.find((e) => e.action === 'COMPANION_QUERY');
        expect(audit).toBeTruthy();
        expect(audit.actorRef).toBe('employee:41');
        expect(audit.details).not.toMatch(/secret-phrase|password\?/);
        const meta = JSON.parse(audit.details.slice(audit.details.indexOf('{')));
        expect(meta.questionSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(meta.intent).toBe('howto');
        expect(meta.path).toBe('/employees/:id');
        expect(meta.personalDataToLlm).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('knowledge-base integrity', () => {
    /** Every GET/POST path the app declares, with its mount prefix. */
    function routePatterns() {
        const idx = read('src/routes/index.js');
        const files = {
            'index.js': [''],
            'dashboard.js': [''],
            'exec.js': ['/exec'],
            'v2-uam.js': ['/v2/uam'],
            'v2-slf.js': ['/v2/slf'],
            'v2-idp.js': ['/v2/idp'],
            'v2-idp-lifecycle.js': ['/v2/idp'],
            'v2-talent.js': ['/v2/talent'],
            'v2-coaching.js': ['/v2/coaching'],
            'v2-pip.js': ['/v2/pip'],
            'v2-lifecycle.js': ['/v2/lifecycle'],
            'v2-continuity.js': ['/v2/continuity'],
            'v2-lms.js': ['/v2/lms'],
            'v2-capability.js': ['/v2/cap'],
        };
        const pats = [];
        for (const [f, [prefix]] of Object.entries(files)) {
            if (prefix) expect(idx).toContain(`'${prefix}'`); // the mount really exists
            const src = read('src/routes/' + f);
            const re = /\b(\w+)\.(get|post|put|delete|all)\(\s*(\[[^\]]*\]|'[^']+')/g;
            let m;
            while ((m = re.exec(src))) {
                const base = f === 'v2-lms.js' && m[1] === 'learnerRouter' ? '/employee' : prefix;
                const paths = m[3].startsWith('[') ? m[3].match(/'[^']+'/g) || [] : [m[3]];
                for (const p of paths) {
                    const full = (base + p.slice(1, -1)).replace(/\/$/, '') || '/';
                    pats.push(
                        new RegExp(
                            '^' +
                                full
                                    .split('/')
                                    .map((seg) =>
                                        seg.startsWith(':')
                                            ? '[^/]+'
                                            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                                    )
                                    .join('/') +
                                '$'
                        )
                    );
                }
            }
        }
        return pats;
    }

    test('ids are unique and there are 40+ entries', () => {
        const ids = K.ENTRIES.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(K.ENTRIES.length).toBeGreaterThanOrEqual(40);
        const cids = K.CONCEPTS.map((c) => c.id);
        expect(new Set(cids).size).toBe(cids.length);
        for (const need of [
            'readiness',
            'not_measured',
            'gap',
            'critical',
            'ninebox',
            'dispute',
            'campaign',
            'idp',
            'succession',
        ])
            expect(cids).toContain(need);
    });

    test('every entry and concept has fr + en text and keywords', () => {
        for (const e of [...K.ENTRIES, ...K.CONCEPTS]) {
            for (const f of ['title', 'answer', ...(e.ask ? ['ask'] : [])]) {
                expect(typeof e[f].fr).toBe('string');
                expect(typeof e[f].en).toBe('string');
                expect(e[f].fr.trim().length).toBeGreaterThan(0);
                expect(e[f].en.trim().length).toBeGreaterThan(0);
            }
            expect(e.keywords.fr.length).toBeGreaterThan(0);
            expect(e.keywords.en.length).toBeGreaterThan(0);
        }
        for (const e of K.ENTRIES) expect(e.ask).toBeTruthy();
        for (const r of ['employee', 'manager', 'admin'])
            for (const p of K.ROLE_PROMPTS[r]) expect(p.fr && p.en).toBeTruthy();
    });

    test('roles and permissions are well-formed', () => {
        const { ALL_SLUGS } = require('../../src/config/permissions');
        for (const e of K.ENTRIES) {
            expect(e.roles.length).toBeGreaterThan(0);
            for (const r of e.roles) expect(['employee', 'manager', 'admin']).toContain(r);
            for (const p of [].concat(e.perm || [])) expect(ALL_SLUGS).toContain(p);
        }
        for (const c of K.CONCEPTS) expect(K.ENTRIES.map((e) => e.id)).toContain(c.related);
    });

    test('every link is a real route of the application', () => {
        const pats = routePatterns();
        expect(pats.length).toBeGreaterThan(100);
        const missing = K.ENTRIES.filter((e) => !pats.some((re) => re.test(e.link))).map(
            (e) => `${e.id} → ${e.link}`
        );
        expect(missing).toEqual([]);
    });

    test('every canonical question routes back to its own entry, for every role that may open it', () => {
        const users = [EMPLOYEE, MANAGER, SUPERADMIN];
        const wrong = [];
        for (const u of users)
            for (const e of K.ENTRIES.filter((x) => Companion.canSee(u, x)))
                for (const l of ['fr', 'en']) {
                    const d = Companion.detectIntent(u, e.ask[l]);
                    if (d.intent !== 'howto' || d.entry.id !== e.id)
                        wrong.push(`${u.userType} ${l} ${e.id} → ${d.intent}`);
                }
        expect(wrong).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('suggestions', () => {
    test('page-aware and role-aware', () => {
        const emp = Companion.suggestions(EMPLOYEE, '/employee/self-assessment', { lng: 'en' });
        expect(emp).toContain('Explain this page');
        expect(emp).toContain('How do I complete my self-assessment?');
        expect(emp).toContain('What is my role readiness?');
        const adm = Companion.suggestions(SUPERADMIN, '/cycles', { lng: 'fr' });
        expect(adm).toContain('Comment lancer une campagne d’évaluation ?');
        expect(adm.length).toBeLessThanOrEqual(5);
        // an employee on an admin path gets no admin prompt
        const odd = Companion.suggestions(EMPLOYEE, '/app-settings', { lng: 'en' });
        expect(odd).not.toContain('Where do I configure application settings?');
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('routes /api/companion', () => {
    const express = require('express');
    const request = require('supertest');

    function app(user) {
        const a = express();
        a.use(express.json());
        a.use((req, res, next) => {
            req.isAuthenticated = () => !!user;
            req.user = user || undefined;
            req.flash = () => {};
            next();
        });
        a.use('/api/companion', require('../../src/routes/companion'));
        return a;
    }

    test('unauthenticated → 401 JSON', async () => {
        const r = await request(app(null))
            .post('/api/companion/ask')
            .set('Accept', 'application/json')
            .send({ question: 'hello' });
        expect(r.status).toBe(401);
        const g = await request(app(null))
            .get('/api/companion/suggestions')
            .set('Accept', 'application/json');
        expect(g.status).toBe(401);
    });

    test('validation: question required, 500 characters maximum', async () => {
        const a = app(EMPLOYEE);
        const none = await request(a).post('/api/companion/ask').send({});
        expect(none.status).toBe(400);
        const notString = await request(a)
            .post('/api/companion/ask')
            .send({ question: { $gt: 1 } });
        expect(notString.status).toBe(400);
        const long = await request(a)
            .post('/api/companion/ask')
            .send({ question: 'x'.repeat(501) });
        expect(long.status).toBe(400);
        expect(long.body.code).toBe('question_too_long');
        const ok = await request(a)
            .post('/api/companion/ask')
            .send({ question: 'x'.repeat(500) + '', path: '/employee/dashboard' });
        expect(ok.status).toBe(200);
    });

    test('any signed-in role gets an answer', async () => {
        for (const u of [EMPLOYEE, MANAGER, SUPERADMIN]) {
            const r = await request(app(u))
                .post('/api/companion/ask')
                .send({ question: 'What can you do?', path: '/dashboard' });
            expect(r.status).toBe(200);
            expect(r.body.ok).toBe(true);
            expect(r.body.source).toBe('kb');
            expect(r.body.answer.length).toBeGreaterThan(20);
        }
    });

    test('suggestions for the page', async () => {
        const r = await request(app(EMPLOYEE)).get(
            '/api/companion/suggestions?path=' + encodeURIComponent('/employee/self-assessment')
        );
        expect(r.status).toBe(200);
        expect(r.body.suggestions.length).toBeGreaterThan(0);
    });

    test('companion.enabled = false → 404 on both routes', async () => {
        settings({ 'companion.enabled': false });
        const a = app(EMPLOYEE);
        expect((await request(a).post('/api/companion/ask').send({ question: 'hi' })).status).toBe(
            404
        );
        expect((await request(a).get('/api/companion/suggestions')).status).toBe(404);
        settings({ 'companion.enabled': 'true' });
        expect((await request(a).get('/api/companion/suggestions')).status).toBe(200);
    });

    test('mounted behind the global session/CSRF stack, next to /api/my-actions', () => {
        const idx = read('src/routes/index.js');
        expect(idx).toMatch(/router\.use\('\/api\/companion', require\('\.\/companion'\)\)/);
        const src = read('src/routes/companion.js');
        expect(src).toMatch(/requireAuth/);
        expect(src).toMatch(/writeActionLimiter/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('i18n, settings and UI wiring', () => {
    test('companion namespace: FR/EN key parity, registered in i18n config', () => {
        const fr = readJson('locales/fr/companion.json');
        const en = readJson('locales/en/companion.json');
        expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
        for (const k of Object.keys(fr)) {
            expect(fr[k].trim()).not.toBe('');
            expect(en[k].trim()).not.toBe('');
        }
        expect(read('src/config/i18n.js')).toMatch(/'companion'/);
        // UK English
        expect(JSON.stringify(en)).not.toMatch(/\b(organization|summarize|color)\b/i);
    });

    test('companion.enabled setting: catalogued, defaulted on, labelled in both languages', () => {
        const model = read('src/models/AppSettingsModel.js');
        expect(model).toMatch(/'companion\.enabled': \{ type: 'boolean' \}/);
        expect(model).toMatch(/key: 'companion\.enabled',\s*value: 'true',\s*type: 'boolean'/);
        for (const l of ['fr', 'en']) {
            const admin = readJson(`locales/${l}/admin.json`);
            expect(admin.set_name_companion_enabled).toBeTruthy();
            expect(admin.set_desc_companion_enabled).toBeTruthy();
        }
    });

    test('help panel: Assistant tab first and active, live region, script, nudge dot', () => {
        const p = read('views/partials/contextual-help.ejs');
        const iAssist = p.indexOf('data-target="tab-assistant"');
        const iGuide = p.indexOf('data-target="tab-guide"');
        expect(iAssist).toBeGreaterThan(-1);
        expect(iAssist).toBeLessThan(iGuide);
        expect(p).toMatch(/id="tab-assistant" class="help-section active hz-companion"/);
        expect(p).toMatch(/role="log" aria-live="polite"/);
        expect(p).toMatch(/\/js\/companion\.js/);
        expect(p).toMatch(/data-companion-dot/);
        expect(p).toMatch(/companionEnabled/);
        const js = read('public/js/companion.js');
        expect(js).toMatch(/sessionStorage/);
        expect(js).toMatch(/x-csrf-token/);
        expect(js).not.toMatch(/innerHTML/); // answers are rendered as text only
        expect(read('public/css/horizon.css')).toMatch(/:root \.hz-companion__thread/);
    });

    test('the partial renders with the switch on and off', () => {
        const ejs = require('ejs');
        const file = path.join(ROOT, 'views/partials/contextual-help.ejs');
        const en = readJson('locales/en/companion.json');
        const __ = (k) => (k.startsWith('companion:') ? en[k.slice(10)] : k);
        const on = ejs.render(
            read('views/partials/contextual-help.ejs'),
            {
                __,
                user: EMPLOYEE,
                assetVersion: '1',
                companionEnabled: true,
            },
            { filename: file }
        );
        expect(on).toMatch(/data-target="tab-assistant"/);
        expect(on).toMatch(/data-user-key="employee:41"/);
        expect(on).toMatch(/data-i18n="\{&#34;welcome&#34;:/);
        expect(on).toMatch(/id="tab-guide" class="help-section"/);
        const off = ejs.render(
            read('views/partials/contextual-help.ejs'),
            {
                __,
                user: EMPLOYEE,
                assetVersion: '1',
                companionEnabled: false,
            },
            { filename: file }
        );
        expect(off).not.toMatch(/tab-assistant|companion\.js|data-companion-dot/);
        expect(off).toMatch(/class="help-tab active" data-target="tab-guide"/);
        expect(off).toMatch(/id="tab-guide" class="help-section active"/);
    });
});
