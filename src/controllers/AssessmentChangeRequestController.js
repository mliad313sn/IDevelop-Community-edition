'use strict';
/**
 * AssessmentChangeRequestController — la demande de modification, des DEUX côtés.
 *
 * Une seule page, `/assessment-changes` : le demandeur y voit ses demandes et leur
 * issue, le décideur y voit sa file. C'est la même règle vue des deux bouts, donc
 * le même écran — et personne n'a besoin de savoir quel écran est « le sien ».
 *
 * Les autorisations sont tenues par le service (il résout l'autorité sur la
 * personne concernée) ; ces poignées ne font que traduire. Même discipline JSON
 * que les autres contrôleurs de ce domaine (`utils/apiErrors`) : les erreurs
 * métier gardent leur phrase et leur statut, les fautes techniques deviennent une
 * phrase générique plus un identifiant de requête.
 */
const svc = require('../services/AssessmentChangeRequestService');
const WF = require('../services/SelfAssessmentWorkflowService');
const { makeHandle, requireId, domainStatus, sayError } = require('../utils/apiErrors');

const _json = makeHandle('AssessmentChangeRequestController');
/**
 * M-02 — la MÊME phrase dans la langue du lecteur, des deux côtés : les
 * formulaires passent par `_say`, les points JSON par ce filtre.
 *
 * Le statut est figé ICI, à partir de la phrase de RÉFÉRENCE : `apiErrors
 * .domainStatus` le déduit de l'anglais (« not authorized » → 403, « not
 * found » → 404, « cannot … from » → 409), et une phrase française lui ferait
 * rendre 400 partout. On le pose donc avant de traduire, puis `expose` rend la
 * paire (statut, phrase) autoritaire.
 *
 * La TRADUCTION, elle, n'est plus faite ici : elle appartient à `apiErrors
 * .toResponse`, que TOUS les contrôleurs JSON de ce domaine traversent. Tant
 * qu'elle vivait dans ce fichier, un seul contrôleur parlait français et les
 * clés posées par `SelfAssessmentWorkflowService.say` étaient mortes sur les
 * routes de `SelfAssessmentWorkflowController` (M-02, résiduel).
 */
const handle = (fn) =>
    _json(async (req, res) => {
        try {
            return await fn(req, res);
        } catch (e) {
            if (e && e.i18n) {
                if (!e.status) e.status = domainStatus(String(e.message || ''));
                e.expose = true;
            }
            throw e;
        }
    });
const id = (req, name = 'id') => requireId(req.params[name], name);

class AssessmentChangeRequestController {
    // --- écritures ---
    create = handle(async (req) => ({
        request: await svc.create(id(req), req.user, { reason: req.body.reason }, req),
    }));
    grant = handle(async (req) => ({
        request: await svc.decide(
            id(req),
            req.user,
            { decision: 'granted', reason: req.body.reason },
            req
        ),
    }));
    refuse = handle(async (req) => ({
        request: await svc.decide(
            id(req),
            req.user,
            { decision: 'refused', reason: req.body.reason },
            req
        ),
    }));
    withdraw = handle(async (req) => ({ request: await svc.withdraw(id(req), req.user, req) }));

    /** L'annulation directe par le superviseur/manager (règle B) — pas une demande. */
    cancel = handle(async (req) => ({
        assessment: await WF.cancelByReviewer(id(req), req.user, req.body.reason, req),
    }));

    // --- lectures ---
    mine = handle(async (req) => ({ requests: await svc.listMine(req.user) }));
    queue = handle(async (req) => ({
        requests: await svc.queue(req.user, { status: req.query.status }),
    }));
    // `req.user` est passé : la garde vit dans le service (le sujet, son
    // superviseur, son manager ou un administrateur dans son périmètre).
    forAssessment = handle(async (req) => ({
        requests: await svc.listForAssessment(id(req), req.user),
    }));

