'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

const {
    requireAuth,
    requireEmployee,
    requireManager,
    requireManagerOrAdmin,
    requirePermission,
} = require('../middleware/auth');
const EvidenceService = require('../services/EvidenceService');
const DisputeServiceV2 = require('../services/DisputeServiceV2');
const RBACService = require('../services/RBACService');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

// A dispute may only be resolved by someone who governs the disputed employee
// (super admin → all; manager/local-admin → their span). Returns an Express
// response on failure, or null to proceed.
//
// "The disputed employee" is the employee the REVIEW is about
// (DisputeServiceV2.employeeFor resolves through supervisor_reviews), NOT
// assessment_disputes.employee_id: scoping on the dispute row let whoever
// opened a dispute on somebody else's review route its resolution to THEIR OWN
// manager, who then rewrote the victim's official skill level.
async function guardDisputeScope(req, res) {
    const empId = await DisputeServiceV2.employeeFor(Number(req.params.id));
    if (empId === null) {
        res.status(404).json({
            ok: false,
            code: 'DISPUTE_NOT_FOUND',
            error: say(req, 'talentx:dsp_err_not_found', 'Dispute not found.'),
        });
        return false;
    }
    const inScope =
        RBACService.isSuperAdmin(req.user) ||
        (await RBACService.getFilteredEmployees(req.user)).some((e) => Number(e.id) === empId);
    if (!inScope) {
        res.status(403).json({
            ok: false,
            code: 'DISPUTE_OUT_OF_SCOPE',
            error: say(req, 'talentx:dsp_err_out_of_scope', 'This dispute is outside your scope.'),
        });
        return false;
    }
    return true;
}

/**
 * LA PHRASE D'UN REFUS SE LIT DANS
 * LA LANGUE DE LA SESSION.
 * -------------------------------------------------------------------------
 * Ces routes REPONDENT directement (elles ne lancent pas), donc aucun
 * `sendDisputeRefusal` ne pouvait les atteindre : leurs phrases partaient en
 * anglais figé. Mesuré avant correction, `uat.manager` en session française,
 * la file `/v2/slf/disputes` affichant `j.error` tel quel dans un toast
 * (`views/pages/slf/disputes.ejs:64`) :
 *     POST …/99999999/resolve-l0 → 404 « dispute not found »
 *     POST …/75/resolve-l2       → 403 « HR arbitration permission required »
 *     POST …/75/resolve-l0       → 409 « This dispute was already resolved or escalated. »
 *     POST …/75/resolve-l1       → 409 « … or escalated to HR. »
 * — identiques octet pour octet en FR et en EN. `say` rend la phrase du
 * catalogue et garde la phrase anglaise d'origine comme référence, pour le cas
 * où le traducteur ne serait pas monté sur la requête (tâche, sonde, test).
 */
function say(req, key, fallback) {
    if (!req || typeof req.t !== 'function') return fallback;
    const s = req.t(key, { defaultValue: fallback });
    // Un t qui renvoie la clé (catalogue non chargé) ne doit jamais atteindre
    // l'écran : c'est le défaut P2-17, on ne le réintroduit pas ici.
    return !s || s === key || s === key.split(':').pop() ? fallback : s;
}

// DisputeServiceV2 refuses a business-rule violation with `status` + a stable
// `code`. Answer it as the 4xx it is, with the localized text the page shows in
// its toast — instead of asyncHandler's blanket 500 (or, for a value that used
// to reach the DB CHECK, a raw driver message). Returns true when handled.
const DISPUTE_ERROR_KEYS = {
    DISPUTE_RATING_REQUIRED: 'talentx:dsp_err_rating_required',
    DISPUTE_RATING_RANGE: 'talentx:dsp_err_rating_range',
    DISPUTE_REASON_REQUIRED: 'talentx:dsp_note_required',
    DISPUTE_REVIEW_INVALID: 'employee:sr_err_review_not_found',
    DISPUTE_REVIEW_NOT_FOUND: 'employee:sr_err_review_not_found',
    DISPUTE_NOT_OWNER: 'employee:sr_err_not_own_review',
    DISPUTE_NOT_DISPUTABLE: 'employee:sr_err_not_disputable',
    DISPUTE_ROUND_SUPERSEDED: 'employee:sr_err_round_superseded',
};

