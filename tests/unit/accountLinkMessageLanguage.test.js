'use strict';
/**
 * LES ISSUES DE « ACCÈS & IDENTITÉ » SE DISAIENT EN ANGLAIS SEULEMENT.
 *
 * CE QUI A ÉTÉ MESURÉ le 16/09/2026, avant correction : AccountLinkService
 * rendait { ok, message } où `message` est une phrase ANGLAISE en dur — 24
 * issues distinctes — et les six écrans qui l'affichent faisaient
 * `req.flash(result.ok ? 'success' : 'error', result.message)`. Une session
 * française lisait donc « That employee is outside your administrative scope. »,
 * « Linked jdoe to the entra identity… », « Employee not found. »
 *
 * LA FORME RETENUE est celle qu'OnboardingService utilise déjà dans ce produit :
 * un CODE stable + ses `params`, `message` restant le dernier recours anglais
 * pour un appelant sans traducteur (script, tâche de fond, test).
 *
 * CE QUE CES TESTS EMPÊCHENT
 *   - qu'une issue reparte à l'écran sans code (donc en anglais) ;
 *   - qu'un code existe sans traduction dans l'UNE des deux langues ;
 *   - qu'une phrase traduite oublie une variable que le service lui passe (ou en
 *     invente une qu'il ne passe pas) — une phrase à trou est pire qu'un refus ;
 *   - que les six appels d'écran reviennent à afficher `result.message`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/AccountLinkService.js'), 'utf8');
const FR = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/admin.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/admin.json'), 'utf8'));

/** Les codes alk_* que le service rend réellement. */
const CODES = [...new Set([...SRC.matchAll(/code:\s*'(alk_[a-z0-9_]+)'/g)].map((m) => m[1]))];

/** Les variables passées avec un code donné, lues sur le même retour. */
function paramsOf(code) {
    const re = new RegExp(`code:\\s*'${code}',\\s*params:\\s*\\{([^}]*)\\}`);
    const m = re.exec(SRC.replace(/\n\s+/g, ' '));
    if (!m) return [];
    return [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
}

describe('accès & identité : chaque issue se dit dans la langue de la personne', () => {
    test('le service rend bien une vingtaine d’issues codées (sinon ce fichier ne mesure rien)', () => {
        expect(CODES.length).toBeGreaterThanOrEqual(20);
    });

    test('chaque code est traduit dans les DEUX catalogues, et réellement traduit', () => {
        const manquants = CODES.filter((c) => !(c in FR) || !(c in EN));
        expect(manquants).toEqual([]);
        for (const c of CODES) {
            expect(typeof FR[c]).toBe('string');
            expect(FR[c].trim()).not.toBe('');
            expect(typeof EN[c]).toBe('string');
            expect(EN[c].trim()).not.toBe('');
            // une recopie mot pour mot de l'anglais n'est pas une traduction
            expect(FR[c]).not.toBe(EN[c]);
        }
    });

    test('chaque phrase porte EXACTEMENT les variables que le service lui passe', () => {
        const ecarts = [];
        for (const c of CODES) {
            const attendus = paramsOf(c).sort();
            for (const [lang, cat] of [
                ['fr', FR],
                ['en', EN],
            ]) {
                const dans = [
                    ...new Set([...cat[c].matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
                ].sort();
                if (JSON.stringify(dans) !== JSON.stringify(attendus)) {
                    ecarts.push(`${lang}:${c} attend [${attendus}] et porte [${dans}]`);
                }
            }
        }
        expect(ecarts).toEqual([]);
    });

    test('aucune issue affichée ne reste sans code', () => {
        // Un retour { ok, message } SANS code repartirait en anglais à l'écran.
        // Seuls les relais d'exception (message: e.message) en sont dispensés.
        const sansCode = [];
        const plat = SRC.replace(/\n\s+/g, ' ');
        for (const m of plat.matchAll(/\{\s*ok:\s*(?:true|false),\s*message:\s*([^}]+)\}/g)) {
            if (!/e\.message/.test(m[1])) sansCode.push(m[0].slice(0, 80));
        }
        expect(sansCode).toEqual([]);
    });

    test('`message` reste le dernier recours anglais, il n’a pas été supprimé', () => {
        const plat = SRC.replace(/\n\s+/g, ' ');
        const sansPhrase = [];
        for (const c of CODES) {
            const at = plat.indexOf(`code: '${c}'`);
            // la phrase de repli se trouve dans le MÊME objet rendu, donc juste après
            if (at === -1 || !/\bmessage:/.test(plat.slice(at, at + 400))) sansPhrase.push(c);
        }
        expect(sansPhrase).toEqual([]);
    });

    test('les six écrans affichent le CODE traduit, plus la phrase du service', () => {
        const sites = [
            'src/controllers/EmployeeController.js',
            'src/controllers/AdminController.js',
        ];
        let rendus = 0;
        for (const f of sites) {
            const s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
            rendus +=
                s.split(
                    'result.code && req.t ? req.t(`admin:${result.code}`, result.params || {}) : result.message'
                ).length - 1;
            // l'ancienne forme, celle qui affichait l'anglais, ne doit pas revenir
            expect(s).not.toContain("req.flash(result.ok ? 'success' : 'error', result.message)");
        }
        expect(rendus).toBe(6);
    });
});
