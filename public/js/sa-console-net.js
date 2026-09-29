/**
 * sa-console-net.js — DISCIPLINE DE RÉSEAU ET DE REFUS DE LA CONSOLE DE REVUE.
 *
 * CE QUI ÉTAIT CASSÉ (mesuré sur une base de développement, session de superviseur
 * réelle, décision « Approuver ») :
 *
 *  1. L'assistant api de la console envoyait `Content-Type: application/json` et
 *     RIEN d'autre. Une session inactive depuis plus d'une heure fait répondre au
 *     serveur `302 → /login?expired=1` ; fetch SUIT la redirection, la page de
 *     connexion arrive en `200 text/html`, `r.ok` vaut donc `true`, `r.json`
 *     échoue et était avalé en `{}`. L'écran annonçait « Terminé » sur une
 *     décision QUE PERSONNE N'AVAIT ENREGISTRÉE (workflow_state inchangé en base).
 *     Un produit qui ment sur un acte est pire qu'un produit qui échoue.
 *  2. Tout refus (403 / 404 / 500) ne laissait qu'un message fugace de 6 secondes
 *     — en anglais pour le 403 des gardes — pendant que la zone de la file gardait
 *     « Chargement… » pour toujours.
 *  3. Le compteur décoratif du haut et la file étaient dans le MÊME Promise.all :
 *     un refus sur le compteur emportait la file entière.
 *  4. La console se filtrait d'office sur la première campagne en cours, y compris
 *     VERROUILLÉE, et masquait tout ce qui était hors campagne.
 *
 * CE QUE CE MODULE GARANTIT
 *  - Une réponse REDIRIGÉE, une réponse non-JSON, un 401/440 : ÉCHEC, jamais un
 *    succès. `api` rejette, il ne rend jamais un objet vide qui passe pour une
 *    réponse valide.
 *  - Tout refus porte une phrase du catalogue, dans la langue de la page.
 *    La phrase du serveur n'est reprise que lorsqu'elle vient de la famille de
 *    contrôleurs qui la traduit déjà (marqueur structurel `success:false` posé par
 *    utils/apiErrors), jamais celle d'une garde qui répond en anglais.
 *  - Un acte n'est annoncé « fait » que si le serveur a renvoyé la preuve
 *    (`confirmed`), jamais sur la seule absence d'erreur.
 *  - Aucune pré-sélection de campagne que l'utilisateur n'a pas demandée.
 *
 * Tout est exposé en fonctions pures testables : tests/unit/saConsoleRefusals.test.js.
 * (Ce chemin-là est VÉRIFIÉ : l'en-tête nommait auparavant une suite « saConsoleNet »
 * que l'arbre n'a jamais portée — `ls` répondait « No such file or directory ».
 * Une source qui promet plus que l'arbre ne tient, et que rien n'épingle, c'est
 * le constat n°15 du dossier. Un test de cohérence exige désormais que TOUT
 * chemin `tests/…test.js` cité dans public/js/ existe réellement.)
 */
