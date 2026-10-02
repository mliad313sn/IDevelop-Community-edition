'use strict';
/**
 * RESIDUS DE LA PASSE 2 — fermes par l'integrateur apres les verificateurs.
 *
 * Six lots ont travaille en parallele. Chacun a corrige ce qui lui etait
 * attribue ; les verificateurs ont trouve, PAR EXECUTION, ce que les lots
 * n'avaient pas ferme. Ce fichier garde ces trous-la, pas ceux des lots.
 *
 * ------------------------------------------------------------------------
 * 1) CONSOLE SQL — un corps de FONCTION echappait a toute la garde (P2-07/08)
 *
 * CE QUI A CASSE. _auditTamperViolation retire les litteraux de chaine (`bare`)
 * AVANT de tester les regles 1 (disable trigger), 1c (event trigger) et 4 (DDL
 * sur une table protegee), et la regle 2 n'ouvre le texte brut que pour
 * DO/CALL/EXECUTE ou un corps $$. Or un corps de fonction en GUILLEMETS SIMPLES
 * n'est rien d'autre qu'un litteral. Mesure sur idevelop, en execution a blanc
 * (transaction annulee), quatre lignes :
 *
 *   CREATE FUNCTION f() RETURNS void LANGUAGE sql
 *     AS 'ALTER TABLE system_logs DISABLE TRIGGER ALL';
 *   CREATE FUNCTION g() RETURNS void LANGUAGE sql
 *     AS 'DELETE FROM system_logs WHERE id = 12';
 *   SELECT f(); SELECT g();
 *
 * -> ok=TRUE, la ligne d'audit passe de 1 a 0. Avec
 * 'ALTER EVENT TRIGGER trg_block_append_only_drop DISABLE' dans le premier
 * corps, le DROP d'une table en ajout seul reussit ensuite (to_regclass NULL).
 * La page promet mot pour mot qu'aucune instruction qu'elle accepte ne peut
 * effacer la trace : elle le promettait a tort.
 *
 * CE QUE CE TEST EMPECHE. Que la garde redevienne aveugle au contenu d'un corps
 * de routine — et, dans l'autre sens, qu'elle se remette a refuser du travail
 * legitime : une fonction metier ordinaire, un commentaire qui CITE la trace,
 * la simple LECTURE de session_replication_role.
 *
 * ------------------------------------------------------------------------
 * 2) MFA — le message qui ENFERME l'administrateur restait en anglais (P2-16)
 *
 * Le lot parite a traduit les deux pages MFA, mais le verrou d'enrolement de
 * server.js redirigeait vers elles avec un req.flash('error', '...') anglais en
 * dur, alors que la cle flash:mfa_enrollment_required existe en FR et en EN
 * depuis longtemps. Mesure du verificateur : session FR, mfaRequiredForPrivileged
 * actif, GET /dashboard -> 302 vers la page MFA francaise, qui affiche un
 * bandeau anglais. La page d'arrivee parlait francais, la phrase qui y enferme
 * l'administrateur non.
 *
 * ------------------------------------------------------------------------
 * 3) RETOUR ARRIERE — la boite de confirmation ne nommait que 3 journaux sur 4
 *
 * La migration 116 a ajoute self_assessment_events a la liste des tables en
 * ajout seul. Le code l'a suivie (4 tables), la ligne d'audit aussi, mais
 * sqlc_revert_warning — la SEULE phrase que l'operateur lit avant de detruire —
 * en enumerait encore trois. C'est exactement la "trace qui ment" reprochee en
 * P2-08, restee dans le texte.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/idevelop';
const svc = require(path.join(ROOT, 'src', 'services', 'SqlConsoleService'));

const PROTECTED = [
    'assessment_history',
    'review_signatures',
    'self_assessment_events',
    'system_logs',
];
const refus = (sql) => svc._auditTamperViolation(svc._splitStatements(sql), PROTECTED);

describe('console SQL — un corps de fonction est du SQL, pas du texte', () => {
    test('le contournement mesure (desactiver les declencheurs depuis un corps) est refuse', () => {
        const sql = `CREATE FUNCTION zzz_off() RETURNS void LANGUAGE sql AS 'ALTER TABLE system_logs DISABLE TRIGGER ALL';
CREATE FUNCTION zzz_del() RETURNS void LANGUAGE sql AS 'DELETE FROM system_logs WHERE id = 12';
SELECT zzz_off();
SELECT zzz_del();`;
        expect(refus(sql)).toMatch(/disable triggers/i);
    });

    test('lever le declencheur d evenement depuis un corps est refuse', () => {
        const sql = `CREATE FUNCTION zzz_evt() RETURNS void LANGUAGE sql AS 'ALTER EVENT TRIGGER trg_block_append_only_drop DISABLE';`;
        expect(refus(sql)).toMatch(/event trigger/i);
    });

    test.each([
        [
            'DELETE',
            `CREATE FUNCTION z() RETURNS void LANGUAGE sql AS 'DELETE FROM system_logs WHERE id = 12';`,
        ],
        [
            'TRUNCATE',
            `CREATE FUNCTION z() RETURNS void LANGUAGE sql AS 'TRUNCATE assessment_history';`,
        ],
        [
            'UPDATE',
            `CREATE FUNCTION z() RETURNS void LANGUAGE sql AS 'UPDATE review_signatures SET signed_at = now()';`,
        ],
        [
            'DROP TABLE',
            `CREATE FUNCTION z() RETURNS void LANGUAGE sql AS 'DROP TABLE self_assessment_events CASCADE';`,
        ],
        [
            'plpgsql + EXECUTE',
            `CREATE FUNCTION z() RETURNS void LANGUAGE plpgsql AS 'BEGIN EXECUTE ''DELETE FROM system_logs''; END';`,
        ],
        [
            'PROCEDURE',
            `CREATE PROCEDURE z() LANGUAGE sql AS 'DELETE FROM system_logs WHERE id = 12';`,
        ],
    ])('%s sur un journal depuis un corps de routine est refuse', (_label, sql) => {
        expect(refus(sql)).toBeTruthy();
    });

    test('le corps en dollars ($$) reste refuse lui aussi', () => {
        const sql = `CREATE FUNCTION z() RETURNS void LANGUAGE sql AS $$ DELETE FROM system_logs WHERE id = 12 $$;`;
        expect(refus(sql)).toBeTruthy();
    });

    // L'autre bord : une garde qui refuse tout ne protege rien, elle deplace le
    // probleme sur l'operateur, qui finit par contourner la console.
    test.each([
        [
            'une fonction metier ordinaire',
            `CREATE FUNCTION zzz_ok() RETURNS integer LANGUAGE sql AS 'SELECT count(*)::int FROM employees';`,
        ],
        [
            'une fonction qui ecrit sur une table METIER',
            `CREATE FUNCTION zzz_ok2() RETURNS void LANGUAGE sql AS 'DELETE FROM perf_events WHERE id = 1';`,
        ],
        [
            'un SELECT precede d un commentaire qui CITE la trace',
            `-- ne jamais toucher a system_logs ici\nSELECT count(*) FROM employees;`,
        ],
        ['la LECTURE d un journal', `SELECT count(*) FROM system_logs;`],
    ])('%s passe toujours', (_label, sql) => {
        expect(refus(sql)).toBeNull();
    });

    // La regle 1b testait la seule MENTION du nom : un commentaire qui met en
    // garde contre le reglage, ou une valeur metier qui le cite, faisait refuser
    // tout le script — et la lecture en retour, que le commentaire du code dit
    // permise, etait refusee elle aussi.
    test.each([
        ["SET session_replication_role = 'replica'"],
        ['SET LOCAL session_replication_role TO replica'],
        ['SET SESSION session_replication_role = replica'],
        ["SELECT set_config('session_replication_role', 'replica', false)"],
        ["ALTER DATABASE app SET session_replication_role = 'replica'"],
        ["/* commentaire anodin */ SET session_replication_role='replica'"],
    ])('assigner le reglage reste refuse : %s', (sql) => {
        expect(refus(sql)).toMatch(/session_replication_role/);
    });

    test.each([
        ['SHOW', 'SHOW session_replication_role;'],
        ['lecture en retour', "SELECT current_setting('session_replication_role');"],
        [
            'commentaire',
            '-- ne jamais SET session_replication_role ici\nSELECT count(*) FROM employees;',
        ],
        [
            'valeur metier',
            "UPDATE app_settings SET value = 'session_replication_role must stay origin' WHERE key = 'x';",
        ],
    ])('nommer le reglage sans l assigner passe : %s', (_label, sql) => {
        expect(refus(sql)).toBeNull();
    });
});

