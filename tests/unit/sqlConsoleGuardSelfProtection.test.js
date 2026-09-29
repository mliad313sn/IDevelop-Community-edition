'use strict';

// POURQUOI CE FICHIER EXISTE.
//
// La console SQL refusait déjà, statement par statement, tout ce qui vise un journal
// en ajout seul. Elle ne se demandait pas ce qui vise LA GARDE elle-même, ni ce qui
// sort tout simplement du SQL. Trois trous ont été mesurés le 15/09/2026 sur une base
// de développement, chacun dans sa propre transaction, toutes annulées :
//
// 1) `COPY … TO PROGRAM` — le pire, parce qu'il ne joue pas au même jeu que les
//    gardes. Mesuré EN EXÉCUTION À BLANC, le mode dont l'étiquette dit « aucune ligne
//    n'est enregistrée » :
//        COPY (SELECT '…') TO PROGRAM 'cmd /c more > C:\tmp\temoin.txt';
//        -> ok=true, restorePoint=null, et le fichier existait sur le disque après.
//    Une commande du système d'exploitation exécutée sous le compte du serveur ne
//    s'annule pas avec un ROLLBACK, et elle contourne d'un coup TOUTES les gardes de
//    ce fichier : `psql -c "DROP TABLE self_assessment_events"` n'est pas une
//    instruction SQL que la console voit passer. La page promet pourtant « Aucune
//    instruction acceptée par cette page ne peut effacer ni réécrire la trace de ce
//    qui a été fait ». `lo_export()` est la même classe par une autre porte.
//
// 2) Le schéma `audit_guard` — celui où la migration 120 range le registre et le
//    déclencheur d'événement qui refusent le DROP d'un journal. Mesuré :
//        DROP SCHEMA audit_guard CASCADE;       -> RÉUSSIT (la CASCADE supprime le
//            déclencheur d'événement avant qu'il ait à s'exécuter, donc il ne
//            s'exécute jamais), puis pg_event_trigger = 0 ligne
//        DROP SCHEMA audit_guard CASCADE; DROP TABLE self_assessment_events;
//            -> to_regclass('self_assessment_events') = NULL. Le journal est parti.
//
// 3) Le registre — décrit par la 120 comme « EN AJOUT SEUL … Ne fait que GRANDIR ».
//    Mesuré :
//        DELETE FROM audit_guard.append_only_registry WHERE table_name='…';
//        DROP TABLE self_assessment_events;   -> to_regclass = NULL.
//
// Pour 2) et 3), la console refusait la SECONDE instruction de chaque paire par le nom
// de la table : le journal n'était pas atteignable PAR CETTE PAGE. Ce qu'elle laissait
// faire, c'est DÉSARMER la garde côté base — celle qui protège le journal sur tous les
// AUTRES chemins (psql, une migration, un outil tiers). La migration 124 ferme les deux
// côté base ; ce test épingle le côté console.
//
// CE QUE CE TEST EMPÊCHE : qu'une de ces trois portes se rouvre en silence. Il ne
// demande aucune base de données : il interroge le prédicat pur `_auditTamperViolation`,
// et il lit les fichiers de migration, qui sont la déclaration d'intention.

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const svc = require('../../src/services/SqlConsoleService');

const MIGRATION_DIR = path.resolve(__dirname, '..', '..', 'db', 'postgres');
const refused = (sql) => svc._auditTamperViolation([sql]);

