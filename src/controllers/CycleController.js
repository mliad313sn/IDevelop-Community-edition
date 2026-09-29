'use strict';

/**
 *   CycleController — the CAMPAIGN CONSOLE.
 *
 *   A cycle used to be a row with a status and three buttons: you could open it,
 *   lock it and close it, and at no point could anyone answer the only two
 *   questions that matter while a campaign is running — "who has not started?"
 *   and "who is sitting on submissions?". This console answers both from the
 *   roster (cycle_participants), so the non-starter is a NAMED, reachable person
 *   instead of a missing row — and, by design, it is
 *   also where a campaign is created, launched, extended, reopened, locked,
 *   closed or cancelled.
 *
 *   Reads are RBAC-scoped inside CycleService (a scoped admin sees only their
 *   population, a manager their reports); the route layer adds the capability
 *   gate. Authority (open question 1, default taken): create / launch / extend /
 *   reopen / lock / close / cancel are SuperAdmin-only; a scoped admin with
 *   manage_cycles keeps PERSON-level roster control (excuse / re-include /
 *   reviewer); a manager may CHASE their own reports.
 *
 *   HARD CONSTRAINT honoured throughout: nothing here reduces the number of
 *   skills anybody is asked to assess. Filters filter the reviewer's VIEW; the
 *   only exclusion offered is PERSON-level, with a written reason.
 */

const CycleService = require('../services/CycleService');
const LogService = require('../services/LogService');
const RBACService = require('../services/RBACService');
const { parsePage, buildPager, sortLinks, csvResponse, paramsFrom } = require('../utils/listTools');
const { wantsJson, denyPermission } = require('../middleware/auth');
const { keepDraft } = require('../utils/validators');

const PAGE_SIZES = [25, 50, 100, 200, 500];
const LIST_STATUSES = ['', 'running', 'draft', 'closed', 'cancelled', 'all'];

function t(req, key, fallback, vars) {
    if (req && typeof req.t === 'function') {
        return req.t(key, { defaultValue: fallback, ...(vars || {}) });
    }
    return fallback;
}

/** Stable error code → HTTP status. Everything else is a 500 (and logged). */
const STATUS_BY_CODE = {
    participant_not_in_scope: 403,
    superadmin_required: 403,
    manager_scope_only: 403,
    cycle_not_found: 404,
    exclusion_reason_required: 400,
    exclusion_category_invalid: 400,
    exclusion_until_invalid: 400,
    exclusion_until_past: 400,
    exclusion_selection_empty: 400,
    nudge_selection_empty: 400,
    cycle_code_required: 400,
    cycle_code_invalid: 400,
    cycle_dates_required: 400,
    cycle_dates_invalid: 400,
    cycle_deadline_past: 400,
    cancel_reason_required: 400,
    reviewer_invalid: 400,
    grouping_unknown: 400,
    cycle_code_taken: 409,
    cycle_not_running: 409,
    cycle_not_locked: 409,
    cycle_not_open: 409,
    cycle_not_draft: 409,
    participant_erased: 409,
    participant_inactive: 409,
    nothing_changed: 409,
    // ---- SECTION campaign-rules (A5 / A8) -------------------------------------------
    // The campaign write gate (CycleService.cycleWriteGate): a refusal is a 409
    // and its message already names the campaign and its closing date.
    cycle_write_closed: 409,
    cycle_write_cancelled: 409,
    cycle_write_draft: 409,
    cycle_write_locked: 409,
    cycle_write_refused: 409,
    cycle_not_closed: 409,
    reopen_reason_required: 400,
    cycle_closed_at_unknown: 409,
    cycle_reopen_window_expired: 409,
    proposal_not_found: 404,
    proposal_decision_invalid: 400,
    proposal_reason_required: 400,
};

