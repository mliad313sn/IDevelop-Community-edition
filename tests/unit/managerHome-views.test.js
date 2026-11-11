'use strict';
/**
 * The manager's home (/supervisor/dashboard, 4.0.0 port wave 10): the pure
 * helpers of ManagerHomeService and the page rendered from models with the
 * real locale files, no database. Invented people only.
 *   - « Waiting on me »: count · fact · age per line; an item that arrived
 *     today says « today », never « 0 days »; a source that could not be read
 *     or is not configured is a sentence, never 0; the top task is marked;
 *   - « Expiring in my team » and « Ready to move on »: counts only, « not
 *     configured » in words, a module that is off leaves the block out;
 *   - no person name or id reaches the page even when the model carries one;
 *   - on a phone « Waiting on me » comes right after the header (CSS order);
 *   - FR and EN print no raw key and no inline handler.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { render } = require('../helpers/vizRender');
const MH = require('../../src/services/ManagerHomeService');
const D = require('../../src/services/DashboardHomeService');

const text = (h) =>
    h
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');

describe('pure helpers', () => {
    test('ageLine: count, oldest age, over a week; nothing is never « 0 days »', () => {
        expect(MH.ageLine([3, 0, 12, 9])).toEqual({ count: 4, oldestDays: 12, over7: 2 });
        expect(MH.ageLine([])).toEqual({ count: 0, oldestDays: null, over7: null });
        expect(MH.ageLine([null, undefined, ''])).toEqual({
            count: 0,
            oldestDays: null,
            over7: null,
        });
        expect(MH.ageLine([0])).toEqual({ count: 1, oldestDays: 0, over7: 0 });
    });

    test('summarise: the top task is the first line, in the fixed order, with something waiting', () => {
        const s = MH.summarise([
            { key: 'safety', notConfigured: true, count: null },
            { key: 'validations', count: 0, oldestDays: null },
            { key: 'disputes', count: 2, oldestDays: 4, href: '/v2/slf/disputes' },
            { key: 'changes', unavailable: true, count: null },
            { key: 'plans', count: 1, oldestDays: 120, ageKind: 'late', href: '/v2/idp/manage' },
        ]);
        expect(s.total).toBe(3);
        expect(s.oldestDays).toBe(120);
        expect(s.top).toEqual({
            key: 'disputes',
            count: 2,
            oldestDays: 4,
            href: '/v2/slf/disputes',
            ageKind: null,
        });
        expect(MH.summarise([{ key: 'validations', count: 0 }]).top).toBeNull();
        expect(MH.BACKLOG_ORDER[0]).toBe('safety');
    });

    test('expiry: no population, not configured and counts are three different answers', () => {
        expect(MH.expiry(null)).toEqual({ state: 'no_population' });
        expect(MH.expiry({ emptyScope: true })).toEqual({ state: 'no_population' });
        expect(MH.expiry({ status: 'not_configured', breakdown: null })).toEqual({
            state: 'not_configured',
        });
        expect(
            MH.expiry({
                status: 'watch',
                breakdown: {
                    expiredPeople: 1,
                    expiringPeople: 3,
                    expiring30People: 1,
                    missingPeople: 0,
                    requiredPeople: 9,
                },
            })
        ).toEqual({
            state: 'ok',
            expired: 1,
            expiring90: 3,
            expiring30: 1,
            missing: 0,
            requiredPeople: 9,
            href: '/compliance',
        });
    });

    test('ready to move on: the best outcome per person; « to assess » is never « not ready »', () => {
        const f = (o) => ({
            totalReq: 3,
            assessed: 3,
            ptsGained: 6,
            ptsReq: 6,
            ptsGainedAssessed: 6,
            ptsReqAssessed: 6,
            critTotal: 1,
            critAssessed: 1,
            critMet: 1,
            ...o,
        });
        expect(MH.targetOutcome(f({}), 80)).toBe('ready');
        // a skill above the target's requirement is credited at the requirement only
        expect(MH.targetOutcome(f({ ptsGained: 4, ptsGainedAssessed: 4 }), 80)).toBe('gap');
        expect(
            MH.targetOutcome(f({ assessed: 1, ptsReqAssessed: 2, ptsGainedAssessed: 2 }), 80)
        ).toBe('to_assess');
        expect(MH.targetOutcome(f({ assessed: 1, critMet: 0 }), 80)).toBe('gap');
        expect(MH.targetOutcome({ totalReq: 0 }, 80)).toBeNull();
        expect(
            MH.bestPerPerson([
                { empId: 1, outcome: 'gap' },
                { empId: 1, outcome: 'ready' },
                { empId: 2, outcome: 'to_assess' },
                { empId: 3, outcome: null },
            ])
        ).toEqual({ withTarget: 2, readyForTarget: 1, toAssess: 1 });
    });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
const ctx = { pop: { ids: [101, 102, 103, 104, 105, 106] }, caps: { manager: true } };
const watch = (o = {}) => ({
    empty: false,
    backlog: MH.summarise(
        o.lines || [
            {
                key: 'safety',
                notConfigured: true,
                count: null,
                mandatory: true,
                href: '/safety-gate',
            },
            {
                key: 'validations',
                count: 2,
                oldestDays: 0,
                over7: 0,
                href: '/supervisor/self-assessment-reviews',
            },
            { key: 'disputes', count: 1, oldestDays: 9, over7: 1, href: '/v2/slf/disputes' },
            {
                key: 'changes',
                count: 0,
                oldestDays: null,
                over7: null,
                href: '/assessment-changes',
            },
            { key: 'actions', unavailable: true, count: null, href: '/v2/idp/manage' },
            {
                key: 'plans',
                count: 1,
                oldestDays: 130,
                over7: 1,
                ageKind: 'late',
                href: '/v2/idp/manage',
            },
        ]
    ),
    expiry:
        'expiry' in o
            ? o.expiry
            : MH.expiry({
                  status: 'watch',
                  breakdown: {
                      expiredPeople: 1,
                      expiringPeople: 2,
                      expiring30People: 1,
                      missingPeople: 0,
                      requiredPeople: 6,
                  },
              }),
    ready:
        'ready' in o
            ? o.ready
            : {
                  readyNow: 3,
                  withTarget: 2,
                  readyForTarget: 1,
                  toAssess: 1,
                  href: '/talent/career-path',
              },
});
const home = (w) => ({
    empty: false,
    tiles: [],
    brief: [],
    summary: { total: 6, byState: { ready: 3, not_ready: 1 }, byNext: {} },
    // a name on the model must never reach the page
    gaps: [],
    coverage: 50,
    team: [{ id: 101, firstName: 'Ottoline', lastName: 'Quarrington' }],
    watch: w,
});
const page = (w, lang = 'fr') =>
    render(
        'views/pages/dashboard/team.ejs',
        { ctx, home: home(w), scopeLabel: 'Mon équipe', asOf: new Date('2026-10-20T08:00:00Z') },
        lang
    );

describe('the manager home renders counts and ages only', () => {
    test('« Waiting on me »: count · fact · age, « today » never « 0 days », the top task marked', () => {
        const fr = page(watch(), 'fr');
        const t = text(fr);
        expect(fr).toMatch(/data-mh="validations"/);
        expect(t).toMatch(
            /2 personnes attendent votre validation élément le plus ancien arrivé aujourd’hui/
        );
        expect(t).not.toMatch(/\b0 j(ours?)?\b/);
        expect(t).toMatch(
            /1 contestation de note à traiter élément le plus ancien en attente depuis 9 jours · 1 depuis plus de 7 jours/
        );
        expect(t).toMatch(/1 plan en retard de plus de 90 jours jusqu’à 130 jours de retard/);
        // the top task is the first waiting line in the fixed order
        expect(fr).toMatch(
            /<li class="mh-top"><a class="mh-line" href="\/supervisor\/self-assessment-reviews" data-mh="validations">/
        );
        expect(t).toMatch(/À faire d’abord/);
        // a line at 0 is « nothing waiting », not a 0 row
        expect(fr).not.toMatch(/data-mh="changes"/);
        expect(t).toMatch(/Rien n’attend pour les demandes de modification\./);
        // not configured and unreadable are sentences, never 0
        expect(fr).toMatch(/data-mh-gate="not_configured"/);
        expect(fr).toMatch(/data-mh-off="actions"/);
        expect(t).toMatch(/Non mesuré pour l’instant \(les actions de plan\)/);
        expect(fr).not.toMatch(/data-mh="actions"/);
        expect(fr).not.toMatch(/data-mh="safety"/);
    });

    test('nothing waiting and nothing unknown: one calm sentence', () => {
        const fr = page(
            watch({
                lines: [
                    { key: 'validations', count: 0 },
                    { key: 'disputes', count: 0 },
                ],
            })
        );
        expect(text(fr)).toMatch(/Rien ne vous attend\./);
        expect(fr).not.toMatch(/class="mh-top"/);
    });

    test('« Expiring in my team »: counts, « not configured » in words, no 0 row', () => {
        const t = text(page(watch()));
        expect(t).toMatch(/1 personne avec un certificat expiré/);
        expect(t).toMatch(
            /2 personnes avec un certificat qui expire dans les 90 jours dont 1 dans les 30 jours/
        );
        expect(t).not.toMatch(/0 personne sans/);
        const nc = page(watch({ expiry: { state: 'not_configured' } }));
        expect(nc).toMatch(/data-mh="exp_not_configured"/);
        expect(text(nc)).toMatch(/Aucun poste de votre équipe n’exige de certificat/);
        const none = text(
            page(
                watch({
                    expiry: MH.expiry({ status: 'compliant', breakdown: { requiredPeople: 4 } }),
                })
            )
        );
        expect(none).toMatch(/Rien n’expire dans les 90 jours pour les 4 personnes/);
    });

    test('« Ready to move on »: ready for the target, of N with a target, to assess', () => {
        const t = text(page(watch(), 'en'));
        expect(t).toMatch(/1 ready for their target role of 2 with a target role/);
        expect(t).toMatch(/1 to assess against their target role/);
        expect(text(page(watch({ ready: { readyNow: 0 } }), 'en'))).toMatch(
            /Nobody in your team is ready in their role yet\./
        );
        expect(text(page(watch({ ready: { readyNow: 2, withTarget: 0 } }), 'en'))).toMatch(
            /2 people are ready in their role; none has a target role yet\./
        );
        expect(text(page(watch({ ready: { unavailable: true } }), 'en'))).toMatch(
            /Could not be read just now: not measured\./
        );
    });

    test('a module that is off leaves its block out (no « not measured » for it)', () => {
        const html = page(watch({ ready: null, expiry: null }));
        expect(html).not.toMatch(/id="mh-ready"/);
        expect(html).not.toMatch(/id="mh-expiry"/);
        expect(html).toMatch(/id="mh-backlog"/);
    });

    test('no name, no person id; FR and EN without a raw key or an inline handler', () => {
        for (const lang of ['fr', 'en']) {
            const html = page(watch(), lang);
            expect(html).not.toMatch(/Ottoline|Quarrington/);
            expect(html).not.toMatch(/\b10[1-6]\b/);
            expect(html).not.toMatch(/\bmw_[a-z_]+/);
            expect(html).not.toMatch(/\son[a-z]+="/i);
        }
    });

    test('the page without a watch (an empty team) is unchanged', () => {
        const html = page(null);
        expect(html).not.toMatch(/mh-backlog/);
    });
});

describe('phones: the top task first', () => {
    const css = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'css', 'dashboard.css'),
        'utf8'
    );
    test('the header, then « Waiting on me », before the tiles', () => {
        const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
        expect(phone).toMatch(/#ds-team-home > \.ds-header \{\s*order: -2;/);
        expect(phone).toMatch(/#ds-team-home > \.mh-backlog \{\s*order: -1;/);
    });
    test('every row is a 44 px target', () => {
        expect(css).toMatch(/\.mh-line \{[^}]*min-height: 44px;/);
    });
});

describe('wiring', () => {
    test('only a manager gets the watch; it never fails the page', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'services', 'DashboardHomeService.js'),
            'utf8'
        );
        expect(src).toMatch(
            /const watch = ctx\.caps\.manager\s*\? await require\('\.\/ManagerHomeService'\)/
        );
        expect(src).toMatch(
            /\.forManager\(ctx, \{ k8: ind\.K8, bundle \}\)\s*\.catch\(\(\) => null\)/
        );
        expect(typeof D.teamHome).toBe('function');
    });
});
