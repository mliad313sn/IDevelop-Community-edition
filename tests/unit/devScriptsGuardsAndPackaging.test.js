'use strict';
/**
 * Packaging guard — Build-Package copied scripts\ whole at one point, so
 * one-shot mutators, capture tooling and fixtures shipped into Program Files.
 * Now every script is classified PRODUCT or DEV, an unclassified one fails the
 * build, and the one-shot helper (_lib/one-shot-guard) keeps mutators dry-run by
 * default with a --commit switch and a production refusal.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const INSTALLER = path.join(ROOT, 'installer');

describe('Z-INST-10: Build-Package ships an allow-list of scripts and refuses the unclassified', () => {
    const build = fs.readFileSync(path.join(INSTALLER, 'Build-Package.ps1'), 'utf8');
    const list = (name) => {
        const m = new RegExp(`\\$${name}\\s*=\\s*@\\(([\\s\\S]*?)\\n\\)`).exec(build);
        expect(m).not.toBeNull();
        return [...m[1].replace(/#[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const product = list('productScripts');
    const dev = list('devOnlyScripts');
    const onDisk = fs
        .readdirSync(SCRIPTS)
        .filter((f) => fs.statSync(path.join(SCRIPTS, f)).isFile());

    test('every script on disk is in exactly one list', () => {
        const both = onDisk.filter((f) => product.includes(f) && dev.includes(f));
        const neither = onDisk.filter((f) => !product.includes(f) && !dev.includes(f));
        expect({ both, neither }).toEqual({ both: [], neither: [] });
    });

    test('every listed script exists (a stale entry would hide a rename)', () => {
        const stale = [...product, ...dev].filter((f) => !onDisk.includes(f));
        expect(stale).toEqual([]);
    });

    test('the product list is the referenced operator tooling, nothing that mutates data unguarded', () => {
        expect(product).toEqual(
            expect.arrayContaining([
                'migrate.js',
                'migrate-preflight.js',
                'reset-for-golive.js',
                'set-admin-password.js',
            ])
        );
        for (const f of [
            'seed-demo.js',
            'backfill-access-profiles.js',
            'v3-merge-duplicate-skills.js',
        ])
            expect({ f, shipped: product.includes(f) }).toEqual({ f, shipped: false });
    });

    test('the build fails on an unclassified script and on anything left after the purge', () => {
        expect(build).toMatch(/unclassified script\(s\)/);
        expect(build).toMatch(/if\s*\(\s*\$unclassified\.Count\s*\)\s*\{\s*throw/);
        expect(build).toMatch(/if\s*\(\s*\$notAllowed\.Count\s*\)\s*\{\s*throw/);
        expect(build).toMatch(/\$devOnlyDirs\s*=\s*@\(\s*'_lib'\s*\)/);
    });

    test('the password-hash guard is still in place behind the allow-list', () => {
        expect(build).toMatch(/bcrypt\\\.hash\|password_hash/);
    });
});

describe('the one-shot mutators are dry-run by default and refuse production', () => {
    const guard = require('../../scripts/_lib/one-shot-guard');

    test('NODE_ENV=production is refused', () => {
        expect(() => guard.oneShotGuard([], { NODE_ENV: 'production' })).toThrow(
            /NODE_ENV=production/
        );
        expect(() => guard.oneShotGuard([], { NODE_ENV: 'Production' })).toThrow(
            /NODE_ENV=production/
        );
    });

    test('without --commit the work runs inside a transaction that is rolled back', async () => {
        const calls = [];
        const db = {
            runTransaction: async (fn) => {
                calls.push('begin');
                try {
                    await fn();
                    calls.push('commit');
                } catch (e) {
                    calls.push('rollback:' + e.message);
                    throw e;
                }
            },
        };
        const { commit } = guard.oneShotGuard(['--verbose'], {});
        expect(commit).toBe(false);
        const r = await guard.runGuarded(db, commit, async () => {
            calls.push('work');
            return 7;
        });
        expect(r).toBe(7);
        expect(calls).toEqual(['begin', 'work', 'rollback:' + guard.ROLLBACK]);
        expect(guard.verdict(false, 'x')).toMatch(/DRY RUN - rolled back/);
    });

    test('with --commit the transaction commits and a real error is rethrown', async () => {
        const calls = [];
        const db = {
            runTransaction: async (fn) => {
                calls.push('begin');
                await fn();
                calls.push('commit');
            },
        };
        const { commit } = guard.oneShotGuard(['--commit'], {});
        expect(commit).toBe(true);
        await guard.runGuarded(db, commit, async () => calls.push('work'));
        expect(calls).toEqual(['begin', 'work', 'commit']);
        await expect(
            guard.runGuarded(db, commit, async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(guard.verdict(true, 'x')).toMatch(/^COMMITTED/);
    });
});