/** JSON error envelope: honest status, stable `code`, translated `error`. */
function fail(req, res, err) {
    const code = (err && err.code) || (err && err.message) || 'error';
    const status = STATUS_BY_CODE[code] || 500;
    if (status === 500) console.error('[cycles]', err);
    // SECTION campaign-rules — a write-gate refusal already carries the sentence that NAMES
    // the campaign and its closing date; re-rendering it from the bare code would
    // throw that away. Re-translate it through the request's own `t` so an EN
    // session gets the EN sentence with the same variables.
    if (err && err.gate) {
        const CycleService = require('../services/CycleService');
        const msg =
            CycleService.gateMessage(err.gate, { t: (k, v) => t(req, k, err.message, v) }) ||
            err.message;
        return res
            .status(status)
            .json({ ok: false, code, error: msg, cycle: err.gate.cycle || null });
    }
    if (code === 'cycle_reopen_window_expired') {
        return res.status(status).json({
            ok: false,
            code,
            closedAt: err.closedAt || null,
            days: err.days || null,
            windowDays: err.windowDays || null,
            error: t(
                req,
                'admin:cyc_err_cycle_reopen_window_expired',
                `La campagne a été clôturée le ${err.closedAt}, il y a ${err.days} jours : au-delà de ${err.windowDays} jours, une réouverture n’est plus possible. Ouvrez une nouvelle campagne.`,
                { date: err.closedAt, days: err.days, window: err.windowDays }
            ),
        });
    }
    const msg =
        status === 500
            ? t(req, 'admin:cyc_error', 'Action impossible.')
            : t(req, `admin:cyc_err_${code}`, code);
    return res.status(status).json({ ok: false, code, error: msg });
}

/** Days past the deadline (positive) for a RUNNING campaign, else null. */
function overdueDays(cycle) {
    if (!cycle || !['open', 'locked'].includes(cycle.status) || !cycle.closesAt) return null;
    const d = Math.floor((Date.now() - new Date(cycle.closesAt).getTime()) / 86400000);
    return d > 0 ? d : null;
}

/**
 * SECTION campaign-rules / A5 — la fenêtre de réouverture d'une campagne close.
 *
 * QA cette fonction comptait ici des MILLISECONDES pendant que
 * `CycleService.reopenClosed` comptait des jours calendaires UTC. Résultat
 * mesuré à J+30 : l'écran retirait le bouton (« le délai de 30 jours est
 * écoulé ») alors que le serveur acceptait encore la dérogation. Deux horloges
 * pour une seule règle. Il n'y a plus qu'UN endroit qui décide —
 * `CycleService.reopenWindow` — et l'écran le LIT. Ne recalcule jamais ce délai
 * ici, même « pour l'affichage » : c'est ce calcul d'affichage qui mentait.
 */
function reopenWindow(cycle) {
    return CycleService.reopenWindow(cycle);
}

class CycleController {
    /** /cycles — every cycle with its live campaign progress bar, filterable. */
    async index(req, res) {
        const status = LIST_STATUSES.includes(String(req.query.status || ''))
            ? String(req.query.status || '')
            : '';
        const siteId = Number(req.query.siteId) > 0 ? Number(req.query.siteId) : null;
        const scope = await CycleService.resolveScope(req.user);
        const cycles = await CycleService.list({ status });
        let summaries = {};
        try {
            summaries = await CycleService.progressSummaryAll(req.user, { siteId, scope });
        } catch (e) {
            console.error('[cycles] progressSummaryAll failed:', e.message);
        }
        // Site options: what the caller may see (a one-site admin gets one option).
        let sites = [];
        try {
            sites =
                req.user.userType === 'admin' ? await RBACService.getFilteredSites(req.user) : [];
        } catch (_) {
            sites = [];
        }
        // SECTION campaign-rules: A8 closure proposals (overdue campaigns are FLAGGED and
        // PROPOSED, never closed on their own) and the A6 off-campaign counter,
        // which is shown apart precisely because it is in no completion rate.
        let proposals = {};
        try {
            proposals = await CycleService.openClosureProposalsByCycle();
        } catch (e) {
            console.error('[cycles] openClosureProposalsByCycle failed:', e.message);
        }
        let offCampaign = null;
        try {
            offCampaign = await CycleService.offCampaignSummary(req.user, { scope });
        } catch (e) {
            console.error('[cycles] offCampaignSummary failed:', e.message);
        }
        res.render('pages/cycles/index', {
            title: t(req, 'admin:cyc_title', 'Campagnes d’évaluation'),
            cycles: cycles.map((c) => {
                const w = reopenWindow(c);
                return {
                    ...c,
                    overdueDays: overdueDays(c),
                    closureProposal: proposals[Number(c.id)] || null,
                    // lus de la seule décision : `canReopenClosed`
                    // est ce que le serveur fera, `reopenWindowDays` n'est que la
                    // formulation du temps qui reste.
                    canReopenClosed: w.canReopen,
                    reopenWindowLastDay: w.lastDay,
                    reopenWindowDays: w.daysLeft,
                    reopenWindowTotal: w.windowDays,
                };
            }),
            summaries,
            proposals,
            offCampaign,
            filters: { status, siteId },
            sites,
            scopedCaption: CycleController.scopedCaption(req, sites),
            canManage: CycleController.canManage(req.user),
            canLaunch: CycleController.canLaunch(req.user),
        });
    }