/**
 * UN SEUL CODE, DEUX PHRASES.
 * -----------------------------------
 * `DisputeServiceV2` lève `DISPUTE_REASON_REQUIRED` à DEUX endroits qui ne
 * parlent pas de la même chose : `_requireReason` (:77) pour la NOTE DE
 * RÉSOLUTION que le décideur doit écrire, et `open` (:156) pour le MOTIF que
 * l'employé doit donner en déposant. La table ci-dessus mappait l'unique code
 * sur la phrase de la résolution, pour les QUATRE usages. Mesuré avant
 * correction, `uat.employee` déposant sans motif :
 *     FR → 400 {"code":"DISPUTE_REASON_REQUIRED","error":"Une note de résolution est obligatoire."}
 *     EN → « A resolution note is required. »
 * Ni clé nue, ni défaut de parité : une phrase de SENS FAUX — celle destinée au
 * manager qui tranche, servie à l'employé qui dépose.
 *
 * La ROUTE, elle, sait de quel acte il s'agit — et elle le sait sans rien
 * déclarer : le DÉPÔT est la seule de ces routes qui n'adresse AUCUNE
 * contestation existante (pas de `:id` dans son chemin). C'est ce qui la
 * distingue, et c'est exactement la distinction que la phrase doit porter.
 * Le service garde son code stable (aucun autre appelant n'est perturbé) ;
 * corriger côté service aurait demandé un second code, dans un fichier que ce
 * lot ne possède pas.
 */
const OPEN_DISPUTE_KEYS = { DISPUTE_REASON_REQUIRED: 'talentx:dsp_open_reason_required' };

/** Vrai sur le chemin du DÉPÔT : aucune contestation n'est encore adressée. */
function isDisputeOpenPath(req) {
    return !req || !req.params || req.params.id === undefined || req.params.id === null;
}

function sendDisputeRefusal(req, res, e) {
    if (!e || !Number.isInteger(e.status) || e.status < 400 || e.status > 499) return false;
    const overrides = isDisputeOpenPath(req) ? OPEN_DISPUTE_KEYS : null;
    const key = (overrides && overrides[e.code]) || DISPUTE_ERROR_KEYS[e.code];
    // A refusal that already names its catalogue entry and variables (the 30-day
    // window: `assess:acr_err_contest_window` with both dates) is rendered from
    // it; the campaign gate arrives already written in the reader's language
    // (`t` was handed to the service). Nothing here falls back to a raw key.
    const i18nKey = !key && e.i18n && e.i18n.key ? e.i18n.key : null;
    const msg = key
        ? say(req, key, e.message)
        : i18nKey && req && typeof req.t === 'function'
          ? req.t(i18nKey, { defaultValue: e.message, ...(e.i18n.vars || {}) })
          : e.message;
    res.status(e.status).json({ ok: false, code: e.code, error: msg });
    return true;
}

// ---- Admin pages ----
// The cycle CRUD page has been folded into the campaign console (/cycles):
// one page creates, launches, extends, reopens, locks and closes a campaign
// with one honest close. Bookmarks land on the console.
router.get('/cycles', requireAuth, (req, res) => res.redirect(301, '/cycles'));

// True if the user may act as the HR/L2 arbiter (SuperAdmin, or a local admin
// holding the arbitrate_disputes grant). This is how "HR" is modelled — a
// scoped local admin with a special permission, not a separate user type.
function canArbitrate(user) {
    if (!user || user.userType !== 'admin') return false;
    if (user.role === 'superadmin') return true;
    return Array.isArray(user.permissions) && user.permissions.includes('arbitrate_disputes');
}

// Disputes queue (managers resolve L0/L1; HR arbiters resolve L2; admins view in scope).
router.get(
    '/disputes',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const disputes = await DisputeServiceV2.listForManager(req.user);
        res.render('pages/slf/disputes', {
            title: req.t ? req.t('chrome:nav_disputes_title') : 'Assessment Disputes',
            disputes,
            canResolve: req.user.userType === 'manager',
            canArbitrate: canArbitrate(req.user),
        });
    })
);

const upload = multer({
    dest: path.resolve('tmp'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    },
});

// Upload evidence for a self-assessment row (max 3 enforced here).
router.post(
    '/evidence/:selfAssessmentId',
    requireEmployee,
    upload.single('file'),
    ah(async (req, res) => {
        const said = Number(req.params.selfAssessmentId);
        // Only the owning employee may attach evidence to their assessment row.
        const sa = await db.get(`SELECT employee_id FROM self_assessments WHERE id = ?`, [said]);
        if (!sa) return res.status(404).json({ error: 'assessment not found' });
        if (Number(sa.employeeId) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'not authorized for this assessment' });
        }
        const row = await db.get(
            `SELECT count(*) AS rows FROM assessment_evidence WHERE self_assessment_id = ?`,
            [said]
        );
        if (row && row.rows >= 3)
            return res.status(400).json({ error: 'max 3 evidences per skill' });
        const result = await EvidenceService.accept({
            file: req.file,
            selfAssessmentId: said,
            uploaderId: req.user.id,
        });
        if (result.avStatus === 'quarantined') {
            return res.status(400).json({ error: 'upload rejected' });
        }
        res.json({ ok: true, ...result });
    })
);

