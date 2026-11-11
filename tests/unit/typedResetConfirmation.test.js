'use strict';
/**
 * The typed word before an irreversible reset (4.0.0 port, wave 10), checked
 * SERVER-SIDE, and the go-live wipe's coverage of the tables of the 4.0.0
 * waves:
 *   - POST /app-settings/reset changes nothing without the word (RESET or
 *     RÉINITIALISER, accents and case folded) and says so;
 *   - scripts/reset-for-golive.js --confirm aborts without
 *     --confirm-word=PRODUCTION, before it connects to anything;
 *   - the go-live WIPE, the database cleanup and the append-only list know
 *     dev_proposals, pip_reviews, review_records, board_decisions,
 *     board_decision_events and board_pack_runs.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
jest.mock('../../src/models/AppSettingsModel', () => ({
    initializeDefaults: jest.fn(async () => undefined),
    getValue: jest.fn(async (k, d) => d),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../../src/utils/typedConfirmation');

const ROOT = path.join(__dirname, '..', '..');

describe('the typed words', () => {
    test('either language, any case, accents folded; anything else refused', () => {
        for (const w of [
            'RESET',
            'reset',
            ' Reset ',
            'RÉINITIALISER',
            'réinitialiser',
            'REINITIALISER',
        ])
            expect(`${w}:${T.typedWordMatches('settingsReset', w)}`).toBe(`${w}:true`);
        for (const w of ['', null, undefined, 'RESE', 'RESET ALL', 'PRODUCTION', 'x'.repeat(200)])
            expect(`${w}:${T.typedWordMatches('settingsReset', w)}`).toBe(`${w}:false`);
        expect(T.typedWordMatches('goLive', 'production')).toBe(true);
        expect(T.typedWordMatches('goLive', 'RESET')).toBe(false);
        expect(T.typedWordMatches('constructor', 'RESET')).toBe(false);
        expect(T.typedWordMatches('nothing', 'RESET')).toBe(false);
    });
});

describe('POST /app-settings/reset checks the word itself', () => {
    const AppSettingsModel = require('../../src/models/AppSettingsModel');
    const C = require('../../src/controllers/AppSettingsController');
    const call = async (body, user = { id: 1, userType: 'admin', role: 'superadmin' }) => {
        const flashes = [];
        const req = {
            user,
            body,
            ip: '127.0.0.1',
            get: () => 'jest',
            t: (k) => k,
            flash: (type, msg) => flashes.push(`${type}:${msg}`),
        };
        let redirected = null;
        const res = { redirect: (u) => (redirected = u) };
        await C.reset(req, res);
        return { flashes, redirected };
    };
    beforeEach(() => AppSettingsModel.initializeDefaults.mockClear());

    test('no word, or another word: nothing is reset, the person is told', async () => {
        for (const body of [{}, { confirm: '' }, { confirm: 'yes' }, { confirm: 'PRODUCTION' }]) {
            const r = await call(body);
            expect(r.redirected).toBe('/app-settings');
            expect(r.flashes).toEqual(['error:flash:settings_reset_word_mismatch']);
        }
        expect(AppSettingsModel.initializeDefaults).not.toHaveBeenCalled();
    });

    test('the word in either language resets', async () => {
        for (const confirm of ['RESET', 'réinitialiser']) {
            const r = await call({ confirm });
            expect(r.flashes).toEqual(['success:flash:settings_reset_done']);
        }
        expect(AppSettingsModel.initializeDefaults).toHaveBeenCalledTimes(2);
    });

    test('without manage_app_settings the word changes nothing either', async () => {
        const r = await call(
            { confirm: 'RESET' },
            { id: 2, userType: 'admin', role: 'localadmin', permissions: [] }
        );
        expect(r.flashes).toEqual(['error:flash:settings_reset_superadmin']);
        expect(AppSettingsModel.initializeDefaults).not.toHaveBeenCalled();
    });

    test('the form asks for the word; the route keeps its permission (CSRF is global)', () => {
        const view = fs.readFileSync(
            path.join(ROOT, 'views', 'pages', 'app-settings', 'index.ejs'),
            'utf8'
        );
        expect(view).toMatch(
            /<form action="\/app-settings\/reset" method="POST"[\s\S]*?name="_csrf"[\s\S]*?<label for="settings-reset-word">[\s\S]*?name="confirm" required/
        );
        const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'index.js'), 'utf8');
        expect(routes).toMatch(
            /'\/app-settings\/reset',\s*requirePermission\('manage_app_settings'\),\s*AppSettingsController\.reset/
        );
    });
});

describe('the go-live wipe', () => {
    const reset = require('../../scripts/reset-for-golive');
    const WAVE_TABLES = [
        'dev_proposals',
        'pip_reviews',
        'review_records',
        'board_decisions',
        'board_decision_events',
        'board_pack_runs',
    ];

    test('the typed word is the script’s own check', () => {
        expect(reset.confirmWordOk(['--confirm'])).toBe(false);
        expect(reset.confirmWordOk(['--confirm', '--confirm-word=reset'])).toBe(false);
        expect(reset.confirmWordOk(['--confirm', '--confirm-word=PRODUCTION'])).toBe(true);
        expect(reset.confirmWordOk(['--confirm-word=production'])).toBe(true);
    });

    test('--confirm without the word aborts before connecting to anything', () => {
        let err = null;
        try {
            execFileSync(
                process.execPath,
                [path.join(ROOT, 'scripts', 'reset-for-golive.js'), '--confirm'],
                {
                    cwd: ROOT,
                    // an address nobody serves: even a missed check could not reach a database
                    env: {
                        ...process.env,
                        DATABASE_URL: 'postgres://nobody:none@127.0.0.1:9/none_test',
                    },
                    stdio: 'pipe',
                    timeout: 30000,
                }
            );
        } catch (e) {
            err = e;
        }
        expect(err).not.toBeNull();
        expect(String(err.stderr)).toMatch(
            /needs the typed word too \(--confirm-word=PRODUCTION\)/
        );
        expect(String(err.stderr)).not.toMatch(/ECONNREFUSED/);
    });

    test('Setup.bat passes the word after its own prompt', () => {
        const bat = fs.readFileSync(path.join(ROOT, 'installer', 'Setup.bat'), 'utf8');
        expect(bat).toMatch(/set \/p "sure= {2}Type PRODUCTION to confirm the reset/);
        expect(bat).toMatch(
            /scripts\\reset-for-golive\.js --confirm --confirm-word=PRODUCTION\r?\n/
        );
    });

    test('the tables of the 4.0.0 waves are wiped, cleaned and known as append-only', () => {
        for (const t of WAVE_TABLES) {
            expect(`${t}:${reset.WIPE.has(t)}`).toBe(`${t}:true`);
            expect(`${t}:${reset.KEEP.has(t)}`).toBe(`${t}:false`);
        }
        const cleanup = fs.readFileSync(
            path.join(ROOT, 'src', 'services', 'DatabaseCleanupService.js'),
            'utf8'
        );
        const order = cleanup.slice(cleanup.indexOf('const CLEAN_ORDER'), cleanup.indexOf('];'));
        for (const t of ['dev_proposals', 'pip_reviews']) expect(order).toContain(`'${t}'`);
        const D = require('../../src/services/DatabaseCleanupService');
        for (const t of [
            'review_records',
            'board_decisions',
            'board_decision_events',
            'board_pack_runs',
        ])
            expect(D.IMMUTABLE_PG_TABLES).toContain(t);
    });
});