    /** "Périmètre : Site Riverside" for a scoped admin, "votre équipe" for a manager, null for a SuperAdmin. */
    static scopedCaption(req, sites) {
        const u = req.user;
        if (!u) return null;
        if (u.userType === 'manager')
            return t(req, 'admin:cyc_scope_team', 'Périmètre : votre équipe');
        if (RBACService.isSuperAdmin(u)) return null;
        const names = (sites || []).map((s) => s.name).filter(Boolean);
        return t(req, 'admin:cyc_scope_sites', 'Périmètre : {{sites}}', {
            sites: names.length ? names.join(', ') : '—',
        });
    }

    /** /cycles/:id — the funnel, the bottleneck breakdowns, the roster. */
    async show(req, res) {
        const id = Number(req.params.id);
        const cycle = await CycleService.findById(id);
        if (!cycle) {
            req.flash('error', t(req, 'admin:cyc_not_found', 'Campagne introuvable.'));
            return res.redirect('/cycles');
        }

        const f = CycleService.parseFilters(req.query);
        const by = CycleService.GROUPINGS.includes(String(req.query.by || ''))
            ? String(req.query.by)
            : 'site';
        const { perPage: limit } = parsePage(req.query, {
            perPageOptions: PAGE_SIZES,
            defaultPerPage: 50,
        });
        const scope = await CycleService.resolveScope(req.user);
        const base = { ...f, scope, sort: req.query.sort, dir: req.query.dir };

        const [progress, byGroup, byManager, options, total] = await Promise.all([
            CycleService.progress(id, req.user, { scope }),
            CycleService.progressBy(by, id, req.user, { scope }),
            CycleService.progressByManager(id, req.user, { scope }),
            CycleService.filterOptions(id, req.user, { scope }),
            CycleService.participants(id, req.user, { ...base, limit: 1, offset: 0 }).then(
                (r) => r.total
            ),
        ]);
        // Page clamped to the last page.
        const pager0 = buildPager(req.query, {
            page: req.query.page,
            total,
            perPage: limit,
            basePath: `/cycles/${id}`,
        });
        const roster = await CycleService.participants(id, req.user, {
            ...base,
            limit,
            offset: (pager0.page - 1) * limit,
        });
        const pager = buildPager(req.query, {
            page: pager0.page,
            total: roster.total,
            perPage: limit,
            basePath: `/cycles/${id}`,
        });
        const sort = sortLinks(req.query, CycleService.SORT_COLUMNS, roster.sort, {
            basePath: `/cycles/${id}`,
        });
        const filtered = !!(
            f.state ||
            f.q ||
            f.siteId.length ||
            f.departmentId.length ||
            f.serviceId.length ||
            f.roleId.length ||
            f.supervisorId.length ||
            f.noSupervisor
        );

        // SECTION campaign-rules — the three campaign-lifecycle facts the console must state:
        // A8 the closure proposal (and its whole history, decided ones included),
        // A6 the off-campaign measurements that are in NO completion rate, and the
        // role changes that must never shrink anybody's skill count in silence.
        let proposal = null,
            proposalHistory = [],
            offCampaign = null,
            roleChanges = null;
        try {
            proposal = await CycleService.openClosureProposal(id);
        } catch (e) {
            console.error('[cycles] openClosureProposal failed:', e.message);
        }
        try {
            proposalHistory = await CycleService.closureProposals(id);
        } catch (e) {
            console.error('[cycles] closureProposals failed:', e.message);
        }
        try {
            offCampaign = await CycleService.offCampaignSummary(req.user, { scope });
        } catch (e) {
            console.error('[cycles] offCampaignSummary failed:', e.message);
        }
        try {
            roleChanges = await CycleService.roleChanges(id, req.user, { scope });
        } catch (e) {
            console.error('[cycles] roleChanges failed:', e.message);
        }
        const w = reopenWindow(cycle);

        res.render('pages/cycles/show', {
            title: `${cycle.code || ''} — ${t(req, 'admin:cyc_title', 'Campagnes d’évaluation')}`,
            cycle: {
                ...cycle,
                overdueDays: overdueDays(cycle),
                daysSinceClose: w.daysSinceClose,
                // `canReopenClosed` EST la décision du serveur, telle
                // quelle : c'est elle, et elle seule, qui commande le bouton. Les
                // deux autres ne servent qu'à écrire la phrase. null = date de
                // clôture jamais enregistrée → réouverture refusée.
                canReopenClosed: w.canReopen,
                reopenWindowLastDay: w.lastDay,
                reopenWindowDays: w.daysLeft,
                reopenWindowTotal: w.windowDays,
            },
            proposal,
            proposalHistory,
            offCampaign,
            roleChanges,
            progress,
            by,
            groupings: CycleService.GROUPINGS,
            byGroup,
            byManager,
            roster,
            options,
            pager,
            sort,
            filters: {
                ...f,
                by,
                limit: pager.perPage,
                page: pager.page,
                filtered,
                sort: roster.sort.key,
                dir: roster.sort.dir,
            },
            queryString: paramsFrom(req.query, ['page']).toString(),
            pageSizes: PAGE_SIZES,
            categories: CycleService.USER_CATEGORIES,
            canManage: CycleController.canManage(req.user),
            canLaunch: CycleController.canLaunch(req.user),
            canNudge: CycleController.canNudge(req.user),
            isManager: req.user && req.user.userType === 'manager',
            actorAdminId: req.user && req.user.userType === 'admin' ? Number(req.user.id) : null,
        });
    }

