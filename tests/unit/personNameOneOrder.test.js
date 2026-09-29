'use strict';
/**
 * UAT3 M-16 / M-20 — one order for a person's name, across every layer.
 *
 * WHAT PASSE 1 SAW
 *   M-16  /cycles/9, ONE HTML response: the table said « Clara Beatrice NOVAK »
 *         (×16) while the supervisor filter of the same page said « Beatrice NOVAK
 *         Clara » (×2) — and the label no longer matched the order that page's
 *         own search indexes on.
 *   M-20  Two formats between two exports: /employees?export=csv wrote
 *         « Daniel Jean-Luc MORENO » and /admin/accounts/export.csv wrote
 *         « Jean-Luc MORENO, Daniel » for the same MOUA1184.
 *
 * WHY THE FIRST FIX WAS NOT ENOUGH, AND WHY THIS TEST EXISTS
 *   The passe-1 fix repaired the two CITED call sites, and the non-regression test
 *   it shipped read one file (CycleService). The class survived in three layers that
 *   test could not see, and an independent pass re-measured it alive:
 *     - the EJS layer   (/employees named six people in both orders in one response;
 *                        /compliance named employee 87 both ways in one response),
 *     - one CSV export  (/admin/accounts/export.csv, 76 rows « NOM, Prénom »),
 *     - THE DATABASE    (v_movement_feed, v_post_approval_queue, v_cancellation_queue
 *                        and fn_capture_employee_movement — the last of which STAMPED
 *                        the reversed spelling into the movement ledger on every
 *                        manager/supervisor change, so the defect regrew by itself).
 *
 *   So this test does not pin a call site. It pins the CLASS, in every layer where
 *   the class can live: the decision itself, the source tree, and the live database.
 *   Re-introduce `last_name || ', ' || first_name` (or its JS/EJS equivalent)
 *   anywhere and one of these tests fails.
 */

require('dotenv').config();
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/idevelop';

const fs = require('fs');
const path = require('path');
const db = require('../../src/config/database');
const { personName, personNameOf, personNameSql } = require('../../src/utils/personName');

const ROOT = path.join(__dirname, '..', '..');
let reachable = false;

beforeAll(async () => {
    try {
        await db.connect();
        await db.get('SELECT 1 AS ok');
        reachable = true;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[personNameOneOrder] Postgres unreachable:', err && err.message);
    }
}, 30000);

