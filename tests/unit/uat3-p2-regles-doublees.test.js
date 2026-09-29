'use strict';

// =====================================================================
//  LOT UAT3 « règles doublées » — P2-05 et P2-06 (comité du 15/09/2026)
// =====================================================================
//
//  CE QUI AVAIT CASSÉ, P2-05 : la règle A5 « une campagne close se rouvre
//  pendant 30 jours » était calculée DEUX fois, et les deux réponses ne
//  disaient pas la même chose.
//    · le SERVEUR (`CycleService.reopenClosed`) comptait des jours CALENDAIRES
//      UTC et acceptait la dérogation jusqu'au 30e jour inclus ;
//    · l'ÉCRAN (`CycleController`) comptait des MILLISECONDES
//      (`Math.floor((Date.now() - closedAt) / 86400000)`) et en déduisait un
//      « jours restants ». Mesuré sur la campagne 73, clôture reculée de
//      29 j 23 h puis de 30 j : la page retirait le bouton
//      `cyc-reopen-closed` — le SEUL point d'entrée de l'acte, il n'y en a pas
//      d'autre au panneau de maintenance — et affirmait « le délai de 30 jours
//      est écoulé », alors que `reopenClosed()` rendait au même instant
//      `{reopened:true, daysSinceClose:30}` et passait la campagne à `open`.
//      Et dans l'autre sens, à 29 j 23 h, elle annonçait « encore 1 jour »
//      quand le compte calendaire valait déjà 30.
//
//  CE QUE CES TESTS EMPÊCHENT : qu'un second calcul de ce délai réapparaisse
//  quelque part. Ils ne vérifient pas « 30 est le bon chiffre » — ils
//  vérifient que l'écran et le serveur donnent la MÊME réponse, jour par jour,
//  parce qu'un seul endroit décide (`CycleService.reopenWindow`). Le jour où
//  quelqu'un recalcule le délai « juste pour l'affichage », la suite vire au
//  rouge avant l'utilisateur.
//
//  CE QUI AVAIT CASSÉ, P2-06 : les trois signalements de campagne (verrouillage,
//  proposition de clôture, retard hebdomadaire) réemploient à dessein le même
//  kind `cycle.escalation`. La boîte du super-administrateur affichait donc SIX
//  lignes rigoureusement identiques — « Revues à finaliser » — venues de DEUX
//  campagnes différentes : le libellé ne disait ni laquelle, ni ce qui venait
//  d'arriver. Le mécanisme n'a pas été refait (même kind, même ledger, même
//  cadence, même lien) : seul le libellé gagne un complément, construit à la
//  LECTURE (jamais figé en base, sinon la phrase serait gelée dans la langue de
//  l'émetteur) et fourni en FR comme en EN.
//
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn(async () => ({ inapp: 'ok' })),
    enqueueBulkInApp: jest.fn(async () => 0),
}));

const CycleService = require('../../src/services/CycleService');
const N = jest.requireActual('../../src/services/NotificationService');

const SUPER = { userType: 'admin', role: 'superadmin', id: 666, username: 'uat.admin' };
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ROOT = path.join(__dirname, '..', '..');

/** Une campagne close il y a `days` jours CALENDAIRES, à 9 h UTC. */
const closedDaysAgo = (days) => ({
    id: 6,
    code: 'UAT-RERUN',
    status: 'closed',
    closedAt: new Date(
        `${new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)}T09:00:00Z`
    ),
    closesAt: new Date('2026-12-31T00:00:00Z'),
});

beforeEach(() => {
    [mockDb.get, mockDb.all, mockDb.run].forEach((m) => m.mockReset());
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1, lastID: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
});