    /** /cycles/:id/export.csv — the roster with the current filters, Excel-ready. */
    async exportCsv(req, res) {
        const id = Number(req.params.id);
        const cycle = await CycleService.findById(id);
        if (!cycle) return res.status(404).send('cycle_not_found');
        const f = CycleService.parseFilters(req.query);
        const scope = await CycleService.resolveScope(req.user);
        const r = await CycleService.participants(id, req.user, {
            ...f,
            scope,
            sort: req.query.sort,
            dir: req.query.dir,
            limit: 5000,
            offset: 0,
        });
        const L = (k, fb) => t(req, `admin:${k}`, fb);
        const stateLabel = (s) => t(req, `admin:cyc_kpi_${s}`, s);
        const catLabel = (c) => (c ? t(req, `admin:cyc_cat_${c}`, c) : '');
        const headers = [
            L('cyc_th_person', 'Personne'),
            L('cyc_th_number', 'Matricule'),
            L('cyc_th_site', 'Site'),
            L('cyc_th_department', 'Département'),
            L('cyc_th_service', 'Service'),
            L('cyc_th_role', 'Poste'),
            L('cyc_th_manager', 'Responsable'),
            L('cyc_th_state', 'État'),
            L('cyc_kpi_expected_skills', 'Compétences attendues'),
            L('cyc_kpi_approved_skills', 'Compétences approuvées'),
            L('cyc_th_last_nudge', 'Dernière relance'),
            L('cyc_th_excluded_on', 'Excusé le'),
            L('cyc_th_excluded_by', 'Par'),
            L('cyc_th_category', 'Catégorie'),
            L('cyc_th_reason', 'Motif'),
            L('cyc_th_excluded_until', 'Jusqu’au'),
        ];
        const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
        const rows = r.rows.map((p) => [
            p.fullName,
            p.employeeNumber || '',
            p.siteName || '',
            p.departmentName || '',
            p.serviceName || '',
            p.roleName || '',
            p.supervisorName || (p.reviewerAdmin ? `admin ${p.reviewerAdmin}` : ''),
            stateLabel(p.state),
            p.expectedSkills,
            p.approvedSkills,
            iso(p.lastNudgeAt),
            iso(p.excludedAt),
            p.excludedBy || (p.excludedAt ? t(req, 'admin:cyc_by_system', 'système') : ''),
            catLabel(p.exclusionCategory),
            p.exclusionCategory && CycleService.SYSTEM_CATEGORIES.includes(p.exclusionCategory)
                ? ''
                : p.exclusionReason || '',
            iso(p.excludedUntil),
        ]);
        return csvResponse(
            res,
            `campagne-${cycle.code || id}-participants-${new Date().toISOString().slice(0, 10)}.csv`,
            headers,
            rows
        );
    }

