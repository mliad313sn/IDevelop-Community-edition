'use strict';

// POURQUOI CE FICHIER EXISTE — quatre choses mesurées, puis corrigées, sur la console SQL.
//
// (1) LA CIBLE ÉTAIT RECONNUE PAR SON NOM, PAS PAR CE QU'ELLE EST. Mesuré :
//        SET session_replication_role = 'replica';
//        CREATE VIEW v AS SELECT * FROM system_logs;
//        DELETE FROM v WHERE id = 12;
//     -> HTTP 200, ok=true, DELETE rowCount=1. Une vue faisait disparaître le nom du
//     texte, donc la garde ne voyait plus rien à refuser. Le `SET` seul suffisait sur
//     self_assessment_events. Les deux sont désormais refusés : le rôle de réplication
//     parce qu'il éteint TOUS les déclencheurs d'un coup sans nommer personne, et la
//     vue parce que toute relation bâtie sur une table protégée — dans le même script
//     (ici) ou déjà en base (pg_depend, testé en bout de chaîne) — hérite de sa garde.
//
// (2) « TOUT CE QUI N'EST PAS PROUVÉ EN LECTURE COMPTE COMME UNE ÉCRITURE » était écrit
//     dans le fichier et faux dans le code : tout ce qui commençait par `select` était
//     classé lecture. Mesuré, réel et COMMITÉ : `SELECT uat3_p2s03_wipe();` (fonction
//     plpgsql dont le corps est un DELETE) -> 25 lignes supprimées, restorePoint=null,
//     sur une page qui promet une sauvegarde « avant tout script qui modifie la base ».
//     La pureté se PROUVE maintenant : PostgreSQL est interrogé sur la volatilité des
//     fonctions appelées ; et si on ne peut pas l'interroger, on tombe du côté sûr.
//
// (3) LES POINTS DE RESTAURATION NE PORTAIENT PAS LEUR BASE. Un seul dossier partagé,
//     une liste {name, sizeBytes, createdAt}, et l'identité pourtant présente dans
//     l'artefact (`pg_restore -l` -> « dbname: … ») que personne ne lisait. Deux
//     instances sur une machine mélangeaient leurs sauvegardes complètes.
//
// (4) _pruneRestorePoints TRAVAILLAIT SUR LE DOSSIER PARTAGÉ : une instance pouvait
//     supprimer le filet de sécurité d'une autre, et un fichier d'origine inconnue
//     était supprimé sur son seul âge.

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:secret@localhost:5432/app_test_db';
// Whatever database the run points at (CI sets its own) — the service files
// restore points under that name.
const DBNAME = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''));

const mockPool = { query: jest.fn(), connect: jest.fn() };
const mockDb = {
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn(),
    runTransaction: jest.fn(),
    pool: mockPool,
};
jest.mock('../../src/config/database', () => mockDb);

const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../../src/services/SqlConsoleService');

const split = (sql) => svc._splitStatements(sql);

describe('SQL console — the target is what a statement REACHES, not what it spells', () => {
    test('refuses SET session_replication_role in every spelling that assigns it', () => {
        for (const sql of [
            "SET session_replication_role = 'replica'",
            'SET LOCAL session_replication_role TO replica',
            'SET SESSION session_replication_role = replica',
            "SELECT set_config('session_replication_role', 'replica', false)",
            "ALTER DATABASE app SET session_replication_role = 'replica'",
            "/* innocent comment */ SET session_replication_role='replica'",
        ]) {
            expect(svc._auditTamperViolation([sql])).toMatch(/session_replication_role/);
        }
    });

    test('reading the setting back is still allowed — the refusal targets the assignment', () => {
        expect(svc._auditTamperViolation(['SHOW session_replication_role'])).toBeNull();
    });

    test('a view created BY THE SCRIPT over a protected table inherits its guard', () => {
        const script =
            'CREATE VIEW v_logs AS SELECT * FROM system_logs;\nDELETE FROM v_logs WHERE id = 12;';
        expect(svc._auditTamperViolation(split(script))).toMatch(/v_logs cannot be modified/);
    });

    test('so does a table created AS SELECT over one, and a view over that view', () => {
        expect(
            svc._auditTamperViolation(
                split('CREATE TABLE t AS SELECT * FROM assessment_history; TRUNCATE t;')
            )
        ).toBeTruthy();
        expect(
            svc._auditTamperViolation(
                split(
                    'CREATE VIEW a AS SELECT * FROM review_signatures; CREATE VIEW b AS SELECT * FROM a; DELETE FROM b;'
                )
            )
        ).toBeTruthy();
    });

    test('a view over an ORDINARY table is not touched (no false positive)', () => {
        expect(
            svc._auditTamperViolation(
                split(
                    'CREATE VIEW v_emp AS SELECT * FROM employees; DELETE FROM v_emp WHERE id = 1;'
                )
            )
        ).toBeNull();
    });

    test('a pre-existing view is caught too — the caller passes the pg_depend answer in', () => {
        // resolvedProtectedTables() ∪ _protectedRelationAliases() is what execute()
        // hands to the guard; here the alias comes from the database, not the script.
        expect(
            svc._auditTamperViolation(
                ['DELETE FROM v_from_last_week WHERE id = 1'],
                ['system_logs', 'v_from_last_week']
            )
        ).toMatch(/v_from_last_week cannot be modified/);
    });

    test('the DDL guard cannot be switched off from the console', () => {
        expect(
            svc._auditTamperViolation(['ALTER EVENT TRIGGER trg_block_append_only_drop DISABLE'])
        ).toBeTruthy();
        expect(
            svc._auditTamperViolation(['DROP EVENT TRIGGER trg_block_append_only_drop'])
        ).toBeTruthy();
    });

    test('a RULE that redirects a write into a protected table is refused', () => {
        expect(
            svc._auditTamperViolation([
                'CREATE RULE r AS ON DELETE TO notes DO INSTEAD DELETE FROM system_logs',
            ])
        ).toBeTruthy();
    });
});

