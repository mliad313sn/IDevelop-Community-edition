'use strict';
const svc = require('../services/NineBoxService');
// Shared JSON error discipline: domain errors keep their message + status, DB /
// runtime faults become one generic FR sentence + a request id and are logged.
// See utils/apiErrors — the old inline wrapper returned err.message for EVERY
// throw, so raw PostgreSQL text reached the browser.
const { makeHandle, requireId, domainStatus } = require('../utils/apiErrors');
const { enumLabel } = require('../utils/enumLabels');

const _json = makeHandle('NineBoxController');

/**
 * M-06 (deuxième geste) — LE REFUS DANS LA LANGUE DU LECTEUR.
 *
 * `nine-box-console.ejs` affiche la réponse par `alert(j.error)` : la phrase du
 * service arrivait donc telle quelle à l'écran — en anglais sur une page dont le
 * `<html lang>` vaut « fr » (« Not authorized: manager/admin only »), et en
 * français sur la page anglaise pour les deux refus de divulgation sans motif.
 * Certaines exposaient en plus une valeur d'énumération brute (« Cannot approve
 * from 'under_review' »).
 *
 * Le service porte désormais `e.i18n = {key, vars}` ; ce filtre rend la phrase.
 * Le statut est figé AVANT la traduction, à partir de la phrase de RÉFÉRENCE :
 * `apiErrors.domainStatus` le déduit de l'anglais (« not authorized » → 403,
 * « not found » → 404, « cannot … from » → 409) et une phrase française lui
 * ferait rendre 400 partout. Même forme que `AssessmentChangeRequestController`.
 *
 * `defaultValue` reste la phrase de référence : une clé oubliée dégrade vers le
 * comportement d'avant, jamais vers une clé brute à l'écran.
 */
const handle = (fn) =>
    _json(async (req, res) => {
        try {
            return await fn(req, res);
        } catch (e) {
            if (e && e.i18n && e.i18n.key && req && typeof req.t === 'function') {
                if (!e.status) e.status = domainStatus(String(e.message || ''));
                const vars = { ...(e.i18n.vars || {}) };
                // Jamais une valeur d'énumération dans une phrase : le même
                // dictionnaire que les tableaux et que `public/js/enum-labels.js`.
                if (vars.statusRaw) {
                    vars.status = enumLabel(
                        vars.statusRaw,
                        req.language || (req.i18n && req.i18n.language) || 'fr'
                    );
                }
                e.message = req.t(e.i18n.key, { defaultValue: String(e.message || ''), ...vars });
                e.expose = true;
            }
            throw e;
        }
    });
/** Route :id → positive integer, or a 400 "identifiant invalide" before any query. */
const id = (req, name = 'id') => requireId(req.params[name], name);

class NineBoxController {
    create = handle(async (req) => ({
        evaluation: await svc.createDraft(req.user, req.body, req),
    }));
    update = handle(async (req) => ({
        evaluation: await svc.update(req.user, id(req), req.body, req),
    }));
    submit = handle(async (req) => ({
        evaluation: await svc.submit(req.user, id(req), req),
    }));
    approve = handle(async (req) => ({
        evaluation: await svc.approve(req.user, id(req), req),
    }));
    reject = handle(async (req) => ({
        evaluation: await svc.reject(req.user, id(req), req.body.reason, req),
    }));
    archive = handle(async (req) => ({
        evaluation: await svc.archive(req.user, id(req), req),
    }));
    // disclosure (and its retraction) carry a mandatory written reason.
    disclose = handle(async (req) => ({
        evaluation: await svc.setDisclosure(
            req.user,
            id(req),
            req.body.disclosed,
            req.body.reason,
            req
        ),
    }));
    get = handle(async (req) => ({
        evaluation: await svc.get(id(req), req.user, req),
    }));
    history = handle(async (req) => ({ events: await svc.history(id(req), req.user) }));
    trend = handle(async (req) => ({ trend: await svc.placementTrend(id(req), req.user, req) }));
    suggestPosition = handle(async (req) => ({
        suggestion: await svc.suggestPosition(id(req), req.user, req),
    }));
    grid = handle(async (req) => ({ placements: await svc.grid(req.user, req) }));
    roster = handle(async (req) => ({ employees: await svc.roster(req.user, req) }));

    gridPage = (req, res) =>
        res.render('pages/talent/nine-box-console', {
            title: req.t ? req.t('chrome:pt_9_box_talent_grid') : '9-Box Talent Grid',
        });
}
module.exports = new NineBoxController();
