'use strict';
/**
 * Companion knowledge base — the bilingual (FR/EN) product knowledge the AI
 * companion answers "how do I …", "explain this page" and "explain a concept"
 * from, with NO language model involved (air-gapped friendly).
 *
 * Pure data, no personal data. Every text is written for the person using the
 * screen, in plain words, and kept consistent with the canonical user guide
 * (src/config/userGuideContent.js — the glossary is the reference for the
 * concepts: an absence of measurement is not a result).
 *
 * ENTRIES[] — one per task / screen:
 *   id        stable identifier
 *   roles     which account types may be pointed at it: 'employee' | 'manager' | 'admin'
 *             (a manager is an employee row, so '/employee/*' pages list both)
 *   perm      admin only: permission slug(s) — ANY of them grants it (a SuperAdmin
 *             holds every permission); ignored for employees/managers
 *   superadmin  admin only: SuperAdmin accounts only
 *   module    optional module(s) the screen belongs to (src/config/modules.js): the
 *             entry is offered only while one of them is switched on
 *             (Administration → Modules); the sidebar hides the screen otherwise
 *   link      the screen the answer points to — a real route (tested)
 *   title     {fr,en} — the button label
 *   ask       {fr,en} — a canonical question, used as a suggestion chip (tested to
 *             route back to this entry)
 *   keywords  {fr,en} — normalised (lower-case, no accents) words or phrases; a
 *             trailing '*' is a prefix match
 *   answer    {fr,en}
 *
 * CONCEPTS[] — "what is …" answers: id, keywords, title, answer, related (an
 * ENTRIES id whose link is offered when the asker may open it).
 *
 * tests/unit/companionService.test.js checks: fr+en everywhere, every link is a
 * real route, unique ids, role/permission shape.
 */

const ALL = ['employee', 'manager', 'admin'];
const EMP = ['employee', 'manager'];
const MGR_ADM = ['manager', 'admin'];
const ADM = ['admin'];