// Open a dispute. The service decides ownership (the caller must be the
// employee the review is about) and state (the review must be decided).
//
// c'est ICI que « motif obligatoire » est la phrase de l'EMPLOYÉ qui
// dépose, et non la note de résolution du manager qui tranche. La route ne
// porte pas de `:id` — `sendDisputeRefusal` le voit et choisit la bonne phrase.
router.post(
    '/disputes',
    requireEmployee,
    ah(async (req, res) => {
        let id;
        try {
            id = await DisputeServiceV2.open({
                supervisorReviewId: req.body.supervisorReviewId,
                employeeId: req.user.id,
                reason: req.body.reason,
                t: typeof req.t === 'function' ? req.t : undefined,
            });
        } catch (e) {
            if (sendDisputeRefusal(req, res, e)) return;
            throw e;
        }
        res.json({ ok: true, id });
    })
);

router.post(
    '/disputes/:id/resolve-l0',
    requireManager,
    ah(async (req, res) => {
        if (!(await guardDisputeScope(req, res))) return;
        let r0;
        try {
            r0 = await DisputeServiceV2.resolveL0({
                disputeId: Number(req.params.id),
                decidedBy: req.user.id,
                decidedRating: req.body.decidedRating,
                reason: req.body.reason,
            });
        } catch (e) {
            if (sendDisputeRefusal(req, res, e)) return;
            throw e;
        }
        if (r0 && r0.resolved === false) {
            return res.status(409).json({
                ok: false,
                code: 'DISPUTE_ALREADY_DECIDED',
                error: say(
                    req,
                    'talentx:dsp_err_already_decided_l0',
                    'This dispute was already resolved or escalated.'
                ),
            });
        }
        res.json({ ok: true });
    })
);

router.post(
    '/disputes/:id/resolve-l1',
    requireManager,
    ah(async (req, res) => {
        if (!(await guardDisputeScope(req, res))) return;
        let r1;
        try {
            r1 = await DisputeServiceV2.resolveL1({
                disputeId: Number(req.params.id),
                decidedBy: req.user.id,
                decidedRating: req.body.decidedRating,
                reason: req.body.reason,
            });
        } catch (e) {
            if (sendDisputeRefusal(req, res, e)) return;
            throw e;
        }
        if (r1 && r1.resolved === false) {
            return res.status(409).json({
                ok: false,
                code: 'DISPUTE_ALREADY_DECIDED',
                error: say(
                    req,
                    'talentx:dsp_err_already_decided_l1',
                    'This dispute was already resolved or escalated to HR.'
                ),
            });
        }
        res.json({ ok: true });
    })
);

// L2 arbitration — HR only (SuperAdmin or arbitrate_disputes grant), in scope.
router.post(
    '/disputes/:id/resolve-l2',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        if (!canArbitrate(req.user)) {
            return res.status(403).json({
                ok: false,
                code: 'DISPUTE_ARBITRATION_FORBIDDEN',
                error: say(
                    req,
                    'talentx:dsp_err_arbitration_permission',
                    'HR arbitration permission required'
                ),
            });
        }
        if (!(await guardDisputeScope(req, res))) return;
        let r2;
        try {
            r2 = await DisputeServiceV2.resolveL2({
                disputeId: Number(req.params.id),
                decidedByAdminId: req.user.id,
                decidedRating: req.body.decidedRating,
                reason: req.body.reason,
            });
        } catch (e) {
            if (sendDisputeRefusal(req, res, e)) return;
            throw e;
        }
        if (r2 && r2.resolved === false) {
            return res.status(409).json({
                ok: false,
                code: 'DISPUTE_ALREADY_DECIDED',
                error: say(
                    req,
                    'talentx:dsp_err_already_decided_l2',
                    'This dispute was already resolved or auto-finalized.'
                ),
            });
        }
        require('../services/LogService')
            .log({
                adminId: req.user.id,
                action: 'DISPUTE_L2_RESOLVED',
                entityType: 'assessment_dispute',
                entityId: Number(req.params.id),
                details: `HR arbitrated dispute with rating ${req.body.decidedRating}`,
            })
            .catch(() => {});
        res.json({ ok: true });
    })
);

// Cycle controls moved to the console (POST /cycles, /cycles/:id/relaunch|lock|close,
// SuperAdmin-only, audited, honest close). The old JSON endpoints answer 410 so a
// stale page cannot run the plain close that bypassed the disposition audit line.
router.post(
    ['/cycles', '/cycles/:id/open', '/cycles/:id/lock', '/cycles/:id/close'],
    requireAuth,
    (req, res) => {
        res.status(410).json({ ok: false, code: 'moved', error: '/cycles' });
    }
);

module.exports = router;