// =====================================================================
//  P2-05 — une seule horloge
// =====================================================================
describe('P2-05 — la fenêtre de réouverture n’est calculée qu’à UN endroit', () => {
    test('jour par jour, de 0 à 33 : ce que l’écran affiche EST ce que le serveur fera', async () => {
        const desaccords = [];
        for (let d = 0; d <= 33; d++) {
            const cycle = closedDaysAgo(d);
            // Ce que l'écran lit (la seule décision).
            const vue = CycleService.reopenWindow(cycle);
            // Ce que le serveur fait vraiment, sur la même campagne.
            mockDb.get.mockResolvedValue(cycle);
            mockDb.run.mockResolvedValue({ changes: 1, lastID: 1 });
            const accepte = await CycleService.reopenClosed(
                6,
                { closesAt: inDays(20), reason: `jour ${d}` },
                SUPER
            )
                .then(() => true)
                .catch((e) => {
                    if (e.code !== 'cycle_reopen_window_expired') throw e;
                    return false;
                });
            if (vue.canReopen !== accepte)
                desaccords.push(`J+${d} : écran=${vue.canReopen}, serveur=${accepte}`);
        }
        expect(desaccords).toEqual([]);
    });

    test('le 30e jour est DANS la fenêtre (A5) et il reste un dernier jour, pas zéro', () => {
        const w30 = CycleService.reopenWindow(closedDaysAgo(30));
        expect(w30).toMatchObject({
            canReopen: true,
            daysSinceClose: 30,
            daysLeft: 0,
            lastDay: true,
            refusal: null,
        });
        const w29 = CycleService.reopenWindow(closedDaysAgo(29));
        expect(w29).toMatchObject({ canReopen: true, daysLeft: 1, lastDay: false });
        const w31 = CycleService.reopenWindow(closedDaysAgo(31));
        expect(w31).toMatchObject({ canReopen: false, refusal: 'cycle_reopen_window_expired' });
    });

    test('une clôture SANS date n’est pas « il y a 0 jour » : refus, et aucun chiffre inventé', () => {
        const w = CycleService.reopenWindow({ id: 2, status: 'closed', closedAt: null });
        expect(w.canReopen).toBe(false);
        expect(w.daysSinceClose).toBeNull();
        expect(w.daysLeft).toBeNull();
        expect(w.refusal).toBe('cycle_closed_at_unknown');
    });

    test('une campagne qui n’est pas close n’a pas de fenêtre du tout', () => {
        for (const status of ['open', 'locked', 'draft', 'cancelled']) {
            expect(CycleService.reopenWindow({ id: 1, status }).canReopen).toBe(false);
            expect(CycleService.reopenWindow({ id: 1, status }).applicable).toBe(false);
        }
    });

    // L'HEURE de clôture ne doit plus changer la réponse : c'était elle qui
    // faisait diverger les deux horloges (29 j 23 h → 29 côté millisecondes,
    // 30 côté calendaire).
    test('deux clôtures du MÊME jour, à 00:05 et à 23:55, donnent la même décision', () => {
        const jour = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const tot = CycleService.reopenWindow({
            id: 6,
            status: 'closed',
            closedAt: new Date(`${jour}T00:05:00Z`),
        });
        const tard = CycleService.reopenWindow({
            id: 6,
            status: 'closed',
            closedAt: new Date(`${jour}T23:55:00Z`),
        });
        expect(tot.canReopen).toBe(tard.canReopen);
        expect(tot.daysSinceClose).toBe(tard.daysSinceClose);
    });

    test('le contrôleur ne recalcule plus le délai : il n’y a plus de seconde horloge dans la console', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src', 'controllers', 'CycleController.js'),
            'utf8'
        );
        // Le calcul fautif, sous toutes ses formes : une division par un nombre
        // de millisecondes appliquée à la date de clôture.
        const lignes = src
            .split('\n')
            .map((l, i) => [i + 1, l])
            .filter(([, l]) => /closedAt/.test(l) && /86400000|REOPEN_CLOSED_WINDOW_DAYS/.test(l));
        expect(lignes).toEqual([]);
        // Et il lit bien la décision du service.
        expect(src).toMatch(/CycleService\.reopenWindow\(/);
    });
});

