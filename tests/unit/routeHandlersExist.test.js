'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AUCUNE ROUTE NE DOIT CITER UNE MÉTHODE DE CONTRÔLEUR QUI N'EXISTE PAS.
 *
 * CE QUI EST DÉJÀ ARRIVÉ (lot admin du 10/09/2026) : un lot interrompu a laissé
 * cinq méthodes de contrôleur inexistantes liées dans les routes. L'arbre NE
 * DÉMARRAIT PLUS — `Route.get() requires a callback function but got [object
 * Undefined]` — et AUCUN test ne l'a vu : la suite était verte, parce que rien
 * ne chargeait les routeurs.
 *
 * CE QUE CE FICHIER ÉPINGLE, et pourquoi en deux temps :
 *   1. chaque routeur se CHARGE. C'est la moitié qu'Express vérifie lui-même :
 *      lier `undefined` lève à la liaison, donc au require. C'est exactement le
 *      démarrage du serveur, joué ici sans base ;
 *   2. chaque membre `Module.membre` CITÉ dans un routeur existe réellement sur
 *      le module require(). C'est la moitié qu'Express ne voit PAS : une méthode
 *      appelée dans le CORPS d'un gestionnaire (`(req,res) => Ctrl.absente(...)`)
 *      se lie sans broncher et n'explose qu'au clic de l'utilisateur.
 *
 * Mesure du 16/09/2026 sur l'arbre : 15 routeurs, 578 membres cités, 0 absent.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const DIR = path.join(ROOT, 'src', 'routes');
const ROUTERS = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));

/** `const X = require('...')` — les seules liaisons qu'un routeur utilise. */
function requiresOf(src) {
    const out = new Map();
    const RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'([^']+)'\s*\)\s*;/g;
    let m;
    while ((m = RE.exec(src))) out.set(m[1], m[2]);
    return out;
}

/** Les membres cités sous la forme `Nom.membre` dans le texte du routeur. */
function membersUsed(src, name) {
    const RE = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
    const out = new Set();
    let m;
    while ((m = RE.exec(src))) out.add(m[1]);
    return [...out];
}

describe('les routes ne peuvent pas citer un gestionnaire absent', () => {
    test('la liste des routeurs n’est pas vide (sinon ce fichier ne mesure rien)', () => {
        expect(ROUTERS.length).toBeGreaterThanOrEqual(10);
    });

    test.each(ROUTERS)('%s se charge — c’est le démarrage du serveur, sans base', (f) => {
        expect(() => require(path.join(DIR, f))).not.toThrow();
    });

    test('chaque méthode de contrôleur/service citée par un routeur existe vraiment', () => {
        const manquantes = [];
        let cites = 0;
        for (const f of ROUTERS) {
            const src = fs.readFileSync(path.join(DIR, f), 'utf8');
            for (const [name, spec] of requiresOf(src)) {
                if (!/controllers|services|models|middleware/.test(spec)) continue;
                const mod = require(path.resolve(DIR, spec));
                for (const membre of membersUsed(src, name)) {
                    cites++;
                    const present =
                        mod != null &&
                        (membre in mod ||
                            (mod.prototype && membre in mod.prototype) ||
                            typeof mod[membre] !== 'undefined');
                    if (!present) manquantes.push(`${f}: ${name}.${membre} → ${spec}`);
                }
            }
        }
        // Un zéro ne vaut que si quelque chose a été mesuré.
        expect(cites).toBeGreaterThan(300);
        expect(manquantes).toEqual([]);
    });
});
