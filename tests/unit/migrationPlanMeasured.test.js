'use strict';
/**
 * « 0 en attente » doit vouloir dire QU'ON A REGARDÉ.
 *
 * CE QUI A CASSÉ, mesuré le 16/09/2026 sur une base de développement. Une
 * migration livrée de DEUX instructions (100_maintenance_assessment_cancel.sql)
 * est estampillée 'pre-existing' — la marque que le lanceur écrit quand il a
 * annulé le fichier en entier tout en inscrivant sa clé. Dans cet état, selon la
 * façon dont on interroge le plan :
 *     plan(fichiers, {key,value}, lecteur) -> unverified=1 halfApplied=1
 *     plan(fichiers, CLÉS seules)          -> unverified=0 halfApplied=0
 * Les deux zéros sont, pour l'appelant, indiscernables d'une base saine. C'est
 * une absence de mesure présentée comme un zéro — la règle de la maison que
 * cette famille de fichiers doit tenir la première.
 *
 * CE QUE CES TESTS EMPÊCHENT
 *   - que plan() rende un zéro sans dire s'il a eu de quoi mesurer :
 *     `measured.values` (les valeurs de schema_meta ont été fournies) et
 *     `measured.contents` (les fichiers étaient lisibles) sont désormais rendus
 *     avec le plan, et halfApplied n'est une mesure que si les DEUX sont vrais ;
 *   - que scripts/migrate.js ou le pré-vol impriment un succès par-dessus une
 *     vérification qui n'a pas eu lieu : les deux refusent (sortie 1) sur un
 *     plan non mesuré, et les deux interrogent schema_meta avec sa VALEUR.
 *
 * CE QUI RESTE À LA MAIN DE LA FAMILLE DES CONTRÔLEURS (hors de ce périmètre) :
 * src/controllers/HealthController.js:47-55 (migrationsState, relayée par
 * /healthz et /about) appelle plan() avec 'SELECT key FROM schema_meta' et sans
 * lecteur — le cas dégradé mesuré ci-dessus. Mesuré le 16/09/2026 dans l'état
 * ci-dessus : {"shipped":123,"applied":124,"pending":0,"ahead":0}, aucun champ
 * unverified ni halfApplied. Le plan ne peut pas deviner une valeur qu'on ne lui
 * donne pas ; la correction est du côté de l'appelant — lire (key, value),
 * passer un lecteur, et remonter p.unverified / p.halfApplied / p.measured.
 */
const fs = require('fs');
const path = require('path');
const { plan, ROLLED_BACK_VALUE } = require('../../scripts/migrate-preflight');

const FILES = ['01_schema.sql', '20_one.sql', '21_many.sql', '22_clean.sql'];
const SQL = {
    '20_one.sql': "ALTER TYPE public.state ADD VALUE IF NOT EXISTS 'rejected';\n",
    '21_many.sql':
        'ALTER TABLE reviews ADD COLUMN manager_type text;\n' +
        'CREATE UNIQUE INDEX uq_guard ON reviews (id, manager_type);\n',
    '22_clean.sql': 'CREATE TABLE t (id int);\n',
};
const read = (f) => SQL[f];

