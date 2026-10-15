'use strict';
/**
 * The human path on the safety-competency gate (migration 174), over a mocked
 * database: the evaluation with waivers, the API and webhook shape, the notice
 * at the end of a waiver, who may act, the page router's refusals, the rule
 * mode lock, and what the pages and the catalogue say in FR and EN.
 * The end-to-end proof on the real schema is safetyGateWaivers-db.test.js.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockScoped = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScoped(...a),
    scopeClause: () => '',
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: (...a) => mockNotify(...a),
}));
const mockLines = jest.fn();
jest.mock('../../src/services/ReportingLineService', () => ({
    linesFor: (...a) => mockLines(...a),
    lineRecipients: async () => [{ userType: 'employee', id: 50, role: 'reviewer' }],
}));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    hasPermission: (u, slug) =>
        !!u &&
        u.userType === 'admin' &&
        (u.role === 'superadmin' || (Array.isArray(u.permissions) && u.permissions.includes(slug))),
    canAccessSite: async () => true,
    getAccessibleSiteIds: async () => [1],
    adminsWithPermission: async () => [],
}));

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const SG = require('../../src/services/SafetyGateService');
const SW = require('../../src/services/SafetyWaiverService');

const { STATUS, REASON } = SG;
const PERSON = { id: 7, isActive: true, roleId: 10, siteId: 1 };
const UNTIL = '2026-11-02T08:00:00Z';
const rule = (skillId, extra = {}) => ({
    roleId: 10,
    siteId: null,
    skillId,
    skillName: `Skill ${skillId}`,
    minLevel: 3,
    certRequired: false,
    ...extra,
});
const facts = ({ waivers = {} } = {}) => ({
    levels: new Map(),
    assessedAt: new Map(),
    validated: new Map(),
    certs: new Map(),
    lapsed: new Map(),
    waivers: new Map(Object.entries(waivers).map(([k, v]) => [Number(k), v])),
});
const W = (id = 91, expiresAt = UNTIL) => ({ id, expiresAt });
const HSE = { id: 9, userType: 'admin', role: 'localadmin', permissions: ['manage_compliance'] };

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockScoped.mockReset().mockResolvedValue(null);
    mockNotify.mockClear();
    mockLines.mockReset().mockResolvedValue(new Map());
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const writes = () =>
    [...mockDb.get.mock.calls, ...mockDb.run.mock.calls].filter(([s]) => /INSERT|UPDATE/.test(s));

describe('a running waiver reads WAIVED, never CLEARED', () => {
    test('every enforced blocking reason waived: WAIVED with its end, in the API too', () => {
        const out = SG.evaluateWithModes(PERSON, [rule(1)], facts({ waivers: { 1: W() } }));
        expect(out.status).toBe(STATUS.WAIVED);
        expect(out.enforcedStatus).toBe(STATUS.WAIVED);
        expect(out.waiverUntil).toBe(UNTIL);
        const api = SG.toApi({ ...out, employeeNumber: 'E7', evaluatedAt: 'x' });
        expect(api).toMatchObject({
            status: 'WAIVED',
            cleared: true,
            waived: true,
            waiverExpiresAt: UNTIL,
            enforcedStatus: 'WAIVED',
        });
        expect(api.reasons[0]).toMatchObject({
            code: REASON.NOT_ASSESSED,
            waived: true,
            waiverExpiresAt: UNTIL,
        });
    });

    test('one blocking skill left without a waiver: still BLOCKED, no waiver flag', () => {
        const out = SG.evaluateWithModes(
            PERSON,
            [rule(1), rule(2)],
            facts({ waivers: { 1: W() } })
        );
        expect(out.status).toBe(STATUS.BLOCKED);
        const api = SG.toApi({ ...out, employeeNumber: 'E7', evaluatedAt: 'x' });
        expect(api.cleared).toBe(false);
        expect(api.waived).toBeUndefined();
    });

    test('a rule required by law is never lifted, even when a waiver row exists', () => {
        const out = SG.evaluateWithModes(
            PERSON,
            [rule(1, { legallyMandatory: true })],
            facts({ waivers: { 1: W() } })
        );
        expect(out.status).toBe(STATUS.BLOCKED);
        expect(out.reasons[0].legallyMandatory).toBe(true);
        expect(out.reasons[0].waived).toBeUndefined();
    });

    test('a rule required by law stays enforced even when stored in observe mode', () => {
        const out = SG.evaluateWithModes(
            PERSON,
            [rule(1, { mode: 'observe', legallyMandatory: true })],
            facts()
        );
        expect(SG.effectiveStatus(out)).toBe(STATUS.BLOCKED);
        expect(SG.isCleared(out)).toBe(false);
        // The same rule without the legal mark only observes.
        const plain = SG.evaluateWithModes(PERSON, [rule(1, { mode: 'observe' })], facts());
        expect(SG.isCleared(plain)).toBe(true);
    });

    test('a person who has left is never waived', () => {
        const out = SG.evaluateWithModes(
            { ...PERSON, isActive: false },
            [rule(1)],
            facts({ waivers: { 1: W() } })
        );
        expect(out.status).toBe(STATUS.BLOCKED);
    });

    test('no waiver: the answer and its fingerprint keep their earlier shape', () => {
        const out = SG.evaluateWithModes(PERSON, [rule(1)], facts());
        expect(out.waiverUntil).toBeUndefined();
        expect(SG.fingerprint(out)).not.toMatch(/:w/);
        const api = SG.toApi({ ...out, employeeNumber: 'E7', evaluatedAt: 'x' });
        expect(api.waived).toBeUndefined();
    });
});

describe('the end of a waiver is one notice, and a renewal reaches the webhook', () => {
    const prior = () =>
        mockDb.all.mockImplementation(async (sql) =>
            /FROM safety_gate_status WHERE/.test(sql)
                ? [
                      {
                          employeeId: 7,
                          status: 'WAIVED',
                          enforcedStatus: 'WAIVED',
                          fingerprint: 'old',
                      },
                  ]
                : []
        );

    test('WAIVED to BLOCKED: waiver_ended to the person and the line, not safety.blocked', async () => {
        prior();
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO safety_gate_status/.test(sql) ? { employeeId: 7 } : null
        );
        const r = {
            employeeId: 7,
            employeeNumber: 'E7',
            name: 'Sample Person',
            isActive: true,
            ...SG.evaluateWithModes(PERSON, [rule(1)], facts()),
        };
        await SG.recordStatuses([r], 'waiver_expired', { webhookEnabled: false });
        expect(mockNotify.mock.calls.map(([a]) => `${a.userType}:${a.kind}`)).toEqual([
            'employee:safety.waiver_ended',
            'employee:safety.waiver_ended.team',
        ]);
        const [first] = mockNotify.mock.calls[0];
        expect(first.payload).toMatchObject({ status: 'BLOCKED', previousStatus: 'WAIVED' });
        // No subject or body: the e-mail is the catalogue's own, without a name.
        expect(first.subject).toBeUndefined();
        expect(first.html).toBeUndefined();
    });

    test('WAIVED to WAIVED with a new end: the webhook gets it, nobody is notified', async () => {
        prior();
        const payloads = [];
        mockDb.get.mockImplementation(async (sql, p) => {
            if (/INSERT INTO safety_gate_status /.test(sql)) return { employeeId: 7 };
            if (/INSERT INTO safety_gate_webhook_deliveries/.test(sql)) {
                payloads.push(JSON.parse(p[1]));
                return { id: null };
            }
            return null;
        });
        const r = {
            employeeId: 7,
            employeeNumber: 'E7',
            isActive: true,
            ...SG.evaluateWithModes(PERSON, [rule(1)], facts({ waivers: { 1: W() } })),
        };
        await SG.recordStatuses([r], 'waiver', {
            webhookEnabled: true,
            webhookUrl: 'https://hooks.example.test/gate',
        });
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
            status: 'WAIVED',
            waived: true,
            waiverExpiresAt: UNTIL,
        });
        expect(mockNotify).not.toHaveBeenCalled();
    });
});

describe('who may act: the line, or HSE within clearance, never the person', () => {
    const line = {
        employeeId: 7,
        supervisor: { type: 'employee', id: 50 },
        manager: { type: 'admin', id: 4 },
    };
    beforeEach(() => mockLines.mockResolvedValue(new Map([[7, line]])));

    test('the supervisor and an admin manager are the line', async () => {
        expect(await SW.authority({ id: 50, userType: 'manager' }, 7)).toBe('line');
        expect(await SW.authority({ id: 4, userType: 'admin', role: 'localadmin' }, 7)).toBe(
            'line'
        );
    });

    test('another manager, the person, HSE out of clearance: nobody', async () => {
        expect(await SW.authority({ id: 51, userType: 'manager' }, 7)).toBeNull();
        expect(await SW.authority({ id: 7, userType: 'employee' }, 7)).toBeNull();
        mockScoped.mockResolvedValue([1, 2, 3]);
        expect(await SW.authority(HSE, 7)).toBeNull();
        mockScoped.mockResolvedValue([7]);
        expect(await SW.authority(HSE, 7)).toBe('hse');
        expect(await SW.authority({ ...HSE, permissions: ['view_compliance'] }, 7)).toBeNull();
    });

    test('an admin whose linked employee is the person cannot act on themselves', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM admins WHERE id/.test(sql) ? { linkedEmployeeId: 7 } : null
        );
        expect(await SW.authority({ id: 1, userType: 'admin', role: 'superadmin' }, 7)).toBeNull();
    });

    test('a grant without authority is refused before any write', async () => {
        await expect(
            SW.grantWaiver(
                { employeeId: 7, skillId: 1, hours: 24, reason: 'r' },
                { id: 51, userType: 'manager' }
            )
        ).rejects.toMatchObject({ code: 'forbidden', status: 403, subject: 'waiver' });
        expect(writes()).toEqual([]);
    });

    test('hours outside 1..72 and an empty reason are refused first', async () => {
        const sup = { id: 50, userType: 'manager' };
        for (const hours of [0, 73, 1.5, 'x'])
            await expect(
                SW.grantWaiver({ employeeId: 7, skillId: 1, hours, reason: 'r' }, sup)
            ).rejects.toMatchObject({ code: 'bad_hours' });
        await expect(
            SW.grantWaiver({ employeeId: 7, skillId: 1, hours: 4, reason: ' ' }, sup)
        ).rejects.toMatchObject({ code: 'reason_required', subject: 'waiver' });
        expect(writes()).toEqual([]);
    });

    test('a rule required by law refuses the grant with its own code, before any write', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM employees WHERE id/.test(sql)
                ? { id: 7, roleId: 10, siteId: 1, isActive: true }
                : null
        );
        mockDb.all.mockImplementation(async (sql) =>
            /FROM safety_gate_rules\s+WHERE is_active AND role_id/.test(sql)
                ? [{ id: 3, siteId: null, legallyMandatory: true, mode: 'enforce' }]
                : []
        );
        await expect(
            SW.grantWaiver(
                { employeeId: 7, skillId: 1, hours: 24, reason: 'r' },
                { id: 50, userType: 'manager' }
            )
        ).rejects.toMatchObject({ code: 'legally_mandatory' });
        expect(writes()).toEqual([]);
    });

    test('the cap refuses when the hours already waived plus the new ones pass 144', async () => {
        mockDb.get.mockResolvedValue({ used: 140 });
        await expect(SW._assertUnderCap(7, 1, 5, null)).rejects.toMatchObject({
            code: 'waiver_cap',
            status: 409,
            usedHours: 140,
        });
        await expect(SW._assertUnderCap(7, 1, 4, null)).resolves.toBe(140);
        // An unreadable sum refuses too.
        mockDb.get.mockResolvedValue({ used: 'NaN' });
        await expect(SW._assertUnderCap(7, 1, 1, null)).rejects.toMatchObject({
            code: 'waiver_cap',
        });
    });

    test('a contest is decided by manage_compliance within clearance, never by its filer', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM safety_gate_contests WHERE id/.test(sql)
                ? {
                      id: 5,
                      employeeId: 7,
                      contestedByRef: 'admin:9',
                      contestedAs: 'line',
                      state: 'open',
                  }
                : null
        );
        mockScoped.mockResolvedValue([7]);
        await expect(
            SW.decideContest(5, { decision: 'upheld', reason: 'r' }, HSE)
        ).rejects.toMatchObject({ code: 'self_decision' });
        await expect(
            SW.decideContest(
                5,
                { decision: 'upheld', reason: 'r' },
                { id: 50, userType: 'manager' }
            )
        ).rejects.toMatchObject({ code: 'forbidden', subject: 'decision' });
        mockScoped.mockResolvedValue([1]);
        await expect(
            SW.decideContest(5, { decision: 'upheld', reason: 'r' }, { ...HSE, id: 10 })
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
            SW.decideContest(5, { decision: 'upheld', reason: '  ' }, { ...HSE, id: 10 })
        ).rejects.toMatchObject({ code: 'reason_required', subject: 'decision' });
        await expect(
            SW.decideContest(5, { decision: 'maybe', reason: 'r' }, { ...HSE, id: 10 })
        ).rejects.toMatchObject({ code: 'bad_decision' });
    });
});

describe('switching a rule to observe', () => {
    const ruleRow = (extra = {}) => ({ id: 3, siteId: 1, roleId: 10, mode: 'enforce', ...extra });

    test('a rule required by law is refused, with the mode subject', async () => {
        mockDb.get.mockResolvedValue(ruleRow({ legallyMandatory: true }));
        await expect(
            SG.setRuleMode(3, 'observe', { id: 1, userType: 'admin', role: 'superadmin' }, 'pilot')
        ).rejects.toMatchObject({ code: 'legally_mandatory', status: 409, subject: 'mode' });
        expect(writes()).toEqual([]);
    });

    test('an ordinary rule needs a reason; the reason is audited', async () => {
        const sa = { id: 1, userType: 'admin', role: 'superadmin' };
        mockDb.get.mockResolvedValue(ruleRow());
        await expect(SG.setRuleMode(3, 'observe', sa, '')).rejects.toMatchObject({
            code: 'reason_required',
            subject: 'mode',
        });
        mockDb.get.mockImplementation(async (sql) =>
            /UPDATE safety_gate_rules SET mode/.test(sql)
                ? { id: 3, roleId: 10, mode: 'observe' }
                : ruleRow()
        );
        const out = await SG.setRuleMode(3, 'observe', sa, 'Pilot on one site');
        expect(out.mode).toBe('observe');
        const update = mockDb.get.mock.calls.find(([s]) => /UPDATE safety_gate_rules/.test(s));
        // The SQL itself re-checks the legal mark.
        expect(update[0]).toMatch(/NOT COALESCE\(legally_mandatory, false\)/);
        const log = require('../../src/services/LogService').log.mock.calls.map(([a]) => a);
        expect(log.some((a) => /reason: Pilot on one site/.test(a.details))).toBe(true);
    });

    test('back to enforce needs no reason', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /UPDATE safety_gate_rules SET mode/.test(sql)
                ? { id: 3, roleId: 10, mode: 'enforce' }
                : ruleRow({ mode: 'observe' })
        );
        const out = await SG.setRuleMode(3, 'enforce', {
            id: 1,
            userType: 'admin',
            role: 'superadmin',
        });
        expect(out.mode).toBe('enforce');
    });
});

describe('the page router carries each refusal in its own words', () => {
    const http = require('http');
    const express = require('express');
    let server;
    let base;
    const flashes = [];
    let user = { id: 51, userType: 'manager' };
    beforeAll(async () => {
        const { pageRouter } = require('../../src/routes/v2-safety-gate');
        const app = express();
        app.use(express.urlencoded({ extended: false }));
        app.use((req, _res, next) => {
            req.user = user;
            req.isAuthenticated = () => true;
            req.flash = (type, msg) => flashes.push([type, msg]);
            req.t = (k) => k;
            next();
        });
        app.use('/safety-gate', pageRouter);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => server && new Promise((r) => server.close(r)));
    beforeEach(() => {
        flashes.length = 0;
    });

    const post = (p, body) =>
        fetch(`${base}${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            redirect: 'manual',
        });

    test('a grant from outside the line: the waiver refusal, no write, back to the list', async () => {
        user = { id: 51, userType: 'manager' };
        const r = await post('/safety-gate/waivers', 'employeeId=7&skillId=1&hours=24&reason=r');
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/safety-gate');
        expect(flashes).toEqual([['error', 'safety:err_forbidden_waiver']]);
        expect(writes()).toEqual([]);
    });

    test('a contest without a reason from the person page returns to that page', async () => {
        user = { id: 7, userType: 'employee' };
        const r = await post('/safety-gate/contests', 'employeeId=7&reason=&back=me');
        expect(r.headers.get('location')).toBe('/safety-gate/me');
        expect(flashes).toEqual([['error', 'safety:err_reason_required_contest']]);
    });

    test('an unknown back value never redirects elsewhere', async () => {
        user = { id: 7, userType: 'employee' };
        const r = await post('/safety-gate/contests', 'employeeId=7&reason=&back=//example.test');
        expect(r.headers.get('location')).toBe('/safety-gate');
    });

    test('the person page is for an employee or manager session only', async () => {
        user = { id: 1, userType: 'admin', role: 'superadmin' };
        const r = await fetch(`${base}/safety-gate/me`, { redirect: 'manual' });
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/safety-gate');
    });
});

describe('the pages and the catalogue say « authorised by waiver », never « cleared »', () => {
    const LOC = {
        fr: require('../../locales/fr/safety.json'),
        en: require('../../locales/en/safety.json'),
    };
    const helpers = (lng) => ({
        __: (k, o) => {
            let s = LOC[lng][String(k).replace(/^safety:/, '')] || k;
            if (o) for (const [kk, v] of Object.entries(o)) s = s.replace(`{{${kk}}}`, v);
            return s;
        },
        fmtPeriodBound: (d) => d,
        fmtDateTime: (d) => `D(${d})`,
        csrfToken: 't',
    });

    test('FR and EN carry the same keys, and the waiver status is not the cleared one', () => {
        expect(Object.keys(LOC.fr).sort()).toEqual(Object.keys(LOC.en).sort());
        for (const lng of ['fr', 'en']) {
            const L = LOC[lng];
            expect(L.status_WAIVED).not.toBe(L.status_CLEARED);
            expect(L.status_WAIVED_until).not.toContain(L.status_CLEARED);
            expect(L.status_WAIVED_until).toContain('{{date}}');
        }
        expect(LOC.en.status_WAIVED).toBe('Authorised by waiver');
        expect(LOC.fr.status_WAIVED).toBe('Autorisé par dérogation');
    });

    test.each(['fr', 'en'])(
        '%s — my page: the waiver and its end, not the cleared status',
        async (lng) => {
            const me = {
                employeeId: 7,
                ...SG.evaluateWithModes(PERSON, [rule(1)], facts({ waivers: { 1: W() } })),
            };
            const html = await ejs.renderFile(
                path.join(__dirname, '../../views/pages/safety-gate/me.ejs'),
                {
                    ...helpers(lng),
                    me,
                    enforced: SG.effectiveStatus(me),
                    waived: SG.isWaived(me),
                    waivers: [],
                    contests: [],
                    canContest: false,
                }
            );
            const L = LOC[lng];
            expect(html).toContain(L.status_WAIVED_until.replace('{{date}}', `D(${UNTIL})`));
            expect(html).not.toContain(`<strong>${L.status_CLEARED}</strong>`);
            expect(html).toContain(L.prefix_waived);
            expect(html).not.toContain('action="/safety-gate/contests"');
        }
    );

    test.each(['fr', 'en'])('%s — my page: a blocked person gets the contest form', async (lng) => {
        const me = { employeeId: 7, ...SG.evaluateWithModes(PERSON, [rule(1)], facts()) };
        const html = await ejs.renderFile(
            path.join(__dirname, '../../views/pages/safety-gate/me.ejs'),
            {
                ...helpers(lng),
                me,
                enforced: SG.effectiveStatus(me),
                waived: false,
                waivers: [
                    {
                        id: 1,
                        skillName: 'Skill 1',
                        reason: 'Cover',
                        state: 'revoked',
                        running: false,
                    },
                ],
                contests: [],
                canContest: true,
                teamLink: true,
            }
        );
        expect(html).toContain('action="/safety-gate/contests"');
        expect(html).toContain('name="back" value="me"');
        expect(html).toContain(LOC[lng].waiver_state_revoked);
        expect(html).toContain(LOC[lng].me_team_link);
    });

    test('index: the running waiver and its end, renew and end for the line, decision for HSE', async () => {
        const html = await ejs.renderFile(
            path.join(__dirname, '../../views/pages/safety-gate/index.ejs'),
            {
                ...helpers('fr'),
                options: { sites: [], roles: [] },
                filters: { site: '', role: '' },
                settings: { expiryWarningDays: 30 },
                canConfigure: false,
                expiring: [],
                rulesNone: false,
                counts: { CLEARED: 0, EXPIRING: 0, BLOCKED: 1, NOT_CONFIGURED: 0, WAIVED: 1 },
                blocked: [
                    {
                        employeeId: 8,
                        name: 'Person Eight',
                        employeeNumber: 'E8',
                        authority: 'line',
                        canContest: true,
                        waivable: [{ skillId: 1, skillName: 'Working at height' }],
                        reasons: [
                            {
                                code: 'not_assessed',
                                blocking: true,
                                skillName: 'Working at height',
                            },
                        ],
                    },
                ],
                waived: [{ employeeId: 7 }],
                waivers: [
                    {
                        id: 91,
                        employeeId: 7,
                        name: 'Person Seven',
                        employeeNumber: 'E7',
                        skillName: 'Lockout',
                        grantVia: 'line',
                        reason: 'Shift cover',
                        expiresAt: UNTIL,
                        isRenewal: false,
                        authority: 'line',
                    },
                ],
                contests: [
                    {
                        id: 5,
                        employeeId: 8,
                        name: 'Person Eight',
                        contestedAs: 'self',
                        reason: 'Certificate obtained',
                        createdAt: 'c',
                        canDecide: true,
                        skills: [{ id: 1, name: 'Working at height' }],
                    },
                ],
                hoursMax: 72,
            }
        );
        expect(html).toContain(`AUTORISÉ PAR DÉROGATION (jusqu’au D(${UNTIL}))`);
        for (const action of [
            '/safety-gate/waivers',
            '/safety-gate/waivers/91/renew',
            '/safety-gate/waivers/91/revoke',
            '/safety-gate/contests',
            '/safety-gate/contests/5/decide',
        ])
            expect(html).toContain(`action="${action}"`);
        expect(html).toContain('max="72"');
    });

    test('config: the legal mark is shown, and its mode cannot be loosened from the page', async () => {
        const FR = LOC.fr;
        const html = await ejs.renderFile(
            path.join(__dirname, '../../views/pages/safety-gate/config.ejs'),
            {
                ...helpers('fr'),
                rules: [
                    {
                        id: 3,
                        roleName: 'Operator',
                        siteName: null,
                        skillName: 'Lockout',
                        minLevel: 2,
                        certRequired: true,
                        mode: 'enforce',
                        legallyMandatory: true,
                        isActive: true,
                        canManage: true,
                    },
                    {
                        id: 4,
                        roleName: 'Operator',
                        siteName: null,
                        skillName: 'First aid',
                        minLevel: 2,
                        certRequired: false,
                        mode: 'enforce',
                        legallyMandatory: false,
                        isActive: true,
                        canManage: true,
                    },
                ],
                options: { roles: [], sites: [], skills: [] },
                settings: {
                    expiryWarningDays: 30,
                    webhookUrl: '',
                    webhookEnabled: false,
                    hasSecret: false,
                },
                deliveries: [],
                showAll: false,
                cspNonce: 'n',
                isSuper: true,
                preview: null,
                draft: null,
            }
        );
        expect(html).toContain(FR.legal_badge);
        expect(html).toContain(FR.mode_locked_legal);
        expect(html).toContain('id="sg-mode-reason-4"');
        expect(html).not.toContain('id="sg-mode-reason-3"');
        expect(html).toContain(FR.btn_unmark_legal);
        expect(html).toContain(FR.btn_mark_legal);
    });

    test('the six notification kinds are in the catalogue, in FR and EN', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/NotificationService.js'),
            'utf8'
        );
        const N = jest.requireActual('../../src/services/NotificationService');
        for (const kind of [
            'safety.waiver_granted',
            'safety.waiver_granted.team',
            'safety.waiver_ended',
            'safety.waiver_ended.team',
            'safety.contest.review',
            'safety.contest.decided',
        ]) {
            expect([kind, typeof N.KIND_LABELS[kind]]).toEqual([kind, 'string']);
            expect([
                kind,
                Boolean(N.KIND_META[kind].title.fr && N.KIND_META[kind].title.en),
            ]).toEqual([kind, true]);
            expect([kind, N.KIND_POLICY[kind]]).toEqual([kind, 'immediate']);
            const msg = N.KIND_MESSAGES[kind];
            expect([kind, Boolean(msg && msg.fr && msg.en)]).toEqual([kind, true]);
            expect(src).toContain(`'${kind}'`);
        }
    });

    test('the job ends expired waivers on every tick', () => {
        const job = fs.readFileSync(path.join(__dirname, '../../src/jobs/safety-gate.js'), 'utf8');
        expect(job).toMatch(/SafetyWaiverService'\)\.expireDue\(\)/);
    });
});