describe('SQL console — une commande du système d’exploitation n’est pas du SQL', () => {
    test('COPY … TO PROGRAM est refusé — c’est la mesure du fichier témoin écrit en exécution à blanc', () => {
        expect(refused(`COPY (SELECT 1) TO PROGRAM 'cmd /c more > C:\\tmp\\temoin.txt'`)).toMatch(
            /PROGRAM/i
        );
    });

    test('COPY … FROM PROGRAM aussi — la direction ne change rien, la commande s’exécute', () => {
        expect(refused(`COPY employees FROM PROGRAM 'cmd /c type payload.csv'`)).toMatch(
            /PROGRAM/i
        );
    });

    test('la charge utile qui vise vraiment le journal est refusée avant d’exister', () => {
        expect(
            refused(
                `COPY (SELECT 1) TO PROGRAM 'psql -d prod -c "DROP TABLE self_assessment_events"'`
            )
        ).toBeTruthy();
    });

    test('lo_export() est refusé — il écrit un fichier là où rien ne sait l’annuler', () => {
        expect(
            refused(`SELECT lo_export(16384, 'C:/ProgramData/IDevelop/sql-restore-points/x.dump')`)
        ).toMatch(/lo_export/i);
    });

    test('COPY … TO un FICHIER du serveur est refusé — mesuré : ok=true et le fichier sur le disque', () => {
        // Un cran moins spectaculaire que TO PROGRAM, même conséquence : sous le compte
        // superutilisateur, cela écrase un point de restauration — ou SqlConsoleService.js
        // lui-même, ce qui emporte la garde au redémarrage suivant.
        expect(refused(`COPY (SELECT id FROM employees) TO '/tmp/export.csv' WITH CSV`)).toMatch(
            /file on the server/i
        );
        expect(
            refused(
                `COPY employees TO 'C:/Program Files/IDevelop/src/services/SqlConsoleService.js'`
            )
        ).toBeTruthy();
    });

    test('COPY … FROM un fichier reste permis — charger des lignes les ramène sous les autres gardes', () => {
        expect(refused(`COPY employees FROM '/tmp/import.csv' WITH CSV`)).toBeNull();
    });

    test('un corps de routine ne peut pas non plus écrire un fichier', () => {
        expect(
            refused(
                `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $x$ COPY employees TO '/tmp/x.csv' $x$`
            )
        ).toMatch(/file on the server/i);
    });

    test('le mot « program » dans une chaîne ordinaire ne déclenche rien (pas de faux positif)', () => {
        expect(refused(`SELECT * FROM training_plans WHERE name = 'program 2026'`)).toBeNull();
    });
});

describe('SQL console — la garde doit se garder elle-même', () => {
    test('DROP SCHEMA audit_guard est refusé — c’est le geste qui a fait tomber le journal', () => {
        expect(refused('DROP SCHEMA audit_guard CASCADE')).toMatch(/audit_guard/);
    });

    test('toute écriture sur le registre est refusée, DELETE en tête', () => {
        for (const sql of [
            `DELETE FROM audit_guard.append_only_registry WHERE table_name = 'self_assessment_events'`,
            `TRUNCATE audit_guard.append_only_registry`,
            `UPDATE audit_guard.append_only_registry SET table_name = 'x'`,
            `DROP TABLE audit_guard.append_only_registry`,
            `ALTER TABLE audit_guard.append_only_registry DROP COLUMN table_name`,
        ]) {
            expect(refused(sql)).toBeTruthy();
        }
    });

    test('LIRE le registre reste permis — une garde qui cache son état est une garde que personne n’audite', () => {
        expect(
            refused('SELECT table_name FROM audit_guard.append_only_registry ORDER BY 1')
        ).toBeNull();
        expect(refused('SELECT * FROM public.append_only_tables()')).toBeNull();
    });

    test('les fonctions de la garde ne se redéfinissent pas depuis la console', () => {
        for (const fn of [
            'block_append_only_drop',
            'sync_append_only_registry',
            'append_only_tables',
            'block_audit_guard_drop',
            'block_registry_mutation',
        ]) {
            expect(
                refused(
                    `CREATE OR REPLACE FUNCTION audit_guard.${fn}() RETURNS void LANGUAGE sql AS 'SELECT 1'`
                )
            ).toBeTruthy();
            expect(refused(`DROP FUNCTION audit_guard.${fn}() CASCADE`)).toBeTruthy();
        }
    });

    test('la paire mesurée, dans un seul script, est refusée à la première instruction', () => {
        expect(
            svc._auditTamperViolation([
                'DROP SCHEMA audit_guard CASCADE',
                'DROP TABLE self_assessment_events',
            ])
        ).toBeTruthy();
        expect(
            svc._auditTamperViolation([
                `DELETE FROM audit_guard.append_only_registry WHERE table_name = 'self_assessment_events'`,
                'DROP TABLE self_assessment_events',
            ])
        ).toBeTruthy();
    });
});

describe('SQL console — un corps de fonction est du SQL qui s’exécutera plus tard', () => {
    // `bare` jette les littéraux de chaîne avant tout autre test : un corps de routine
    // voyage précisément comme un littéral. Chaque garde ci-dessus doit donc être
    // rejouée sur le texte BRUT quand l’instruction définit une routine.
    test('un corps ne peut pas contenir COPY … TO PROGRAM', () => {
        expect(
            refused(
                `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $x$ COPY (SELECT 1) TO PROGRAM 'cmd /c whoami' $x$`
            )
        ).toMatch(/PROGRAM/i);
    });

    test('un corps ne peut pas appeler lo_export()', () => {
        expect(
            refused(
                `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $x$ SELECT lo_export(1, 'C:/x') $x$`
            )
        ).toMatch(/lo_export/i);
    });

    test('un corps ne peut pas supprimer le schéma de la garde', () => {
        expect(
            refused(
                `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS 'DROP SCHEMA audit_guard CASCADE'`
            )
        ).toBeTruthy();
    });

    test('un corps ne peut pas vider le registre', () => {
        expect(
            refused(
                `CREATE PROCEDURE p() LANGUAGE sql AS $x$ DELETE FROM audit_guard.append_only_registry $x$`
            )
        ).toMatch(/append_only_registry/);
    });

    test('un corps innocent passe toujours — la garde ne doit pas coûter sans protéger', () => {
        expect(
            refused(
                `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT count(*)::int FROM employees'`
            )
        ).toBeNull();
    });
});