describe('le plan dit toujours de quoi il a eu les moyens de répondre', () => {
    test("nourri comme le font le pré-vol et l'entrée de migration : tout est mesuré", () => {
        const p = plan(FILES, [{ key: '21_many', value: ROLLED_BACK_VALUE }], read);
        expect(p.measured).toEqual({ values: true, contents: true });
        expect(p.halfApplied).toEqual(['21_many.sql']);
    });

    test('LE DÉFAUT : les mêmes données, demandées en CLÉS seules, rendent les mêmes listes vides — seul le drapeau les sépare', () => {
        const rows = [{ key: '21_many', value: ROLLED_BACK_VALUE }];
        const mesure = plan(FILES, rows, read);
        const degrade = plan(
            FILES,
            rows.map((r) => r.key)
        ); // 'SELECT key FROM schema_meta'
        const sain = plan(FILES, [{ key: '21_many', value: 'applied' }], read);

        // Sans le drapeau, le cas dégradé est le sosie exact d'une base saine…
        expect(degrade.unverified).toEqual(sain.unverified);
        expect(degrade.halfApplied).toEqual(sain.halfApplied);
        // …alors que la même base, mesurée, porte une migration à moitié appliquée.
        expect(mesure.halfApplied).toEqual(['21_many.sql']);
        // Le drapeau est ce qui les sépare.
        expect(degrade.measured.values).toBe(false);
        expect(sain.measured.values).toBe(true);
    });

    test("sans lecteur de fichier, halfApplied n'est pas une mesure", () => {
        const p = plan(FILES, [{ key: '21_many', value: ROLLED_BACK_VALUE }]);
        expect(p.measured).toEqual({ values: true, contents: false });
        expect(p.halfApplied).toEqual([]); // vide parce que non mesuré, pas parce que sain
    });

    test("une valeur NULLE n'est pas une valeur absente : la colonne a bien été demandée", () => {
        // schema_meta porte légitimement des lignes sans valeur. Confondre les deux
        // ferait refuser le pré-vol sur une base parfaitement saine.
        const p = plan(FILES, [{ key: '20_one', value: null }], read);
        expect(p.measured.values).toBe(true);
    });

    test('une seule ligne en clé nue suffit à rendre le lot non mesuré', () => {
        const p = plan(FILES, [{ key: '20_one', value: 'applied' }, '21_many'], read);
        expect(p.measured.values).toBe(false);
    });

    test("un schema_meta vide est mesuré : il n'y a rien d'inscrit, le zéro est vrai", () => {
        // Première installation : tout est en attente, et c'est dit par pending.
        const p = plan(FILES, [], read);
        expect(p.measured).toEqual({ values: true, contents: true });
        expect(p.pending).toHaveLength(3);
    });

    test("l'ancienne signature (un tableau de clés) répond toujours, et s'annonce non mesurée", () => {
        const p = plan(FILES, ['20_one', '21_many']);
        expect(p.pending).toEqual(['22_clean.sql']);
        expect(p.measured).toEqual({ values: false, contents: false });
    });
});

describe('les deux consommateurs ne concluent jamais sur une vérification qui n’a pas eu lieu', () => {
    const src = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
    const PREFLIGHT = src('scripts/migrate-preflight.js');
    const MIGRATE = src('scripts/migrate.js');

    test('chacun demande schema_meta AVEC sa valeur et passe un lecteur de fichier', () => {
        // Le formateur coupe l'appel sur plusieurs lignes selon sa largeur : on
        // mesure les TROIS arguments réellement passés, pas la mise en page.
        const oneLine = (s) => s.replace(/\s+/g, ' ');
        for (const s of [PREFLIGHT, MIGRATE]) {
            expect(s).toContain("'SELECT key, value FROM schema_meta'");
            expect(oneLine(s)).toMatch(
                /plan\( ?fs\.readdirSync\(MIG_DIR\), ?metaRows, ?\(f\) => fs\.readFileSync\(path\.join\(MIG_DIR, f\), 'utf8'\) ?\)/
            );
        }
    });

    test('chacun refuse (sortie 1) quand le plan revient non mesuré', () => {
        for (const s of [PREFLIGHT, MIGRATE]) {
            expect(s).toMatch(/if \(!p\.measured\.values \|\| !p\.measured\.contents\)/);
        }
        expect(PREFLIGHT).toMatch(
            /PRE-FLIGHT ERROR: schema_meta values or the migration files were not read/
        );
        expect(MIGRATE).toMatch(/Half-applied check NOT made/);
    });

    test('le refus précède toute conclusion — succès comme échec', () => {
        expect(MIGRATE.indexOf('Half-applied check NOT made')).toBeLessThan(
            MIGRATE.indexOf('Migration recorded but NOT applied')
        );
        expect(MIGRATE.indexOf('Half-applied check NOT made')).toBeLessThan(
            MIGRATE.indexOf('✓ Migrations complete.')
        );
        // la forme CODE du verdict, pas les mentions qui en sont faites dans l'en-tête
        expect(PREFLIGHT.indexOf('PRE-FLIGHT ERROR: schema_meta values')).toBeLessThan(
            PREFLIGHT.indexOf("'  POST-FLIGHT OK")
        );
    });
});
