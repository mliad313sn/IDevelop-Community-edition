'use strict';

/**
 * CLÔTURE UAT3 — la CLASSE du constat E-13 : « une date ISO dans une phrase
 * française ».
 *
 * La passe 1 citait quatre emplacements, tous corrigés par le lot S6. La
 * vérification de clôture a mesuré, sur le HTML SERVI, trois surfaces où le même
 * motif survivait — et une quatrième dans la PHRASE de refus d'une campagne,
 * devenue visible dans le flash que le lot S1 compose pour M-01 :
 *
 *   /employee/my-progress   « 2026-06-01 → 2026-08-31 »   (views/pages/employees/progress.ejs)
 *   /compliance             « 2025-08-31 », « 2026-09-14 » (views/pages/compliance/index.ejs)
 *   flash M-01              « (échéance du 2026-08-31) »   (CycleService.gateMessage)
 *
 * Ces tests épinglent la RÈGLE, pas les trois lignes : aucune vue ne rend une
 * date d'affichage par `new Date(x).toISOString().slice(0, 10)` — le motif que
 * `src/utils/dateFormat.js` nomme lui-même « a live defect it must never
 * reproduce » — et la porte d'écriture de campagne parle dd/MM/aaaa tout en
 * gardant l'ISO dans son contrat machine.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

// `gateMessage` est une fonction PURE : la base n'est jamais touchée ici, elle est
// simulée uniquement parce que le service la charge au require.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
}));

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ejs')) out.push(p);
    }
    return out;
}

describe('E-13 (classe) — aucune vue ne fabrique une date affichée en ISO', () => {
    const OFFENDER = /toISOString\(\)\s*\.slice\(0,\s*10\)/;

    // Deux usages LÉGITIMES de l'ISO, et seulement ceux-là :
    //   - un attribut d'<input type="date"> (value/min/max), que la norme HTML
    //     exige en ISO et que le navigateur affiche ensuite dans la locale du
    //     lecteur — ce n'est donc jamais une date IMPRIMÉE par nous ;
    //   - le nom d'un fichier exporté (tri alphabétique = tri chronologique).
    const LEGIT = /type="date"|value="|\bmin="|\bmax="|\.csv|\.xlsx/;

    const hits = [];
    for (const file of walk(VIEWS)) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            if (!OFFENDER.test(line)) return;
            if (LEGIT.test(line)) return;
            if (/^\s*(\/\/|\*|<%#)/.test(line)) return; // commentaire
            hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
    }

    test('aucun gabarit ne rend « new Date(x).toISOString().slice(0, 10) »', () => {
        expect(hits).toEqual([]);
    });

    test('le test n’est pas vide : le motif est bien cherché et les cas légitimes existent', () => {
        const all = walk(VIEWS);
        expect(all.length).toBeGreaterThan(50);
        const legit = all.filter((f) =>
            fs
                .readFileSync(f, 'utf8')
                .split(/\r?\n/)
                .some((l) => OFFENDER.test(l) && LEGIT.test(l))
        );
        expect(legit.length).toBeGreaterThan(0); // <input type="date"> + noms de fichiers
    });

    test('les vues corrigées passent bien par un formateur partagé', () => {
        for (const rel of [
            'views/pages/employees/progress.ejs',
            'views/pages/compliance/index.ejs',
            'views/pages/qualified/index.ejs',
            'views/pages/reviews/post-approval.ejs',
        ]) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            expect(src).toMatch(/fmtPeriodBound\(|fmtDate\(/);
        }
    });

    test('server.js expose fmtPeriodBound aux vues, à côté de fmtDate', () => {
        const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        expect(src).toMatch(/res\.locals\.fmtPeriodBound\s*=/);
        expect(src).toMatch(/fmtPeriodBound\s*\}\s*=\s*require\('\.\/src\/utils\/dateFormat'\)/);
    });
});

describe('E-13 (classe) — la porte d’écriture de campagne parle la langue du lecteur', () => {
    const CycleService = require('../../src/services/CycleService');

    const gateOf = (code, cycle) => ({ writable: false, code, cycle });

    test('close, verrouillée, annulée : dd/MM/aaaa dans la phrase, jamais l’ISO', () => {
        const cases = [
            [
                gateOf('cycle_write_closed', { id: 2, code: 'UAT-2026', closedAt: '2026-09-01' }),
                '01/09/2026',
                '2026-09-01',
            ],
            [
                gateOf('cycle_write_locked', { id: 9, code: '2026-Q3', closesAt: '2026-08-31' }),
                '31/08/2026',
                '2026-08-31',
            ],
            [
                gateOf('cycle_write_cancelled', {
                    id: 12,
                    code: 'ANNUL',
                    cancelledAt: '2026-07-09',
                }),
                '09/07/2026',
                '2026-07-09',
            ],
        ];
        for (const [gate, shown, iso] of cases) {
            const msg = CycleService.gateMessage(gate);
            expect(msg).toContain(gate.cycle.code);
            expect(msg).toContain(shown);
            expect(msg).not.toContain(iso);
            // ni un jour anglais issu de String(Date), ni « Invalid Date »
            expect(msg).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun|Invalid/);
        }
    });

    test('la même phrase traduite porte la même graphie (parité FR/EN)', () => {
        const gate = gateOf('cycle_write_locked', {
            id: 9,
            code: '2026-Q3',
            closesAt: '2026-08-31',
        });
        const en = require('../../locales/en/admin.json');
        const t = (key, vars) =>
            String(en[key.replace(/^admin:/, '')] || vars.defaultValue).replace(
                /\{\{(\w+)\}\}/g,
                (_, v) => vars[v]
            );
        const msg = CycleService.gateMessage(gate, { t });
        expect(msg).toContain('31/08/2026');
        expect(msg).not.toContain('2026-08-31');
        expect(msg).toMatch(/locked/i);
    });

    test('une date absente ne devient jamais une date inventée', () => {
        const msg = CycleService.gateMessage(
            gateOf('cycle_write_closed', { id: 2, code: 'X', closedAt: null })
        );
        expect(msg).toMatch(/non enregistrée/);
        expect(msg).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });
});