describe('le verrou d enrolement MFA parle la langue de la session', () => {
    // The inline gate of server.js was removed; the policy (with its grace
    // period, failing closed) is enforced by middleware/mfaEnforcement, whose
    // holdOnSetup() writes the one enrolment flash.
    const serverSrc = fs.readFileSync(
        path.join(ROOT, 'src', 'middleware', 'mfaEnforcement.js'),
        'utf8'
    );

    // On n'EPINGLE PAS le texte source : une premiere version de ce test lisait
    // la source et restait VERTE quand on remettait l'anglais en dur (mutation
    // `req.t ?` -> `false ?`). On EXTRAIT donc l'expression reellement ecrite
    // dans le fichier et on l'EXECUTE, avec puis sans traducteur.
    const bloc = serverSrc.slice(serverSrc.indexOf('function holdOnSetup'));
    const m = /req\.flash\(\s*'error',\s*([\s\S]*?)\s*\);/.exec(bloc);
    const argument = m && m[1];

    test('le bloc d enrolement pose bien un seul flash, et on sait le lire', () => {
        expect(argument).toBeTruthy();
    });

    test('avec un traducteur, la phrase vient des locales — pas de l anglais fige', () => {
        // eslint-disable-next-line no-new-func
        const evaluer = new Function('req', 'return (' + argument + ');');
        const rendu = evaluer({ t: (k) => 'TRADUIT<' + k + '>' });
        expect(rendu).toBe('TRADUIT<flash:mfa_enrollment_required>');
    });

    test('sans traducteur, il reste un repli lisible plutot qu une cle nue', () => {
        // eslint-disable-next-line no-new-func
        const evaluer = new Function('req', 'return (' + argument + ');');
        const rendu = evaluer({});
        expect(typeof rendu).toBe('string');
        expect(rendu.trim()).not.toBe('');
        expect(rendu).not.toMatch(/^flash:/); // jamais la cle nue a l ecran
    });

    test('la cle existe dans les DEUX langues et elle est traduite', () => {
        const fr = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'locales', 'fr', 'flash.json'), 'utf8')
        );
        const en = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'locales', 'en', 'flash.json'), 'utf8')
        );
        expect(typeof fr.mfa_enrollment_required).toBe('string');
        expect(typeof en.mfa_enrollment_required).toBe('string');
        expect(fr.mfa_enrollment_required.trim()).not.toBe('');
        expect(en.mfa_enrollment_required.trim()).not.toBe('');
        expect(fr.mfa_enrollment_required).not.toBe(en.mfa_enrollment_required);
    });
});

