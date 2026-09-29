'use strict';
/**
 * 123_repair_113_carryover_and_views.sql — réparation de la migration 113.
 *
 * CE QUI A CASSÉ, mesuré le 15/09/2026 sur une base de développement clonée.
 *
 * (A) La reprise de données de 113 (lignes 86-105) numérote les tours par
 *     (created_at, id) et marque « remplacés » tous ceux qui ne sont pas les
 *     plus récents. Elle ne regarde ni workflow_state, ni status, ni
 *     l'existence d'une revue superviseur en attente. Sur la forme de données
 *     ANTÉRIEURE à 113 — où l'unicité portait sur (employee_id, skill_id,
 *     STATUS) et où une paire pouvait donc porter en même temps un brouillon
 *     et une ligne soumise — le brouillon rouvert est le plus récent :
 *         AVANT la reprise : tour soumis 224063, revue 'pending', file = 1 ligne
 *         APRÈS la reprise : tour 224063 remplacé, file = 0 ligne
 *     Une décision attendue quitte la file du superviseur le jour même où la
 *     migration s'applique, sans un mot.
 *
 * (B) Le ALTER TABLE ... RENAME TO de 113:47 a emmené SIX vues avec la table :
 *     PostgreSQL lie les vues par OID, pas par nom. Mesuré par pg_depend :
 *     v_cycle_participant_status, v_employee_cycle_progress,
 *     v_employee_skill_gaps, v_perf_actions, v_requirement_provenance et
 *     v_resolved_assessments dépendent de self_assessment_rounds — la table,
 *     historique compris — alors que leurs fichiers d'origine (55, 57, 71, 80,
 *     105, tous antérieurs à 113) écrivent tous « FROM self_assessments ».
 *     Effet mesuré sur une paire portant un tour APPROUVÉ devenu historique et
 *     un tour courant SOUMIS : la vérité (vue self_assessments) dit
 *     « submitted », v_resolved_assessments annonce « niveau 4, self_approved ».
 *
 * CE QUE CES TESTS EMPÊCHENT
 *   - que la réparation (A) s'élargisse à des tours qui ont été remplacés pour
 *     de bonnes raisons : les quatre gardes (signature de la reprise, décision
 *     réellement en attente, coquille vide, un seul tour par paire) sont
 *     épinglées une par une ;
 *   - qu'elle supprime quoi que ce soit ;
 *   - qu'une SEPTIÈME vue antérieure à 113 lisant self_assessments soit ajoutée
 *     au produit sans être re-branchée ici : la liste des six n'est pas
 *     comparée à une liste écrite à la main, elle est RECALCULÉE depuis les
 *     fichiers de migration à chaque exécution du test.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MIG_DIR = path.join(ROOT, 'db', 'postgres');
// Renumerotee 122 -> 123 par l'integrateur le 16/09/2026 (collision de numero avec
// 122_append_only_guard_privileges.sql). Le fichier est resolu par son SUFFIXE, et
// la cle schema_meta attendue est DERIVEE du nom trouve : un renumerotage futur ne
// doit pas faire virer ce test au rouge pour une raison qui n'est pas un comportement,
// mais la coherence nom-de-fichier / cle doit, elle, rester epinglee.
const REPAIR = fs
    .readdirSync(MIG_DIR)
    .find((f) => /^\d+_repair_113_carryover_and_views\.sql$/.test(f));
const sql = fs.readFileSync(path.join(MIG_DIR, REPAIR), 'utf8');

/** Corps du fichier, commentaires `--` retirés : les gardes doivent être du CODE. */
const code = sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

const num = (n) => {
    const m = /^(\d+)/.exec(n);
    return m ? Number(m[1]) : null;
};

