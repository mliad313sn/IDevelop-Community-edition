'use strict';
/**
 * 3.23.21 lane L1 — safety-gate rollout (F5), rule options (F6), notification
 * of a transition (F7) and the index page wording (UX-6).
 *
 * Behavioural: the real SafetyGateService over a mocked database; the real
 * EJS view rendered with a stub translator.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockScoped = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScoped(...a),
    scopeClause: () => '',
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
const mockLine = jest.fn();
jest.mock('../../src/services/ReportingLineService', () => ({
    lineRecipients: (...a) => mockLine(...a),
}));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    canAccessSite: async () => true,
}));

const path = require('path');
const ejs = require('ejs');
const SG = require('../../src/services/SafetyGateService');

const { STATUS, REASON } = SG;
const EMP = { id: 7, isActive: true, roleId: 10, siteId: 1 };
const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const rule = (skillId, minLevel, extra = {}) => ({
    roleId: 10,
    siteId: null,
    skillId,
    skillName: `S${skillId}`,
    minLevel,
    certRequired: false,
    ...extra,
});
const facts = ({ levels = {}, assessedAt = {}, validated = {} } = {}) => ({
    levels: new Map(Object.entries(levels).map(([k, v]) => [Number(k), v])),
    assessedAt: new Map(Object.entries(assessedAt).map(([k, v]) => [Number(k), v])),
    validated: new Map(Object.entries(validated).map(([k, v]) => [Number(k), v])),
    certs: new Map(),
    lapsed: new Map(),
});
const codes = (r) => r.reasons.map((x) => x.code);

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockScoped.mockReset().mockResolvedValue(null);
    mockNotify.mockClear();
    mockLine.mockReset().mockResolvedValue([{ userType: 'employee', id: 50, role: 'reviewer' }]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('F5 — observe mode computes and shows, but does not close the gate', () => {
    test('blocked only by an observe rule → status BLOCKED, API cleared:true + observe flag', () => {
        const out = SG.evaluateWithModes(
            EMP,
            [rule(1, 3, { mode: 'observe' })],
            facts({ levels: { 1: 1 } })
        );
        expect(out.status).toBe(STATUS.BLOCKED);
        expect(out.enforcedStatus).toBe(STATUS.NOT_CONFIGURED);
        const api = SG.toApi({ ...out, employeeNumber: 'E7', evaluatedAt: 'x' });
        expect(api).toMatchObject({ status: 'BLOCKED', cleared: true, observe: true });
        expect(api.reasons).toEqual([
            {
                code: REASON.LEVEL_BELOW_MIN,
                blocking: true,
                skillId: 1,
                skillName: 'S1',
                observe: true,
            },
        ]);
    });

    test('an enforce rule still blocks next to an observe one; only the observe reason is tagged', () => {
        const out = SG.evaluateWithModes(
            EMP,
            [rule(1, 3, { mode: 'enforce' }), rule(2, 2, { mode: 'observe' })],
            facts({ levels: { 1: 1, 2: 1 } })
        );
        const api = SG.toApi({ ...out, employeeNumber: 'E7' });
        expect(api.cleared).toBe(false);
        expect(api.reasons.find((x) => x.skillId === 1).observe).toBeUndefined();
        expect(api.reasons.find((x) => x.skillId === 2).observe).toBe(true);
    });

    test('rules without a mode (pre-155) are enforced; fingerprint unchanged from 3.23.18', () => {
        const out = SG.evaluateWithModes(EMP, [rule(1, 3)], facts({ levels: { 1: 1 } }));
        expect(SG.toApi({ ...out }).cleared).toBe(false);
        expect(SG.fingerprint(out)).toBe('BLOCKED|level_below_min:1:');
    });

    test('a leaver is never cleared, even when every rule observes', () => {
        const out = SG.evaluateWithModes(
            { ...EMP, isActive: false },
            [rule(1, 1, { mode: 'observe' })],
            facts({ levels: { 1: 4 } })
        );
        expect(SG.toApi(out).cleared).toBe(false);
    });

    test('NOT_CONFIGURED stays not cleared', () => {
        expect(SG.toApi(SG.evaluateWithModes(EMP, [], facts())).cleared).toBe(false);
    });

    test('a NEW rule defaults to observe; an unknown mode is refused', () => {
        expect(SG.normaliseRule({ roleId: 1, skillId: 2, minLevel: 2 }).mode).toBe('observe');
        expect(() => SG.normaliseRule({ roleId: 1, skillId: 2, minLevel: 2, mode: 'x' })).toThrow(
            expect.objectContaining({ code: 'bad_mode' })
        );
    });

    test('impact preview counts the people the rule would NEWLY block, and records nothing', async () => {
        const people = [
            { id: 1, employeeNumber: 'A', name: 'A', isActive: true, roleId: 10, siteId: 1 },
            { id: 2, employeeNumber: 'B', name: 'B', isActive: true, roleId: 10, siteId: 1 },
            { id: 3, employeeNumber: 'C', name: 'C', isActive: true, roleId: 10, siteId: 1 },
        ];
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_settings/.test(sql)) return { expiryWarningDays: 30 };
            if (/FROM skills WHERE id/.test(sql)) return { name: 'Consignation' };
            return null;
        });
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM employees e/.test(sql)) return people;
            if (/FROM safety_gate_rules gr JOIN skills/.test(sql)) return [];
            if (/v_resolved_assessments/.test(sql))
                return [
                    { employeeId: 1, skillId: 9, level: 4 },
                    { employeeId: 2, skillId: 9, level: 1 },
                ];
            return [];
        });
        const p = await SG.previewRule({ roleId: 10, siteId: 1, skillId: 9, minLevel: 2 }, SUPER);
        expect(p).toMatchObject({ evaluated: 3, newlyBlocked: 2 }); // B below, C never assessed
        expect(p.rule).toMatchObject({ mode: 'observe', skillName: 'Consignation' });
        const writes = [...mockDb.run.mock.calls, ...mockDb.get.mock.calls].filter(([sql]) =>
            /\b(INSERT|UPDATE)\b/.test(sql)
        );
        expect(writes).toHaveLength(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('F6 — supervisor-validated level and maximum assessment age', () => {
    const NOW = new Date('2026-09-29T12:00:00Z');

    test('requireValidated: an approved self-rating alone blocks with level_not_validated', () => {
        const r = SG.evaluate(
            EMP,
            [rule(1, 2, { requireValidated: true })],
            facts({ levels: { 1: 4 } })
        );
        expect(r.status).toBe(STATUS.BLOCKED);
        expect(codes(r)).toEqual([REASON.LEVEL_NOT_VALIDATED]);
    });

    test('requireValidated: the latest VALIDATED level is the one judged', () => {
        const f = facts({
            levels: { 1: 4 },
            validated: { 1: { level: 1, assessedAt: '2026-06-01' } },
        });
        expect(codes(SG.evaluate(EMP, [rule(1, 2, { requireValidated: true })], f))).toEqual([
            REASON.LEVEL_BELOW_MIN,
        ]);
        const ok = facts({
            levels: { 1: 1 },
            validated: { 1: { level: 3, assessedAt: '2026-06-01' } },
        });
        expect(SG.evaluate(EMP, [rule(1, 2, { requireValidated: true })], ok).status).toBe(
            STATUS.CLEARED
        );
    });

    test('requireValidated with nothing at all stays not_assessed', () => {
        expect(codes(SG.evaluate(EMP, [rule(1, 2, { requireValidated: true })], facts()))).toEqual([
            REASON.NOT_ASSESSED,
        ]);
    });

    test('maxAgeMonths: an older measurement blocks with assessment_too_old; a recent one clears', () => {
        const r12 = rule(1, 2, { maxAgeMonths: 12 });
        const old = SG.evaluate(
            EMP,
            [r12],
            facts({ levels: { 1: 4 }, assessedAt: { 1: '2025-01-15' } }),
            { now: NOW }
        );
        expect(old.status).toBe(STATUS.BLOCKED);
        expect(old.reasons[0]).toMatchObject({
            code: REASON.ASSESSMENT_TOO_OLD,
            maxAgeMonths: 12,
            assessedOn: '2025-01-15',
        });
        const fresh = SG.evaluate(
            EMP,
            [r12],
            facts({ levels: { 1: 4 }, assessedAt: { 1: '2026-03-01' } }),
            { now: NOW }
        );
        expect(fresh.status).toBe(STATUS.CLEARED);
    });

    test('maxAgeMonths with no date on the measurement fails closed', () => {
        const r = SG.evaluate(EMP, [rule(1, 2, { maxAgeMonths: 6 })], facts({ levels: { 1: 4 } }), {
            now: NOW,
        });
        expect(codes(r)).toEqual([REASON.ASSESSMENT_TOO_OLD]);
    });

    test('options merge to the strictest: validated if any, the shortest age', () => {
        const [m] = SG.applicableRules(EMP, [
            rule(1, 2, { maxAgeMonths: 24 }),
            rule(1, 1, { maxAgeMonths: 6, requireValidated: true }),
        ]);
        expect(m).toMatchObject({ minLevel: 2, requireValidated: true, maxAgeMonths: 6 });
    });

    test('max age must be a whole number of months in 1..120', () => {
        for (const v of [0, 121, 2.5, 'x'])
            expect(() =>
                SG.normaliseRule({ roleId: 1, skillId: 2, minLevel: 2, maxAgeMonths: v })
            ).toThrow(expect.objectContaining({ code: 'bad_max_age' }));
        expect(
            SG.normaliseRule({ roleId: 1, skillId: 2, minLevel: 2, maxAgeMonths: '' }).maxAgeMonths
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe('F7 — the person and their line are told, exactly once per transition', () => {
    const blocked = {
        employeeId: 7,
        employeeNumber: 'E7',
        name: 'Awa Silva',
        isActive: true,
        status: STATUS.BLOCKED,
        enforcedStatus: STATUS.BLOCKED,
        reasons: [
            {
                code: 'level_below_min',
                blocking: true,
                skillId: 3,
                skillName: 'Consignation',
                level: 1,
            },
        ],
        nextExpiry: null,
        evaluatedAt: 'x',
    };
    function wire(cached, { upsertWins = true } = {}) {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM safety_gate_status WHERE/.test(sql) ? cached : []
        );
        mockDb.get.mockImplementation(async (sql) => {
            if (/INSERT INTO safety_gate_status /.test(sql))
                return upsertWins ? { employeeId: 7 } : null;
            if (/FROM idp_plans/.test(sql)) return { id: 91 };
            return null;
        });
    }
    const cfg = { webhookEnabled: false };

    test('CLEARED → BLOCKED: one notification to the person, one per line recipient, with reason + plan link', async () => {
        wire([{ employeeId: 7, status: 'CLEARED', enforcedStatus: null, fingerprint: 'CLEARED|' }]);
        await SG.recordStatuses([blocked], 'nightly', cfg);
        expect(mockLine).toHaveBeenCalledWith(7, { includeManager: true });
        expect(mockNotify).toHaveBeenCalledTimes(2);
        const [person, line] = mockNotify.mock.calls.map((c) => c[0]);
        expect(person).toMatchObject({ userType: 'employee', userId: 7, kind: 'safety.blocked' });
        expect(person.payload.link).toBe('/v2/idp');
        expect(person.payload.reason).toMatch(/Consignation — Niveau inférieur au minimum requis/);
        expect(line).toMatchObject({
            userType: 'employee',
            userId: 50,
            kind: 'safety.blocked.team',
        });
        expect(line.payload.link).toBe('/v2/idp/91');
        expect(line.payload.reason).toMatch(/^Awa Silva — /);
        // never a level or a score in what is written
        expect(JSON.stringify(mockNotify.mock.calls)).not.toMatch(/"level"|niveau 1|level 1/i);
    });

    test('BLOCKED again with another reason: recorded, but NOT notified again', async () => {
        wire([
            {
                employeeId: 7,
                status: 'BLOCKED',
                enforcedStatus: 'BLOCKED',
                fingerprint: 'BLOCKED|not_assessed:3:',
            },
        ]);
        await SG.recordStatuses([blocked], 'nightly', cfg);
        expect(mockDb.run.mock.calls.some(([s]) => /safety_gate_status_history/.test(s))).toBe(
            true
        );
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('a concurrent evaluation that lost the upsert does not notify a second time', async () => {
        wire(
            [{ employeeId: 7, status: 'CLEARED', enforcedStatus: null, fingerprint: 'CLEARED|' }],
            {
                upsertWins: false,
            }
        );
        await SG.recordStatuses([blocked], 'api', cfg);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('BLOCKED only by an observe rule does not notify (access is not closed)', async () => {
        wire([{ employeeId: 7, status: 'CLEARED', enforcedStatus: null, fingerprint: 'CLEARED|' }]);
        await SG.recordStatuses(
            [
                {
                    ...blocked,
                    enforcedStatus: STATUS.CLEARED,
                    reasons: [{ ...blocked.reasons[0], observe: true }],
                },
            ],
            'nightly',
            cfg
        );
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('switching that rule to enforce (same status, enforced now BLOCKED) notifies once', async () => {
        wire([
            {
                employeeId: 7,
                status: 'BLOCKED',
                enforcedStatus: 'CLEARED',
                fingerprint: 'BLOCKED/CLEARED|level_below_min:3::o',
            },
        ]);
        await SG.recordStatuses([blocked], 'rule_change', cfg);
        expect(mockNotify.mock.calls.map((c) => c[0].kind)).toEqual([
            'safety.blocked',
            'safety.blocked.team',
        ]);
    });

    test('CLEARED → EXPIRING notifies with the expiring kind; a leaver is never notified', async () => {
        wire([{ employeeId: 7, status: 'CLEARED', enforcedStatus: null, fingerprint: 'CLEARED|' }]);
        const expiring = {
            ...blocked,
            status: STATUS.EXPIRING,
            enforcedStatus: STATUS.EXPIRING,
            reasons: [
                {
                    code: 'cert_expiring',
                    blocking: false,
                    skillId: 3,
                    skillName: 'Consignation',
                    expiresOn: '2026-10-10',
                },
            ],
        };
        await SG.recordStatuses([expiring], 'nightly', cfg);
        expect(mockNotify.mock.calls[0][0].kind).toBe('safety.expiring');
        mockNotify.mockClear();
        wire([{ employeeId: 7, status: 'CLEARED', enforcedStatus: null, fingerprint: 'CLEARED|' }]);
        await SG.recordStatuses([{ ...blocked, isActive: false }], 'nightly', cfg);
        expect(mockNotify).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('UX-6 — the index page says what it means, in words', () => {
    const view = path.join(__dirname, '../../views/pages/safety-gate/index.ejs');
    const FR = require('../../locales/fr/safety.json');
    const __ = (k, o) => {
        let s = FR[String(k).replace(/^safety:/, '')] || k;
        if (o) for (const [kk, v] of Object.entries(o)) s = s.replace(`{{${kk}}}`, v);
        return s;
    };
    const base = {
        __,
        fmtPeriodBound: (d) => d,
        options: { sites: [], roles: [] },
        filters: { site: '', role: '' },
        settings: { expiryWarningDays: 30 },
        canConfigure: true,
        expiring: [],
    };

    test('only unconfigured roles → "no critical skill is configured", not "nobody is blocked"', async () => {
        const html = await ejs.renderFile(view, {
            ...base,
            counts: { CLEARED: 0, EXPIRING: 0, BLOCKED: 0, NOT_CONFIGURED: 12 },
            blocked: [],
            rulesNone: true,
        });
        expect(html).toContain(FR.rules_none);
        expect(html).not.toContain(FR.blocked_none);
        // F5 doc text: NOT_CONFIGURED is not a denial.
        expect(html).toContain(FR.not_configured_is_not_denial);
        expect(html).toContain('Personnes dont le poste n’a aucune exigence');
    });

    test('reasons carry a text prefix, observe-only people a badge', async () => {
        const html = await ejs.renderFile(view, {
            ...base,
            counts: { CLEARED: 0, EXPIRING: 0, BLOCKED: 1, NOT_CONFIGURED: 0 },
            rulesNone: false,
            blocked: [
                {
                    employeeId: 7,
                    name: 'A',
                    employeeNumber: 'E7',
                    observeOnly: true,
                    reasons: [
                        { code: 'not_assessed', blocking: true, skillName: 'S1', observe: true },
                        {
                            code: 'cert_expiring',
                            blocking: false,
                            skillName: 'S2',
                            expiresOn: '2026-10-01',
                        },
                        { code: 'level_below_min', blocking: true, skillName: 'S3' },
                    ],
                },
            ],
        });
        expect(html).toContain('<strong>Observation :</strong>');
        expect(html).toContain('<strong>Attention :</strong>');
        expect(html).toContain('<strong>Bloquant :</strong>');
        expect(html).toContain(FR.observe_only_badge);
        expect(html).toContain('dont 1 en mode observation');
    });
});

describe('config page — SEC-1 mirrored in the UI, F5 preview, F6 options', () => {
    const view = path.join(__dirname, '../../views/pages/safety-gate/config.ejs');
    const FR = require('../../locales/fr/safety.json');
    const __ = (k, o) => {
        let s = FR[String(k).replace(/^safety:/, '')] || k;
        if (o) for (const [kk, v] of Object.entries(o)) s = s.replace(`{{${kk}}}`, v);
        return s;
    };
    const rules = [
        {
            id: 1,
            roleName: 'Foreur',
            siteName: null,
            siteId: null,
            skillName: 'S1',
            minLevel: 2,
            certRequired: false,
            mode: 'enforce',
            isActive: true,
            canManage: false,
        },
        {
            id: 2,
            roleName: 'Foreur',
            siteName: 'Mine',
            siteId: 5,
            skillName: 'S2',
            minLevel: 3,
            certRequired: true,
            mode: 'observe',
            requireValidated: true,
            maxAgeMonths: 12,
            isActive: true,
            canManage: true,
        },
    ];
    const base = {
        __,
        csrfToken: 't',
        cspNonce: 'n',
        fmtDateTime: (d) => String(d),
        rules,
        options: { roles: [{ id: 10, name: 'Foreur' }], sites: [{ id: 5, name: 'Mine' }] },
        settings: {
            expiryWarningDays: 30,
            webhookUrl: '',
            webhookEnabled: false,
            hasSecret: false,
        },
        deliveries: [],
        showAll: false,
        preview: null,
        draft: null,
    };

    test('a local admin: no settings form, no "all sites" choice, no action on a global rule', async () => {
        const html = await ejs.renderFile(view, { ...base, isSuper: false });
        expect(html).not.toContain('action="/safety-gate/config/settings"');
        expect(html).toContain(FR.settings_superadmin_only);
        expect(html).not.toContain(`<option value="">${FR.all_sites_rule}</option>`);
        expect(html).not.toContain('/safety-gate/config/rules/1/deactivate');
        expect(html).toContain('/safety-gate/config/rules/2/deactivate');
        expect(html).toContain('/safety-gate/config/rules/2/mode');
        expect(html).toContain(FR.not_in_your_scope);
        expect(html).toContain('action="/safety-gate/config/rules/preview"');
        expect(html).toContain(FR.opt_validated);
    });

    test('the SuperAdmin gets the settings form and the preview panel with a confirmation', async () => {
        const html = await ejs.renderFile(view, {
            ...base,
            isSuper: true,
            preview: {
                evaluated: 9,
                newlyBlocked: 4,
                alreadyBlocked: 1,
                sample: [{ name: 'A', siteName: 'Mine' }],
            },
            draft: {
                roleId: 10,
                siteId: null,
                skillId: 3,
                skillName: 'Consignation',
                minLevel: 2,
                certRequired: false,
                requireValidated: true,
                maxAgeMonths: 24,
                mode: 'observe',
            },
        });
        expect(html).toContain('action="/safety-gate/config/settings"');
        expect(html).toContain('4 personne(s) deviendraient bloquées sur 9 évaluée(s).');
        expect(html).toContain(FR.btn_confirm_add);
        expect(html).toMatch(/name="maxAgeMonths" value="24"/);
        expect(html).toMatch(/name="mode" value="observe"/);
    });
});