/**
 * 4) GARDE DDL — elle desarmait le ROLE APPLICATIF (regression de la migration 120)
 *
 * CE QUI A CASSE. Les deux fonctions de declencheur d'evenement de la migration
 * 120 s'executaient avec les droits de CELUI QUI DECLENCHE le DDL, et lisaient
 * `audit_guard.append_only_registry` — une table posee par le superutilisateur
 * dans un schema sans aucun GRANT. Mesure sur idevelop, transaction annulee, avec
 * un role LOGIN NOSUPERUSER (la forme exacte du role applicatif de l'installeur) :
 *
 *   DROP TABLE <table ORDINAIRE>  -> « permission denied for table append_only_registry »
 *   CREATE TRIGGER <table ordinaire> -> « permission denied for schema audit_guard »
 *
 * Les memes ordres passent en superutilisateur. Sur une installation client, la
 * PREMIERE migration future qui supprime une table ou cree un declencheur aurait
 * fait echouer la mise a jour — et la garde y arrive sans que personne ne la
 * demande, parce que l'instantane empaquete la porte.
 *
 * CE QUE CE TEST EMPECHE : qu'une reecriture de ces fonctions les rende a nouveau
 * en droits de l'appelant, et que la 120 — dont le rattrapage documente est
 * « rejouez-la en superutilisateur » — reparte sans le durcissement et defasse
 * la 122 au passage.
 */
