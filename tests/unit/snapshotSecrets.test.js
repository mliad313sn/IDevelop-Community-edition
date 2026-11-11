'use strict';
/**
 * Snapshots and secrets: a snapshot never carries a stored secret (not even
 * sealed), a restore never overwrites the live secret with an old clear copy
 * or a mask, and snapshots taken before secrets were masked are scrubbed.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/SnapshotModel', () => ({ findById: jest.fn(), create: jest.fn() }));
jest.mock('../../src/services/SqlConsoleService', () => ({
    createRestorePoint: jest.fn().mockResolvedValue({ name: 'rp', sizeBytes: 1 }),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/DSRService', () => ({
    reapplyTombstones: jest.fn().mockResolvedValue({ failed: [], reapplied: 0, tombstones: 0 }),
}));

const SnapshotModel = require('../../src/models/SnapshotModel');
const Snap = require('../../src/services/SnapshotService');

const SEALED = 'enc:v2:app_settings:aXY=:dGFn:Y3Q=';
const LIVE_SETTINGS = [
    {
        id: 11,
        settingKey: 'smtpPassword',
        settingValue: SEALED,
        settingType: 'string',
        category: 'email',
    },
    {
        id: 12,
        settingKey: 'backupKeep',
        settingValue: '14',
        settingType: 'number',
        category: 'jobs',
    },
    {
        id: 13,
        settingKey: 'sso.entra.clientSecret',
        settingValue: 'enc:v1:a:b:c',
        settingType: 'string',
        category: 'sso',
    },
];

function route(map) {
    mockDb.all.mockImplementation(async (sql) => {
        for (const [needle, rows] of map) if (sql.includes(needle)) return rows;
        return [];
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
});

test('createSnapshot omits every secret setting (clear, sealed or SSO) and says so', async () => {
    route([['FROM appSettings', LIVE_SETTINGS]]);
    SnapshotModel.create.mockResolvedValue({ id: 1 });
    await Snap.createSnapshot('s', null, 1);
    const saved = JSON.parse(SnapshotModel.create.mock.calls[0][0].snapshotData);
    const keys = saved.data.appSettings.map((r) => r.settingKey);
    expect(keys).toEqual(['backupKeep']);
    expect(saved.secretsOmitted).toBe(true);
    const text = JSON.stringify(saved);
    expect(text).not.toContain(SEALED);
    expect(text).not.toContain('enc:v1:a:b:c');
});

test('restore keeps the LIVE secret: an old clear copy or a mask in the snapshot never overwrites it', async () => {
    SnapshotModel.findById.mockResolvedValue({
        id: 5,
        snapshotData: {
            data: {
                appSettings: [
                    {
                        id: 11,
                        settingKey: 'smtpPassword',
                        settingValue: 'OLD-CLEAR-SECRET',
                        settingType: 'string',
                    },
                    {
                        id: 13,
                        settingKey: 'copilotApiSecret',
                        settingValue: '••••••••',
                        settingType: 'string',
                    },
                    { id: 12, settingKey: 'backupKeep', settingValue: '7', settingType: 'number' },
                ],
            },
        },
    });
    route([
        ['FROM pg_trigger', []],
        ['FROM pg_constraint', []],
        ['SELECT * FROM appSettings', LIVE_SETTINGS],
    ]);
    await Snap.restoreSnapshot(5, 1);

    const runs = mockDb.run.mock.calls.map(([sql, params]) => ({ sql, params: params || [] }));
    const inserts = runs.filter((r) => /^INSERT INTO app_settings/.test(r.sql));
    const flat = JSON.stringify(inserts);
    expect(flat).not.toContain('OLD-CLEAR-SECRET');
    expect(flat).not.toContain('••••••••');
    // The non-secret row comes from the snapshot…
    expect(inserts.some((r) => r.params.includes('backupKeep') && r.params.includes('7'))).toBe(
        true
    );
    // …the secrets are the live ones, sealed, put back verbatim.
    expect(
        inserts.some((r) => r.params.includes('smtpPassword') && r.params.includes(SEALED))
    ).toBe(true);
    expect(
        inserts.some(
            (r) => r.params.includes('sso.entra.clientSecret') && r.params.includes('enc:v1:a:b:c')
        )
    ).toBe(true);
});

test('older snapshots are scrubbed of secret settings, nothing else changes', async () => {
    const legacy = {
        timestamp: 't',
        data: {
            sites: [{ id: 1, name: 'A' }],
            appSettings: [
                { settingKey: 'smtpPassword', settingValue: 'clear-in-old-snapshot' },
                { settingKey: 'appName', settingValue: 'Example' },
            ],
        },
    };
    route([["snapshot_data -> 'secretsOmitted'", [{ id: 3, snapshotData: legacy }]]]);
    const n = await Snap.scrubSecretsFromStoredSnapshots();
    expect(n).toBe(1);
    const [sql, params] = mockDb.run.mock.calls[0];
    expect(sql).toMatch(/^UPDATE snapshots SET snapshot_data = \? WHERE id = \?/);
    const out = JSON.parse(params[0]);
    expect(out.data.appSettings.map((r) => r.settingKey)).toEqual(['appName']);
    expect(out.data.sites).toEqual([{ id: 1, name: 'A' }]);
    expect(out.secretsOmitted).toBe(true);
    expect(params[1]).toBe(3);
});

test('server.js scrubs stored snapshots once at boot', () => {
    const src = require('fs').readFileSync(require.resolve('../../server.js'), 'utf8');
    expect(src).toMatch(/scrubSecretsFromStoredSnapshots\(\)/);
});
