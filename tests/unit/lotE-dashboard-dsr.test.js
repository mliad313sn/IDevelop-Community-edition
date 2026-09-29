'use strict';

// SECTION ux (UAT3 passe 1) — Tableau de bord et symétrie export/effacement.
//   M-12  la tuile « Mesures effectif & talents » ignorait le FILTRE ACTIF (charge
//         octet pour octet identique avec et sans filtre, `people 76`, pendant que
//         `/overview-kpis` passait de 76 à 17) et la phrase de garantie de
//         périmètre était démentie par les chiffres de la même page.
//         Arbitrage 4 du tableau, les deux volets : (a) recharger la tuile avec le
//         filtre actif ; (b) restreindre la phrase aux blocs qui la tiennent.
//   A-04  quatre catégories détruites par l'effacement et jamais restituées par
//         l'export (`username`, `user_identities`, `external_id`/`auth_provider`,
//         recognitions ÉMISES) — plus une cinquième trouvée en instrumentant
//         `erase()` (les comptes d'administration liés) — et l'asymétrie INVERSE
//         tranchée (revue, litige, demande de modification).
//         Référentiel RH 13/09/2026 §3 règle 15 : les deux listes sont la MÊME liste.
//
// La base est simulée : chaque test pilote le code réel et vérifie le SQL émis.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

let mockScopeIds = null; // ce que RBAC rend pour un administrateur restreint
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'superadmin',
    getFilteredEmployees: async () => (mockScopeIds || []).map((id) => ({ id })),
    scopeFilter: async () => ({ clause: '', params: [] }),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: async () => (mockScopeIds || []).slice(),
}));

const DashboardController = require('../../src/controllers/DashboardController');
const DSR = require('../../src/services/DSRService');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Banc d'essai de /api/dashboard/measures : on capture chaque requête et le
// tableau d'identifiants qui lui est lié, et on rend un compte reconnaissable.
// ---------------------------------------------------------------------------
function runMeasures({ user, query = {}, filterRows = null }) {
    const seen = [];
    mockDb.all.mockImplementation(async (sql, params) => {
        seen.push({ sql: flat(sql), params });
        // la requête qui résout le filtre de nom vers des personnes
        if (/FROM employees e LEFT JOIN/i.test(flat(sql)))
            return (filterRows || []).map((id) => ({ id }));
        return [];
    });
    mockDb.get.mockImplementation(async (sql, params) => {
        seen.push({ sql: flat(sql), params });
        return { c: 7 };
    });
    const ctl = new DashboardController();
    let payload = null;
    const res = {
        json: (j) => {
            payload = j;
        },
        status: () => res,
    };
    const req = { user, query, t: (k) => k };
    return ctl.getMeasures(req, res).then(() => ({ payload, seen }));
}

const SUPER = { id: 666, userType: 'admin', role: 'superadmin' };
const MANAGER = { id: 136, userType: 'employee' };

const find = (seen, re) => seen.filter((s) => re.test(s.sql));

