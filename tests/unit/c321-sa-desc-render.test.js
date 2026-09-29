'use strict';
/**
 * 3.23.21 — the server-rendered « Qu'est-ce que c'est ? » (D1-D5, D7-D10).
 *
 * Rendered with EJS against the real views and the real shared resolver:
 *  · an XSS description is escaped and keeps its line break (text + pre-line);
 *  · the search reads the NAME span only (the description is elsewhere in the cell);
 *  · the rating select is described by the description and the level line;
 *  · the required level is « — » until the row is rated, then level + gap;
 *  · a missing description says so (D7), never an empty box;
 *  · the level list follows skill anchor → category anchor → generic scale;
 *  · the scale legend is a visible list, no title= tooltip on legend/badges;
 *  · reviewer console + single review page carry the same, escaped panel.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const viewPath = (p) => path.join(ROOT, 'views', 'pages', p);
const read = (p) => fs.readFileSync(p, 'utf8');
const skillHelpCore = require('../../src/utils/skillHelp');

const XSS = '<img src=x onerror=alert(1)>\nline2';
const __ = (key, opts) => {
    if (opts && opts.n !== undefined) return `[${key}|${opts.n}]`;
    return `[${key}]`;
};
const base = {
    __,
    lang: 'fr',
    colon: ' :',
    cspNonce: 'n',
    csrfToken: 'c',
    assetVersion: '1',
    user: { id: 137 },
    skillHelpCore,
    enumLabel: (a, b) => String(b),
};
const render = (p, data) =>
    ejs.render(read(viewPath(p)), { ...base, ...data }, { filename: viewPath(p) });

const help = (over) => ({
    descriptionFr: XSS,
    descriptionEn: null,
    subDomainName: 'Sous-domaine',
    subDomainDefinition: 'Définition',
    category: 'Technical',
    anchors: {
        skill: { 2: { fr: 'Propre niveau 2', en: null } },
        category: {
            0: { fr: 'Cat 0', en: 'Cat 0 en' },
            2: { fr: 'Cat 2', en: null },
            4: { fr: 'Cat 4', en: null },
        },
    },
    ...over,
});
const skill = (over) => ({
    skillId: 11,
    skillName: 'Soudage',
    domainName: 'Pilier',
    requiredLevel: 3,
    isCritical: true,
    selfRatedLevel: null,
    currentSkillLevel: 0,
    status: 'not_started',
    selfAssessment: null,
    skillHelp: help(),
    ...over,
});
const page = (skills) =>
    render('employee/self-assessment.ejs', {
        employee: { roleName: 'R' },
        skillsWithAssessments: skills,
        cycle: null,
        lockedCycle: null,
    });
const rowOf = (html, id) => {
    const at = html.indexOf(`<tr data-skill-id="${id}"`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf('</tr>', at));
};

describe('self-assessment page', () => {
    test('XSS description: escaped text, line break kept (pre-line), never markup', () => {
        const html = page([skill()]);
        const r = rowOf(html, 11);
        expect(r).not.toMatch(/<img src=x/);
        expect(r).toContain('id="sk-desc-11">&lt;img src=x onerror=alert(1)&gt;\nline2</p>');
        const css = read(path.join(ROOT, 'public', 'css', 'sa-skill-help.css'));
        expect(css).toMatch(/\.sa-skill-desc\s*\{[^}]*white-space:\s*pre-line/);
    });

    test('the NAME sits in its own span; the search reads that span only', () => {
        const html = page([skill()]);
        expect(rowOf(html, 11)).toContain('<span class="sa-skill-name">Soudage</span>');
        // The page's own filter code (behaviour): run applyFilter's name read on a row
        // whose description contains the search term but whose name does not.
        const src = read(viewPath('employee/self-assessment.ejs'));
        const line = src.split('\n').find((l) => /const name = \(r\.querySelector\(/.test(l));
        const sel = /querySelector\('([^']+)'\)/.exec(line)[1];
        expect(sel).toBe('.sa-skill-name');
        const fakeRow = {
            querySelector: (s) =>
                ({
                    '.sa-skill-name': { textContent: 'Soudage' },
                    '.sa-skill-cell': { textContent: 'Soudage onerror line2' },
                })[s],
        };
        expect(
            (fakeRow.querySelector(sel) || {}).textContent.toLowerCase().indexOf('onerror')
        ).toBe(-1);
    });

    test('the select is described by the description and the level line', () => {
        const r = rowOf(page([skill({ selfRatedLevel: 2, status: 'draft' })]), 11);
        const m = /<select[^>]*aria-describedby="([^"]+)"/.exec(r);
        expect(m).not.toBeNull();
        const ids = m[1].split(/\s+/);
        expect(ids).toEqual(expect.arrayContaining(['sk-desc-11', 'sk-lvl-11']));
        ids.forEach((id) => expect(r).toContain(`id="${id}"`));
        // D3: the rated level's meaning, in words (skill anchor for level 2).
        expect(r).toMatch(
            /id="sk-lvl-11" aria-live="polite">\[employee:sa_level_line\|2\] Propre niveau 2</
        );
    });

    test('D5: required level hidden until rated, then shown with the gap', () => {
        const unrated = rowOf(page([skill()]), 11);
        const cell = /data-req-cell[^>]*>([\s\S]*?)<\/td>/.exec(unrated)[1];
        expect(cell).toContain('—');
        expect(cell).toContain('[employee:sa_req_hidden_sr]');
        expect(cell).not.toMatch(/\b3\b/);
        // In the panel, the required tag exists but is hidden until rated.
        expect(unrated).toMatch(/class="sa-req-tag" hidden>/);
        // Critical badge stays visible.
        expect(unrated).toContain('[employee:critical_badge]');

        const rated = rowOf(page([skill({ selfRatedLevel: 1, status: 'draft' })]), 11);
        const cell2 = /data-req-cell[^>]*>([\s\S]*?)<\/td>/.exec(rated)[1];
        expect(cell2).toBe('3<span class="sa-req-gap"> · [employee:sa_req_gap|-2]</span>');
        expect(rated).toMatch(/class="sa-req-tag">/);
    });

    test('D7: no description → the explicit message, never an empty box', () => {
        const r = rowOf(page([skill({ skillHelp: null })]), 11);
        expect(r).toMatch(
            /class="sa-skill-desc sa-skill-desc-missing" id="sk-desc-11">\[employee:sa_help_no_desc\]</
        );
    });

    test('levels: skill anchor wins, then category, then the generic scale', () => {
        const r = rowOf(page([skill()]), 11);
        const texts = [...r.matchAll(/<span class="sa-lvl-text">([^<]*)<\/span>/g)].map(
            (m) => m[1]
        );
        expect(texts).toEqual([
            'Cat 0',
            '[employee:scale_1_title]',
            'Propre niveau 2',
            '[employee:scale_3_title]',
            'Cat 4',
        ]);
        // Neither the current validated level nor strategic_link is ever in the panel.
        expect(r).not.toMatch(/strategic/i);
    });

    test('D9: evidence nudge on 4, training nudge on 0', () => {
        const r4 = rowOf(page([skill({ selfRatedLevel: 4, status: 'draft' })]), 11);
        expect(r4).toMatch(/placeholder="\[employee:sa_nudge_evidence\]"/);
        const r0 = rowOf(page([skill({ selfRatedLevel: 0, status: 'draft' })]), 11);
        expect(r0).toMatch(/placeholder="\[employee:sa_nudge_training\]"/);
    });

    test('D4/D8: visible scale list, intro, toggle; no title= on legend, critical or lock badge', () => {
        const html = page([skill({ selfRatedLevel: 2, status: 'submitted' })]);
        expect(html).toMatch(/<dl class="sa-scale-dl"/);
        expect(html).toMatch(/<details class="sa-intro" id="saIntro" open>/);
        expect(html).toMatch(/id="saHelpToggleAll"/);
        expect(html).not.toMatch(/<span title="\[employee:scale_/);
        expect(html).not.toMatch(/class="sa-crit-key" title=/);
        expect(html).not.toMatch(/class="sa-lock-badge" title=/);
        // The lock reason is still given, in words linked to the select.
        expect(html).toMatch(/id="sk-lock-11"> — \[employee:sa_locked_title\]/);
        expect(html).toMatch(/aria-describedby="sk-desc-11 sk-lvl-11 sk-lock-11"/);
        // The helper is loaded as an external file (CSP: no inline handlers).
        expect(html).toMatch(/<script src="\/js\/sa-skill-help\.js\?v=1"><\/script>/);
    });
});

describe('HR quality page', () => {
    const q = (status, can) =>
        render('framework/quality.ejs', {
            can: () => can,
            status,
            openCount: 1,
            starterAvailable: true,
            quality: {
                counts: { used: 2, missingDescription: 1, fewAnchors: 2, todo: 2 },
                items: [
                    {
                        id: 1,
                        name: 'Soudage',
                        pillar: 'P',
                        subDomain: 'S',
                        category: 'Technical',
                        employees: 7,
                        roles: 2,
                        hasDescription: false,
                        hasOpenProposal: true,
                        ownAnchors: 0,
                    },
                ],
            },
            proposals: [
                {
                    id: 4,
                    skillId: 1,
                    skillName: 'Soudage',
                    pillar: 'P',
                    subDomain: 'S',
                    category: 'Technical',
                    textFr: XSS,
                    textEn: null,
                    source: 'starter',
                    status,
                },
            ],
        });
    test('proposal texts are escaped; bulk approval asks for a confirmation', () => {
        const html = q('proposed', true);
        expect(html).not.toMatch(/<img src=x/);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;\nline2</textarea>');
        expect(html).toMatch(/name="confirm" value="1" form="sqBulkForm" required/);
        expect(html).toMatch(/action="\/framework\/quality\/load-starter"/);
    });
    test('a read-only viewer sees no write control', () => {
        const html = q('proposed', false);
        expect(html).not.toMatch(/sqBulkForm|load-starter|sqImportForm|\/approve"/);
        expect(html).toContain('&lt;img src=x');
    });
});

describe('reviewer console (server render) and review page', () => {
    const QUEUE = [
        {
            employeeId: 1,
            firstName: 'A',
            lastName: 'B',
            total: 1,
            pending: 1,
            counts: { submitted: 1 },
            cycles: [],
            items: [
                {
                    id: 9,
                    skillId: 11,
                    skillName: 'Soudage',
                    requiredLevel: 3,
                    selfRatedLevel: 2,
                    validatedLevel: null,
                    employeeNotes: 'n',
                    workflowState: 'submitted',
                    commentCount: 0,
                    skillHelp: help(),
                },
            ],
        },
    ];
    test('console: escaped description, self-rating and required level marked', () => {
        const html = render('supervisor/self-assessment-review.ejs', { employees: QUEUE });
        const at = html.indexOf('id="sk-help-r9-11"');
        expect(at).toBeGreaterThan(-1);
        const panel = html.slice(at, html.indexOf('</details>', at));
        expect(panel).not.toMatch(/<img src=x/);
        expect(panel).toContain('&lt;img src=x onerror=alert(1)&gt;\nline2');
        expect(panel).toMatch(
            /data-level="2" class="is-selected">[\s\S]*?\[talentx:sar_help_self_tag\]/
        );
        expect(panel).toMatch(
            /data-level="3" class=" is-required">[\s\S]*?class="sa-req-tag">\[talentx:sar_help_required_tag\]/
        );
        // The JS path gets the same helper and its strings.
        expect(html).toMatch(/<script src="\/js\/sa-skill-help\.js\?v=1"><\/script>/);
        expect(html).toMatch(/helpPanel\(it\)/);
    });

    test('single review page: the panel with the XSS payload escaped', () => {
        const html = render('supervisor/review.ejs', {
            review: { skillId: 11, skillName: 'Soudage', domainName: 'P', selfRatedLevel: 4 },
            employee: { firstName: 'A', lastName: 'B' },
            selfAssessment: null,
            skillHelp: help(),
            requiredLevel: 2,
        });
        expect(html).not.toMatch(/<img src=x/);
        expect(html).toContain('id="sk-desc-rv-11">&lt;img src=x onerror=alert(1)&gt;\nline2</p>');
        expect(html).toMatch(/data-level="4" class="is-selected"/);
        expect(html).toMatch(/data-level="2" class=" is-required"/);
    });
});