const ENTRIES = [
    // ── Everyone ──────────────────────────────────────────────────────────
    {
        id: 'change_password',
        roles: ALL,
        link: '/change-password',
        title: { fr: 'Changer mon mot de passe', en: 'Change my password' },
        ask: { fr: 'Comment changer mon mot de passe ?', en: 'How do I change my password?' },
        keywords: {
            fr: ['mot de passe', 'mdp', 'changer mot de passe'],
            en: ['password', 'change password', 'reset password'],
        },
        answer: {
            fr: 'Ouvrez « Changer le mot de passe » depuis votre profil. Le nouveau mot de passe doit compter au moins 12 caractères avec majuscule, minuscule, chiffre et caractère spécial ; les mots courants et les suites de clavier sont refusés. Le changer déconnecte toutes vos autres sessions.',
            en: 'Open “Change password” from your profile. The new password needs at least 12 characters with an upper-case letter, a lower-case letter, a number and a special character; common words and keyboard patterns are refused. Changing it signs out all your other sessions.',
        },
    },
    {
        id: 'account_profile',
        roles: ALL,
        link: '/account',
        title: { fr: 'Mon profil', en: 'My profile' },
        ask: { fr: 'Comment modifier mon profil ?', en: 'How do I update my profile?' },
        keywords: {
            fr: ['profil', 'mon compte', 'adresse e-mail', 'email', 'telephone', 'langue'],
            en: ['profile', 'my account', 'email address', 'phone', 'language'],
        },
        answer: {
            fr: '« Mon profil » regroupe vos coordonnées (e-mail, téléphone) et votre langue. Modifier votre e-mail demande votre mot de passe actuel, car c’est l’adresse utilisée pour la réinitialisation.',
            en: '“My profile” holds your contact details (e-mail, phone) and your language. Changing your e-mail asks for your current password, because it is the address used for password resets.',
        },
    },
    {
        id: 'sessions',
        roles: ALL,
        link: '/account/sessions',
        title: { fr: 'Mes sessions actives', en: 'My active sessions' },
        ask: {
            fr: 'Comment déconnecter mes autres appareils ?',
            en: 'How do I sign out my other devices?',
        },
        keywords: {
            fr: ['session*', 'appareil*', 'deconnecter', 'deconnexion'],
            en: ['session*', 'device*', 'sign out', 'log out', 'logout'],
        },
        answer: {
            fr: 'La page « Sessions actives » liste chaque appareil ou navigateur connecté avec votre compte. Vous pouvez déconnecter les autres en un clic — utile après un poste partagé ou un téléphone perdu.',
            en: 'The “Active sessions” page lists every device or browser signed in as you. You can sign the others out in one click — useful after a shared computer or a lost phone.',
        },
    },
    {
        id: 'mfa',
        roles: ALL,
        link: '/v2/uam/mfa/manage',
        title: { fr: 'Double authentification', en: 'Two-factor authentication' },
        ask: {
            fr: 'Comment activer la double authentification ?',
            en: 'How do I turn on two-factor authentication?',
        },
        keywords: {
            fr: ['double authentification', '2fa', 'mfa', 'code de secours', 'authentificateur'],
            en: ['two factor', '2fa', 'mfa', 'backup code*', 'authenticator'],
        },
        answer: {
            fr: 'Scannez le QR code avec une application d’authentification, saisissez le code à 6 chiffres, puis conservez les 10 codes de secours à usage unique. Optionnelle par défaut, elle peut être imposée par un administrateur.',
            en: 'Scan the QR code with an authenticator app, enter the 6-digit code, then keep the 10 single-use backup codes somewhere safe. Optional by default, an administrator can make it mandatory.',
        },
    },
    {
        id: 'notifications',
        roles: ALL,
        link: '/notifications',
        title: { fr: 'Mes notifications', en: 'My notifications' },
        ask: { fr: 'Où voir mes notifications ?', en: 'Where do I see my notifications?' },
        keywords: {
            fr: ['notification*', 'cloche', 'alerte*', 'message*'],
            en: ['notification*', 'bell', 'alert*', 'message*'],
        },
        answer: {
            fr: 'La cloche en haut de l’écran et la page « Notifications » rassemblent ce qui vous concerne : revues, demandes, rappels de campagne. Chaque notification mène à l’écran où agir.',
            en: 'The bell at the top of the screen and the “Notifications” page gather what concerns you: reviews, requests, campaign reminders. Each notification leads to the screen where you act.',
        },
    },
    {
        id: 'notification_prefs',
        roles: ALL,
        link: '/account/notifications',
        title: { fr: 'Préférences de notification', en: 'Notification preferences' },
        ask: {
            fr: 'Comment régler mes préférences de notification ?',
            en: 'How do I change my notification preferences?',
        },
        keywords: {
            fr: ['preference*', 'heures calmes', 'recevoir moins', 'desactiver les e-mails'],
            en: ['preference*', 'quiet hours', 'fewer emails', 'stop emails', 'email settings'],
        },
        answer: {
            fr: 'Dans les préférences de notification, choisissez ce que vous recevez par e-mail et fixez vos heures calmes. Rien n’est perdu pendant les heures calmes : tout est remis à la fin de la plage.',
            en: 'In notification preferences, choose what you receive by e-mail and set your quiet hours. Nothing is dropped during quiet hours: everything is delivered when the window ends.',
        },
    },
    {
        id: 'user_guide',
        roles: ALL,
        link: '/guide',
        title: { fr: 'Guide utilisateur', en: 'User guide' },
        ask: { fr: 'Où trouver le guide utilisateur ?', en: 'Where is the user guide?' },
        keywords: {
            fr: ['guide', 'manuel', 'documentation', 'mode d emploi', 'tutoriel', 'glossaire'],
            en: ['guide', 'manual', 'documentation', 'tutorial', 'glossary'],
        },
        answer: {
            fr: 'Le guide utilisateur décrit chaque écran pour votre profil, avec un glossaire et une FAQ. L’onglet « Page actuelle » de ce panneau résume l’écran où vous êtes.',
            en: 'The user guide describes every screen for your profile, with a glossary and an FAQ. The “Current page” tab of this panel summarises the screen you are on.',
        },
    },
    {
        id: 'my_access',
        roles: ALL,
        link: '/account/my-access',
        title: { fr: 'Mes accès', en: 'My access' },
        ask: {
            fr: 'Quels sont mes droits dans l’application ?',
            en: 'What access rights do I have?',
        },
        keywords: {
            fr: ['mes droits', 'mes acces', 'permission*', 'autorisation*', 'perimetre'],
            en: ['my rights', 'my access', 'permission*', 'access rights', 'scope'],
        },
        answer: {
            fr: '« Mes accès » explique ce que votre compte peut voir et faire : votre profil, votre périmètre et, pour un administrateur, ses capacités. Hors de ce périmètre, toute action est refusée.',
            en: '“My access” explains what your account can see and do: your profile, your span and, for an administrator, its capabilities. Outside that span every action is refused.',
        },
    },

    // ── Employees (and managers, who are employees too) ───────────────────
    {
        id: 'employee_home',
        roles: EMP,
        link: '/employee/dashboard',
        title: { fr: 'Mon espace', en: 'My home' },
        ask: { fr: 'Que montre mon espace personnel ?', en: 'What does my home page show?' },
        keywords: {
            fr: ['mon espace', 'accueil', 'tableau de bord personnel', 'ma page'],
            en: ['my home', 'home page', 'my dashboard', 'personal dashboard'],
        },
        answer: {
            fr: 'Votre espace montre votre préparation au poste (sur les exigences réellement évaluées), vos écarts mesurés, ce qui n’est pas encore mesuré et ce qui vous attend. Commencez par les tâches en haut de la page.',
            en: 'Your home shows your role readiness (over the requirements actually assessed), your measured gaps, what is not measured yet and what is waiting for you. Start with the to-dos at the top of the page.',
        },
    },
    {
        id: 'self_assessment',
        roles: EMP,
        link: '/employee/self-assessment',
        title: { fr: 'Mon auto-évaluation', en: 'My self-assessment' },
        ask: {
            fr: 'Comment faire mon auto-évaluation ?',
            en: 'How do I complete my self-assessment?',
        },
        keywords: {
            fr: [
                'auto evaluation',
                'autoevaluation',
                'm evaluer',
                'noter mes competences',
                'evaluer mes competences',
                'soumettre',
            ],
            en: ['self assessment', 'self-assessment', 'rate my skills', 'assess myself', 'submit'],
        },
        answer: {
            fr: 'Ouvrez « Mon auto-évaluation », notez chaque compétence de 0 à 4 (2 = guidé, 3 = autonome), ajoutez une preuve ou un commentaire si utile, puis soumettez. Une ligne jamais touchée reste « non mesurée », jamais 0. Après soumission, votre relecteur la revoit.',
            en: 'Open “My self-assessment”, rate each skill from 0 to 4 (2 = guided, 3 = autonomous), add evidence or a comment where useful, then submit. A row you never touch stays “not measured”, never 0. Once submitted, your reviewer looks at it.',
        },
    },
    {
        id: 'assessment_status',
        roles: EMP,
        link: '/employee/assessment-status',
        title: { fr: 'Statut de mon évaluation', en: 'My assessment status' },
        ask: {
            fr: 'Où en est mon évaluation ?',
            en: 'Where is my assessment in the review process?',
        },
        keywords: {
            fr: [
                'statut',
                'ou en est',
                'suivi evaluation',
                'resultat*',
                'accuser reception',
                'valide',
            ],
            en: [
                'status',
                'where is my assessment',
                'results',
                'acknowledge',
                'approved',
                'reviewed',
            ],
        },
        answer: {
            fr: 'Cette page suit votre dossier : soumis, revu, validé ou renvoyé pour modification. Quand un relecteur a noté, vous voyez sa note et son commentaire, et vous pouvez en accuser réception ou la contester pendant la fenêtre ouverte.',
            en: 'This page tracks your file: submitted, reviewed, validated or sent back for changes. Once a reviewer has rated, you see their rating and comment, and can acknowledge it or dispute it while the window is open.',
        },
    },
    {
        id: 'my_reviews',
        roles: EMP,
        link: '/employee/supervisor-reviews',
        title: { fr: 'Mes revues', en: 'My reviews' },
        ask: {
            fr: 'Où lire les commentaires de mon relecteur ?',
            en: 'Where do I read my reviewer’s comments?',
        },
        keywords: {
            fr: ['commentaire* du relecteur', 'revue du superviseur', 'mes revues', 'feedback'],
            en: ['reviewer comment*', 'supervisor review*', 'my reviews', 'feedback'],
        },
        answer: {
            fr: '« Mes revues » affiche les décisions et commentaires de votre superviseur ou manager, compétence par compétence. Si la note diffère de la vôtre, le relecteur a dû en donner la raison.',
            en: '“My reviews” shows your supervisor’s or manager’s decisions and comments, skill by skill. When their rating differs from yours, the reviewer had to give a reason.',
        },
    },
    {
        id: 'assessment_change',
        roles: ALL,
        link: '/assessment-changes',
        title: { fr: 'Demandes de modification', en: 'Assessment change requests' },
        ask: {
            fr: 'Comment demander la correction d’une note validée ?',
            en: 'How do I request a change to an approved rating?',
        },
        keywords: {
            fr: [
                'demande de modification',
                'corriger une note',
                'modifier une note validee',
                'correction',
            ],
            en: ['change request', 'correct a rating', 'change an approved rating', 'correction'],
        },
        answer: {
            fr: 'Une note validée ne se réécrit pas en silence : déposez une demande de modification motivée. Un décideur habilité l’examine, et la décision est tracée.',
            en: 'An approved rating is never rewritten silently: file a change request with a reason. An authorised decision-maker reviews it, and the decision is logged.',
        },
    },
    {
        id: 'my_progress',
        roles: EMP,
        link: '/employee/my-progress',
        title: { fr: 'Ma progression', en: 'My progress' },
        ask: { fr: 'Comment suivre ma progression ?', en: 'How do I follow my progress?' },
        keywords: {
            fr: ['progression', 'historique', 'evolution de mes notes', 'mon parcours'],
            en: ['progress', 'history', 'how my ratings changed', 'my journey'],
        },
        answer: {
            fr: '« Ma progression » retrace l’évolution de vos niveaux validés dans le temps, compétence par compétence, pour voir ce qui a réellement avancé.',
            en: '“My progress” traces how your validated levels changed over time, skill by skill, so you can see what actually moved.',
        },
    },
    {
        id: 'my_development',
        roles: EMP,
        link: '/employee/my-development',
        title: { fr: 'Mon développement', en: 'My development' },
        ask: {
            fr: 'Où voir mon plan de développement ?',
            en: 'Where do I see my development plan?',
        },
        keywords: {
            fr: [
                'mon developpement',
                'mon pdi',
                'mon plan',
                'actions de developpement',
                'objectif*',
            ],
            en: ['my development', 'my idp', 'my plan', 'development action*', 'objective*'],
        },
        answer: {
            fr: '« Mon développement » réunit votre plan de développement individuel (PDI) : objectifs, actions et échéances. Mettez à jour l’avancement de chaque action au fil de l’eau ; votre manager le voit.',
            en: '“My development” brings together your individual development plan (IDP): objectives, actions and due dates. Update each action’s progress as you go; your manager sees it.',
        },
    },
    {
        id: 'my_learning',
        roles: EMP,
        link: '/employee/my-learning',
        title: { fr: 'Mes formations', en: 'My learning' },
        ask: { fr: 'Où trouver mes formations ?', en: 'Where are my training courses?' },
        keywords: {
            fr: ['formation*', 'cours', 'apprentissage', 'e learning', 'lms'],
            en: ['training', 'course*', 'learning', 'e-learning', 'lms'],
        },
        answer: {
            fr: '« Mes formations » liste les formations qui vous sont assignées et leur statut. Une formation terminée dans le LMS remonte ici quand l’intégration est configurée.',
            en: '“My learning” lists the courses assigned to you and their status. A course completed in the LMS shows up here when the integration is configured.',
        },
    },
    {
        id: 'my_certifications',
        roles: EMP,
        link: '/employee/my-certifications',
        title: { fr: 'Mes certifications', en: 'My certifications' },
        ask: {
            fr: 'Comment suivre mes certifications ?',
            en: 'How do I track my certifications?',
        },
        keywords: {
            fr: ['certification*', 'habilitation*', 'expiration', 'diplome*'],
            en: ['certification*', 'certificate*', 'expiry', 'expiring', 'licence*'],
        },
        answer: {
            fr: '« Mes certifications » montre vos certifications, leur date d’expiration et celles à renouveler bientôt.',
            en: '“My certifications” shows your certifications, their expiry dates and those due for renewal soon.',
        },
    },
    {
        id: 'my_coaching',
        roles: EMP,
        module: 'development',
        link: '/employee/my-coaching',
        title: { fr: 'Mon coaching', en: 'My coaching' },
        ask: { fr: 'Où suivre mon coaching ?', en: 'Where do I follow my coaching?' },
        keywords: {
            fr: ['mon coaching', 'mentorat', 'mentor', 'seance*'],
            en: ['my coaching', 'mentoring', 'mentor', 'session notes'],
        },
        answer: {
            fr: '« Mon coaching » affiche vos plans de coaching ou de mentorat actifs, toujours rattachés à un besoin précis (PDI, PIP ou écart de compétence), avec les séances et actions convenues.',
            en: '“My coaching” shows your active coaching or mentoring plans — always tied to a named need (IDP, PIP or skill gap) — with the agreed sessions and actions.',
        },
    },
    {
        id: 'opportunities',
        roles: EMP,
        module: ['mobility', 'engagement'],
        link: '/employee/opportunities',
        title: { fr: 'Mon évolution', en: 'My opportunities' },
        ask: {
            fr: 'Comment exprimer mes souhaits d’évolution ?',
            en: 'How do I share my career aspirations?',
        },
        keywords: {
            fr: [
                'evolution',
                'mobilite',
                'souhait*',
                'aspiration*',
                'carriere',
                'poste interne',
                'reconnaissance',
            ],
            en: [
                'career',
                'mobility',
                'aspiration*',
                'opportunit*',
                'internal job*',
                'recognition',
            ],
        },
        answer: {
            fr: '« Mon évolution » vous permet d’exprimer vos souhaits de mobilité, de voir les opportunités internes, de répondre aux enquêtes et de retrouver les reconnaissances reçues.',
            en: '“My opportunities” lets you share your mobility wishes, see internal opportunities, answer surveys and find the recognition you received.',
        },
    },
    {
        id: 'okr',
        roles: EMP,
        module: 'engagement',
        link: '/employee/okr',
        title: { fr: 'Mes objectifs', en: 'My goals' },
        ask: { fr: 'Où suivre mes objectifs ?', en: 'Where do I track my goals?' },
        keywords: {
            fr: ['okr', 'objectifs', 'resultats cles', 'mes buts'],
            en: ['okr', 'goals', 'key results', 'my objectives'],
        },
        answer: {
            fr: 'La page des objectifs (OKR) montre vos objectifs et résultats clés ; mettez à jour leur avancement lors de vos points réguliers.',
            en: 'The goals (OKR) page shows your objectives and key results; update their progress at your regular check-ins.',
        },
    },
    {
        id: 'one_on_one',
        roles: EMP,
        module: 'engagement',
        link: '/one-on-one',
        title: { fr: 'Mes entretiens 1:1', en: 'My one-to-ones' },
        ask: {
            fr: 'Comment préparer mon entretien individuel ?',
            en: 'How do I prepare my one-to-one?',
        },
        keywords: {
            fr: ['1:1', 'entretien individuel', 'ordre du jour', 'tete a tete', 'point individuel'],
            en: ['1:1', 'one-to-one', 'one on one', 'agenda', 'meeting notes'],
        },
        answer: {
            fr: 'L’espace 1:1 est partagé avec votre responsable : chacun ajoute ses sujets avant l’entretien (l’autre est prévenu), vous prenez des notes partagées et des notes privées que vous seul pouvez lire, et vous convenez d’actions avec un responsable et une échéance. Votre responsable l’ouvre depuis « Mon équipe ».',
            en: 'The 1:1 space is shared with your manager: each of you adds topics before the meeting (the other is notified), you keep shared notes and private notes only you can read, and you agree actions with an owner and a due date. Your manager opens it from “My team”.',
        },
    },
    {
        id: 'feedback_360',
        roles: EMP,
        module: 'development',
        link: '/feedback-360',
        title: { fr: 'Mon feedback 360°', en: 'My 360° feedback' },
        ask: {
            fr: 'Comment fonctionne le feedback 360° ?',
            en: 'How does 360° feedback work?',
        },
        keywords: {
            fr: ['360', 'feedback 360', 'multi evaluateurs', 'evaluateurs', 'questionnaire 360'],
            en: ['360', '360 feedback', 'multi-rater', 'raters', '360 questionnaire'],
        },
        answer: {
            fr: 'Quand un tour 360° est lancé pour vous, vous proposez vos évaluateurs (collègues, collaborateurs, autres) et votre responsable valide la liste. Les réponses des autres ne sont montrées que regroupées, à partir de 3 réponses ; « non observé » n’est jamais compté comme 0. Une fois le rapport communiqué, vous pouvez ajouter des objectifs à votre plan de développement.',
            en: 'When a 360° round is launched for you, you propose your raters (peers, direct reports, others) and your manager approves the list. Others’ answers are only shown grouped, from 3 answers; “not observed” is never counted as 0. Once the report is released, you can add objectives to your development plan.',
        },
    },
    {
        id: 'dispute_rating',
        roles: EMP,
        link: '/employee/assessment-status',
        title: { fr: 'Contester une note', en: 'Dispute a rating' },
        ask: { fr: 'Comment contester une note ?', en: 'How do I dispute a rating?' },
        keywords: {
            fr: ['contester', 'contestation*', 'desaccord', 'litige*', 'pas d accord'],
            en: ['dispute', 'contest', 'disagree', 'challenge a rating', 'appeal'],
        },
        answer: {
            fr: 'Depuis le statut de votre évaluation, contestez une note revue pendant que la fenêtre est ouverte, avec un motif. La contestation suit l’échelle L0 (superviseur) → L1 (manager) → L2 (arbitrage RH), chaque niveau ayant un délai ; sans décision, la note du superviseur est finalisée et vous êtes prévenu.',
            en: 'From your assessment status, dispute a reviewed rating while the window is open, with a reason. It follows the ladder L0 (supervisor) → L1 (manager) → L2 (HR arbitration), each level with a deadline; without a decision the supervisor’s rating is finalised and you are told.',
        },
    },

    // ── Managers (and admins acting on a population) ──────────────────────
    {
        id: 'review_queue',
        roles: MGR_ADM,
        link: '/supervisor/self-assessment-reviews',
        title: { fr: 'Revues à traiter', en: 'Reviews to process' },
        ask: {
            fr: 'Comment revoir les auto-évaluations de mon équipe ?',
            en: 'How do I review my team’s self-assessments?',
        },
        keywords: {
            fr: [
                'revoir',
                'revue*',
                'valider les auto evaluations',
                'approuver',
                'file de revue',
                'relire',
            ],
            en: ['review*', 'approve', 'review queue', 'validate self assessment*'],
        },
        answer: {
            fr: 'La file de revue liste les auto-évaluations soumises dans votre périmètre. Pour chaque compétence : approuvez, rejetez (motif obligatoire, aucune note n’est créée) ou saisissez votre propre note — un motif est obligatoire si elle diffère de l’auto-évaluation. C’est votre note qui devient officielle.',
            en: 'The review queue lists the self-assessments submitted in your span. For each skill: approve, reject (reason required; no rating is created) or enter your own rating — a reason is mandatory when it differs from the self-rating. Your rating becomes the official level.',
        },
    },
    {
        id: 'disputes_queue',
        roles: MGR_ADM,
        link: '/v2/slf/disputes',
        title: { fr: 'Contestations à traiter', en: 'Disputes to resolve' },
        ask: {
            fr: 'Comment traiter une contestation ?',
            en: 'How do I resolve a dispute?',
        },
        keywords: {
            fr: [
                'traiter une contestation',
                'contestations a traiter',
                'arbitrer',
                'resoudre un litige',
            ],
            en: ['resolve a dispute', 'disputes to resolve', 'arbitrate', 'dispute queue'],
        },
        answer: {
            fr: 'La file des contestations montre celles de votre périmètre avec leur niveau et leur échéance. Le superviseur traite L0, le manager L1, un administrateur RH habilité arbitre L2. Répondez avant l’échéance : sinon la contestation monte d’un niveau.',
            en: 'The disputes queue shows those in your span with their level and deadline. The supervisor handles L0, the manager L1, an authorised HR administrator arbitrates L2. Answer before the deadline, or the dispute moves up a level.',
        },
    },
    {
        id: 'supervisor_dashboard',
        roles: ['manager'],
        link: '/supervisor/dashboard',
        title: { fr: 'Tableau de bord manager', en: 'Manager dashboard' },
        ask: {
            fr: 'Que montre le tableau de bord manager ?',
            en: 'What does the manager dashboard show?',
        },
        keywords: {
            fr: ['tableau de bord manager', 'tableau de bord superviseur', 'mon equipe'],
            en: ['manager dashboard', 'supervisor dashboard', 'my team'],
        },
        answer: {
            fr: 'Le tableau de bord manager résume votre équipe : revues en attente, préparation mesurée, couverture d’évaluation et plans en cours. Lisez toujours un score à côté de sa couverture.',
            en: 'The manager dashboard summarises your team: pending reviews, measured readiness, assessment coverage and plans in progress. Always read a score next to its coverage.',
        },
    },
    {
        id: 'gap_analysis',
        roles: MGR_ADM,
        link: '/supervisor/gap-analysis',
        title: { fr: 'Analyse des écarts', en: 'Gap analysis' },
        ask: {
            fr: 'Comment analyser les écarts de mon équipe ?',
            en: 'How do I analyse my team’s skill gaps?',
        },
        keywords: {
            fr: ['analyse des ecarts', 'ecarts de l equipe', 'lacunes'],
            en: ['gap analysis', 'team gaps', 'skill gaps analysis', 'shortfall*'],
        },
        answer: {
            fr: 'L’analyse des écarts compare niveaux requis et niveaux mesurés, personne par personne et compétence par compétence. Les exigences jamais évaluées sont comptées à part (« non mesuré ») : aller mesurer et aller former sont deux actions différentes.',
            en: 'Gap analysis compares required and measured levels, person by person and skill by skill. Requirements never assessed are counted separately (“not measured”): going to measure and going to train are two different actions.',
        },
    },
    {
        id: 'dashboard',
        roles: MGR_ADM,
        link: '/dashboard',
        title: { fr: 'Tableau de bord des capacités', en: 'Capability dashboard' },
        ask: {
            fr: 'Comment lire le tableau de bord des capacités ?',
            en: 'How do I read the capability dashboard?',
        },
        keywords: {
            fr: ['tableau de bord', 'indice de risque', 'cockpit', 'radar'],
            en: ['dashboard', 'risk index', 'cockpit', 'radar', 'scorecard'],
        },
        answer: {
            fr: 'Réglez d’abord le filtre Site / Département / Service, puis lisez l’indice de risque (préparation, couverture, conformité, effectif, fraîcheur), le tableau de santé et le radar réel vs requis. Les onglets détaillent priorités de formation et développement des talents.',
            en: 'Set the Site / Department / Service filter first, then read the risk index (readiness, coverage, compliance, staffing, freshness), the health scorecard and the actual-vs-required radar. The tabs drill into training priorities and talent development.',
        },
    },
    {
        id: 'skill_matrix',
        roles: MGR_ADM,
        link: '/skill-matrix',
        title: { fr: 'Matrice de compétences', en: 'Skill matrix' },
        ask: {
            fr: 'Comment utiliser la matrice de compétences ?',
            en: 'How do I use the skill matrix?',
        },
        keywords: {
            fr: ['matrice', 'matrice de competences', 'grille de competences'],
            en: ['skill matrix', 'matrix', 'skills grid'],
        },
        answer: {
            fr: 'La matrice croise les personnes de votre périmètre et les compétences de leur poste. Un « — » signifie non mesuré (pas 0). Filtrez par organisation ou poste, et exportez si besoin.',
            en: 'The matrix crosses the people in your span with the skills of their role. A “—” means not measured (not 0). Filter by organisation or role, and export if needed.',
        },
    },
    {
        id: 'employees_list',
        roles: MGR_ADM,
        perm: ['view_employees'],
        link: '/employees',
        title: { fr: 'Collaborateurs', en: 'Employees' },
        ask: { fr: 'Comment retrouver un collaborateur ?', en: 'How do I find an employee?' },
        keywords: {
            fr: [
                'collaborateur*',
                'salarie*',
                'fiche',
                'liste du personnel',
                'rechercher une personne',
            ],
            en: ['employee list', 'employees', 'staff list', 'find a person', 'profile page'],
        },
        answer: {
            fr: 'La liste des collaborateurs montre votre périmètre ; recherchez par nom ou filtrez par organisation. La fiche d’une personne donne ses évaluations, son historique, son développement et sa chronologie.',
            en: 'The employee list shows your span; search by name or filter by organisation. A person’s page gives their assessments, history, development and timeline.',
        },
    },
    {
        id: 'coaching_plans',
        roles: MGR_ADM,
        module: 'development',
        link: '/coaching/plans',
        title: { fr: 'Plans de coaching', en: 'Coaching plans' },
        ask: { fr: 'Comment créer un plan de coaching ?', en: 'How do I create a coaching plan?' },
        keywords: {
            fr: ['coaching', 'plan de coaching', 'mentorat', 'accompagner'],
            en: ['coaching', 'coaching plan', 'mentoring', 'mentor'],
        },
        answer: {
            fr: 'Créez un plan de coaching ou de mentorat rattaché à un besoin précis — un PDI, un PIP ou un écart de compétence : la plateforme refuse un plan sans contexte. Planifiez les séances, suivez l’avancement, puis validez la clôture.',
            en: 'Create a coaching or mentoring plan tied to a named need — an IDP, a PIP or a skill gap: the platform refuses a plan without context. Schedule sessions, track progress, then validate the close.',
        },
    },
    {
        id: 'idp_manage',
        roles: MGR_ADM,
        module: 'development',
        link: '/v2/idp/manage',
        title: { fr: 'Plans de développement (PDI)', en: 'Development plans (IDP)' },
        ask: {
            fr: 'Comment créer un plan de développement pour un collaborateur ?',
            en: 'How do I create a development plan for someone?',
        },
        keywords: {
            fr: ['pdi', 'plan de developpement', 'creer un plan', 'plans individuels'],
            en: ['idp', 'development plan', 'create a plan', 'individual plan*'],
        },
        answer: {
            fr: 'Depuis les PDI, créez un plan pour une personne de votre périmètre : objectifs rattachés à ses écarts mesurés, actions (formation, coaching, mise en situation) et échéances. Activez-le ; la personne suit et met à jour ses actions.',
            en: 'From IDPs, create a plan for someone in your span: objectives tied to their measured gaps, actions (training, coaching, on-the-job) and due dates. Activate it; the person follows and updates their actions.',
        },
    },
    {
        id: 'feedback_360_console',
        roles: MGR_ADM,
        module: 'development',
        link: '/feedback-360/manage',
        title: { fr: 'Console feedback 360°', en: '360° feedback console' },
        ask: {
            fr: 'Comment lancer un feedback 360° pour mon équipe ?',
            en: 'How do I launch 360° feedback for my team?',
        },
        keywords: {
            fr: [
                'lancer un 360',
                'campagne 360',
                'feedback 360 equipe',
                'relancer les evaluateurs',
            ],
            en: ['launch a 360', '360 campaign', 'team 360 feedback', 'remind raters'],
        },
        answer: {
            fr: 'Depuis la console 360°, lancez un tour pour une personne ou une campagne pour plusieurs : échéance, nombre minimum d’évaluateurs par groupe et seuil d’anonymat (3 au moins). Validez les évaluateurs proposés, relancez ceux qui n’ont pas répondu — vous voyez qui a répondu, jamais ce qu’il a répondu — puis communiquez le rapport après la clôture.',
            en: 'From the 360° console, launch a round for one person or a campaign for several: deadline, minimum raters per group and anonymity threshold (3 or more). Approve the proposed raters, remind those who have not answered — you see who answered, never what — then release the report after the round closes.',
        },
    },
    {
        id: 'pip',
        roles: MGR_ADM,
        module: 'development',
        link: '/v2/pip',
        title: { fr: 'Plans d’amélioration (PIP)', en: 'Improvement plans (PIP)' },
        ask: { fr: 'Comment ouvrir un PIP ?', en: 'How do I open a PIP?' },
        keywords: {
            fr: ['pip', 'plan d amelioration', 'amelioration de la performance', 'insuffisance'],
            en: ['pip', 'improvement plan', 'performance improvement', 'underperformance'],
        },
        answer: {
            fr: 'Un PIP se propose, puis s’approuve et s’active : objectifs mesurables, soutien prévu, dates de début et de fin, et une issue enregistrée. C’est une décision humaine documentée — confidentielle et limitée à votre périmètre.',
            en: 'A PIP is proposed, then approved and activated: measurable objectives, planned support, start and end dates, and a recorded outcome. It is a documented human decision — confidential and limited to your span.',
        },
    },
    {
        id: 'nine_box',
        roles: MGR_ADM,
        link: '/talent/nine-box',
        title: { fr: 'Grille 9-Box', en: '9-Box grid' },
        ask: { fr: 'Comment utiliser la grille 9-Box ?', en: 'How do I use the 9-Box grid?' },
        keywords: {
            fr: ['9 box', '9box', 'neuf cases', 'positionner', 'calibrage', 'calibration'],
            en: ['9 box', '9box', 'nine box', 'place someone', 'calibration', 'calibrate'],
        },
        answer: {
            fr: 'Proposez un positionnement Performance × Potentiel pour une personne ; seul un manager l’approuve, le rejette, l’archive ou le restitue. Les positionnements sont confidentiels par défaut et chaque personne n’apparaît qu’une fois.',
            en: 'Propose a Performance × Potential placement for someone; only a manager approves, rejects, archives or discloses it. Placements are confidential by default and each person appears exactly once.',
        },
    },
    {
        id: 'talent_actions',
        roles: MGR_ADM,
        link: '/talent/actions',
        title: { fr: 'Actions talents', en: 'Talent actions' },
        ask: {
            fr: 'Où voir tous les PDI, PIP et coachings en cours ?',
            en: 'Where do I see all IDPs, PIPs and coaching in progress?',
        },
        keywords: {
            fr: ['actions talents', 'vue d ensemble des plans', 'plans en cours', 'biais'],
            en: ['talent actions', 'all plans', 'plans in progress', 'bias'],
        },
        answer: {
            fr: '« Actions talents » rassemble PIP, PDI et plans de coaching de votre périmètre en une vue, avec un panneau de calibrage et de détection de biais.',
            en: '“Talent actions” brings the PIPs, IDPs and coaching plans of your span into one view, with a calibration and bias-detection panel.',
        },
    },
    {
        id: 'career_path',
        roles: MGR_ADM,
        link: '/talent/career-path',
        title: { fr: 'Parcours de carrière', en: 'Career path' },
        ask: {
            fr: 'Comment préparer un parcours de carrière ?',
            en: 'How do I plan a career path?',
        },
        keywords: {
            fr: ['parcours de carriere', 'poste cible', 'passerelle'],
            en: ['career path', 'target role', 'next role'],
        },
        answer: {
            fr: 'Le parcours de carrière compare le profil mesuré d’une personne aux exigences d’un poste cible et liste les écarts à combler pour y arriver.',
            en: 'The career path compares a person’s measured profile with the requirements of a target role and lists the gaps to close to get there.',
        },
    },
    {
        id: 'continuity',
        roles: MGR_ADM,
        perm: ['view_continuity', 'manage_succession', 'view_retention_risk', 'manage_handover'],
        module: 'talent',
        link: '/v2/continuity',
        title: { fr: 'Continuité & succession', en: 'Continuity & succession' },
        ask: {
            fr: 'Comment préparer la succession d’un poste clé ?',
            en: 'How do I plan succession for a key role?',
        },
        keywords: {
            fr: [
                'succession',
                'successeur*',
                'releve',
                'continuite',
                'passation',
                'risque de depart',
            ],
            en: [
                'succession',
                'successor*',
                'continuity',
                'handover',
                'retention risk',
                'flight risk',
            ],
        },
        answer: {
            fr: 'Le module Continuité identifie les postes et personnes clés, les successeurs possibles avec leur niveau de préparation, le risque de départ et les passations. Il sert à décider — la décision reste humaine.',
            en: 'The Continuity module identifies key roles and people, possible successors with their readiness, retention risk and handovers. It supports the decision — a person makes it.',
        },
    },
    {
        id: 'key_person',
        roles: MGR_ADM,
        perm: ['view_continuity', 'manage_succession', 'view_retention_risk', 'manage_handover'],
        module: 'talent',
        link: '/exec/key-person',
        title: { fr: 'Risque personne-clé', en: 'Key-person risk' },
        ask: {
            fr: 'Où voir le risque lié aux personnes clés ?',
            en: 'Where do I see key-person risk?',
        },
        keywords: {
            fr: ['personne cle', 'personnes cles', 'dependance', 'single point'],
            en: ['key person', 'key people', 'single point of failure', 'dependency'],
        },
        answer: {
            fr: 'La vue « Risque personne-clé » montre les compétences critiques portées par trop peu de personnes, pour cibler la relève et le transfert de savoir.',
            en: 'The “Key-person risk” view shows critical skills held by too few people, so you can target succession and knowledge transfer.',
        },
    },
    {
        id: 'reports',
        roles: MGR_ADM,
        link: '/reports/builder',
        title: { fr: 'Générateur de rapports', en: 'Report builder' },
        ask: { fr: 'Comment créer un rapport ?', en: 'How do I build a report?' },
        keywords: {
            fr: ['rapport*', 'export excel', 'exporter', 'extraction', 'modele de rapport'],
            en: ['report*', 'excel export', 'export', 'report template*'],
        },
        answer: {
            fr: 'Le générateur de rapports assemble des colonnes (personnes, compétences, préparation, couverture…), filtre sur votre périmètre et exporte. Enregistrez un modèle pour le réutiliser ou le planifier.',
            en: 'The report builder assembles columns (people, skills, readiness, coverage…), filters to your span and exports. Save a template to reuse or schedule it.',
        },
    },
    {
        id: 'readiness_report',
        roles: MGR_ADM,
        link: '/reports/readiness',
        title: { fr: 'Rapport de préparation', en: 'Readiness report' },
        ask: {
            fr: 'Où voir le rapport de préparation au poste ?',
            en: 'Where is the role readiness report?',
        },
        keywords: {
            fr: ['rapport de preparation', 'pret au poste', 'verdict'],
            en: ['readiness report', 'role ready', 'verdict'],
        },
        answer: {
            fr: 'Le rapport de préparation donne, par personne, le score (sur ce qui est mesuré), la couverture et le verdict « prêt au poste » (sur toutes les exigences, compétences critiques comprises).',
            en: 'The readiness report gives, per person, the score (over what was measured), the coverage and the role-ready verdict (over all requirements, critical skills included).',
        },
    },
    {
        id: 'benchmark',
        roles: MGR_ADM,
        link: '/benchmark',
        title: { fr: 'Référentiel (Benchmark)', en: 'Benchmark' },
        ask: {
            fr: 'Comment comparer les exigences des postes ?',
            en: 'How do I compare role requirements?',
        },
        keywords: {
            fr: ['referentiel', 'benchmark', 'comparer les postes', 'adequation'],
            en: ['benchmark', 'compare roles', 'role requirements', 'fit'],
        },
        answer: {
            fr: 'Le Référentiel aligne les postes côte à côte face aux compétences (par pilier et sous-domaine) et mesure l’adéquation des titulaires. À lire avec la couverture.',
            en: 'The Benchmark lines roles up side by side against the skills (by pillar and sub-domain) and measures how well the current holders fit. Read it with coverage.',
        },
    },
    {
        id: 'org_chart',
        roles: MGR_ADM,
        link: '/org-chart',
        title: { fr: 'Organigramme', en: 'Org chart' },
        ask: { fr: 'Où voir l’organigramme ?', en: 'Where is the org chart?' },
        keywords: {
            fr: ['organigramme', 'hierarchie', 'rattachement*'],
            en: ['org chart', 'organisation chart', 'hierarchy', 'reporting line*'],
        },
        answer: {
            fr: 'L’organigramme montre les liens de supervision et de management de votre périmètre ; il permet de repérer une personne sans relecteur.',
            en: 'The org chart shows the supervision and management lines in your span; it helps spot someone with no reviewer.',
        },
    },
    {
        id: 'compliance',
        roles: MGR_ADM,
        perm: ['view_compliance'],
        link: '/compliance',
        title: { fr: 'Conformité', en: 'Compliance' },
        ask: { fr: 'Où suivre la conformité ?', en: 'Where do I track compliance?' },
        keywords: {
            fr: ['conformite', 'obligatoire*', 'reglementaire'],
            en: ['compliance', 'mandatory', 'regulatory'],
        },
        answer: {
            fr: 'L’écran Conformité suit les exigences obligatoires (certifications, habilitations) et signale ce qui expire ou manque dans votre périmètre.',
            en: 'The Compliance screen tracks mandatory requirements (certifications, clearances) and flags what is expiring or missing in your span.',
        },
    },
    {
        id: 'qualified',
        roles: MGR_ADM,
        link: '/qualified',
        title: { fr: 'Personnes qualifiées', en: 'Qualified people' },
        ask: {
            fr: 'Comment trouver les personnes qualifiées sur une compétence ?',
            en: 'How do I find people qualified on a skill?',
        },
        keywords: {
            fr: ['qualifie*', 'trouver un expert', 'qui sait'],
            en: ['qualified', 'find an expert', 'who can do'],
        },
        answer: {
            fr: 'L’écran « Personnes qualifiées » trouve, dans votre périmètre, les personnes qui atteignent un niveau donné sur une compétence — à partir des seuls niveaux validés.',
            en: 'The “Qualified people” screen finds, in your span, the people who reach a given level on a skill — from validated levels only.',
        },
    },

    // ── Administrators ────────────────────────────────────────────────────
    {
        id: 'campaigns',
        roles: ADM,
        perm: ['manage_cycles'],
        module: 'campaigns',
        link: '/cycles',
        title: { fr: 'Campagnes d’évaluation', en: 'Assessment campaigns' },
        ask: {
            fr: 'Comment lancer une campagne d’évaluation ?',
            en: 'How do I launch an assessment campaign?',
        },
        keywords: {
            fr: ['campagne*', 'cycle*', 'lancer', 'ouvrir une campagne', 'relance*'],
            en: ['campaign*', 'cycle*', 'launch', 'open a campaign', 'reminder*'],
        },
        answer: {
            fr: 'Créez la campagne (brouillon), vérifiez les dates, puis ouvrez-la : seule l’ouverture inscrit les participants et fige le roster. Suivez l’avancement sur la console, relancez les non-démarrés, puis verrouillez et clôturez.',
            en: 'Create the campaign (draft), check the dates, then open it: only opening enrols participants and freezes the roster. Follow progress on the console, chase those not started, then lock and close.',
        },
    },
    {
        id: 'organization',
        roles: ADM,
        perm: ['manage_organization'],
        link: '/organization',
        title: { fr: 'Organisation', en: 'Organisation' },
        ask: {
            fr: 'Comment créer les sites et départements ?',
            en: 'How do I set up sites and departments?',
        },
        keywords: {
            fr: ['organisation', 'site*', 'departement*', 'service*', 'structure'],
            en: ['organisation', 'organization', 'site*', 'department*', 'structure'],
        },
        answer: {
            fr: 'Dans Organisation, créez les sites, puis les départements, puis les services : c’est la structure qui sert de périmètre aux droits et de filtre aux tableaux de bord.',
            en: 'In Organisation, create sites, then departments, then services: that structure is the span for access rights and the filter for dashboards.',
        },
    },
    {
        id: 'skills_framework',
        roles: ADM,
        perm: ['view_domains_skills'],
        link: '/domains-skills',
        title: { fr: 'Référentiel de compétences', en: 'Skills framework' },
        ask: {
            fr: 'Comment ajouter une compétence au référentiel ?',
            en: 'How do I add a skill to the framework?',
        },
        keywords: {
            fr: [
                'competence*',
                'domaine*',
                'pilier*',
                'sous domaine*',
                'referentiel de competences',
            ],
            en: ['skill*', 'domain*', 'pillar*', 'sub domain*', 'skills framework'],
        },
        answer: {
            fr: 'Le référentiel a trois niveaux : pilier (domaine) → sous-domaine → compétence. Ajoutez une compétence sous le bon sous-domaine avec une définition claire ; elle devient disponible pour les exigences des postes.',
            en: 'The framework has three levels: pillar (domain) → sub-domain → skill. Add a skill under the right sub-domain with a clear definition; it then becomes available for role requirements.',
        },
    },
    {
        id: 'roles_requirements',
        roles: ADM,
        perm: ['view_roles'],
        link: '/roles',
        title: { fr: 'Postes & exigences', en: 'Roles & requirements' },
        ask: {
            fr: 'Comment définir les exigences d’un poste ?',
            en: 'How do I set a role’s requirements?',
        },
        keywords: {
            fr: ['poste*', 'exigence*', 'niveau requis', 'fiche de poste', 'famille de roles'],
            en: ['role*', 'requirement*', 'required level', 'job profile', 'role family'],
        },
        answer: {
            fr: 'Ouvrez un poste et fixez, compétence par compétence, le niveau requis (0 à 4) et, si besoin, la case « critique ». Un poste créé depuis une famille de rôles pré-suggère ses compétences.',
            en: 'Open a role and set, skill by skill, the required level (0 to 4) and, where needed, the “critical” flag. A role created from a role family pre-suggests its skills.',
        },
    },
    {
        id: 'add_employee',
        roles: ADM,
        perm: ['edit_employees'],
        link: '/employees/create',
        title: { fr: 'Ajouter un collaborateur', en: 'Add an employee' },
        ask: { fr: 'Comment ajouter un collaborateur ?', en: 'How do I add an employee?' },
        keywords: {
            fr: ['ajouter un collaborateur', 'creer un salarie', 'nouvel employe', 'embauche'],
            en: ['add an employee', 'create employee', 'new employee', 'new hire'],
        },
        answer: {
            fr: 'Créez la fiche avec son site, département, service et poste, puis son superviseur et son manager : sans relecteur, une auto-évaluation n’arrive dans aucune file. Pour beaucoup de personnes, utilisez l’import.',
            en: 'Create the record with site, department, service and role, then their supervisor and manager: without a reviewer, a self-assessment reaches no queue. For many people, use the import.',
        },
    },
    {
        id: 'import_data',
        roles: ADM,
        perm: ['import_data', 'export_data'],
        link: '/data-management',
        title: { fr: 'Gestion des données', en: 'Data management' },
        ask: {
            fr: 'Comment importer des collaborateurs en masse ?',
            en: 'How do I bulk import employees?',
        },
        keywords: {
            fr: ['import*', 'export*', 'fichier excel', 'en masse', 'csv', 'sauvegarde'],
            en: ['import*', 'export*', 'excel file', 'bulk', 'csv', 'backup'],
        },
        answer: {
            fr: 'Dans Gestion des données, téléchargez le modèle, remplissez-le, puis importez : un aperçu montre les compteurs (créés, modifiés, rejetés) avant d’appliquer. L’export complet se fait au même endroit.',
            en: 'In Data management, download the template, fill it in, then import: a preview shows the counters (created, updated, rejected) before you apply. The full export lives in the same place.',
        },
    },
    {
        id: 'accounts_invitations',
        roles: ADM,
        perm: ['manage_invitations'],
        link: '/admin/accounts',
        title: { fr: 'Comptes & invitations', en: 'Accounts & invitations' },
        ask: {
            fr: 'Comment inviter des collaborateurs à se connecter ?',
            en: 'How do I invite employees to sign in?',
        },
        keywords: {
            fr: [
                'invitation*',
                'inviter',
                'identifiants',
                'debloquer',
                'compte bloque',
                'renvoyer',
            ],
            en: ['invitation*', 'invite', 'credentials', 'unlock', 'locked account', 'resend'],
        },
        answer: {
            fr: 'La console Comptes envoie les invitations (une personne sans e-mail ne peut pas en recevoir), les renvoie, débloque un compte et traite les demandes des managers.',
            en: 'The Accounts console sends invitations (a person with no e-mail cannot receive one), resends them, unlocks an account and handles managers’ requests.',
        },
    },
    {
        id: 'onboarding',
        roles: ADM,
        perm: ['manage_onboarding'],
        link: '/onboarding',
        title: { fr: 'Demandes d’inscription', en: 'Onboarding requests' },
        ask: {
            fr: 'Comment traiter les demandes d’inscription ?',
            en: 'How do I process sign-up requests?',
        },
        keywords: {
            fr: ['inscription*', 'onboarding', 'demande d acces', 'libre service'],
            en: ['sign up', 'signup', 'onboarding', 'access request*', 'self service'],
        },
        answer: {
            fr: 'Les demandes d’inscription en libre-service arrivent ici ; vérifiez l’identité et le rattachement, puis acceptez ou refusez.',
            en: 'Self-service sign-up requests arrive here; check identity and placement, then accept or decline.',
        },
    },
    {
        id: 'admins',
        roles: ADM,
        perm: ['manage_admins'],
        link: '/admins',
        title: { fr: 'Administrateurs', en: 'Administrators' },
        ask: {
            fr: 'Comment créer un administrateur local ?',
            en: 'How do I create a local administrator?',
        },
        keywords: {
            fr: ['administrateur*', 'admin local', 'delegation', 'capacite*', 'droits admin'],
            en: ['administrator*', 'local admin', 'delegation', 'capabilit*', 'admin rights'],
        },
        answer: {
            fr: 'Créez un administrateur local avec un périmètre (sites, départements) et des capacités précises, pour une durée limitée (12 mois par défaut). L’accès permanent doit rester l’exception.',
            en: 'Create a local administrator with a span (sites, departments) and specific capabilities, for a limited time (12 months by default). Permanent access should stay the exception.',
        },
    },
    {
        id: 'system_logs',
        roles: ADM,
        perm: ['view_system_logs'],
        link: '/system-logs',
        title: { fr: 'Journal d’audit', en: 'Audit log' },
        ask: { fr: 'Où consulter le journal d’audit ?', en: 'Where is the audit log?' },
        keywords: {
            fr: ['journal*', 'audit', 'trace*', 'historique des actions', 'qui a fait'],
            en: ['log*', 'audit', 'trail', 'who did', 'activity history'],
        },
        answer: {
            fr: 'Le journal d’audit trace chaque action sensible (qui, quoi, quand), cloisonné à votre périmètre. La chaîne de hachage permet de vérifier qu’il n’a pas été altéré.',
            en: 'The audit log records every sensitive action (who, what, when), limited to your span. Its hash chain lets you verify it has not been tampered with.',
        },
    },
    {
        id: 'app_settings',
        roles: ADM,
        perm: ['view_app_settings'],
        link: '/app-settings',
        title: { fr: 'Paramètres', en: 'Settings' },
        ask: {
            fr: 'Où configurer les paramètres de l’application ?',
            en: 'Where do I configure application settings?',
        },
        keywords: {
            fr: ['parametre*', 'reglage*', 'configuration', 'smtp', 'copilote', 'assistant'],
            en: ['setting*', 'configuration', 'configure', 'smtp', 'copilot', 'assistant'],
        },
        answer: {
            fr: 'Les paramètres sont regroupés par catégorie (e-mail, campagnes, contestations, copilote…). Chaque valeur est validée et chaque changement est tracé. L’assistant et le copilote s’y activent ou se désactivent.',
            en: 'Settings are grouped by category (e-mail, campaigns, disputes, copilot…). Each value is validated and every change is logged. The assistant and the copilot are switched on or off there.',
        },
    },
    {
        id: 'setup',
        roles: ADM,
        superadmin: true,
        link: '/setup',
        title: { fr: 'Mise en route', en: 'Getting started' },
        ask: {
            fr: 'Quelles étapes pour configurer l’application ?',
            en: 'What are the steps to set up the application?',
        },
        keywords: {
            fr: [
                'mise en route',
                'premiers pas',
                'installation',
                'demarrage',
                'configurer l application',
            ],
            en: ['getting started', 'first steps', 'setup', 'set up', 'onboard the product'],
        },
        answer: {
            fr: 'La mise en route suit l’ordre : organisation → compétences → postes et exigences → collaborateurs (avec relecteur) → campagne → évaluations, plus l’e-mail. Chaque étape affiche son état et un lien pour la terminer.',
            en: 'Getting started follows the order: organisation → skills → roles and requirements → employees (with a reviewer) → campaign → assessments, plus e-mail. Each step shows its state and a link to finish it.',
        },
    },
    {
        id: 'health',
        roles: ADM,
        superadmin: true,
        link: '/admin/health',
        title: { fr: 'Santé de l’instance', en: 'Instance health' },
        ask: {
            fr: 'Comment vérifier la santé du serveur ?',
            en: 'How do I check the server’s health?',
        },
        keywords: {
            fr: ['sante', 'serveur', 'taches planifiees', 'migrations', 'supervision'],
            en: ['health', 'server', 'scheduled jobs', 'migrations', 'monitoring'],
        },
        answer: {
            fr: 'La page Santé montre base de données, e-mail, migrations, licence et tâches planifiées ; « Exécuter maintenant » lance une tâche et l’inscrit au journal.',
            en: 'The Health page shows database, e-mail, migrations, licence and scheduled jobs; “Run now” runs a job and records it in the log.',
        },
    },
    {
        id: 'sso',
        roles: ADM,
        superadmin: true,
        link: '/app-settings/sso',
        title: { fr: 'Authentification unique (SSO)', en: 'Single sign-on (SSO)' },
        ask: { fr: 'Comment configurer le SSO ?', en: 'How do I configure SSO?' },
        keywords: {
            fr: ['sso', 'authentification unique', 'entra', 'azure', 'saml', 'oidc'],
            en: ['sso', 'single sign on', 'entra', 'azure', 'saml', 'oidc'],
        },
        answer: {
            fr: 'Les réglages SSO relient l’application à votre fournisseur d’identité (Entra ID, SAML, OIDC). Testez la connexion avant de l’imposer, et gardez un accès administrateur de secours.',
            en: 'SSO settings connect the application to your identity provider (Entra ID, SAML, OIDC). Test the connection before enforcing it, and keep a break-glass administrator account.',
        },
    },
    {
        id: 'access_review',
        roles: ADM,
        superadmin: true,
        link: '/admin/access-review',
        title: { fr: 'Revue d’accès', en: 'Access review' },
        ask: {
            fr: 'Comment faire la revue des accès administrateurs ?',
            en: 'How do I review administrator access?',
        },
        keywords: {
            fr: ['revue d acces', 'revue des acces', 'attester', 'comptes dormants'],
            en: ['access review', 'attest', 'dormant account*', 'recertif*'],
        },
        answer: {
            fr: 'La revue d’accès liste chaque compte administrateur avec périmètre, capacités, expiration, MFA et dernière activité, et signale les anomalies. Attestez chaque ligne ; l’attestation est inscrite au journal.',
            en: 'The access review lists every admin account with span, capabilities, expiry, MFA and last activity, and flags the exceptions. Attest each row; the attestation is written to the log.',
        },
    },
    {
        id: 'api_keys',
        roles: ADM,
        superadmin: true,
        link: '/admin/api-keys',
        title: { fr: 'Clés d’API', en: 'API keys' },
        ask: {
            fr: 'Comment connecter Power BI ou une intégration ?',
            en: 'How do I connect Power BI or an integration?',
        },
        keywords: {
            fr: ['api', 'cle d api', 'power bi', 'integration*', 'webhook*'],
            en: ['api', 'api key*', 'power bi', 'integration*', 'webhook*'],
        },
        answer: {
            fr: 'Créez une clé d’API dédiée à chaque intégration (Power BI, SIRH), avec le strict nécessaire ; chaque clé a son propre quota et peut être révoquée.',
            en: 'Create a dedicated API key for each integration (Power BI, HRIS), with only what it needs; each key has its own quota and can be revoked.',
        },
    },
];