afterAll(async () => {
    await db.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// 1) The decision itself.
// ---------------------------------------------------------------------------
describe('M-16/M-20 — the one order is given name, then family name', () => {
    test('a person is named « Prénom Nom », never « Nom, Prénom »', () => {
        // Employee 136 of idevelop: last_name is a COMPOUND name, which is exactly
        // why the order is the only thing telling a reader which half is which.
        expect(personName('Clara', 'Beatrice NOVAK')).toBe('Clara Beatrice NOVAK');
        expect(personName('Daniel', 'Jean-Luc MORENO')).toBe('Daniel Jean-Luc MORENO');
        expect(personNameOf({ firstName: 'Ismael', lastName: 'LINDQVIST' })).toBe(
            'Ismael LINDQVIST'
        );
        expect(personNameOf({ first_name: 'Ismael', last_name: 'LINDQVIST' })).toBe(
            'Ismael LINDQVIST'
        );
    });

    test('a missing half yields the other half — never a stray separator, never null', () => {
        // The reversed expressions this replaced (`last_name || ', ' || first_name`)
        // went NULL as soon as one half was missing: an unnamed row.
        expect(personName('Clara', null)).toBe('Clara');
        expect(personName(null, 'NOVAK')).toBe('NOVAK');
        expect(personName('  Jean  ', '  Fischer ')).toBe('Jean Fischer');
        expect(personName(null, null)).toBe('');
        expect(personNameOf(null)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// 2) The source tree — the layers the passe-1 test could not see.
// ---------------------------------------------------------------------------
describe('M-16/M-20 — no layer of the source re-invents the reversed order', () => {
    // `last_name || ', ' || first_name`, `lastName %> <%= firstName`,
    // `${lastName}, ${firstName}` … in SQL, in JS and in EJS.
    const REVERSED = [
        /last_name\s*\|\|[^\n|]{0,24}\|\|\s*first_name/i,
        /lastName\s*\|\|[^\n|]{0,24}\|\|\s*firstName/,
        /\$\{[^}]*lastName[^}]*\}\s*,?\s*\$\{[^}]*firstName[^}]*\}/,
        /<%=\s*[\w.]*lastName\s*%>\s*,?\s*<%=\s*[\w.]*firstName\s*%>/,
    ];
    const SKIP = new Set([
        'node_modules',
        '.git',
        'dist',
        'logs',
        'backups',
        'tmp',
        'test-results',
        'coverage',
    ]);
    const WANTED = new Set(['.js', '.ejs', '.sql']);

    function walk(dir, out) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p, out);
            else if (WANTED.has(path.extname(entry.name))) out.push(p);
        }
        return out;
    }

    // db/postgres/ is deliberately NOT scanned: migrations are append-only history,
    // a later file supersedes an earlier one (96 replaced 60's view; 119 replaced
    // 62's function), so an old file still QUOTING the reversed order is the record
    // of what was once true, not live code. What is live in the database is asserted
    // directly against the database below — the authoritative reading, and the one
    // that also catches a definition changed outside this repository.
    test('src/ and views/ carry no reversed name concatenation', () => {
        const files = [];
        for (const d of ['src', 'views']) walk(path.join(ROOT, d), files);
        expect(files.length).toBeGreaterThan(100);

        const offenders = [];
        for (const f of files) {
            // The migration that REMOVED the reversed spellings quotes them in its
            // own comments; so does this test. Only live code is searched.
            const rel = path.relative(ROOT, f).replace(/\\/g, '/');
            if (rel === 'src/utils/personName.js') continue;
            const text = fs.readFileSync(f, 'utf8');
            text.split('\n').forEach((line, i) => {
                const code = line.replace(/^\s*(--|\/\/|\*|<%#).*$/, '');
                if (REVERSED.some((re) => re.test(code)))
                    offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            });
        }
        expect(offenders).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 3) The live database — the layer no source sweep can see.
// ---------------------------------------------------------------------------
describe('M-16/M-20 — the database names people in the one order', () => {
    test('Postgres is reachable (these tests are worthless without it)', () => {
        expect(reachable).toBe(true);
    });

    test('no VIEW concatenates last_name before first_name', async () => {
        if (!reachable) return;
        const views = await db.all(
            "SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname"
        );
        const offenders = [];
        for (const v of views) {
            const name = v.viewname || v.viewName;
            const row = await db.get('SELECT pg_get_viewdef(?::regclass, true) AS def', [name]);
            const def = row.def || '';
            const hits = (def.match(/last_name[^\n]{0,24}\|\|[^\n]{0,24}first_name/g) || []).length;
            if (hits) offenders.push(`${name} (${hits})`);
        }
        expect(offenders).toEqual([]);
    }, 60000);

    test('no FUNCTION writes a reversed label into the ledger', async () => {
        if (!reachable) return;
        const fns = await db.all(
            `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prokind = 'f'`
        );
        const offenders = fns
            .filter((f) => /last_name[^\n]{0,24}\|\|[^\n]{0,24}first_name/.test(f.def || ''))
            .map((f) => f.sig);
        expect(offenders).toEqual([]);
    }, 60000);

    test('the SQL fragment names the same person as the JS helper', async () => {
        if (!reachable) return;
        const rows = await db.all(
            `SELECT first_name AS "firstName", last_name AS "lastName",
                    ${personNameSql('e')} AS "sqlName"
               FROM employees e WHERE first_name IS NOT NULL AND last_name IS NOT NULL LIMIT 50`
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.sqlName).toBe(personNameOf(r));
    });

    test('the movement ledger holds no label in the reversed order', async () => {
        if (!reachable) return;
        // fn_capture_employee_movement used to stamp « NOM, Prénom » here on every
        // manager/supervisor change; migration 119 fixed the writer and re-spelled
        // the labels it had already stamped (only exact matches, nothing deleted).
        const bad = await db.all(
            `SELECT m.id, m.kind, m.from_label AS "fromLabel", m.to_label AS "toLabel"
               FROM employee_movements m
              WHERE m.kind IN ('manager', 'supervisor')
                AND EXISTS (SELECT 1 FROM employees e
                             WHERE m.from_label = e.last_name || ', ' || e.first_name
                                OR m.to_label   = e.last_name || ', ' || e.first_name)`
        );
        expect(bad).toEqual([]);
    });
});