describe('M-12 (a) — la tuile des mesures suit le FILTRE ACTIF', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockScopeIds = null;
    });

    test('sans filtre ni périmètre, aucune requête ne porte de liste d’identifiants (charge inchangée)', async () => {
        const { seen } = await runMeasures({ user: SUPER });
        expect(find(seen, /FROM employees e LEFT JOIN/i)).toHaveLength(0);
        expect(seen.every((s) => !s.params || !s.params.length)).toBe(true);
        // le catalogue reste le catalogue entier
        expect(find(seen, /^SELECT COUNT\(\*\) FROM sites$/i)).toHaveLength(1);
    });

    test('un filtre de nom est RÉSOLU vers des personnes puis appliqué à chaque mesure', async () => {
        const { seen } = await runMeasures({
            user: SUPER,
            query: { siteName: 'Riverside', departmentName: 'IT', serviceName: 'Data & Insights' },
            filterRows: [11, 12, 13],
        });
        const resolver = find(seen, /FROM employees e LEFT JOIN/i)[0];
        expect(resolver).toBeTruthy();
        expect(resolver.sql).toMatch(/st\.name = \?/);
        expect(resolver.sql).toMatch(/dp\.name = \?/);
        expect(resolver.sql).toMatch(/sv\.name = \?/);
        expect(resolver.params).toEqual(['Riverside', 'IT', 'Data & Insights']);
        // le filtre est un filtre de PLACEMENT : il ne présume pas de l'état
        expect(resolver.sql).not.toMatch(/is_active/);
        const people = find(seen, /FROM employees e WHERE is_active/i)[0];
        expect(people.sql).toMatch(/e\.id = ANY\(\?\)/);
        expect(people.params).toEqual([[11, 12, 13]]);
    });

    test('un filtre n’ÉLARGIT jamais un périmètre : on intersecte, on n’unit pas', async () => {
        mockScopeIds = [11, 12]; // ce manager gouverne 11 et 12
        const { seen } = await runMeasures({
            user: MANAGER,
            query: { siteName: 'Riverside' },
            filterRows: [11, 90, 91],
        });
        const people = find(seen, /FROM employees e WHERE is_active/i)[0];
        // 136 (le lecteur lui-même) et 12 sortent par le filtre, 90/91 par le périmètre
        expect(people.params).toEqual([[11]]);
    });

    test('un filtre qui ne désigne personne rend une mesure BORNÉE, jamais toute l’organisation', async () => {
        const { seen } = await runMeasures({
            user: SUPER,
            query: { siteName: 'ZZZ' },
            filterRows: [],
        });
        const people = find(seen, /FROM employees e WHERE is_active/i)[0];
        expect(people.sql).toMatch(/AND 1=0/);
        expect(people.params).toEqual([]);
    });

    test('le catalogue de PLACEMENT compte les entrées OCCUPÉES dès qu’un périmètre est actif', async () => {
        mockScopeIds = [11, 12];
        const { seen } = await runMeasures({ user: MANAGER });
        for (const [table, col] of [
            ['sites', 'site_id'],
            ['departments', 'department_id'],
            ['services', 'service_id'],
            ['roles', 'role_id'],
        ]) {
            const q = find(
                seen,
                new RegExp(`FROM ${table} t JOIN employees e ON e\\.${col} = t\\.id`, 'i')
            )[0];
            expect(q).toBeTruthy();
            expect(q.sql).toMatch(/COUNT\(DISTINCT t\.id\)/);
            expect(q.sql).toMatch(/e\.id = ANY\(\?\)/);
        }
    });
});

describe('M-12 (b) — la garantie de périmètre ne porte que sur ce qu’elle tient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockScopeIds = null;
    });

    test('le RÉFÉRENTIEL de compétences n’est JAMAIS restreint, et le dit', async () => {
        mockScopeIds = [11, 12];
        const { payload, seen } = await runMeasures({
            user: MANAGER,
            query: { siteName: 'Riverside' },
            filterRows: [11, 12],
        });
        // aucune borne sur skills / domains : règle du propriétaire (§3 règle 12)
        const skills = find(seen, /FROM skills/i)[0];
        const domains = find(seen, /FROM domains/i)[0];
        expect(skills.sql).toBe('SELECT COUNT(*) FROM skills');
        expect(domains.sql).toBe('SELECT COUNT(*) FROM domains');
        const marked = payload.measures.filter((m) => m.framework).map((m) => m.key);
        expect(marked).toEqual(['skills', 'domains']);
        expect(payload.frameworkChip).toBe('dash:measure_framework_chip');
        expect(payload.frameworkHint).toBe('dash:measure_framework_hint');
        expect(payload.scoped).toBe(true);
    });

    test('la phrase des DEUX locales nomme l’exception au lieu de tout promettre', () => {
        const fr = JSON.parse(read('locales/fr/dash.json'));
        const en = JSON.parse(read('locales/en/dash.json'));
        expect(fr.exec_scope_hint).toMatch(/sauf/i);
        expect(fr.exec_scope_hint).toMatch(/référentiel/i);
        expect(en.exec_scope_hint).toMatch(/except/i);
        expect(en.exec_scope_hint).toMatch(/framework/i);
        for (const k of ['measure_framework_chip', 'measure_framework_hint']) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
            expect(fr[k]).not.toBe(en[k]); // traduit, pas recopié
        }
    });

    test('la vue interroge l’API AVEC le filtre et se recharge quand on l’applique ou le remet à zéro', () => {
        const v = read('views/pages/dashboard.ejs');
        expect(v).toMatch(/fetch\('\/api\/dashboard\/measures'\s*\+\s*activeQuery\(\)/);
        expect(v).toMatch(/filter-site[\s\S]{0,80}siteName/);
        expect(v).toMatch(/btn-apply-filters/);
        expect(v).toMatch(/btn-reset-filters/);
        // la carte « référentiel » est rendue, échappée, avec son info-bulle
        expect(v).toMatch(/measure-chip/);
        expect(v).toMatch(/m\.framework\s*\?/);
    });
});