describe('P2-05 — l’écran obéit à la décision, pas à un décompte', () => {
    // Le VRAI bloc de la vue livrée, découpé dans le fichier : si quelqu'un
    // remet une condition de décompte à la place de la décision, ce test tombe.
    const bloc = (() => {
        const v = fs.readFileSync(path.join(ROOT, 'views', 'pages', 'cycles', 'show.ejs'), 'utf8');
        const a = v.indexOf("<% if (cycle.status === 'closed') { %>");
        const b = v.indexOf('<% } else if (cycle.reopenOverrideAt) { %>');
        return `${v.slice(a, b)}<% } %>`;
    })();
    const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'fr', 'admin.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en', 'admin.json'), 'utf8'));
    const rendre = (cycle, dict) =>
        ejs.render(bloc, {
            cycle,
            canLaunch: true,
            fmtDate: (d) => String(d || '').slice(0, 10),
            __: (k, vars) => {
                const key = String(k).replace(/^admin:/, '');
                let s = dict[key];
                if (s == null) return `MANQUE:${key}`;
                for (const [n2, v2] of Object.entries(vars || {}))
                    s = s.split(`{{${n2}}}`).join(String(v2));
                return s;
            },
        });
    const vue = (cycle) => {
        const w = CycleService.reopenWindow(cycle);
        return {
            ...cycle,
            canReopenClosed: w.canReopen,
            reopenWindowLastDay: w.lastDay,
            reopenWindowDays: w.daysLeft,
            reopenWindowTotal: w.windowDays,
        };
    };

    test('DERNIER JOUR (jours restants = 0) : le bouton est là — c’était LE défaut', () => {
        const html = rendre(vue(closedDaysAgo(30)), fr);
        expect(html).toContain('id="cyc-reopen-closed"');
        expect(html).not.toContain('MANQUE:');
        expect(html).toContain('Dernier jour');
        // La phrase qui mentait ne doit pas apparaître tant que l'acte est possible.
        expect(html).not.toContain('est écoulé');
    });

    test('hors délai : pas de bouton, et la phrase dit pourquoi', () => {
        const html = rendre(vue(closedDaysAgo(31)), fr);
        expect(html).not.toContain('id="cyc-reopen-closed"');
        expect(html).toContain('est écoulé');
    });

    test('date de clôture inconnue : pas de bouton, pas de « 0 jour »', () => {
        const html = rendre(vue({ id: 2, code: 'X', status: 'closed', closedAt: null }), fr);
        expect(html).not.toContain('id="cyc-reopen-closed"');
        expect(html).not.toContain('MANQUE:');
    });

    test('parité FR/EN : les trois phrases de la fenêtre existent des deux côtés', () => {
        for (const cle of [
            'cyc_reopen_window_left',
            'cyc_reopen_window_last_day',
            'cyc_reopen_window_none',
        ]) {
            expect(typeof fr[cle]).toBe('string');
            expect(typeof en[cle]).toBe('string');
            expect(fr[cle]).not.toBe(en[cle]);
        }
        expect(rendre(vue(closedDaysAgo(30)), en)).not.toContain('MANQUE:');
        expect(rendre(vue(closedDaysAgo(31)), en)).not.toContain('MANQUE:');
    });
});