(function (root) {
    'use strict';
    if (root.SAConsoleNet) {
        // Déjà chargé (double inclusion, ou re-require sous Jest) : on réexporte
        // l'instance en place plutôt que de rendre un objet vide.
        if (typeof module !== 'undefined' && module.exports) module.exports = root.SAConsoleNet;
        return;
    }

    /** Catalogue de la page (posé par la vue depuis les fichiers locales/). */
    var T = {};

    /** Phrases de repli — le module reste lisible si la vue oublie un libellé. */
    var FALLBACK = {
        err_session: 'Votre session a expiré — reconnectez-vous.',
        err_forbidden: 'Accès refusé : cet élément est hors de votre périmètre.',
        err_notfound: 'Élément introuvable.',
        err_server: 'Le serveur a rencontré une erreur. Réessayez.',
        err_http: 'La requête a échoué (code {code}).',
        err_ref: ' (réf. {id})',
        err_network: 'Le serveur est injoignable. Vérifiez votre connexion.',
        err_format:
            'Réponse inattendue du serveur : une page a été renvoyée à la place des données.',
        load_failed: 'La file de revue n’a pas pu être chargée.',
        pending_failed: 'La liste des personnes attendues n’a pas pu être chargée.',
        retry: 'Réessayer',
        relogin: 'Se reconnecter',
    };

    function fmt(s, vars) {
        return String(s).replace(/\{(\w+)\}/g, function (m, k) {
            return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
        });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var NET = {
        /** Pose le catalogue de la page (clés courtes : err_session, retry, …). */
        configure: function (i18n) {
            T = i18n || {};
            return this;
        },
        /** Libellé du catalogue, repli interne si la clé manque. */
        t: function (key, vars) {
            var s = (T && T[key]) || FALLBACK[key] || key;
            return fmt(s, vars);
        },
        /** Seam de navigation — remplaçable en test. */
        navigate: function (url) {
            if (root.location) root.location.href = url;
        },

        /** La réponse porte-t-elle vraiment du JSON ? */
        isJson: function (r) {
            if (!r || !r.headers || typeof r.headers.get !== 'function') return false;
            return String(r.headers.get('content-type') || '').indexOf('json') > -1;
        },

        /**
         * Code stable décrivant une réponse. UNE redirection est un ÉCHEC : sur ces
         * routes JSON elle ne peut être que la page de connexion.
         * @returns {'ok'|'session'|'forbidden'|'notfound'|'server'|'format'|'http'|'network'}
         */
        classify: function (r) {
            if (!r) return 'network';
            if (r.redirected === true || r.type === 'opaqueredirect') return 'session';
            var s = Number(r.status || 0);
            if (s === 0) return 'network';
            if (s >= 300 && s < 400) return 'session';
            if (s === 401 || s === 440) return 'session';
            if (s === 403) return 'forbidden';
            if (s === 404) return 'notfound';
            if (s >= 500) return 'server';
            if (s >= 200 && s < 300) return this.isJson(r) ? 'ok' : 'format';
            return 'http';
        },

        /**
         * La phrase à afficher, et POURQUOI ce tri-là.
         *
         * Un refus MÉTIER est déjà écrit dans la langue de la page par le serveur
         * (utils/apiErrors.sayError, ou un contrôleur qui appelle req.t) et il est
         * plus précis que n'importe quelle phrase générique : on le garde mot pour
         * mot. On le reconnaît à un MARQUEUR DE STRUCTURE — `success:false`
         * (famille apiErrors), `ok:false` (gardes de type de compte) ou un `code`
         * stable (contestations, maker-checker) — ou à un statut que seules les
         * règles métier produisent (400/409/422).
         *
         * Une garde de middleware, elle, répond `{error: "Access denied. Manager or
         * admin privileges required."}` : ni marqueur, ni traduction. C'est cette
         * phrase-là, et elle seule, que l'on remplace par le catalogue — un écran
         * français n'affiche pas un refus en anglais. Test de structure, jamais
         * liste noire de messages : une nouvelle phrase du serveur marche sans
         * qu'on touche à ce fichier.
         */
        pickMessage: function (code, body, status) {
            if (code === 'session') return this.t('err_session');
            var s = Number(status || 0);
            var marked = Boolean(
                body &&
                (body.success === false || body.ok === false || typeof body.code === 'string')
            );
            var domainStatus = s === 400 || s === 409 || s === 422;
            if (
                body &&
                typeof body.error === 'string' &&
                body.error.trim() &&
                (marked || domainStatus)
            ) {
                var msg = body.error.trim();
                // La référence d'incident ne doit pas disparaître avec le toast — et
                // elle se lit dans la langue de la page. Mesure de l'intégrateur,
                // 16/09/2026 : ce fragment était le SEUL du module écrit en dur, donc
                // une page anglaise affichait « A technical error occurred. (réf. abc123) ».
                // Un mot français dans un écran anglais : la parité FR/EN se rompt aussi
                // par un fragment de phrase.
                if (body.requestId) msg += this.t('err_ref', { id: body.requestId });
                return msg;
            }
            if (code === 'forbidden') return this.t('err_forbidden');
            if (code === 'notfound') return this.t('err_notfound');
            if (code === 'server') return this.t('err_server');
            if (code === 'format') return this.t('err_format');
            if (code === 'network') return this.t('err_network');
            return this.t('err_http', { code: status == null ? '?' : status });
        },

        /** Erreur normalisée : message lisible + code stable + statut HTTP. */
        fail: function (code, body, status) {
            var e = new Error(this.pickMessage(code, body, status));
            e.code = code;
            e.status = status == null ? 0 : status;
            e.body = body || null;
            return e;
        },

        /**
         * Appel JSON de la console. Rejette sur TOUT ce qui n'est pas une réponse
         * JSON 2xx non redirigée.
         */
        api: function (path, method, body) {
            var self = this;
            var opts = {
                method: method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    // Sans Accept, le serveur renvoyait 302 vers /login à un appel JSON.
                    Accept: 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
            };
            if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
            return Promise.resolve()
                .then(function () {
                    return root.fetch(path, opts);
                })
                .catch(function () {
                    throw self.fail('network', null, 0);
                })
                .then(function (r) {
                    var code = self.classify(r);
                    if (!self.isJson(r)) {
                        if (code === 'ok') code = 'format';
                        throw self.fail(code, null, r && r.status);
                    }
                    return Promise.resolve(r.json())
                        .catch(function () {
                            return null;
                        })
                        .then(function (payload) {
                            if (code === 'ok') return payload || {};
                            throw self.fail(code, payload, r.status);
                        });
                });
        },

        /**
         * `api` PLUS la convention historique des consoles de la gamme : un 200
         * qui porte `ok:false` (ou `success:false`) est un REFUS, pas une réussite.
         *
         * Les neuf écrans convertis le 16/09/2026 (coaching, 9-box, PIP, LMS,
         * continuité, clés d'API, cadre de compétences, mon accompagnement, état de
         * mon évaluation) portaient CHACUN sa copie de
         * `if(!r.ok||j.ok===false){alert(j.error||('HTTP '+r.status));throw …}`,
         * et chacune de ces copies avalait `r.json` en `{}`. La règle vit
         * désormais ici, une seule fois, et les pages l'APPELLENT.
         */
        call: function (path, method, body) {
            var self = this;
            return this.api(path, method, body).then(function (json) {
                if (json && (json.ok === false || json.success === false)) {
                    throw self.fail('http', json, 200);
                }
                return json;
            });
        },

        /**
         * Un acte n'est « fait » que si le serveur en a renvoyé la preuve.
         * `{}` — ce que rendait l'ancien `r.json.catch(=>({}))` — n'en est pas une.
         */
        confirmed: function (json, key) {
            if (!json || typeof json !== 'object') return false;
            if (json.success === false) return false;
            return json[key] !== undefined && json[key] !== null;
        },

        /**
         * La campagne pré-sélectionnée. UNIQUEMENT celle que l'URL demande : la
         * console ne se filtre jamais toute seule (une campagne verrouillée et
         * échue masquait toute la file sans que personne l'ait choisie).
         */
        preselectedCycle: function (search, cycles) {
            var want = '';
            try {
                want = new root.URLSearchParams(String(search || '')).get('cycleId') || '';
            } catch (_) {
                want = '';
            }
            if (!want) return '';
            var list = cycles || [];
            for (var i = 0; i < list.length; i++) {
                if (String(list[i] && list[i].id) === String(want)) return String(want);
            }
            return '';
        },

        /**
         * Résultat d'un Promise.allSettled : l'ORNEMENT ne doit jamais emporter
         * l'ESSENTIEL. Rend {value, error} par appel, indépendamment.
         */
        settled: function (results) {
            return (results || []).map(function (r) {
                if (r && r.status === 'fulfilled') return { value: r.value, error: null };
                return { value: null, error: (r && r.reason) || new Error('unknown') };
            });
        },

        /**
         * Le refus ÉCRIT DANS LA ZONE concernée — un bandeau qui s'efface au bout de
         * six secondes n'est pas une information. `zone` nomme l'action à relancer.
         */
        failureCard: function (err, zone, titleKey) {
            var code = (err && err.code) || 'http';
            var msg = (err && err.message) || this.t('err_http', { code: '?' });
            var action =
                code === 'session'
                    ? '<a class="btn btn-sm btn-primary" href="/login?expired=1">' +
                      esc(this.t('relogin')) +
                      '</a>'
                    : '<button type="button" class="btn btn-sm" data-sa-retry="' +
                      esc(zone || '') +
                      '">' +
                      esc(this.t('retry')) +
                      '</button>';
            return (
                '<div class="card" style="padding:1rem" role="alert" data-sa-error="' +
                esc(code) +
                '">' +
                '<strong>' +
                esc(this.t(titleKey || 'load_failed')) +
                '</strong>' +
                '<p style="margin:.4rem 0">' +
                esc(msg) +
                '</p>' +
                action +
                '</div>'
            );
        },

        /** Même chose, en une seule cellule de tableau. */
        failureRow: function (err, zone, colspan, titleKey) {
            return (
                '<tr><td colspan="' +
                Number(colspan || 1) +
                '">' +
                this.failureCard(err, zone, titleKey) +
                '</td></tr>'
            );
        },

        escapeHtml: esc,
    };

    root.SAConsoleNet = NET;
    if (typeof module !== 'undefined' && module.exports) module.exports = NET;
})(typeof window !== 'undefined' ? window : globalThis);
