'use strict';

/**
 * SECTION operations — employee & account surfaces.
 *
 * D1  /account did not exist (404) while /account/sessions, /account/notifications
 *     and /change-password did — so an employee could never provide the email the
 *     self-service password reset depends on. Measured before the fix, on the real
 *     app as `test.employee`:
 *         GET /account                 404
 *         PasswordResetService         {"sent":false,"reason":"no_email"}
 *     and after:
 *         GET /account                 200 (fr, editable inputs = email, phone)
 *         PasswordResetService         sent=true
 *     Posting 20 forged fields (roleId, siteId, departmentId, serviceId,
 *     supervisorId, managerId, employeeNumber, username, isActive, passwordHash,
 *     id, firstName, isOrgRoot, …) changed exactly two columns: email and phone.
 *
 * D2  The policy ANNOUNCED 8 characters and ENFORCED 12, and refused in English on
 *     a French page: « Mot de passe : Password must be at least 12 characters long ».
 *
 * D3  "Invalid credentials" and "Current password is incorrect" rendered in English
 *     because `info?.message ||` / `result.message` overrode the existing FR keys.
 *
 * D4  A note typed on an APPROVED row was discarded while the page said
 *     « Brouillon enregistré avec succès. » — the row is excluded from collect(),
 *     so the text never left the browser.
 *
 * D5/D6 are LAYOUT defects; their proof is a getBoundingClientRect() measurement in
 *     the real browser (19px → 36px; left:-49px → left:+32px at 375px). jsdom has no
 *     layout engine, so the guards below pin the CSS VALUES that produce those
 *     measurements rather than re-measuring.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '../..');
const frFlash = JSON.parse(fs.readFileSync(path.join(APP, 'locales/fr/flash.json'), 'utf8'));
const enFlash = JSON.parse(fs.readFileSync(path.join(APP, 'locales/en/flash.json'), 'utf8'));
const frChrome = JSON.parse(fs.readFileSync(path.join(APP, 'locales/fr/chrome.json'), 'utf8'));
const enChrome = JSON.parse(fs.readFileSync(path.join(APP, 'locales/en/chrome.json'), 'utf8'));
const frEmployee = JSON.parse(fs.readFileSync(path.join(APP, 'locales/fr/employee.json'), 'utf8'));
const enEmployee = JSON.parse(fs.readFileSync(path.join(APP, 'locales/en/employee.json'), 'utf8'));

const DICT = { fr: { flash: frFlash, chrome: frChrome }, en: { flash: enFlash, chrome: enChrome } };
/** A `req.t` backed by the REAL locale files, so a missing key shows up as a failure. */
const translator = (lng) => (key, opts) => {
    const [ns, k] = String(key).split(':');
    const hit = DICT[lng] && DICT[lng][ns] && DICT[lng][ns][k];
    if (hit) return hit;
    return (opts && opts.defaultValue) !== undefined ? opts.defaultValue : key;
};

// 3.23.17 (S-08): changing one's OWN e-mail re-checks the current password.
const PW = 'Correct-Horse-1!';
const PW_HASH = require('bcrypt').hashSync(PW, 4);