// =====================================================================
//  P2-06 — le signalement nomme la campagne
// =====================================================================
describe('P2-06 — « Revues à finaliser » dit MAINTENANT de quelle campagne il parle', () => {
    const ligne = (payload) => ({
        id: 1,
        kind: 'cycle.escalation',
        payload: JSON.stringify(payload),
        read_at: null,
        created_at: new Date('2026-09-15T10:52:25Z'),
    });

    test('les trois transitions d’une même campagne ne rendent plus le MÊME libellé', () => {
        const base = { link: '/cycles/73', cycleId: 73, cycle: 'UAT3C-CLOSURE' };
        const titres = [
            { ...base, stage: 'locked', closesOn: '2026-08-16' },
            { ...base, stage: 'closure_proposed', proposalId: 4, overdueDays: 30 },
            { ...base, stage: 'overdue', overdueDays: 30, proposalPending: true },
        ].map((p) => N.present(ligne(p), 'fr').title);
        expect(new Set(titres).size).toBe(3);
        for (const t of titres) expect(t).toContain('UAT3C-CLOSURE');
    });

    test('deux campagnes différentes ne rendent plus la même ligne', () => {
        const a = N.present(
            ligne({
                link: '/cycles/73',
                cycle: 'UAT3C-CLOSURE',
                stage: 'overdue',
                overdueDays: 30,
            }),
            'fr'
        ).title;
        const b = N.present(
            ligne({ link: '/cycles/9', cycle: '2026-Q3', stage: 'overdue', overdueDays: 14 }),
            'fr'
        ).title;
        expect(a).not.toBe(b);
        expect(b).toContain('2026-Q3');
    });

    test('FR et EN, dans le même geste — et jamais une phrase figée en base', () => {
        const p = {
            link: '/cycles/73',
            cycle: 'UAT3C-CLOSURE',
            stage: 'closure_proposed',
            overdueDays: 30,
        };
        const fr = N.present(ligne(p), 'fr').title;
        const en = N.present(ligne(p), 'en').title;
        expect(fr).toContain('campagne');
        expect(en).toContain('campaign');
        expect(fr).not.toBe(en);
        // La MÊME ligne stockée rend les deux langues : rien n'est gelé au moment de l'envoi.
        expect(fr).toContain('UAT3C-CLOSURE');
        expect(en).toContain('UAT3C-CLOSURE');
    });

    test('le mécanisme n’a pas bougé : kind, lien et icône sont inchangés', () => {
        const p = { link: '/cycles/73', cycle: 'UAT3C-CLOSURE', stage: 'overdue' };
        const v = N.present(ligne(p), 'fr');
        expect(v.kind).toBe('cycle.escalation');
        expect(v.link).toBe('/cycles/73');
        expect(v.icon).toBe(N.KIND_META['cycle.escalation'].icon);
        expect(v.title.startsWith(N.KIND_META['cycle.escalation'].title.fr)).toBe(true);
    });

    test('un payload SANS campagne garde exactement le libellé d’avant', () => {
        expect(N.present(ligne({}), 'fr').title).toBe('Revues à finaliser');
        expect(N.present(ligne({ stage: 'overdue' }), 'en').title).toBe('Reviews to finalize');
        // …et les autres kinds ne sont pas touchés du tout.
        expect(N.present({ id: 2, kind: 'cycle.reminder', payload: '{}' }, 'fr').title).toBe(
            N.KIND_META['cycle.reminder'].title.fr
        );
    });

    test('le complément n’est pas un motif : `withReason:false` fait taire le motif, pas la campagne', () => {
        const p = {
            cycle: 'UAT3C-CLOSURE',
            stage: 'overdue',
            reason: 'Saisie faite sur le mauvais collaborateur.',
        };
        const avecMotif = N.present(ligne(p), 'fr').title;
        const sansMotif = N.present(ligne(p), 'fr', { withReason: false }).title;
        expect(avecMotif).toContain('mauvais collaborateur');
        expect(sansMotif).not.toContain('mauvais collaborateur');
        expect(sansMotif).toContain('UAT3C-CLOSURE');
    });

    test('le sujet d’e-mail nomme la campagne, et reste celui d’avant sans payload', () => {
        const sujet = N._subjectFor('cycle.escalation', 'fr', 'IDevelop', {
            cycle: 'UAT3C-CLOSURE',
            stage: 'closure_proposed',
        });
        expect(sujet).toContain('UAT3C-CLOSURE');
        expect(N._subjectFor('cycle.escalation', 'fr', 'IDevelop')).toBe(
            'IDevelop — Revues à finaliser'
        );
    });

    test('un payload hostile ne casse ni ne déborde le libellé', () => {
        const long = N.present(ligne({ cycle: 'X'.repeat(400), stage: 'overdue' }), 'fr').title;
        expect(long.length).toBeLessThan(200);
        const sale = N.present(ligne({ cycle: 'A\nB\tC', stage: 'overdue' }), 'fr').title;
        expect(sale).not.toMatch(/[\n\t]/);
        expect(() =>
            N.present(ligne({ cycle: { méchant: true }, stage: 'overdue' }), 'fr')
        ).not.toThrow();
    });
});
