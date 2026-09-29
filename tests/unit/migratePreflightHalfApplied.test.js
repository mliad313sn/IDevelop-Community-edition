'use strict';
/**
 * "Migration inscrite" doit vouloir dire "son contenu est en base". Il ne le
 * voulait pas.
 *
 * CE QUI A CASSE. PostgresDatabase.migrate exécute chaque fichier dans UNE
 * transaction et classe six SQLSTATE comme « objet déjà présent » (42P07,
 * 42710, 42P06, 42701, 42723, 42P16). Quand l'un d'eux part, TOUT le fichier
 * est annulé — et la clé est quand même inscrite dans schema_meta, avec la
 * valeur 'pre-existing', si bien que le fichier ne sera jamais rejoué.
 * Mesuré le 15/09/2026 en rejouant la boucle du lanceur VERBATIM dans un schéma
 * jetable, sur un fichier de DEUX instructions dont la première lève 42701 :
 *     issue du lanceur        : pre-existing (42701)
 *     schema_meta             : [{"key":"113_probe_migration","value":"pre-existing"}]
 *     garde d'unicité créée ? : NON — la 2e instruction n'a jamais tourné
 *     pré-vol                 : pending = 0 -> « POST-FLIGHT OK: nothing pending »
 * L'installeur conclut que le schéma correspond au paquet ; c'est la forme
 * exacte de la panne du client du 2026-09-09.
 *
 * CE QUE CES TESTS EMPÊCHENT. « Objet déjà présent » n'est une conclusion
 * honnête que pour un fichier d'UNE instruction. Le plan doit donc (1) remonter
 * la VALEUR inscrite, pas seulement la présence de la clé, et (2) distinguer un
 * fichier d'une instruction — signalé, non bloquant — d'un fichier
 * multi-instructions inscrit 'pre-existing', qui est une migration à moitié
 * appliquée et doit faire échouer le post-vol.
 *
 * La règle est VOLONTAIREMENT étroite : seule la valeur 'pre-existing' écrite
 * par le lanceur compte, jamais « toute valeur différente de applied ».
 * schema_meta porte légitimement d'autres valeurs (schema_version, source,
 * l'estampille d'un prérequis appliqué à la main) et échouer là-dessus
 * reconstruirait exactement la régression de 2026-09-09.
 */
const { plan, statementCount, ROLLED_BACK_VALUE } = require('../../scripts/migrate-preflight');

const FILES = ['01_schema.sql', '20_one.sql', '21_many.sql', '22_clean.sql'];
const SQL = {
    '20_one.sql': "ALTER TYPE public.state ADD VALUE IF NOT EXISTS 'rejected';\n",
    '21_many.sql':
        'ALTER TABLE reviews ADD COLUMN manager_type text;\n' +
        'CREATE UNIQUE INDEX uq_guard ON reviews (id, manager_type);\n',
    '22_clean.sql': 'CREATE TABLE t (id int);\n',
};
const read = (f) => SQL[f];

describe('statementCount — ce qui sépare « déjà présent » de « à moitié appliqué »', () => {
    test('une instruction, avec ou sans point-virgule final', () => {
        expect(statementCount('CREATE TABLE t (id int);')).toBe(1);
        expect(statementCount('CREATE TABLE t (id int)')).toBe(1);
        expect(statementCount('')).toBe(0);
        expect(statementCount('   \n\n  ')).toBe(0);
    });

    test('deux instructions en comptent deux — le cas qui a produit la panne', () => {
        expect(statementCount(SQL['21_many.sql'])).toBe(2);
    });

    test('les point-virgules dans un commentaire de ligne ne comptent pas', () => {
        expect(
            statementCount("-- ('submitted', 'under_review'); a rejected skill\nSELECT 1;")
        ).toBe(1);
    });

    test('les point-virgules dans un commentaire de bloc, même imbriqué, ne comptent pas', () => {
        expect(statementCount('/* a; /* b; */ c; */ SELECT 1;')).toBe(1);
    });

    test('les point-virgules dans une chaîne ou un identifiant entre guillemets ne comptent pas', () => {
        expect(statementCount('SELECT \'a;b\', "col;name" FROM t;')).toBe(1);
        expect(statementCount("SELECT 'il''y a; deux' FROM t;")).toBe(1);
    });

    test('un bloc DO $$ … $$ est UNE instruction, quel que soit son contenu', () => {
        const doBlock =
            'DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1) THEN\n    ALTER TABLE t ADD COLUMN c int;\n  END IF;\n  UPDATE t SET c = 1;\nEND $$;';
        expect(statementCount(doBlock)).toBe(1);
        expect(statementCount(doBlock + '\nCREATE INDEX i ON t (c);')).toBe(2);
    });

    test('un corps $tag$ … $tag$ est traité comme $$ … $$', () => {
        expect(
            statementCount(
                'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END $body$ LANGUAGE plpgsql;'
            )
        ).toBe(1);
    });
});

