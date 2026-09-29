'use strict';
/**
 * LIMITE DE POSTES — la seule phrase de refus du produit qui sortait en ANGLAIS
 * sur un écran français.
 *
 * CE QUI A ÉTÉ MESURÉ le 16/09/2026, avant correction :
 *   - EntitlementService.canAddEmployee() rendait { ok:false, reason:"Seat limit
 *     reached (2/2). Increase the licensed seats or deactivate an employee." } —
 *     une phrase anglaise EN DUR ;
 *   - EmployeeController.create affichait `seatGate.reason` EN PRIORITÉ, donc
 *     cette phrase-là, quelle que soit la langue de la session ;
 *   - la clé de repli citée juste à côté, `flash:seat_limit_reached`, n'existait
 *     dans AUCUN des deux catalogues : interrogée, i18next rendait le nom brut de
 *     la clé, « seat_limit_reached », en fr COMME en en.
 *
 * CE QUE CES TESTS EMPÊCHENT
 *   - que le service reperde la clé traduisible (et donc que l'écran reperde le
 *     français) ;
 *   - que la clé disparaisse d'un seul des deux catalogues, ou perde une de ses
 *     deux variables ;
 *   - que le contrôleur revienne à afficher la phrase du service en premier.
 */
const fs = require('fs');
const path = require('path');

let settings;
const mockDb = { get: jest.fn() };
const mockSettings = { getValue: jest.fn((k, d) => (k in settings ? settings[k] : d)) };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const svc = require('../../src/services/EntitlementService');
const ROOT = path.join(__dirname, '../..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const FR = readJson('locales/fr/flash.json');
const EN = readJson('locales/en/flash.json');

beforeEach(() => {
    settings = {
        license: JSON.stringify({ customer: 'ACME', seats: 2 }),
        enforceSeatLimit: 'true',
    };
    mockDb.get.mockReset();
    mockDb.get.mockResolvedValue({ n: 2 });
    svc.invalidate();
    delete process.env.LICENSE_JSON;
});

describe('la limite de postes se dit dans la langue de la personne', () => {
    test('le refus porte une CLÉ et ses variables, pas seulement une phrase anglaise', async () => {
        const g = await svc.canAddEmployee();
        expect(g.ok).toBe(false);
        expect(g.reasonKey).toBe('flash:seat_limit_reached');
        expect(g.reasonVars).toEqual({ used: 2, seats: 2 });
        // La phrase anglaise reste pour un appelant sans requête (script, tâche).
        expect(g.reason).toMatch(/seat limit/i);
    });

    test('la clé existe dans les DEUX catalogues, avec ses deux variables', () => {
        for (const [lang, cat] of [
            ['fr', FR],
            ['en', EN],
        ]) {
            expect(Object.prototype.hasOwnProperty.call(cat, 'seat_limit_reached')).toBe(true);
            const v = cat.seat_limit_reached;
            expect(typeof v).toBe('string');
            expect(v.trim()).not.toBe('');
            expect(v).toContain('{{used}}');
            expect(v).toContain('{{seats}}');
            // et elle est bien TRADUITE, pas recopiée d'une langue à l'autre
            if (lang === 'fr') expect(v).not.toBe(EN.seat_limit_reached);
        }
    });

    test('le français est du français, l’anglais est de l’anglais', () => {
        expect(FR.seat_limit_reached).toMatch(/postes/i);
        expect(EN.seat_limit_reached).toMatch(/seats/i);
    });

    test('le contrôleur traduit la clé quand il a un traducteur, et ne préfère plus la phrase du service', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/controllers/EmployeeController.js'),
            'utf8'
        );
        const oneLine = src.replace(/\s+/g, ' ');
        expect(oneLine).toContain('req.t(seatGate.reasonKey, seatGate.reasonVars || {})');
        // l'ancienne forme — la phrase anglaise d'abord — ne doit pas revenir
        expect(oneLine).not.toContain(
            "seatGate.reason || (req.t ? req.t('flash:seat_limit_reached')"
        );
    });

    test('le chemin autorisé ne fabrique aucun refus', async () => {
        mockDb.get.mockResolvedValue({ n: 1 });
        svc.invalidate();
        const g = await svc.canAddEmployee();
        expect(g.ok).toBe(true);
        expect(g.reasonKey).toBeUndefined();
    });
});