describe('A-04 — l’export rend TOUT ce que l’effacement détruit', () => {
    const src = () => read('src/services/DSRService.js');

    const exportSql = async () => {
        const calls = [];
        mockDb.all.mockImplementation(async (sql) => {
            calls.push(flat(sql));
            return [];
        });
        mockDb.get.mockImplementation(async (sql) => {
            calls.push(flat(sql));
            return {};
        });
        const out = await DSR.export(138);
        return { calls, out, joined: calls.join(' | ') };
    };

    beforeEach(() => jest.clearAllMocks());

    test('le profil rend le LOGIN et l’identité externe — que l’effacement détruit', async () => {
        const { joined } = await exportSql();
        const profile = joined.split(' | ').find((s) => /FROM employees WHERE id/i.test(s));
        for (const col of ['username', 'external_id', 'auth_provider', 'is_account_active']) {
            expect(profile).toContain(col);
        }
    });

    test('un secret d’authentification n’est JAMAIS exporté', async () => {
        const { joined } = await exportSql();
        expect(joined).not.toMatch(/password_hash/);
    });

    test('les identités externes et les comptes d’administration liés sont rendus', async () => {
        const { out, joined } = await exportSql();
        expect(Object.keys(out)).toEqual(
            expect.arrayContaining(['userIdentities', 'linkedAdminAccounts'])
        );
        expect(joined).toMatch(/FROM user_identities WHERE subject_type = 'employee'/i);
        expect(joined).toMatch(/FROM admins a WHERE a\.linked_employee_id = \?/i);
    });

    test('les recognitions ÉMISES aussi, pas seulement les reçues', async () => {
        const { joined } = await exportSql();
        const r = joined.split(' | ').find((s) => /FROM recognitions/i.test(s));
        expect(r).toMatch(/to_employee_id = \? OR from_employee_id = \?/i);
        expect(r).toMatch(/AS direction/i);
    });

    test('LA MÊME LISTE : chaque table redactée par l’effacement est lue par l’export', async () => {
        const { out, joined } = await exportSql();
        const erase = src().slice(src().indexOf('async erase('));
        for (const c of DSR.REDACTED_ON_ERASURE) {
            expect(Object.keys(out)).toContain(c.key);
            expect(joined).toContain(c.table);
            expect(erase).toContain(c.table);
        }
    });
});