describe('la page ne promet rien que le code ne tienne', () => {
    // Règle de la maison. La promesse « Aucune instruction acceptée par cette page ne
    // peut effacer ni réécrire la trace de ce qui a été fait » était déjà écrite quand
    // `COPY … TO PROGRAM` passait. Chaque vecteur que le texte énumère est donc rejoué
    // ici contre le prédicat : si quelqu'un retire une garde sans retirer la phrase,
    // ce test tombe.
    const fr = require('../../locales/fr/datamgmt.json');
    const en = require('../../locales/en/datamgmt.json');

    const VECTEURS = [
        [/COPY … TO\/FROM PROGRAM/, `COPY (SELECT 1) TO PROGRAM 'cmd /c whoami'`],
        [/lo_export/, `SELECT lo_export(1, '/tmp/x')`],
        [/audit_guard/, `DROP SCHEMA audit_guard CASCADE`],
        [/append_only_registry/, `DELETE FROM audit_guard.append_only_registry`],
        [/session_replication_role/, `SET session_replication_role = 'replica'`],
    ];

    test.each(VECTEURS)(
        'ce que le texte annonce refusé (%s) est réellement refusé',
        (motif, sql) => {
            expect(fr.sqlc_appendonly_body).toMatch(motif);
            expect(en.sqlc_appendonly_body).toMatch(motif);
            expect(refused(sql)).toBeTruthy();
        }
    );

    test('les deux langues portent la même promesse — parité stricte, même geste', () => {
        for (const mot of [
            'PROGRAM',
            'lo_export',
            'audit_guard',
            'append_only_registry',
            'session_replication_role',
        ]) {
            expect(fr.sqlc_appendonly_body).toContain(mot);
            expect(en.sqlc_appendonly_body).toContain(mot);
        }
        expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    });

    // LE SIXIÈME VECTEUR SE TENAIT SANS ÊTRE ÉPINGLÉ.
    //
    // Le texte de la page annonce aussi refusée l'écriture qui passe par une VUE —
    // celle qui ne prononce jamais le nom du journal. Ce refus-là ne vient pas du
    // prédicat : `_auditTamperViolation` ne connaît que la liste de noms qu'on lui
    // TEND. C'est `execute()` qui va demander à pg_depend les relations qui SONT un
    // journal sans en porter le nom, puis qui ajoute le résultat à cette liste
    // (SqlConsoleService.js, le `const protectedNames = [...]` juste avant l'appel
    // au prédicat). Toute la promesse tient à cette ligne de CÂBLAGE.
    //
    // Mesuré le 16/09/2026 sur une base de développement : la remplacer par
    // `[...protectedTables]` laissait la suite VERTE à 85/85, alors qu'en exécution
    // réelle `DELETE FROM <vue sur system_logs>` passait de « refusé » à ACCEPTÉ par
    // la console — seul le déclencheur côté BASE arrêtait encore le geste, et cette
    // couche-là est absente des installations où les migrations tournent sous un
    // rôle ordinaire (CREATE EVENT TRIGGER exige le superutilisateur). Le test qui
    // semblait couvrir ce vecteur (sqlConsoleSafetyNet.test.js) tend la liste
    // d'alias À LA MAIN au prédicat : il prouve que le prédicat sait s'en servir,
    // jamais qu'execute() la lui donne.
    //
    // Ces deux tests-ci épinglent le câblage, sans base de données : la SEULE source
    // possible de l'alias est le faux `_protectedRelationAliases`. S'il n'est plus
    // consulté, l'alias n'est pas dans la liste, la garde ne dit rien, et `execute()`
    // poursuit jusqu'à la sentinelle posée sur `_writeAnalysis`.
    describe('le vecteur « vue » tient par le CÂBLAGE, pas par le prédicat seul', () => {
        const ALIAS = 'zz_vue_sur_le_journal';
        let aliases;
        let resolved;
        let sentinelle;

        beforeEach(() => {
            svc._protCache = null;
            resolved = jest
                .spyOn(svc, 'resolvedProtectedTables')
                .mockResolvedValue(['system_logs']);
            aliases = jest.spyOn(svc, '_protectedRelationAliases').mockResolvedValue([ALIAS]);
            sentinelle = jest.spyOn(svc, '_writeAnalysis').mockImplementation(() => {
                throw new Error(
                    'LA GARDE A LAISSÉ PASSER : execute() a franchi le contrôle de sabotage sans ' +
                        'reconnaître la vue — le câblage vers _protectedRelationAliases a disparu.'
                );
            });
        });

        afterEach(() => {
            svc._protCache = null;
        });

        test('execute() CONSULTE pg_depend, et avec les tables réellement résolues', async () => {
            await svc.execute(`DELETE FROM ${ALIAS} WHERE id = 1`, { dryRun: true });
            expect(resolved).toHaveBeenCalled();
            expect(aliases).toHaveBeenCalledTimes(1);
            expect(aliases).toHaveBeenCalledWith(['system_logs']);
        });

        test('une relation que SEUL pg_depend sait nommer est refusée par la console', async () => {
            const r = await svc.execute(`DELETE FROM ${ALIAS} WHERE id = 1`, { dryRun: true });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(new RegExp(`${ALIAS} cannot be modified`));
            // Refusée AVANT toute écriture : rien après la garde n'a été atteint.
            expect(sentinelle).not.toHaveBeenCalled();
        });

        test('la vue sur la vue aussi — pg_depend remonte la chaîne, la garde suit', async () => {
            aliases.mockResolvedValue([ALIAS, `${ALIAS}_2`]);
            const r = await svc.execute(`DELETE FROM ${ALIAS}_2 WHERE id = 1`, { dryRun: true });
            expect(r.error).toMatch(new RegExp(`${ALIAS}_2 cannot be modified`));
        });

        test('une vue ORDINAIRE, que pg_depend ne rattache à rien, reste modifiable', async () => {
            // La garde ne doit pas coûter sans protéger : une vue de reporting qui ne
            // lit aucun journal n'est pas un journal. Elle passe la garde — la
            // sentinelle le prouve, c'est elle qui est atteinte ensuite.
            aliases.mockResolvedValue([]);
            await expect(
                svc.execute('DELETE FROM zz_vue_ordinaire WHERE id = 1', { dryRun: true })
            ).rejects.toThrow(/LA GARDE A LAISSÉ PASSER/);
        });
    });
});

