'use strict';

// POURQUOI CE FICHIER EXISTE.
//
// SqlConsoleService écrivait lui-même l'invariant : « The two must never drift ».
// C'était une phrase dans un commentaire, et elle a dérivé. La migration 116 a posé
// les deux gardes d'ajout seul (block_mutation + block_truncate) sur
// `self_assessment_events` — « la seule trace qui nomme l'acteur d'une approbation
// administrateur » — et la liste du code est restée à trois tables. Mesuré le
// 15/09/2026 sur idevelop, en transaction annulée :
//
//   PROTECTED_TABLES (code)          = 3 tables
//   déclencheurs réellement en base  = 4 tables
//   DELETE FROM self_assessment_events   -> accepté par la console
//   DROP TABLE self_assessment_events    -> accepté ET RÉUSSI (to_regclass = NULL)
//   _preserveAuditTables()               -> 3 tables en quarantaine sur 4
//
// Ce que ce test empêche : qu'une migration future pose les gardes d'ajout seul sur
// une nouvelle table sans que la liste du code suive. Il ne demande pas de base de
// données — il lit les fichiers de migration, qui sont la déclaration d'intention —
// et il tombe en ROUGE au moment où la dérive est introduite, pas six mois après.
//
// Deuxième filet, complémentaire et à l'exécution : SqlConsoleService.
// resolvedProtectedTables() prend l'UNION de la liste déclarée et de ce que la base
// rapporte, donc une table qui porte les gardes est protégée même si la liste tarde.

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const cleanup = require('../../src/services/DatabaseCleanupService');
const svc = require('../../src/services/SqlConsoleService');

const MIGRATION_DIR = path.resolve(__dirname, '..', '..', 'db', 'postgres');

/** Every table a migration puts a block_mutation()/block_truncate() trigger on. */
function tablesGuardedByMigrations() {
    const found = new Set();
    const files = fs.readdirSync(MIGRATION_DIR).filter((f) => /\.sql$/i.test(f));
    // CREATE TRIGGER <name> BEFORE … ON public.<table> … EXECUTE FUNCTION block_mutation()
    const re =
        /create\s+trigger\s+[^\s;]+\s+before\s+[\s\S]{0,120}?\bon\s+(?:public\.)?"?([a-z0-9_]+)"?[\s\S]{0,200}?execute\s+(?:function|procedure)\s+(?:public\.)?block_(?:mutation|truncate)\s*\(/gi;
    for (const f of files) {
        const sql = fs.readFileSync(path.join(MIGRATION_DIR, f), 'utf8');
        let m;
        while ((m = re.exec(sql)) !== null) found.add(m[1].toLowerCase());
    }
    return [...found].sort();
}

describe('append-only tables — the code list and the migrations must not drift', () => {
    test('the migrations really do declare append-only tables (the scan is not silently empty)', () => {
        // A regex that matched nothing would make every assertion below vacuously true.
        expect(tablesGuardedByMigrations().length).toBeGreaterThanOrEqual(4);
    });

    test('every table guarded by a migration is in DatabaseCleanupService.IMMUTABLE_TABLES', () => {
        const missing = tablesGuardedByMigrations().filter((t) => !cleanup.isImmutable(t));
        expect(missing).toEqual([]); // ← self_assessment_events was here
    });

    test('self_assessment_events is named explicitly — it is the case that was missed', () => {
        expect(tablesGuardedByMigrations()).toContain('self_assessment_events');
        expect(cleanup.isImmutable('self_assessment_events')).toBe(true);
        expect(svc.PROTECTED_TABLES).toContain('self_assessment_events');
    });

    test('the console guard refuses BOTH the DML and the DDL on every declared table', () => {
        for (const t of svc.PROTECTED_TABLES) {
            expect(svc._auditTamperViolation([`DELETE FROM ${t} WHERE id = 1`])).toBeTruthy();
            expect(svc._auditTamperViolation([`DROP TABLE ${t}`])).toBeTruthy();
            expect(svc._auditTamperViolation([`ALTER TABLE ${t} DROP COLUMN action`])).toBeTruthy();
            expect(svc._auditTamperViolation([`TRUNCATE ${t}`])).toBeTruthy();
        }
    });

    test('migration 120 ships the database-side answer, so the code never has to recite the list', () => {
        const f = path.join(MIGRATION_DIR, '120_append_only_ddl_guard.sql');
        expect(fs.existsSync(f)).toBe(true);
        const sql = fs.readFileSync(f, 'utf8');
        // the live view of the truth…
        expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.append_only_tables\(\)/);
        // …the durable registry a sql_drop trigger can still read after the drop…
        expect(sql).toMatch(/audit_guard\.append_only_registry/);
        // …and the event trigger that refuses the DROP the row triggers never saw.
        expect(sql).toMatch(/CREATE EVENT TRIGGER trg_block_append_only_drop\s+ON sql_drop/);
    });
});
