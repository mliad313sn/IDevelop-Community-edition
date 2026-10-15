'use strict';

/**
 * notificationCatalogue — the ONE declaration of every notification kind
 * IDevelop emits (in-app, e-mail, digest and outgoing webhook alike).
 *
 * The per-kind maps used to live as static getters on NotificationService;
 * they were moved here unchanged, and NotificationService re-exposes each of
 * them (NotificationService.KIND_META and so on), so no caller changes:
 *
 *   KIND_LABELS    English subject fallback per kind (kinds older than KIND_META)
 *   KIND_META      { icon, link, title:{fr,en}, forceLink? } per kind
 *   KIND_POLICY    e-mail tier per kind: 'immediate' | 'digest' | 'none'
 *   KIND_SUBTITLE  (payload, lang) => string|null: a complement to the title,
 *                  shown in the app and in the body of a mail, NEVER in a subject
 *   KIND_MESSAGES  { fr, en } body sentence per kind (never payload-interpolated)
 *
 * and declares, for every kind, what the platform needs to know about it:
 *
 *   KIND_SUBJECT   a neutral { fr, en } subject for the kinds whose title states
 *                  a decision or a person's status: a subject is read on a lock
 *                  screen and in shared mailboxes, so it never says « rejected »,
 *                  « blocked » or « performance plan »
 *   KIND_SEVERITY  'critique' | 'echeance' | 'action' | 'favorable' | 'info'
 *   MANDATORY      safety and security kinds: sent whatever the recipient's own
 *                  e-mail switch and the per-domain toggles say (never when the
 *                  global e-mail switch is off or SMTP is not configured)
 *   WEBHOOK        what may leave by outgoing webhook: 'default' (the
 *                  WebhookService allow-list), 'opt-in' (360° feedback,
 *                  one-to-one and HRIS sync kinds, only when a SuperAdmin lists
 *                  them) or 'never'
 *   category       the preference category of the kind (categoryOf)
 *
 * Every property is a GETTER returning a fresh object, so a caller mutating one
 * copy never affects another. `describe(kind)` returns the whole declaration of
 * one kind; `isDeclared(kind)` is what NotificationService checks before it
 * writes a row (an undeclared kind is reported, see NotificationService).
 *
 * The tests pin the contract: every kind written by a notify / enqueue call in
 * src/ is declared here (tests/unit/notificationCatalogue.test.js), and every
 * kind any test suite emits is declared too (tests/helpers/dbSuiteLockSetup.js).
 */

/** Families whose kinds leave by webhook only on a SuperAdmin opt-in (decision 8). */
const WEBHOOK_OPT_IN_FAMILIES = ['feedback360.', 'oneonone.', 'hris.sync.'];

/**
 * The kinds an outgoing webhook carries by default. It is the same list as
 * WebhookService.EMITTABLE_EVENTS (a test keeps the two equal).
 */
const WEBHOOK_DEFAULT = [
    'lifecycle.joiner',
    'lifecycle.mover',
    'lifecycle.leaver',
    'cycle.opened',
    'cycle.closed',
    'sa.submitted',
    'sa.approved',
    'sa.manager_validated',
    'review.completed',
    'idp.created',
    'idp.activated',
    'coaching.created',
    'coaching.validated',
    'lms.assigned',
    'lms.due',
    'cert.expiry',
    'certification.revoked',
    'coverage.breach',
    'coverage.predicted',
    'mobility.opportunity_posted',
];

/**
 * Mail-only kinds: mails the platform composes itself (the daily digest, the
 * SMTP test, the account mails). They have no in-app row and are never sent
 * by webhook. The account mails are mandatory: they concern access to the
 * account and carry no unsubscribe header.
 */
const MAIL_ONLY = {
    'digest.daily': {
        icon: 'fa-envelope',
        title: { fr: 'Votre récapitulatif', en: 'Your summary' },
        link: '/notifications',
    },
    'ops.smtp_test': {
        icon: 'fa-envelope-circle-check',
        title: { fr: 'E-mail de test', en: 'Test e-mail' },
        link: '/app-settings',
        mandatory: true,
    },
    'account.welcome': {
        icon: 'fa-door-open',
        title: { fr: 'Bienvenue : votre accès', en: 'Welcome: your access' },
        link: '/login',
        mandatory: true,
    },
    'account.setup': {
        icon: 'fa-key',
        title: { fr: 'Définissez votre mot de passe', en: 'Set your password' },
        link: '/login',
        mandatory: true,
    },
    'account.password_reset': {
        icon: 'fa-key',
        title: { fr: 'Réinitialisez votre mot de passe', en: 'Reset your password' },
        link: '/login',
        mandatory: true,
    },
    'account.email_changed': {
        icon: 'fa-at',
        title: {
            fr: 'L’adresse e-mail de votre compte a changé',
            en: 'The e-mail address of your account changed',
        },
        link: '/account',
        mandatory: true,
    },
};

/** Preference category per family (the first segment of the kind). */
const FAMILY_CATEGORY = {
    sa: 'evaluations',
    cycle: 'evaluations',
    review: 'evaluations',
    mc: 'evaluations',
    dispute: 'evaluations',
    idp: 'development',
    coaching: 'development',
    lms: 'development',
    pip: 'development',
    talent: 'development',
    recognition: 'development',
    mobility: 'development',
    survey: 'development',
    feedback360: 'development',
    oneonone: 'development',
    cert: 'compliance',
    certification: 'compliance',
    coverage: 'compliance',
    safety: 'compliance',
    ninebox: 'talent',
    succession: 'talent',
    continuity: 'talent',
    retention: 'talent',
    planning: 'talent',
    lifecycle: 'people',
    onboarding: 'people',
    handover: 'people',
    report: 'reports',
    manager_digest: 'reports',
    dept_digest: 'reports',
    dept_brief: 'reports',
    digest: 'reports',
    access: 'account',
    account: 'account',
    admin: 'account',
    security: 'account',
    sso: 'account',
    privacy: 'account',
    ops: 'account',
};

/** The preference categories, in display order; the last three are mandatory. */
const CATEGORIES = [
    'evaluations',
    'development',
    'compliance',
    'talent',
    'people',
    'reports',
    'account',
    'other',
    'safety',
    'security',
];

/** The label of each preference category, FR and EN. */
const CATEGORY_LABELS = {
    evaluations: { fr: 'Évaluations et campagnes', en: 'Assessments and campaigns' },
    development: { fr: 'Développement', en: 'Development' },
    compliance: { fr: 'Conformité', en: 'Compliance' },
    talent: { fr: 'Talents et relève', en: 'Talent and succession' },
    people: { fr: 'Arrivées, mobilités et départs', en: 'Joiners, movers and leavers' },
    reports: { fr: 'Rapports et récapitulatifs', en: 'Reports and summaries' },
    account: { fr: 'Compte et administration', en: 'Account and administration' },
    other: { fr: 'Autres', en: 'Other' },
    safety: { fr: 'Sécurité au travail (obligatoire)', en: 'Workplace safety (mandatory)' },
    security: { fr: 'Sécurité des comptes (obligatoire)', en: 'Account security (mandatory)' },
};

/**
 * Severity levels. Red is « critique » only; « action » takes the tenant's
 * brand colour, never red.
 */
const SEVERITY_LEVELS = {
    critique: { label: { fr: 'Critique', en: 'Critical' }, color: '#b91c1c' },
    action: { label: { fr: 'Action requise', en: 'Action required' }, color: null },
    echeance: { label: { fr: 'Échéance', en: 'Deadline' }, color: '#b45309' },
    info: { label: { fr: 'Information', en: 'Information' }, color: '#475569' },
    favorable: { label: { fr: 'Décision favorable', en: 'Favourable decision' }, color: '#15803d' },
};

