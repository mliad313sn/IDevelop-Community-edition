'use strict';
/**
 * Password policy — NIST SP 800-63B / OWASP ASVS 4.0.3 V2.1.
 *
 * The previous version of this suite asserted that a password without an
 * upper-case letter, a lower-case letter, a digit or a symbol was refused.
 * ASVS 2.1.9 says the opposite ("no requirement for upper or lower case or
 * numbers or special characters"), so those cases now assert acceptance by
 * default, and refusal only when an organisation opts back in with
 * PASSWORD_REQUIRE_CHAR_CLASSES=1.
 */
const fs = require('fs');
const path = require('path');
const passwordValidator = require('../../src/utils/passwordValidator');

afterEach(() => {
    delete process.env.PASSWORD_REQUIRE_CHAR_CLASSES;
});

describe('passwordValidator.validate', () => {
    test('accepts a strong password', () => {
        const r = passwordValidator.validate('StrongP@ss9x');
        expect(r.valid).toBe(true);
        expect(r.errors).toHaveLength(0);
    });

    test.each([
        ['empty', '', 'Password is required'],
        ['too short (2.1.1: 12 minimum)', 'Ab1!', 'at least 12'],
        ['11 characters', 'violet-tram', 'at least 12'],
        ['longer than 128', 'x7K#'.repeat(33), 'not exceed 128'],
    ])('rejects %s', (_label, pw, fragment) => {
        const r = passwordValidator.validate(pw);
        expect(r.valid).toBe(false);
        expect(r.errors.join(' ').toLowerCase()).toContain(fragment.toLowerCase());
    });
});

describe('ASVS 2.1.2-2.1.4: length and characters', () => {
    test('64 characters and more are allowed (up to 128)', () => {
        const pw = 'mauve ferry lantern orbit quiet ribbon saddle tunnel velvet wicker';
        expect(pw.length).toBeGreaterThanOrEqual(64);
        expect(passwordValidator.validate(pw).valid).toBe(true);
        expect(passwordValidator.validate('k'.repeat(0) + pw + ' zinc brook').valid).toBe(true);
    });

    test('spaces and any Unicode character are allowed', () => {
        expect(passwordValidator.validate('crème brûlée à Brest').valid).toBe(true);
        expect(passwordValidator.validate('日本語のパスフレーズです安全').valid).toBe(true);
        expect(passwordValidator.validate('violet  tram  umbrella').valid).toBe(true);
    });

    test('length counts characters, not UTF-16 units', () => {
        // 11 emoji = 22 UTF-16 units but 11 characters.
        expect(passwordValidator.validate('🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒').valid).toBe(false);
    });
});

describe('ASVS 2.1.9: no composition rules by default', () => {
    test.each([
        ['no uppercase', 'alllower9!xz'],
        ['no lowercase', 'ALLUPPER9!XZ'],
        ['no number', 'NoNumber@xyzw'],
        ['no special', 'NoSpecial9xyz'],
        ['letters only (a passphrase)', 'violet tram umbrella'],
    ])('accepts a password with %s', (_label, pw) => {
        expect(passwordValidator.validate(pw).errors).toEqual([]);
    });

    test.each([
        ['no uppercase', 'alllower9!xz', 'uppercase'],
        ['no lowercase', 'ALLUPPER9!XZ', 'lowercase'],
        ['no number', 'NoNumber@xyzw', 'number'],
        ['no special', 'NoSpecial9xyz', 'special'],
    ])(
        'PASSWORD_REQUIRE_CHAR_CLASSES=1 restores the rule: %s is refused',
        (_label, pw, fragment) => {
            process.env.PASSWORD_REQUIRE_CHAR_CLASSES = '1';
            const r = passwordValidator.validate(pw);
            expect(r.valid).toBe(false);
            expect(r.errors.join(' ').toLowerCase()).toContain(fragment);
        }
    );

    test('the admin form validator follows the same switch', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/utils/validators.js'), 'utf8');
        const block = src.slice(
            src.indexOf('const adminValidation'),
            src.indexOf("body('passwordConfirm')")
        );
        expect((block.match(/\.if\(requireCharClasses\)/g) || []).length).toBe(4);
    });
});