const CONCEPTS = [
    {
        id: 'readiness',
        related: 'readiness_report',
        keywords: {
            fr: ['preparation', 'pret au poste', 'score de preparation', 'verdict'],
            en: ['readiness', 'role ready', 'readiness score', 'ready for the role', 'verdict'],
        },
        title: { fr: 'Préparation au poste', en: 'Role readiness' },
        answer: {
            fr: 'Le score de préparation est un pourcentage : les points obtenus sur les seules exigences réellement évaluées. Quand rien n’est évalué, il affiche « Non mesuré », jamais 0 %. Le verdict « prêt au poste » est une autre question : il exige, sur TOUTES les exigences, d’atteindre le seuil (80 % par défaut) ET de satisfaire chaque compétence critique.',
            en: 'The readiness score is a percentage: points obtained over the requirements actually assessed. When nothing has been assessed it reads “Not measured”, never 0 %. The role-ready verdict is a different question: over ALL requirements, it needs the threshold (80 % by default) AND every critical skill met.',
        },
    },
    {
        id: 'not_measured',
        related: 'self_assessment',
        keywords: {
            fr: ['non mesure', 'non mesuree', 'pas mesure', 'tiret', 'non evalue'],
            en: ['not measured', 'unmeasured', 'not assessed', 'dash'],
        },
        title: { fr: '« Non mesuré »', en: '“Not measured”' },
        answer: {
            fr: 'L’idée clé du produit : une absence de mesure n’est pas un résultat. Une compétence que personne n’a évaluée affiche « — » et n’est jamais comptée comme 0 ni comme un écart. Un niveau 0 est l’inverse : quelqu’un a regardé et constaté un niveau nul.',
            en: 'The key idea of the product: an absence of measurement is not a result. A skill nobody has assessed shows “—” and is never counted as 0 or as a gap. A level 0 is the opposite: somebody looked and found nothing.',
        },
    },
    {
        id: 'gap',
        related: 'gap_analysis',
        keywords: {
            fr: ['ecart*', 'lacune*', 'insuffisance'],
            en: ['gap*', 'skill gap', 'shortfall'],
        },
        title: { fr: 'Écart de compétence', en: 'Skill gap' },
        answer: {
            fr: 'Un écart est une insuffisance MESURÉE : le niveau requis par le poste moins le niveau constaté. Une exigence jamais évaluée ne crée aucun écart — elle est « non mesurée ». Aller mesurer et aller former sont deux consignes différentes.',
            en: 'A gap is a MEASURED shortfall: the level the role requires minus the level observed. A requirement never assessed creates no gap — it is “not measured”. Going to measure and going to train are two different instructions.',
        },
    },
    {
        id: 'critical',
        related: 'roles_requirements',
        keywords: {
            fr: ['competence critique', 'critique*'],
            en: ['critical skill*', 'critical'],
        },
        title: { fr: 'Compétence critique', en: 'Critical skill' },
        answer: {
            fr: 'Une exigence marquée « critique » doit être satisfaite pour que la personne soit déclarée prête au poste, quel que soit son score global. Les écarts critiques sont donc à traiter en premier.',
            en: 'A requirement flagged “critical” must be met for the person to be declared role-ready, whatever the overall score. Critical gaps are therefore the first to address.',
        },
    },
    {
        id: 'ninebox',
        related: 'nine_box',
        keywords: {
            fr: ['9 box', '9box', 'neuf cases', 'performance potentiel'],
            en: ['9 box', '9box', 'nine box', 'performance potential'],
        },
        title: { fr: '9-Box', en: '9-Box' },
        answer: {
            fr: 'Une grille Performance × Potentiel de neuf cases, pour calibrer les talents. Les positionnements sont confidentiels par défaut ; seul un positionnement approuvé peut être restitué à la personne, par choix explicite de son manager.',
            en: 'A Performance × Potential grid of nine cells, used to calibrate talent. Placements are confidential by default; only an approved placement can be disclosed to the person, by their manager’s explicit choice.',
        },
    },
    {
        id: 'dispute',
        related: 'dispute_rating',
        keywords: {
            fr: ['contestation*', 'litige*', 'l0', 'l1', 'l2', 'arbitrage'],
            en: ['dispute*', 'l0', 'l1', 'l2', 'arbitration', 'escalation'],
        },
        title: { fr: 'Contestation', en: 'Dispute' },
        answer: {
            fr: 'Une escalade datée pour qu’aucune note contestée ne bloque une campagne : L0 le superviseur (5 jours par défaut), L1 le manager (7 jours), L2 l’arbitrage RH (7 jours), puis finalisation automatique sur la note du superviseur, tracée et notifiée.',
            en: 'A timed escalation so no contested rating stalls a campaign: L0 the supervisor (5 days by default), L1 the manager (7 days), L2 HR arbitration (7 days), then automatic finalisation on the supervisor’s rating, logged and notified.',
        },
    },
    {
        id: 'campaign',
        related: 'campaigns',
        keywords: {
            fr: ['campagne*', 'cycle*', 'roster'],
            en: ['campaign*', 'cycle*', 'roster'],
        },
        title: { fr: 'Campagne d’évaluation', en: 'Assessment campaign' },
        answer: {
            fr: 'Une fenêtre datée à quatre états : Brouillon → Ouverte → Verrouillée → Close. Seule l’ouverture inscrit les participants et construit le roster, base de calcul de l’avancement ; une campagne en brouillon ne contient personne.',
            en: 'A timed window with four states: Draft → Open → Locked → Closed. Only opening enrols participants and builds the roster that progress is measured against; a draft campaign has nobody in it.',
        },
    },
    {
        id: 'idp',
        related: 'my_development',
        keywords: {
            fr: ['pdi', 'plan de developpement', 'plan individuel'],
            en: ['idp', 'development plan', 'individual development'],
        },
        title: {
            fr: 'PDI (plan de développement individuel)',
            en: 'IDP (individual development plan)',
        },
        answer: {
            fr: 'Un PDI rassemble objectifs, actions (formation, coaching, mise en situation) et échéances pour combler des écarts mesurés ou préparer une évolution. Il est tenu à jour par la personne et suivi par son manager.',
            en: 'An IDP gathers objectives, actions (training, coaching, on-the-job) and due dates to close measured gaps or prepare a move. The person keeps it up to date and their manager follows it.',
        },
    },
    {
        id: 'pip',
        related: 'pip',
        keywords: {
            fr: ['pip', 'plan d amelioration'],
            en: ['pip', 'performance improvement plan', 'improvement plan'],
        },
        title: {
            fr: 'PIP (plan d’amélioration de la performance)',
            en: 'PIP (performance improvement plan)',
        },
        answer: {
            fr: 'Un PIP est un plan formel et daté, proposé puis approuvé, avec objectifs mesurables et soutien prévu, clos par une issue enregistrée. C’est une décision humaine, confidentielle.',
            en: 'A PIP is a formal, dated plan, proposed then approved, with measurable objectives and planned support, closed with a recorded outcome. It is a confidential human decision.',
        },
    },
    {
        id: 'succession',
        related: 'continuity',
        keywords: {
            fr: ['succession', 'successeur*', 'releve', 'continuite'],
            en: ['succession', 'successor*', 'continuity', 'bench strength'],
        },
        title: { fr: 'Succession', en: 'Succession' },
        answer: {
            fr: 'La planification de la succession identifie, pour un poste ou une personne clé, qui pourrait prendre le relais et quand (prêt maintenant, à 1-2 ans…), à partir des niveaux mesurés. Elle éclaire une décision qui reste humaine.',
            en: 'Succession planning identifies, for a key role or person, who could take over and when (ready now, in 1-2 years…), from measured levels. It informs a decision a person still makes.',
        },
    },
    {
        id: 'coverage',
        related: 'readiness_report',
        keywords: {
            fr: ['couverture', 'taux d evaluation'],
            en: ['coverage', 'assessment coverage'],
        },
        title: { fr: 'Couverture', en: 'Coverage' },
        answer: {
            fr: 'La part des exigences réellement évaluées. Elle accompagne chaque score : un chiffre faible avec une couverture faible veut dire « allez évaluer », pas « ces personnes sont faibles ».',
            en: 'The share of requirements actually assessed. It travels with every score: a low figure at low coverage means “go and assess”, not “these people are weak”.',
        },
    },
    {
        id: 'levels',
        related: 'self_assessment',
        keywords: {
            fr: ['echelle', 'niveau* 0', 'niveau*', 'guide', 'autonome', 'expert'],
            en: ['scale', 'level*', 'guided', 'autonomous', 'expert', 'proficiency'],
        },
        title: { fr: 'Échelle de niveaux 0–4', en: 'Level scale 0–4' },
        answer: {
            fr: '0 Aucun · 1 Notions de base · 2 Guidé · 3 Autonome · 4 Expert (peut former). La frontière décisive : 2 « Guidé », il faut quelqu’un avec vous ; 3 « Autonome », non.',
            en: '0 None · 1 Basic awareness · 2 Guided · 3 Autonomous · 4 Expert (can teach). The boundary that matters: at 2 “Guided” you need someone with you; at 3 “Autonomous” you do not.',
        },
    },
];

/** Suggested prompts per role (chips), shown before any page-specific ones. */
const ROLE_PROMPTS = {
    employee: [
        { fr: 'Que dois-je faire maintenant ?', en: 'What should I do next?' },
        { fr: 'Quelle est ma préparation au poste ?', en: 'What is my role readiness?' },
        { fr: 'Que veut dire « non mesuré » ?', en: 'What does “not measured” mean?' },
    ],
    manager: [
        { fr: 'Que dois-je faire maintenant ?', en: 'What should I do next?' },
        { fr: 'Quelle est la préparation par site ?', en: 'What is the readiness by site?' },
        { fr: 'Qu’est-ce qu’un écart de compétence ?', en: 'What is a skill gap?' },
    ],
    admin: [
        { fr: 'Que dois-je faire maintenant ?', en: 'What should I do next?' },
        {
            fr: 'Quels sont nos principaux écarts de compétences ?',
            en: 'What are our top skill gaps?',
        },
        { fr: 'Que peux-tu faire ?', en: 'What can you do?' },
    ],
};

module.exports = { ENTRIES, CONCEPTS, ROLE_PROMPTS };