const catalogue = {
    /** Human-readable subject lines per event kind. */
    get KIND_LABELS() {
        return {
            // 3.23.21 safety-competency gate transitions
            'safety.blocked': 'Your safety clearance is blocked',
            'safety.expiring': 'Your safety clearance is expiring soon',
            'safety.blocked.team': 'A team member’s safety clearance is blocked',
            'safety.expiring.team': 'A team member’s safety clearance is expiring soon',
            // Safety-gate waivers and contests (migration 174)
            'safety.waiver_granted': 'You are authorised by a safety waiver',
            'safety.waiver_granted.team': 'A team member is authorised by a safety waiver',
            'safety.waiver_ended': 'Your safety waiver is over',
            'safety.waiver_ended.team': 'A team member’s safety waiver is over',
            'safety.contest.review': 'A safety clearance contest needs your decision',
            'safety.contest.decided': 'A safety clearance contest has a decision',
            // SA-38: scheduled reports reach accounts in the app, never an attachment.
            'report.schedule_ready': 'Your scheduled report is ready',
            'report.schedule_suspended': 'A report schedule was suspended',
            'sa.submitted': 'Self-assessment submitted',
            'sa.changes_requested': 'Changes requested on your self-assessment',
            'sa.approved': 'Your self-assessment was approved',
            'sa.rejected': 'Your self-assessment was rejected',
            'sa.manager_validated': 'Your assessment was validated by management',
            //  / M-05 — the five kinds shipped by the cancellation and
            // request-for-change work with NO catalogue entry at all.
            'sa.cancelled': 'A self-assessment was cancelled',
            // SA-42: a SuperAdmin reset an assessment so it can be redone.
            'sa.reset_for_redo': 'Resume your assessment',
            'sa.review_reset': 'An assessment needs reviewing again',
            'sa.change_request_raised': 'A request for change awaits your decision',
            // the SUBJECT of a request raised by someone else was told
            // nothing at all; only the decider was written to.
            'sa.change_request_raised_on_me': 'A request for change was raised on your assessment',
            'sa.change_request_granted': 'A request for change was granted',
            'sa.change_request_refused': 'A request for change was refused',
            'talent.task.created': 'A follow-up task is assigned to you',
            // Same class as the five above, found by sweeping every kind emitted
            // in src/ and every kind already stored in `notifications`:
            // 'certification.revoked' is raised by CertificationService:187 and
            // had no entry anywhere; 'review.due' has no emitter left but one row
            // still sits in an inbox (notification #1, admin:1) and rendered as
            // its own slug.
            'certification.revoked': 'A certification was revoked',
            'privacy.objection': 'Someone objected to automated profiling',
            'privacy.trigger_paused': 'An automatic development action awaits your review',
            'review.due': 'A review is due',
            'review.completed': 'A supervisor review was completed',
            'mc.submitted': 'An action awaits your approval',
            'mc.approved': 'Your submitted action was approved',
            'mc.rejected': 'Your submitted action was rejected',
            'pip.created': 'A Performance Improvement Plan was created',
            'pip.activated': 'Your Performance Improvement Plan is now active',
            'pip.closed': 'A Performance Improvement Plan was closed',
            'idp.created': 'An Individual Development Plan was created',
            'idp.activated': 'Your Individual Development Plan is now active',
            'coaching.created': 'A coaching plan was created',
            'coaching.validated': 'A coaching plan was completed',
            'feedback360.nominate': 'Choose who gives you 360° feedback',
            'feedback360.approve': '360° feedback nominations to approve',
            'feedback360.invited': 'You are asked for 360° feedback',
            'feedback360.reminder': 'A 360° feedback questionnaire is waiting for you',
            'feedback360.closed': 'A 360° feedback report is ready to release',
            'feedback360.released': 'Your 360° feedback report is available',
            'oneonone.topic_added': 'A topic was added to your next one-to-one',
            'ninebox.submitted': 'A 9-box placement was submitted for review',
            'ninebox.approved': 'A 9-box placement was approved',
            'dispute.opened': 'A rating dispute was opened',
            'dispute.escalated': 'A dispute was escalated',
            'dispute.resolved': 'A dispute was resolved',
            'lifecycle.joiner': 'Welcome — your account is ready',
            'lifecycle.mover': 'Your role assignment has changed',
            'cycle.opened': 'An assessment cycle is now open',
            'cycle.closed': 'An assessment cycle has closed',
            'admin.created': 'Your administrator account was created',
        };
    },

    /**
     * Per-kind display metadata for the in-app centre: an icon and a FALLBACK
     * deep link used only when the stored payload has no explicit `link`. Wiring
     * a `link` into the notify payload at the event site is always preferred
     * (it can be id-specific); this map keeps older/link-less rows still clickable.
     */
    get KIND_META() {
        // `title` carries BOTH languages ({ fr, en }); resolve at render time via
        // NotificationService._localizeTitle(meta.title, locale). FR is primary —
        // it is the fallback whenever a locale/translation is missing.
        return {
            'sa.submitted': {
                icon: 'fa-clipboard-check',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Auto-évaluation à réviser', en: 'Self-assessment to review' },
            },
            'sa.changes_requested': {
                icon: 'fa-pen-to-square',
                link: '/employee/self-assessment',
                title: {
                    fr: 'Modifications demandées sur votre auto-évaluation',
                    en: 'Changes requested on your self-assessment',
                },
            },
            // The three DECISION notifications land on the review page, not on the
            // status list: a decision is only useful next to the level that was
            // retained and the reason given for it. /employee/assessment-status
            // answers "where is my file"; /employee/supervisor-reviews answers
            // "what was decided about me, and why".
            'sa.approved': {
                icon: 'fa-circle-check',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre auto-évaluation a été approuvée',
                    en: 'Your self-assessment was approved',
                },
            },
            'sa.rejected': {
                icon: 'fa-circle-xmark',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre auto-évaluation a été rejetée',
                    en: 'Your self-assessment was rejected',
                },
            },
            'sa.manager_validated': {
                icon: 'fa-clipboard-check',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre évaluation a été validée par le management',
                    en: 'Your assessment was validated by management',
                },
            },
            // ----  / M-05 — les CINQ `kind` livrés sans entrée de catalogue.
            //      Mesuré avant correction : `present` retombait sur `n.kind`, donc
            //      le centre de notifications et la cloche affichaient le slug technique
            //      « sa.cancelled », « sa.change_request_raised »… À L'IDENTIQUE en
            //      français et en anglais — absence de libellé, pas trou de traduction —
            //      avec l'icône générique fa-bell et le lien de repli /dashboard.
            //      Émetteurs : SelfAssessmentWorkflowService (_notifyEmployee),
            //      AssessmentChangeRequestService (_notifyDeciders / _notifyRequester),
            //      DevelopmentTriggerService (_notify).
            //
            //      Le destinataire de `sa.cancelled` est le SUJET : sa ligne est annulée,
            //      aucune revue n'a été décidée (supervisor_reviews n'est pas touchée),
            //      donc l'atterrissage est « où en est mon dossier » et non la page des
            //      décisions de revue.
            // SA-42: a SuperAdmin reset the assessment for redo. The person may
            // do it again and their reviewer will see it again. No reason and no
            // name in the title or the body.
            'sa.reset_for_redo': {
                icon: 'fa-rotate-left',
                link: '/employee/self-assessment',
                title: { fr: 'Reprenez votre évaluation', en: 'Resume your assessment' },
            },
            'sa.review_reset': {
                icon: 'fa-rotate-left',
                link: '/supervisor/self-assessment-reviews',
                title: {
                    fr: 'Une évaluation est à revoir',
                    en: 'An assessment needs reviewing again',
                },
            },
            'sa.cancelled': {
                icon: 'fa-ban',
                link: '/employee/assessment-status',
                title: {
                    fr: 'Votre auto-évaluation a été annulée',
                    en: 'Your self-assessment was cancelled',
                },
            },
            //      `raised` va au DÉCIDEUR (superviseur, à défaut manager) : sa file.
            'sa.change_request_raised': {
                icon: 'fa-pen-to-square',
                link: '/assessment-changes',
                title: {
                    fr: 'Une demande de modification attend votre décision',
                    en: 'A request for change awaits your decision',
                },
            },
            //      le SUJET d'une demande déposée par son superviseur ne
            //      recevait RIEN (mesuré sur la demande #35 : une seule notification,
            //      pour le décideur). `kind` distinct de `raised` parce que le libellé
            //      de `raised` dit « attend VOTRE décision » : le sujet ne décide rien,
            //      il doit savoir que la réouverture de SON évaluation est demandée.
            'sa.change_request_raised_on_me': {
                icon: 'fa-pen-to-square',
                link: '/assessment-changes',
                title: {
                    fr: 'Une demande de modification a été déposée sur votre évaluation',
                    en: 'A request for change was raised on your assessment',
                },
            },
            //      `granted` est notifié DEUX FOIS — au demandeur (qui peut être le
            //      superviseur) et au sujet — donc le libellé reste neutre : dire
            //      « votre auto-évaluation » mentirait au superviseur demandeur. Le
            //      lien de repli sert le sujet, qui peut de nouveau saisir ; le
            //      demandeur, lui, reçoit /assessment-changes dans son payload.
            'sa.change_request_granted': {
                icon: 'fa-lock-open',
                link: '/employee/self-assessment',
                title: {
                    fr: 'Une demande de modification a été accordée',
                    en: 'A request for change was granted',
                },
            },
            'sa.change_request_refused': {
                icon: 'fa-circle-xmark',
                link: '/assessment-changes',
                title: {
                    fr: 'Votre demande de modification a été refusée',
                    en: 'Your request for change was refused',
                },
            },
            //      la case basse produit une TÂCHE manager, jamais un PIP d'office.
            //      Le libellé ne nomme ni la case, ni la performance, ni le potentiel —
            //      même règle de confidentialité que les autres kinds 9-box.
            'talent.task.created': {
                icon: 'fa-list-check',
                link: '/v2/pip',
                title: {
                    fr: 'Une action de suivi vous est assignée',
                    en: 'A follow-up task is assigned to you',
                },
            },
            'cycle.reminder': {
                icon: 'fa-clock',
                link: '/employee/self-assessment',
                title: { fr: 'Auto-évaluation à soumettre', en: 'Self-assessment to submit' },
            },
            'cycle.escalation': {
                icon: 'fa-triangle-exclamation',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Revues à finaliser', en: 'Reviews to finalize' },
            },
            'review.completed': {
                icon: 'fa-clipboard-check',
                link: '/employee/assessment-status',
                title: { fr: 'Une revue a été complétée', en: 'A review was completed' },
            },
            // ---- Même classe que les cinq `kind` de E-03/M-05, relevée en
            //      balayant TOUS les kinds émis dans src/ et tous ceux déjà
            //      stockés en base : deux autres n'avaient aucune entrée.
            //      `review.due` n'a plus d'émetteur mais une ligne survit dans
            //      une boîte (notification #1, admin:1) et s'affichait
            //      « review.due » ; sa destination est la file de revues du
            //      superviseur, la même que `sa.submitted`.
            'review.due': {
                icon: 'fa-clipboard-list',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Une revue reste à réaliser', en: 'A review is still to be done' },
            },
            //      `certification.revoked` est émis vers l'EMPLOYÉ
            //      (CertificationService:187) avec la compétence et le motif dans
            //      le payload ; il atterrit sur ses propres certifications, comme
            //      `cert.expiry`. Le libellé ne nomme pas la compétence : c'est le
            //      motif, écrit par le décideur, que present rend.
            'certification.revoked': {
                icon: 'fa-id-badge',
                link: '/employee/my-certifications',
                title: {
                    fr: 'Une certification vous a été retirée',
                    en: 'A certification of yours was revoked',
                },
            },
            'mc.submitted': {
                icon: 'fa-user-shield',
                link: '/v2/uam/maker-checker/queue',
                title: {
                    fr: 'Une action attend votre approbation',
                    en: 'An action awaits your approval',
                },
            },
            'mc.approved': {
                icon: 'fa-circle-check',
                link: '/dashboard',
                title: { fr: 'Votre action a été approuvée', en: 'Your action was approved' },
            },
            'mc.rejected': {
                icon: 'fa-circle-xmark',
                link: '/dashboard',
                title: { fr: 'Votre action a été rejetée', en: 'Your action was rejected' },
            },
            'pip.created': {
                icon: 'fa-user-clock',
                link: '/employee/dashboard',
                title: {
                    fr: 'Un plan de performance vous concerne',
                    en: 'A performance plan concerns you',
                },
            },
            'pip.activated': {
                icon: 'fa-user-clock',
                link: '/employee/dashboard',
                title: {
                    fr: 'Votre plan de performance est actif',
                    en: 'Your performance plan is now active',
                },
            },
            'pip.closed': {
                icon: 'fa-user-check',
                link: '/employee/dashboard',
                title: {
                    fr: 'Un plan de performance a été clôturé',
                    en: 'A performance plan was closed',
                },
            },
            'idp.created': {
                icon: 'fa-seedling',
                link: '/v2/idp',
                title: {
                    fr: 'Un plan de développement a été créé',
                    en: 'A development plan was created',
                },
            },
            'idp.activated': {
                icon: 'fa-seedling',
                link: '/v2/idp',
                title: {
                    fr: 'Votre plan de développement est actif',
                    en: 'Your development plan is now active',
                },
            },
            'coaching.created': {
                icon: 'fa-hands-helping',
                link: '/employee/my-coaching',
                title: { fr: 'Un plan de coaching a été créé', en: 'A coaching plan was created' },
            },
            'coaching.validated': {
                icon: 'fa-hands-helping',
                link: '/employee/my-coaching',
                title: {
                    fr: 'Un plan de coaching a été complété',
                    en: 'A coaching plan was completed',
                },
            },
            'feedback360.nominate': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Choisissez qui vous donne un feedback 360°',
                    en: 'Choose who gives you 360° feedback',
                },
            },
            'feedback360.approve': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Des propositions d’évaluateurs 360° attendent votre accord',
                    en: '360° feedback nominations await your approval',
                },
            },
            'feedback360.invited': {
                icon: 'fa-comments',
                link: '/feedback-360',
                title: {
                    fr: 'On vous demande un feedback 360°',
                    en: 'You are asked for 360° feedback',
                },
            },
            'feedback360.reminder': {
                icon: 'fa-comments',
                link: '/feedback-360',
                title: {
                    fr: 'Un questionnaire 360° vous attend',
                    en: 'A 360° feedback questionnaire is waiting for you',
                },
            },
            'feedback360.closed': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Un rapport 360° est prêt à être communiqué',
                    en: 'A 360° feedback report is ready to release',
                },
            },
            'feedback360.released': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Votre rapport 360° est disponible',
                    en: 'Your 360° feedback report is available',
                },
            },
            'oneonone.topic_added': {
                icon: 'fa-people-arrows',
                link: '/one-on-one',
                title: {
                    fr: 'Un sujet a été ajouté à votre prochain entretien individuel',
                    en: 'A topic was added to your next one-to-one',
                },
            },
            'dispute.opened': {
                icon: 'fa-scale-balanced',
                link: '/employee/assessment-status',
                title: { fr: 'Une contestation a été ouverte', en: 'A dispute was opened' },
            },
            'dispute.escalated': {
                icon: 'fa-scale-balanced',
                link: '/dashboard',
                title: { fr: 'Une contestation a été escaladée', en: 'A dispute was escalated' },
            },
            'dispute.resolved': {
                icon: 'fa-scale-balanced',
                link: '/employee/assessment-status',
                title: { fr: 'Une contestation a été résolue', en: 'A dispute was resolved' },
            },
            'ninebox.disclosed': {
                icon: 'fa-box-open',
                link: '/employee/dashboard',
                title: {
                    fr: 'Votre positionnement talent a été partagé avec vous',
                    en: 'Your talent placement was shared with you',
                },
            },
            // The two 9-box WORKFLOW kinds. They were in KIND_LABELS (email subjects)
            // and the policy map but had NO KIND_META, so present fell through to
            // the raw kind string and the bell rendered a literal "ninebox.approved".
            // Recipients are the reviewer / submitting manager, never the subject, so
            // both land on the manager-side grid (/talent/nine-box, requireManagerOrAdmin
            // — src/routes/index.js:379) and NOT on an employee page. Titles say a
            // placement moved; they never name the box, the performance or the potential.
            'ninebox.submitted': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Un positionnement talent attend votre revue',
                    en: 'A talent placement awaits your review',
                },
            },
            'ninebox.approved': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Un positionnement talent a été approuvé',
                    en: 'A talent placement was approved',
                },
            },
            'recognition.received': {
                icon: 'fa-award',
                link: '/employee/dashboard',
                title: { fr: 'Vous avez reçu une reconnaissance', en: 'You received recognition' },
            },
            // The expiry ladder alerts the EMPLOYEE four times (90/60/30 days, then
            // expired) because they are the person who must book the revalidation.
            // It used to land on /employee/dashboard, which shows no certification at
            // all — four alerts, nowhere to learn WHICH one or WHEN. It now lands on
            // the employee's own certification page. The TEAM copy goes to the
            // manager, so it lands on /compliance (manager or view_compliance), where
            // the scoped expiring-cert table already lives — never on the employee's
            // own page, which shows the reader's certifications and not their report's.
            'cert.expiry': {
                icon: 'fa-id-badge',
                link: '/employee/my-certifications',
                title: { fr: 'Certification à renouveler', en: 'Certification to renew' },
            },
            'cert.expiry.team': {
                icon: 'fa-id-badge',
                link: '/compliance',
                title: {
                    fr: "Certification d'un collaborateur à renouveler",
                    en: "A team member's certification needs renewal",
                },
            },
            'coverage.breach': {
                icon: 'fa-triangle-exclamation',
                link: '/dashboard',
                title: { fr: 'Couverture insuffisante', en: 'Insufficient coverage' },
            },
            'coverage.predicted': {
                icon: 'fa-triangle-exclamation',
                link: '/dashboard',
                title: { fr: 'Rupture de couverture prévue', en: 'Coverage gap predicted' },
            },
            // Batched variants: past the per-pass alert cap the coverage job sends ONE
            // notice to the manage_compliance audience instead of one page per rule
            // (a bulk rule generation can flip hundreds of rules at once).
            'coverage.breach.batch': {
                icon: 'fa-triangle-exclamation',
                link: '/compliance',
                title: { fr: 'Plusieurs ruptures de couverture', en: 'Multiple coverage breaches' },
            },
            'coverage.predicted.batch': {
                icon: 'fa-triangle-exclamation',
                link: '/compliance',
                title: {
                    fr: 'Plusieurs ruptures de couverture prévues',
                    en: 'Multiple predicted coverage breaches',
                },
            },
            'continuity.successor_ready': {
                icon: 'fa-people-roof',
                link: '/v2/continuity',
                title: { fr: 'Un successeur est prêt', en: 'A successor is ready' },
            },
            'onboarding.submitted': {
                icon: 'fa-user-plus',
                link: '/onboarding',
                title: { fr: "Nouvelle demande d'intégration", en: 'New onboarding request' },
            },
            'lifecycle.joiner': {
                icon: 'fa-door-open',
                link: '/dashboard',
                title: {
                    fr: 'Bienvenue — votre compte est prêt',
                    en: 'Welcome — your account is ready',
                },
            },
            'lifecycle.mover': {
                icon: 'fa-shuffle',
                link: '/employee/dashboard',
                title: { fr: 'Votre affectation a changé', en: 'Your assignment has changed' },
            },
            'cycle.opened': {
                icon: 'fa-calendar-check',
                link: '/employee/self-assessment',
                title: {
                    fr: "Une campagne d'évaluation est ouverte",
                    en: 'An assessment cycle is now open',
                },
            },
            'cycle.closed': {
                icon: 'fa-calendar-xmark',
                link: '/dashboard',
                title: {
                    fr: "Une campagne d'évaluation est clôturée",
                    en: 'An assessment cycle has closed',
                },
            },
            manager_digest: {
                icon: 'fa-chart-line',
                link: '/dashboard',
                title: {
                    fr: 'Récapitulatif hebdomadaire de votre équipe',
                    en: 'Weekly summary of your team',
                },
            },
            dept_digest: {
                icon: 'fa-chart-line',
                link: '/reports/dept-analytics',
                title: { fr: 'Récapitulatif départemental', en: 'Departmental summary' },
            },
            // ONE kind for all four cadences of the department brief — the cadence
            // travels in the payload. Four kinds would make the merge of §4.7
            // (weekly + monthly + quarterly + yearly falling due on 1 January, ONE
            // message) impossible to represent. The kind carries no dot, so it forms
            // its own family through split_part(kind,'.',1) in the notification
            // centre, which is why locales/*/chrome.json carry
            // `notif_family_dept_brief`: without it the raw slug leaks into the
            // family selector (views/pages/notifications/index.ejs:27).
            // The link is the FALLBACK — every brief carries its own
            // `payload.link = /reports/dept-brief/<id>`.
            dept_brief: {
                icon: 'fa-list-check',
                link: '/reports/dept-brief',
                title: { fr: 'Bilan de votre département', en: 'Your department brief' },
            },
            'idp.signoff_needed': {
                icon: 'fa-signature',
                link: '/v2/idp',
                title: {
                    fr: 'Un plan de développement attend votre signature',
                    en: 'A development plan awaits your signature',
                },
            },
            // Learner-facing kinds point at the LEARNER page. They used to point at
            // /v2/lms — the admin console — so the employee the notification was
            // written for was refused by the very link it gave them.
            'lms.assigned': {
                icon: 'fa-graduation-cap',
                link: '/employee/my-learning',
                title: {
                    fr: 'Une formation vous a été assignée',
                    en: 'A training course was assigned to you',
                },
            },
            'lms.due': {
                icon: 'fa-hourglass-half',
                link: '/employee/my-learning',
                title: {
                    fr: 'Une formation assignée reste à démarrer',
                    en: 'An assigned training course is still to start',
                },
            },
            // Goes to the SUPERVISOR, not the learner: a finished course now
            // proposes a level instead of setting one (rulebook §10), and this
            // is the nudge that stops the proposal sitting unseen forever.
            'lms.uplift_proposed': {
                icon: 'fa-user-graduate',
                link: '/v2/lms/uplifts',
                title: {
                    fr: 'Une formation terminée propose une élévation de niveau à valider',
                    en: 'A completed course proposes a level increase for your decision',
                },
            },
            // Recipient-appropriate landings. These four go to EMPLOYEES, and
            // /v2/cap is the manager/admin capability console (requireManagerOrAdmin,
            // src/routes/index.js) — an employee clicking through was bounced to
            // /dashboard. /employee/opportunities is the "Mon évolution" hub that
            // surfaces exactly this content (mobility, surveys, recognition) for
            // them. mobility.application_received stays on /v2/cap: its recipient
            // is the manager who posted the opportunity.
            'mobility.opportunity_posted': {
                icon: 'fa-briefcase',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une nouvelle opportunité pourrait vous correspondre',
                    en: 'A new opportunity may match your profile',
                },
            },
            'mobility.application_received': {
                icon: 'fa-user-check',
                link: '/v2/cap',
                title: {
                    fr: 'Une candidature a été reçue pour votre opportunité',
                    en: 'An application was received for your opportunity',
                },
            },
            'mobility.application_decided': {
                icon: 'fa-clipboard-check',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une décision a été prise sur votre candidature',
                    en: 'A decision was made on your application',
                },
            },
            'survey.published': {
                icon: 'fa-clipboard-question',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une enquête attend votre réponse',
                    en: 'A survey awaits your response',
                },
            },
            'survey.respond': {
                icon: 'fa-clipboard-question',
                link: '/employee/opportunities',
                title: {
                    fr: 'Rappel : une enquête attend votre réponse',
                    en: 'Reminder: a survey awaits your response',
                },
            },
            'lifecycle.leaver': {
                icon: 'fa-door-closed',
                link: '/v2/continuity',
                title: {
                    fr: 'Un départ requiert un plan de passation',
                    en: 'A departure requires a handover plan',
                },
            },
            // 3.23.18 R2 — the leaver cascade (LifecycleService) names the ACTIVE
            // people left without a reviewer. The payload link is per recipient
            // (admin → the leaver's record, line manager → continuity); this is
            // the fallback.
            'safety.blocked': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp',
                title: {
                    fr: 'Votre habilitation sécurité est bloquée',
                    en: 'Your safety clearance is blocked',
                },
            },
            'safety.expiring': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp',
                title: {
                    fr: 'Votre habilitation sécurité arrive à échéance',
                    en: 'Your safety clearance is expiring soon',
                },
            },
            'safety.blocked.team': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp/manage',
                title: {
                    fr: 'Habilitation sécurité bloquée dans votre équipe',
                    en: 'A team member’s safety clearance is blocked',
                },
            },
            'safety.expiring.team': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp/manage',
                title: {
                    fr: 'Habilitation sécurité d’un collaborateur bientôt échue',
                    en: 'A team member’s safety clearance is expiring soon',
                },
            },
            // Safety-gate waivers and contests (migration 174).
            'safety.waiver_granted': {
                icon: 'fa-user-shield',
                link: '/safety-gate/me',
                title: {
                    fr: 'Vous êtes autorisé(e) par une dérogation de sécurité',
                    en: 'You are authorised by a safety waiver',
                },
            },
            'safety.waiver_granted.team': {
                icon: 'fa-user-shield',
                link: '/safety-gate',
                title: {
                    fr: 'Un collaborateur est autorisé par une dérogation de sécurité',
                    en: 'A team member is authorised by a safety waiver',
                },
            },
            'safety.waiver_ended': {
                icon: 'fa-user-shield',
                link: '/safety-gate/me',
                title: {
                    fr: 'Votre dérogation de sécurité est terminée',
                    en: 'Your safety waiver is over',
                },
            },
            'safety.waiver_ended.team': {
                icon: 'fa-user-shield',
                link: '/safety-gate',
                title: {
                    fr: 'La dérogation de sécurité d’un collaborateur est terminée',
                    en: 'A team member’s safety waiver is over',
                },
            },
            'safety.contest.review': {
                icon: 'fa-scale-balanced',
                link: '/safety-gate',
                title: {
                    fr: 'Une contestation d’habilitation sécurité attend votre décision',
                    en: 'A safety clearance contest needs your decision',
                },
            },
            'safety.contest.decided': {
                icon: 'fa-scale-balanced',
                link: '/safety-gate/me',
                title: {
                    fr: 'Une contestation d’habilitation sécurité a reçu une décision',
                    en: 'A safety clearance contest has a decision',
                },
            },
            'lifecycle.reports_to_reassign': {
                icon: 'fa-people-arrows',
                link: '/v2/continuity',
                title: {
                    fr: 'Des collaborateurs sont à réaffecter après un départ',
                    en: 'Team members need a new reviewer after a departure',
                },
            },
            'access.review': {
                icon: 'fa-user-shield',
                link: '/admin/access-review',
                title: { fr: 'Revue des accès à réaliser', en: 'Access review to complete' },
            },
            // jobs/reminders.js prefers these two kinds when they are declared
            // (kindFor) and used to borrow 'access.review' for want of an entry.
            // Counts and days only, never a name.
            'account.dormant': {
                icon: 'fa-user-clock',
                link: '/admin/accounts',
                title: { fr: 'Des comptes inutilisés à vérifier', en: 'Unused accounts to review' },
            },
            'access.expiry': {
                icon: 'fa-hourglass-end',
                link: '/admins',
                title: {
                    fr: 'Des droits d’administration arrivent à échéance',
                    en: 'Administration rights are about to end',
                },
            },
            // No emitter left; kept so an old row still reads in both languages.
            'admin.created': {
                icon: 'fa-user-gear',
                link: '/account',
                title: {
                    fr: 'Votre compte administrateur a été créé',
                    en: 'Your administrator account was created',
                },
            },
            // The two weekly manager nudges raised by jobs/reminders.js. That job
            // deliberately falls back to another kind whenever KIND_META has no
            // entry (kindFor), so until now they borrowed 'ninebox.submitted' /
            // 'cycle.escalation' titles that described a different event. Their own
            // entries make the bell say what actually happened. Counts only — no
            // names, no placements.
            'ninebox.reassess_due': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Des positionnements talent sont à revoir',
                    en: 'Talent placements are due for review',
                },
            },
            'talent.plan_due': {
                icon: 'fa-list-check',
                link: '/talent/actions',
                title: {
                    fr: 'Des plans de votre équipe arrivent à échéance',
                    en: 'Plans in your team are coming due',
                },
            },
            // ---- Proactive continuity automation (jobs/succession-review,
            //      jobs/retention-recompute, jobs/reminders handover section,
            //      jobs/planning-digest). Key-person risk is the one exposure the
            //      platform used to surface ONLY to whoever happened to open
            //      /v2/continuity; these four kinds are what now go and find the
            //      responsible person. All four are AGGREGATED (one notification
            //      carrying a count, never one per row) and carry COUNTS ONLY —
            //      no employee name, no risk band, no placement.
            'succession.review_due': {
                icon: 'fa-people-roof',
                link: '/v2/continuity',
                title: {
                    fr: 'Des postes clés attendent votre revue de succession',
                    en: 'Key positions await your succession review',
                },
            },
            'handover.due': {
                icon: 'fa-people-arrows',
                link: '/v2/continuity',
                title: {
                    fr: 'Des plans de passation restent à finaliser',
                    en: 'Handover plans are still to be completed',
                },
            },
            // Retention risk is a `restricted` confidentiality tier (24_continuity.sql):
            // in-app only, count only, and it never names anyone — same rule as 9-box.
            'retention.risk_high': {
                icon: 'fa-user-minus',
                link: '/v2/continuity',
                title: {
                    fr: 'Risque de départ élevé dans votre équipe',
                    en: 'High retention risk in your team',
                },
            },
            'planning.digest': {
                icon: 'fa-calendar-days',
                link: '/dashboard',
                title: {
                    fr: 'Votre point mensuel de planification des effectifs',
                    en: 'Your monthly workforce-planning brief',
                },
            },
            // ---- operations alerts to SuperAdmins.
            //      Raised by JobRunService.alert — de-duplicated per day, in-app
            //      first, rolled into the daily digest e-mail (tier 'digest').
            'ops.job_failed': {
                icon: 'fa-heart-crack',
                link: '/admin/health',
                title: {
                    fr: 'Une tâche planifiée a échoué ou ne tourne plus',
                    en: 'A scheduled job failed or has stopped running',
                },
            },
            'ops.backup_stale': {
                icon: 'fa-database',
                link: '/admin/health',
                title: {
                    fr: 'Sauvegarde de la base absente ou trop ancienne',
                    en: 'Database backup missing or too old',
                },
            },
            'ops.hris_plan_ready': {
                icon: 'fa-people-arrows',
                link: '/admin/integrations/hris',
                title: {
                    fr: 'Synchronisation SIRH : un plan attend votre revue',
                    en: 'HRIS sync: a plan is waiting for your review',
                },
            },
            'ops.hris_sync_alert': {
                icon: 'fa-triangle-exclamation',
                link: '/admin/integrations/hris',
                title: {
                    fr: 'Synchronisation SIRH interrompue',
                    en: 'HRIS sync stopped',
                },
            },
            'ops.smtp_failed': {
                icon: 'fa-envelope-circle-check',
                link: '/admin/health',
                title: {
                    fr: 'L’envoi d’e-mails échoue (SMTP)',
                    en: 'E-mail delivery is failing (SMTP)',
                },
            },
            'ops.license': {
                icon: 'fa-file-contract',
                link: '/admin/license',
                title: {
                    fr: 'Licence expirée ou sièges dépassés',
                    en: 'Licence expired or seats exceeded',
                },
            },
            // SA-38: scheduled reports (report-scheduler.js, migration 172).
            'report.schedule_ready': {
                icon: 'fa-file-csv',
                link: '/reports/schedules',
                title: {
                    fr: 'Votre rapport programmé est prêt',
                    en: 'Your scheduled report is ready',
                },
            },
            'report.schedule_suspended': {
                icon: 'fa-pause-circle',
                link: '/reports/schedules',
                forceLink: true,
                title: {
                    fr: 'Un envoi de rapport programmé a été suspendu',
                    en: 'A report schedule was suspended',
                },
            },
            // ---- 3.23.20 (C2f): security alerts to every SuperAdmin.
            'security.breakglass_signin': {
                icon: 'fa-key',
                link: '/system-logs',
                title: {
                    fr: 'Connexion par l’accès de secours super administrateur',
                    en: 'Super administrator emergency-access sign-in',
                },
            },
            'security.superadmin_sso_refused': {
                icon: 'fa-user-shield',
                link: '/system-logs',
                title: {
                    fr: 'Connexion SSO refusée sur un compte super administrateur',
                    en: 'SSO sign-in refused on a super administrator account',
                },
            },
            'security.superadmin_mfa_changed': {
                icon: 'fa-shield-halved',
                link: '/admins',
                title: {
                    fr: 'Double authentification d’un super administrateur modifiée',
                    en: 'Super administrator two-factor authentication changed',
                },
            },
            'sso.migration_invite': {
                icon: 'fa-right-to-bracket',
                // The signed-in explanation (same text as the e-mail); /login took
                // a signed-in reader nowhere. Wins over the payload link, so the
                // notices already stored with '/login' open it too.
                link: '/account/sso-change',
                forceLink: true,
                title: {
                    fr: 'Connexion avec votre compte d’entreprise : ce qui change',
                    en: 'Signing in with your company account: what changes',
                },
            },
            'security.superadmin_password_reset': {
                icon: 'fa-key',
                link: '/admins',
                title: {
                    fr: 'Mot de passe d’un super administrateur réinitialisé',
                    en: 'Super administrator password reset',
                },
            },
            // Objection to automated profiling (GDPR art. 21): reviewed on the
            // works-council register page. The row names nobody.
            'privacy.objection': {
                icon: 'fa-hand',
                link: '/compliance/register',
                title: {
                    fr: 'Une personne s’est opposée au profilage automatisé',
                    en: 'Someone objected to automated profiling',
                },
            },
            'privacy.trigger_paused': {
                icon: 'fa-pause',
                link: '/compliance/register',
                title: {
                    fr: 'Une action de développement automatique attend votre examen',
                    en: 'An automatic development action awaits your review',
                },
            },
            // ---- Lockout model (progressive throttling, admin hard lock).
            'security.admin_account_locked': {
                icon: 'fa-lock',
                link: '/admins',
                title: {
                    fr: 'Compte administrateur verrouillé après des échecs de connexion',
                    en: 'Administrator account locked after failed sign-ins',
                },
            },
            'security.account_soft_locked': {
                icon: 'fa-user-lock',
                link: '/account',
                title: {
                    fr: 'Connexions ralenties sur votre compte',
                    en: 'Sign-ins slowed on your account',
                },
            },
        };
    },

    /**
     * Data-driven channel policy — email TIER per kind (the "no mailbox invasion"
     * core): 'immediate' (send now, still user-controllable via the category
     * toggle), 'digest' (in-app now; the daily digest emails it), 'none' (in-app
     * only, never email — e.g. confidential 9-box). A kind absent here falls back
     * to legacy category gating. Class is implied: obligations/criticals are
     * immediate, informational/engagement are digest.
     */
    get KIND_POLICY() {
        return {
            // Time-boxed obligation / security / SLA → immediate email
            'sa.changes_requested': 'immediate',
            'sa.reset_for_redo': 'immediate',
            'sa.rejected': 'immediate',
            'mc.submitted': 'immediate',
            'mc.rejected': 'immediate',
            'dispute.opened': 'immediate',
            'dispute.escalated': 'immediate',
            'dispute.resolved': 'immediate',
            'pip.activated': 'immediate',
            'coverage.breach': 'immediate',
            'coverage.predicted': 'immediate',
            'coverage.breach.batch': 'immediate',
            'coverage.predicted.batch': 'immediate',
            'cert.expiry': 'immediate',
            'cycle.reminder': 'immediate',
            'cycle.escalation': 'immediate',
            // Informational / engagement → daily digest only (no standalone email)
            'sa.submitted': 'digest',
            'sa.review_reset': 'digest',
            'sa.approved': 'digest',
            'sa.manager_validated': 'digest',
            'mc.approved': 'digest',
            'review.completed': 'digest',
            'pip.created': 'digest',
            'pip.closed': 'digest',
            'idp.created': 'digest',
            'idp.activated': 'digest',
            'idp.signoff_needed': 'digest',
            'coaching.created': 'digest',
            'coaching.validated': 'digest',
            'feedback360.nominate': 'digest',
            'feedback360.approve': 'digest',
            'feedback360.invited': 'digest',
            'feedback360.reminder': 'digest',
            'feedback360.closed': 'digest',
            'feedback360.released': 'digest',
            'oneonone.topic_added': 'digest',
            'recognition.received': 'digest',
            'continuity.successor_ready': 'digest',
            'onboarding.submitted': 'digest',
            'cert.expiry.team': 'digest',
            'lms.assigned': 'digest',
            'lms.due': 'digest',
            // A decision is pending on a person's official skill level — it
            // belongs in the daily digest, not buried in-app only.
            'lms.uplift_proposed': 'digest',
            'mobility.opportunity_posted': 'digest',
            'mobility.application_received': 'digest',
            'mobility.application_decided': 'immediate',
            'survey.published': 'digest',
            'survey.respond': 'digest',
            // ('idp.signoff_needed' was listed twice — same 'digest' tier both times,
            //  so the duplicate was a no-op that only tripped no-dupe-keys. Removed
            //  here; the surviving declaration is three lines up, tier unchanged.)
            'access.review': 'digest',
            // Same tier as 'access.review', which they used to borrow.
            'account.dormant': 'digest',
            'access.expiry': 'digest',
            // Manager nudges from jobs/reminders.js — in-app now, rolled into the
            // one daily digest mail; never a standalone email.
            'ninebox.reassess_due': 'digest',
            'talent.plan_due': 'digest',
            // Continuity automation — in-app now, rolled into the one daily digest
            // mail. ('planning.digest' is deliberately ABSENT: like manager_digest
            // and dept_digest it composes its own branded email and is gated by the
            // 'digest' email category, not by a per-kind tier.)
            'succession.review_due': 'digest',
            'handover.due': 'digest',
            'lifecycle.joiner': 'digest',
            'lifecycle.mover': 'digest',
            'lifecycle.leaver': 'digest',
            'safety.blocked': 'immediate',
            'safety.expiring': 'immediate',
            'safety.blocked.team': 'immediate',
            'safety.expiring.team': 'immediate',
            'safety.waiver_granted': 'immediate',
            'safety.waiver_granted.team': 'immediate',
            'safety.waiver_ended': 'immediate',
            'safety.waiver_ended.team': 'immediate',
            'safety.contest.review': 'immediate',
            'safety.contest.decided': 'immediate',
            'lifecycle.reports_to_reassign': 'digest',
            'cycle.opened': 'digest',
            'cycle.closed': 'digest',
            // Confidential → in-app only, NEVER email
            // ('ninebox.submitted' was the only 9-box kind with no tier, so it fell
            //  through to category gating and could have been emailed. Added, not
            //  changed: no existing tier is touched.)
            // Retention risk carries a `restricted` confidentiality tier in the
            // schema — it must never leave the app, so it is in-app only. (The
            // job that raises it uses enqueue rather than notify as well, so
            // it never reaches the webhook fan-out either.)
            'ninebox.disclosed': 'none',
            'ninebox.approved': 'none',
            'ninebox.submitted': 'none',
            'retention.risk_high': 'none',
            // ops alerts: in-app now, in the daily digest e-mail when emailOnDigest.
            'ops.job_failed': 'digest',
            'ops.backup_stale': 'digest',
            'ops.hris_plan_ready': 'digest',
            'ops.hris_sync_alert': 'digest',
            'ops.smtp_failed': 'digest',
            'ops.license': 'digest',
            // SA-38: the copy is ready now; a suspension is said in the app.
            'report.schedule_ready': 'immediate',
            'report.schedule_suspended': 'digest',
            // 3.23.20 (C2f): security alerts to every SuperAdmin — sent now.
            'security.breakglass_signin': 'immediate',
            'security.superadmin_sso_refused': 'immediate',
            'security.superadmin_mfa_changed': 'immediate',
            'security.superadmin_password_reset': 'immediate',
            // Lockout: the SuperAdmins now; the person, now too (someone is
            // trying their account; still user-controllable by category).
            'security.admin_account_locked': 'immediate',
            'security.account_soft_locked': 'immediate',
            // 3.23.20: the SSO migration invitation — in-app row written by
            // SsoInviteService (enqueue); its e-mail is composed and sent there.
            'sso.migration_invite': 'none',
            // Profiling objections: in-app only. They name nobody, but an
            // objection is itself personal data: it never leaves the app.
            'privacy.objection': 'none',
            'privacy.trigger_paused': 'none',
            // 'dept_brief' is DELIBERATELY ABSENT — do not add it.
            //
            // Like manager_digest, dept_digest and planning.digest, the department
            // brief composes its OWN branded email and is gated by the 'digest'
            // EMAIL CATEGORY, not by a per-kind tier. A tier of 'digest' here would
            // hit line 131 (`if (tier === 'digest') { result.email =
            // 'digest_deferred'; return result; }`) and the composed brief would
            // never be sent — the monthly, quarterly and yearly cadences would
            // silently become in-app only.
            //
            // This absence is written down because the jest invariant only checks
            // POLICY → META, never META → POLICY: the omission is invisible to the
            // test suite, and the next contributor will reasonably assume it was an
            // oversight. It is not.
        };
    },

    /**
     * QA LE SIGNALEMENT NOMME LA CAMPAGNE.
     *
     * Trois transitions de campagne (verrouillage, proposition de clôture,
     * retard hebdomadaire) réemploient DÉLIBÉRÉMENT le même kind
     * `cycle.escalation` (`jobs/cycle-deadline.js`). Le réemploi est bon — le
     * lien du payload pointe la bonne campagne et la surface de décision est
     * complète — mais la boîte du super-administrateur affichait six lignes
     * RIGOUREUSEMENT identiques, « Revues à finaliser », venues de campagnes
     * différentes : rien ne disait laquelle, ni ce qui venait de se passer.
     *
     * Le mécanisme n'est pas refait : le kind, le ledger, la cadence et le lien
     * ne bougent pas. Seul le LIBELLÉ gagne un complément, construit AU MOMENT
     * DE LA LECTURE à partir du payload (jamais figé en base, sinon la phrase
     * serait gelée dans la langue de l'émetteur — c'est exactement le défaut
     * P2-03) et fourni en FR et en EN dans le même geste.
     *
     * Contrat : retourne une chaîne courte, ou null — et null veut dire « titre
     * inchangé ». Un payload sans code de campagne ne change donc rien.
     */
    get KIND_SUBTITLE() {
        const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
        return {
            // The announcement carries its date, the invitation its provider: the
            // title alone said nothing to a person with no e-mail.
            'sso.migration_invite': (p, lang) =>
                require('./SsoInviteService').inAppSubtitle(p, lang),
            // SA-38: the report's own (template) name, never a figure.
            'report.schedule_ready': (p) => {
                const name = String((p && p.report) || '').trim();
                return name ? `« ${name.slice(0, 120)} »` : null;
            },
            'cycle.escalation': (p, lang) => {
                const code = String((p && p.cycle) || '').trim();
                if (!code) return null;
                const stage = String((p && p.stage) || '');
                const pending = n(p && p.pending);
                const late = n(p && p.overdueDays);
                if (lang === 'en') {
                    if (stage === 'locked')
                        return `campaign ${code} is locked: the reviews are what is left`;
                    if (stage === 'closure_proposed')
                        return `campaign ${code}: a closure is proposed, your decision is awaited`;
                    if (stage === 'overdue')
                        return late
                            ? `campaign ${code} is ${late} day(s) past its deadline`
                            : `campaign ${code} is past its deadline`;
                    if (stage === 'escalation_overdue')
                        return pending
                            ? `campaign ${code}: ${pending} review(s) overdue`
                            : `campaign ${code}: reviews overdue`;
                    return pending
                        ? `campaign ${code}: ${pending} review(s) to finalise`
                        : `campaign ${code}`;
                }
                if (stage === 'locked') return `campagne ${code} verrouillée : restent les revues`;
                if (stage === 'closure_proposed')
                    return `campagne ${code} : une clôture est proposée, votre décision est attendue`;
                if (stage === 'overdue')
                    return late
                        ? `campagne ${code} en retard de ${late} jour(s)`
                        : `campagne ${code} en retard`;
                if (stage === 'escalation_overdue')
                    return pending
                        ? `campagne ${code} : ${pending} revue(s) en retard`
                        : `campagne ${code} : revues en retard`;
                return pending
                    ? `campagne ${code} : ${pending} revue(s) à finaliser`
                    : `campagne ${code}`;
            },
        };
    },

    /**
     * The body sentence for an event, FR primary + EN parity.
     *
     * Every kind that can be emailed has one — the generic "Une mise à jour
     * vous concernant est disponible" fallback used to stand in for whole tiers
     * of events (including five immediate-tier ones), so an urgent dispute
     * escalation and a routine plan update read identically and neither told
     * the reader what had happened.
     *
     * The confidentiality rule holds and is the reason these are static
     * sentences: NOTHING from the payload is interpolated, no rating, level,
     * comment, reason, PIP content or 9-box placement ever appears. The mail
     * says what KIND of thing happened and links into the app; the detail
     * stays behind authentication, where clearance is enforced.
     */
    get KIND_MESSAGES() {
        return {
            // ---- Self-assessment workflow ----
            'sa.submitted': {
                fr: 'Une auto-évaluation a été soumise et attend votre revue. Merci de la traiter dès que possible.',
                en: 'A self-assessment has been submitted and is waiting for your review. Please handle it as soon as you can.',
            },
            'sa.changes_requested': {
                fr: 'Votre responsable a demandé des modifications sur votre auto-évaluation. Merci de la compléter puis de la soumettre à nouveau.',
                en: 'Your manager has requested changes to your self-assessment. Please complete it and submit it again.',
            },
            'sa.approved': {
                fr: 'Bonne nouvelle : votre auto-évaluation a été approuvée. Vous pouvez en consulter le détail.',
                en: 'Good news: your self-assessment has been approved. You can review the details.',
            },
            'sa.rejected': {
                fr: 'Votre auto-évaluation a été rejetée. Consultez les commentaires associés pour la suite à donner.',
                en: 'Your self-assessment was rejected. Open it to read the comments and see what happens next.',
            },
            'sa.manager_validated': {
                fr: 'Votre évaluation a été validée par le management. Vous pouvez en consulter le détail.',
                en: 'Your assessment has been validated by management. You can review the details.',
            },
            'review.completed': {
                fr: "Une revue de votre responsable a été complétée. Le résultat est consultable dans l'application.",
                en: 'A supervisor review has been completed. The outcome is available in the app.',
            },
            'review.due': {
                fr: "Une revue d'évaluation reste à réaliser et attend votre traitement.",
                en: 'An assessment review is still to be done and is waiting for you.',
            },
            // Compétence et motif restent dans l'application : la phrase dit ce qui
            // s'est passé, jamais quelle certification ni pourquoi.
            'privacy.objection': {
                fr: "Une personne s'est opposée au profilage automatisé. Examinez sa demande dans le registre.",
                en: 'Someone objected to automated profiling. Review the request in the register.',
            },
            'privacy.trigger_paused': {
                fr: "Une action de développement déclenchée automatiquement a été suspendue parce que la personne s'est opposée au profilage. Elle attend une décision humaine.",
                en: 'An automatically triggered development action was paused because the person objected to profiling. It awaits a human decision.',
            },
            'certification.revoked': {
                fr: "Une de vos certifications a été retirée. Le motif et la marche à suivre sont consultables dans l'application.",
                en: 'One of your certifications was revoked. The reason and what to do next are available in the app.',
            },
            // ----  / M-05 — annulation et demande de modification.
            //      Comme toutes les autres : phrases STATIQUES, rien du payload n'y est
            //      interpolé. Le motif écrit par le décideur est rendu dans le centre de
            //      notifications (voir present), jamais dans un e-mail.
            'sa.reset_for_redo': {
                fr: 'Votre évaluation a été rouverte : vous pouvez la reprendre.',
                en: 'Your assessment has been reopened: you can resume it.',
            },
            'sa.review_reset': {
                fr: 'Une évaluation de votre équipe a été rouverte et attend de nouveau votre revue.',
                en: 'An assessment in your team has been reopened and is waiting for your review again.',
            },
            'sa.cancelled': {
                fr: "Une auto-évaluation vous concernant a été annulée par votre responsable. Le motif et la suite à donner sont consultables dans l'application.",
                en: 'A self-assessment concerning you was cancelled by your manager. The reason and what happens next are available in the app.',
            },
            'sa.change_request_raised': {
                fr: 'Une demande de modification sur une évaluation validée attend votre décision. Merci de la traiter dès que possible.',
                en: 'A request to change a validated assessment is waiting for your decision. Please handle it as soon as you can.',
            },
            'sa.change_request_raised_on_me': {
                fr: "Une demande de modification a été déposée sur une de vos évaluations. Le motif et la suite donnée sont consultables dans l'application.",
                en: 'A request for change was raised on one of your assessments. The reason and what happens next are available in the app.',
            },
            'sa.change_request_granted': {
                fr: "Une demande de modification a été accordée : l'auto-évaluation concernée est de nouveau modifiable.",
                en: 'A request for change was granted: the self-assessment concerned can be edited again.',
            },
            'sa.change_request_refused': {
                fr: "Votre demande de modification a été refusée. Le motif de la décision est consultable dans l'application.",
                en: 'Your request for change was refused. The reason for the decision is available in the app.',
            },

            // ---- Maker-checker ----
            'mc.submitted': {
                fr: "Une action soumise par un collègue attend votre approbation. Merci de l'examiner à votre convenance.",
                en: 'An action submitted by a colleague is waiting for your approval. Please review it at your convenience.',
            },
            'mc.approved': {
                fr: "L'action que vous avez soumise a été approuvée.",
                en: 'The action you submitted has been approved.',
            },
            'mc.rejected': {
                fr: "L'action que vous avez soumise a été rejetée. Consultez le motif pour la suite à donner.",
                en: 'The action you submitted was rejected. Open it to read the reason and decide what happens next.',
            },

            // ---- Disputes (immediate tier — SLA-bound) ----
            'dispute.opened': {
                fr: 'Une contestation a été ouverte sur une évaluation et attend votre traitement dans le délai prévu.',
                en: 'A rating dispute has been opened and is waiting to be handled within the agreed time limit.',
            },
            'dispute.escalated': {
                fr: 'Une contestation a été escaladée au niveau supérieur : son délai de traitement court désormais pour vous.',
                en: 'A rating dispute has been escalated to the next level — its response deadline now runs for you.',
            },
            'dispute.resolved': {
                fr: "Une contestation a été résolue. La décision et sa justification sont consultables dans l'application.",
                en: 'A rating dispute has been resolved. The decision and its rationale are available in the app.',
            },

            // ---- Performance / development plans ----
            'pip.created': {
                fr: "Un plan d'amélioration de la performance a été créé et vous concerne.",
                en: 'A performance improvement plan has been created and concerns you.',
            },
            'pip.activated': {
                fr: "Un plan de performance vous concernant est désormais actif. Merci d'en prendre connaissance.",
                en: 'A performance plan concerning you is now active. Please take note of it.',
            },
            'pip.closed': {
                fr: "Un plan d'amélioration de la performance a été clôturé.",
                en: 'A performance improvement plan has been closed.',
            },
            'idp.created': {
                fr: 'Un plan de développement individuel a été créé et vous concerne.',
                en: 'An individual development plan has been created and concerns you.',
            },
            'idp.activated': {
                fr: 'Votre plan de développement individuel est désormais actif.',
                en: 'Your individual development plan is now active.',
            },
            'idp.signoff_needed': {
                fr: 'Un plan de développement attend votre signature pour pouvoir démarrer.',
                en: 'A development plan is waiting for your sign-off before it can start.',
            },
            'coaching.created': {
                fr: 'Un plan de coaching a été créé pour vous accompagner.',
                en: 'A coaching plan has been created to support you.',
            },
            'coaching.validated': {
                fr: 'Un plan de coaching a été mené à son terme et validé.',
                en: 'A coaching plan has been completed and validated.',
            },
            'feedback360.nominate': {
                fr: 'Un feedback 360° est lancé pour vous. Proposez les collègues, collaborateurs et autres personnes qui vous répondront.',
                en: 'A 360° feedback round has been launched for you. Propose the colleagues, direct reports and others who will answer.',
            },
            'feedback360.approve': {
                fr: 'Un membre de votre équipe a proposé ses évaluateurs 360°. Validez ou ajustez la liste.',
                en: 'A member of your team has proposed their 360° raters. Approve or adjust the list.',
            },
            'feedback360.invited': {
                fr: 'Un collègue vous demande un feedback 360°. Vos réponses sont regroupées avec celles des autres et restent anonymes.',
                en: 'A colleague asks you for 360° feedback. Your answers are grouped with others and stay anonymous.',
            },
            'feedback360.reminder': {
                fr: 'Un questionnaire de feedback 360° attend encore votre réponse.',
                en: 'A 360° feedback questionnaire is still waiting for your answer.',
            },
            'feedback360.closed': {
                fr: 'Un tour de feedback 360° est clos. Consultez le rapport et communiquez-le à la personne concernée.',
                en: 'A 360° feedback round has closed. Read the report and release it to the person.',
            },
            'feedback360.released': {
                fr: 'Votre rapport de feedback 360° est disponible.',
                en: 'Your 360° feedback report is available.',
            },
            'oneonone.topic_added': {
                fr: 'Un sujet a été ajouté à l’ordre du jour de votre prochain entretien individuel.',
                en: 'A topic has been added to the agenda of your next one-to-one.',
            },
            'talent.plan_due': {
                fr: "Des plans de développement ou de performance de votre équipe arrivent à échéance ou n'ont pas démarré.",
                en: 'Development or performance plans in your team are coming due or have not started.',
            },
            //  / M-05. Comptes et faits seulement : ni la case, ni la
            // performance, ni le potentiel — le détail reste derrière le lien.
            'talent.task.created': {
                fr: "Une action de suivi vous a été assignée à la suite d'une revue talent. Ouvrez-la pour décider de la suite : rien n'est ouvert d'office.",
                en: 'A follow-up task has been assigned to you after a talent review. Open it to decide what happens next: nothing is opened automatically.',
            },
            // Counts only — never a box, a performance level or a potential level.
            'ninebox.reassess_due': {
                fr: "Des positionnements talent de votre équipe n'ont pas été revus depuis la cadence définie.",
                en: 'Talent placements in your team have not been reviewed within the defined cadence.',
            },

            // ---- Campaigns ----
            'cycle.opened': {
                fr: "Une campagne d'évaluation vient d'être ouverte : votre contribution y est attendue.",
                en: 'An assessment cycle has just opened — your contribution is expected.',
            },
            'cycle.reminder': {
                fr: "Une campagne d'évaluation est en cours et attend votre contribution.",
                en: 'An assessment cycle is under way and is waiting for your contribution.',
            },
            'cycle.escalation': {
                fr: 'Des revues de votre périmètre restent à finaliser avant la clôture de la campagne.',
                en: 'Reviews in your scope are still to be finalised before the cycle closes.',
            },
            'cycle.closed': {
                fr: "Une campagne d'évaluation est clôturée. Les résultats consolidés sont disponibles.",
                en: 'An assessment cycle has closed. The consolidated results are available.',
            },

            // ---- Compliance / operations ----
            'cert.expiry': {
                fr: "Une de vos certifications arrive à échéance. Merci d'anticiper son renouvellement.",
                en: 'One of your certifications is approaching its expiry date. Please plan its renewal.',
            },
            'cert.expiry.team': {
                fr: "La certification d'un membre de votre équipe arrive à échéance et doit être renouvelée.",
                en: 'A certification held by a member of your team is approaching expiry and needs renewing.',
            },
            'coverage.breach': {
                fr: "Un seuil de couverture de compétences n'est plus respecté. Une action peut être requise.",
                en: 'A skills-coverage threshold is no longer met. Action may be required.',
            },
            'coverage.predicted': {
                fr: 'Une rupture de couverture de compétences est prévue à court terme sur votre périmètre.',
                en: 'A skills-coverage gap is forecast in the near term for your scope.',
            },
            'coverage.breach.batch': {
                fr: 'Plusieurs règles de couverture sont passées en rupture en une seule passe. Les alertes ont été regroupées ; le détail est sur la page Conformité opérationnelle.',
                en: 'Several coverage rules moved into breach in a single pass. The alerts were batched; the detail is on the Operational Compliance page.',
            },
            'coverage.predicted.batch': {
                fr: 'Plusieurs ruptures de couverture sont prévues à court terme. Les alertes ont été regroupées ; le détail est sur la page Conformité opérationnelle.',
                en: 'Several coverage gaps are forecast in the near term. The alerts were batched; the detail is on the Operational Compliance page.',
            },
            'access.review': {
                fr: 'Une revue des accès vous est assignée et doit être réalisée.',
                en: 'An access review has been assigned to you and needs to be completed.',
            },
            'account.dormant': {
                fr: 'Des comptes n’ont pas été utilisés depuis plus longtemps que le délai défini. Vérifiez-les et désactivez ceux qui ne servent plus.',
                en: 'Some accounts have not been used for longer than the defined period. Check them and deactivate those no longer needed.',
            },
            'access.expiry': {
                fr: 'Des droits d’administration délégués arrivent à leur date de fin. Si l’accès reste nécessaire, demandez ou accordez une prolongation avant cette date.',
                en: 'Delegated administration rights are reaching their end date. If the access is still needed, request or grant an extension before then.',
            },

            // ---- Learning ----
            'lms.assigned': {
                fr: 'Une formation vous a été assignée. Vous pouvez la démarrer depuis la plateforme.',
                en: 'A training course has been assigned to you. You can start it from the platform.',
            },
            'lms.due': {
                fr: "Une formation qui vous a été assignée n'a pas encore été démarrée.",
                en: 'A training course assigned to you has not been started yet.',
            },
            // No name, no level and no skill in the body: this leaves the
            // platform by e-mail, and the detail belongs behind the link.
            'lms.uplift_proposed': {
                fr: "Une formation terminée par une personne que vous encadrez propose une élévation de niveau. Le niveau officiel reste inchangé tant que vous ne l'avez pas validée.",
                en: 'A course completed by someone you supervise proposes a level increase. The official level stays unchanged until you validate it.',
            },

            // ---- Mobility, surveys, recognition ----
            'mobility.opportunity_posted': {
                fr: "Une nouvelle opportunité interne vient d'être publiée et pourrait correspondre à votre profil.",
                en: 'A new internal opportunity has just been published and may match your profile.',
            },
            'mobility.application_received': {
                fr: 'Une candidature a été déposée sur une opportunité dont vous êtes responsable.',
                en: 'An application has been submitted for an opportunity you own.',
            },
            'mobility.application_decided': {
                fr: "Une décision a été prise sur votre candidature interne. Le détail est consultable dans l'application.",
                en: 'A decision has been made on your internal application. The details are available in the app.',
            },
            'survey.published': {
                fr: "Une enquête vient d'être publiée et attend votre réponse.",
                en: 'A survey has just been published and is waiting for your response.',
            },
            'survey.respond': {
                fr: 'Rappel : une enquête attend toujours votre réponse.',
                en: 'Reminder: a survey is still waiting for your response.',
            },
            'recognition.received': {
                fr: 'Un collègue tient à vous remercier — vous avez reçu une reconnaissance.',
                en: 'A colleague wants to thank you — you have received recognition.',
            },

            // ---- Continuity, lifecycle, onboarding ----
            'continuity.successor_ready': {
                fr: 'Un successeur a atteint le niveau de préparation requis pour un poste clé.',
                en: 'A successor has reached the readiness level required for a key position.',
            },
            'succession.review_due': {
                fr: 'Des postes clés de votre périmètre attendent une revue de succession : plans arrivés à échéance de revue, ou postes critiques sans successeur désigné.',
                en: 'Key positions in your scope are waiting for a succession review: plans that have reached their review date, or critical positions with no named successor.',
            },
            'handover.due': {
                fr: 'Des plans de passation de votre périmètre sont en retard ou arrivent à échéance avec des éléments encore ouverts.',
                en: 'Handover plans in your scope are overdue, or are coming due with items still open.',
            },
            'onboarding.submitted': {
                fr: "Une nouvelle demande d'intégration a été déposée et attend votre décision.",
                en: 'A new onboarding request has been submitted and is waiting for your decision.',
            },
            'lifecycle.joiner': {
                fr: 'Votre compte est prêt : vous pouvez vous connecter et compléter votre profil.',
                en: 'Your account is ready — you can sign in and complete your profile.',
            },
            'lifecycle.mover': {
                fr: 'Votre affectation a changé. Les compétences attendues de votre nouveau poste sont consultables.',
                en: 'Your assignment has changed. The skills expected in your new role are available to review.',
            },
            'lifecycle.leaver': {
                fr: "Un départ a été enregistré et requiert la mise en place d'un plan de passation.",
                en: 'A departure has been recorded and requires a handover plan.',
            },
            'safety.blocked': {
                fr: 'Une ou plusieurs compétences critiques de votre poste ne sont plus couvertes. Consultez votre plan de développement.',
                en: 'One or more critical skills of your role are no longer covered. Please check your development plan.',
            },
            'safety.expiring': {
                fr: 'Un certificat requis pour votre poste arrive à échéance. Prévoyez son renouvellement.',
                en: 'A certificate required for your role is about to expire. Please plan its renewal.',
            },
            'safety.blocked.team': {
                fr: 'L’habilitation sécurité d’un collaborateur de votre équipe est bloquée. Un plan de développement peut être proposé.',
                en: 'A team member’s safety clearance is blocked. A development plan can be proposed.',
            },
            'safety.expiring.team': {
                fr: 'Un certificat requis pour un collaborateur de votre équipe arrive à échéance.',
                en: 'A certificate required for a member of your team is about to expire.',
            },
            'safety.waiver_granted': {
                fr: 'Une dérogation vous autorise pour une durée limitée. À son terme, votre statut calculé s’appliquera de nouveau. Le détail est dans l’application.',
                en: 'A waiver authorises you for a limited time. When it ends, your computed status applies again. The details are in the app.',
            },
            'safety.waiver_granted.team': {
                fr: 'Une dérogation autorise un collaborateur de votre équipe pour une durée limitée. Le détail est dans l’application.',
                en: 'A waiver authorises a member of your team for a limited time. The details are in the app.',
            },
            'safety.waiver_ended': {
                fr: 'Votre dérogation de sécurité est terminée : votre statut calculé s’applique de nouveau.',
                en: 'Your safety waiver is over: your computed status applies again.',
            },
            'safety.waiver_ended.team': {
                fr: 'La dérogation de sécurité d’un collaborateur est terminée : son statut calculé s’applique de nouveau.',
                en: 'A team member’s safety waiver is over: their computed status applies again.',
            },
            'safety.contest.review': {
                fr: 'Une personne conteste le blocage de son habilitation sécurité. Une décision motivée est attendue.',
                en: 'Someone is contesting the block on their safety clearance. A decision with a reason is needed.',
            },
            'safety.contest.decided': {
                fr: 'Une décision motivée a été enregistrée sur la contestation d’habilitation sécurité.',
                en: 'A decision with its reason has been recorded on the safety clearance contest.',
            },
            'lifecycle.reports_to_reassign': {
                fr: 'Un départ a laissé des collaborateurs sans responsable actif. Désignez-leur un nouveau réviseur.',
                en: 'A departure has left team members without an active reviewer. Please assign them a new one.',
            },
            'admin.created': {
                fr: 'Un compte administrateur a été créé pour vous. Vos identifiants vous parviennent séparément.',
                en: 'An administrator account has been created for you. Your credentials are sent separately.',
            },

            // ---- Rollups (these have their own dedicated emails; kept for parity) ----
            manager_digest: {
                fr: 'Le récapitulatif de votre équipe est disponible.',
                en: 'The summary for your team is available.',
            },
            dept_digest: {
                fr: 'Le récapitulatif de votre département est disponible.',
                en: 'The summary for your department is available.',
            },
            // Counts and rates live in the brief itself, behind authentication —
            // this sentence says what arrived and nothing about what it contains.
            dept_brief: {
                fr: "Le bilan de performance de votre département est disponible : ce qui attend votre décision, ce qu'il y a à relancer, ce qui arrive à échéance, et l'état mesuré de vos départements.",
                en: 'The performance brief for your department is available: what awaits your decision, what needs chasing, what falls due, and the measured state of your departments.',
            },
            'planning.digest': {
                fr: 'Votre point mensuel de planification des effectifs est disponible : échéances de certification, postes critiques sans relève et évolution du risque de départ.',
                en: 'Your monthly workforce-planning brief is available: upcoming certification expiries, critical positions with no bench, and movements in retention risk.',
            },
            // ---- operations alerts (SuperAdmins only) ----
            'ops.job_failed': {
                fr: "Une tâche planifiée a échoué ou n'a pas tourné depuis plus de 36 heures. Consultez la page Santé de l'instance pour le détail et relancez-la.",
                en: 'A scheduled job failed or has not run for more than 36 hours. Open the instance health page for the detail and run it again.',
            },
            'ops.backup_stale': {
                fr: "Aucune sauvegarde de la base de données réussie depuis plus de 36 heures. Vérifiez l'emplacement et l'espace disque, puis lancez une sauvegarde depuis la page Santé de l'instance.",
                en: 'No successful database backup for more than 36 hours. Check the location and the disk space, then run a backup from the instance health page.',
            },
            'ops.hris_plan_ready': {
                fr: "La synchronisation SIRH de la nuit a préparé un plan (arrivées, mobilités, départs, valeurs non rapprochées). Rien n'a été appliqué : relisez-le puis appliquez-le depuis Intégrations → SIRH.",
                en: 'The nightly HRIS sync prepared a plan (joiners, movers, leavers, unmapped values). Nothing was applied: review it, then apply it from Integrations → HRIS.',
            },
            'ops.hris_sync_alert': {
                fr: "La synchronisation SIRH s'est arrêtée sans rien appliquer : l'export n'a pas pu être lu, ou il aurait désactivé plus de salariés que le seuil de sécurité ne l'autorise. Vérifiez l'export puis relancez un essai à blanc.",
                en: 'The HRIS sync stopped without applying anything: the export could not be read, or it would have deactivated more employees than the safety threshold allows. Check the export, then run a new dry run.',
            },
            'ops.smtp_failed': {
                fr: "L'envoi d'e-mails a échoué. Vérifiez la configuration SMTP dans les paramètres et relancez un e-mail de test.",
                en: 'E-mail delivery failed. Check the SMTP settings and send a test e-mail again.',
            },
            'ops.license': {
                fr: "La licence de l'instance est expirée ou le nombre de sièges licenciés est dépassé. Mettez la licence à jour.",
                en: 'The instance licence has expired or the licensed seat count is exceeded. Update the licence.',
            },
            'report.schedule_ready': {
                fr: "Le rapport n'est pas joint à ce message : ouvrez-le dans l'application, où votre accès est vérifié à l'ouverture.",
                en: 'The report is not attached to this message: open it in the app, where your access is checked when you open it.',
            },
            'report.schedule_suspended': {
                fr: "Cet envoi programmé partait vers des adresses saisies à la main. Les destinataires doivent désormais être des comptes de l'application : choisissez-les de nouveau pour le réactiver.",
                en: 'This schedule sent to typed e-mail addresses. Recipients must now be accounts of the app: choose them again to re-enable it.',
            },
            // ---- 3.23.20 (C2f) security alerts to every SuperAdmin ----
            'security.breakglass_signin': {
                fr: "Un super administrateur s'est connecté par l'accès de secours (mot de passe) alors que la connexion SSO est imposée. Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: 'A super administrator signed in through the password emergency access while SSO sign-in is enforced. If this was not expected, check the security log.',
            },
            'security.superadmin_sso_refused': {
                fr: 'Une tentative de connexion par SSO à un compte super administrateur a été refusée. Un super administrateur ne se connecte jamais par SSO. Vérifiez le journal de sécurité.',
                en: 'A single sign-on attempt to a super administrator account was refused. A super administrator never signs in with SSO. Check the security log.',
            },
            'security.superadmin_mfa_changed': {
                fr: "La double authentification d'un compte super administrateur a été modifiée (activation, réinitialisation ou code de secours). Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: "A super administrator account's two-factor authentication changed (enrolment, reset or recovery). If this was not expected, check the security log.",
            },
            'security.superadmin_password_reset': {
                fr: "Le mot de passe d'un compte super administrateur a été réinitialisé. La double authentification reste exigée. Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: "A super administrator account's password was reset. Two-factor authentication is still required. If this was not expected, check the security log.",
            },
            // ---- Lockout ----
            'security.admin_account_locked': {
                fr: "Un compte administrateur a été verrouillé après une série d'échecs de connexion. Si ce n'était pas la personne elle-même, vérifiez le journal de sécurité ; un super administrateur peut le déverrouiller.",
                en: 'An administrator account was locked after a series of failed sign-ins. If it was not the person themselves, check the security log; a super administrator can unlock it.',
            },
            'security.account_soft_locked': {
                fr: "Plusieurs tentatives de connexion ont échoué sur votre compte : les connexions sont ralenties pour un moment. Votre mot de passe reste valable. Si ce n'était pas vous, prévenez votre administrateur.",
                en: 'Several sign-in attempts on your account failed: sign-ins are slowed for a while. Your password still works. If it was not you, tell your administrator.',
            },
        };
    },

    /**
     * A neutral subject for the kinds whose title states a decision or a
     * person's status. The title (inside the mail and in the app) is unchanged;
     * only the subject line, read on a lock screen or in a shared mailbox, says
     * what KIND of thing is waiting and nothing about its outcome.
     */
    get KIND_SUBJECT() {
        const decisionOnSa = {
            fr: 'Une décision a été prise sur votre auto-évaluation',
            en: 'A decision was made on your self-assessment',
        };
        const decisionOnRequest = {
            fr: 'Une décision a été prise sur une demande de modification',
            en: 'A decision was made on a request for change',
        };
        const decisionOnAction = {
            fr: 'Une décision a été prise sur votre action',
            en: 'A decision was made on your submitted action',
        };
        const followUp = { fr: 'Un suivi vous concerne', en: 'A follow-up concerns you' };
        const mySafety = {
            fr: 'Votre habilitation sécurité : à consulter',
            en: 'Your safety clearance: please read',
        };
        const teamSafety = {
            fr: 'Habilitation sécurité dans votre équipe : à consulter',
            en: 'Safety clearance in your team: please read',
        };
        return {
            'sa.approved': decisionOnSa,
            'sa.rejected': decisionOnSa,
            'sa.cancelled': {
                fr: 'Du nouveau sur votre auto-évaluation',
                en: 'An update on your self-assessment',
            },
            'sa.manager_validated': {
                fr: 'Une décision a été prise sur votre évaluation',
                en: 'A decision was made on your assessment',
            },
            'sa.change_request_granted': decisionOnRequest,
            'sa.change_request_refused': decisionOnRequest,
            'mc.approved': decisionOnAction,
            'mc.rejected': decisionOnAction,
            'pip.created': followUp,
            'pip.activated': followUp,
            'pip.closed': followUp,
            'ninebox.approved': {
                fr: 'Une décision a été prise sur un positionnement talent',
                en: 'A decision was made on a talent placement',
            },
            'certification.revoked': {
                fr: 'Du nouveau sur vos certifications',
                en: 'An update on your certifications',
            },
            'safety.blocked': mySafety,
            'safety.expiring': mySafety,
            'safety.waiver_granted': mySafety,
            'safety.waiver_ended': mySafety,
            'safety.blocked.team': teamSafety,
            'safety.expiring.team': teamSafety,
            'safety.waiver_granted.team': teamSafety,
            'safety.waiver_ended.team': teamSafety,
            'security.account_soft_locked': {
                fr: 'Avis de sécurité sur votre compte',
                en: 'Security notice about your account',
            },
        };
    },

    /**
     * Severity per kind. An unlisted kind is 'info'. Red (« critique ») is kept
     * for what can hurt someone or the organisation today.
     */
    get KIND_SEVERITY() {
        const by = {
            critique: [
                'safety.blocked',
                'safety.blocked.team',
                'coverage.breach',
                'coverage.breach.batch',
                'security.breakglass_signin',
                'security.superadmin_sso_refused',
                'security.admin_account_locked',
                'ops.backup_stale',
            ],
            echeance: [
                'cert.expiry',
                'cert.expiry.team',
                'safety.expiring',
                'safety.expiring.team',
                'safety.waiver_ended',
                'safety.waiver_ended.team',
                'coverage.predicted',
                'coverage.predicted.batch',
                'access.expiry',
                'cycle.reminder',
                'lms.due',
                'talent.plan_due',
                'handover.due',
                'succession.review_due',
                'ninebox.reassess_due',
                'dispute.escalated',
                'feedback360.reminder',
                'survey.respond',
            ],
            action: [
                'sa.submitted',
                'sa.changes_requested',
                'sa.reset_for_redo',
                'sa.review_reset',
                'sa.change_request_raised',
                'mc.submitted',
                'dispute.opened',
                'cycle.escalation',
                'review.due',
                'onboarding.submitted',
                'idp.signoff_needed',
                'lms.assigned',
                'lms.uplift_proposed',
                'access.review',
                'account.dormant',
                'safety.contest.review',
                'survey.published',
                'lifecycle.leaver',
                'lifecycle.reports_to_reassign',
                'talent.task.created',
                'ninebox.submitted',
                'privacy.objection',
                'privacy.trigger_paused',
                'ops.job_failed',
                'ops.smtp_failed',
                'ops.license',
                'ops.hris_plan_ready',
                'ops.hris_sync_alert',
                'mobility.application_received',
                'pip.activated',
                'report.schedule_suspended',
                'feedback360.nominate',
                'feedback360.approve',
                'feedback360.invited',
                'feedback360.closed',
                'sso.migration_invite',
                'security.superadmin_mfa_changed',
                'security.superadmin_password_reset',
                'security.account_soft_locked',
            ],
            favorable: [
                'sa.approved',
                'sa.manager_validated',
                'sa.change_request_granted',
                'mc.approved',
                'recognition.received',
                'coaching.validated',
                'continuity.successor_ready',
                'safety.waiver_granted',
            ],
        };
        const out = {};
        for (const [level, kinds] of Object.entries(by)) for (const k of kinds) out[k] = level;
        return out;
    },

    /**
     * Mandatory kinds: safety and security. They are e-mailed whatever the
     * recipient's own e-mail switch and the per-domain toggle say, and their
     * footer reads « Message obligatoire » with no unsubscribe header. The
     * global e-mail switch and the SMTP configuration still apply, and a kind
     * whose tier is 'none' is never e-mailed.
     */
    get MANDATORY() {
        return [
            'safety.blocked',
            'safety.expiring',
            'safety.blocked.team',
            'safety.expiring.team',
            'safety.waiver_granted',
            'safety.waiver_granted.team',
            'safety.waiver_ended',
            'safety.waiver_ended.team',
            'safety.contest.review',
            'safety.contest.decided',
            'security.breakglass_signin',
            'security.superadmin_sso_refused',
            'security.superadmin_mfa_changed',
            'security.superadmin_password_reset',
            'security.admin_account_locked',
            'security.account_soft_locked',
        ];
    },

    /** The webhook defaults (equal to WebhookService.EMITTABLE_EVENTS). */
    get WEBHOOK_DEFAULT() {
        return [...WEBHOOK_DEFAULT];
    },

    get WEBHOOK_OPT_IN_FAMILIES() {
        return [...WEBHOOK_OPT_IN_FAMILIES];
    },

    get MAIL_ONLY() {
        return JSON.parse(JSON.stringify(MAIL_ONLY));
    },

    get CATEGORIES() {
        return [...CATEGORIES];
    },

    get CATEGORY_LABELS() {
        return JSON.parse(JSON.stringify(CATEGORY_LABELS));
    },

    get MANDATORY_CATEGORIES() {
        return ['safety', 'security'];
    },

    get SEVERITY_LEVELS() {
        return JSON.parse(JSON.stringify(SEVERITY_LEVELS));
    },

    /** Every declared kind, sorted: the notification kinds and the mail-only ones. */
    kinds() {
        const all = new Set([
            ...Object.keys(catalogue.KIND_META),
            ...Object.keys(catalogue.KIND_POLICY),
            ...Object.keys(catalogue.KIND_LABELS),
            ...Object.keys(MAIL_ONLY),
        ]);
        return [...all].sort();
    },

    /** Is this kind declared? */
    isDeclared(kind) {
        if (typeof kind !== 'string' || !kind) return false;
        return (
            Object.prototype.hasOwnProperty.call(catalogue.KIND_META, kind) ||
            Object.prototype.hasOwnProperty.call(catalogue.KIND_POLICY, kind) ||
            Object.prototype.hasOwnProperty.call(catalogue.KIND_LABELS, kind) ||
            Object.prototype.hasOwnProperty.call(MAIL_ONLY, kind)
        );
    },

    /** Safety and security kinds ignore the recipient's switches (see MANDATORY). */
    isMandatory(kind) {
        if (!kind) return false;
        if (MAIL_ONLY[kind]) return MAIL_ONLY[kind].mandatory === true;
        return catalogue.MANDATORY.includes(kind);
    },

    /**
     * E-mail tier: 'immediate' | 'digest' | 'none'. A kind absent from
     * KIND_POLICY keeps the behaviour it always had (category gating, sent now):
     * the rollups that compose their own mail (manager_digest, dept_digest,
     * dept_brief, planning.digest) are absent on purpose.
     */
    tierOf(kind) {
        const t = catalogue.KIND_POLICY[kind];
        return t === 'none' || t === 'digest' ? t : 'immediate';
    },

    /** May this kind appear in the daily digest? Never a tier-'none' kind. */
    isDigestible(kind) {
        return catalogue.tierOf(kind) !== 'none';
    },

    /** 'critique' | 'echeance' | 'action' | 'favorable' | 'info'. */
    severityOf(kind) {
        return catalogue.KIND_SEVERITY[kind] || 'info';
    },

    /** 'default' | 'opt-in' | 'never' (decision 8). */
    webhookOf(kind) {
        const k = String(kind || '');
        if (!k || MAIL_ONLY[k]) return 'never';
        if (/^(pip|ninebox|retention|privacy)(\.|_|$)/.test(k)) return 'never';
        if (WEBHOOK_DEFAULT.includes(k)) return 'default';
        if (WEBHOOK_OPT_IN_FAMILIES.some((f) => k.startsWith(f))) return 'opt-in';
        return 'never';
    },

    /**
     * The preference category of a kind. A mandatory kind sits in its mandatory
     * category whatever its family, so a preferences grid never offers a switch
     * that would not work.
     */
    categoryOf(kind) {
        const k = String(kind || '');
        const fam = k.split('.')[0];
        if (catalogue.isMandatory(k)) return fam === 'safety' ? 'safety' : 'security';
        return FAMILY_CATEGORY[fam] || 'other';
    },

    /**
     * Resolve a { fr, en } title for a language (FR primary: the fallback
     * whenever the requested language is missing). A plain string is returned
     * as is. `lang` may be 'fr', 'en', 'en-GB'…; only the language matters.
     */
    localize(title, lang) {
        if (title == null) return null;
        if (typeof title === 'string') return title;
        const l = String(lang || 'fr')
            .toLowerCase()
            .startsWith('en')
            ? 'en'
            : 'fr';
        return title[l] || title.fr || title.en || null;
    },

    /**
     * The complement of a kind's title for this payload (KIND_SUBTITLE), folded
     * to one line and capped, or null. Shown in the app and in a mail's body,
     * never in a subject.
     */
    subtitleOf(kind, payload, lang) {
        const build = catalogue.KIND_SUBTITLE[kind];
        if (typeof build !== 'function') return null;
        const l = String(lang || 'fr')
            .toLowerCase()
            .startsWith('en')
            ? 'en'
            : 'fr';
        let s = null;
        try {
            s = build(payload && typeof payload === 'object' ? payload : {}, l);
        } catch (_) {
            return null;
        }
        if (s == null) return null;
        // Folded to one line: a title is one line. The control range IS the
        // point of this expression.
        s = String(s)
            .replace(/[\u0000-\u001F\u007F]+/g, ' ') // eslint-disable-line no-control-regex
            .replace(/\s+/g, ' ')
            .trim();
        if (!s) return null;
        return s.length > 120 ? `${s.slice(0, 119)}…` : s;
    },

    /** The localised title of a kind, FR primary. */
    titleOf(kind, lang) {
        const l = lang === 'en' ? 'en' : 'fr';
        const meta = catalogue.KIND_META[kind] || MAIL_ONLY[kind];
        if (meta && meta.title) return meta.title[l] || meta.title.fr || meta.title.en;
        return catalogue.KIND_LABELS[kind] || null;
    },

    /**
     * The subject text of a kind (without the app name): its neutral subject
     * when it has one, else its title. Never built from a payload, so it never
     * carries a name, a figure or a date.
     */
    subjectOf(kind, lang) {
        const l = lang === 'en' ? 'en' : 'fr';
        const s = catalogue.KIND_SUBJECT[kind];
        if (s) return s[l] || s.fr;
        return catalogue.titleOf(kind, l);
    },

    /** The whole declaration of one kind, or null when it is not declared. */
    describe(kind) {
        if (!catalogue.isDeclared(kind)) return null;
        const meta = catalogue.KIND_META[kind] || MAIL_ONLY[kind] || {};
        return {
            kind,
            category: catalogue.categoryOf(kind),
            severity: catalogue.severityOf(kind),
            tier: catalogue.tierOf(kind),
            mandatory: catalogue.isMandatory(kind),
            webhook: catalogue.webhookOf(kind),
            mailOnly: !!MAIL_ONLY[kind],
            icon: meta.icon || null,
            link: meta.link || null,
            title: { fr: catalogue.titleOf(kind, 'fr'), en: catalogue.titleOf(kind, 'en') },
            subject: { fr: catalogue.subjectOf(kind, 'fr'), en: catalogue.subjectOf(kind, 'en') },
        };
    },
};

module.exports = catalogue;
