'use strict';

/**
 * Lot E — the three lists rebuilt on the shared toolkit:
 *   - the approvals queue (L6-17): filters, paging, translated kinds/states,
 *     a readable payload summary and the maker's NAME;
 *   - the notification centre: server-side filters + a pager instead of a hard
 *     100-row cap that buried everything older;
 *   - /domains-skills (L6-16): one block per sub-domain, skills rendered for the
 *     SELECTED sub-domain only.
 *
 * DB is mocked — these pin the query shape and the presentation rules, not data.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    connect: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const MakerChecker = require('../../src/controllers/MakerCheckerController');

function resStub() {
    return {
        rendered: null,
        render(view, locals) {
            this.rendered = { view, locals };
        },
    };
}
// i18next-like stub: falls back to defaultValue and interpolates {{vars}}, and
// records every key asked for so a test can assert the KEY, not the fallback.
function reqStub(query = {}) {
    const asked = [];
    const t = (k, o) => {
        asked.push(k);
        let out = (o && o.defaultValue) || k;
        if (o)
            out = String(out).replace(/\{\{(\w+)\}\}/g, (_, v) =>
                o[v] == null ? '' : String(o[v])
            );
        return out;
    };
    return { query, user: { id: 1, userType: 'admin', role: 'superadmin' }, t, asked };
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
});

describe('L6-17 — the approvals queue is a real list', () => {
    test('the default view is what needs a decision; ?state=all lifts the filter', async () => {
        mockDb.get.mockResolvedValue({ c: 0 });
        mockDb.all.mockResolvedValue([]);
        const res = resStub();
        await MakerChecker.queue(reqStub(), res);
        // first call = the COUNT, its params carry the implicit 'pending'
        expect(mockDb.get.mock.calls[0][1]).toEqual(['pending']);
        expect(res.rendered.locals.filters.state).toBe('pending');

        mockDb.get.mockClear();
        mockDb.all.mockClear();
        mockDb.get.mockResolvedValue({ c: 0 });
        mockDb.all.mockResolvedValue([]);
        const res2 = resStub();
        await MakerChecker.queue(reqStub({ state: 'all' }), res2);
        expect(mockDb.get.mock.calls[0][1]).toEqual([]);
        expect(res2.rendered.locals.filters.state).toBe('all');
    });

    test('an unknown state or a non-numeric site never reaches SQL', async () => {
        mockDb.get.mockResolvedValue({ c: 0 });
        mockDb.all.mockResolvedValue([]);
        const res = resStub();
        await MakerChecker.queue(
            reqStub({ state: "'; DROP TABLE admins; --", siteId: 'abc' }),
            res
        );
        expect(mockDb.get.mock.calls[0][1]).toEqual([]);
        expect(res.rendered.locals.filters.siteId).toBe('');
    });

    test('the site filter joins through the payload subject, and a kind is a bound param', async () => {
        mockDb.get.mockResolvedValue({ c: 3 });
        mockDb.all.mockResolvedValue([]);
        await MakerChecker.queue(
            reqStub({ state: 'pending', kind: 'pip.create', siteId: '11' }),
            resStub()
        );
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(
            /LEFT JOIN employees e ON e\.id = NULLIF\(r\.payload->>'employeeId',''\)::bigint/
        );
        expect(sql).toMatch(/e\.site_id = \?/);
        expect(params).toEqual(['pending', 'pip.create', 11]);
    });

    test('a row carries the maker NAME, a translated kind and a readable summary', async () => {
        mockDb.get.mockResolvedValue({ c: 1 });
        mockDb.all
            .mockResolvedValueOnce([
                {
                    id: 7,
                    kind: 'pip.create',
                    state: 'pending',
                    reason: null,
                    error: null,
                    makerId: 41,
                    payload: { employeeId: 84, startsOn: '2026-10-01', endsOn: '2026-12-31' },
                    createdAt: '2026-09-11T10:00:00Z',
                    makerUsername: 'zz_checker',
                    employeeId: 84,
                    firstName: 'Hamady',
                    lastName: 'Soumare',
                    employeeNumber: 'EMP-1',
                    siteName: 'Riverside',
                },
            ])
            .mockResolvedValueOnce([{ id: 11, name: 'Riverside' }]);
        const res = resStub();
        const req = reqStub();
        await MakerChecker.queue(req, res);
        const row = res.rendered.locals.items[0];
        expect(row.makerName).toBe('zz_checker'); // a name, never the numeric maker_id
        expect(row.employeeName).toBe('Hamady Soumare');
        // the LABEL is asked for by key; the raw kind is only its last-resort default
        expect(req.asked).toContain('admin:mcq_kind_pip_create');
        expect(req.asked).toContain('admin:mcq_sum_pip_create');
        expect(row.summary).toMatch(/84/);
        expect(row.summary).toMatch(/2026-10-01/);
        expect(row.summary).not.toMatch(/^\{/); // never a raw JSON dump
    });

    test('summarize() never prints raw JSON for an unregistered kind', () => {
        const t = (k, o) => (o && o.defaultValue) || k;
        expect(MakerChecker.summarize('some.future.kind', { a: 1, b: 2 }, t)).toBe('a, b');
        expect(MakerChecker.summarize('some.future.kind', {}, t)).toBe('No details');
    });

    test('every state of the PG enum is translated in both locales', () => {
        const FR = require('../../locales/fr/admin.json');
        const EN = require('../../locales/en/admin.json');
        expect(MakerChecker.STATES).toEqual([
            'pending',
            'approved',
            'applied',
            'rejected',
            'failed',
            'cancelled',
        ]);
        for (const s of MakerChecker.STATES) {
            expect(FR[`mcq_state_${s}`]).toBeTruthy();
            expect(EN[`mcq_state_${s}`]).toBeTruthy();
        }
    });

    test('the kind filter is built from the REGISTERED handlers, never a hand-written list', () => {
        const Svc = require('../../src/services/MakerCheckerService');
        expect(typeof Svc.kinds).toBe('function');
        expect(read('src/controllers/MakerCheckerController.js')).toMatch(/Svc\.kinds\(\)/);
    });

    test('the view shows an empty state, a pager and a mandatory rejection reason', () => {
        const view = read('views/pages/maker-checker/index.ejs');
        expect(view).toMatch(/admin:mcq_empty_pending/);
        expect(view).toMatch(/class="pagination"/);
        expect(view).toMatch(/name="reason"[\s\S]{0,320}required/);
        expect(view).toMatch(/fmtDateTime\(r\.createdAt\)/);
        expect(view).not.toMatch(/JSON\.stringify\(it\.payload/);
        expect(view).not.toMatch(/it\.maker_id/);
    });

    test('the decision flash names a translated state, not the raw enum', () => {
        expect(read('src/routes/v2-uam.js')).toMatch(/admin:mcq_state_\$\{result\.state\}/);
    });
});

describe('the notification centre is filterable and paged', () => {
    const ctl = read('src/controllers/NotificationController.js');
    const svc = read('src/services/NotificationService.js');
    const view = read('views/pages/notifications/index.ejs');

    test('the controller uses the shared list toolkit', () => {
        expect(ctl).toMatch(/require\('\.\.\/utils\/listTools'\)/);
        expect(ctl).toMatch(/countInApp/);
        expect(ctl).toMatch(/listInAppPage/);
        expect(ctl).not.toMatch(/listInApp\(\{ \.\.\.id, limit: 100 \}\)/);
    });

    test('an out-of-range page is clamped BEFORE the query (no empty page under a full caption)', () => {
        expect(ctl).toMatch(/const safePage = Math\.min\(page, totalPages\)/);
        expect(ctl).toMatch(/offset: \(safePage - 1\) \* perPage/);
    });

    test('the state/family filters are validated, never interpolated', () => {
        expect(ctl).toMatch(/\['unread', 'read'\]\.includes/);
        expect(ctl).toMatch(/\/\^\[a-z_\]\{1,32\}\$\/\.test/);
        expect(svc).toMatch(/split_part\(kind, '\.', 1\) = \?/);
    });

    test('an empty result says WHY it is empty', () => {
        expect(view).toMatch(/notifications_none_match/);
        expect(view).toMatch(/\(filters\.state \|\| filters\.family\)/);
    });

    test('the family labels exist in both locales for every family this DB uses', () => {
        const FR = require('../../locales/fr/chrome.json');
        const EN = require('../../locales/en/chrome.json');
        for (const f of [
            'cycle',
            'sa',
            'access',
            'coaching',
            'talent',
            'handover',
            'cert',
            'pip',
            'ops',
            'idp',
            'dispute',
            'lifecycle',
            'planning',
            'coverage',
            'review',
            'manager_digest',
            'dept_digest',
            'mc',
            'account',
            'mobility',
            'survey',
            'lms',
        ]) {
            expect(FR[`notif_family_${f}`]).toBeTruthy();
            expect(EN[`notif_family_${f}`]).toBeTruthy();
        }
    });
});

describe('L6-16 — /domains-skills is browsed one sub-domain at a time', () => {
    const ctl = read('src/controllers/DomainController.js');
    const view = read('views/pages/domains-skills/index.ejs');

    test('no sub-domain selected renders NO skill rows (and says so)', () => {
        expect(ctl).toMatch(/const skills = subDomainFilter/);
        expect(ctl).toMatch(/: \[\];/);
        expect(view).toMatch(/framework:pick_subdomain_prompt/);
        expect(view).toMatch(/framework:pick_subdomain_hint/);
    });

    test('the selection is a validated integer bound as a parameter', () => {
        expect(ctl).toMatch(/\/\^\\d\+\$\/\.test\(String\(req\.query\.subDomainId \|\| ''\)\)/);
        expect(ctl).toMatch(/s\.sub_domain_id = \?/);
        expect(ctl).toMatch(/\[subDomainFilter\]/);
    });

    test('the framework tab still renders one block per sub-domain', () => {
        expect(view).toMatch(/<details class="fw-sub">/);
        expect(view).toMatch(/sd\.skills\.length %> <%= __\('framework:label_skills'\)/);
    });
});
