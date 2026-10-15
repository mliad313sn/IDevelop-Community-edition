'use strict';
const svc = require('../services/NineBoxService');
// Shared JSON error discipline: domain errors keep their message + status, DB /
// runtime faults become one generic FR sentence + a request id and are logged.
// See utils/apiErrors — the old inline wrapper returned err.message for EVERY
// throw, so raw PostgreSQL text reached the browser.
const { makeHandle, requireId, domainStatus } = require('../utils/apiErrors');
const { enumLabel } = require('../utils/enumLabels');

const { csvResponse } = require('../utils/listTools');
const { appDayIso } = require('../utils/dateFormat');

const _json = makeHandle('NineBoxController');
const MOVEMENT_DIRECTIONS = ['first', 'stable', 'up', 'down', 'lateral'];
// box 1..9 → localized cell key (box = BAND[potential]*3 + BAND[performance] + 1).
const BOX_CELL_KEYS = [
    'nb_cell_concern',
    'nb_cell_essential',
    'nb_cell_trusted',
    'nb_cell_dilemma',
    'nb_cell_critical',
    'nb_cell_emerging',
    'nb_cell_diamond',
    'nb_cell_shooting',
    'nb_cell_gold',
];

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
    // migration 175: a box change carries a written justification (≥ 20 chars).
    submit = handle(async (req) => ({
        evaluation: await svc.submit(req.user, id(req), req, {
            movementJustification: req.body && req.body.movementJustification,
        }),
    }));
    approve = handle(async (req) => ({
        evaluation: await svc.approve(req.user, id(req), req, {
            movementJustification: req.body && req.body.movementJustification,
        }),
    }));
    previousPlacement = handle(async (req) => svc.previousPlacement(id(req), req.user));
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

    // ── 9-BOX MOVEMENTS (migration 175) ──────────────────────────────────────
    // Same guard and scope as the console (requireManagerOrAdmin + the service's
    // _scopedEmployeeIds). Filters come from the query string and are only ever
    // compared to known values: nothing from the query reaches SQL text.
    _movementFilters(req) {
        const q = req.query || {};
        const pick = (v) => (v == null ? '' : String(v).trim());
        const posInt = (v) =>
            /^\d{1,12}$/.test(pick(v)) && Number(pick(v)) > 0 ? String(Number(pick(v))) : '';
        const cycle = pick(q.cycle) === 'none' ? 'none' : posInt(q.cycle);
        const direction = MOVEMENT_DIRECTIONS.includes(pick(q.direction)) ? pick(q.direction) : '';
        return { cycle, siteId: posInt(q.siteId), departmentId: posInt(q.departmentId), direction };
    }

    _lang(req) {
        return req.language || (req.i18n && req.i18n.language) || 'fr';
    }

    movementsPage = async (req, res, next) => {
        try {
            const filters = this._movementFilters(req);
            const data = await svc.movements(req.user, filters, req);
            res.render('pages/talent/nine-box-movements', {
                title: req.t ? req.t('talentx:nb_mv_title') : '9-box movements',
                filters,
                data,
                minJustification: svc.constructor.MOVEMENT_MIN_JUSTIFICATION,
                boxKeys: BOX_CELL_KEYS,
                directions: MOVEMENT_DIRECTIONS,
                statusLabel: (s) => enumLabel(s, this._lang(req)),
            });
        } catch (e) {
            next(e);
        }
    };

    movementsCsv = async (req, res, next) => {
        try {
            const t = (k, o) => (req.t ? req.t(`talentx:${k}`, o) : k);
            const filters = this._movementFilters(req);
            const data = await svc.movements(req.user, filters, req);
            const box = (n) => (n >= 1 && n <= 9 ? t(BOX_CELL_KEYS[n - 1]) : '');
            // The calendar day in the app's zone, never the UTC day.
            const fmt = (d) => (d ? appDayIso(d) || '' : '');
            const lang = this._lang(req);
            const rows = data.rows.map((r) => {
                const m = r.movement;
                return [
                    [r.firstName, r.lastName].filter(Boolean).join(' '),
                    r.employeeNumber || '',
                    r.siteName || '',
                    r.departmentName || '',
                    r.cycleLabel || t('nb_mv_cycle_none'),
                    m.previous ? box(m.previous.box) : t('nb_mv_first'),
                    box(r.box),
                    t(`nb_mv_${m.direction}`),
                    m.justification || (m.requiresJustification ? t('nb_mv_not_justified') : ''),
                    m.justifiedBy || '',
                    fmt(m.justifiedAt),
                    fmt(r.approvedAt),
                    enumLabel(r.status, lang),
                ];
            });
            // Ids and counts only in the audit line; csvResponse runs every cell
            // through csvSafe (spreadsheet formula-injection guard).
            await svc._audit(
                req,
                'NINEBOX_MOVEMENTS_EXPORT',
                null,
                `exported ${rows.length} 9-box movements`
            );
            csvResponse(
                res,
                '9-box-movements.csv',
                [
                    t('nb_mv_col_person'),
                    t('nb_mv_col_number'),
                    t('nb_mv_filter_site'),
                    t('nb_mv_filter_department'),
                    t('nb_mv_col_cycle'),
                    t('nb_mv_col_old'),
                    t('nb_mv_col_new'),
                    t('nb_mv_col_direction'),
                    t('nb_mv_col_justification'),
                    t('nb_mv_col_by'),
                    t('nb_mv_col_justified_on'),
                    t('nb_mv_col_decided_on'),
                    t('nb_mv_col_status'),
                ],
                rows
            );
        } catch (e) {
            next(e);
        }
    };
}
module.exports = new NineBoxController();