describe('A-04 — l’asymétrie INVERSE, tranchée : le texte libre écrit sur la personne', () => {
    const erase = () => {
        const s = read('src/services/DSRService.js');
        return s.slice(s.indexOf('async erase('));
    };

    test('la revue, le litige et la demande de modification sont redactés', () => {
        const e = erase();
        expect(e).toMatch(
            /UPDATE supervisor_reviews SET supervisor_notes = NULL, gap_reason = NULL WHERE employee_id = \?/
        );
        expect(e).toMatch(
            /UPDATE assessment_disputes SET reason = '\[erased\]' WHERE employee_id = \?/
        );
        expect(flat(e)).toMatch(/UPDATE assessment_change_requests SET reason = '\[erased\]'/);
    });

    test('les colonnes NOT NULL reçoivent un marqueur, jamais un NULL qui ferait échouer l’effacement', () => {
        const e = flat(erase());
        // assessment_disputes.reason et assessment_change_requests.reason sont
        // NOT NULL + CHECK (btrim(...) <> '') : un NULL abortirait la transaction.
        expect(e).not.toMatch(/UPDATE assessment_disputes SET reason = NULL/);
        expect(e).not.toMatch(/UPDATE assessment_change_requests SET reason = NULL/);
    });

    test('seul le TEXTE part : la décision reste lisible et l’effacement reste borné au sujet', () => {
        const e = flat(erase());
        for (const col of [
            'supervisor_rated_level',
            'decided_by_ref',
            'decided_at',
            'status',
            'decision',
        ]) {
            expect(e).not.toMatch(new RegExp(`SET[^;]*${col}\\s*=`));
        }
        // aucune ligne d'une AUTRE personne : les trois instructions se bornent
        // au sujet, jamais à `requester_ref` / `decided_by_ref` (le dossier
        // d'autrui garderait son motif, l'identité du sujet n'y étant qu'une
        // référence opaque, comme dans le journal d'audit).
        for (const t of [
            'supervisor_reviews',
            'assessment_disputes',
            'assessment_change_requests',
        ]) {
            const from = e.indexOf(`UPDATE ${t} SET`);
            expect(from).toBeGreaterThan(-1);
            const stmt = e.slice(from, e.indexOf('[employeeId]', from));
            expect(stmt).toMatch(/WHERE employee_id = \?/);
        }
        expect(e).not.toMatch(/UPDATE assessment_change_requests[\s\S]{0,300}WHERE requester_ref/);
    });

    test('l’histoire d’emploi reste DÉCLARÉE comme rendue mais non détruite', () => {
        // Intention conservée : l'événement de cycle de vie est rendu et NON
        // détruit. La liste s'est étoffée (résidu A-04 : la clé `idp`, en-tête de
        // plan sans narration, n'était déclarée nulle part) — on épingle donc
        // l'appartenance, et l'absence de la liste des catégories effacées.
        const tables = DSR.DISCLOSED_ABOUT_SUBJECT.map((c) => c.table);
        expect(tables).toContain('lifecycle_events');
        expect(DSR.REDACTED_ON_ERASURE.map((c) => c.table)).not.toContain('lifecycle_events');
    });
});