describe('la garde DDL ne desarme pas le role applicatif', () => {
    const lire = (f) => fs.readFileSync(path.join(ROOT, 'db', 'postgres', f), 'utf8');
    const m120 = lire('120_append_only_ddl_guard.sql');
    const m122 = lire('122_append_only_guard_privileges.sql');

    test.each([['sync_append_only_registry'], ['on_create_trigger'], ['block_append_only_drop']])(
        '120 definit %s en droits du PROPRIETAIRE, pas de l appelant',
        (fn) => {
            const i = m120.indexOf('FUNCTION audit_guard.' + fn + '()');
            expect(i).toBeGreaterThan(-1);
            // La clause doit se trouver dans la DEFINITION, avant le corps.
            const definition = m120.slice(i, m120.indexOf('AS $', i));
            expect(definition).toMatch(/SECURITY DEFINER/);
            // Un SECURITY DEFINER sans search_path fige est une porte ouverte.
            expect(definition).toMatch(/SET search_path\s*=\s*pg_catalog/);
        }
    );

    test('120 rend le schema et le registre LISIBLES par tous', () => {
        expect(m120).toMatch(/GRANT USAGE ON SCHEMA audit_guard TO PUBLIC/);
        expect(m120).toMatch(/GRANT SELECT ON audit_guard\.append_only_registry TO PUBLIC/);
    });

    test('le registre reste en AJOUT SEUL : aucune ecriture n est accordee', () => {
        for (const src of [m120, m122]) {
            expect(src).not.toMatch(
                /GRANT[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*append_only_registry/i
            );
        }
        // et la fonction qui ECRIT dans le registre n'est pas offerte a tout le monde
        expect(m122).toMatch(
            /REVOKE ALL ON FUNCTION audit_guard\.sync_append_only_registry\(\) FROM PUBLIC/
        );
    });

    test('122 repare une base qui a DEJA la 120, et ne suppose pas le schema present', () => {
        expect(m122).toMatch(/to_regnamespace\('audit_guard'\) IS NULL/);
        for (const fn of [
            'sync_append_only_registry',
            'on_create_trigger',
            'block_append_only_drop',
        ]) {
            expect(m122).toMatch(
                new RegExp(
                    'ALTER FUNCTION audit_guard\\.' + fn + '\\(\\)[\\s\\S]{0,120}SECURITY DEFINER'
                )
            );
        }
    });

    test('les deux migrations echouent en AVERTISSANT, jamais en cassant l installation', () => {
        for (const src of [m120, m122]) {
            expect(src).toMatch(/WHEN insufficient_privilege THEN/);
            expect(src).toMatch(/RAISE WARNING/);
        }
    });
});

describe('la phrase lue avant un retour arriere nomme TOUS les journaux', () => {
    // La liste vraie est celle que le service resout, pas une liste recitee.
    const declaree = svc.PROTECTED_TABLES.map((t) => String(t).toLowerCase());

    test.each(['fr', 'en'])('sqlc_revert_warning (%s) nomme les 4 tables en ajout seul', (lng) => {
        const dict = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'locales', lng, 'datamgmt.json'), 'utf8')
        );
        const phrase = String(dict.sqlc_revert_warning || '').toLowerCase();
        expect(phrase).not.toBe('');
        for (const t of declaree) expect(phrase).toContain(t);
    });

    test('la liste declaree est bien celle de 4 tables, pas celle de 3', () => {
        expect(declaree).toEqual(expect.arrayContaining(['self_assessment_events']));
        expect(declaree.length).toBeGreaterThanOrEqual(4);
    });
});