describe('ASVS 2.1.7: common and breached passwords', () => {
    test.each([
        'Sunshine2024!',
        'P@ssw0rd123456',
        'Password1234!',
        'Marseille13!!',
        'Summer2025!!',
        'Welcome123456',
        'soleilsoleil',
        'Azerty123456!',
        'Jetaime123456',
        'Idevelop2026!',
        'Motdepasse!2026',
        'iloveyou4ever!',
        '1qaz2wsx3edc',
        '123456789012',
    ])('refuses %s', (pw) => {
        const r = passwordValidator.validate(pw);
        expect(r.valid).toBe(false);
        expect(r.score).toBeLessThanOrEqual(54);
    });

    test('the list is bundled, offline, and says where it comes from', () => {
        const file = path.join(__dirname, '../../src/data/common-passwords.txt');
        const txt = fs.readFileSync(file, 'utf8');
        expect(txt).toMatch(/Provenance: generated for IDevelop Community Edition/);
        const entries = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
        expect(entries.length).toBeGreaterThan(400);
        for (const e of entries) expect(e).toBe(e.toLowerCase().trim());
        const notice = fs.readFileSync(path.join(__dirname, '../../NOTICE'), 'utf8');
        expect(notice).toMatch(/src\/data\/common-passwords\.txt/);
    });

    test('a passphrase or a random password is not mistaken for a common one', () => {
        for (const pw of [
            'correct horse battery staple',
            'Xk#7vQ$2mZ&4',
            'Tr0ub4dor&3xyz',
            'orbit-velvet-saddle',
        ])
            expect([pw, passwordValidator.isCommonPassword(pw)]).toEqual([pw, false]);
    });
});

describe('strength (ASVS 2.1.8)', () => {
    test('longer is stronger, and a common password is always weak', () => {
        const s = (p) => passwordValidator.calculateStrength(p);
        expect(s('violet tram umbrella')).toBeGreaterThan(s('violettram12'));
        expect(passwordValidator.getStrengthLabel(s('correct horse battery staple'))).toBe(
            'Strong'
        );
        expect(passwordValidator.getStrengthLabel(s('Sunshine2024!'))).toBe('Weak');
    });

    test('the change and reset pages show a live meter with FR and EN labels', () => {
        const views = path.join(__dirname, '../../views/pages/auth');
        for (const v of ['change-password.ejs', 'reset-password.ejs']) {
            const src = fs.readFileSync(path.join(views, v), 'utf8');
            expect(src).toMatch(/data-pw-strength="pwStrengthNew"/);
            expect(src).toMatch(/\/js\/password-strength\.js/);
            expect(src).toMatch(/autocomplete="new-password"/);
        }
        expect(fs.existsSync(path.join(__dirname, '../../public/js/password-strength.js'))).toBe(
            true
        );
        for (const lang of ['fr', 'en']) {
            const auth = JSON.parse(
                fs.readFileSync(path.join(__dirname, `../../locales/${lang}/auth.json`), 'utf8')
            );
            for (const k of ['weak', 'fair', 'good', 'strong', 'hint', 'label', 'empty'])
                expect(auth[`pw_strength_${k}`]).toBeTruthy();
        }
    });
});

describe('ASVS V8 / 2.1.11: password fields help password managers', () => {
    test('sign-in and sign-up fields carry the right autocomplete, and nothing blocks paste', () => {
        const root = path.join(__dirname, '../../views/pages');
        const login = fs.readFileSync(path.join(root, 'auth/login.ejs'), 'utf8');
        expect(login).toMatch(/id="username"[^>]*autocomplete="username"/);
        expect(login).toMatch(/id="password"[^>]*autocomplete="current-password"/);
        const signup = fs.readFileSync(path.join(root, 'onboarding/signup.ejs'), 'utf8');
        expect(signup).toMatch(/id="password"[^>]*autocomplete="new-password"/);
        expect(signup).toMatch(/id="confirmPassword"[^>]*autocomplete="new-password"/);
        const walk = (d) =>
            fs
                .readdirSync(d, { withFileTypes: true })
                .flatMap((e) =>
                    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
                );
        for (const f of walk(path.join(__dirname, '../../views')).filter((x) =>
            x.endsWith('.ejs')
        )) {
            const src = fs.readFileSync(f, 'utf8');
            expect([f, /onpaste\s*=/i.test(src)]).toEqual([f, false]);
            // Every password input declares autocomplete (EJS tags inside the
            // element rule out a plain [^>]* match, hence the window).
            let i = src.indexOf('type="password"');
            while (i >= 0) {
                const end = /[^%]>/.exec(src.slice(i));
                const tag = src.slice(i, i + (end ? end.index + 2 : 600));
                expect([f, i, /autocomplete=/.test(tag)]).toEqual([f, i, true]);
                i = src.indexOf('type="password"', i + 1);
            }
        }
    });
});