// ---- mocks: the controller must not reach a database in a unit test ---------
const mockEmp = {
    findById: jest.fn(),
    findByEmail: jest.fn(async () => null),
    findByIdWithOrganization: jest.fn(),
    update: jest.fn(async () => ({})),
};
const mockAdminModel = {
    findByEmail: jest.fn(async () => null),
    // Lot C (L1-18): an admin now edits their OWN e-mail here, so the controller
    // reads and writes the admin row on that branch.
    findById: jest.fn(async () => ({
        id: 1,
        username: 'admin',
        email: 'old@example.test',
        passwordHash: PW_HASH,
    })),
    update: jest.fn(async () => ({ changes: 1 })),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
jest.mock('../../src/models/AdminModel', () => mockAdminModel);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
// A shared address is allowed since migration 107: the controller asks this
// service for an ADVISORY and never refuses on it.
const mockEmailAccounts = { advisory: jest.fn(async () => null) };
jest.mock('../../src/services/EmailAccountsService', () => mockEmailAccounts);

const AuthController = require('../../src/controllers/AuthController');
const passwordValidator = require('../../src/utils/passwordValidator');

function fakeReq(overrides = {}) {
    const flashes = [];
    return Object.assign(
        {
            body: {},
            ip: '127.0.0.1',
            get: () => 'jest',
            t: translator('fr'),
            user: { id: 84, userType: 'employee', username: 'test.employee' },
            flash: (type, msg) => flashes.push([type, msg]),
            _flashes: flashes,
        },
        overrides
    );
}
function fakeRes() {
    return {
        redirected: null,
        redirect(u) {
            this.redirected = u;
        },
        rendered: null,
        render(v, o) {
            this.rendered = { view: v, opts: o };
        },
    };
}

beforeEach(() => {
    Object.values(mockEmp).forEach((f) => f.mockReset && f.mockReset());
    mockAdminModel.findByEmail.mockReset();
    mockEmp.update.mockResolvedValue({});
    mockEmp.findByEmail.mockResolvedValue(null);
    mockAdminModel.findByEmail.mockResolvedValue(null);
    mockEmailAccounts.advisory.mockReset().mockResolvedValue(null);
    mockEmp.findById.mockResolvedValue({ id: 84, email: '', phone: null, passwordHash: PW_HASH });
});

// =============================================================================
// D1 — the profile page exists, and edits ONLY the two contact fields
// =============================================================================
describe('D1 — /account writes contact details and nothing else', () => {
    const FORGED = {
        email: 'Someone@Example.Test',
        phone: ' +225 01 02 03 04 ',
        roleId: '999',
        role_id: '999',
        siteId: '999',
        site_id: '999',
        departmentId: '999',
        serviceId: '999',
        supervisorId: '999',
        managerId: '999',
        employeeNumber: 'UAT-HACK',
        username: 'uat.hacked',
        isActive: 'false',
        isAccountActive: 'false',
        passwordHash: 'UAT-HACK',
        id: '85',
        firstName: 'UAT-HACK',
        isOrgRoot: 'true',
    };

    test('an employee may set their own email and phone', async () => {
        const req = fakeReq({
            body: { email: 'me@example.test', phone: '+225 01', currentPassword: PW },
        });
        const res = fakeRes();
        await AuthController.updateProfile(req, res);
        expect(mockEmp.update).toHaveBeenCalledTimes(1);
        expect(mockEmp.update.mock.calls[0][0]).toBe(84);
        expect(mockEmp.update.mock.calls[0][1]).toEqual({
            email: 'me@example.test',
            phone: '+225 01',
        });
        expect(res.redirected).toBe('/account');
    });

    test(
        'NEGATIVE: role, site, department, service, supervisor, identity and account ' +
            'flags posted alongside are never written',
        async () => {
            const req = fakeReq({ body: { ...FORGED, currentPassword: PW } });
            await AuthController.updateProfile(req, fakeRes());
            expect(mockEmp.update).toHaveBeenCalledTimes(1);
            const written = mockEmp.update.mock.calls[0][1];
            // Exactly two keys — no more, whatever the caller sent.
            expect(Object.keys(written).sort()).toEqual(['email', 'phone']);
            for (const forbidden of Object.keys(FORGED)) {
                if (forbidden === 'email' || forbidden === 'phone') continue;
                expect(written).not.toHaveProperty(forbidden);
            }
            // …and it never targets another employee's row.
            expect(mockEmp.update.mock.calls[0][0]).toBe(84);
        }
    );

    test('an email already held by another account is ACCEPTED with an advisory (a person may hold several accounts)', async () => {
        mockEmailAccounts.advisory.mockResolvedValueOnce('[shared with 2 other accounts]');
        const req = fakeReq({ body: { email: 'taken@example.test', currentPassword: PW } });
        const res = fakeRes();
        await AuthController.updateProfile(req, res);
        expect(mockEmailAccounts.advisory).toHaveBeenCalledWith(req, 'taken@example.test', {
            excludeEmployeeId: 84,
        });
        expect(mockEmp.update).toHaveBeenCalledWith(84, {
            email: 'taken@example.test',
            phone: null,
        });
        // advisory first (a 'warning', never an 'error'), then the success line
        expect(req._flashes[0]).toEqual(['warning', '[shared with 2 other accounts]']);
        expect(req._flashes[1][0]).toBe('success');
        expect(res.redirected).toBe('/account');
    });

    test('an unchanged address is not even checked, and an unused one raises no advisory', async () => {
        mockEmp.findById.mockResolvedValue({
            id: 84,
            email: 'me@example.test',
            phone: null,
            passwordHash: PW_HASH,
        });
        let req = fakeReq({ body: { email: 'me@example.test' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmailAccounts.advisory).not.toHaveBeenCalled();
        expect(req._flashes.map((f) => f[0])).toEqual(['success']);
        req = fakeReq({ body: { email: 'new@example.test', currentPassword: PW } });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmailAccounts.advisory).toHaveBeenCalledTimes(1);
        expect(req._flashes.map((f) => f[0])).toEqual(['success']);
    });

    test('a malformed address is refused', async () => {
        const req = fakeReq({ body: { email: 'not-an-address' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmp.update).not.toHaveBeenCalled();
        expect(req._flashes[0][1]).toBe(frFlash.profile_email_invalid);
    });

    // Superseded by Lot C (L1-16/18): an administrator's own e-mail is the address
    // the self-service password reset needs, so /account now WRITES it — on the
    // admin row, and on nothing else. The old refusal is gone on purpose.
    test('an ADMIN saves their own e-mail — and only their e-mail', async () => {
        const req = fakeReq({
            user: { id: 1, userType: 'admin', username: 'admin' },
            body: {
                email: 'x@y.test',
                phone: '0102030405',
                role: 'superadmin',
                currentPassword: PW,
            },
        });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmp.update).not.toHaveBeenCalled();
        expect(mockAdminModel.update).toHaveBeenCalledWith(1, { email: 'x@y.test' });
        expect(req._flashes[0][0]).toBe('success');
        expect(req._flashes[0][1]).toBe(frFlash.profile_saved);
    });

    test("an ADMIN's malformed address is refused the same way", async () => {
        const req = fakeReq({
            user: { id: 1, userType: 'admin' },
            body: { email: 'not-an-address' },
        });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockAdminModel.update).not.toHaveBeenCalled();
        expect(req._flashes[0][1]).toBe(frFlash.profile_email_invalid);
    });

    test('S-08: an e-mail change WITHOUT or with a WRONG current password is refused, nothing written', async () => {
        for (const currentPassword of [undefined, '', 'wrong-password']) {
            mockEmp.update.mockClear();
            const req = fakeReq({ body: { email: 'thief@example.test', currentPassword } });
            const res = fakeRes();
            await AuthController.updateProfile(req, res);
            expect(mockEmp.update).not.toHaveBeenCalled();
            expect(req._flashes[0][0]).toBe('error');
            expect(res.redirected).toBe('/account');
        }
    });

    test('S-08: a phone-only change needs no password; an SSO-only account cannot change its e-mail here', async () => {
        mockEmp.findById.mockResolvedValue({
            id: 84,
            email: 'me@example.test',
            phone: null,
            passwordHash: PW_HASH,
        });
        let req = fakeReq({ body: { email: 'me@example.test', phone: '0707' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmp.update).toHaveBeenCalledWith(84, {
            email: 'me@example.test',
            phone: '0707',
        });
        mockEmp.update.mockClear();
        mockEmp.findById.mockResolvedValue({
            id: 84,
            email: 'me@example.test',
            phone: null,
            passwordHash: null,
        });
        req = fakeReq({ body: { email: 'other@example.test', currentPassword: PW } });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockEmp.update).not.toHaveBeenCalled();
        expect(req._flashes[0][0]).toBe('error');
    });

    test('S-08: an ADMIN with a wrong current password keeps their address', async () => {
        const req = fakeReq({
            user: { id: 1, userType: 'admin', username: 'admin' },
            body: { email: 'x@y.test', currentPassword: 'nope' },
        });
        await AuthController.updateProfile(req, fakeRes());
        expect(mockAdminModel.update).not.toHaveBeenCalled();
        expect(req._flashes[0][0]).toBe('error');
    });

    test('the page renders the account-family profile view', async () => {
        mockEmp.findByIdWithOrganization.mockResolvedValue({ id: 84, email: '', roleName: 'X' });
        const res = fakeRes();
        await AuthController.showProfile(fakeReq(), res);
        expect(res.rendered.view).toBe('pages/account/profile');
        expect(res.rendered.opts.title).toBe(frChrome.profile_title);
    });
});

describe('D1 — the route is mounted, and behind the authentication gate', () => {
    const ROUTES = fs.readFileSync(path.join(APP, 'src/routes/index.js'), 'utf8');
    // Locate by REGEX, not by an exact one-line literal: prettier breaks
    // `router.post('/account', …)` onto several lines as soon as the guard list
    // overflows, and `indexOf("router.post('/account',")` then returns -1 — the
    // route reads as "not mounted" when it is mounted and correctly gated.
    const GATE = ROUTES.search(/router\.use\(\s*requireAuth\s*\)/);
    const mountOf = (verb) => ROUTES.search(new RegExp(`router\\.${verb}\\(\\s*'/account'`));

    test.each([['get'], ['post']])("router.%s('/account') is mounted", (verb) => {
        expect(mountOf(verb)).toBeGreaterThan(-1);
    });

    test('both are mounted AFTER the blanket auth gate (a profile page is never public)', () => {
        expect(GATE).toBeGreaterThan(-1);
        expect(mountOf('get')).toBeGreaterThan(GATE);
        expect(mountOf('post')).toBeGreaterThan(GATE);
    });

    test('the profile view offers no input for anything but the contact fields', () => {
        const view = fs.readFileSync(path.join(APP, 'views/pages/account/profile.ejs'), 'utf8');
        // Two mutually exclusive forms since Lot C (admin branch / employee
        // branch), so the NAMES are deduped — the rule pinned here is that no
        // other field is ever offered, not how many forms carry them.
        const names = [...view.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map(
            (m) => m[1]
        );
        expect([...new Set(names)].sort()).toEqual(['_csrf', 'currentPassword', 'email', 'phone']);
    });
});

// =============================================================================
// D2 — what the page ANNOUNCES is what the validator ENFORCES, in both languages
// =============================================================================
describe('D2 — the announced password policy is the enforced password policy', () => {
    const announced = (s) => {
        const m = String(s).match(/(\d+)\s*(?:characters|caractères)/i);
        return m ? Number(m[1]) : null;
    };

    test.each([
        ['fr/chrome', frChrome.password_requirements],
        ['en/chrome', enChrome.password_requirements],
        [
            'fr/admin',
            JSON.parse(fs.readFileSync(path.join(APP, 'locales/fr/admin.json'), 'utf8'))
                .password_requirements,
        ],
        [
            'en/admin',
            JSON.parse(fs.readFileSync(path.join(APP, 'locales/en/admin.json'), 'utf8'))
                .password_requirements,
        ],
    ])(
        '%s: a password of exactly the announced length, meeting every announced rule, is ACCEPTED',
        (_label, sentence) => {
            const n = announced(sentence);
            expect(n).toBeGreaterThan(0);
            // Build a password of exactly `n` chars carrying upper+lower+digit+symbol
            // and no sequence/repeat/common word.
            const base = 'Xk#7vQ$2mZ&4pR!9tW%5nB*3';
            const pw = base.slice(0, n);
            expect(pw).toHaveLength(n);
            const r = passwordValidator.validate(pw);
            expect(r.errors).toEqual([]);
            expect(r.valid).toBe(true);
        }
    );

    test('one character SHORTER than announced is refused — the number is the real boundary', () => {
        const n = announced(frChrome.password_requirements);
        const pw = 'Xk#7vQ$2mZ&4pR!9tW%5nB*3'.slice(0, n - 1);
        expect(passwordValidator.validate(pw).valid).toBe(false);
    });
});

// =============================================================================
// D2/D3 — nothing the auth surfaces say to a French user is English
// =============================================================================
describe('D2/D3 — password and credential messages are localized', () => {
    const ENGLISH =
        /\b(Password must|characters long|Current password is incorrect|Invalid credentials|must contain|too common)\b/i;

    test('a rejected password on /change-password speaks French, not validator prose', async () => {
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        const spy = jest.spyOn(EmployeeAuthService, 'changePassword');
        const req = fakeReq({
            body: { currentPassword: 'x', newPassword: 'Zk7#pQw!', confirmPassword: 'Zk7#pQw!' },
        });
        await AuthController.changePassword(req, fakeRes());
        const [, msg] = req._flashes[0];
        expect(msg).toBe(frFlash.pw_rule_min_length);
        expect(msg).not.toMatch(ENGLISH);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('"Current password is incorrect" from the service is translated', async () => {
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        const spy = jest
            .spyOn(EmployeeAuthService, 'changePassword')
            .mockResolvedValue({ success: false, message: 'Current password is incorrect' });
        const req = fakeReq({
            body: {
                currentPassword: 'wrong',
                newPassword: 'Zk7#pQw!mNvR',
                confirmPassword: 'Zk7#pQw!mNvR',
            },
        });
        await AuthController.changePassword(req, fakeRes());
        const [, msg] = req._flashes[0];
        expect(msg).toBe(frFlash.pw_current_incorrect);
        expect(msg).not.toMatch(ENGLISH);
        spy.mockRestore();
    });

    test('an UNKNOWN service message never leaks English either', async () => {
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        const spy = jest
            .spyOn(EmployeeAuthService, 'changePassword')
            .mockResolvedValue({ success: false, message: 'Some brand new English sentence' });
        const req = fakeReq({
            body: {
                currentPassword: 'x',
                newPassword: 'Zk7#pQw!mNvR',
                confirmPassword: 'Zk7#pQw!mNvR',
            },
        });
        await AuthController.changePassword(req, fakeRes());
        expect(req._flashes[0][1]).toBe(frFlash.pw_change_error);
        spy.mockRestore();
    });

    test('the same messages exist in English too (matching keys in both locales)', () => {
        for (const k of Object.keys(frFlash).filter((k2) =>
            /^pw_rule_|^pw_current_incorrect$|^profile_/.test(k2)
        )) {
            expect(Object.keys(enFlash)).toContain(k);
            expect(String(enFlash[k]).length).toBeGreaterThan(0);
        }
        for (const k of Object.keys(frChrome).filter((k2) => /^profile_/.test(k2))) {
            expect(Object.keys(enChrome)).toContain(k);
        }
        for (const k of Object.keys(frEmployee).filter((k2) =>
            /^sa_notes_locked|^sa_toast_partial_skipped$/.test(k2)
        )) {
            expect(Object.keys(enEmployee)).toContain(k);
        }
    });

    test('the login handler no longer prefers the strategy message over the FR key', () => {
        const SRC = fs.readFileSync(path.join(APP, 'src/controllers/AuthController.js'), 'utf8');
        // The strategy returns one constant English sentence; preferring it made a
        // French login page answer in English.
        expect(SRC).not.toMatch(/req\.flash\('error',\s*info\?\.message\s*\|\|/);
    });
});

// =============================================================================
// D4 — a refused write is never reported as a success
// =============================================================================
describe('D4 — declined rows are reported, not swallowed', () => {
    const VIEW = fs.readFileSync(
        path.join(APP, 'views/pages/employee/self-assessment.ejs'),
        'utf8'
    );

    test('the note on a locked row is READ-ONLY in the markup', () => {
        // The whole <td> that carries the notes textarea.
        const td = VIEW.slice(
            VIEW.indexOf(
                'th_notes\') %>">',
                VIEW.indexOf('<td data-label="<%= __(\'employee:th_notes')
            )
        );
        const cell = td.slice(0, td.indexOf('</td>'));
        expect(cell).toMatch(/<%=\s*saLocked\s*\?\s*'readonly'\s*:\s*''\s*%>/);
    });

    test('the client branches on `skipped` instead of always claiming success', () => {
        const post = VIEW.slice(
            VIEW.indexOf('async function post('),
            VIEW.indexOf('// ---- AUTOSAVE')
        );
        expect(post).toMatch(/result\.skipped/);
        // The success toast must be reachable ONLY when nothing was skipped.
        expect(post).toMatch(/skipped\.length[\s\S]{0,200}toast\(okMsg, 'success'\)/);
    });

    test('the server still reports which rows it declined', async () => {
        const svc = require('../../src/services/SelfAssessmentService');
        const spy = jest
            .spyOn(svc, 'createOrUpdateSelfAssessment')
            .mockImplementation(async (_e, skillId) =>
                skillId === 317 ? { id: 1, skipped: true, state: 'approved' } : { id: 2 }
            );
        const EmployeePortalController = require('../../src/controllers/EmployeePortalController');
        const req = {
            user: { id: 84 },
            body: {
                assessments: [
                    { skillId: 317, selfRatedLevel: 3, notes: 'refused' },
                    { skillId: 318, selfRatedLevel: 2, notes: 'kept' },
                ],
            },
        };
        let payload = null;
        const res = {
            status() {
                return this;
            },
            json(o) {
                payload = o;
            },
        };
        await EmployeePortalController.saveDraftSelfAssessment(req, res);
        expect(payload.success).toBe(true);
        // Without this list the page cannot tell the truth about a partial save.
        expect(payload.skipped).toEqual([{ skillId: 317, reason: 'approved' }]);
        spy.mockRestore();
    });
});

// =============================================================================
// D5 / D6 — the CSS values behind the browser measurements
// =============================================================================
describe('D5/D6 — rating target size and the mobile action bar', () => {
    const VIEW = fs.readFileSync(
        path.join(APP, 'views/pages/employee/self-assessment.ejs'),
        'utf8'
    );

    test('D5: the rating dropdown clears the WCAG 2.2 SC 2.5.8 minimum of 24px', () => {
        const rule = VIEW.match(/\.self-rating-select\s*\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        const mh = rule[1].match(/min-height:\s*(\d+(?:\.\d+)?)px/);
        expect(mh).not.toBeNull();
        expect(Number(mh[1])).toBeGreaterThanOrEqual(24);
    });

    test('D6: the mobile action bar wraps, so it cannot overflow to the LEFT', () => {
        // Everything from the phone media query to the rule that follows it: the
        // `.sa-bar-actions` override inside is the one that governs 375px.
        const mq = VIEW.slice(VIEW.indexOf('@media (max-width:780px)'));
        const block = mq.slice(0, mq.indexOf('.sa-locked{'));
        const actions = block.match(/\.sa-bar-actions\s*\{([^}]*)\}/);
        expect(actions).not.toBeNull();
        expect(actions[1]).toMatch(/flex-wrap:\s*wrap/);
        // `justify-content:flex-end` on a NON-wrapping full-width row is exactly what
        // pushed the button to left:-49px at 375px.
        expect(actions[1]).not.toMatch(/justify-content:\s*flex-end/);
    });
});
