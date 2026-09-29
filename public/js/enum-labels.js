/* eslint-env browser */
/**
 * enum-labels.js — one shared French-first dictionary for the raw enum values that
 * client-side console tables render (workflow states, levels, dispute levels, box
 * status, scope types, opportunity kinds, readiness bands). Fixes the pervasive
 * "raw English enum on a French-first UI" leak the design review flagged, in one
 * place. window.EL(value[, fallback]).
 *
 * In non-French locales it returns a humanized (Title Case) form of the raw value,
 * which is already English — so both languages read naturally with no per-call work.
 */
(function () {
    'use strict';
    var M = {
        // Workflow / generic lifecycle states
        draft: 'Brouillon',
        submitted: 'Soumis',
        under_review: 'En revue',
        reviewed: 'Évalué',
        approved: 'Approuvé',
        rejected: 'Rejeté',
        arbitration: 'Arbitrage',
        changes_requested: 'Modifications demandées',
        active: 'Actif',
        proposed: 'Proposé',
        closed: 'Clôturé',
        cancelled: 'Annulé',
        completed: 'Terminé',
        closed_success: 'Clôturé (succès)',
        closed_failure: 'Clôturé (échec)',
        in_progress: 'En cours',
        pending: 'En attente',
        open: 'Ouvert',
        escalated: 'Escaladé',
        resolved: 'Résolu',
        auto_finalized: 'Finalisé automatiquement',
        disputed: 'Contesté',
        finalized: 'Finalisé',
        provisional: 'Provisoire',
        assigned: 'Assigné',
        accepted: 'Acceptée',
        declined: 'Refusée',
        applied: 'Candidaté',
        // Levels / risk
        low: 'Faible',
        medium: 'Moyen',
        high: 'Élevé',
        critical: 'Critique',
        unknown: '—',
        healthy: 'Sain',
        moderate: 'Modéré',
        'at-risk': 'À risque',
        // 9-box + dispute + scope
        archived: 'Archivé',
        L0: 'N0',
        L1: 'N1',
        L2: 'N2 (RH)',
        org: 'Organisation',
        site: 'Site',
        department: 'Département',
        service: 'Service',
        employee: 'Employé',
        // Coaching kinds
        coaching: 'Coaching',
        mentoring: 'Mentorat',
        // Opportunity kinds
        gig: 'Mission',
        secondment: 'Détachement',
        role: 'Poste',
        project: 'Projet',
        // Readiness bands
        ready_now: 'Prêt maintenant',
        ready_1_2y: 'Prêt 1–2 ans',
        ready_3y: 'Prêt 3 ans+',
        emergency: 'Relève d’urgence',
    };
    function humanize(k) {
        return String(k)
            .replace(/_/g, ' ')
            .replace(/\b\w/g, function (c) {
                return c.toUpperCase();
            });
    }
    window.EL = function (v, fallback) {
        if (v == null || v === '') return fallback !== undefined ? fallback : '';
        var k = String(v);
        var lang = document.documentElement.getAttribute('lang') || 'fr';
        if (lang.indexOf('fr') !== 0) return fallback !== undefined ? fallback : humanize(k);
        return M[k] || M[k.toLowerCase()] || (fallback !== undefined ? fallback : humanize(k));
    };
})();