describe('migration 124 — le côté base des mêmes trois trous', () => {
    const FILE = path.join(MIGRATION_DIR, '124_audit_guard_self_protection.sql');

    test('le fichier existe et rend le registre réellement en ajout seul', () => {
        expect(fs.existsSync(FILE)).toBe(true);
        const sql = fs.readFileSync(FILE, 'utf8');
        expect(sql).toMatch(
            /CREATE TRIGGER trg_registry_immutable\s+BEFORE DELETE OR UPDATE ON audit_guard\.append_only_registry/
        );
        expect(sql).toMatch(
            /CREATE TRIGGER trg_registry_no_truncate\s+BEFORE TRUNCATE ON audit_guard\.append_only_registry/
        );
    });

    test('la garde croisée vit dans public, donc elle survit au DROP SCHEMA audit_guard CASCADE', () => {
        const sql = fs.readFileSync(FILE, 'utf8');
        expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.block_audit_guard_drop\(\)/);
        expect(sql).toMatch(/CREATE EVENT TRIGGER trg_block_audit_guard_drop\s+ON sql_drop/);
    });

    test('elle ne peut pas faire échouer une installation sous un rôle non superutilisateur', () => {
        // Leçon de la 120/122 : CREATE EVENT TRIGGER exige le superutilisateur et
        // l'installeur applique les migrations sous le rôle applicatif.
        const sql = fs.readFileSync(FILE, 'utf8');
        expect(sql).toMatch(/WHEN insufficient_privilege THEN[\s\S]{0,400}RAISE WARNING/);
    });

    test('le retour arrière lève LES DEUX déclencheurs d’événement autour de pg_restore', () => {
        // Sinon la seconde garde ferait échouer la restauration à mi-chemin : pg_restore
        // --clean supprime aussi les objets de audit_guard.
        const code = fs.readFileSync(
            path.resolve(__dirname, '..', '..', 'src', 'services', 'SqlConsoleService.js'),
            'utf8'
        );
        const fn = code.slice(code.indexOf('async _setDropGuard('));
        expect(fn.slice(0, 1200)).toContain('trg_block_append_only_drop');
        expect(fn.slice(0, 1200)).toContain('trg_block_audit_guard_drop');
    });
});