    /**
     * La page. Elle sert les deux rôles : `mine` est toujours rempli, `queue`
     * seulement pour qui peut décider. Un échec de lecture ne doit pas coûter la
     * page à l'autre moitié — chaque liste est tentée séparément.
     *
     * Elle est entièrement rendue côté serveur et pilotée par des formulaires :
     * elle fonctionne sans JavaScript, comme le reste des écrans de décision.
     */
    page = async (req, res) => {
        const isAdmin = Boolean(req.user && req.user.userType === 'admin');
        let mine = [];
        let queue = [];
        let lockedRows = [];
        let othersRows = [];
        let cancellable = [];
        try {
            mine = await svc.listMine(req.user);
        } catch (_) {
            mine = [];
        }
        // E-02 / M-01 — ce que le SERVEUR accepterait, pour les deux rôles. Le
        // calcul vivait ici et portait sur les évaluations DU LECTEUR, donc la
        // section de dépôt était structurellement vide pour un superviseur ;
        // il vit maintenant dans le service, à côté des règles de `create`.
        try {
            const r = await svc.raisable(req.user);
            lockedRows = r.mine;
            othersRows = r.others;
        } catch (_) {
            lockedRows = [];
            othersRows = [];
        }
        const canDecide = Boolean(req.user && (isAdmin || req.user.userType === 'manager'));
        if (canDecide) {
            try {
                queue = await svc.queue(req.user, { status: 'pending' });
            } catch (_) {
                queue = [];
            }
            // Ce que je peux encore ANNULER directement (règle B) : tout ce qui
            // n'est pas validé. Au-delà, c'est une demande de modification.
            try {
                const rows = await WF.reviewQueue(req.user);
                cancellable = (rows || []).filter((r) =>
                    ['submitted', 'under_review', 'changes_requested', 'reviewed'].includes(
                        r.workflowState
                    )
                );
            } catch (_) {
                cancellable = [];
            }
        }
        res.render('pages/assessment-changes/index', {
            title: req.t ? req.t('chrome:pt_assessment_changes') : 'Demandes de modification',
            mine,
            queue,
            lockedRows,
            othersRows,
            cancellable,
            canDecide,
            // E-16 — « Retirer » n'appartient qu'à la personne qui a déposé la
            // demande (`withdraw` refuse les autres) : la vue a besoin de
            // savoir QUI lit, pas seulement de l'état de la ligne.
            meRef:
                req.user && req.user.id != null
                    ? `${isAdmin ? 'admin' : 'employee'}:${Number(req.user.id)}`
                    : null,
        });
    };

    // --- formulaires HTML (sans JavaScript) : flash + retour à la page ---
    /**
     * Message d'erreur lisible, DANS LA LANGUE DU LECTEUR (constat M-02).
     *
     * Six refus de ce domaine étaient rendus en anglais sur une page française
     * (`<html lang="fr">` vérifié), dont « Cannot cancel from 'draft' » qui
     * exposait une valeur de base ; d'autres, écrits en français, apparaissaient
     * sur la page anglaise. Les services portent désormais `e.i18n = {key, vars}`
     * et c'est le catalogue qui rend la phrase.
     *
     * `defaultValue` reste la phrase de référence de l'erreur : une clé oubliée
     * dégrade vers le comportement d'avant, jamais vers une clé brute à l'écran.
     *
     * La résolution elle-même est PARTAGÉE (`utils/apiErrors.sayError`) : c'est
     * la même pour un refus rendu en flash et pour un refus rendu en JSON, et
     * une copie locale est exactement ce qui a laissé les routes de
     * `SelfAssessmentWorkflowController` en anglais.
     */
    static _say(req, e, fallback) {
        return sayError(req, e, fallback) || fallback;
    }

    raiseForm = async (req, res) => {
        try {
            await svc.create(
                Number(req.body.assessmentId),
                req.user,
                { reason: req.body.reason },
                req
            );
            req.flash(
                'success',
                req.t ? req.t('assess:acr_flash_raised') : 'Demande de modification envoyée.'
            );
        } catch (e) {
            req.flash('error', AssessmentChangeRequestController._say(req, e, 'Demande refusée.'));
        }
        res.redirect('/assessment-changes');
    };

    decideForm = async (req, res) => {
        try {
            await svc.decide(
                Number(req.params.id),
                req.user,
                {
                    decision: req.body.decision === 'granted' ? 'granted' : 'refused',
                    reason: req.body.reason,
                },
                req
            );
            req.flash(
                'success',
                req.body.decision === 'granted'
                    ? req.t
                        ? req.t('assess:acr_flash_granted')
                        : 'Demande accordée : l’évaluation est rendue à la personne.'
                    : req.t
                      ? req.t('assess:acr_flash_refused')
                      : 'Demande refusée, motif enregistré.'
            );
        } catch (e) {
            req.flash('error', AssessmentChangeRequestController._say(req, e, 'Décision refusée.'));
        }
        res.redirect('/assessment-changes');
    };

    withdrawForm = async (req, res) => {
        try {
            await svc.withdraw(Number(req.params.id), req.user, req);
            req.flash('success', req.t ? req.t('assess:acr_flash_withdrawn') : 'Demande retirée.');
        } catch (e) {
            req.flash('error', AssessmentChangeRequestController._say(req, e, 'Retrait refusé.'));
        }
        res.redirect('/assessment-changes');
    };

    cancelForm = async (req, res) => {
        try {
            await WF.cancelByReviewer(
                Number(req.body.assessmentId),
                req.user,
                req.body.reason,
                req
            );
            req.flash(
                'success',
                req.t
                    ? req.t('assess:acr_flash_cancelled')
                    : 'Évaluation annulée (état + motif). Rien n’a été supprimé.'
            );
        } catch (e) {
            req.flash(
                'error',
                AssessmentChangeRequestController._say(req, e, 'Annulation refusée.')
            );
        }
        res.redirect('/assessment-changes');
    };
}

module.exports = new AssessmentChangeRequestController();