// =========================================================================
//  A-04, RÉSIDU DE LA PASSE 1 — l'épinglage à la COLONNE.
//
//  La correspondance clé↔table ne voyait rien À L'INTÉRIEUR d'une catégorie
//  déjà déclarée : cinq colonnes rendues par l'export restaient lisibles après
//  l'effacement, dont quatre pendant qu'une AUTRE colonne de la MÊME LIGNE
//  partait. Mesuré sur idevelop, sujet 138, en transaction annulée, AVANT
//  correction — « encore lisible dans export() après erase() ? » :
//      PROBE-RISK-FACTORS            true   (retention_risk, jamais touchée,
//                                            clé `retentionRisk` non déclarée)
//      PROBE-PLAN-TITLE              true   (coaching_plans.title)
//      PROBE-PLAN-EXPECTED-OUTCOME   true   (coaching_plans.expected_outcome)
//      PROBE-PLAN-OBJECTIVE          false  ← la même ligne, elle, partait
//      PROBE-NB-DISCLOSURE-REASON    true   (nine_box_evaluations)
//      PROBE-NB-COMMENTS             false  ← la même ligne, elle, partait
//      PROBE-SAR-CANCEL-REASON       true   (self_assessment_rounds, alors que
//                                            le même appel met
//                                            employees.cancel_reason à '[erased]')
//  APRÈS correction, mêmes sondes : les huit à false, `undeclaredExportKeys`
//  réduit à ['employeeId','generatedAt'] (les deux vraies métadonnées).
//
//  Ces tests ne rejouent pas les cinq cas : ils ferment la CLASSE. Toute
//  colonne rendue par l'export doit être CLASSÉE (détruite / conservée), et
//  toute colonne déclarée détruite doit être réellement assignée par erase().
// =========================================================================
describe('A-04 (résidu) — aucune colonne exportée n’échappe à la classification', () => {
    const META = ['employeeId', 'generatedAt']; // horodatage et sujet, pas des colonnes
    const ALL = () => [...DSR.REDACTED_ON_ERASURE, ...DSR.DISCLOSED_ABOUT_SUBJECT];

    beforeEach(() => jest.clearAllMocks());

    // Chaque requête d'export est rattachée à SA clé : `export()` assigne
    // `out[label]` juste après son `db.all`, donc l'ordre des appels est celui
    // des clés du résultat. Le profil passe par `db.get`.
    const captured = async () => {
        const calls = [];
        mockDb.all.mockImplementation(async (sql) => {
            calls.push(flat(sql));
            return [];
        });
        let profileSql = null;
        mockDb.get.mockImplementation(async (sql) => {
            profileSql = flat(sql);
            return {};
        });
        const out = await DSR.export(138);
        const keys = Object.keys(out).filter((k) => !META.includes(k) && k !== 'profile');
        const byKey = new Map(keys.map((k, i) => [k, calls[i]]));
        byKey.set('profile', profileSql);
        return { out, byKey };
    };

    // Liste de colonnes d'un SELECT : découpe sur les virgules de profondeur 0,
    // s'arrête au FROM de profondeur 0, jette les EXPRESSIONS (CASE, sous-
    // requête) qui ne sont pas des colonnes de table, et retire préfixe et alias.
    const selectColumns = (sql) => {
        const s = String(sql);
        const start = s.search(/\bSELECT\b/i) + 6;
        let depth = 0;
        let end = s.length;
        for (let i = start; i < s.length; i++) {
            if (s[i] === '(') depth++;
            else if (s[i] === ')') depth--;
            else if (depth === 0 && /\s/.test(s[i]) && /^FROM\b/i.test(s.slice(i + 1))) {
                end = i;
                break;
            }
        }
        const parts = [];
        let cur = '';
        depth = 0;
        for (const ch of s.slice(start, end)) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (ch === ',' && depth === 0) {
                parts.push(cur);
                cur = '';
                continue;
            }
            cur += ch;
        }
        parts.push(cur);
        return parts
            .map((p) => p.trim())
            .filter(Boolean)
            .filter((p) => !/[()]/.test(p) && !/\bCASE\b/i.test(p))
            .map((p) =>
                p
                    .replace(/\s+AS\s+\w+$/i, '')
                    .trim()
                    .replace(/^\w+\./, '')
            );
    };

    const eraseSrc = () => {
        const s = read('src/services/DSRService.js');
        return s.slice(s.indexOf('async erase('));
    };
    // Les clauses SET de TOUTES les instructions d'effacement visant cette table
    // (le sujet en a deux sur `employees`), sans leur WHERE : une colonne citée
    // dans un WHERE n'est pas une colonne détruite.
    const setClauses = (table) => {
        const src = flat(eraseSrc()); // les instructions sont écrites sur plusieurs lignes
        const re = new RegExp(`UPDATE ${table} SET`, 'g');
        const out = [];
        let m;
        while ((m = re.exec(src))) {
            const w = src.indexOf('WHERE', m.index);
            out.push(src.slice(m.index, w === -1 ? src.length : w));
        }
        return out.join(' ');
    };

    test('chaque clé de l’export est DÉCLARÉE dans l’une des deux listes', async () => {
        const { out } = await captured();
        const declared = new Set(ALL().map((c) => c.key));
        expect(Object.keys(out).filter((k) => !META.includes(k) && !declared.has(k))).toEqual([]);
    });

    test('chaque colonne rendue est CLASSÉE, et rien n’est déclaré qui ne soit rendu', async () => {
        const { byKey } = await captured();
        for (const c of ALL()) {
            const sql = byKey.get(c.key);
            expect([c.key, Boolean(sql)]).toEqual([c.key, true]);
            const rendered = selectColumns(sql);
            const declared = [...(c.erased || []), ...(c.kept || [])];
            // une colonne, une seule classe
            expect([c.key, declared.length]).toEqual([c.key, new Set(declared).size]);
            // rien d'INCLASSÉ (le défaut mesuré : title, expected_outcome,
            // disclosure_reason, cancel_reason, et toute la table retention_risk)
            expect([c.key, rendered.filter((col) => !declared.includes(col))]).toEqual([c.key, []]);
            // ni rien d'INVENTÉ : une colonne déclarée mais plus exportée
            expect([c.key, declared.filter((col) => !rendered.includes(col))]).toEqual([c.key, []]);
        }
    });

    test('chaque colonne déclarée DÉTRUITE l’est réellement par erase()', () => {
        for (const c of DSR.REDACTED_ON_ERASURE) {
            if (c.deleted) {
                // ligne supprimée en entier : tout part, rien n'est « conservé »
                expect([c.key, eraseSrc()]).toEqual([
                    c.key,
                    expect.stringContaining(`DELETE FROM ${c.table} WHERE`),
                ]);
                expect([c.key, c.kept]).toEqual([c.key, []]);
                continue;
            }
            const sets = setClauses(c.table);
            expect([c.key, sets.length > 0]).toEqual([c.key, true]);
            for (const col of c.erased) {
                expect([c.key, col, new RegExp(`\\b${col}\\s*=`).test(sets)]).toEqual([
                    c.key,
                    col,
                    true,
                ]);
            }
            // et ce qui est déclaré CONSERVÉ n'est jamais assigné : la structure
            // de la décision (niveaux, écart, état, auteur, dates) reste lisible.
            for (const col of c.kept) {
                expect([c.key, col, new RegExp(`\\b${col}\\s*=`).test(sets)]).toEqual([
                    c.key,
                    col,
                    false,
                ]);
            }
        }
    });

    test('une catégorie déclarée CONSERVÉE ne prétend détruire aucune colonne', () => {
        for (const c of DSR.DISCLOSED_ABOUT_SUBJECT) {
            expect([c.key, c.erased || []]).toEqual([c.key, []]);
            expect([c.key, (c.kept || []).length > 0]).toEqual([c.key, true]);
        }
    });

    test('les cinq résidus, nommément : les colonnes voisines partent avec leur ligne', () => {
        const e = flat(eraseSrc());
        // (b)(c) coaching_plans : title est NOT NULL → marqueur, jamais un NULL
        expect(e).toMatch(
            /UPDATE coaching_plans SET title = '\[erased\]', objective = NULL, expected_outcome = NULL WHERE employee_id = \?/
        );
        expect(e).not.toMatch(/UPDATE coaching_plans SET title = NULL/);
        // (d) nine_box : contrainte chk_ninebox_disclosure_complete → marqueur
        // sur une ligne divulguée, NULL quand il n'y avait pas de motif
        expect(e).toMatch(
            /UPDATE nine_box_evaluations SET comments = NULL, evidence = NULL, calibration_notes = NULL, disclosure_reason = CASE WHEN disclosure_reason IS NULL THEN NULL ELSE '\[erased\]' END/
        );
        // (e) self_assessment_rounds : contrainte chk_sa_cancel_reasoned → même
        // forme que employees.cancel_reason, dans la même transaction
        expect(e).toMatch(
            /UPDATE self_assessment_rounds SET notes = NULL, justification = NULL, cancel_reason = CASE WHEN cancelled_at IS NULL THEN NULL ELSE '\[erased\]' END/
        );
        // (a) retention_risk : la ligne entière part
        expect(e).toMatch(/DELETE FROM retention_risk WHERE employee_id = \?/);
        // et l'export la rend AVANT, sinon la règle 15 serait tenue à l'envers
        expect(DSR.REDACTED_ON_ERASURE.map((c) => c.key)).toContain('retentionRisk');
    });
});
