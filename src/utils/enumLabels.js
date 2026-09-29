'use strict';

/**
 * enumLabels — one shared French-first dictionary for the raw enum values that
 * SERVER-RENDERED EJS tables print (workflow states, dispute levels, levels, box
 * status, scope types, opportunity kinds, readiness bands). Mirrors the client
 * public/js/enum-labels.js so JS-rendered and server-rendered tables read the same.
 * In non-French locales it humanizes the raw value (already English).
 *
 * Two call shapes:
 *   enumLabel(value, lang)            — legacy generic dictionary (kept for every caller)
 *   enumLabel(kind, value, t[, lang]) — KIND-aware: resolves `admin:enum_<kind>_<value>`
 *                                       through the request translator, so a cycle
 *                                       `closed` reads « Clôturée » and an admin
 *                                       `viewer` « Lecteur » in either language.
 */
const FR = {
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
    low: 'Faible',
    medium: 'Moyen',
    high: 'Élevé',
    critical: 'Critique',
    unknown: '—',
    healthy: 'Sain',
    moderate: 'Modéré',
    'at-risk': 'À risque',
    archived: 'Archivé',
    L0: 'N0',
    L1: 'N1',
    L2: 'N2 (RH)',
    org: 'Organisation',
    site: 'Site',
    department: 'Département',
    service: 'Service',
    employee: 'Employé',
    coaching: 'Coaching',
    mentoring: 'Mentorat',
    gig: 'Mission',
    secondment: 'Détachement',
    role: 'Poste',
    project: 'Projet',
    ready_now: 'Prêt maintenant',
    ready_1_2y: 'Prêt 1–2 ans',
    ready_3y: 'Prêt 3 ans+',
    emergency: 'Relève d’urgence',
};

/**
 * Enum families with a dedicated locale key per value (`admin:enum_<kind>_<value>`
 * in locales/{fr,en}/admin.json). Listing the values here lets the parity test
 * prove every value has both translations.
 */
const KINDS = {
    cycle_status: ['draft', 'open', 'locked', 'closed', 'cancelled', 'archived'],
    sa_state: [
        'draft',
        'submitted',
        'under_review',
        'reviewed',
        'approved',
        'rejected',
        'changes_requested',
        'arbitration',
        'disputed',
    ],
    admin_role: ['superadmin', 'localadmin', 'viewer'],
    api_key_status: ['active', 'revoked', 'expired'],
    schedule_frequency: ['daily', 'weekly', 'monthly'],
    movement_status: ['active', 'inactive', 'voided', 'erased', 'reactivated', 'deactivated'],
};

function humanize(k) {
    return String(k)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isFr(lang) {
    return !!lang && String(lang).slice(0, 2).toLowerCase() === 'fr';
}

function genericLabel(value, lang) {
    if (value == null || value === '') return '';
    const k = String(value);
    if (!isFr(lang)) return humanize(k);
    return FR[k] || FR[k.toLowerCase()] || humanize(k);
}

function kindLabel(kind, value, t, lang) {
    if (value == null || value === '') return '';
    const key = `admin:enum_${kind}_${String(value).toLowerCase()}`;
    if (typeof t === 'function') {
        const s = t(key);
        // i18next echoes the key (with or without namespace) when it is missing.
        if (s && s !== key && s !== key.slice('admin:'.length)) return s;
    }
    // No translator or no key: the generic dictionary, in the caller's language
    // (or the translator's, when it carries one).
    const lng = lang || (t && t.lng) || (t && t.language) || 'fr';
    return genericLabel(value, lng);
}

function enumLabel(a, b, c, d) {
    if (Object.prototype.hasOwnProperty.call(KINDS, a)) return kindLabel(a, b, c, d);
    return genericLabel(a, b);
}

module.exports = { enumLabel, kindLabel, genericLabel, FR, KINDS };