describe('SQL console — a SELECT is read-only only when it is PROVEN pure', () => {
    afterEach(() => {
        mockPool.query.mockReset();
    });

    const volatilesAre = (...names) => {
        mockPool.query.mockImplementation(async (sql, params) => {
            if (/provolatile/.test(sql)) {
                return {
                    rows: (params[0] || [])
                        .filter((n) => names.includes(n))
                        .map((n) => ({ proname: n })),
                };
            }
            return { rows: [] };
        });
    };

    test('every function call in the statement is collected, schema-qualified or not', () => {
        expect(svc._calledFunctionNames('SELECT public.uat3_wipe()')).toContain('uat3_wipe');
        expect(svc._calledFunctionNames("SELECT setval('s', 1)")).toContain('setval');
        expect(svc._calledFunctionNames('SELECT count(*) FROM employees')).toContain('count');
    });

    test('SELECT <function that deletes>() is a WRITE — this is the 25 committed deletions', async () => {
        volatilesAre('uat3_p2s03_wipe');
        const a = await svc._writeAnalysis(['SELECT uat3_p2s03_wipe()']);
        expect(a.hasWrite).toBe(true);
        expect(a.volatileCalls).toEqual(['uat3_p2s03_wipe']);
    });

    test('SELECT nextval/setval are WRITES — a dry run cannot give a sequence value back', async () => {
        volatilesAre('nextval', 'setval');
        expect((await svc._writeAnalysis(["SELECT nextval('employees_id_seq')"])).hasWrite).toBe(
            true
        );
        expect((await svc._writeAnalysis(["SELECT setval('employees_id_seq', 1)"])).hasWrite).toBe(
            true
        );
    });

    test('an ordinary read stays a read — no pointless full-database dump', async () => {
        volatilesAre('nextval', 'setval'); // count/lower are not volatile
        const a = await svc._writeAnalysis([
            'SELECT count(*), lower(first_name) FROM employees GROUP BY 2',
        ]);
        expect(a.hasWrite).toBe(false);
        expect(a.volatileCalls).toEqual([]);
    });

    test('when PostgreSQL cannot be asked, the script counts as a WRITE (fail closed)', async () => {
        mockPool.query.mockImplementation(async () => {
            throw new Error('connection refused');
        });
        expect((await svc._writeAnalysis(['SELECT mystery_function()'])).hasWrite).toBe(true);
    });

    test('the plain DML classification is untouched', async () => {
        expect((await svc._writeAnalysis(['DELETE FROM employees WHERE id = 1'])).hasWrite).toBe(
            true
        );
        expect((await svc._writeAnalysis(['SELECT 1'])).hasWrite).toBe(false);
    });
});