    /** /cycles/:id/roster.json — the scoped roster for JS surfaces (the review page's "not yet submitted" tab). */
    async rosterJson(req, res) {
        try {
            const id = Number(req.params.id);
            const cycle = await CycleService.findById(id);
            if (!cycle) throw new Error('cycle_not_found');
            const f = CycleService.parseFilters(req.query);
            const states = String(req.query.states || '')
                .split(',')
                .filter((s) => CycleService.STATES.includes(s));
            const r = await CycleService.participants(id, req.user, {
                ...f,
                sort: req.query.sort,
                dir: req.query.dir,
                limit: 500,
                offset: 0,
            });
            const rows = states.length ? r.rows.filter((p) => states.includes(p.state)) : r.rows;
            return res.json({
                ok: true,
                cycle: {
                    id: cycle.id,
                    code: cycle.code,
                    status: cycle.status,
                    closesAt: cycle.closesAt,
                    overdueDays: overdueDays(cycle),
                },
                total: rows.length,
                rows: rows.map((p) => ({
                    employeeId: p.employeeId,
                    fullName: p.fullName,
                    employeeNumber: p.employeeNumber,
                    state: p.state,
                    expectedSkills: p.expectedSkills,
                    ratedSkills: p.ratedSkills,
                    approvedSkills: p.approvedSkills,
                    siteName: p.siteName,
                    serviceName: p.serviceName,
                    lastNudgeAt: p.lastNudgeAt,
                })),
            });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** /cycles/running.json — running campaigns for pickers (open first). */
    async runningJson(req, res) {
        try {
            return res.json({ ok: true, cycles: await CycleService.listRunning() });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    // ---- Lifecycle (SuperAdmin) ------------------------------------------

    /** GET /cycles/new — the « Nouvelle campagne » form (folded in from /v2/slf/cycles). */
    async newForm(req, res) {
        res.render('pages/cycles/form', {
            title: t(req, 'admin:cyc_new', 'Nouvelle campagne'),
            cycle: null,
            action: '/cycles',
        });
    }

    /** POST /cycles — validated create: refused forms keep what was typed. */
    async create(req, res) {
        try {
            const id = await CycleService.create({
                code: req.body.code,
                label: req.body.label,
                opensAt: req.body.opensAt,
                closesAt: req.body.closesAt,
                createdBy: req.user.id,
            });
            if (wantsJson(req)) return res.json({ ok: true, id });
            req.flash('success', t(req, 'admin:cyc_created', 'Campagne créée en brouillon.'));
            return res.redirect(`/cycles/${id}`);
        } catch (err) {
            return CycleController._formRefusal(req, res, err, '/cycles/new');
        }
    }

    /** GET /cycles/:id/edit — drafts only. */
    async editForm(req, res) {
        const cycle = await CycleService.findById(Number(req.params.id));
        if (!cycle) {
            req.flash('error', t(req, 'admin:cyc_not_found', 'Campagne introuvable.'));
            return res.redirect('/cycles');
        }
        if (cycle.status !== 'draft') {
            req.flash(
                'error',
                t(req, 'admin:cyc_err_cycle_not_draft', 'Seul un brouillon se modifie.')
            );
            return res.redirect(`/cycles/${cycle.id}`);
        }
        res.render('pages/cycles/form', {
            title: `${cycle.code} — ${t(req, 'admin:cyc_edit', 'Modifier la campagne')}`,
            cycle,
            action: `/cycles/${cycle.id}`,
        });
    }

    /** POST /cycles/:id — validated edit of a draft. */
    async update(req, res) {
        const id = Number(req.params.id);
        try {
            await CycleService.update(
                id,
                {
                    code: req.body.code,
                    label: req.body.label,
                    opensAt: req.body.opensAt,
                    closesAt: req.body.closesAt,
                },
                req.user
            );
            if (wantsJson(req)) return res.json({ ok: true });
            req.flash('success', t(req, 'admin:cyc_updated', 'Campagne modifiée.'));
            return res.redirect(`/cycles/${id}`);
        } catch (err) {
            return CycleController._formRefusal(req, res, err, `/cycles/${id}/edit`);
        }
    }

    /** A refused form: JSON gets the code; a browser gets a FR/EN flash and its typed values back. */
    static _formRefusal(req, res, err, formRoute) {
        const code = (err && (err.code || err.message)) || 'error';
        if (!STATUS_BY_CODE[code]) return fail(req, res, err);
        if (wantsJson(req)) return fail(req, res, err);
        req.flash('error', t(req, `admin:cyc_err_${code}`, code));
        return res.redirect(keepDraft(req, formRoute));
    }

    /**
     * « Lancer la campagne » / « Réenrôler les participants ».
     *
     * DELIBERATE human action: on a DRAFT it opens the campaign (roster + launch
     * notification, ); on an OPEN campaign it reconciles the roster; on a
     * locked / closed / cancelled one it is refused (409) — enrolling people into a
     * campaign they cannot submit to only lowers the completion rate.
     */
    async relaunch(req, res) {
        try {
            const id = Number(req.params.id);
            const cycle = await CycleService.findById(id);
            if (!cycle) throw new Error('cycle_not_found');
            if (cycle.status === 'draft') {
                const r = await CycleService.open(id, req.user);
                const after = await CycleService.progress(id, {
                    userType: 'admin',
                    role: 'superadmin',
                });
                return res.json({
                    ok: true,
                    opened: true,
                    added: r.enrolled,
                    notified: r.notified,
                    excluded: 0,
                    active: after.totals.active,
                });
            }
            if (cycle.status !== 'open') throw new Error('cycle_not_running');

            const result = await CycleService.reconcileParticipants(id);
            const after = await CycleService.progress(id, {
                userType: 'admin',
                role: 'superadmin',
            });
            await LogService.log({
                adminId: req.user && req.user.id ? req.user.id : null,
                action: 'cycle_participants_reconciled',
                entityType: 'assessment_cycle',
                entityId: id,
                category: 'audit',
                ipAddress: req.ip,
                userAgent: req.get && req.get('user-agent'),
                details:
                    `Campagne #${id} (${cycle.code || ''}) — enrôlement manuel : ` +
                    `${result.added} ajouté(s), ${result.excluded} exclu(s) (comptes désactivés / effacés), ${result.reincluded} réintégré(s) ; ` +
                    `roster actif = ${after.totals.active} personne(s)`,
            });
            return res.json({
                ok: true,
                opened: false,
                added: result.added,
                excluded: result.excluded,
                reincluded: result.reincluded,
                active: after.totals.active,
            });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** Roster headcount that a launch would contact — SuperAdmin-only like the action it previews. */
    async relaunchPreview(req, res) {
        try {
            const id = Number(req.params.id);
            const cycle = await CycleService.findById(id);
            if (!cycle) throw new Error('cycle_not_found');
            const p = await CycleService.progress(id, { userType: 'admin', role: 'superadmin' });
            let wouldEnrol = p.totals.active;
            if (cycle.status === 'draft') {
                const row = await require('../config/database').get(
                    `SELECT COUNT(*)::int AS n FROM employees e
                      WHERE e.is_active AND e.erased_at IS NULL
                        AND EXISTS (SELECT 1 FROM role_skill_requirements r WHERE r.role_id = e.role_id)`
                );
                wouldEnrol = Number((row && row.n) || 0);
            }
            return res.json({
                ok: true,
                status: cycle.status,
                active: wouldEnrol,
                participants: p.totals.participants,
            });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** POST /cycles/:id/reopen {closesAt} — locked → open with a new deadline. */
    async reopen(req, res) {
        try {
            const r = await CycleService.reopen(
                Number(req.params.id),
                req.body && req.body.closesAt,
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** POST /cycles/:id/extend {closesAt} — new deadline on an OPEN campaign. */
    async extend(req, res) {
        try {
            const r = await CycleService.extendDeadline(
                Number(req.params.id),
                req.body && req.body.closesAt,
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** POST /cycles/:id/lock — manual lock (no more submissions; reviews continue). */
    async lock(req, res) {
        try {
            const id = Number(req.params.id);
            const cycle = await CycleService.findById(id);
            if (!cycle) throw new Error('cycle_not_found');
            if (cycle.status !== 'open') throw new Error('cycle_not_open');
            const r = await CycleService.lock(id, req.user);
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** POST /cycles/:id/cancel {reason} — a draft raised in error (state + reason). */
    async cancel(req, res) {
        try {
            const r = await CycleService.cancel(
                Number(req.params.id),
                req.body && req.body.reason,
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** Honest close: stamps the finishers, records the shortfall, keeps close. */
    async close(req, res) {
        try {
            const id = Number(req.params.id);
            const cycle = await CycleService.findById(id);
            if (!cycle) throw new Error('cycle_not_found');
            if (!['open', 'locked'].includes(cycle.status)) throw new Error('cycle_not_running');
            const locale = (req.user && req.user.locale) || 'fr';
            const disposition = await CycleService.closeWithDisposition(id, req.user, {
                emit: (name, data) => require('../jobs').emitEvent(name, { ...data, locale }),
            });
            return res.json({ ok: true, disposition });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    // ---- SECTION campaign-rules — A5 / A6 / A8 ----------------------------------------

    /**
     * POST /cycles/:id/reopen-closed {closesAt, reason} — A5.
     * SuperAdmin (route guard), within 30 days of the close, mandatory reason,
     * recorded as an OVERRIDE. Out of the window → an explicit French refusal
     * naming the campaign, its closing date and the number of days elapsed.
     */
    async reopenClosed(req, res) {
        try {
            const b = req.body || {};
            const r = await CycleService.reopenClosed(
                Number(req.params.id),
                { closesAt: b.closesAt, reason: b.reason },
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /**
     * POST /cycles/:id/closure-proposal/decide {decision, reason} — A8.
     * `accepted` closes through the honest close; `declined` files the proposal
     * with its reason and the campaign carries on. Nothing is ever auto-closed.
     */
    async decideClosureProposal(req, res) {
        try {
            const b = req.body || {};
            const locale = (req.user && req.user.locale) || 'fr';
            const r = await CycleService.decideClosureProposal(
                Number(req.params.id),
                { decision: b.decision, reason: b.reason },
                req.user,
                { emit: (name, data) => require('../jobs').emitEvent(name, { ...data, locale }) }
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /**
     * GET /cycles/off-campaign.json — A6. Measurements attached to NO campaign:
     * allowed, dated, labelled `hors_campagne`, and never part of a completion
     * rate — the response says so in `countedInCompletionRate: false`.
     */
    async offCampaignJson(req, res) {
        try {
            const scope = await CycleService.resolveScope(req.user);
            const [summary, rows] = await Promise.all([
                CycleService.offCampaignSummary(req.user, { scope }),
                CycleService.offCampaignMeasurements(req.user, {
                    employeeId: req.query.employeeId,
                    limit: req.query.limit,
                    scope,
                }),
            ]);
            return res.json({ ok: true, ...summary, rows });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /**
     * GET /cycles/:id/write-gate.json — the campaign write gate, readable.
     * Exposed so any surface (and any other lot) can ask "does this campaign
     * accept a write?" and get back the exact refusal sentence it must show.
     */
    async writeGateJson(req, res) {
        try {
            const gate = await CycleService.cycleWriteGate(Number(req.params.id), {
                allowReview: String(req.query.allowReview || '') === 'true',
                t: (k, v) => t(req, k, (v && v.defaultValue) || k, v),
            });
            return res.json({ ok: true, ...gate });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    // ---- Roster (manage_cycles, scoped) -----------------------------------

    /** PERSON-level exclusion with a written reason + category (never skill-level). */
    async exclude(req, res) {
        try {
            const b = req.body || {};
            const r = await CycleService.excludeParticipant(
                Number(req.params.id),
                Number(req.params.employeeId),
                { reason: b.reason, category: b.category, until: b.until },
                req.user
            );
            if (!r.changed) throw new Error('nothing_changed');
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /**
     * POST /cycles/:id/participants/exclude-bulk
     *   { employeeIds: [], reason, category, until }  — the ticked rows, or
     *   { filter: {state,q,siteId[],…}, reason, … }   — everyone matching the filter.
     * One transaction, one audit row per person.
     */
    async excludeBulk(req, res) {
        try {
            const b = req.body || {};
            const target =
                b.filter && typeof b.filter === 'object'
                    ? { filter: CycleService.parseFilters(b.filter) }
                    : { employeeIds: b.employeeIds };
            const r = await CycleService.excludeBulk(
                Number(req.params.id),
                target,
                { reason: b.reason, category: b.category, until: b.until },
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** Put an excused person back on the campaign. */
    async include(req, res) {
        try {
            const r = await CycleService.includeParticipant(
                Number(req.params.id),
                Number(req.params.employeeId),
                req.user
            );
            if (!r.changed) throw new Error('nothing_changed');
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /** POST /cycles/:id/participants/:employeeId/reviewer {supervisorId | adminId}. */
    async assignReviewer(req, res) {
        try {
            const b = req.body || {};
            const r = await CycleService.assignReviewer(
                Number(req.params.id),
                Number(req.params.employeeId),
                { supervisorId: b.supervisorId, adminId: b.adminId },
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    /**
     * POST /cycles/:id/nudge {employeeIds[] | all, supervisorId, siteId} — manual
     * chase. A manager reaches only their own reports (the
     * service scopes through findGovernedIds); an admin their clearance.
     */
    async nudge(req, res) {
        try {
            const b = req.body || {};
            const r = await CycleService.nudge(
                Number(req.params.id),
                {
                    employeeIds: b.employeeIds,
                    all: b.all === true || b.all === 'true',
                    supervisorId: b.supervisorId,
                    siteId: b.siteId,
                    states: b.states,
                },
                req.user
            );
            return res.json({ ok: true, ...r });
        } catch (err) {
            return fail(req, res, err);
        }
    }

    // ---- Authority ---------------------------------------------------------

    /**
     * Launching / extending / reopening / closing enrols or ends the WHOLE
     * campaign, so it is superadmin-only (the route enforces this too). A
     * site-scoped admin with manage_cycles keeps the console and person-level
     * roster control, but cannot fire or end a company-wide campaign.
     */
    static canLaunch(user) {
        return RBACService.isSuperAdmin(user);
    }

    static canManage(user) {
        if (!user || user.userType !== 'admin') return false;
        if (user.role === 'superadmin') return true;
        if (user.role === 'viewer') return false;
        return Array.isArray(user.permissions) && user.permissions.includes('manage_cycles');
    }

    /** Managers chase their own reports; admins holding manage_cycles chase their clearance. */
    static canNudge(user) {
        return !!user && (user.userType === 'manager' || CycleController.canManage(user));
    }

    /**
     * Route guard for the lifecycle actions: SuperAdmin only, answered as a JSON
     * 403 with a stable code for the console's fetch calls (requireSuperAdmin
     * would 302 to /dashboard), and as the explanatory 403 page otherwise.
     */
    static requireLifecycle(req, res, next) {
        if (req.isAuthenticated && req.isAuthenticated() && RBACService.isSuperAdmin(req.user))
            return next();
        if (wantsJson(req)) {
            return res.status(403).json({
                ok: false,
                code: 'superadmin_required',
                error: t(
                    req,
                    'admin:cyc_err_superadmin_required',
                    'Réservé au super-administrateur.'
                ),
            });
        }
        return denyPermission(req, res, ['manage_cycles']);
    }

    /** Route guard for chasing: manager, or admin holding manage_cycles (JSON-aware). */
    static requireNudge(req, res, next) {
        if (req.isAuthenticated && req.isAuthenticated() && CycleController.canNudge(req.user))
            return next();
        return denyPermission(req, res, ['manage_cycles']);
    }
}

module.exports = new CycleController();
module.exports.CycleController = CycleController;
