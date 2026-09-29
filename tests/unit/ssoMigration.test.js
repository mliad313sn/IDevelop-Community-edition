/**
 * SSO migration — bulk remap of existing employees onto SSO identities
 * (migration 144, SsoRemapService, SsoService.claimPendingMapping).
 *
 * The rules pinned here are the committee's hard requirements: employees only;
 * nothing guessed (every ambiguity stops the row with its reason); counts add
 * up to the file; the Entra objectId — immutable — is the identity key; e-mail
 * alone can never claim a mapping; guests and foreign tenants are refused; an
 * admin's local password is never disabled by an SSO sign-in.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: jest.fn() }));

const db = require('../../src/config/database');
const AppSettingsModel = require('../../src/models/AppSettingsModel');
const R = require('../../src/services/SsoRemapService');
const S = require('../../src/services/SsoService');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    db.runTransaction.mockImplementation((fn) => fn());
});

// ---------------------------------------------------------------------------
describe('parseCsv — an Entra "Download users" export in its real shapes', () => {
    test('BOM, Entra headers, quoted cells with commas', () => {
        const r = R.parseCsv(
            '﻿objectId,userPrincipalName,mail,employeeId,displayName\r\n' +
                'A-1,a@x.com,a@x.com,E1,"Doe, Jane"\r\n'
        );
        expect(r.error).toBeUndefined();
        expect(r.rows).toEqual([
            expect.objectContaining({
                rowNo: 2,
                objectId: 'A-1',
                upn: 'a@x.com',
                mail: 'a@x.com',
                employeeId: 'E1',
                displayName: 'Doe, Jane',
            }),
        ]);
    });
    test('semicolon separator and an Excel sep= line; header spellings vary', () => {
        const r = R.parseCsv('sep=;\nObject ID;User principal name;Employee ID\nA-1;a@x.com;E1\n');
        expect(r.rows[0]).toEqual(
            expect.objectContaining({ objectId: 'A-1', upn: 'a@x.com', employeeId: 'E1' })
        );
    });
    test('a file with no claim-able key column is refused', () => {
        expect(R.parseCsv('mail,displayName\na@x.com,A\n').error).toBe('ssom_err_no_key_column');
    });
    test('an empty file is refused', () => {
        expect(R.parseCsv('objectId\n').error).toBe('ssom_err_empty');
    });
});

// ---------------------------------------------------------------------------
function ctxOf(emps, { linked = [], pending = [], uidHolder = {} } = {}) {
    const byId = new Map();
    const byNumber = new Map();
    const byEmail = new Map();
    emps.forEach((e) => {
        const rec = {
            active: true,
            localOnly: false,
            site: 'S',
            name: e.name || `E${e.id}`,
            email: '',
            number: '',
            ...e,
        };
        byId.set(rec.id, rec);
        if (rec.number)
            byNumber.set(rec.number.toLowerCase(), [
                ...(byNumber.get(rec.number.toLowerCase()) || []),
                rec,
            ]);
        if (rec.email) byEmail.set(rec.email, [...(byEmail.get(rec.email) || []), rec]);
    });
    const pendingByEmployee = new Map();
    const pendingKey = new Map();
    pending.forEach((p) => {
        pendingByEmployee.set(p.employeeId, p);
        if (p.oid) pendingKey.set('oid:' + p.oid, p.employeeId);
        if (p.upn) pendingKey.set('upn:' + p.upn, p.employeeId);
    });
    return {
        byId,
        byNumber,
        byEmail,
        linkedEmployees: new Set(linked),
        uidHolder: new Map(Object.entries(uidHolder)),
        pendingByEmployee,
        pendingKey,
    };
}
const row = (rowNo, o) => ({
    rowNo,
    objectId: '',
    upn: '',
    mail: '',
    employeeId: '',
    displayName: '',
    userType: '',
    accountEnabled: '',
    ...o,
});
const outcomeOf = (rows, ctx, res) => R.classify(rows, ctx, res).map((r) => r.outcome);

describe('classify — every row gets a named outcome; nothing is guessed', () => {
    const emps = [
        { id: 1, number: 'E1', email: 'a@x.com' },
        { id: 2, number: 'E2', email: 'shared@x.com' },
        { id: 3, number: 'E3', email: 'shared@x.com' },
        { id: 4, number: 'E4', email: 'b@x.com', active: false },
        { id: 5, number: 'E5', email: 'c@x.com', localOnly: true },
        { id: 6, number: 'E6', email: 'd@x.com' },
        { id: 7, number: 'E7', email: 'e@x.com' },
    ];
    test('employee number is decisive', () => {
        const [r] = R.classify([row(2, { objectId: 'OID1', employeeId: 'e1' })], ctxOf(emps));
        expect(r.outcome).toBe('will_map');
        expect(r.matchKey).toBe('employee_number');
        expect(r.employee.id).toBe(1);
    });
    test('e-mail, then UPN, when there is no employee number', () => {
        expect(
            R.classify([row(2, { upn: 'u@corp', mail: 'A@x.com' })], ctxOf(emps))[0].matchKey
        ).toBe('email');
        expect(R.classify([row(2, { upn: 'a@x.com' })], ctxOf(emps))[0].matchKey).toBe('upn');
    });
    test('a shared address never picks one of its owners', () => {
        const [r] = R.classify([row(2, { upn: 'u@corp', mail: 'shared@x.com' })], ctxOf(emps));
        expect(r.outcome).toBe('ambiguous');
        expect(r.candidates.map((c) => c.id).sort()).toEqual([2, 3]);
    });
    test('employee number and e-mail pointing at different people stop the row', () => {
        expect(
            outcomeOf([row(2, { employeeId: 'E1', mail: 'd@x.com', upn: 'z@corp' })], ctxOf(emps))
        ).toEqual(['conflicting_keys']);
    });
    test('a manual resolution decides an ambiguous row, and is recorded as manual', () => {
        const [r] = R.classify([row(2, { upn: 'u@corp', mail: 'shared@x.com' })], ctxOf(emps), {
            2: 3,
        });
        expect(r.outcome).toBe('will_map');
        expect(r.matchKey).toBe('manual');
        expect(r.employee.id).toBe(3);
    });
    test('refusals: no match, inactive, password-only, guest, disabled, no claim key', () => {
        expect(
            outcomeOf(
                [
                    row(2, { upn: 'nobody@corp' }),
                    row(3, { employeeId: 'E4', upn: 'b2@corp' }),
                    row(4, { employeeId: 'E5', upn: 'c2@corp' }),
                    row(5, { upn: 'g_x#EXT#@corp', employeeId: 'E6' }),
                    row(6, { upn: 'h@corp', employeeId: 'E7', accountEnabled: 'False' }),
                    row(7, { mail: 'a@x.com' }),
                ],
                ctxOf(emps)
            )
        ).toEqual([
            'no_match',
            'inactive',
            'local_only',
            'guest',
            'directory_disabled',
            'no_claim_key',
        ]);
    });
    test('the same key twice in the file: every copy is refused', () => {
        expect(
            outcomeOf(
                [
                    row(2, { objectId: 'X', employeeId: 'E1' }),
                    row(3, { objectId: 'x', employeeId: 'E6' }),
                ],
                ctxOf(emps)
            )
        ).toEqual(['duplicate_in_file', 'duplicate_in_file']);
    });
    test('two rows landing on the same employee: neither wins', () => {
        expect(
            outcomeOf(
                [
                    row(2, { objectId: 'P', employeeId: 'E1' }),
                    row(3, { objectId: 'Q', mail: 'a@x.com' }),
                ],
                ctxOf(emps)
            )
        ).toEqual(['duplicate_target', 'duplicate_target']);
    });
    test('already linked / already mapped / identity or key held by someone else', () => {
        const ctx = ctxOf(emps, {
            linked: [1],
            pending: [{ employeeId: 6, upn: 'd@corp' }],
            uidHolder: { oid7: { type: 'employee', id: 99 } },
        });
        expect(
            outcomeOf(
                [
                    row(2, { employeeId: 'E1', objectId: 'o1' }),
                    row(3, { employeeId: 'E6', objectId: 'o6' }),
                    row(4, { employeeId: 'E7', objectId: 'OID7' }),
                ],
                ctx
            )
        ).toEqual(['already_linked', 'already_mapped', 'identity_taken']);
        const ctx2 = ctxOf(emps, { pending: [{ employeeId: 6, upn: 'taken@corp' }] });
        expect(outcomeOf([row(2, { employeeId: 'E7', upn: 'TAKEN@corp' })], ctx2)).toEqual([
            'key_taken',
        ]);
    });
    test('the outcome counts always add up to the file', () => {
        const rows = [
            row(2, { employeeId: 'E1', objectId: 'a' }),
            row(3, { upn: 'nobody@corp' }),
            row(4, { mail: 'x' }),
        ];
        const s = R.summarize(R.classify(rows, ctxOf(emps)));
        expect(s.total).toBe(3);
        expect(Object.values(s.counts).reduce((a, b) => a + b, 0)).toBe(3);
        expect(s.toMap).toBe(1);
    });
});

// ---------------------------------------------------------------------------
describe('preview / apply / undo — gates', () => {
    const superA = { id: 1, userType: 'admin', role: 'superadmin' };
    const local = { id: 2, userType: 'admin', role: 'localadmin', permissions: ['manage_admins'] };
    test('only a SuperAdmin may preview, apply or undo', async () => {
        expect((await R.preview({ text: 'objectId\nA\n', provider: 'saml' }, local)).code).toBe(
            'ssom_err_super_only'
        );
        expect((await R.apply({ previewId: 1, expectedCount: 1 }, local)).code).toBe(
            'ssom_err_super_only'
        );
        expect((await R.undo({ batchId: 1, reason: 'because' }, local)).code).toBe(
            'ssom_err_super_only'
        );
        expect(db.run).not.toHaveBeenCalled();
    });
    test('unknown provider refused before any read', async () => {
        expect((await R.preview({ text: 'objectId\nA\n', provider: 'evil' }, superA)).code).toBe(
            'ssom_err_provider'
        );
        expect(db.all).not.toHaveBeenCalled();
    });
    test('undo needs a reason', async () => {
        expect((await R.undo({ batchId: 1, reason: ' no ' }, superA)).code).toBe('ssom_err_reason');
    });
    test('apply refuses when the live count differs from the confirmed one — and writes nothing', async () => {
        db.get.mockImplementation(async (sql) => {
            if (/FROM sso_remap_batches WHERE id/.test(sql)) {
                return {
                    id: 5,
                    provider: 'saml',
                    mode: 'dry_run',
                    status: 'previewed',
                    summary: {},
                    expired: false,
                    used: false,
                };
            }
            return {};
        });
        db.all.mockImplementation(async (sql) => {
            if (/FROM sso_remap_rows/.test(sql))
                return [{ rowNo: 2, input: { objectId: 'o', employeeId: 'E1' } }];
            if (/FROM employees e/.test(sql))
                return [
                    {
                        id: 1,
                        employeeNumber: 'E1',
                        email: '',
                        firstName: 'A',
                        lastName: 'B',
                        isAccountActive: true,
                        authPolicy: 'any',
                    },
                ];
            return [];
        });
        const r = await R.apply({ previewId: 5, expectedCount: 7 }, superA);
        expect(r).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'ssom_err_stale',
                params: { expected: 7, now: 1 },
            })
        );
        expect(db.run).not.toHaveBeenCalled();
    });
    test('R2-D1: the SAME count mapping a DIFFERENT person is refused (fingerprint of who, not how many)', async () => {
        const emps = [
            { id: 85, number: 'E85' },
            { id: 86, number: 'E86' },
        ];
        const rows = [
            row(2, { objectId: 'a', employeeId: 'E85' }),
            row(3, { objectId: 'b', employeeId: 'E86' }),
        ];
        const before = R.summarize(
            R.classify(rows, ctxOf([{ ...emps[0] }, { ...emps[1], active: false }]))
        );
        const after = R.summarize(
            R.classify(rows, ctxOf([{ ...emps[0], active: false }, { ...emps[1] }]))
        );
        expect(before.toMap).toBe(after.toMap);
        expect(before.fingerprint).not.toBe(after.fingerprint);

        db.get.mockImplementation(async (sql) =>
            /FROM sso_remap_batches WHERE id/.test(sql)
                ? {
                      id: 5,
                      provider: 'saml',
                      mode: 'dry_run',
                      summary: { fingerprint: before.fingerprint },
                      expired: false,
                      used: false,
                  }
                : {}
        );
        db.all.mockImplementation(async (sql) => {
            if (/FROM sso_remap_rows/.test(sql))
                return rows.map((r) => ({ rowNo: r.rowNo, input: r }));
            if (/FROM employees e/.test(sql)) {
                return [
                    { id: 85, employeeNumber: 'E85', isAccountActive: false, authPolicy: 'any' },
                    { id: 86, employeeNumber: 'E86', isAccountActive: true, authPolicy: 'any' },
                ];
            }
            return [];
        });
        const r = await R.apply({ previewId: 5, expectedCount: 1 }, superA);
        expect(r.code).toBe('ssom_err_stale');
        expect(db.run).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('SsoService — the identity key and the claim', () => {
    test('the objectId (lower-cased) is the key a new link is recorded under; sub stays a fallback', () => {
        expect(S.stableUids({ oid: 'AB-CD', sub: 'pairwise' })).toEqual(['ab-cd', 'pairwise']);
        expect(S.primaryUid({ sub: 'only-sub' })).toBe('only-sub');
    });
    test('guests are recognised', () => {
        expect(S.isGuest({ upn: 'x_y#EXT#@t.onmicrosoft.com' })).toBe(true);
        expect(S.isGuest({ upn: 'a@corp.com' })).toBe(false);
    });
    test('e-mail alone can never claim a mapping (no query issued)', async () => {
        expect(
            await S.claimPendingMapping('saml', { email: 'a@x.com', sub: 'a@x.com' })
        ).toBeNull();
        expect(db.all).not.toHaveBeenCalled();
    });
    test('a foreign tenant cannot claim', async () => {
        process.env.SSO_EXPECTED_TENANT_ID = 'good';
        try {
            expect(await S.claimPendingMapping('saml', { oid: 'o', tid: 'evil' })).toBeNull();
            expect(db.all).not.toHaveBeenCalled();
        } finally {
            delete process.env.SSO_EXPECTED_TENANT_ID;
        }
    });
    test('matches on several employees are refused, never guessed', async () => {
        db.all.mockResolvedValue([
            {
                id: 1,
                employeeId: 10,
                matchObjectId: null,
                matchUpn: 'a@corp',
                matchEmployeeId: null,
            },
            { id: 2, employeeId: 11, matchObjectId: null, matchUpn: null, matchEmployeeId: 'E1' },
        ]);
        expect(
            await S.claimPendingMapping('saml', { oid: 'o', upn: 'a@corp', employeeId: 'E1' })
        ).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });
    test('a mapping pinned to an objectId ignores a different objectId (UPN reassigned)', async () => {
        db.all.mockResolvedValue([
            {
                id: 1,
                employeeId: 10,
                matchObjectId: 'o-original',
                matchUpn: 'a@corp',
                matchEmployeeId: null,
            },
        ]);
        expect(await S.claimPendingMapping('saml', { oid: 'o-other', upn: 'a@corp' })).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });
    test('the rightful claim binds once: consumes the mapping, writes the identity under the objectId', async () => {
        db.all.mockResolvedValue([
            {
                id: 1,
                employeeId: 10,
                matchObjectId: 'o1',
                matchUpn: null,
                matchEmployeeId: null,
                createdBy: 3,
            },
        ]);
        db.get.mockImplementation(async (sql) =>
            /FROM employees/.test(sql) ? { id: 10, username: 'jane', email: 'j@x' } : null
        );
        db.run.mockResolvedValue({ changes: 1 });
        const p = await S.claimPendingMapping('saml', { oid: 'O1', sub: 'jane@corp' });
        expect(p).toEqual({ kind: 'employee', id: 10, username: 'jane' });
        const sqls = db.run.mock.calls.map((c) => c[0]);
        expect(sqls[0]).toMatch(
            /UPDATE sso_pending_links SET status = 'bound'[\s\S]*status = 'pending'/
        );
        const ins = db.run.mock.calls.find((c) => /INSERT INTO user_identities/.test(c[0]));
        expect(ins[1]).toEqual(expect.arrayContaining([10, 'saml', 'o1']));
    });
    test('R2-D2: a mapping pinned to an objectId cannot be claimed by a sign-in with NO objectId', async () => {
        db.all.mockResolvedValue([
            {
                id: 1,
                employeeId: 10,
                matchObjectId: 'o-pinned',
                matchUpn: 'a@corp',
                matchEmployeeId: null,
            },
        ]);
        expect(await S.claimPendingMapping('saml', { sub: 'a@corp', upn: 'a@corp' })).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });
    test('R2-D4: the employee id is compared case-insensitively at claim time', async () => {
        db.all.mockResolvedValue([]);
        await S.claimPendingMapping('saml', { employeeId: ' EMP-576 ' });
        expect(db.all.mock.calls[0][1]).toEqual(['saml', null, null, 'emp-576']);
    });
    test('R2-D3: a legacy link under a UPN-like NameID never gets the newcomer objectId aliased onto it', async () => {
        db.get.mockImplementation(async (sql) => {
            if (/FROM user_identities WHERE sso_provider/.test(sql)) return null;
            if (/FROM admins WHERE auth_provider/.test(sql)) return null;
            if (/FROM employees WHERE auth_provider = \? AND external_id = \?/.test(sql))
                return { id: 85, username: 'leaver' };
            return null;
        });
        db.run.mockResolvedValue({ changes: 1 });
        const p = await S.resolveIdentity('saml', { oid: 'NEWCOMER', sub: 'leaver.upn@corp' });
        expect(p && p.id).toBe(85);
        expect(db.run.mock.calls.some((c) => /INSERT INTO user_identities/.test(c[0]))).toBe(false);
    });
    test('R2-S1: a matching employee id is NOT enough when the UPN disagrees (reused staff number)', async () => {
        db.all.mockResolvedValue([
            {
                id: 1,
                employeeId: 85,
                matchObjectId: null,
                matchUpn: 'alice@corp',
                matchEmployeeId: 'e1',
            },
        ]);
        expect(
            await S.claimPendingMapping('saml', {
                oid: 'bob-oid',
                upn: 'bob@corp',
                employeeId: 'E1',
            })
        ).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });
    test('R2-S4: a password-only employee is never bound (same gate as SsoController)', async () => {
        db.all.mockResolvedValue([{ id: 1, employeeId: 10, matchObjectId: 'o1' }]);
        db.get.mockResolvedValue(null); // the lookup excludes local_only
        expect(await S.claimPendingMapping('saml', { oid: 'o1' })).toBeNull();
        expect(db.get.mock.calls[0][0]).toMatch(/auth_policy[\s\S]*<> 'local_only'/);
    });
    test('R2-S4: resolveIdentity with allowClaim:false (API bearer) never consumes a mapping', async () => {
        db.get.mockResolvedValue(null);
        db.all.mockResolvedValue([{ id: 1, employeeId: 10, matchObjectId: 'o1' }]);
        expect(await S.resolveIdentity('entra', { oid: 'o1' }, { allowClaim: false })).toBeNull();
        expect(db.all.mock.calls.some((c) => /sso_pending_links/.test(c[0]))).toBe(false);
    });
    test('R2-S4: an Entra B2B guest is flagged from the acct claim', () => {
        expect(S.isGuest({ upn: 'home@othertenant.com', userType: 'Guest' })).toBe(true);
        expect(read('src/config/sso.js')).toMatch(
            /userType: String\(j\.acct\) === '1' \? 'Guest' : null/
        );
        // 3.23.19: the bearer also asks HOW the identity was linked (S4/S5 trace).
        const { flat } = require('../helpers/flatSource');
        expect(flat(read('src/config/sso.js'))).toMatch(
            /resolveIdentity\('entra', mapped, \{ allowClaim: false, trace \}\)/
        );
    });
    test('a lost race (mapping already consumed) binds nothing', async () => {
        db.all.mockResolvedValue([{ id: 1, employeeId: 10, matchObjectId: 'o1' }]);
        db.get.mockImplementation(async (sql) =>
            /FROM employees/.test(sql) ? { id: 10, username: 'jane' } : null
        );
        db.run.mockResolvedValue({ changes: 0 });
        expect(await S.claimPendingMapping('saml', { oid: 'o1' })).toBeNull();
        expect(db.run.mock.calls.some((c) => /INSERT INTO user_identities/.test(c[0]))).toBe(false);
    });
});

describe('enforceSsoOnly — never locks out an admin or a password-only employee', () => {
    beforeEach(() => AppSettingsModel.getValue.mockResolvedValue(true));
    test.each([
        [{ kind: 'admin', id: 1, role: 'localadmin' }],
        [{ kind: 'admin', id: 1, role: 'superadmin' }],
    ])('admin %p: password untouched', async (principal) => {
        await S.enforceSsoOnly(principal);
        expect(db.run).not.toHaveBeenCalled();
    });
    test('local_only employee: password untouched', async () => {
        db.get.mockResolvedValue({ authPolicy: 'local_only' });
        await S.enforceSsoOnly({ kind: 'employee', id: 5 });
        expect(db.run).not.toHaveBeenCalled();
    });
    test('ordinary employee with the policy on: password disabled', async () => {
        db.get.mockResolvedValue({ authPolicy: 'any' });
        db.run.mockResolvedValue({ changes: 1 });
        await S.enforceSsoOnly({ kind: 'employee', id: 5 });
        expect(db.run.mock.calls[0][0]).toMatch(/UPDATE employees SET password_disabled = true/);
    });
});

// ---------------------------------------------------------------------------
describe('SAML claim mapping', () => {
    const sso = require('../../src/config/sso');
    test('the Entra objectidentifier / tenantid / custom employeeid claims are read', () => {
        const pf = {
            'http://schemas.microsoft.com/identity/claims/objectidentifier': 'OID',
            'http://schemas.microsoft.com/identity/claims/tenantid': 'TID',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'a@corp',
            'http://schemas.acme.example/claims/employeeid': ['E1'],
        };
        expect(sso.samlClaim(pf, sso.SAML_CLAIMS.oid)).toBe('OID');
        expect(sso.samlClaim(pf, sso.SAML_CLAIMS.tid)).toBe('TID');
        expect(sso.samlClaim(pf, sso.SAML_CLAIMS.upn)).toBe('a@corp');
        expect(sso.samlClaim(pf, sso.SAML_CLAIMS.employeeId)).toBe('E1');
    });
    test('the random SAML Response ID is no longer a fallback identity', () => {
        expect(read('src/config/sso.js')).not.toMatch(/pf\.nameID \|\| pf\.ID/);
    });
});

describe('wiring (source guards)', () => {
    test('every /admin/sso-migration route is SuperAdmin-only', () => {
        // Each registration, single- or multi-line: path, then the guard next.
        const regs = [
            ...read('src/routes/index.js').matchAll(
                /router\.(get|post)\(\s*'(\/admin\/sso-migration[^']*)',\s*(\w+)/g
            ),
        ];
        expect(regs.length).toBeGreaterThanOrEqual(8);
        regs.forEach((m) => expect(m[3]).toBe('requireSuperAdmin'));
    });
    test('R2-S2: the 10 MB dry-run body is parsed only AFTER requireSuperAdmin', () => {
        const server = read('server.js');
        expect(server).not.toMatch(/app\.use\('\/admin\/sso-migration\/preview', express\.json/);
        expect(server).toMatch(
            /req\.path === '\/admin\/sso-migration\/preview' \? next\(\) : _jsonParser/
        );
        expect(read('src/routes/index.js')).toMatch(
            /'\/admin\/sso-migration\/preview',\s*requireSuperAdmin,\s*require\('express'\)\.json\(\{ limit: '10mb' \}\)/
        );
    });
    test('R2-S3: only providers whose sign-in presents a claim key can be targeted', () => {
        expect(R.PROVIDERS).toEqual(['saml', 'entra']);
    });
    test('admins are refused on the interactive SSO path unless admin SSO is on (3.23.19)', () => {
        // Behaviour is proven in c319-admin-sso.test.js; this pins the gate's place.
        const { flat } = require('../helpers/flatSource');
        const src = flat(read('src/controllers/SsoController.js'));
        expect(src).toMatch(/user\.userType === 'admin'/);
        expect(src).toMatch(/if \(!\(await AdminSso\.isAdminSsoEnabled\(\)\)\) \{/);
    });
    test('every outcome has a label and a reason in both languages', () => {
        for (const lng of ['fr', 'en']) {
            const j = JSON.parse(read(`locales/${lng}/admin.json`));
            R.OUTCOMES.forEach((o) => {
                expect(j['ssom_o_' + o]).toBeTruthy();
                expect(j['ssom_r_' + o]).toBeTruthy();
            });
        }
    });
    test('erasure reaches the SSO-migration mappings and history', () => {
        const dsr = read('src/services/DSRService.js');
        expect(dsr).toMatch(/DELETE FROM sso_pending_links WHERE employee_id = \?/);
        expect(dsr).toMatch(
            /UPDATE sso_remap_rows SET input = '\{\}'::jsonb\s+WHERE employee_id = \?/
        );
        // …and the unattached lines still carrying the person's address or number.
        expect(dsr).toMatch(
            /employee_id IS NULL AND[\s\S]*input->>'mail'[\s\S]*input->>'employeeId'/
        );
        expect(dsr).toMatch(/const origEmail =/);
    });
});