describe('SQL console — a restore point carries the database it came from', () => {
    let dir;
    let prevDir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlc-rp-'));
        prevDir = process.env.SQL_CONSOLE_BACKUP_DIR;
        process.env.SQL_CONSOLE_BACKUP_DIR = dir;
    });
    afterEach(() => {
        process.env.SQL_CONSOLE_BACKUP_DIR = prevDir;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const put = (folder, name, ageDays = 0) => {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
        const f = path.join(dir, folder, name + '.dump');
        fs.writeFileSync(f, 'x');
        if (ageDays) {
            const t = new Date(Date.now() - ageDays * 86400000);
            fs.utimesSync(f, t, t);
        }
        return f;
    };
    const putRoot = (name, ageDays = 0) => {
        const f = path.join(dir, name + '.dump');
        fs.writeFileSync(f, 'x');
        if (ageDays) {
            const t = new Date(Date.now() - ageDays * 86400000);
            fs.utimesSync(f, t, t);
        }
        return f;
    };

    test('each database gets its own folder — two instances no longer share one pile', () => {
        expect(path.basename(svc._restoreDir())).toBe(DBNAME);
    });

    test('the list reports the database, and reports "not recorded" as null — never as ours', () => {
        put(DBNAME, 'mine-1');
        fs.writeFileSync(
            path.join(dir, DBNAME, 'mine-1.json'),
            JSON.stringify({ database: DBNAME, createdAt: new Date().toISOString() })
        );
        put(DBNAME, 'mine-2'); // no sidecar → unknown
        putRoot('legacy-shared-1'); // written before points were filed per DB

        const rows = svc.listRestorePoints();
        const by = Object.fromEntries(rows.map((r) => [r.name, r]));
        expect(by['mine-1'].database).toBe(DBNAME);
        expect(by['mine-2'].database).toBeNull();
        expect(by['legacy-shared-1'].database).toBeNull();
        expect(by['legacy-shared-1'].scope).toBe('legacy');
    });

    test("pruning touches only this database's folder — never another instance's net", () => {
        put(DBNAME, 'mine-old', 30);
        put('other_database', 'theirs-old', 30);
        putRoot('legacy-old', 30);

        svc._pruneRestorePoints(20);

        expect(fs.existsSync(path.join(dir, DBNAME, 'mine-old.dump'))).toBe(false); // ours, aged out
        expect(fs.existsSync(path.join(dir, 'other_database', 'theirs-old.dump'))).toBe(true); // not ours
        expect(fs.existsSync(path.join(dir, 'legacy-old.dump'))).toBe(true); // origin unproven
    });

    test('the point being reverted to is never pruned out from under the revert', () => {
        put(DBNAME, 'target', 30);
        svc._pruneRestorePoints(20, 'target');
        expect(fs.existsSync(path.join(dir, DBNAME, 'target.dump'))).toBe(true);
    });

    test('a restore point from ANOTHER database is refused before pg_restore runs', async () => {
        put(DBNAME, 'foreign');
        jest.spyOn(svc, '_dumpDatabaseName').mockResolvedValue('some_other_db');
        mockPool.connect.mockResolvedValue({
            query: jest.fn(async () => ({ rows: [] })),
            release() {},
        });
        const spawn = jest.spyOn(svc, '_execFile');
        try {
            await expect(svc.revertRestorePoint('foreign')).rejects.toThrow(
                /was taken from database "some_other_db"/
            );
            expect(spawn).not.toHaveBeenCalled(); // nothing was dumped, nothing was restored
        } finally {
            svc._dumpDatabaseName.mockRestore();
            spawn.mockRestore();
        }
    });

    test('a DDL guard that cannot be lifted stops the revert instead of half-restoring', async () => {
        // pg_restore --clean must DROP every table in the dump, and migration 120's
        // event trigger refuses exactly that on the append-only tables. On an install
        // where the guard was put in by a superuser and the app runs as the app role,
        // the ALTER EVENT TRIGGER fails — and going ahead anyway would abort the
        // restore part-way through. Nothing is touched, and the reason is named.
        put(DBNAME, 'ok-origin');
        jest.spyOn(svc, '_dumpDatabaseName').mockResolvedValue(DBNAME);
        jest.spyOn(svc, 'createRestorePoint').mockResolvedValue({ name: 'pre-revert-x' });
        jest.spyOn(svc, '_preserveAuditTables').mockResolvedValue({
            schema: 'audit_preserve_x',
            tables: [],
            counts: {},
        });
        jest.spyOn(svc, '_setDropGuard').mockResolvedValue('failed:must be owner of event trigger');
        mockPool.connect.mockResolvedValue({
            query: jest.fn(async () => ({ rows: [] })),
            release() {},
        });
        const spawn = jest.spyOn(svc, '_execFile');
        try {
            await expect(svc.revertRestorePoint('ok-origin')).rejects.toThrow(
                /could not be lifted for the restore/
            );
            expect(spawn).not.toHaveBeenCalled();
        } finally {
            [
                svc._dumpDatabaseName,
                svc.createRestorePoint,
                svc._preserveAuditTables,
                svc._setDropGuard,
                spawn,
            ].forEach((m) => m.mockRestore());
        }
    });

    test('an unreadable archive is refused too — an unverifiable origin is not an origin', async () => {
        put(DBNAME, 'corrupt');
        jest.spyOn(svc, '_dumpDatabaseName').mockResolvedValue(null);
        mockPool.connect.mockResolvedValue({
            query: jest.fn(async () => ({ rows: [] })),
            release() {},
        });
        try {
            await expect(svc.revertRestorePoint('corrupt')).rejects.toThrow(
                /origin cannot be verified/
            );
        } finally {
            svc._dumpDatabaseName.mockRestore();
        }
    });
});