describe('le plan remonte la VALEUR inscrite, pas seulement la présence de la clé', () => {
    test('LE DÉFAUT : une clé inscrite après annulation du fichier passait pour appliquée', () => {
        const meta = [
            { key: '20_one', value: 'applied' },
            { key: '21_many', value: ROLLED_BACK_VALUE },
            { key: '22_clean', value: 'applied' },
        ];
        const p = plan(FILES, meta, read);
        // L'ancien verdict — celui qui a imprimé « POST-FLIGHT OK » — reste vrai…
        expect(p.pending).toEqual([]);
        // …mais le fichier est maintenant nommé, et nommé à moitié appliqué.
        expect(p.unverified).toEqual(['21_many.sql']);
        expect(p.halfApplied).toEqual(['21_many.sql']);
    });

    test("un fichier d'UNE instruction inscrit 'pre-existing' est signalé, jamais bloquant", () => {
        const p = plan(FILES, [{ key: '20_one', value: ROLLED_BACK_VALUE }], read);
        expect(p.unverified).toEqual(['20_one.sql']);
        expect(p.halfApplied).toEqual([]);
    });

    test('une base saine ne remonte rien', () => {
        const meta = FILES.filter((f) => f !== '01_schema.sql').map((f) => ({
            key: f.replace('.sql', ''),
            value: 'applied',
        }));
        const p = plan(FILES, meta, read);
        expect(p.unverified).toEqual([]);
        expect(p.halfApplied).toEqual([]);
    });

    test("LA RÉGRESSION DE 2026-09-09 : une valeur qui n'est simplement pas 'applied' ne doit RIEN déclencher", () => {
        // schema_meta porte légitimement schema_version / source / des estampilles
        // posées à la main. Seule la marque du lanceur compte.
        const meta = [
            { key: '20_one', value: null },
            { key: '21_many', value: '2026-06-30T11:09:21.200Z' },
            {
                key: '22_clean',
                value: 'V1 schema.sql + add-performance-management-features migration',
            },
            { key: 'schema_version', value: '01-base' },
        ];
        const p = plan(FILES, meta, read);
        expect(p.pending).toEqual([]);
        expect(p.unverified).toEqual([]);
        expect(p.halfApplied).toEqual([]);
    });

    test('une clé inscrite pour un fichier que ce paquet ne livre PAS ne remonte pas', () => {
        const p = plan(FILES, [{ key: '50_hotfix_local', value: ROLLED_BACK_VALUE }], read);
        expect(p.unverified).toEqual([]);
        expect(p.halfApplied).toEqual([]);
    });

    test('sans lecteur de fichier, rien ne peut être déclaré à moitié appliqué', () => {
        const p = plan(FILES, [{ key: '21_many', value: ROLLED_BACK_VALUE }]);
        expect(p.unverified).toEqual(['21_many.sql']);
        expect(p.halfApplied).toEqual([]); // on ne conclut pas sans avoir lu
    });

    test('un fichier illisible est traité comme suspect, jamais comme sain', () => {
        const p = plan(FILES, [{ key: '21_many', value: ROLLED_BACK_VALUE }], () => {
            throw new Error('ENOENT');
        });
        expect(p.halfApplied).toEqual(['21_many.sql']);
    });

    test("l'ancienne signature (un tableau de clés) continue de fonctionner", () => {
        const p = plan(FILES, ['20_one', '21_many']);
        expect(p.pending).toEqual(['22_clean.sql']);
        expect(p.unverified).toEqual([]);
    });
});

describe('les deux consommateurs refusent de conclure sur une migration annulée', () => {
    const fs = require('fs');
    const path = require('path');
    const read2 = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

    test('le post-vol sort en 3 sur une migration à moitié appliquée', () => {
        const src = read2('scripts/migrate-preflight.js');
        expect(src).toMatch(/if \(expectNone && p\.halfApplied\.length\)/);
        expect(src).toMatch(
            /POST-FLIGHT FAILED: migration\(s\) recorded as done that the runner rolled back in full/
        );
        expect(src).toMatch(/process\.exit\(3\)/);
    });

    test("l'entrée de migration manuelle refuse d'imprimer le succès par-dessus", () => {
        const src = read2('scripts/migrate.js');
        expect(src).toMatch(/if \(p\.halfApplied\.length\)/);
        expect(src).toMatch(/Migration recorded but NOT applied/);
        // le succès n'est imprimé qu'APRÈS le refus
        expect(src.indexOf('Migration recorded but NOT applied')).toBeLessThan(
            src.indexOf('✓ Migrations complete.')
        );
    });

    test('la marque surveillée est exactement celle que le lanceur écrit', () => {
        const runner = read2('src/database/PostgresDatabase.js');
        expect(runner).toContain(`'${ROLLED_BACK_VALUE}'`);
        expect(ROLLED_BACK_VALUE).toBe('pre-existing');
    });
});