// ---------------------------------------------------------------------------
// A) La réparation de la reprise : strictement les tours déclassés à tort.
// ---------------------------------------------------------------------------
describe("A — un tour n'est rendu à la file que si les quatre gardes sont réunies", () => {
    test('garde 1 : il doit être marqué remplacé ET pointer vers son successeur', () => {
        expect(code).toMatch(/r\.superseded_at IS NOT NULL/);
        expect(code).toMatch(
            /JOIN public\.self_assessment_rounds nxt ON nxt\.id = r\.superseded_by/
        );
    });

    test("garde 2 : la signature de la REPRISE — l'absence d'événement 'reopen_new_cycle'", () => {
        // C'est LE discriminant. Le seul chemin applicatif qui remplace un tour
        // (SelfAssessmentService) écrit toujours cet événement sur le tour
        // remplacé, dans la même transaction. Sans ce test, la réparation
        // annulerait de vraies re-mesures.
        expect(code).toMatch(
            /NOT EXISTS[\s\S]{0,200}self_assessment_events[\s\S]{0,200}'reopen_new_cycle'/
        );
        expect(code).toMatch(/r\.superseded_at = nxt\.created_at/);
    });

    test("garde 3 : le tour doit réellement attendre une décision — et 'changes_requested' en est exclu", () => {
        expect(code).toMatch(
            /c\.workflow_state IN \('submitted', 'under_review', 'reviewed', 'arbitration'\)/
        );
        expect(code).toMatch(/sr\.self_assessment_id = c\.id AND sr\.status = 'pending'/);
        // la main est rendue à la personne : le brouillon suivant est sa suite légitime
        expect(code).not.toMatch(/'changes_requested'/);
    });

    test('garde 4 : le tour qui a pris la place doit être une coquille jamais soumise', () => {
        for (const g of [
            /nxt\.superseded_at IS NULL/,
            /nxt\.workflow_state = 'draft'/,
            /nxt\.submitted_at IS NULL/,
            /nxt\.reviewed_at IS NULL/,
            /nxt\.approved_at IS NULL/,
        ]) {
            expect(code).toMatch(g);
        }
        expect(code).toMatch(
            /NOT EXISTS[\s\S]{0,160}supervisor_reviews sr2[\s\S]{0,120}sr2\.self_assessment_id = nxt\.id/
        );
    });

    test("un seul tour par paire peut redevenir courant — uq_sa_current_round n'en autorise qu'un", () => {
        expect(code).toMatch(/row_number\(\) OVER \(PARTITION BY a\.employee_id, a\.skill_id/);
        expect(code).toMatch(/WHERE k\.rn = 1/);
    });

    test("la place est libérée AVANT que le tour soit rendu — sinon l'index unique refuse", () => {
        const free = code.indexOf('WHERE id = v_row.shell_id');
        const restore = code.indexOf('WHERE id = v_row.round_id');
        expect(free).toBeGreaterThan(-1);
        expect(restore).toBeGreaterThan(free);
    });

    test("l'instruction qui REND le tour à la file est épinglée mot pour mot", () => {
        // MESURÉ PAR MUTATION le 16/09/2026. En remplaçant, dans l'UPDATE de
        // restauration, `SET superseded_at = NULL, superseded_by = NULL` par
        // `SET superseded_by = NULL`, la réparation devient un NO-OP — la
        // reproduction le voit (le tour soumis reste `remplacé`, la file du
        // superviseur reste vide) — et pourtant cette suite sortait en code 0,
        // 19 tests sur 19. Les deux tests voisins n'épinglaient que l'AUTRE
        // UPDATE (la mise de côté de la coquille) et l'ORDRE des deux clauses
        // WHERE : aucun ne portait sur l'instruction qui répare. C'est la leçon
        // de la passe 2 — un correctif vrai, une suite verte, et rien qui
        // tienne le correctif en place.
        //
        // `superseded_at` est ce qui compte : c'est la colonne que lit
        // l'index partiel uq_sa_current_round (« un seul tour courant par
        // paire ») et donc la file de revue. Remettre `superseded_by` à NULL
        // sans elle laisse le tour en historique.
        expect(code).toMatch(
            /UPDATE\s+public\.self_assessment_rounds\s+SET\s+superseded_at\s*=\s*NULL\s*,\s*superseded_by\s*=\s*NULL\s+WHERE\s+id\s*=\s*v_row\.round_id\s*;/
        );
    });

    test('la boucle porte EXACTEMENT deux écritures, dans cet ordre : libérer la place, puis rendre le tour', () => {
        // La forme complète des deux instructions, extraite du fichier et
        // comparée en entier : ni un SET amputé, ni une cible échangée, ni une
        // troisième écriture glissée dans la boucle ne peuvent passer.
        const updates = [
            ...code.matchAll(
                /UPDATE\s+public\.self_assessment_rounds\s+SET\s+([\s\S]*?)\s+WHERE\s+([^;]*?)\s*;/g
            ),
        ].map((m) => ({
            set: m[1].replace(/\s+/g, ' ').trim(),
            where: m[2].replace(/\s+/g, ' ').trim(),
        }));
        expect(updates).toEqual([
            { set: 'superseded_at = now(), superseded_by = NULL', where: 'id = v_row.shell_id' },
            { set: 'superseded_at = NULL, superseded_by = NULL', where: 'id = v_row.round_id' },
        ]);
    });

    test('ce qui ne peut pas être tranché est laissé et DIT, jamais forcé', () => {
        expect(code).toMatch(/IF NOT v_row\.shell_is_empty THEN/);
        expect(code).toMatch(/RAISE NOTICE[\s\S]{0,200}laisse en historique/);
        expect(code).toMatch(/CONTINUE;/);
    });

    test("rien n'est supprimé : une annulation est un ÉTAT, jamais une suppression", () => {
        expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(code).not.toMatch(/\bTRUNCATE\b/i);
        expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
        // le brouillon mis de côté est marqué, pas effacé
        expect(code).toMatch(/SET superseded_at = now\(\), superseded_by = NULL/);
    });

    test("sans effet quand 113 n'est pas passée", () => {
        expect(code).toMatch(
            /IF to_regclass\('public\.self_assessment_rounds'\) IS NULL THEN\s*\n\s*RETURN;/
        );
    });
});

// ---------------------------------------------------------------------------
// B) Les six vues : la liste est RECALCULÉE, jamais recopiée.
// ---------------------------------------------------------------------------
describe('B — toute vue antérieure à 113 qui lit self_assessments est re-branchée', () => {
    /**
     * Dernière définition de chaque vue dans les fichiers de migration, dans
     * l'ordre où le lanceur les applique. Une vue dont la dernière définition
     * précède 113 a été emportée par le RENAME ; une vue redéfinie après 113
     * s'est re-branchée toute seule sur la vue (c'est le cas de v_movement_feed,
     * redéfinie en 119 — et pg_depend le confirme).
     */
    const lastDef = new Map();
    const files = fs
        .readdirSync(MIG_DIR)
        .filter((f) => /\.sql$/i.test(f) && !/_down\.sql$/i.test(f))
        .sort((a, b) => (num(a) || 0) - (num(b) || 0) || a.localeCompare(b));
    for (const f of files) {
        const text = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
        const re =
            /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+AS/gi;
        let m;
        while ((m = re.exec(text))) {
            const rest = text.slice(m.index);
            const end = rest.search(/;\s*(\n|$)/);
            const body = end > 0 ? rest.slice(0, end) : rest;
            lastDef.set(m[1], { file: f, n: num(f), readsSa: /\bself_assessments\b/.test(body) });
        }
    }
    const carriedAway = [...lastDef.entries()]
        .filter(([name, v]) => v.readsSa && v.n < 113 && name !== 'self_assessments')
        .map(([name]) => name)
        .sort();

    /**
     * v_requirement_provenance a QUITTÉ cette liste : la migration 136 la
     * redéfinit (pour que la dégradation d'un certificat périmé s'applique
     * aussi à cette vue), donc elle se re-branche toute seule sur la VUE
     * self_assessments — exactement comme v_movement_feed l'a fait en 119.
     * Vérifié par pg_depend ci-dessous, pas supposé.
     *
     * v_resolved_assessments a QUITTÉ cette liste à son tour : la migration 142
     * (R3 — un auto-évaluation approuvée doit porter un niveau) la redéfinit,
     * donc elle se re-branche elle aussi sur la VUE self_assessments courante.
     *
     * Ce qui reste protégé, et c'est tout l'intérêt : une vue antérieure à 113
     * qui lirait self_assessments sans être re-branchée.
     */
    test('le calcul retrouve exactement les vues antérieures à 113 encore concernées', () => {
        expect(carriedAway).toEqual([
            'v_cycle_participant_status',
            'v_employee_cycle_progress',
            'v_employee_skill_gaps',
            'v_perf_actions',
        ]);
    });

    test('une vue redéfinie APRÈS 113 se re-branche seule, et 136 le fait pour la provenance', () => {
        const prov = lastDef.get('v_requirement_provenance');
        expect(prov).toBeTruthy();
        expect(prov.readsSa).toBe(true);
        expect(prov.n).toBeGreaterThan(113); // sinon elle devrait figurer ci-dessus
        expect(carriedAway).not.toContain('v_requirement_provenance');
    });

    test("la migration 122 nomme chacune d'elles", () => {
        const listed = /v_names CONSTANT text\[\] := ARRAY\[([\s\S]*?)\]/.exec(code);
        expect(listed).toBeTruthy();
        const names = [...listed[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
        // 122 peut en nommer davantage sans dommage — elle passe son chemin
        // quand la vue est déjà branchée sur la vue (le CONTINUE testé plus
        // bas). Ce qui compte : aucune des vues concernées ne lui échappe.
        for (const v of carriedAway) expect(names).toContain(v);
    });

    test('la définition VIVANTE est relue, jamais un texte recopié — une correction postérieure à 113 ne peut pas être annulée', () => {
        expect(code).toMatch(
            /pg_get_viewdef\(\('public\.' \|\| quote_ident\(v_name\)\)::regclass, true\)/
        );
        expect(code).toMatch(
            /regexp_replace\([\s\S]{0,120}'\\mself_assessment_rounds\\M', 'self_assessments', 'g'\)/
        );
        expect(code).toMatch(/CREATE OR REPLACE VIEW public\.%I AS %s/);
        // jamais de DROP VIEW : les vues qui en dépendent doivent survivre
        expect(code).not.toMatch(/\bDROP\s+VIEW\b/i);
    });

    test("une vue déjà branchée sur la vue est laissée telle quelle — d'où l'absence d'effet et la rejouabilité", () => {
        expect(code).toMatch(/IF v_def !~ '\\mself_assessment_rounds\\M' THEN\s*\n\s*CONTINUE;/);
    });

    test('la migration se vérifie elle-même et échoue si une des six reste sur la table', () => {
        expect(code).toMatch(/AND dep\.relname = ANY \(v_names\)/);
        expect(code).toMatch(
            /RAISE EXCEPTION 'reparation 113 : vue\(s\) encore branchee\(s\) sur la table des tours apres re-creation/
        );
    });

    test('toute AUTRE vue lisant la table est signalée, jamais réécrite en douce', () => {
        expect(code).toMatch(/RAISE NOTICE[\s\S]{0,200}verifier que c''est VOULU/);
    });
});

// ---------------------------------------------------------------------------
// Le fichier lui-même : les règles de la maison pour une migration.
// ---------------------------------------------------------------------------
describe('le fichier respecte le contrat du lanceur', () => {
    test('aucun BEGIN/COMMIT : le lanceur enveloppe déjà le fichier', () => {
        expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    });

    test("elle s'inscrit dans schema_meta sous son propre nom de fichier", () => {
        // La cle attendue est DERIVEE du nom du fichier : si le fichier est renumerote
        // sans que son auto-estampille suive, la base le rejouerait a chaque demarrage
        // sous une cle qui ne correspond a rien. C'est ce desaccord qui est epingle ici,
        // pas un numero en particulier.
        const expectedKey = REPAIR.replace(/\.sql$/, '');
        expect(code).toContain(
            `INSERT INTO schema_meta(key, value) VALUES ('${expectedKey}', 'applied')`
        );
    });

    test("aucun numero a trois chiffres n'est porte par deux fichiers", () => {
        // Cette migration a ete livree sous le numero 122, deja pris par
        // 122_append_only_guard_privileges.sql ecrite le meme jour par un autre lot,
        // alors que 123 etait libre. Le lanceur indexe schema_meta sur le nom COMPLET,
        // donc rien ne cassait — mais l'ordre d'application devenait ambigu a la lecture
        // et le trou dans la numerotation donnait a croire qu'un fichier manquait.
        //
        // Le controle ne porte QUE sur les numeros a trois chiffres : les migrations
        // historiques a deux chiffres (09, 11, 12, ...) partagent deliberement leurs
        // numeros et sont figees depuis longtemps. Les elargir ferait virer ce test
        // au rouge sur de l'existant que personne ne doit renommer.
        const nums = fs
            .readdirSync(MIG_DIR)
            .filter((f) => /^\d{3}_.*\.sql$/.test(f))
            .map((f) => f.slice(0, 3));
        const duplicates = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
        expect(duplicates).toEqual([]);
    });

    test('elle ne touche pas à 113, qui est déjà appliquée partout', () => {
        const m113 = fs.readFileSync(path.join(MIG_DIR, '113_self_assessment_rounds.sql'), 'utf8');
        expect(m113).toMatch(/WITH ordered AS/); // la reprise est laissée en place
        expect(code).not.toMatch(/ALTER TABLE public\.self_assessments RENAME/);
    });
});
