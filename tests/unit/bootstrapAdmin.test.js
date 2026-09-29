'use strict';

/**
 * The first-run superadmin credential must never be a constant.
 *
 * Before this, BOTH seed paths (PostgresDatabase.seed and
 * AuthService.createDefaultSuperAdmin) hardcoded 'admin123', so every
 * deployment of this product shipped the SAME guessable superadmin login.
 * force_password_change stops that value PERSISTING, but it cannot stop an
 * attacker being the one who performs the change — whoever reaches the login
 * page first, before the operator's first sign-in, takes the account.
 *
 * The installer overwrote it on fresh installs, but a manual deploy did not,
 * and neither did the window before that installer step ran.
 */

const { seedAdminPassword } = require('../../src/utils/bootstrapAdmin');

describe('bootstrap superadmin password', () => {
    let saved;
    beforeEach(() => {
        saved = process.env.BOOTSTRAP_ADMIN_PASSWORD;
        delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
        else process.env.BOOTSTRAP_ADMIN_PASSWORD = saved;
    });

    test('is never the old hardcoded constant', () => {
        for (let i = 0; i < 25; i++) {
            expect(seedAdminPassword().password).not.toBe('admin123');
        }
    });

    test('differs on every call, so two installs never share a credential', () => {
        const seen = new Set();
        for (let i = 0; i < 50; i++) seen.add(seedAdminPassword().password);
        expect(seen.size).toBe(50);
    });

    test('is long enough to resist guessing', () => {
        const { password } = seedAdminPassword();
        expect(password.length).toBeGreaterThanOrEqual(20);
    });

    test('is flagged as generated, so the caller knows to print it once', () => {
        expect(seedAdminPassword().generated).toBe(true);
    });

    test('contains no characters that would break a shell or a log line', () => {
        for (let i = 0; i < 25; i++) {
            expect(seedAdminPassword().password).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });

    describe('BOOTSTRAP_ADMIN_PASSWORD override', () => {
        test('a strong pinned value is honoured', () => {
            process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Corr3ct-Horse-Battery!';
            const r = seedAdminPassword();
            expect(r.password).toBe('Corr3ct-Horse-Battery!');
        });

        test('a pinned value is NOT flagged generated, so it is never echoed to the log', () => {
            process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Corr3ct-Horse-Battery!';
            expect(seedAdminPassword().generated).toBe(false);
        });

        test.each(['admin123', 'password', 'Password1', 'short', 'admin'])(
            'refuses the weak pinned value %p rather than seeding it',
            (weak) => {
                process.env.BOOTSTRAP_ADMIN_PASSWORD = weak;
                expect(() => seedAdminPassword()).toThrow(/does not meet the password policy/);
            }
        );

        test('whitespace-only is treated as unset and falls back to a generated value', () => {
            process.env.BOOTSTRAP_ADMIN_PASSWORD = '   ';
            const r = seedAdminPassword();
            expect(r.generated).toBe(true);
            expect(r.password.length).toBeGreaterThanOrEqual(20);
        });
    });
});

describe('no seed path reintroduces a constant credential', () => {
    const fs = require('fs');
    const path = require('path');
    // Resolve from THIS file, not process.cwd(). Reading 'src/...' relative to the
    // working directory made these two assertions pass or fail depending on where
    // jest was invoked from — running with --rootDir from the parent directory
    // turned a security guard into an ENOENT. A guard that only holds when you
    // launch it from the right folder is not a guard.
    const repo = path.join(__dirname, '../..');

    test.each(['src/database/PostgresDatabase.js', 'src/services/AuthService.js'])(
        '%s hashes a resolved password, never a literal',
        (file) => {
            const src = fs.readFileSync(path.join(repo, file), 'utf8');
            // A literal passed straight to bcrypt.hash is the exact defect being pinned.
            // Comments may still mention the old value historically, so strip them first.
            const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            expect(code).not.toMatch(/bcrypt\.hash\(\s*['"][^'"]+['"]/);
            expect(code).toMatch(/seedAdminPassword\(\)/);
        }
    );
});
