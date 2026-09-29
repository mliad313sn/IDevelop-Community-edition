'use strict';
/**
 * Canonical bilingual (FR/EN) user-guide content for IDevelop.
 *
 * Pure data — consumed by BOTH the standalone generator
 * (scripts/build-user-guide.js) and the in-app contextual guide
 * (GuideController → /guide), so there is a single source of truth.
 *
 * PROVENANCE. Every block below was verified against the RUNNING application
 * (3.22.85, database de démonstration) by the documentation design review on
 * 2026-09-02, one lane per profile, driving the real screens with the five test
 * accounts. Figures quoted in the text are the values those screens actually
 * displayed. Where an integration could not be exercised on this instance (SSO,
 * the LMS completion loop), the block says so rather than describing it as
 * observed behaviour. Nothing here is aspirational: a manual that promises a
 * capability the product lacks reads as a guarantee, which is the worst defect
 * a manual can carry.
 *
 * EVERY PERSON NAMED IN THIS FILE IS INVENTED, and must stay invented.
 * What happened: the examples had been
 * written straight off the running database, so the manual named 23 ACTIVE
 * colleagues in full, quoted their staff numbers, and printed their 9-box box
 * label ("Shooting Star", "Concern") and their IDP / PIP / coaching numbers in
 * running text. Anyone who could open the guide could therefore read a
 * colleague's talent placement although no disclosure had ever been made —
 * which rule 17 of the rulebook forbids "on every path, without exception".
 * The figures were kept exactly as measured; only the identities were swapped,
 * one for one, so every table in the manual still adds up. The cast:
 *   the governed team  Aïcha FARRELL (their manager) · Bakary FARRELL ·
 *     Sékou ZANTÉ · Nadia FONTÉRA · Léa KESSLER · Idrissa MARCHÉTTI · Mariama TANAKA ·
 *     Zoumana WALSH · Clarisse OYÉRÉ · Landry PETROV · Aminata BRENNAN ·
 *     Thierry ABÉRNATH · Yacine RIVERA · Ferdinand POUNDÉ · Rachelle ESPOSITO ·
 *     Norah HARTLEY        (staff numbers DEMO-1000 … DEMO-1115)
 *   elsewhere  Anicet VANCÉO (DEMO-2004) · Rachid QUINN · Fabrice BECKER ·
 *     Souleymane LARSÈN · Yao HALVORSEN (DEMO-3007) · Bintou NORDIN ·
 *     Joseph DAHLÉN · the leaver record ERASED-90010.
 * Before adding an example, invent the person. tests/unit/userGuideNotPublic.test.js
 * cross-checks this file AND the built guides against the live employee table and
 * fails if a real full name or staff number reappears.
 *
 * `imgRetired` marks a screenshot PULLED for the same reason: its pixels carried
 * names, staff numbers or brand tokens that no text scanner can see. The name is
 * kept so the re-capture list lives here rather than in a report nobody reads.
 * A retired shot may only come back re-taken on invented data.
 *
 * THE RULE THE WHOLE PRODUCT TURNS ON: an ABSENCE of measurement is not a
 * result. “—” / “Not measured” is never rounded to zero and never counted as a
 * gap; a level 0 is a measured finding and is. The guide names that distinction
 * in the glossary, in the FAQ, and in every screen description where it applies.
 *
 * Shape:
 *   PROFILES[] { id, icon, color, name{en,fr}, tagline{en,fr}, features[] }
 *   features[] { icon, img, title{en,fr}, where{en,fr}, what{en,fr},
 *                steps?{en:[],fr:[]}, tip?{en,fr} }   — steps/tip are OPTIONAL
 *   FLOWS[]    { icon, title, actors, when, steps, example, practices }
 *   GLOSSARY[] [enTerm, frTerm, enDef, frDef]
 *   FAQ[]      [enQ, frQ, enA, frA]
 *   img        = a file basename in tests/uat/screenshots-min/ (no extension).
 *                A referenced image with no file is a BLOCKING build error.
 *   imgRetired = the basename of a screenshot withdrawn for exposing real data;
 *                `img` is null beside it. Never render it — it is a to-do.
 */

const PROFILES = [
    {
        id: 'employee',
        icon: '🧑‍💼',
        color: '#0ea5e9',
        name: { en: 'Employee', fr: 'Collaborateur' },
        tagline: {
            en: 'Rate your own skills honestly, follow your development, and keep your account reachable.',
            fr: 'Évaluez vos compétences honnêtement, suivez votre développement et gardez votre compte joignable.',
        },
        features: [
            {
                icon: '🏠',
                img: null,
                imgRetired: 'emp-01-dashboard',
                title: {
                    fr: 'Votre tableau de bord — préparation, écarts mesurés et non mesurés',
                    en: 'Your dashboard — readiness, measured gaps and unmeasured skills',
                },
                where: {
                    fr: 'Accueil / Mon espace (première page après connexion)',
                    en: 'Home / My workspace (landing page after sign-in)',
                },
                what: {
                    fr: "Votre page d'accueil affiche quatre cartes de synthèse et le détail de vos compétences. Sur le compte de démonstration : <b>89 % PRÉPARATION AU POSTE — 39/49 compétences atteintes</b>, <b>9 ÉCARTS DE COMPÉTENCES · 0 critique(s) · 1 Non mesuré</b>, <b>POSITION 9-BOX : Non positionné</b> (« Aucun positionnement approuvé pour le moment »), et <b>ÉTAT DE L'ÉVALUATION : Non commencé</b>. Le tableau « Mes écarts de compétences » liste chaque compétence du poste avec <b>REQUIS</b>, <b>ACTUEL</b> et <b>ÉCART</b>. Lisez-le attentivement : une ligne à <b>ACTUEL = 0</b> et <b>ÉCART = −1</b> (ex. <i>Training & Mentorship</i>) signifie « évalué, niveau nul » ; une ligne à <b>ACTUEL = —</b> et <b>ÉCART = Non mesuré</b> (ex. <i>Budget & Cost Control</i>) signifie « jamais évaluée ». La seconde <b>n'est pas comptée dans les 9 écarts</b> : le produit ne présente jamais une absence de mesure comme un résultat. La carte « Préparation » ne bouge que sur les compétences réellement mesurées.",
                    en: 'Your landing page shows four summary cards and your full skill detail. On the demo account: <b>89% ROLE READINESS — 39/49 skills met</b>, <b>9 SKILL GAPS · 0 critical · 1 Not measured</b>, <b>9-BOX POSITION: Not placed</b> (“No approved placement yet”), and <b>ASSESSMENT STATE: Not started</b>. The “My skill gaps” table lists every skill your role requires with <b>REQUIRED</b>, <b>CURRENT</b> and <b>GAP</b>. Read it carefully: a row with <b>CURRENT = 0</b> and <b>GAP = −1</b> (e.g. <i>Training & Mentorship</i>) means “assessed, level zero”; a row with <b>CURRENT = —</b> and <b>GAP = Not measured</b> (e.g. <i>Budget & Cost Control</i>) means “never assessed”. The second is <b>not counted in the 9 gaps</b>: the product never presents an absence of measurement as a result. The readiness figure only moves on skills that were actually measured.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Accueil</b> (menu de gauche, « Mon espace »).',
                        "Lisez les quatre cartes : préparation, écarts, position 9-box, état de l'évaluation.",
                        'Dans « Mes écarts de compétences », distinguez <b>−1 / −2</b> (écart mesuré, à combler) de <b>Non mesuré</b> (à faire évaluer).',
                        "Cliquez sur <b>mettre à jour l'auto-évaluation →</b> ou sur le bouton <b>Démarrer mon auto-évaluation</b> pour agir.",
                        "Utilisez les cartes d'actions rapides en bas : <b>Mon auto-évaluation</b>, <b>Mon statut</b>, <b>Revues du superviseur</b>, <b>Plan de développement</b>, <b>Coaching</b>, <b>Mon profil</b>.",
                    ],
                    en: [
                        'Open <b>Home</b> (left menu, “My Space”).',
                        'Read the four cards: readiness, gaps, 9-box position, assessment state.',
                        'In “My skill gaps”, tell <b>−1 / −2</b> (a measured shortfall to close) apart from <b>Not measured</b> (a skill to get assessed).',
                        'Click <b>update self-assessment →</b> or the <b>Start my self-assessment</b> button to act.',
                        'Use the quick-action cards at the bottom: <b>My Self-Assessment</b>, <b>My Status</b>, <b>Supervisor reviews</b>, <b>Development plan</b>, <b>Coaching</b>, <b>My profile</b>.',
                    ],
                },
                tip: {
                    fr: "Un « Non mesuré » ne vous pénalise pas et ne vous protège pas non plus : il ne dit rien. Faites-le disparaître en évaluant la compétence — c'est la seule manière d'obtenir un chiffre honnête.",
                    en: 'A “Not measured” neither penalises nor protects you: it says nothing at all. Make it disappear by rating the skill — that is the only way to get an honest figure.',
                },
            },
            {
                icon: '📝',
                img: 'emp-02-self-assessment',
                title: { fr: 'Remplir votre auto-évaluation', en: 'Complete your self-assessment' },
                where: {
                    fr: 'Auto-évaluation (menu de gauche)',
                    en: 'Self-Assessment (left menu)',
                },
                what: {
                    fr: "Vous notez votre niveau actuel sur chaque compétence exigée par votre poste. L'échelle réelle affichée en haut de page est : <b>0 Aucun · 1 Notions de base · 2 Guidé · 3 Autonome · 4 Expert</b>. Tant que vous n'avez pas choisi, la liste déroulante affiche <b>« — Choisir — »</b> : une compétence non notée ne vaut donc <b>pas</b> 0, elle est simplement vide, et le statut de la ligne reste <b>NON COMMENCÉ</b>. Le compteur en tête de page compte les lignes réellement renseignées : sur le compte de démonstration il indique <b>« 0 sur 50 compétences évaluées · 50 restant à évaluer »</b>, avec une estimation <b>« Environ 7 min pour terminer »</b>. Les compétences sont groupées par pilier (1. HSE & Operational Risk 0/1 · 2. Functional Technical 0/1 · 3. Digital, Data & Work Tools 0/37 · 4. Compliance & Certification 0/2 · 5. Business Acumen 0/6 · 6. People Management 0/3). Colonnes : <b>COMPÉTENCE</b>, <b>NIVEAU REQUIS</b>, <b>VOTRE AUTO-ÉVALUATION</b>, <b>STATUT</b>, <b>NOTES</b> (zone de texte libre). Filtres : <b>Toutes</b>, <b>Non évaluées (50)</b>, <b>Critiques (0)</b>, <b>Sous le niveau requis (0)</b>, plus <b>Afficher mon dernier niveau validé</b>, <b>Suivante non évaluée</b> et <b>Tout replier</b>. Raccourcis clavier : <b>0–4</b> pour noter, <b>J/K</b> ou <b>↑↓</b> pour naviguer. Deux boutons : <b>Enregistrer le brouillon</b> et <b>Soumettre pour revue</b>.",
                    en: "You rate your current level on every skill your role requires. The scale actually shown at the top of the page is: <b>0 None · 1 Basic Awareness · 2 Guided · 3 Autonomous · 4 Expert</b>. Until you choose, the dropdown reads <b>“— Choose —”</b>: an unrated skill is therefore <b>not</b> a 0, it is simply empty, and the row's status stays <b>NOT STARTED</b>. The header counter counts rows you actually filled in: on the demo account it reads <b>“0 of 50 skills rated · 50 left to rate”</b>, with an <b>“About 7 min left to finish”</b> estimate. Skills are grouped by pillar (1. HSE & Operational Risk 0/1 · 2. Functional Technical 0/1 · 3. Digital, Data & Work Tools 0/37 · 4. Compliance & Certification 0/2 · 5. Business Acumen 0/6 · 6. People Management 0/3). Columns: <b>SKILL</b>, <b>REQUIRED LEVEL</b>, <b>YOUR SELF-RATING</b>, <b>STATUS</b>, <b>NOTES</b> (free-text box). Filters: <b>All</b>, <b>Not yet rated (50)</b>, <b>Critical (0)</b>, <b>Below required (0)</b>, plus <b>Show my last validated level</b>, <b>Next unrated</b> and <b>Collapse all</b>. Keyboard: <b>0–4</b> to rate, <b>J/K</b> or <b>↑↓</b> to move. Two buttons: <b>Save Draft</b> and <b>Submit for Review</b>.",
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Auto-évaluation</b> dans le menu de gauche.',
                        'Pour chaque compétence, remplacez <b>« — Choisir — »</b> par votre niveau : <b>0 Aucun · 1 Notions de base · 2 Guidé · 3 Autonome · 4 Expert</b>.',
                        'Ajoutez une note dans la colonne <b>NOTES</b> si un exemple concret aide votre relecteur.',
                        'Cliquez sur <b>Enregistrer le brouillon</b> à tout moment ; le compteur « restant à évaluer » diminue au fil de vos saisies.',
                        'Quand tout est renseigné, cliquez sur <b>Soumettre pour revue</b>.',
                    ],
                    en: [
                        'Open <b>Self-Assessment</b> from the left menu.',
                        'For each skill, replace <b>“— Choose —”</b> with your level: <b>0 None · 1 Basic Awareness · 2 Guided · 3 Autonomous · 4 Expert</b>.',
                        'Add a note in the <b>NOTES</b> column if a concrete example helps your reviewer.',
                        'Click <b>Save Draft</b> at any time; the “left to rate” counter falls as you fill rows in.',
                        'When everything is filled in, click <b>Submit for Review</b>.',
                    ],
                },
                tip: {
                    fr: "Laisser <b>« — Choisir — »</b> n'est pas neutre : la compétence restera « Non mesuré » sur votre tableau de bord et personne ne saura où vous en êtes. Un <b>0</b> assumé est une information ; un vide n'en est pas une.",
                    en: 'Leaving <b>“— Choose —”</b> is not a neutral option: the skill stays “Not measured” on your dashboard and nobody knows where you stand. An honest <b>0</b> is information; a blank is not.',
                },
            },
            {
                icon: '📊',
                img: 'emp-03-assessment-status',
                title: {
                    fr: "Suivre l'état de votre évaluation",
                    en: 'Track your assessment status',
                },
                where: { fr: 'Mon statut (menu de gauche)', en: 'My Status (left menu)' },
                what: {
                    fr: "Cette page situe votre évaluation dans la campagne en cours et dans le circuit de revue. Le bandeau <b>Campagne en cours</b> affiche le cycle et sa date de clôture — sur une instance d’exemple : <b>« 2026-Q3 — clôture le 31/08/2026 ÉCHÉANCE DÉPASSÉE »</b> — puis <b>Votre situation : Pas encore commencée</b>. Trois barres chiffrent l'avancement, toutes rapportées aux <b>compétences demandées</b> : <b>Compétences renseignées 0 sur 49</b>, <b>Envoyées à la revue 0 sur 49</b>, <b>Approuvées 0 sur 49</b>. La page rappelle explicitement que « <i>Toutes les compétences définies par votre département pour votre poste sont à évaluer — aucune n'est retirée de la liste</i> ». Le tableau du bas (COMPÉTENCE / NIVEAU AUTO-ÉVALUÉ / ÉTAT / COMMENTAIRES / ACTIONS) liste chaque compétence soumise et son état ; il affiche <b>« Aucune auto-évaluation pour le moment. »</b> tant que rien n'a été envoyé. Un bouton <b>Continuer mon auto-évaluation</b> ramène à la saisie.",
                    en: 'This page places your assessment inside the current campaign and inside the review flow. The <b>Current campaign</b> banner shows the cycle and its closing date — on a sample instance: <b>“2026-Q3 — closes on 31/08/2026 PAST THE DEADLINE”</b> — then <b>Where you stand: Not started yet</b>. Three bars quantify progress, all against the <b>skills required</b>: <b>Skills rated 0 of 49</b>, <b>Sent for review 0 of 49</b>, <b>Approved 0 of 49</b>. The page explicitly states that “<i>Every skill your department defined for your role is to be assessed — none are removed from the list</i>”. The table below (SKILL / SELF LEVEL / STATE / COMMENTS / ACTIONS) lists each submitted skill and its state; it reads <b>“No self-assessments yet.”</b> until something is sent. A <b>Continue my self-assessment</b> button takes you back to the form.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mon statut</b> dans le menu.',
                        'Lisez la campagne en cours et sa date de clôture — un badge <b>ÉCHÉANCE DÉPASSÉE</b> signale un cycle expiré.',
                        'Comparez les trois barres : renseignées → envoyées à la revue → approuvées.',
                        "Si une compétence revient en <b>modifications demandées</b>, rouvrez l'auto-évaluation, corrigez et soumettez à nouveau.",
                    ],
                    en: [
                        'Open <b>My Status</b> from the menu.',
                        'Read the current campaign and its closing date — a <b>PAST THE DEADLINE</b> badge flags an expired cycle.',
                        'Compare the three bars: rated → sent for review → approved.',
                        'If a skill comes back as <b>changes requested</b>, reopen the self-assessment, fix it and submit again.',
                    ],
                },
                tip: {
                    fr: 'Le dénominateur ici est <b>49</b>, pas 50 : une compétence dont le niveau requis est 0 figure dans la liste à évaluer mais ne peut pas compter dans une exigence.',
                    en: 'The denominator here is <b>49</b>, not 50: a skill whose required level is 0 appears in the list to rate but cannot count toward a requirement.',
                },
            },
            {
                icon: '⚖️',
                img: 'emp-04-supervisor-reviews',
                title: {
                    fr: 'Vos revues et la contestation',
                    en: 'Your reviews and raising a dispute',
                },
                where: {
                    fr: 'Mes revues (menu de gauche) — /employee/supervisor-reviews',
                    en: 'My reviews (left menu) — /employee/supervisor-reviews',
                },
                what: {
                    fr: "La page montre <b>où en est chaque compétence que vous avez envoyée</b> et, une fois la décision prise, <b>le niveau retenu et sa justification</b>. Le bandeau « Où en sont vos évaluations » explique le principe : « <i>Chaque compétence que vous envoyez passe de main en main jusqu'à ce qu'une décision soit prise. Vous voyez ici qui la détient actuellement</i> ». Quand rien n'est en cours, le message est explicite : <b>« Rien en attente : aucune de vos compétences n'est actuellement chez un relecteur. »</b>, suivi du bloc <b>Décisions de votre superviseur</b> — sur le compte de démonstration : <b>« Aucune revue de superviseur pour le moment. »</b>. Dès qu'une ligne revue apparaît, un bouton <b>Contester</b> s'affiche sur les décisions contestables, et un tableau de litiges (compétence, niveau auto-évalué, niveau superviseur, écart, état, niveau final retenu) suit la contestation jusqu'à sa résolution.",
                    en: "The page shows <b>where each skill you sent currently stands</b> and, once decided, <b>the level retained and the reason for it</b>. The “Where your assessments stand” banner explains the principle: “<i>Every skill you send moves from hand to hand until a decision is made. Here you can see who is holding it right now</i>”. When nothing is in flight the message is explicit: <b>“Nothing pending: none of your skills is currently with a reviewer.”</b>, followed by the <b>Your supervisor's decisions</b> block — on the demo account: <b>“No supervisor reviews available yet.”</b>. As soon as a reviewed row appears, a <b>Dispute</b> button is shown on contestable decisions, and a dispute table (skill, self-rated level, supervisor level, gap, state, final decided rating) follows the case to resolution.",
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mes revues</b> dans le menu.',
                        "Comparez votre auto-évaluation et le niveau retenu par le superviseur — c'est l'écart qui justifie une contestation.",
                        "Si vous n'êtes pas d'accord, cliquez sur <b>Contester</b> et argumentez avec des faits (ce que vous avez livré à ce niveau).",
                        "Suivez l'état du litige dans le tableau du bas ; le niveau final retenu y est affiché une fois la décision prise.",
                    ],
                    en: [
                        'Open <b>My reviews</b> from the menu.',
                        'Compare your self-rating with the level the supervisor retained — that gap is what a dispute is about.',
                        'If you disagree, click <b>Dispute</b> and argue with facts (what you delivered at that level).',
                        "Track the dispute's state in the table below; the final retained level appears there once decided.",
                    ],
                },
            },
            {
                icon: '🌱',
                img: 'emp-05-my-development',
                title: {
                    fr: 'Mon développement — les plans qui vous concernent',
                    en: 'My Development — the plans that concern you',
                },
                where: {
                    fr: 'Mon développement (menu de gauche)',
                    en: 'My Development (left menu)',
                },
                what: {
                    fr: "Une page unique qui rassemble <b>les plans ouverts pour vous</b> : plan de développement individuel (PDI), plan d'amélioration (PIP) et le renvoi vers votre coaching — « <i>ce qui est prévu, ce qui est attendu de vous, et où en est chaque étape</i> ». Elle est strictement personnelle : le contrôleur n'accepte ni identifiant dans l'URL ni paramètre d'employé, il n'interroge que votre propre dossier. Quand rien n'est ouvert, la page ne laisse pas un vide muet : elle affiche <b>« Aucun plan ouvert pour le moment »</b> et explique que c'est normal — « <i>un plan de développement, de coaching ou d'amélioration s'ouvre à travers les échanges que vous avez avec votre manager</i> » — avec un bouton <b>Retour à mon espace</b>. C'est ici qu'atterrissent les PDI créés automatiquement lorsqu'un manager vous positionne en haut potentiel sur la 9-box.",
                    en: 'One page gathering <b>the plans opened for you</b>: individual development plan (IDP), performance improvement plan (PIP) and the pointer to your coaching — “<i>what is planned, what is expected of you, and where each step stands</i>”. It is strictly personal: the controller accepts no id in the URL and no employee parameter, it only ever queries your own record. When nothing is open the page does not leave a silent blank: it shows <b>“No plan open right now”</b> and explains that this is normal — “<i>a development, coaching or improvement plan opens through the conversations you have with your manager</i>” — with a <b>Back to my workspace</b> button. This is where IDPs auto-created when a manager places you as high-potential on the 9-box land.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mon développement</b> dans le menu.',
                        "Lisez chaque objectif : il nomme une compétence et un niveau cible — c'est tout le contrat.",
                        "Suivez l'avancement de chaque action et signalez à votre manager tout ce qui bloque.",
                    ],
                    en: [
                        'Open <b>My Development</b> from the menu.',
                        'Read each objective: it names a skill and a target level — that is the whole contract.',
                        "Track each action's progress and raise anything blocking with your manager.",
                    ],
                },
            },
            {
                icon: '📈',
                img: 'emp-06-my-progress',
                title: {
                    fr: 'Ma progression — votre historique de campagnes',
                    en: 'My Progression — your campaign history',
                },
                where: {
                    fr: 'Ma progression (menu de gauche) — /employee/my-progress',
                    en: 'My Progression (left menu) — /employee/my-progress',
                },
                what: {
                    fr: "Une courbe <b>Progression dans le temps</b> et un tableau <b>Historique des campagnes</b> qui répond honnêtement à « est-ce que je progresse ? ». Le tableau porte onze colonnes : <b>CYCLE, FENÊTRE, COMPÉTENCES, APPROUVÉES, EN REVUE, NON SOUMISES, MOY. AUTO-ÉVALUÉE, MOY. CONFIRMÉE, MOUVEMENT NET, PRÉPARATION, VS PRÉCÉDENT</b>. Sur le compte de démonstration l'en-tête affiche <b>« Historique des campagnes (0 cycles) »</b> et le corps <b>« Aucune participation à une campagne pour le moment. »</b> — l'absence d'historique est affichée comme telle, jamais comme une progression nulle. La colonne <b>NON SOUMISES</b> mérite l'attention : elle isole le travail commencé mais jamais envoyé, qui ne compte pour rien tant qu'il n'est pas soumis.",
                    en: 'A <b>Progression Over Time</b> chart and a <b>Campaign History</b> table that answers “am I actually progressing?” honestly. The table carries eleven columns: <b>CYCLE, WINDOW, SKILLS, APPROVED, IN REVIEW, UNSUBMITTED, AVG SELF-RATED, AVG CONFIRMED, NET MOVEMENT, READINESS, VS PREVIOUS</b>. On the demo account the header reads <b>“Campaign History (0 cycles)”</b> and the body <b>“No campaign participation yet.”</b> — the absence of history is shown as such, never as zero progress. The <b>UNSUBMITTED</b> column deserves attention: it isolates work you started but never sent, which counts for nothing until submitted.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Ma progression</b> dans le menu de gauche.',
                        'Lisez la courbe pour repérer les compétences qui montent et celles qui stagnent.',
                        "Dans le tableau, la colonne <b>VS PRÉCÉDENT</b> donne votre mouvement d'une campagne à l'autre.",
                        "Vérifiez la colonne <b>NON SOUMISES</b> : tout ce qui s'y trouve est un travail perdu tant qu'il n'est pas envoyé.",
                    ],
                    en: [
                        'Open <b>My Progression</b> from the left menu.',
                        'Read the chart to spot skills that are rising and skills that are stalling.',
                        'In the table, the <b>VS PREVIOUS</b> column gives your campaign-over-campaign movement.',
                        'Check the <b>UNSUBMITTED</b> column: anything there is wasted work until you submit it.',
                    ],
                },
            },
            {
                icon: '🧗',
                img: 'emp-07-opportunities',
                title: {
                    fr: 'Mon évolution — opportunités, aspirations, sondages, reconnaissances',
                    en: 'My growth — opportunities, aspirations, surveys, recognition',
                },
                where: {
                    fr: 'Mon évolution (menu de gauche) — /employee/opportunities',
                    en: 'My growth (left menu) — /employee/opportunities',
                },
                what: {
                    fr: "Quatre blocs sur une seule page. <b>Opportunités internes</b> : les missions, projets et postes ouverts auxquels vous pouvez postuler (« <i>Aucune opportunité ouverte pour le moment.</i> » sur une instance d’exemple). <b>Mes aspirations</b> : vous déclarez vous-même, <b>sans passer par votre manager</b>, votre <b>Poste visé</b> — une liste déroulante des postes réels du référentiel (49 entrées sur une instance d’exemple, de « Application Support officer » à « UX/UI Designer », avec l'option <b>Aucune préférence</b>) —, vos <b>Centres d'intérêt / mobilité</b> en texte libre et une case <b>« Je suis ouvert(e) à la mobilité »</b>, puis vous cliquez sur <b>Enregistrer</b>. <b>Sondages ouverts</b> : les enquêtes d'engagement à remplir (« <i>Aucun sondage à compléter pour le moment.</i> »). <b>Reconnaissances reçues</b> : les remerciements qui vous ont été adressés (« <i>Aucune reconnaissance reçue pour le moment.</i> »). Les aspirations enregistrées ici sont ce qui vous fait remonter dans les viviers de succession et le classement des candidats aux opportunités.",
                    en: 'Four blocks on a single page. <b>Internal opportunities</b>: the gigs, projects and roles open to you (“<i>No open opportunities right now.</i>” on a sample instance). <b>My aspirations</b>: you declare your own <b>Target role</b>, <b>without going through your manager</b> — a dropdown of the real roles in the catalogue (49 entries on a sample instance, from “Application Support officer” to “UX/UI Designer”, plus a <b>No preference</b> option) —, your free-text <b>Interests / mobility</b> and an <b>“I am open to mobility”</b> checkbox, then you click <b>Save</b>. <b>Open surveys</b>: the engagement surveys to answer (“<i>No survey to complete right now.</i>”). <b>Recognition received</b>: the kudos sent to you (“<i>No recognition received yet.</i>”). The aspirations saved here are what surface you in succession benches and in the candidate ranking for opportunities.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mon évolution</b> dans le menu de gauche.',
                        "Dans <b>Mes aspirations</b>, choisissez votre <b>Poste visé</b> dans la liste, décrivez vos centres d'intérêt, cochez <b>Je suis ouvert(e) à la mobilité</b> si c'est le cas, puis <b>Enregistrer</b>.",
                        "Consultez <b>Opportunités internes</b> et postulez (une note facultative est possible) ; vous pouvez retirer votre candidature tant qu'aucune décision n'est prise.",
                        'Répondez aux <b>Sondages ouverts</b> — les sondages anonymes sont signalés comme tels.',
                    ],
                    en: [
                        'Open <b>My growth</b> from the left menu.',
                        'In <b>My aspirations</b>, pick your <b>Target role</b> from the list, describe your interests, tick <b>I am open to mobility</b> if it applies, then <b>Save</b>.',
                        'Browse <b>Internal opportunities</b> and apply (an optional note is allowed); you can withdraw while it is still undecided.',
                        'Answer the <b>Open surveys</b> — anonymous ones are clearly tagged.',
                    ],
                },
                tip: {
                    fr: "Vous n'avez pas besoin d'attendre un 1-à-1 pour déclarer votre poste cible : le formulaire est à vous et s'enregistre immédiatement. Une aspiration déclarée passe avant une aspiration supposée.",
                    en: 'You do not need to wait for a 1-on-1 to declare your target role: the form is yours and saves immediately. A declared aspiration beats a guessed one.',
                },
            },
            {
                icon: '🎓',
                img: 'emp-08-my-learning',
                title: {
                    fr: 'Mes formations — ce qui vous est assigné',
                    en: 'My learning — what is assigned to you',
                },
                where: {
                    fr: 'Mes formations (menu de gauche) — /employee/my-learning',
                    en: 'My learning (left menu) — /employee/my-learning',
                },
                what: {
                    fr: "La liste des formations qui vous ont été assignées : « <i>Ouvrez un cours pour le démarrer — votre progression est enregistrée automatiquement.</i> » Colonnes réelles : <b>COURS, FOURNISSEUR, STATUT, ÉCHÉANCE, ASSIGNÉ LE, ACTION</b>. Sur le compte de démonstration : <b>« Aucune formation ne vous est assignée pour le moment. »</b>. Le bouton d'ouverture d'un cours part vers le LMS externe dans un nouvel onglet ; à la complétion, le LMS renvoie le résultat et le niveau de la compétence associée monte automatiquement, sans écraser une note de superviseur. Vous ne vous assignez pas de cours vous-même : c'est votre manager ou l'administration de la formation qui le fait.",
                    en: 'The list of training assigned to you: “<i>Open a course to start it — your progress is recorded automatically.</i>” Real columns: <b>COURSE, PROVIDER, STATUS, DUE, ASSIGNED ON, ACTION</b>. On the demo account: <b>“No training is assigned to you at the moment.”</b>. The open button sends you to the external LMS in a new tab; on completion the LMS reports back and the mapped skill level rises automatically, without overriding a supervisor rating. You do not assign yourself a course: your manager or training administration does.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mes formations</b> dans le menu de gauche.',
                        'Repérez la colonne <b>ÉCHÉANCE</b> : une formation en retard vous vaut un rappel automatique.',
                        "Cliquez sur l'action d'ouverture pour lancer le cours ; revenez sur la page pour voir le statut se mettre à jour.",
                    ],
                    en: [
                        'Open <b>My learning</b> from the left menu.',
                        'Watch the <b>DUE</b> column: an overdue course triggers an automatic reminder to you.',
                        'Click the open action to launch the course; come back to the page to see the status update.',
                    ],
                },
            },
            {
                icon: '🎖️',
                img: 'emp-09-my-certifications',
                title: { fr: 'Mes certifications et VOC', en: 'My certifications and VOCs' },
                where: {
                    fr: 'Mes certifications (menu de gauche) — /employee/my-certifications',
                    en: 'My certifications (left menu) — /employee/my-certifications',
                },
                what: {
                    fr: "« <i>Vos certifications et vérifications de compétence (VOC) : lesquelles vous détenez, jusqu'à quand, et ce que votre poste exige.</i> » Un bandeau <b>Ce qui demande votre attention</b> chiffre les manques — sur le compte de démonstration : <b>« Certification(s) exigée(s) par votre poste et non encore enregistrée(s) — 1 »</b>. Le tableau <b>Ce que votre poste exige</b> (COMPÉTENCE / DÉLIVRÉE LE / ÉCHÉANCE / DÉLAI / ÉTAT) montre l'exigence réelle : <b>BUDGET & COST CONTROL — VALIDITÉ : 12 MOIS · FENÊTRE DE REVALIDATION : 90 JOURS</b>, dates à <b>—</b>, état <b>NON DÉTENUE</b>, avec la mention « <i>Aucune certification enregistrée à votre nom pour cette exigence.</i> ». Là encore, une exigence non couverte est affichée comme non détenue, pas comme un zéro. La page annonce le calendrier d'alerte : <b>90, 60 et 30 jours avant l'échéance, puis le jour où elle est dépassée</b>. Elle est <b>en lecture seule</b> : « <i>l'enregistrement d'une certification ou d'un VOC est effectué par votre responsable ou par la conformité, avec la pièce justificative</i> » ; pour planifier une revalidation, il faut s'adresser à son responsable hiérarchique.",
                    en: '“<i>Your certifications and verifications of competency (VOC): which ones you hold, until when, and what your role requires.</i>” A <b>What needs your attention</b> banner quantifies the shortfalls — on the demo account: <b>“Certification(s) your role requires and that are not recorded yet — 1”</b>. The <b>What your role requires</b> table (SKILL / ISSUED ON / EXPIRES ON / TIME LEFT / STATUS) shows the real requirement: <b>BUDGET & COST CONTROL — VALIDITY: 12 MONTHS · REVALIDATION WINDOW: 90 DAYS</b>, dates at <b>—</b>, status <b>NOT HELD</b>, with the note “<i>No certification is recorded in your name for this requirement.</i>”. Again, an uncovered requirement is shown as not held, not as a zero. The page states the alert schedule: <b>90, 60 and 30 days before expiry, then on the day it is passed</b>. It is <b>read-only</b>: “<i>a certification or VOC is recorded by your manager or by compliance, together with the supporting evidence</i>”; to schedule a revalidation you speak to your line manager.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mes certifications</b> dans le menu de gauche.',
                        'Lisez le bandeau <b>Ce qui demande votre attention</b> : il chiffre les certifications exigées et non enregistrées.',
                        'Dans le tableau, contrôlez la colonne <b>DÉLAI</b> et anticipez la <b>fenêtre de revalidation</b> indiquée sous chaque compétence.',
                        'Adressez-vous à votre responsable hiérarchique pour planifier une revalidation — vous ne pouvez rien enregistrer ici.',
                    ],
                    en: [
                        'Open <b>My certifications</b> from the left menu.',
                        'Read the <b>What needs your attention</b> banner: it counts required, unrecorded certifications.',
                        'In the table, watch the <b>TIME LEFT</b> column and anticipate the <b>revalidation window</b> shown under each skill.',
                        'Speak to your line manager to schedule a revalidation — you cannot record anything here.',
                    ],
                },
                tip: {
                    fr: "<b>NON DÉTENUE</b> ne veut pas dire « échouée » : cela veut dire qu'aucune pièce n'est enregistrée à votre nom. Si vous détenez le certificat, apportez-le à votre responsable pour qu'il soit saisi.",
                    en: '<b>NOT HELD</b> does not mean “failed”: it means nothing is recorded in your name. If you do hold the certificate, take it to your manager so it gets recorded.',
                },
            },
            {
                icon: '🤝',
                img: 'emp-10-my-coaching',
                title: { fr: 'Mon coaching et mentorat', en: 'My coaching and mentoring' },
                where: {
                    fr: 'Mon coaching (menu de gauche) — /employee/my-coaching',
                    en: 'My Coaching (left menu) — /employee/my-coaching',
                },
                what: {
                    fr: "« <i>Mettez à jour votre avancement et complétez les actions assignées.</i> » Le tableau porte six colonnes : <b>TYPE, TITRE, CONTEXTE, CIBLE, ÉTAT, PROGRESSION, MISE À JOUR</b>. La colonne <b>CONTEXTE</b> est structurante : un plan de coaching est toujours rattaché à un PDI, à un PIP ou à un écart de compétence précis — il n'existe pas de coaching « hors sol ». Sur le compte de démonstration : <b>« Aucun plan assigné. »</b>. Vous ne créez pas de plan vous-même ; votre manager l'ouvre, et vous y mettez à jour votre progression.",
                    en: '“<i>Update your progress and complete assigned actions.</i>” The table carries six columns: <b>KIND, TITLE, CONTEXT, TARGET, STATE, PROGRESS, UPDATE</b>. The <b>CONTEXT</b> column is the structuring one: a coaching plan is always anchored to an IDP, a PIP or a specific skill gap — context-free coaching does not exist here. On the demo account: <b>“No plans assigned.”</b>. You do not create a plan yourself; your manager opens it and you update your progress in it.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mon coaching</b> dans le menu de gauche.',
                        'Lisez la colonne <b>CONTEXTE</b> pour savoir ce que le plan est censé combler.',
                        'Utilisez la colonne <b>MISE À JOUR</b> pour faire avancer votre progression entre deux séances.',
                    ],
                    en: [
                        'Open <b>My Coaching</b> from the left menu.',
                        'Read the <b>CONTEXT</b> column to know what the plan is meant to close.',
                        'Use the <b>UPDATE</b> column to move your progress forward between sessions.',
                    ],
                },
            },
            {
                icon: '🎯',
                img: 'emp-11-okr',
                title: { fr: 'Mes OKR et mes 1-à-1', en: 'My OKRs and 1-on-1s' },
                where: {
                    fr: 'Mes OKR & 1:1 (menu de gauche) — /employee/okr',
                    en: 'My OKRs & 1:1s (left menu) — /employee/okr',
                },
                what: {
                    fr: "Deux blocs. <b>Mes objectifs & résultats clés</b> : « <i>Votre manager définit les objectifs avec vous — mettez à jour ici l'avancement de vos résultats clés au fur et à mesure.</i> » Sur le compte de démonstration : <b>« Aucun objectif pour le moment — votre manager peut en définir avec vous. »</b>. <b>Mes séances 1-à-1</b> : « <i>Points à venir et passés avec votre manager. Ajoutez les sujets que vous souhaitez aborder ; cochez les actions au fur et à mesure.</i> » Sur le compte de démonstration : <b>« Aucune séance 1-à-1 pour le moment — votre manager peut en planifier une. »</b>. La création d'un objectif et la planification d'une séance appartiennent au manager ; ce qui vous appartient, c'est la mise à jour de l'avancement et l'ajout de points de discussion.",
                    en: 'Two blocks. <b>My objectives & key results</b>: “<i>Your manager sets objectives with you — update your key-result progress here as you advance.</i>” On the demo account: <b>“No objectives yet — your manager can set them with you.”</b>. <b>My 1-on-1 sessions</b>: “<i>Upcoming and past check-ins with your manager. Add talking points you want to raise; tick actions as you complete them.</i>” On the demo account: <b>“No 1-on-1 sessions yet — your manager can schedule one.”</b>. Creating an objective and scheduling a session belong to the manager; what belongs to you is updating progress and adding talking points.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Mes OKR & 1:1</b> dans le menu de gauche.',
                        'Mettez à jour la valeur courante de chaque résultat clé pour refléter votre avancement réel.',
                        'Avant un 1-à-1, ajoutez vos points de discussion ; après, cochez les actions réalisées.',
                    ],
                    en: [
                        'Open <b>My OKRs & 1:1s</b> from the left menu.',
                        'Update the current value of each key result to reflect real progress.',
                        'Before a 1-on-1, add your talking points; afterwards, tick off the actions you completed.',
                    ],
                },
            },
            {
                icon: '🔔',
                img: 'emp-12-notifications',
                title: {
                    fr: 'Notifications — tout ce qui vous attend',
                    en: 'Notifications — everything waiting for you',
                },
                where: {
                    fr: 'Cloche 🔔 en haut à droite → « Voir tout » · page /notifications',
                    en: 'Bell 🔔 top-right → “View all” · page /notifications',
                },
                what: {
                    fr: "La cloche en haut à droite affiche un compteur dès qu'une action vous attend et ouvre un panneau ; le lien <b>Voir tout</b> conduit à la page complète <b>/notifications</b>, qui liste chaque élément avec son horodatage et un lien direct vers l'endroit où agir. Sur le compte de démonstration, trois éléments sont présents : <b>« Auto-évaluation à soumettre » (01/09/2026 16:22:11)</b>, <b>« Auto-évaluation à soumettre » (27/08/2026 23:09:25)</b> et <b>« Votre auto-évaluation a été approuvée » (13/07/2026 11:52:48)</b>. Un bouton permet de <b>tout marquer comme lu</b>. Les types que reçoit un collaborateur incluent : auto-évaluation à soumettre, auto-évaluation approuvée ou renvoyée, formation assignée ou en retard, certification qui arrive à échéance (90/60/30 jours puis dépassée), invitation à un sondage, décision sur une candidature interne.",
                    en: 'The top-right bell shows a counter as soon as something needs you and opens a panel; the <b>View all</b> link leads to the full <b>/notifications</b> page, which lists every item with its timestamp and a direct link to where to act. On the demo account three items are present: <b>“Self-assessment to submit” (01/09/2026 16:22:11)</b>, <b>“Self-assessment to submit” (27/08/2026 23:09:25)</b> and <b>“Your self-assessment was approved” (13/07/2026 11:52:48)</b>. A button lets you <b>mark everything read</b>. Types an employee receives include: self-assessment to submit, self-assessment approved or sent back, training assigned or overdue, certification nearing expiry (90/60/30 days then passed), survey invitation, decision on an internal application.',
                },
                steps: {
                    fr: [
                        'Regardez la <b>🔔 cloche</b> en haut à droite : un nombre signale une action en attente.',
                        'Cliquez sur un élément pour aller directement à la tâche concernée.',
                        'Ouvrez <b>Voir tout</b> pour la page complète, puis <b>marquez comme lu</b> ce qui est traité.',
                    ],
                    en: [
                        'Look at the <b>🔔 bell</b> at the top-right: a number flags a pending action.',
                        'Click an item to jump straight to the task it concerns.',
                        'Open <b>View all</b> for the full page, then <b>mark as read</b> what you have handled.',
                    ],
                },
            },
            {
                icon: '👤',
                img: null,
                imgRetired: 'emp-13-account',
                title: {
                    fr: 'Mon profil — vos coordonnées (et ce que vous ne pouvez pas changer)',
                    en: 'My profile — your contact details (and what you cannot change)',
                },
                where: {
                    fr: 'Menu du compte (en haut à droite) → Mon profil · /account',
                    en: 'Account menu (top-right) → My profile · /account',
                },
                what: {
                    fr: "<b>Nouveau en 3.22.85.</b> La page explique d'emblée l'enjeu : « <i>Vos coordonnées personnelles. L'adresse e-mail enregistrée ici est celle qui reçoit le lien de réinitialisation de votre mot de passe : sans elle, la réinitialisation en libre-service ne peut pas vous joindre.</i> » Le formulaire <b>Mes coordonnées</b> ne contient que <b>deux champs modifiables</b> : <b>Adresse e-mail</b> (« Utilisée pour la réinitialisation du mot de passe et les notifications par e-mail ») et <b>Téléphone</b>, avec le bouton <b>Enregistrer mes coordonnées</b>, plus un raccourci <b>Changer le mot de passe</b>. En dessous, le bloc <b>Mes informations professionnelles</b> est en <b>lecture seule</b> et le dit : « <i>Ces informations sont gérées par votre administrateur : elles ne sont pas modifiables ici. Signalez toute erreur à votre responsable ou à l'administrateur RH.</i> » Il affiche <b>Nom</b> (Anicet VANCÉO), <b>Matricule</b> (DEMO-2004), <b>Identifiant de connexion</b> (test.employee), <b>Poste</b> (Cybersecurity Analyst (On-Prem & OT)), <b>Site</b> (Riverside), <b>Département</b> (IT) et <b>Service</b> (CyberSecurity). <b>Ce que la page ne permet PAS :</b> changer votre nom, votre matricule, votre identifiant, votre <b>poste</b>, votre <b>site</b>, votre <b>département</b>, votre <b>service</b> ou votre <b>superviseur</b>. Ce n'est pas seulement une affaire d'affichage : la vérification a consisté à envoyer volontairement ces champs au serveur en même temps que l'e-mail et le téléphone — seuls l'e-mail et le téléphone ont été écrits, le poste, le site, le département, le superviseur et le prénom sont restés strictement inchangés en base. L'adresse e-mail doit être unique dans la plateforme et une adresse déjà utilisée par un autre compte est refusée. Chaque modification est tracée dans le journal d'audit.",
                    en: '<b>New in 3.22.85.</b> The page states the stake up front: “<i>Your personal contact details. The email address stored here is the one that receives your password-reset link: without it, the self-service reset cannot reach you.</i>” The <b>My contact details</b> form holds only <b>two editable fields</b>: <b>Email address</b> (“Used for password reset and email notifications”) and <b>Phone</b>, with a <b>Save my contact details</b> button, plus a <b>Change Password</b> shortcut. Below it, the <b>My work information</b> block is <b>read-only</b> and says so: “<i>This information is managed by your administrator and cannot be edited here. Report any error to your manager or HR administrator.</i>” It shows <b>Name</b> (Anicet VANCÉO), <b>Employee number</b> (DEMO-2004), <b>Sign-in username</b> (test.employee), <b>Role</b> (Cybersecurity Analyst (On-Prem & OT)), <b>Site</b> (Riverside), <b>Department</b> (IT) and <b>Service</b> (CyberSecurity). <b>What the page does NOT allow:</b> changing your name, employee number, username, <b>role</b>, <b>site</b>, <b>department</b>, <b>service</b> or <b>supervisor</b>. This is not merely a display matter: the check consisted of deliberately sending those fields to the server alongside the email and phone — only email and phone were written; role, site, department, supervisor and first name stayed strictly unchanged in the database. The email address must be unique across the platform and an address already used by another account is refused. Every change is written to the audit trail.',
                },
                steps: {
                    fr: [
                        'Ouvrez le menu de votre compte en haut à droite, puis <b>Mon profil</b>.',
                        "Saisissez votre <b>adresse e-mail</b> professionnelle — c'est elle qui recevra le lien de réinitialisation de mot de passe.",
                        'Ajoutez votre <b>téléphone</b> si vous le souhaitez, puis cliquez sur <b>Enregistrer mes coordonnées</b>.',
                        "Vérifiez le bloc <b>Mes informations professionnelles</b> : s'il contient une erreur (poste, site, département, service), signalez-la à votre responsable ou à l'administrateur RH — vous ne pouvez pas la corriger ici.",
                    ],
                    en: [
                        'Open your account menu at the top-right, then <b>My profile</b>.',
                        'Enter your work <b>email address</b> — that is what will receive the password-reset link.',
                        'Add your <b>phone</b> if you wish, then click <b>Save my contact details</b>.',
                        'Check the <b>My work information</b> block: if anything is wrong (role, site, department, service), report it to your manager or HR administrator — you cannot correct it here.',
                    ],
                },
                tip: {
                    fr: "Sans adresse e-mail enregistrée, la fonction « mot de passe oublié » ne peut pas vous joindre : il faudra passer par un administrateur. Le tableau de bord vous le rappelle d'ailleurs par une carte <b>Mon profil</b> qui dit exactement cela.",
                    en: 'With no email address on file, “forgot password” cannot reach you and you will have to go through an administrator. The dashboard even reminds you with a <b>My profile</b> card saying exactly that.',
                },
            },
            {
                icon: '🖥️',
                img: 'emp-14-account-sessions',
                title: {
                    fr: 'Sessions actives — voir et fermer vos connexions',
                    en: 'Active sessions — see and close your sign-ins',
                },
                where: {
                    fr: 'Menu du compte → Sessions actives · /account/sessions',
                    en: 'Account menu → Active Sessions · /account/sessions',
                },
                what: {
                    fr: "Accessible à <b>tout collaborateur</b>, pas seulement aux administrateurs. « <i>Ce sont les appareils actuellement connectés à votre compte. Si vous n'en reconnaissez pas un, déconnectez toutes les autres sessions et changez votre mot de passe.</i> » Le tableau affiche <b>APPAREIL, ADRESSE IP, CONNEXION, DERNIÈRE ACTIVITÉ</b> ; la session courante est marquée <b>CET APPAREIL / current</b>. Sur une instance d’exemple, 21 sessions étaient listées (toutes « Chrome on Windows », IP ::1 — c'est un poste de développement) et le bouton portait le compte exact : <b>« Déconnecter toutes les autres sessions (20) »</b>. Un lien <b>Changer le mot de passe</b> complète la page.",
                    en: "Available to <b>every employee</b>, not just administrators. “<i>These are the devices currently signed in to your account. If you don't recognise one, sign out all other sessions and change your password.</i>” The table shows <b>DEVICE, IP ADDRESS, SIGNED IN, LAST ACTIVE</b>; the current session is marked <b>THIS DEVICE / current</b>. on a sample instance 21 sessions were listed (all “Chrome on Windows”, IP ::1 — this is a development workstation) and the button carried the exact count: <b>“Sign out all other sessions (20)”</b>. A <b>Change password</b> link completes the page.",
                },
                steps: {
                    fr: [
                        'Ouvrez le menu du compte, puis <b>Sessions actives</b>.',
                        'Parcourez la liste : la session marquée <b>CET APPAREIL</b> est la vôtre en cours.',
                        'Cliquez sur <b>Déconnecter toutes les autres sessions (N)</b> pour révoquer immédiatement le reste.',
                        'Si vous avez vu une session inconnue, changez ensuite votre mot de passe et prévenez votre administrateur.',
                    ],
                    en: [
                        'Open the account menu, then <b>Active Sessions</b>.',
                        'Scan the list: the session marked <b>THIS DEVICE</b> is your current one.',
                        'Click <b>Sign out all other sessions (N)</b> to revoke the rest immediately.',
                        "If you saw a session you don't recognise, change your password afterwards and tell your administrator.",
                    ],
                },
                tip: {
                    fr: 'Prenez le réflexe après avoir utilisé un poste partagé. Changer votre mot de passe révoque de toute façon toutes les autres sessions.',
                    en: 'Make it a reflex after using a shared machine. Changing your password revokes every other session anyway.',
                },
            },
            {
                icon: '⚙️',
                img: 'emp-15-account-notifications',
                title: {
                    fr: 'Préférences de notification et heures calmes',
                    en: 'Notification preferences and quiet hours',
                },
                where: {
                    fr: 'Menu du compte → Notifications · /account/notifications',
                    en: 'Account menu → Notifications · /account/notifications',
                },
                what: {
                    fr: "Deux réglages personnels. <b>Recevoir les notifications par e-mail</b> : un interrupteur, avec la précision « <i>Lorsqu'il est désactivé, vous voyez toujours tout dans l'application (cloche) — mais aucun e-mail n'est envoyé.</i> » — couper les e-mails ne vous fait donc rien perdre. <b>Heures calmes</b> : une plage <b>De … à …</b> pendant laquelle « <i>rien n'apparaît dans la cloche et aucun e-mail n'est envoyé — tout est délivré à la fin de la fenêtre</i> ». Rien n'est supprimé, tout est différé. Il faut <b>renseigner les deux heures, ou laisser les deux vides pour désactiver</b>. Le bouton <b>Enregistrer</b> valide, et deux liens (<b>Voir tout</b>, <b>Mon profil</b>) complètent la page.",
                    en: 'Two personal settings. <b>Receive notifications by email</b>: a toggle, with the note “<i>When off, you still see everything in-app (bell) — no email.</i>” — switching email off loses you nothing. <b>Quiet hours</b>: a <b>From … to …</b> window during which “<i>nothing appears in the bell and no email is sent — everything is delivered when the window ends</i>”. Nothing is dropped, everything is deferred. You must <b>set both times, or leave both empty to switch it off</b>. The <b>Save</b> button applies, and two links (<b>View all</b>, <b>My profile</b>) complete the page.',
                },
                steps: {
                    fr: [
                        'Ouvrez le menu du compte, puis <b>Notifications</b>.',
                        'Activez ou désactivez <b>Recevoir les notifications par e-mail</b> selon votre préférence.',
                        'Pour des heures calmes, renseignez <b>les deux</b> heures (début et fin) ; laissez-les vides pour désactiver.',
                        'Cliquez sur <b>Enregistrer</b>.',
                    ],
                    en: [
                        'Open the account menu, then <b>Notifications</b>.',
                        'Turn <b>Receive notifications by email</b> on or off as you prefer.',
                        'For quiet hours, fill in <b>both</b> times (start and end); leave them empty to switch it off.',
                        'Click <b>Save</b>.',
                    ],
                },
            },
            {
                icon: '🔑',
                img: 'emp-16-change-password',
                title: {
                    fr: 'Changer votre mot de passe (12 caractères minimum)',
                    en: 'Change your password (12 characters minimum)',
                },
                where: {
                    fr: 'Menu du compte → Changer le mot de passe · /change-password',
                    en: 'Account menu → Change Password · /change-password',
                },
                what: {
                    fr: "Trois champs — <b>Mot de passe actuel</b>, <b>Nouveau mot de passe</b>, <b>Confirmer le nouveau mot de passe</b> — et la règle affichée sous le champ : « <b>Doit contenir au moins 12 caractères, avec majuscule, minuscule, chiffre et caractère spécial.</b> » Ce n'est pas qu'un texte d'aide : le contrôle est appliqué côté serveur (le validateur refuse tout mot de passe de moins de <b>12</b> caractères). Les mots courants, les suites et les motifs de clavier sont également rejetés. Changer votre mot de passe déconnecte toutes vos autres sessions. Après une réinitialisation faite par un administrateur, le changement peut vous être imposé à la première connexion.",
                    en: 'Three fields — <b>Current Password</b>, <b>New Password</b>, <b>Confirm New Password</b> — and the rule shown under the field: “<b>Must be at least 12 characters with uppercase, lowercase, number, and special character.</b>” This is not just help text: the check is enforced server-side (the validator refuses anything shorter than <b>12</b> characters). Common words, sequences and keyboard patterns are rejected too. Changing your password signs out all your other sessions. After an administrator reset, the change may be forced on you at next sign-in.',
                },
                steps: {
                    fr: [
                        'Ouvrez le menu du compte, puis <b>Changer le mot de passe</b>.',
                        'Saisissez votre mot de passe actuel, puis le nouveau deux fois — <b>au moins 12 caractères</b>, avec majuscule, minuscule, chiffre et caractère spécial.',
                        'Validez : vos autres sessions sont déconnectées et vous utiliserez le nouveau mot de passe à la prochaine connexion.',
                    ],
                    en: [
                        'Open the account menu, then <b>Change Password</b>.',
                        'Enter your current password, then the new one twice — <b>at least 12 characters</b>, with uppercase, lowercase, number and special character.',
                        'Submit: your other sessions are signed out and you will use the new password next time you sign in.',
                    ],
                },
                tip: {
                    fr: 'Une phrase de passe longue et unique satisfait la règle des 12 caractères sans effort de mémoire — et ne se réutilise nulle part ailleurs.',
                    en: 'A long, unique passphrase meets the 12-character rule with no memory effort — and is reused nowhere else.',
                },
            },
            {
                icon: '🔐',
                img: 'emp-20-mfa',
                title: {
                    fr: 'Double authentification (2FA) — facultative mais recommandée',
                    en: 'Two-factor authentication (2FA) — optional but recommended',
                },
                where: {
                    fr: 'Menu du compte → Vérification en deux étapes · /v2/uam/mfa/manage',
                    en: 'Account menu → Two-Factor Auth · /v2/uam/mfa/manage',
                },
                what: {
                    fr: "La page indique l'état courant — sur le compte de démonstration : <b>NON ACTIVE — « Votre compte est protégé par mot de passe uniquement »</b> — et explique le principe : un code à 6 chiffres issu d'une application d'authentification (Microsoft Authenticator, Google Authenticator, Authy…) en plus du mot de passe, plus des <b>codes de secours à usage unique</b> si vous perdez votre téléphone. Un seul bouton : <b>Activer la double authentification</b>. L'activation affiche un QR code (ou une clé à saisir), demande la confirmation d'un code à 6 chiffres, puis délivre 10 codes de secours. Pour la désactiver, il faut saisir un code en cours.",
                    en: 'The page states the current state — on the demo account: <b>NOT ACTIVE — “Your account is protected by password only”</b> — and explains the principle: a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, Authy…) on top of the password, plus <b>single-use backup codes</b> if you lose your phone. A single button: <b>Activate two-factor authentication</b>. Activation shows a QR code (or a key to type), asks you to confirm a 6-digit code, then issues 10 backup codes. To turn it off you must enter a current code.',
                },
                steps: {
                    fr: [
                        'Ouvrez le menu du compte, puis <b>Vérification en deux étapes</b>.',
                        'Cliquez sur <b>Activer la double authentification</b>.',
                        "Scannez le QR code avec votre application d'authentification, puis confirmez un code à 6 chiffres.",
                        "Conservez vos <b>10 codes de secours</b> ailleurs que sur le téléphone qui porte l'application.",
                    ],
                    en: [
                        'Open the account menu, then <b>Two-Factor Auth</b>.',
                        'Click <b>Activate two-factor authentication</b>.',
                        'Scan the QR code with your authenticator app, then confirm a 6-digit code.',
                        'Keep your <b>10 backup codes</b> somewhere other than the phone that holds the app.',
                    ],
                },
            },
            {
                icon: '🆘',
                img: 'emp-19-forgot-password',
                title: {
                    fr: 'Mot de passe oublié (hors connexion)',
                    en: 'Forgot password (signed out)',
                },
                where: {
                    fr: 'Page /forgot-password — accessible sans être connecté',
                    en: 'The /forgot-password page — reachable while signed out',
                },
                what: {
                    fr: "Écran <b>Réinitialiser votre mot de passe</b> : « <i>Saisissez votre nom d'utilisateur ou votre adresse e-mail. S'il correspond à un compte, nous enverrons un lien pour réinitialiser votre mot de passe.</i> » Un seul champ (<b>Nom d'utilisateur ou e-mail</b>), un bouton <b>Envoyer le lien</b> et un retour <b>← Retour à la connexion</b>. La formulation est volontairement neutre : la réponse est la même que l'identifiant existe ou non, pour ne pas révéler quels comptes existent. Le lien de réinitialisation part vers l'<b>adresse e-mail enregistrée sur votre fiche</b> — celle que vous saisissez vous-même dans <b>Mon profil</b> : sans elle, la réinitialisation en libre-service ne peut pas aboutir. Si l'envoi d'e-mails n'est pas configuré sur l'installation, un bandeau le dit explicitement (« <i>L'envoi d'e-mails n'est pas configuré : aucun lien ne peut être envoyé pour le moment. Demandez à un administrateur de réinitialiser votre mot de passe.</i> ») et il faut passer par un administrateur.",
                    en: 'A <b>Reset your password</b> screen: “<i>Enter your username or your email address. If it matches an account, we will send a link to reset your password.</i>” One field (<b>Username or email</b>), a <b>Send the link</b> button and a <b>← Back to sign-in</b> return. The wording is deliberately neutral: the answer is the same whether the identifier exists or not, so no account is revealed. The reset link goes to the <b>email address recorded on your record</b> — the one you enter yourself in <b>My profile</b>: without it, the self-service reset cannot complete. If email sending is not configured on the installation, a banner says so explicitly (“<i>Email sending is not configured: no link can be sent right now. Ask an administrator to reset your password.</i>”) and you must go through an administrator.',
                },
                steps: {
                    fr: [
                        "Depuis l'écran de connexion, ouvrez <b>/forgot-password</b> (ou le lien « Mot de passe oublié ? » s'il est affiché).",
                        "Saisissez votre nom d'utilisateur ou votre e-mail, puis <b>Envoyer le lien</b>.",
                        "Ouvrez le lien reçu par e-mail et choisissez un nouveau mot de passe d'au moins 12 caractères.",
                        "Si un bandeau indique que l'envoi d'e-mails n'est pas configuré, demandez la réinitialisation à un administrateur.",
                    ],
                    en: [
                        'From the sign-in screen, open <b>/forgot-password</b> (or the “Forgot your password?” link when shown).',
                        'Enter your username or email, then <b>Send the link</b>.',
                        'Open the emailed link and choose a new password of at least 12 characters.',
                        'If a banner says email sending is not configured, ask an administrator to reset it for you.',
                    ],
                },
                tip: {
                    fr: "Renseignez votre e-mail dans <b>Mon profil</b> <i>avant</i> d'en avoir besoin : c'est la seule adresse que cette page sait joindre.",
                    en: 'Fill in your email in <b>My profile</b> <i>before</i> you need it: it is the only address this page can reach.',
                },
            },
            {
                icon: '📖',
                img: 'emp-17-guide',
                title: {
                    fr: "Le manuel intégré et l'aide contextuelle",
                    en: 'The built-in manual and contextual help',
                },
                where: {
                    fr: "Bouton « ? » en bas à droite de chaque page · menu → Guide de l'utilisateur (/guide)",
                    en: 'The “?” button bottom-right of every page · menu → User Guide (/guide)',
                },
                what: {
                    fr: "Deux niveaux d'aide. Le bouton flottant <b>« ? »</b>, présent en bas à droite de <b>chaque</b> page, ouvre un panneau <b>Aide contextuelle</b> à deux onglets : <b>Page actuelle</b> (le processus de l'écran où vous êtes, « Comment l'utiliser », « Bonnes pratiques », « En tirer le maximum ») et <b>Manuel complet</b>. La page <b>/guide</b> affiche le manuel filtré par votre habilitation — pour un collaborateur, l'en-tête indique <b>« Votre guide pour : Collaborateur »</b> et les sections disponibles sont <b>Pour commencer</b>, <b>🧑‍💼 Collaborateur</b>, <b>Processus</b>, <b>Glossaire</b> et <b>FAQ</b>, avec un compteur de progression (<b>0 / 15</b> au départ), un bouton <b>Réinitialiser</b>, une visite guidée <b>▶ Faire le tour</b> et un sélecteur <b>English / Français</b>. Vous ne voyez que ce que votre profil permet : les sections manager et administrateur ne sont pas affichées.",
                    en: 'Two levels of help. The floating <b>“?”</b> button, present bottom-right on <b>every</b> page, opens a <b>Contextual help</b> panel with two tabs: <b>Current page</b> (the process of the screen you are on, “How to use it”, “Good practices”, “Get the most value”) and <b>Full manual</b>. The <b>/guide</b> page shows the manual filtered by your clearance — for an employee the header reads <b>“Your guide for: Employee”</b> and the available sections are <b>Start here</b>, <b>🧑‍💼 Employee</b>, <b>Processes</b>, <b>Glossary</b> and <b>FAQ</b>, with a progress counter (<b>0 / 15</b> to begin with), a <b>Reset</b> button, a <b>▶ Take the tour</b> walkthrough and an <b>English / Français</b> switcher. You only see what your profile allows: manager and administrator sections are not shown.',
                },
                steps: {
                    fr: [
                        "Sur n'importe quel écran, cliquez sur le bouton <b>« ? »</b> en bas à droite pour l'aide de la page en cours.",
                        "Basculez sur l'onglet <b>Manuel complet</b>, ou ouvrez <b>Guide de l'utilisateur</b> dans le menu, pour le manuel entier.",
                        "Utilisez le sélecteur <b>English / Français</b> du guide si la langue affichée n'est pas la vôtre.",
                        'Cochez les rubriques au fur et à mesure : le compteur de progression suit votre lecture.',
                    ],
                    en: [
                        'On any screen, click the <b>“?”</b> button bottom-right for help on the current page.',
                        'Switch to the <b>Full manual</b> tab, or open <b>User Guide</b> from the menu, for the whole manual.',
                        "Use the guide's <b>English / Français</b> switcher if the displayed language is not yours.",
                        'Tick sections as you go: the progress counter follows your reading.',
                    ],
                },
            },
            {
                icon: '🔒',
                img: null,
                title: {
                    fr: "Ce qu'un collaborateur ne peut pas voir ni faire",
                    en: 'What an employee cannot see or do',
                },
                where: {
                    fr: 'Partout — appliqué par le serveur, pas par le menu',
                    en: 'Everywhere — enforced by the server, not by the menu',
                },
                what: {
                    fr: "Le périmètre d'un collaborateur est <b>son seul dossier</b>, et cette limite est appliquée par le serveur, pas seulement en masquant des entrées de menu. Constaté sur l'application en fonctionnement, avec le compte du collaborateur connecté : l'annuaire <b>/employees</b>, la fiche d'un tiers <b>/employees/1</b> et son édition <b>/employees/2/edit</b> répondent <b>403</b> ; <b>/api/v1/employees</b> répond <b>403</b> ; la préparation d'un tiers <b>/api/v1/employees/1/readiness</b> répond <b>403</b> alors que la sienne <b>/api/v1/employees/84/readiness</b> répond <b>200</b> ; l'historique de revue d'un tiers <b>/api/self-assessment/employee/1/movement</b> répond <b>404</b> alors que le sien répond <b>200</b> ; le journal système <b>/system-logs</b>, la gestion des administrateurs <b>/admins</b>, la continuité <b>/v2/continuity</b> et la conformité <b>/compliance</b> répondent <b>403</b> ; approuver une auto-évaluation, la sienne comme celle d'un autre (<b>POST /api/self-assessment/employee/…/approve-all</b>), répond <b>403</b> — un collaborateur ne valide jamais sa propre note. Les écrans de pilotage (tableau de bord général, 9-box, PIP, matrice de compétences, benchmark, générateur de rapports, sessions plateforme, surfaces exécutives) <b>redirigent</b> vers <b>/employee/dashboard</b>. Enfin, forcer un identifiant dans l'URL ne sert à rien : <b>/employee/dashboard?employeeId=1</b> renvoie bien <b>200</b>, mais affiche <b>« Bienvenue, Bakary »</b> — vos propres données. Le paramètre est ignoré, les pages personnelles sont toujours calculées sur l'utilisateur connecté.",
                    en: "An employee's scope is <b>their own record only</b>, and that boundary is enforced by the server, not merely by hiding menu entries. Observed on the running application with the employee signed in: the directory <b>/employees</b>, someone else's record <b>/employees/1</b> and its edit form <b>/employees/2/edit</b> all answer <b>403</b>; <b>/api/v1/employees</b> answers <b>403</b>; another person's readiness <b>/api/v1/employees/1/readiness</b> answers <b>403</b> while their own <b>/api/v1/employees/84/readiness</b> answers <b>200</b>; another person's review history <b>/api/self-assessment/employee/1/movement</b> answers <b>404</b> while their own answers <b>200</b>; the system log <b>/system-logs</b>, admin management <b>/admins</b>, continuity <b>/v2/continuity</b> and compliance <b>/compliance</b> answer <b>403</b>; approving a self-assessment, their own as much as someone else's (<b>POST /api/self-assessment/employee/…/approve-all</b>), answers <b>403</b> — an employee never validates their own rating. Steering screens (the general dashboard, 9-box, PIP, skill matrix, benchmark, report builder, platform sessions, executive surfaces) <b>redirect</b> to <b>/employee/dashboard</b>. Finally, forcing an id into the URL achieves nothing: <b>/employee/dashboard?employeeId=1</b> does answer <b>200</b>, but renders <b>“Welcome, Bakary”</b> — your own data. The parameter is ignored; personal pages are always computed from the signed-in user.",
                },
                steps: {
                    fr: [
                        "Si un écran vous répond <b>403</b> ou vous ramène à votre espace, ce n'est pas une panne : c'est votre habilitation.",
                        "Pour obtenir une information sur une autre personne, passez par votre manager — c'est lui qui en a la responsabilité.",
                        "Pour corriger vos informations professionnelles (poste, site, département, service), passez par votre responsable ou l'administrateur RH.",
                    ],
                    en: [
                        'If a screen answers <b>403</b> or sends you back to your workspace, it is not a fault: it is your clearance.',
                        'To get information about another person, go through your manager — it is their responsibility.',
                        'To fix your work information (role, site, department, service), go through your manager or the HR administrator.',
                    ],
                },
            },
        ],
    },
    {
        id: 'supervisor',
        icon: '🧑‍🏫',
        color: '#2563eb',
        name: { en: 'Supervisor', fr: 'Superviseur' },
        tagline: {
            en: "A supervisor is whoever is named in the 'supervisor' column of their reports. They instruct the file: open, comment, send back, rate and approve their team's self-assessments, and draft 9-Box placements. They hold NO arbitration power: manager validation and dispute arbitration are refused to them (HTTP 403).",
            fr: "Le superviseur est la personne dont l'identifiant figure dans la colonne « superviseur » de ses collaborateurs. Il instruit : il ouvre, commente, renvoie, note et approuve les auto-évaluations de son équipe, et il prépare les placements 9-Box. Il ne détient AUCUN pouvoir d'arbitrage : la validation manager et l'arbitrage d'un désaccord lui sont refusés (HTTP 403).",
        },
        features: [
            {
                icon: '✅',
                img: 'sup-sv-02-sa-reviews',
                title: { fr: "Revues d'auto-évaluation", en: 'Self-assessment reviews' },
                where: {
                    fr: "Menu Équipe → « Revues d'auto-évaluation » (/supervisor/self-assessment-reviews)",
                    en: 'Team menu → “SA Reviews” (/supervisor/self-assessment-reviews)',
                },
                what: {
                    fr: "Les soumissions sont regroupées par personne. Trois actions par compétence : Approuver, Demander des modifications, Rejeter — plus « Approuver tout » pour traiter une personne d'un bloc. Demander des modifications EXIGE un commentaire : sans texte, l'application refuse en 400 « Please explain what the employee needs to change. » et le dossier ne bouge pas. Approuver permet de saisir SON PROPRE niveau 0–4 ; s'il diffère de l'auto-évaluation, un motif d'écart est obligatoire. Lorsque rien n'est en attente, l'écran affiche « Nothing awaiting your review. » et « Pipeline: none » — c'est une file vide, pas un résultat de mesure.",
                    en: 'Submissions are grouped per person. Three per-skill actions: Approve, Request changes, Reject — plus “Approve all” to clear one person in a single move. Request changes REQUIRES a comment: with no text the app refuses with 400 “Please explain what the employee needs to change.” and nothing moves. Approve lets the reviewer enter THEIR OWN 0–4 rating; when it differs from the self-rating a gap reason is mandatory. With nothing pending the screen reads “Nothing awaiting your review.” and “Pipeline: none” — an empty queue, not a measurement.',
                },
            },
            {
                icon: '⚖️',
                img: 'sup-sv-04-v1-reviews',
                title: {
                    fr: 'Revue détaillée et niveau retenu',
                    en: 'Detailed review and retained level',
                },
                where: {
                    fr: 'Menu Équipe → « Mon équipe » → Ouvrir une revue (/supervisor/reviews/:id)',
                    en: 'Team menu → “My Team” → Open a review (/supervisor/reviews/:id)',
                },
                what: {
                    fr: "Le superviseur saisit le niveau observé et une note. Mesuré sur la compétence « Adoption, Change & Stakeholder Management » : auto-évaluation 4, niveau superviseur 2 → l'écart est recalculé à −2, la revue passe en « completed », le dossier passe en état Revue, et le NIVEAU OFFICIEL du collaborateur (profil de compétences) passe de 1 à 2 avec la mention « Validated by supervisor review. Gap: -2 ». C'est ce niveau officiel qui alimente la préparation au poste, les écarts, le benchmark et la 9-Box.",
                    en: "The supervisor enters the observed level and a note. Measured on “Adoption, Change & Stakeholder Management”: self 4, supervisor 2 → the gap is recomputed to −2, the review becomes “completed”, the file moves to Reviewed, and the employee's OFFICIAL level (skill profile) goes from 1 to 2, noted “Validated by supervisor review. Gap: -2”. That official level feeds readiness, gaps, benchmark and the 9-Box.",
                },
            },
            {
                icon: '🧩',
                img: null,
                imgRetired: 'sup-sv-10-nine-box',
                title: {
                    fr: 'Grille 9-Box — préparer la proposition',
                    en: '9-Box grid — draft the proposal',
                },
                where: {
                    fr: 'Menu Talents → « Grille 9-Box » (/talent/nine-box)',
                    en: 'Talent menu → “9-Box Talent” (/talent/nine-box)',
                },
                what: {
                    fr: "L'écran l'annonce lui-même : « Supervisors draft; managers approve/publish. » Le superviseur crée le brouillon (Performance × Potentiel, en low/medium/high) et le soumet : le statut passe de « draft » à « under_review » et son identifiant est enregistré comme auteur. Il ne peut PAS aller plus loin : Approuver, Rejeter, Archiver et Rendre visible au collaborateur lui répondent 403 « Not authorized: manager/admin only ».",
                    en: 'The screen says it itself: “Supervisors draft; managers approve/publish.” The supervisor creates the draft (Performance × Potential, low/medium/high) and submits it: status goes draft → under_review and their id is recorded as author. They cannot go further: Approve, Reject, Archive and Disclose all answer 403 “Not authorized: manager/admin only”.',
                },
            },
            {
                icon: '📉',
                img: null,
                imgRetired: 'sup-sv-05-gap-analysis',
                title: {
                    fr: 'Analyse des écarts de son équipe',
                    en: 'Gap analysis for their team',
                },
                where: {
                    fr: 'Menu Équipe → « Analyse des écarts » (/supervisor/gap-analysis)',
                    en: 'Team menu → “Gap analysis” (/supervisor/gap-analysis)',
                },
                what: {
                    fr: "Une ligne par personne supervisée — mesuré : 15 lignes pour le compte de test, en tête Léa KESSLER (11 écarts), Thierry ABÉRNATH (10), Zoumana WALSH (10). Trois colonnes : écarts totaux, écarts critiques, et « NOT MEASURED » — cette dernière affiche « — » quand la donnée n'a pas été mesurée ; elle ne vaut pas zéro. Chaque ligne ouvre directement Coaching ou Plan de développement.",
                    en: 'One row per supervised person — measured: 15 rows on the test account, led by Léa KESSLER (11 gaps), Thierry ABÉRNATH (10), Zoumana WALSH (10). Three columns: total gaps, critical gaps, and “NOT MEASURED” — the last shows “—” where nothing was measured; it does not mean zero. Each row opens Coaching or a Development plan directly.',
                },
            },
            {
                icon: '🤝',
                img: null,
                imgRetired: 'sup-sv-06-coaching',
                title: {
                    fr: 'Coaching et plans de développement',
                    en: 'Coaching and development plans',
                },
                where: {
                    fr: 'Menu Équipe → « Coaching » (/coaching/plans) et « Plans de développement (IDP) » (/v2/idp/manage)',
                    en: 'Team menu → “Coaching” (/coaching/plans) and “Dev Plans (IDP)” (/v2/idp/manage)',
                },
                what: {
                    fr: "La page l'écrit : « Supervisors create & validate; employees execute; managers monitor. » Le coaching est intégralement au niveau superviseur — aucune de ses actions n'exige le rang de manager. La liste « Mes collaborateurs » contient exactement les personnes gouvernées (15 pour le compte de test).",
                    en: 'The page states it: “Supervisors create & validate; employees execute; managers monitor.” Coaching sits entirely at supervisor level — none of its actions requires manager rank. The “My people” list holds exactly the governed people (15 on the test account).',
                },
            },
            {
                icon: '🚫',
                img: 'sup-sv-02-sa-reviews',
                title: {
                    fr: "Ce qu'un superviseur ne peut PAS faire",
                    en: 'What a supervisor CANNOT do',
                },
                where: {
                    fr: "Constaté sur les points d'API du parcours d'auto-évaluation et de la 9-Box",
                    en: 'Observed on the self-assessment workflow and 9-Box endpoints',
                },
                what: {
                    fr: "Six refus mesurés, tous en HTTP 403 : validation manager d'un dossier en état Revue → « Not authorized: manager/admin only » ; arbitrage d'un désaccord → même message ; 9-Box Approuver, Rejeter, Archiver, Rendre visible → même message. Après chacun de ces refus, la donnée est strictement inchangée. Il ne peut pas non plus approuver sa propre auto-évaluation (403 « Not authorized: supervisor/manager/admin only ») ni toucher au dossier d'une personne hors de son périmètre (403 « Not authorized: supervisor/admin only »).",
                    en: 'Six measured refusals, all HTTP 403: manager validation of a Reviewed file → “Not authorized: manager/admin only”; dispute arbitration → same message; 9-Box Approve, Reject, Archive, Disclose → same message. After each refusal the data is strictly unchanged. They also cannot approve their own self-assessment (403 “Not authorized: supervisor/manager/admin only”) nor touch anyone outside their span (403 “Not authorized: supervisor/admin only”).',
                },
            },
            {
                icon: '🏠',
                img: 'mgr-01-supervisor-dashboard',
                title: {
                    fr: 'Mon équipe — votre page d’accueil de manager',
                    en: 'My Team — your manager home',
                },
                where: {
                    fr: 'ÉQUIPE → Mon équipe (/supervisor/dashboard)',
                    en: 'TEAM → My Team (/supervisor/dashboard)',
                },
                what: {
                    fr: 'La page « qu’est-ce qui m’attend aujourd’hui ? ». Un bandeau « Ce qui requiert votre attention » (le 2026-09-02 : « Vous êtes à jour — aucune action requise pour le moment ») puis quatre raccourcis : File d’attente des revues, Analyse des écarts, Coaching, et votre propre auto-évaluation. Le chemin est /supervisor/dashboard : /manager/dashboard n’existe pas (404).',
                    en: 'The "what needs me today?" page. A "What needs you" strip (on 2026-09-02: "You are all caught up — nothing needs your action right now") then four shortcuts: reviews queue, gap analysis, coaching, and your own self-assessment. The path is /supervisor/dashboard: /manager/dashboard does not exist (404).',
                },
            },
            {
                icon: '✅',
                img: null,
                imgRetired: 'mgr-02c-sa-reviews-detail',
                title: {
                    fr: 'Examiner les auto-évaluations — et poser VOTRE note',
                    en: 'Review self-assessments — and enter YOUR rating',
                },
                where: {
                    fr: 'ÉQUIPE → Revues d’auto-évaluation (/supervisor/self-assessment-reviews)',
                    en: 'TEAM → SA Reviews (/supervisor/self-assessment-reviews)',
                },
                what: {
                    fr: 'Les soumissions sont groupées par collaborateur : une carte par personne avec « Détails » et « Tout approuver (N) ». Dépliée, chaque ligne montre <b>Compétence · Requis · Auto-éval (avec l’écart) · Dernier niveau validé · Justification du collaborateur · État · Actions</b>. Dans Actions, un sélecteur <b>« Note resp. »</b> de 0 à 4 porte VOTRE note de responsable, pré-remplie avec l’auto-évaluation : c’est elle qui devient le niveau officiel à l’approbation. Si vous la modifiez, une fenêtre <b>« Saisie requise »</b> s’ouvre : « Votre note (3) diffère de l’auto-évaluation (2). Indiquez brièvement pourquoi — cette justification est conservée et visible dans la revue ». Annuler abandonne toute la décision : rien n’est envoyé. <b>Rejeter</b> exige aussi un « Motif du rejet » et ne produit AUCUNE note : le rejet ne promeut rien au niveau officiel et ne déclenche ni PDI ni PIP. Le tri (Tout / Écart avec le requis / Critique / Sans justification) réorganise l’affichage seulement : « toutes les compétences restent dans la file, aucune n’est retirée ». Vous ne pouvez pas réviser votre propre auto-évaluation.',
                    en: 'Submissions are grouped per employee: one card per person with "Details" and "Approve all (N)". Expanded, each row shows <b>Skill · Required · Self-rating (with the gap) · Last validated level · Employee justification · State · Actions</b>. In Actions a <b>"Reviewer rating"</b> 0–4 selector carries YOUR OWN rating, pre-filled with the self-rating: that is what becomes the official level on approval. Change it and a <b>"Input required"</b> dialog opens: "Your rating (3) differs from the self-assessment (2). Say briefly why — this justification is kept and visible in the review". Cancel aborts the whole decision: nothing is sent. <b>Reject</b> also demands a rejection reason and produces NO rating: rejection promotes nothing to the official level and triggers neither an IDP nor a PIP. Sorting (All / Gap against required / Critical / No justification) only reorders the display: "every skill stays in the queue, none is removed". You cannot review your own self-assessment.',
                },
            },
            {
                icon: '📉',
                img: null,
                imgRetired: 'mgr-03-gap-analysis',
                title: {
                    fr: 'Analyse des écarts — écart mesuré ≠ non mesuré',
                    en: 'Gap analysis — a measured gap is not an unmeasured one',
                },
                where: {
                    fr: 'ÉQUIPE → Analyse des écarts (/supervisor/gap-analysis)',
                    en: 'TEAM → Gap analysis (/supervisor/gap-analysis)',
                },
                what: {
                    fr: 'La page liste chaque collaborateur ayant au moins un écart mesuré ou une exigence jamais évaluée, avec quatre colonnes : <b>Employé · Écarts totaux · Écarts critiques · Non mesuré</b>. Le 2026-09-02 elle affiche <b>14 lignes pour 90 écarts</b> (Léa KESSLER 11, Thierry ABÉRNATH 10, Zoumana WALSH 10, Clarisse OYÉRÉ 9, Landry PETROV 9, Norah HARTLEY 9, Aminata BRENNAN 6, Bakary FARRELL 6, Nadia FONTÉRA 5, Ferdinand POUNDÉ 4, Sékou ZANTÉ 4, Yacine RIVERA 4, Idrissa MARCHÉTTI 2, Mariama TANAKA 1) ; <b>0 écart critique</b> et <b>« — » partout en « Non mesuré »</b>. Le 15ᵉ collaborateur mesuré, Rachelle ESPOSITO, n’apparaît pas : il est à 100 % de préparation, sans aucun écart. <b>Un écart est une insuffisance MESURÉE</b> (niveau constaté < niveau requis du poste). Une exigence <b>jamais évaluée</b> est comptée à part, en pastille orange, avec l’infobulle « Jamais évalué — aucune donnée, ce n’est pas un niveau 0 » : elle n’est jamais additionnée aux écarts, parce que « aller mesurer » et « former » ne sont pas la même consigne. La page lit désormais les exigences du poste (vue v_employee_skill_gaps), la même source que /reports/gaps et le tableau de bord : les trois concordent.',
                    en: 'The page lists every report with at least one measured gap or one never-assessed requirement, in four columns: <b>Employee · Total gaps · Critical gaps · Not measured</b>. On 2026-09-02 it shows <b>14 rows for 90 gaps</b> (Léa KESSLER 11, Thierry ABÉRNATH 10, Zoumana WALSH 10, Clarisse OYÉRÉ 9, Landry PETROV 9, Norah HARTLEY 9, Aminata BRENNAN 6, Bakary FARRELL 6, Nadia FONTÉRA 5, Ferdinand POUNDÉ 4, Sékou ZANTÉ 4, Yacine RIVERA 4, Idrissa MARCHÉTTI 2, Mariama TANAKA 1); <b>0 critical gaps</b> and <b>"—" in every Not-measured cell</b>. The 15th measured person, Rachelle ESPOSITO, is absent: he is at 100% readiness with no gap at all. <b>A gap is a MEASURED shortfall</b> (observed level below the level the role requires). A <b>never-assessed</b> requirement is counted separately, as an amber badge, tooltip "Never assessed — no data, this is not a level 0": it is never added to the gaps, because "go and measure" and "go and train" are different instructions to a manager. The page now reads role requirements (view v_employee_skill_gaps), the same source as /reports/gaps and the dashboard: the three agree.',
                },
            },
            {
                icon: '📊',
                img: null,
                imgRetired: 'mgr-04-dashboard-executive',
                title: {
                    fr: 'Tableau de bord des capacités — Vue exécutive',
                    en: 'Workforce Capability Dashboard — Executive overview',
                },
                where: {
                    fr: 'PRINCIPAL → Tableau de bord (/dashboard), onglet « Vue exécutive »',
                    en: 'MAIN → Dashboard (/dashboard), "Executive overview" tab',
                },
                what: {
                    fr: 'Le cockpit, limité à vos collaborateurs. Filtres Site / Département / Service puis Appliquer. Le 2026-09-02 : <b>Indice de santé 81 « Sain »</b> (Préparation 25 % → 72, Couverture 15 % → 100, Conformité 25 % → 100, Dotation 15 % → 18, Fraîcheur 20 % → 100) ; <b>71,7 % de maîtrise moyenne « sur les 189 exigences évaluées de 189 (100 %) »</b> ; <b>7 / 15 prêts pour le poste</b> ; <b>1 écart critique</b> (employé mesuré sous 50 %) ; <b>« — » en conformité critique</b> ; <b>9 postes à risque</b> (titulaire unique) ; <b>189 / 189 exigences évaluées, 0 jamais évaluée</b>. L’encadré « Comment lire ceci » le dit explicitement : « Les 0 jamais évaluées sont un angle mort, pas un niveau 0 ». Cinq onglets : Vue exécutive, Priorités de formation, Développement des talents, Cartographie des capacités, Comparateur. L’échelle affichée en pied de page est <b>0 Aucune connaissance · 1 Notions de base · 2 Performance guidée · 3 Autonome · 4 Expert / peut former</b>.',
                    en: 'The cockpit, scoped to your people. Site / Department / Service filters then Apply. On 2026-09-02: <b>Health index 81 "Healthy"</b> (Readiness 25% → 72, Coverage 15% → 100, Compliance 25% → 100, Staffing 15% → 18, Freshness 20% → 100); <b>71.7% average proficiency "over the 189 of 189 requirements assessed (100%)"</b>; <b>7 / 15 role-ready</b>; <b>1 critical gap</b> (measured below 50%); <b>"—" critical compliance</b>; <b>9 roles at risk</b> (single occupant); <b>189 / 189 requirements assessed, 0 never assessed</b>. The "How to read this" note says it outright: "The 0 never assessed are a blind spot, not a level 0". Five tabs: Executive overview, Training priorities, Talent development, Capability map, Comparator. The scale printed in the footer is <b>0 No knowledge · 1 Basic awareness · 2 Guided performance · 3 Autonomous · 4 Expert / can teach</b>.',
                },
            },
            {
                icon: '🎯',
                img: 'mgr-05-dashboard-training',
                title: {
                    fr: 'Priorités de formation — impact et dette de mesure',
                    en: 'Training priorities — impact and measurement debt',
                },
                where: {
                    fr: 'Tableau de bord → onglet « Priorités de formation »',
                    en: 'Dashboard → "Training priorities" tab',
                },
                what: {
                    fr: 'Le top 15 des compétences par score d’impact (écart × collaborateurs), avec les colonnes <b>Employés concernés · Jamais évalué · Points d’écart · Écart moyen · Score d’impact</b>. Le 2026-09-02, 13 lignes : Ways of Working & Operating Model Design (10 concernés, 18 points, 1,8 de moyenne, impact 18), Business Problem Framing & Value Orientation (12, 15, 1,3, impact 18), Adoption, Change & Stakeholder Management (10, 15, 1,5, 15), Data Governance & Quality (10, 13, 1,3, 13), Data Platform & Cloud Operations (9, 13, 1,4, 11,7)… <b>La colonne « Jamais évalué » est à 0 sur toutes les lignes</b> et reste séparée des points d’écart : une compétence non mesurée ne gonfle jamais un besoin de formation.',
                    en: 'The top 15 skills by impact score (gap × people), with columns <b>Employees affected · Never assessed · Gap points · Average gap · Impact score</b>. On 2026-09-02, 13 rows: Ways of Working & Operating Model Design (10 affected, 18 points, 1.8 avg, impact 18), Business Problem Framing & Value Orientation (12, 15, 1.3, impact 18), Adoption, Change & Stakeholder Management (10, 15, 1.5, 15), Data Governance & Quality (10, 13, 1.3, 13), Data Platform & Cloud Operations (9, 13, 1.4, 11.7)… <b>The "Never assessed" column is 0 on every row</b> and stays separate from the gap points: an unmeasured skill never inflates a training need.',
                },
            },
            {
                icon: '🗺️',
                img: 'mgr-05c-dashboard-capability',
                title: {
                    fr: 'Cartographie des capacités et dotation par poste',
                    en: 'Capability map and staffing by role',
                },
                where: {
                    fr: 'Tableau de bord → onglet « Cartographie des capacités »',
                    en: 'Dashboard → "Capability map" tab',
                },
                what: {
                    fr: 'Une carte thermique des domaines regroupable par Site / Département / Service — pour ce périmètre : 3. Digital, Data & Work Tools 1,8 ; 5. Business Acumen 1,9 ; 6. People Management 1,9 (site Riverside) — puis une « Vue de la dotation par poste » : Confirmed Data Engineer 1 personne / 82,6 % ⚠️, Confirmed Soft/ML Engineer 1 / 77,3 % ⚠️, Data Architect 1 / 63,9 % ⚠️, Data Governance Lead 1 / 56,3 % ⚠️, Junior Data Scientist 1 / 100 % ⚠️, Senior Data Engineer 1 / 50 % ⚠️, UX/UI Designer 1 / 30 % ⚠️, Confirmed Data Scientist 2 / 92,1 % ✓, Data Platform Lead 2 / 61,8 % ⚠️, Data Product Lead 2 / 82 % ✓, Senior Data Scientist 2 / 71,7 % ⚠️. Le ⚠️ marque un poste à titulaire unique, y compris quand la préparation est de 100 % : c’est un risque de continuité, pas un défaut de compétence.',
                    en: 'A domain heatmap groupable by Site / Department / Service — for this scope: 3. Digital, Data & Work Tools 1.8; 5. Business Acumen 1.9; 6. People Management 1.9 (Riverside site) — then a "Staffing by role" view: Confirmed Data Engineer 1 person / 82.6% ⚠️, Confirmed Soft/ML Engineer 1 / 77.3% ⚠️, Data Architect 1 / 63.9% ⚠️, Data Governance Lead 1 / 56.3% ⚠️, Junior Data Scientist 1 / 100% ⚠️, Senior Data Engineer 1 / 50% ⚠️, UX/UI Designer 1 / 30% ⚠️, Confirmed Data Scientist 2 / 92.1% ✓, Data Platform Lead 2 / 61.8% ⚠️, Data Product Lead 2 / 82% ✓, Senior Data Scientist 2 / 71.7% ⚠️. The ⚠️ flags a single-occupant role, even at 100% readiness: that is a continuity risk, not a competency failure.',
                },
            },
            {
                icon: '📈',
                img: 'mgr-06-dept-analytics',
                title: {
                    fr: 'Analytique départementale, avancement de campagne, progression',
                    en: 'Departmental analytics, campaign burndown, progression',
                },
                where: {
                    fr: 'PILOTAGE → Analytique dépt. (/reports/dept-analytics)',
                    en: 'STEERING → Dept Analytics (/reports/dept-analytics)',
                },
                what: {
                    fr: 'Fenêtre 6 / 12 / 24 mois. En haut, « Ce mois-ci — actions de performance » : PIP, PDI, Coaching, Mentorat, Auto-évaluation, chacun <b>0 (±0 vs mois dernier)</b> le 2026-09-02. Puis complétion de la matrice par département, distribution 9-box par département (« Aucun positionnement 9-box disponible dans ce périmètre pour l’instant »), actions de performance mois par mois, <b>avancement de campagne</b> (« Aucune campagne ouverte — l’avancement apparaît pendant qu’un cycle tourne ») et <b>progression d’équipe</b> (« Aucune évaluation confirmée dans la fenêtre »). La page dit ce qu’elle n’a pas mesuré au lieu d’afficher un zéro.',
                    en: 'A 6 / 12 / 24-month window. At the top, "This month — performance actions": PIP, IDP, Coaching, Mentoring, Self-assessment, each <b>0 (±0 vs last month)</b> on 2026-09-02. Then skill-matrix completion by department, 9-box distribution by department ("No 9-box placements available in this scope yet"), performance actions month over month, <b>campaign burndown</b> ("No open campaign — the burndown appears while a cycle is running") and <b>team progression</b> ("No confirmed assessments in the window yet"). The page states what it has not measured instead of printing a zero.',
                },
            },
            {
                icon: '🏁',
                img: null,
                imgRetired: 'mgr-07-readiness-report',
                title: {
                    fr: 'Rapport de préparation (vue prête à l’emploi)',
                    en: 'Readiness report (ready-made view)',
                },
                where: {
                    fr: '/reports/readiness — atteint depuis Rapports ; export CSV / JSON en haut',
                    en: '/reports/readiness — reached from Reports; CSV / JSON export at the top',
                },
                what: {
                    fr: 'Le 2026-09-02 : <b>15 collaborateurs, 7 prêts, 8 non prêts, 47 % de prêts au poste</b>, avec la distribution 0-20 % : 0 · 21-40 % : 1 · 41-60 % : 3 · 61-79 % : 4 · 80-100 % : 7. Le tableau donne, par personne, <b>Préparation % et Compétences atteintes</b> : Rachelle ESPOSITO 100 % (11/11), Mariama TANAKA 94,7 % (12/13), Idrissa MARCHÉTTI 89,5 % (11/13), Nadia FONTÉRA 83,3 % (8/13), Ferdinand POUNDÉ 82,6 % (7/11), Aminata BRENNAN 80,6 % (7/13), Yacine RIVERA 80 % (9/13) — les 7 « PRÊT » — puis Sékou ZANTÉ 77,3 % (9/13), Bakary FARRELL 73,5 % (7/13), Landry PETROV 63,9 % (4/13), Clarisse OYÉRÉ 63,3 % (4/13), Zoumana WALSH 56,3 % (3/13), Thierry ABÉRNATH 50 % (2/12), Norah HARTLEY 50 % (4/13), Léa KESSLER 30 % (1/12). Ce pourcentage est calculé <b>en points</b> (points obtenus / points exigés, sur les seules exigences évaluées) — voir l’avertissement au § 4 sur le pourcentage différent affiché par le Parcours de carrière.',
                    en: 'On 2026-09-02: <b>15 employees, 7 ready, 8 not ready, 47% role-ready</b>, distribution 0-20%: 0 · 21-40%: 1 · 41-60%: 3 · 61-79%: 4 · 80-100%: 7. The table gives, per person, <b>Readiness % and Skills met</b>: Rachelle ESPOSITO 100% (11/11), Mariama TANAKA 94.7% (12/13), Idrissa MARCHÉTTI 89.5% (11/13), Nadia FONTÉRA 83.3% (8/13), Ferdinand POUNDÉ 82.6% (7/11), Aminata BRENNAN 80.6% (7/13), Yacine RIVERA 80% (9/13) — the 7 "READY" — then Sékou ZANTÉ 77.3% (9/13), Bakary FARRELL 73.5% (7/13), Landry PETROV 63.9% (4/13), Clarisse OYÉRÉ 63.3% (4/13), Zoumana WALSH 56.3% (3/13), Thierry ABÉRNATH 50% (2/12), Norah HARTLEY 50% (4/13), Léa KESSLER 30% (1/12). This percentage is <b>points-based</b> (points gained / points required, over assessed requirements only) — see the warning in § 4 about the different percentage shown by Career Path.',
                },
            },
            {
                icon: '📋',
                img: 'mgr-08-gaps-report',
                title: {
                    fr: 'Rapport des écarts (liste de courses de formation)',
                    en: 'Gaps report (the training shopping list)',
                },
                where: {
                    fr: '/reports/gaps — export CSV / JSON',
                    en: '/reports/gaps — CSV / JSON export',
                },
                what: {
                    fr: 'Une ligne par couple compétence × niveau requis, avec <b>Compétence · Domaine · Niveau requis · Critique · Employés concernés · Écart moyen</b>. Le 2026-09-02 : <b>38 lignes</b>, en tête Business Problem Framing & Value Orientation (requis 3, 7 concernés, écart moyen 1,29), Adoption, Change & Stakeholder Management (requis 3, 7 concernés, 1,71), Data Governance & Quality (requis 3, 6 concernés, 1,33), Ways of Working & Operating Model Design (requis 4, 5 concernés, 2,00). <b>La colonne Critique vaut « Non » sur les 38 lignes</b> : aucune exigence critique ne pèse sur cette équipe aujourd’hui.',
                    en: 'One row per skill × required-level pair, with <b>Skill · Domain · Required level · Critical · Employees affected · Average gap</b>. On 2026-09-02: <b>38 rows</b>, led by Business Problem Framing & Value Orientation (required 3, 7 affected, avg gap 1.29), Adoption, Change & Stakeholder Management (required 3, 7 affected, 1.71), Data Governance & Quality (required 3, 6 affected, 1.33), Ways of Working & Operating Model Design (required 4, 5 affected, 2.00). <b>The Critical column reads "No" on all 38 rows</b>: no critical requirement is in play for this team today.',
                },
            },
            {
                icon: '🧱',
                img: 'mgr-09-report-builder',
                title: { fr: 'Générateur de rapports', en: 'Report Builder' },
                where: {
                    fr: 'PILOTAGE → Rapports (/reports/builder)',
                    en: 'STEERING → Reports (/reports/builder)',
                },
                what: {
                    fr: 'Un constructeur par sections. Panneau CONFIG : <b>8 sources de données</b> (Préparation, Écarts de compétences, Capacité par domaine, Détails collaborateur, Évaluations résolues, Couverture des évaluations, Provenance des exigences, Talents 9-Box), dimension et dimension secondaire, métrique, agrégation (Moyenne / Somme / Comptage / Comptage distinct / Min / Max), <b>14 types de graphiques</b> (Barres, Barres empilées, Barres horizontales, Ligne, Aire, Radar, Anneau, Jauge, Nuage, Carte thermique, Tableau, Cartes KPI, Barres de progression), 7 palettes, mise en forme conditionnelle (Préparation < 50 rouge / 50-79 orange / 80+ vert ; Écart ; Niveau ; Couverture), tri, limite, largeur. Onglets SECTIONS / FILTRES / MODÈLES et boutons Planifications, Imprimer, Importer, Exporter, Enregistrer. Vide au départ : « Aucune section pour l’instant ». Un aperçu SQL / DATA / RÈGLES montre la requête générée.',
                    en: 'A section-based builder. CONFIG panel: <b>8 data sources</b> (Employee Readiness, Skill Gaps, Domain Capability, Employee Details, Resolved Assessments, Assessment Coverage, Requirement Provenance, 9-Box Talent), dimension and secondary dimension, metric, aggregation (Average / Sum / Count / Count distinct / Min / Max), <b>14 chart types</b> (Bar, Stacked bar, Horizontal bar, Line, Area, Radar, Doughnut, Gauge, Scatter, Heatmap, Table, KPI cards, Progress bars), 7 palettes, conditional formatting (Readiness < 50 red / 50-79 amber / 80+ green; Gap; Level; Coverage), sort, limit, width. SECTIONS / FILTERS / TEMPLATES tabs and Schedules, Print, Import, Export, Save buttons. Empty at first: "No sections yet". A SQL / DATA / RULES preview shows the generated query.',
                },
            },
            {
                icon: '📬',
                img: 'mgr-34-report-schedules',
                title: {
                    fr: 'Planifications de rapports et rapport départemental personnel',
                    en: 'Report schedules and the personal departmental digest',
                },
                where: {
                    fr: 'Rapports → Planifications (/reports/schedules)',
                    en: 'Reports → Schedules (/reports/schedules)',
                },
                what: {
                    fr: 'Deux mécanismes sur une page. (1) <b>Rapport départemental personnel</b> : une carte d’abonnement avec Fréquence (Bimensuel / Mensuel), heure de départ (00:00 à 23:00) et le bouton <b>S’abonner</b> ; l’état affiché le 2026-09-02 est <b>« Non abonné »</b>. Le contenu annoncé est « effectif, complétion de la matrice, préparation, revues, PIP, IDP, couverture », limité à ce que vous gouvernez. (2) <b>Nouvelle planification</b> : envoie par courriel un <i>modèle de rapport enregistré</i> de façon récurrente, en pièce jointe CSV, avec votre propre périmètre de données. Le 2026-09-02, la page dit : « Aucun modèle de rapport enregistré pour le moment — créez un rapport et enregistrez-le d’abord comme modèle », et le tableau Modèle / Destinataires / Fréquence / Dernière exécution / Dernier statut est vide. <b>Il faut donc d’abord enregistrer un modèle dans le générateur</b> : sans modèle, aucune planification n’est créable.',
                    en: 'Two mechanisms on one page. (1) <b>Personal departmental digest</b>: a subscription card with Frequency (Bi-weekly / Monthly), start hour (00:00 to 23:00) and a <b>Subscribe</b> button; the state shown on 2026-09-02 is <b>"Not subscribed"</b>. The advertised content is "headcount, matrix completion, readiness, reviews, PIPs, IDPs, coverage", limited to what you govern. (2) <b>New schedule</b>: emails a <i>saved report template</i> on a recurring basis, as a CSV attachment, with your own data scope. On 2026-09-02 the page says: "No saved report template yet — create a report and save it as a template first", and the Template / Recipients / Frequency / Last run / Last status table is empty. <b>So a template must be saved in the builder first</b>: with no template, no schedule can be created.',
                },
            },
            {
                icon: '🧩',
                img: null,
                imgRetired: 'mgr-10-nine-box-roster',
                title: {
                    fr: 'Grille 9-Box — l’effectif et son état',
                    en: '9-Box grid — the roster and its state',
                },
                where: {
                    fr: 'TALENTS → Grille 9-Box (/talent/nine-box), onglet « Effectif »',
                    en: 'TALENT → 9-Box Talent (/talent/nine-box), "Roster" tab',
                },
                what: {
                    fr: 'La liste des personnes de votre périmètre — <b>« 15 sur 15 collaborateurs »</b> le 2026-09-02, toutes marquées <b>« — non évalué — ⏰ Échéance »</b> avec un bouton Évaluer. La page rappelle : « Positionnement piloté par le manager (Performance × Potentiel). Les superviseurs préparent les brouillons ; les managers approuvent/publient. Confidentiel — vous ne voyez que les collaborateurs de votre périmètre. » Une personne déjà positionnée affiche à la place son <b>encadré = sa position approuvée</b>, suivie le cas échéant du brouillon en attente, marqué : par exemple <b>« ÉTOILE ÉMERGENTE ◌ Brouillon → Étoile montante »</b>. Un brouillon est une <b>proposition</b>, jamais une position : il est signalé par ◌ et ne remplace jamais une approbation.',
                    en: 'The list of the people in your scope — <b>"15 of 15 employees"</b> on 2026-09-02, every one marked <b>"— not assessed — ⏰ Due"</b> with an Assess button. The page states: "Manager-driven placement (Performance × Potential). Supervisors draft; managers approve/publish. Confidential — you only see the employees within your span of control." Someone already placed shows instead their <b>badge = their approved position</b>, followed where relevant by the pending draft, marked: e.g. <b>"EMERGING STAR ◌ Draft → Rising star"</b>. A draft is a <b>proposal</b>, never a position: it carries the ◌ marker and never stands in place of an approval.',
                },
            },
            {
                icon: '🎲',
                img: 'mgr-11-nine-box-grid',
                title: {
                    fr: 'Grille 9-Box — une personne, une seule pastille',
                    en: '9-Box grid — one person, exactly one chip',
                },
                where: {
                    fr: 'TALENTS → Grille 9-Box → onglet « Grille 9-Box »',
                    en: 'TALENT → 9-Box Talent → "9-Box grid" tab',
                },
                what: {
                    fr: 'Les neuf cases Performance × Potentiel, chacune avec son libellé, son compte et sa définition : Diamant brut, Étoile montante, Étoile d’or / Dilemme, Contributeur clé, Étoile émergente / Point de vigilance, Contributeur essentiel, Professionnel de confiance. Le 2026-09-02 les neuf cases sont à 0 pour cette équipe. <b>Chaque personne n’apparaît qu’une seule fois</b> : la grille affiche la ligne COURANTE de l’employé, c’est-à-dire son positionnement <b>approuvé</b>. Un ◌ en tête de pastille signale une proposition sans approbation derrière elle ; un • signale une position approuvée assortie d’un brouillon plus récent en attente de décision. Vérifié en conditions réelles : une personne portant simultanément un positionnement approuvé « Étoile émergente » et un brouillon plus récent « Étoile montante » a produit <b>exactement une pastille</b>, placée dans « Étoile émergente » (compte 1) — « Étoile montante » restant à 0 — infobulle « Niveau 2 · tendance stable · Approuvé ».',
                    en: 'The nine Performance × Potential cells, each with its label, count and definition: Rough diamond, Rising star, Gold star / Dilemma, Key contributor, Emerging star / Concern, Core contributor, Trusted professional. On 2026-09-02 all nine cells are 0 for this team. <b>Each person appears exactly once</b>: the grid shows the employee’s CURRENT row, i.e. their <b>approved</b> placement. A leading ◌ marks a proposal with no approval behind it; a • marks an approved position that has a newer draft awaiting a decision. Verified live: a person carrying both an approved "Emerging star" placement and a newer "Rising star" draft produced <b>exactly one chip</b>, sitting in "Emerging star" (count 1) — "Rising star" staying at 0 — tooltip "Tier 2 · trend stable · Approved".',
                },
            },
            {
                icon: '📋',
                img: 'mgr-12-talent-actions',
                title: {
                    fr: 'Actions talents — le backlog de développement',
                    en: 'Talent Actions — the development backlog',
                },
                where: {
                    fr: 'TALENTS → Actions talents (/talent/actions)',
                    en: 'TALENT → Talent Actions (/talent/actions)',
                },
                what: {
                    fr: 'Une vue consolidée des PIP, PDI et plans de coaching/mentorat de vos collaborateurs, plus la supervision calibration & biais. Le 2026-09-02 : <b>0 / 0 PIP actifs, 0 / 0 PDI actifs, 0 / 0 coaching actifs, 0 % de progression moyenne, 0 alerte de biais ouverte</b>, avec la mention « Tout est en ordre — aucun élément n’attend une action du manager » et la répartition « Coaching par contexte : écart de compétence 0 · PIP 0 · PDI 0 ». Trois tableaux (PIP, PDI, Coaching & mentorat) affichent « Aucun … dans le périmètre » et renvoient chacun vers sa console (« gérer → »). Un bouton <b>Export CSV</b> exporte le contenu affiché (généré côté navigateur, fichier talent-actions-AAAA-MM-JJ.csv).',
                    en: 'A consolidated view of your people’s PIPs, IDPs and coaching/mentoring plans, plus calibration & bias oversight. On 2026-09-02: <b>0 / 0 active PIPs, 0 / 0 active IDPs, 0 / 0 active coaching, 0% average progress, 0 open bias alerts</b>, with "All clear — no items are currently waiting on a manager action" and the breakdown "Coaching by context: skill-gap 0 · PIP 0 · IDP 0". Three tables (PIP, IDP, Coaching & mentoring) read "No … in scope" and each links to its console ("manage →"). An <b>Export CSV</b> button exports what is displayed (built in the browser, file talent-actions-YYYY-MM-DD.csv).',
                },
            },
            {
                icon: '🧭',
                img: null,
                imgRetired: 'mgr-13-career-path-analysis',
                title: {
                    fr: 'Parcours de carrière et préparation',
                    en: 'Career path and readiness',
                },
                where: {
                    fr: 'TALENTS → Parcours de carrière (/talent/career-path)',
                    en: 'TALENT → Career Path (/talent/career-path)',
                },
                what: {
                    fr: 'Choisissez un collaborateur (les 15 de votre périmètre) et un poste cible (49 postes du catalogue), puis <b>Analyser</b>. Exemple réel : Norah HARTLEY vers Data Platform Lead → <b>31 % de préparation, 4 exigences satisfaites sur 13, 9 écarts, 0 écart critique</b>. Le tableau donne Domaine · Compétence · Requis · Actuel · Écart · Statut, trié par écart décroissant : Security, Privacy & Compliance (4 → 1, écart 3), Ways of Working & Operating Model Design (4 → 1, écart 3), Adoption, Change & Stakeholder Management (3 → 1, écart 2), Business Problem Framing (3 → 1, écart 2), Data Governance & Quality (3 → 1, écart 2), Data Platform & Cloud Operations (4 → 2, écart 2), puis trois écarts de 1 et quatre lignes « atteint ». <b>Attention</b> : ce pourcentage est un simple ratio d’exigences satisfaites (4/13 = 31 %) et n’est pas le même calcul que le « Préparation % » du rapport de préparation, qui vaut 50 % pour la même personne (calcul en points). Les deux pages s’accordent en revanche sur les valeurs mesurables : <b>4 sur 13 satisfaites, 9 écarts</b> — le même chiffre que l’Analyse des écarts.',
                    en: 'Pick an employee (your 15) and a target role (49 catalogue roles), then <b>Analyze</b>. Real example: Norah HARTLEY toward Data Platform Lead → <b>31% readiness, 4 requirements met out of 13, 9 gaps, 0 critical gaps</b>. The table gives Domain · Skill · Required · Current · Gap · Status, sorted by descending gap: Security, Privacy & Compliance (4 → 1, gap 3), Ways of Working & Operating Model Design (4 → 1, gap 3), Adoption, Change & Stakeholder Management (3 → 1, gap 2), Business Problem Framing (3 → 1, gap 2), Data Governance & Quality (3 → 1, gap 2), Data Platform & Cloud Operations (4 → 2, gap 2), then three gaps of 1 and four "met" rows. <b>Caution</b>: this percentage is a plain ratio of requirements met (4/13 = 31%) and is not the same computation as the readiness report’s "Readiness %", which is 50% for the same person (points-based). The two pages do agree on the measurable values: <b>4 of 13 met, 9 gaps</b> — the same figure the Gap analysis shows.',
                },
            },
            {
                icon: '🤝',
                img: null,
                imgRetired: 'mgr-15-coaching',
                title: { fr: 'Coaching et mentorat', en: 'Coaching and mentoring' },
                where: {
                    fr: 'ÉQUIPE → Coaching (/coaching/plans)',
                    en: 'TEAM → Coaching (/coaching/plans)',
                },
                what: {
                    fr: 'Deux onglets : <b>Mes collaborateurs</b> et <b>Plans</b>. L’onglet collaborateurs liste les <b>15 sur 15</b> personnes gouvernées avec Poste, Service · Site, « Plans actifs » (<b>« aucun » pour les 15</b> le 2026-09-02) et un bouton <b>Démarrer un plan</b>. La page pose la règle : « Les superviseurs créent et valident ; les collaborateurs exécutent ; les managers suivent. Les administrateurs héritent des deux rôles. » Le chemin réel est /coaching/plans ; /talent/coaching n’existe pas (404).',
                    en: 'Two tabs: <b>My people</b> and <b>Plans</b>. The people tab lists the <b>15 of 15</b> governed employees with Role, Service · Site, "Active plans" (<b>"none" for all 15</b> on 2026-09-02) and a <b>Start a plan</b> button. The page states the rule: "Supervisors create and validate; employees execute; managers follow up. Administrators inherit both roles." The real path is /coaching/plans; /talent/coaching does not exist (404).',
                },
            },
            {
                icon: '🌱',
                img: 'mgr-16-idp',
                title: {
                    fr: 'Plans de développement individuels (PDI)',
                    en: 'Individual Development Plans (IDP)',
                },
                where: {
                    fr: 'ÉQUIPE → Plans de développement (IDP) (/v2/idp/manage) ; création : /v2/idp/new',
                    en: 'TEAM → Dev Plans (IDP) (/v2/idp/manage); creation: /v2/idp/new',
                },
                what: {
                    fr: 'La liste des PDI de vos collaborateurs, avec les compteurs <b>Brouillon 0 · Actif 0 · Terminé 0</b> le 2026-09-02 et le message « Aucun plan de développement pour votre équipe pour le moment. Ils apparaissent ici lorsqu’un positionnement 9-box à haut potentiel est approuvé ou qu’un cycle génère des brouillons de PDI. » Le bouton <b>Nouveau PDI</b> ouvre un formulaire dont la liste de collaborateurs ne contient que <b>les 15 personnes que vous encadrez</b> (une personne hors périmètre n’y figure pas, même en forçant l’identifiant dans l’URL). Le plan « reste un brouillon jusqu’à ce que vous et le collaborateur l’ayez signé », et les écarts de compétences sélectionnés deviennent des objectifs SMART assortis d’une action de formation.',
                    en: 'The list of your people’s IDPs, with counters <b>Draft 0 · Active 0 · Completed 0</b> on 2026-09-02 and the message "No development plan for your team yet. They appear here when a high-potential 9-box placement is approved or a cycle generates IDP drafts." The <b>New IDP</b> button opens a form whose employee list contains only <b>the 15 people you supervise</b> (an out-of-scope person is absent, even when the id is forced in the URL). The plan "stays a draft until both you and the employee have signed it", and the selected skill gaps become SMART objectives, each with a training action.',
                },
            },
            {
                icon: '⏱️',
                img: 'mgr-17-pip',
                title: {
                    fr: 'Plans d’amélioration de la performance (PIP)',
                    en: 'Performance Improvement Plans (PIP)',
                },
                where: { fr: 'ÉQUIPE → PIP (/v2/pip)', en: 'TEAM → PIP (/v2/pip)' },
                what: {
                    fr: '« Piloté par le manager. Proposez un PIP pour l’un de vos collaborateurs, puis activez-le et clôturez-le une fois terminé. » Le formulaire « Proposer un PIP » demande le collaborateur (parmi les 15), un Démarrage, une Fin, un Résumé, des Objectifs, des Critères de réussite, des Points de suivi et un Accompagnement proposé. Le tableau Collaborateur / État / Démarrage / Fin / Résumé / Actions affiche « Aucun PIP pour votre équipe » le 2026-09-02. Chemin réel /v2/pip ; /talent/pip n’existe pas (404).',
                    en: '"Manager-driven. Propose a PIP for one of your people, then activate it and close it when it ends." The "Propose a PIP" form asks for the employee (from your 15), a start, an end, a summary, objectives, success criteria, follow-up points and the support offered. The Employee / State / Start / End / Summary / Actions table reads "No PIP for your team" on 2026-09-02. Real path /v2/pip; /talent/pip does not exist (404).',
                },
            },
            {
                icon: '⚖️',
                img: 'mgr-18-disputes',
                title: { fr: 'Contestations d’évaluation', en: 'Assessment disputes' },
                where: {
                    fr: 'ÉQUIPE → Contestations en cours (/v2/slf/disputes)',
                    en: 'TEAM → Open disputes (/v2/slf/disputes)',
                },
                what: {
                    fr: '« Contestations de notation ouvertes et escaladées pour votre équipe. Résolvez avec une note finale. » Colonnes : Collaborateur · Compétence · Auto · Superviseur · Niveau · État · Motif · Ouverte le · Résoudre. Le 2026-09-02 : « Aucune contestation ouverte ». La contestation est le SEUL cas qui remonte au manager : l’approbation ordinaire est déjà finale au niveau du superviseur. Chemin réel /v2/slf/disputes ; /talent/disputes n’existe pas (404).',
                    en: '"Open and escalated rating disputes for your team. Resolve with a final note." Columns: Employee · Skill · Self · Supervisor · Level · State · Reason · Opened on · Resolve. On 2026-09-02: "No open disputes". A dispute is the ONLY case that escalates to the manager: ordinary approval is already final at supervisor level. Real path /v2/slf/disputes; /talent/disputes does not exist (404).',
                },
            },
            {
                icon: '🗺️',
                img: null,
                imgRetired: 'mgr-19-continuity',
                title: {
                    fr: 'Continuité des effectifs — succession, risque de perte, passation',
                    en: 'People continuity — succession, risk-of-loss, handover',
                },
                where: {
                    fr: 'TALENTS → Continuité (/v2/continuity)',
                    en: 'TALENT → Continuity (/v2/continuity)',
                },
                what: {
                    fr: 'La page s’ouvre sur un guide « Commencer — activer la relève » qui chiffre le travail restant : le 2026-09-02, <b>11 élément(s) à traiter</b>, en trois gestes ordonnés. (1) <b>Postes occupés non cotés (11)</b> — « Tant qu’un poste n’a pas de cote de criticité, il n’entre dans aucun plan de relève » : Confirmed Data Scientist 2 titulaires, Data Platform Lead 2, Data Product Lead 2, Senior Data Scientist 2, puis Confirmed Data Engineer, Confirmed Soft/ML Engineer, Data Architect, Data Governance Lead, Junior Data Scientist, Senior Data Engineer, UX/UI Designer à 1. (2) <b>Postes critiques sans successeur nommé (0)</b>. (3) <b>Plans à échéance (0)</b> — chaque plan se revoit tous les 6 mois. Suivent : le tableau « Couverture des postes critiques » (vide — « Aucun poste critique désigné »), le formulaire <b>Désigner un poste critique</b> (Criticité 1–5, Risque de vacance faible/moyen/élevé, Délai de remplacement en jours, Impact métier, Justification), <b>Ouvrir un plan de succession</b>, la <b>Passation de connaissances</b> (sortant / entrant / échéance ; « Les événements de départ/mobilité en créent une automatiquement » ; aucune passation le 2026-09-02) et le <b>Risque de perte</b> : <b>15 lignes, toutes « faible / faible / score 0 / calculé »</b>, avec les actions Recalculer et Forcer. <b>Votre propre fiche de risque n’y figure pas</b> (séparation des tâches). Les sous-adresses /v2/continuity/retention, /handover et /plans-due répondent en 200 mais sont des <b>points d’API JSON</b>, pas des pages.',
                    en: 'The page opens on a "Get started — wake succession up" guide that quantifies the remaining work: on 2026-09-02, <b>11 item(s) to handle</b>, in three ordered moves. (1) <b>Occupied roles with no criticality score (11)</b> — "Until a role has a criticality score it belongs to no succession plan": Confirmed Data Scientist 2 occupants, Data Platform Lead 2, Data Product Lead 2, Senior Data Scientist 2, then Confirmed Data Engineer, Confirmed Soft/ML Engineer, Data Architect, Data Governance Lead, Junior Data Scientist, Senior Data Engineer, UX/UI Designer at 1. (2) <b>Critical roles with no named successor (0)</b>. (3) <b>Plans due for review (0)</b> — each plan is reviewed every 6 months. Then: the "Coverage of critical roles" table (empty — "No critical roles designated yet"), the <b>Designate a critical role</b> form (Criticality 1–5, Vacancy risk low/medium/high, Time-to-fill in days, Business impact, Rationale), <b>Open a succession plan</b>, the <b>Knowledge handover</b> block (outgoing / incoming / due; "Leaver/mover events auto-create one"; none on 2026-09-02) and <b>Risk-of-loss</b>: <b>15 rows, all "low / low / score 0 / computed"</b>, with Recompute and Override actions. <b>Your own risk record is not shown</b> (separation of duties). The sub-addresses /v2/continuity/retention, /handover and /plans-due answer 200 but are <b>JSON API endpoints</b>, not pages.',
                },
            },
            {
                icon: '🔎',
                img: null,
                imgRetired: 'mgr-20-qualified-lookup',
                title: {
                    fr: 'Qui est qualifié — la recherche opérationnelle',
                    en: 'Who is qualified — the operational lookup',
                },
                where: {
                    fr: 'CONFORMITÉ & SUIVI → Qui est qualifié (/qualified)',
                    en: 'COMPLIANCE & AUDIT → Who is qualified (/qualified)',
                },
                what: {
                    fr: '« Qui, sur ce site, peut réaliser cette tâche au niveau requis, avec un certificat valide, et sans absence programmée. » On saisit une compétence, un niveau minimum (1 à 4), éventuellement un site, un département, une date de disponibilité et la case « Certificat valide uniquement ». Recherche réelle du 2026-09-02 sur « Data Governance & Quality » au niveau ≥ 2 : <b>« 6 personne(s) au niveau 2 ou plus »</b> — Nadia FONTÉRA, Bakary FARRELL, Zoumana WALSH, Landry PETROV, Aminata BRENNAN, Yacine RIVERA, toutes à Riverside · IT, niveau 2, certificat « — », statut <b>DISPONIBLE</b>. Sans compétence choisie, la page dit « Choisissez une compétence pour lancer la recherche » : elle ne devine rien.',
                    en: '"Who, on this site, can do this task at the required level, with a valid certificate, and with no planned absence." You pick a skill, a minimum level (1 to 4), optionally a site, a department, an availability date and the "Valid certificate only" box. Real lookup on 2026-09-02 for "Data Governance & Quality" at level ≥ 2: <b>"6 person(s) at level 2 or above"</b> — Nadia FONTÉRA, Bakary FARRELL, Zoumana WALSH, Landry PETROV, Aminata BRENNAN, Yacine RIVERA, all Riverside · IT, level 2, certificate "—", status <b>AVAILABLE</b>. With no skill chosen the page says "Pick a skill to run the lookup": it guesses nothing.',
                },
            },
            {
                icon: '🎖️',
                img: 'mgr-21-compliance',
                title: {
                    fr: 'Conformité opérationnelle — certifications, VOC, couverture',
                    en: 'Operational compliance — certifications, VOC, coverage',
                },
                where: {
                    fr: 'CONFORMITÉ & SUIVI → Conformité (/compliance)',
                    en: 'COMPLIANCE & AUDIT → Compliance (/compliance)',
                },
                what: {
                    fr: 'Cinq cartes d’état — <b>Valides · À renouveler (fenêtre) · Expirées · Niveaux périmés · Règles de couverture en rupture</b> — toutes à <b>0</b> (et « 0 / 0 » pour les règles) le 2026-09-02 sur ce périmètre. Suivent le tableau « Couverture de postes (règles safe-shift) » (Règle · Périmètre · Compétence et niveau min. · Requis · Qualifiés · État · Prévu — « Aucune règle de couverture »), les <b>Absences planifiées</b> qui alimentent la prévision (« Les fenêtres de congé/formation/mission enregistrées sont projetées sur les 14 prochains jours avec les expirations de certificats »), avec un formulaire d’enregistrement (Collaborateur, Du, Au, Type : Congé / Formation / Mission / Médical / Autre, Note), et le tableau des certifications trié par échéance (« Aucune certification enregistrée dans votre périmètre ») avec le formulaire « Enregistrer une certification / validation VOC », dont la liste de compétences couvre tout le référentiel.',
                    en: 'Five status cards — <b>Valid · Expiring (in window) · Expired · Lapsed skill levels · Coverage rules in breach</b> — all <b>0</b> (and "0 / 0" for the rules) on 2026-09-02 for this scope. Then the "Position coverage (safe-shift rules)" table (Rule · Scope · Skill and min. level · Required · Qualified · Status · Predicted — "No coverage rules"), the <b>Planned absences</b> that feed the prediction ("Recorded leave/training/mission windows are projected over the next 14 days together with certificate expiries"), with a recording form (Employee, From, To, Kind: Leave / Training / Mission / Medical / Other, Note), and the certification table sorted by expiry ("No certifications recorded in your scope") with the "Record a certification / VOC sign-off" form, whose skill list spans the whole framework.',
                },
            },
            {
                icon: '⚠️',
                img: 'mgr-22-key-person',
                title: {
                    fr: 'Risque de personne clé — et l’inconnue qui n’est pas un risque',
                    en: 'Key-person risk — and the unknown that is not a risk',
                },
                where: {
                    fr: 'TALENTS → Risque de personne clé (/exec/key-person)',
                    en: 'TALENT → Key-person risk (/exec/key-person)',
                },
                what: {
                    fr: '« Les compétences qu’une seule personne détient — nommément, avec son site et son rôle. » Un bandeau annonce le périmètre : « les 15 collaborateurs que vous supervisez — tous les chiffres de cette page sont calculés sur ce périmètre uniquement, avant tout regroupement ». Le balayage du 2026-09-02 sur <b>13 paires compétence × unité</b> donne : <b>0 détenteur unique</b> (« exactement une personne évaluée au niveau requis. C’est le risque de personne clé »), <b>12 « aucun qualifié »</b> (« des personnes ont été évaluées ; aucune n’atteint le niveau requis. Écart réel et mesuré »), <b>0 « jamais mesuré »</b> (« personne n’a jamais été évalué sur cette compétence ici. C’est une INCONNUE, pas un écart — elle n’est jamais comptée comme un risque ») et <b>1 « couvert »</b> (au moins deux personnes qualifiées). Filtres : Unité (Site / Département / Service), État, unité précise, « Exigences critiques uniquement ».',
                    en: '"The capabilities exactly one person carries — by name, with their site and role." A banner states the scope: "the 15 people you govern — every figure on this page is computed over that scope only, before any grouping". The 2026-09-02 sweep over <b>13 skill × unit pairs</b> gives: <b>0 sole holders</b> ("exactly one person assessed at the required level. This is the key-person risk"), <b>12 "no one qualified"</b> ("people were assessed; none reaches the required level. A real, evidenced gap"), <b>0 "never measured"</b> ("nobody here has ever been assessed on this skill. That is an UNKNOWN, not a gap — it is never counted as risk") and <b>1 "covered"</b> (two or more qualified people). Filters: Unit (Site / Department / Service), State, a specific unit, "Critical requirements only".',
                },
            },
            {
                icon: '🔁',
                img: null,
                imgRetired: 'mgr-23-movements-365',
                title: {
                    fr: 'Mouvements — qui a bougé, qui a agi, et sous quel nom',
                    en: 'Movements — what moved, who acted, and under what name',
                },
                where: {
                    fr: 'CONFORMITÉ & SUIVI → Mouvements (/movements)',
                    en: 'COMPLIANCE & AUDIT → Movements (/movements)',
                },
                what: {
                    fr: 'Deux flux sur une page : les <b>mutations d’organisation</b> (site, département, service, poste, manager, superviseur, activation/désactivation) et l’<b>activité des évaluateurs</b> (évaluations saisies, revues effectuées). « Les mouvements sont captés par la base elle-même, donc les imports, SCIM et le SSO sont couverts au même titre que l’interface. » La fenêtre par défaut est courte : élargissez-la avec 7 / 30 / 90 / <b>365 derniers jours</b> puis Filtrer. Sur 365 jours au 2026-09-02 : <b>0 mouvement, 0 personne concernée, 195 évaluations saisies, 0 revue effectuée, 1 intervenant actif</b> ; le panneau « Qui agit le plus » affiche <b>admin — 195</b>. Le tableau donne Quand · Quoi · Qui · Où · Changement · <b>Auteur</b>, et la colonne Auteur affiche un <b>nom lisible</b> (ici « admin », l’identifiant de connexion de l’administrateur ; un manager y apparaît sous la forme « NOM, Prénom ») — plus jamais un jeton technique du type « admin:1 ». Bouton <b>Exporter CSV</b>.',
                    en: 'Two streams on one page: <b>organisational movements</b> (site, department, service, role, manager, supervisor, activation/deactivation) and <b>assessor activity</b> (assessments recorded, reviews completed). "Movements are captured by the database itself, so imports, SCIM and SSO are covered just like the UI." The default window is short: widen it with 7 / 30 / 90 / <b>365 days</b> then Filter. Over 365 days on 2026-09-02: <b>0 movements, 0 people affected, 195 assessments recorded, 0 reviews completed, 1 active actor</b>; the "Who is most active" panel shows <b>admin — 195</b>. The table gives When · What · Who · Where · Change · <b>Actor</b>, and the Actor column shows a <b>readable name</b> (here "admin", the administrator’s login; a manager appears as "SURNAME, First name") — never again a raw technical token such as "admin:1". <b>Export CSV</b> button.',
                },
            },
            {
                icon: '🚫',
                img: 'mgr-24-cancellations',
                title: {
                    fr: 'Annulations — vous demandez, un administrateur décide',
                    en: 'Cancellations — you request, an administrator decides',
                },
                where: {
                    fr: 'CONFORMITÉ & SUIVI → Annulations (/cancellations)',
                    en: 'COMPLIANCE & AUDIT → Cancellations (/cancellations)',
                },
                what: {
                    fr: '« Un manager ou un administrateur peut demander l’annulation d’un plan de coaching, d’un plan de mentorat, d’un PIP ou d’un PDI. La demande exige toujours un motif et n’est jamais appliquée d’elle-même : un administrateur local couvrant ce collaborateur doit l’approuver, et ce ne peut pas être le demandeur. » Un encart le confirme pour votre profil : « Vous pouvez demander une annulation ; la décision appartient à un administrateur local. » Filtres État (Tous / En attente / Annulé / Refusé / Retiré) et Type (Coaching / Mentorat / PIP / PDI). Le 2026-09-02 : « Aucune demande d’annulation ». La page rappelle enfin : « Rien n’est supprimé : le plan est marqué annulé et la demande conserve qui a demandé, pourquoi, qui a décidé et l’état précédent. »',
                    en: '"A manager or an administrator can request the cancellation of a coaching plan, a mentoring plan, a PIP or an IDP. The request always needs a reason and is never applied on its own: a local admin covering that employee must approve it, and it cannot be the requester." A callout confirms it for your profile: "You can request a cancellation; the decision belongs to a local admin." State filters (All / Pending / Cancelled / Refused / Withdrawn) and Type (Coaching / Mentoring / PIP / IDP). On 2026-09-02: "No cancellation requests". The page closes with: "Nothing is deleted: the plan is marked cancelled and the request keeps who asked, why, who decided and the previous state."',
                },
            },
            {
                icon: '🔒',
                img: 'mgr-25-post-approval',
                title: { fr: 'Révisions après approbation', en: 'Post-approval revisions' },
                where: {
                    fr: 'CONFORMITÉ & SUIVI → Révisions après approbation (/reviews/post-approval)',
                    en: 'COMPLIANCE & AUDIT → Post-approval revisions (/reviews/post-approval)',
                },
                what: {
                    fr: '« Un superviseur peut contester un niveau DÉJÀ APPROUVÉ et proposer une correction. Parce que la note porte déjà l’approbation d’un manager, seul un administrateur peut trancher — ni le superviseur ni le manager ne peuvent revenir seuls sur une approbation. » L’encart le redit pour vous : « Vous pouvez ouvrir un dossier, mais la décision appartient à un administrateur. » Colonnes : Collaborateur · Compétence · Niveau · Motif · Soulevé par · État. Filtres Tous / En attente / Approuvé / Rejeté / Retiré. Le 2026-09-02 : « Aucun dossier après approbation ».',
                    en: '"A supervisor can contest an ALREADY APPROVED level and propose a correction. Because the score already carries a manager’s approval, only an administrator can decide it — neither the supervisor nor the manager may overturn an approval on their own." The callout repeats it for you: "You can open a case, but the decision belongs to an administrator." Columns: Employee · Skill · Level · Reason · Raised by · State. Filters All / Pending / Approved / Rejected / Withdrawn. On 2026-09-02: "No post-approval cases".',
                },
            },
            {
                icon: '👥',
                img: null,
                imgRetired: 'mgr-26-employees',
                title: { fr: 'Annuaire des collaborateurs', en: 'Employee directory' },
                where: {
                    fr: 'PRINCIPAL → Collaborateurs (/employees)',
                    en: 'MAIN → Employees (/employees)',
                },
                what: {
                    fr: 'La liste des personnes de votre périmètre — <b>« 15 collaborateurs »</b> le 2026-09-02, groupés par site (RIVERSIDE), colonnes Matricule · Nom · Poste · Site · Département · Service · <b>Superviseur</b> (liste déroulante modifiable) · Actions (Voir, Évaluer, Modifier). Filtres : site, <b>Actifs / Sortis (désactivés) / Tous</b> (c’est sous « Sortis » que se trouve la 16ᵉ personne, désactivée), pagination 20 / 50 / 100 / 200 par page, et une recherche. Ouvrir une fiche donne accès à Voir les évaluations, <b>Progression</b>, Chronologie des compétences et Modifier.',
                    en: 'The list of the people in your scope — <b>"15 employees"</b> on 2026-09-02, grouped by site (RIVERSIDE), columns Number · Name · Role · Site · Department · Service · <b>Supervisor</b> (editable dropdown) · Actions (View, Assess, Edit). Filters: site, <b>Active / Leavers (deactivated) / All</b> (the 16th, deactivated person sits under "Leavers"), 20 / 50 / 100 / 200 per page, and a search box. Opening a record gives View assessments, <b>Progression</b>, Skill timeline and Edit.',
                },
            },
            {
                icon: '👤',
                img: null,
                imgRetired: 'mgr-32-employee-profile',
                title: {
                    fr: 'Fiche collaborateur — évolution, 9-box, OKR, points 1-à-1',
                    en: 'Employee profile — evolution, 9-box, OKRs, 1-on-1s',
                },
                where: {
                    fr: 'Collaborateurs → ouvrir une personne (/employees/:id)',
                    en: 'Employees → open a person (/employees/:id)',
                },
                what: {
                    fr: 'Une page unique par personne. Elle enchaîne : <b>Informations du collaborateur</b> (matricule, nom, e-mail, téléphone, poste, site, département, service) ; <b>Évolution et mouvements des compétences</b> (courbe des niveaux + allers-retours collaborateur ↔ évaluateur — « L’historique est capturé automatiquement lorsqu’une évaluation est approuvée ou qu’un niveau est modifié ») ; <b>Historique et tendance 9-Box</b> ; <b>Chronologie de développement</b> filtrable (Tous / Compétences / 9-Box / Coaching / IDP / PIP) ; <b>Actions de développement</b> (coaching et mentorat, PDI, PIP) ; <b>Objectifs et OKR</b> avec « ＋ Ajouter un objectif » ; <b>Points réguliers et entretiens 1-à-1</b> avec le type (1-à-1 / Feedback / Pulse) et une humeur 1 à 5 (😟 🙁 😐 🙂 😀). Sur la fiche de Norah HARTLEY le 2026-09-02, toutes ces sections sont vides et le disent (« Aucun objectif pour le moment », « Aucun point pour le moment »).',
                    en: 'One page per person. It runs through: <b>Employee information</b> (number, name, e-mail, phone, role, site, department, service); <b>Skill evolution and movement</b> (level chart + the employee ↔ reviewer round trips — "History is captured automatically when an assessment is approved or a level is edited"); <b>9-Box history and trend</b>; a filterable <b>Development timeline</b> (All / Skills / 9-Box / Coaching / IDP / PIP); <b>Development actions</b> (coaching and mentoring, IDPs, PIPs); <b>Goals and OKRs</b> with "＋ Add an objective"; <b>Check-ins and 1-on-1s</b> with the type (1-on-1 / Feedback / Pulse) and a 1–5 mood (😟 🙁 😐 🙂 😀). On Norah HARTLEY’s record on 2026-09-02 every one of these sections is empty and says so ("No objective yet", "No check-in yet").',
                },
            },
            {
                icon: '📈',
                img: null,
                imgRetired: 'mgr-37-employee-progression',
                title: {
                    fr: 'Progression d’un collaborateur (historique de campagnes)',
                    en: 'A report’s progression (campaign history)',
                },
                where: {
                    fr: 'Fiche collaborateur → bouton « Progression » (/employees/:id/progress)',
                    en: 'Employee record → "Progression" button (/employees/:id/progress)',
                },
                what: {
                    fr: 'La courbe et le tableau de l’historique de campagnes de la personne : <b>Campagne · Période · Compétences · Approuvées · En revue · Non soumises · Moy. auto-évaluée · Moy. confirmée · Mouvement net · Préparation · vs précédente</b>. Pour Norah HARTLEY le 2026-09-02 : « <b>Historique des campagnes (0 campagnes)</b> » et « Aucune activité d’évaluation enregistrée — la courbe démarre avec la première campagne ». Le chemin réel est /employees/:id/progress.',
                    en: 'The chart and the table of that person’s campaign history: <b>Campaign · Period · Skills · Approved · In review · Unsubmitted · Avg self-rated · Avg confirmed · Net movement · Readiness · vs previous</b>. For Norah HARTLEY on 2026-09-02: "<b>Campaign history (0 campaigns)</b>" and "No assessment activity recorded — the chart starts with the first campaign". The real path is /employees/:id/progress.',
                },
            },
            {
                icon: '🔲',
                img: null,
                imgRetired: 'mgr-27-skill-matrix',
                title: {
                    fr: 'Matrice de compétences (grille personnes × compétences)',
                    en: 'Skill matrix (people × skills grid)',
                },
                where: {
                    fr: 'PRINCIPAL → Matrice de compétences (/skill-matrix)',
                    en: 'MAIN → Skill Matrix (/skill-matrix)',
                },
                what: {
                    fr: 'La grille des niveaux actuels, filtrable par Site, Département, Service et Poste, avec <b>Vue compacte</b> et <b>Exporter CSV</b>. Un interrupteur <b>« Édition rapide »</b> (désactivée par défaut) transforme chaque cellule en liste déroulante 0–4 : « plus rapide pour noter plusieurs personnes à la fois ; les modifications sont enregistrées immédiatement ». Sans lui, cliquer une cellule ouvre l’écran d’évaluation de cette compétence.',
                    en: 'The grid of current levels, filterable by Site, Department, Service and Role, with a <b>Compact view</b> and <b>Export CSV</b>. A <b>"Quick edit"</b> toggle (off by default) turns each cell into a 0–4 dropdown: "faster for rating many people at once; changes save immediately". Without it, clicking a cell opens the assessment screen for that skill.',
                },
            },
            {
                icon: '📐',
                img: 'mgr-28-benchmark',
                title: {
                    fr: 'Référentiel (Benchmark) — exigences par poste et adéquation',
                    en: 'Benchmark — role requirements and fit',
                },
                where: {
                    fr: 'PRINCIPAL → <b>Référentiel</b> (/benchmark) — le libellé du menu français est « Référentiel », pas « Benchmark »',
                    en: 'MAIN → <b>Benchmark</b> (/benchmark)',
                },
                what: {
                    fr: 'Deux parties. La <b>matrice</b> aligne les postes en colonnes face aux compétences groupées par pilier → sous-domaine. Elle s’ouvre volontairement sur <b>un seul pilier</b> : « Affichage du pilier 1. HSE & Operational Risk uniquement (par défaut, pour garder la matrice lisible) » — soit <b>23 postes × 14 compétences</b>. Chaque cellule est le niveau requis (0–4), « · » signifie aucune exigence, « ◤ » marque une compétence critique, et la colonne <b>Δ</b> est « la dispersion du niveau requis entre les postes affichés (plus grand = les postes diffèrent davantage sur cette compétence) ». Filtres : Pilier, Sous-domaine (48 valeurs), Famille de rôles (13), Poste (41), Catégorie (Technique / Comportemental / Sécurité / Conformité), Niveau minimum, recherche, « Critiques uniquement ». La légende des niveaux est <b>0 aucun · 1 notions de base · 2 guidé · 3 autonome · 4 expert</b>. Le <b>tableau d’adéquation</b>, en bas, ne couvre que vos collaborateurs : Poste · Titulaires · <b>Adéquation au référentiel</b> · <b>Couverture</b> · Adéquation critique · Écarts crit. · Prêts (≥ 80 %). Le 2026-09-02 : UX/UI Designer 1 titulaire 30 %, Senior Data Engineer 1 · 50 %, Data Governance Lead 1 · 56 %, Data Platform Lead 2 · 62 %, Data Architect 1 · 64 %, Senior Data Scientist 2 · 72 % (1/2 prêts), Confirmed Soft/ML Engineer 1 · 77 %, Data Product Lead 2 · 82 % (2/2 prêts), Confirmed Data Engineer 1 · 83 % (1/1) — <b>couverture 100 % partout, 0 écart critique</b>. Lisez toujours la Couverture à côté de l’Adéquation. Bouton <b>Exporter la matrice (CSV)</b>.',
                    en: 'Two parts. The <b>matrix</b> lines roles up as columns against skills grouped by pillar → sub-domain. It deliberately opens on <b>a single pillar</b>: "Showing pillar 1. HSE & Operational Risk only (default, to keep the matrix readable)" — that is <b>23 roles × 14 skills</b>. Each cell is the required level (0–4), "·" means no requirement, "◤" marks a critical skill, and the <b>Δ</b> column is "the spread of required level across the shown roles (bigger = the roles differ more on that skill)". Filters: Pillar, Sub-domain (48 values), Role family (13), Role (41), Category (Technical / Behavioral / Safety / Compliance), Minimum level, search, "Critical only". The level legend is <b>0 none · 1 basic awareness · 2 guided · 3 autonomous · 4 expert</b>. The <b>fit table</b> below covers only your people: Role · Occupants · <b>Benchmark fit</b> · <b>Coverage</b> · Critical fit · Crit. gaps · Ready (≥ 80%). On 2026-09-02: UX/UI Designer 1 occupant 30%, Senior Data Engineer 1 · 50%, Data Governance Lead 1 · 56%, Data Platform Lead 2 · 62%, Data Architect 1 · 64%, Senior Data Scientist 2 · 72% (1/2 ready), Confirmed Soft/ML Engineer 1 · 77%, Data Product Lead 2 · 82% (2/2 ready), Confirmed Data Engineer 1 · 83% (1/1) — <b>coverage 100% everywhere, 0 critical gaps</b>. Always read Coverage next to Fit. <b>Export matrix (CSV)</b> button.',
                },
            },
            {
                icon: '🎯',
                img: null,
                imgRetired: 'mgr-35-benchmark-role-detail',
                title: {
                    fr: 'Détail d’un poste et relève (depuis le Référentiel)',
                    en: 'Role drill-through and succession (from the Benchmark)',
                },
                where: {
                    fr: 'Référentiel → cliquer un nom de poste (/benchmark/role/:id)',
                    en: 'Benchmark → click a role name (/benchmark/role/:id)',
                },
                what: {
                    fr: 'Un poste en détail. Exemple réel, <b>Data Platform Lead</b> le 2026-09-02 : <b>2 titulaires, 62 % d’adéquation au référentiel, 100 % de couverture des évaluations, « — » d’adéquation critique, 0 titulaire avec écart critique</b>. « Qui a quels écarts » croise chaque compétence requise avec chaque titulaire (« Cellule = réel (0–4) ; un anneau rouge = sous le requis ») : Norah HARTLEY 50 % et Bakary FARRELL 74 %, ligne à ligne. Puis <b>« Prêts à évoluer »</b> — les personnes du périmètre non titulaires du poste, classées par adéquation : Nadia FONTÉRA 76 % (6 écarts), Aminata BRENNAN 71 % (6), Yacine RIVERA 71 % (7), Landry PETROV 65 % (6), Ferdinand POUNDÉ 65 % (6), Mariama TANAKA 65 % (7), Idrissa MARCHÉTTI 62 % (8), Rachelle ESPOSITO 59 % (8), Clarisse OYÉRÉ 56 % (8), Thierry ABÉRNATH 53 % (9), Zoumana WALSH 53 % (8), Sékou ZANTÉ 53 % (9), Léa KESSLER 15 % (12) — chacun avec un bouton <b>Développer</b>. La page se termine par la <b>Tendance de l’adéquation</b>.',
                    en: 'One role in full. Real example, <b>Data Platform Lead</b> on 2026-09-02: <b>2 occupants, 62% benchmark fit, 100% assessment coverage, "—" critical fit, 0 occupants with a critical gap</b>. "Who has which gaps" crosses every required skill with every occupant ("Cell = actual (0–4); a red ring = below the requirement"): Norah HARTLEY 50% and Bakary FARRELL 74%, row by row. Then <b>"Ready to move up"</b> — people in scope who do not hold the role, ranked by fit: Nadia FONTÉRA 76% (6 gaps), Aminata BRENNAN 71% (6), Yacine RIVERA 71% (7), Landry PETROV 65% (6), Ferdinand POUNDÉ 65% (6), Mariama TANAKA 65% (7), Idrissa MARCHÉTTI 62% (8), Rachelle ESPOSITO 59% (8), Clarisse OYÉRÉ 56% (8), Thierry ABÉRNATH 53% (9), Zoumana WALSH 53% (8), Sékou ZANTÉ 53% (9), Léa KESSLER 15% (12) — each with a <b>Develop</b> button. The page ends with the <b>Fit trend</b>.',
                },
            },
            {
                icon: '🗂️',
                img: null,
                imgRetired: 'mgr-29-org-chart',
                title: {
                    fr: 'Organigramme — quatre vues, recherche et focus',
                    en: 'Org chart — four views, search and focus',
                },
                where: {
                    fr: 'TALENTS → Organigramme (/org-chart)',
                    en: 'TALENT → Org Chart (/org-chart)',
                },
                what: {
                    fr: 'Un arbre vivant de votre part d’organisation, en lecture seule. Sélecteur <b>VUE</b> à quatre entrées : <b>Ligne hiérarchique</b> (par défaut), <b>Manager</b>, <b>Superviseur</b>, <b>Site / Dépt / Service</b>. En ligne hiérarchique le 2026-09-02 : « <b>16 personnes · 1 équipe</b> », tête <b>Aïcha FARRELL</b> avec 15 rattachés. En vue structurelle : « 16 personnes · 1 site · structure organisationnelle » → Organisation (16) → Riverside, Site (16) → IT, Département (16). Un champ <b>« Rechercher nom, poste, unité… »</b> met en évidence et compte les résultats (recherche « FARRELL » → <b>« 2 résultat(s) »</b>, deux homonymes), un bouton <b>Focus</b> sur un nœud n’affiche que cette branche, et Déplier / Replier plus un zoom (99 %) complètent la navigation. La hiérarchie elle-même se corrige sur la fiche du collaborateur : l’organigramme ne fait que la refléter. La vue ne se choisit pas par l’URL (?view=… est ignoré) : utilisez les boutons.',
                    en: 'A live, read-only tree of your part of the organisation. A <b>VIEW</b> selector with four entries: <b>Reporting line</b> (default), <b>Manager</b>, <b>Supervisor</b>, <b>Site / Dept / Service</b>. In reporting-line view on 2026-09-02: "<b>16 people · 1 team</b>", head <b>Aïcha FARRELL</b> with 15 reports. In structural view: "16 people · 1 site · organisational structure" → Organisation (16) → Riverside, Site (16) → IT, Department (16). A <b>"Search name, role, unit…"</b> box highlights and counts matches (searching "FARRELL" → <b>"2 result(s)"</b>, two namesakes), a <b>Focus</b> button on a node shows that branch only, and Expand / Collapse plus a zoom (99%) complete the navigation. The hierarchy itself is fixed on the employee record: the chart only reflects it. The view cannot be chosen from the URL (?view=… is ignored): use the buttons.',
                },
            },
            {
                icon: '🔄',
                img: null,
                imgRetired: 'mgr-30-lifecycle',
                title: {
                    fr: 'Événements de cycle de vie (arrivée / mobilité / départ)',
                    en: 'Lifecycle events (joiner / mover / leaver)',
                },
                where: {
                    fr: 'TALENTS → Cycle de vie (/v2/lifecycle)',
                    en: 'TALENT → Lifecycle (/v2/lifecycle)',
                },
                what: {
                    fr: '« Enregistrez les événements d’arrivée / mobilité / départ de vos collaborateurs. L’arrivée inscrit le collaborateur au cycle ouvert ; le départ désactive le compte. » Le formulaire demande le collaborateur (parmi les 15) et l’événement (Arrivée / Mobilité / Départ), avec l’avertissement « Le départ désactive le compte du collaborateur — à utiliser avec précaution ». Le tableau Collaborateur · Événement · Survenu le · Traité le · Statut contient un seul enregistrement le 2026-09-02 : <b>Norah HARTLEY — Mobilité — 17 juin 2026</b>.',
                    en: '"Record joiner / mover / leaver events for your people. A joiner enrols the employee in the open cycle; a leaver deactivates the account." The form asks for the employee (from your 15) and the event (Joiner / Mover / Leaver), with the warning "A leaver deactivates the employee’s account — use with care". The Employee · Event · Occurred on · Processed on · Status table holds a single record on 2026-09-02: <b>Norah HARTLEY — Mover — 17 June 2026</b>.',
                },
            },
            {
                icon: '🧠',
                img: 'mgr-31-talent-suite',
                title: { fr: 'Suite Talent & Engagement', en: 'Talent & Engagement Suite' },
                where: {
                    fr: 'TALENTS → Suite Talents (/v2/cap)',
                    en: 'TALENT → Talent Suite (/v2/cap)',
                },
                what: {
                    fr: 'Sept blocs sur une page, tous limités à votre périmètre. <b>Copilote talent</b> : une zone de question libre (« Interrogez au sujet de vos collaborateurs ») avec des questions pré-écrites — Qui présente un risque de départ ? · Qui doit être développé en priorité ? · Préparation par site · Principaux écarts de compétences · Couverture des évaluations · PIP ouverts — et l’avertissement explicite : « Fonctionne sur site par défaut. Si votre administrateur a connecté un fournisseur d’IA externe, les données talent de votre périmètre lui sont transmises (chaque transfert est audité). » <b>Sessions de calibration</b> : « ajustez les positionnements avec une justification obligatoire (ajout seul), face à une distribution en temps réel » (colonnes Périmètre · Statut · Ajustements · Créé le ; « Aucune session »). <b>Objectifs organisationnels</b> (cascade entreprise / site / département / équipe ; « Aucun »). <b>Place de marché de mobilité interne</b> (type mission / projet / mentorat / poste ; « Aucune opportunité ouverte »). <b>Sondages d’engagement et pulse</b> (« Aucun sondage »). <b>Reconnaissance</b> (à un identifiant employé, une valeur, un message). <b>Analyses DEI</b> — « masqué en dessous de 5 par groupe » — sur les dimensions genre, origine ethnique, tranche d’âge, nationalité, avec Représentation, 9-box par groupe et Taux de PIP par groupe.',
                    en: 'Seven blocks on one page, all scoped to your people. <b>Talent copilot</b>: a free-text box ("Ask about your people") with pre-written questions — Who is a flight risk? · Who should be developed first? · Readiness by site · Top skill gaps · Assessment coverage · Open PIPs — and an explicit warning: "Runs on-premise by default. If your administrator has connected an external AI provider, the talent data in your scope is sent to it (every transfer is audited)." <b>Calibration sessions</b>: "move placements with a mandatory rationale (append-only), against a live distribution" (columns Scope · Status · Adjustments · Created; "No session"). <b>Organisational objectives</b> (company / site / department / team cascade; "None"). <b>Internal mobility marketplace</b> (gig / project / mentoring / role; "No open opportunity"). <b>Engagement and pulse surveys</b> ("No survey"). <b>Recognition</b> (to an employee id, a value, a message). <b>DEI analytics</b> — "suppressed below 5 per group" — over gender, ethnicity, age band and nationality, with Representation, 9-box by group and PIP rate by group.',
                },
            },
            {
                icon: '🔔',
                img: 'mgr-41-action-center-bell',
                title: {
                    fr: 'Centre d’actions (cloche) et notifications',
                    en: 'Action Center (bell) and notifications',
                },
                where: {
                    fr: 'Cloche 🔔 en haut à droite → « Mes actions » ; « Voir tout » ouvre /notifications',
                    en: 'The 🔔 bell, top right → "My actions"; "See all" opens /notifications',
                },
                what: {
                    fr: 'La cloche porte un compteur (<b>7</b> le 2026-09-02) et ouvre un panneau <b>« Mes actions »</b> : d’abord ce qui vous attend (« Vous êtes à jour. » ce jour-là), puis une section <b>RÉCENT</b> listant vos dernières notifications cliquables — Revues à finaliser · Auto-évaluation à soumettre · Un plan de performance vous concerne · Auto-évaluation à réviser · Un départ requiert un plan de passation — et un lien <b>Voir tout</b>. La page /notifications donne la liste horodatée complète avec « Tout marquer comme lu » ; chaque entrée est un lien profond vers l’écran concerné.',
                    en: 'The bell carries a counter (<b>7</b> on 2026-09-02) and opens a <b>"My actions"</b> panel: first what is waiting on you ("You are all caught up." that day), then a <b>RECENT</b> section listing your latest clickable notifications — Reviews to finalize · Self-assessment to submit · A performance plan concerns you · Self-assessment to review · A departure requires a handover plan — and a <b>See all</b> link. The /notifications page gives the full timestamped list with "Mark all as read"; every entry deep-links to the screen concerned.',
                },
            },
            {
                icon: '📤',
                img: null,
                title: {
                    fr: 'Exports CSV — ce que vous obtenez réellement',
                    en: 'CSV exports — what you actually get',
                },
                where: {
                    fr: 'Boutons « Exporter CSV » de /reports/readiness, /reports/gaps, /benchmark, /movements, /skill-matrix, /talent/actions',
                    en: '"Export CSV" buttons on /reports/readiness, /reports/gaps, /benchmark, /movements, /skill-matrix, /talent/actions',
                },
                what: {
                    fr: 'Quatre exports serveur, testés le 2026-09-02 avec le profil manager, tous renvoyés en <code>text/csv</code> et déjà limités à votre périmètre : <b>readiness-report.csv</b> (/reports/readiness?format=csv — 15 lignes de données ; colonnes Employee Number, First Name, Last Name, Role, Site, Department, Service, Total Required, Skills Met, Skills Not Met, Critical Skills Met, Critical Skills Total, Readiness %, Is Ready) ; <b>gap-analysis.csv</b> (/reports/gaps?format=csv — 38 lignes ; Skill Name, Domain, Required Level, Is Critical, Employees Affected, Average Gap) ; <b>benchmark-matrix.csv</b> (/benchmark?format=csv — une colonne par poste, 14 lignes pour le pilier affiché ; Pillar, Sub-Domain, Skill, Category, Variation puis les postes) ; <b>movements-AAAA-MM-JJ.csv</b> (/movements/export.csv — 195 lignes sur 365 jours ; When, Stream, Event, Employee, Number, Site, Department, From, To, Skill, <b>Actor</b>). Deux exports supplémentaires sont générés dans le navigateur, pas par le serveur : celui de la Matrice de compétences et celui des Actions talents (talent-actions-AAAA-MM-JJ.csv). <b>À savoir</b> : readiness-report.csv et gap-analysis.csv commencent par une ligne <code>sep=,</code> et utilisent la virgule ; movements-….csv utilise le <b>point-virgule</b> et n’a pas cette ligne ; aucun des quatre ne porte de BOM UTF-8 — vérifiez le séparateur et l’encodage à l’ouverture dans Excel.',
                    en: 'Four server-side exports, tested on 2026-09-02 with the manager profile, all returned as <code>text/csv</code> and already scoped to your people: <b>readiness-report.csv</b> (/reports/readiness?format=csv — 15 data rows; columns Employee Number, First Name, Last Name, Role, Site, Department, Service, Total Required, Skills Met, Skills Not Met, Critical Skills Met, Critical Skills Total, Readiness %, Is Ready); <b>gap-analysis.csv</b> (/reports/gaps?format=csv — 38 rows; Skill Name, Domain, Required Level, Is Critical, Employees Affected, Average Gap); <b>benchmark-matrix.csv</b> (/benchmark?format=csv — one column per role, 14 rows for the displayed pillar; Pillar, Sub-Domain, Skill, Category, Variation then the roles); <b>movements-YYYY-MM-DD.csv</b> (/movements/export.csv — 195 rows over 365 days; When, Stream, Event, Employee, Number, Site, Department, From, To, Skill, <b>Actor</b>). Two further exports are built in the browser rather than by the server: the Skill Matrix one and the Talent Actions one (talent-actions-YYYY-MM-DD.csv). <b>Worth knowing</b>: readiness-report.csv and gap-analysis.csv start with a <code>sep=,</code> line and use commas; movements-….csv uses <b>semicolons</b> and has no such line; none of the four carries a UTF-8 BOM — check the separator and the encoding when opening them in Excel.',
                },
            },
            {
                icon: '🔐',
                img: null,
                title: {
                    fr: 'Les limites de votre profil (testées, pas supposées)',
                    en: 'The limits of your profile (tested, not assumed)',
                },
                where: {
                    fr: 'Partout — la portée est appliquée côté serveur',
                    en: 'Everywhere — scope is enforced server-side',
                },
                what: {
                    fr: 'Votre périmètre est celui de vos rattachés directs, et il est refusé de façon visible en dehors. Tests réels du 2026-09-02 sur un collaborateur d’un autre manager (Rachid QUINN, employé 204) : la fiche <code>/employees/204</code> et sa modification <code>/employees/204/edit</code> renvoient <b>HTTP 403 « Accès refusé »</b> ; les API <code>/api/v1/employees/204/readiness</code> et <code>/api/v1/employees/204/development</code> renvoient <b>403 {"error":"forbidden"}</b> ; une écriture <code>POST /api/v1/goals</code> visant l’employé 204 renvoie également <b>403</b>. Les mêmes appels sur un de vos collaborateurs (employé 211) renvoient <b>200</b>. Les formulaires suivent la même règle : le sélecteur du Nouveau PDI ne propose que vos 15 personnes, même en forçant <code>?employeeId=204</code> dans l’URL. Vous ne pouvez ni créer un collaborateur (<code>/employees/create</code> → <b>403</b>), ni ouvrir la console LMS (<code>/v2/lms</code> → <b>403 « Requires the configure_lms permission »</b>), ni approuver une annulation ou une révision après approbation : ces décisions appartiennent à un administrateur.',
                    en: 'Your scope is your direct reports, and it is refused visibly outside them. Real tests on 2026-09-02 against another manager’s report (Rachid QUINN, employee 204): the record <code>/employees/204</code> and its edit form <code>/employees/204/edit</code> return <b>HTTP 403 "Access denied"</b>; the APIs <code>/api/v1/employees/204/readiness</code> and <code>/api/v1/employees/204/development</code> return <b>403 {"error":"forbidden"}</b>; a write, <code>POST /api/v1/goals</code> aimed at employee 204, also returns <b>403</b>. The same calls on one of your people (employee 211) return <b>200</b>. Forms follow the same rule: the New IDP selector offers only your 15 people, even when <code>?employeeId=204</code> is forced in the URL. You can neither create an employee (<code>/employees/create</code> → <b>403</b>) nor open the LMS console (<code>/v2/lms</code> → <b>403 "Requires the configure_lms permission"</b>) nor approve a cancellation or a post-approval revision: those decisions belong to an administrator.',
                },
            },
        ],
    },
    {
        id: 'manager',
        icon: '👔',
        color: '#4f46e5',
        name: { en: 'Manager', fr: 'Manager' },
        tagline: {
            en: "A manager is whoever is named in the 'manager' column of their reports (with manager type 'employee'). They hold EVERYTHING a supervisor holds, plus four powers that are theirs alone: validate a file already reviewed by the supervisor, arbitrate a disagreement, and approve / reject / archive / disclose a 9-Box placement. Their span contains their supervisors': on the test data, 16 people against 15 — the supervisor herself is one of them.",
            fr: "Le manager est la personne désignée dans la colonne « manager » de ses collaborateurs (avec un type de manager « employé »). Il possède TOUT ce que possède le superviseur, plus quatre pouvoirs qui n'appartiennent qu'à lui : valider un dossier déjà revu par le superviseur, arbitrer un désaccord, et approuver / rejeter / archiver / rendre visible un placement 9-Box. Son périmètre englobe celui de ses superviseurs : sur le jeu de test, 16 personnes contre 15 — la superviseure elle-même en fait partie.",
        },
        features: [
            {
                icon: '🖊️',
                img: 'sup-mgr-02-sa-reviews',
                title: {
                    fr: "Validation manager d'un dossier revu",
                    en: 'Manager validation of a reviewed file',
                },
                where: {
                    fr: "Point d'API POST /api/self-assessment/:id/validate — AUCUN bouton dans la console de revue à ce jour",
                    en: 'API endpoint POST /api/self-assessment/:id/validate — NO button in the review console today',
                },
                what: {
                    fr: "Réservé au manager : un superviseur reçoit 403 « Not authorized: manager/admin only ». Le dossier doit être en état Revue ou Arbitrage, sinon 409. Effet mesuré : l'auto-évaluation passe en Approuvée (les deux colonnes d'état), « approuvé par » enregistre le manager tandis que « revu par » garde le superviseur, la revue superviseur reçoit la décision « approve » et une date de décision, et le NIVEAU OFFICIEL est promu — celui du SUPERVISEUR (2), pas l'auto-évaluation (4) : la validation entérine le jugement du superviseur, elle ne le réécrit pas. Un événement « manager / validate / reviewed → approved » est ajouté à la chronologie et le collaborateur est notifié. À ce jour l'action n'est atteignable que par l'API : dans l'écran, un superviseur finalise un dossier en état Revue avec le bouton « Approuver ».",
                    en: "Manager-only: a supervisor gets 403 “Not authorized: manager/admin only”. The file must be in Reviewed or Arbitration, otherwise 409. Measured effect: the self-assessment becomes Approved (both state columns), “approved by” records the manager while “reviewed by” keeps the supervisor, the supervisor review takes decision “approve” with a decision date, and the OFFICIAL level is promoted — the SUPERVISOR's (2), not the self-rating (4): validation endorses the supervisor's judgement, it does not overwrite it. A “manager / validate / reviewed → approved” event is appended and the employee is notified. Today the action is reachable only through the API: in the screen, a supervisor finalises a Reviewed file with the “Approve” button.",
                },
            },
            {
                icon: '🧑‍⚖️',
                img: 'sup-mgr-02-sa-reviews',
                title: { fr: "Arbitrage d'un désaccord", en: 'Arbitrating a disagreement' },
                where: {
                    fr: "Point d'API POST /api/self-assessment/:id/arbitrate — AUCUN bouton dans la console de revue à ce jour",
                    en: 'API endpoint POST /api/self-assessment/:id/arbitrate — NO button in the review console today',
                },
                what: {
                    fr: "Réservé au manager (403 pour un superviseur). Sans décision, l'appel place le dossier en état ARBITRAGE : il sort de la file ordinaire et signale qu'un désaccord est instruit. Avec la décision « approve », le dossier devient Approuvé, « approuvé par » enregistre le manager et le niveau officiel est promu (mesuré : 1 → 4 lorsque aucun superviseur n'avait noté, donc l'auto-évaluation fait foi ; sinon c'est le niveau du superviseur qui l'emporte). Avec « reject », le dossier devient Rejeté. Une note d'arbitrage rejoint le fil de discussion. L'arbitrage n'est possible que depuis les états Soumise, En revue, Revue ou Arbitrage : depuis un brouillon, l'application répond 409 « Cannot arbitrate from state 'draft' » — un brouillon jamais soumis ne peut donc plus être transformé en niveau officiel.",
                    en: "Manager-only (403 for a supervisor). With no outcome, the call puts the file into ARBITRATION: it leaves the ordinary queue and flags that a disagreement is being handled. With outcome “approve” the file becomes Approved, “approved by” records the manager and the official level is promoted (measured: 1 → 4 where no supervisor had rated, so the self-rating stands; otherwise the supervisor's level wins). With “reject” the file becomes Rejected. An arbitration note joins the discussion thread. Arbitration is only possible from Submitted, Under review, Reviewed or Arbitration: from a draft the app answers 409 “Cannot arbitrate from state 'draft'” — a never-submitted draft can no longer be turned into an official level.",
                },
            },
            {
                icon: '🎲',
                img: null,
                imgRetired: 'sup-mgr-10-nine-box',
                title: {
                    fr: 'Grille 9-Box — approuver et publier',
                    en: '9-Box grid — approve and publish',
                },
                where: {
                    fr: 'Menu Talents → « Grille 9-Box » (/talent/nine-box)',
                    en: 'Talent menu → “9-Box Talent” (/talent/nine-box)',
                },
                what: {
                    fr: "C'est la seule exclusivité manager réellement cliquable. L'en-tête de la page l'énonce : « Supervisors draft; managers approve/publish. » Quatre actions refusées au superviseur en 403 et autorisées au manager : Approuver (le placement passe de « under_review » à « approved », « approuvé par » enregistre le manager, et une ligne de calibration est créée — mesuré : talent_placements 1 → 2), Rejeter, Archiver, et Rendre visible au collaborateur. L'approbation arme aussi les déclencheurs automatiques du produit (case rouge → PIP et coaching, case bleue → plan de développement). La liste des personnes est celle du périmètre du manager — 16 sur le jeu de test, une de plus que celle de la superviseure.",
                    en: "This is the only manager exclusivity that is actually clickable. The page header states it: “Supervisors draft; managers approve/publish.” Four actions refused to the supervisor with 403 and allowed for the manager: Approve (the placement moves under_review → approved, “approved by” records the manager, and a calibration row is created — measured: talent_placements 1 → 2), Reject, Archive, and Disclose to the employee. Approval also arms the product's automatic triggers (red box → PIP and coaching, blue box → development plan). The people list is the manager's span — 16 on the test data, one more than the supervisor's.",
                },
            },
            {
                icon: '🧾',
                img: 'sup-mgr-09-disputes',
                title: {
                    fr: 'Contestations : les trois niveaux',
                    en: 'Disputes: the three levels',
                },
                where: {
                    fr: 'Menu Équipe → « Contestations en cours » (/v2/slf/disputes)',
                    en: 'Team menu → “Open disputes” (/v2/slf/disputes)',
                },
                what: {
                    fr: "L'écran annonce « Open and escalated rating disputes for your team. Resolve with a final rating. » et affiche « No open disputes. » quand la file est vide. L'échelle a trois barreaux : L0 tenu par le superviseur qui a noté, L1 par le manager, L2 par les RH — un administrateur porteur de la permission « arbitrer les contestations ». Chaque barreau a son délai réglable (par défaut 5 jours en L0, 7 en L1, 7 en L2) ; à l'expiration, la contestation monte d'un cran automatiquement, et le manager est prévenu à l'entrée en L1. Une résolution sans note est refusée en 400 « A resolution note is required. » ; une contestation déjà traitée renvoie 409. À noter : la garde de ces écrans porte sur « gouverne au moins une personne », donc un superviseur atteint aussi L0 et L1 sur SES collaborateurs — l'échelle n'est pas entièrement réservée au manager.",
                    en: 'The screen reads “Open and escalated rating disputes for your team. Resolve with a final rating.” and shows “No open disputes.” when the queue is empty. The ladder has three rungs: L0 held by the supervisor who rated, L1 by the manager, L2 by HR — an administrator holding the “arbitrate disputes” permission. Each rung has a tunable SLA (5 days at L0, 7 at L1, 7 at L2 by default); on expiry the dispute climbs one rung automatically and the manager is notified on entering L1. Resolving with no note is refused with 400 “A resolution note is required.”; an already-handled dispute returns 409. Note: the guard on these screens is “governs at least one person”, so a supervisor also reaches L0 and L1 for THEIR reports — the ladder is not wholly manager-reserved.',
                },
            },
            {
                icon: '⏳',
                img: 'sup-mgr-09-disputes',
                title: {
                    fr: 'Clôture automatique en L2 après expiration',
                    en: 'Automatic L2 close-out on expiry',
                },
                where: {
                    fr: 'Traitement planifié, visible dans /v2/slf/disputes et dans le dossier du collaborateur',
                    en: 'Scheduled job, visible in /v2/slf/disputes and in the employee file',
                },
                what: {
                    fr: "Si les RH ne tranchent pas dans le délai L2, la contestation est clôturée automatiquement AVEC LA NOTE DU SUPERVISEUR, pour qu'une campagne ne puisse pas se bloquer sur un désaccord. Exécuté et mesuré : l'état passe à « auto_finalized », la note retenue est inscrite comme note décidée, la revue superviseur passe à « completed », le NIVEAU OFFICIEL est mis à jour avec la mention « Set by dispute resolution (final decided rating). » — mesuré 4 → 1 — et la ligne d'auto-évaluation passe de « provisoire » à « finalisée ». Le collaborateur reçoit une notification : sa note contestée est devenue officielle sans décision RH. Ce comportement est gouverné par le réglage « clôture automatique à expiration » : désactivé, rien n'est clôturé et la contestation reste ouverte.",
                    en: "If HR does not decide within the L2 SLA, the dispute is auto-finalised WITH THE SUPERVISOR'S RATING, so a campaign cannot deadlock on a disagreement. Executed and measured: state becomes “auto_finalized”, the retained rating is written as the decided rating, the supervisor review becomes “completed”, the OFFICIAL level is updated with the note “Set by dispute resolution (final decided rating).” — measured 4 → 1 — and the self-assessment row moves from provisional to finalized. The employee is notified: their contested rating became official with no HR decision. The behaviour is governed by the “auto-finalize on expiry” setting: turned off, nothing is finalised and the dispute stays open.",
                },
            },
            {
                icon: '👥',
                img: 'sup-mgr-01-dashboard',
                title: {
                    fr: 'Un périmètre plus large que celui du superviseur',
                    en: 'A wider span than the supervisor’s',
                },
                where: {
                    fr: 'Tableau de bord (/dashboard), Employés (/employees), Continuité (/v2/continuity)',
                    en: 'Dashboard (/dashboard), Employees (/employees), Continuity (/v2/continuity)',
                },
                what: {
                    fr: 'Le manager voit toute la chaîne sous lui, superviseurs compris. Mesuré côte à côte : /employees affiche « 16 employees » pour le manager contre « 15 employees » pour la superviseure ; le tableau de bord annonce 8/16 personnes prêtes pour leur poste et 195 exigences évaluées sur 195 (proficience moyenne 73,4 %) contre 7/15 et 189 sur 189 (71,7 %) ; la Continuité liste 12 rôles à noter contre 11. Le menu, lui, est RIGOUREUSEMENT IDENTIQUE (39 entrées) : la différence ne se voit que dans le contenu des écrans et dans le résultat des actions.',
                    en: 'The manager sees the whole chain below them, supervisors included. Measured side by side: /employees shows “16 employees” for the manager against “15 employees” for the supervisor; the dashboard reads 8/16 role-ready and 195 of 195 requirements assessed (73.4 % average proficiency) against 7/15 and 189 of 189 (71.7 %); Continuity lists 12 roles to score against 11. The menu itself is STRICTLY IDENTICAL (39 entries): the difference shows only in screen content and in what the actions do.',
                },
            },
        ],
    },
    {
        id: 'localadmin',
        icon: '🛡️',
        color: '#7c3aed',
        name: { en: 'Local Admin / Viewer', fr: 'Administrateur local / Lecteur' },
        tagline: {
            en: 'You administer a perimeter. Capability and scope are granted separately — and you need both.',
            fr: 'Vous administrez un périmètre. Capacité et périmètre s’accordent séparément — et il faut les deux.',
        },
        features: [
            {
                icon: '🔑',
                img: 'la-26-mon-acces',
                title: {
                    fr: 'Ce que vous pouvez faire = vos capacités accordées × votre périmètre',
                    en: 'What you can do = your granted capabilities × your scope',
                },
                where: {
                    fr: '<b>Mon accès</b> (/mon-acces) — la page qui répond à la question ; les capacités elles-mêmes sont accordées par un super-administrateur sur votre fiche (/admins)',
                    en: '<b>My access</b> (/mon-acces) — the page that answers the question; the capabilities themselves are granted by a super admin on your record (/admins)',
                },
                what: {
                    fr: 'Deux verrous indépendants, et il faut les deux. La <b>capacité</b> dit ce que vous savez faire ; le <b>périmètre</b> dit sur qui. La page « Mon accès » les affiche côte à côte : pour le compte observé, <code>LocalAdmin · <b>41 collaborateurs couverts</b> · <b>21/31 capacités</b> · SITE : Riverside, sans expiration</code>, puis <b>le catalogue complet des 31 capacités</b> avec le statut GRANTED / NOT GRANTED de chacune et sa description — « Anything greyed out is not granted to you — ask an administrator for it if your work requires it ». Le compte observé détenait notamment <i>Manage employees (full)</i>, <i>Manage skill assessments</i>, <i>Manage assessment cycles</i>, <i>Manage onboarding</i>, <i>Manage organization</i>, <i>Manage domains & skills</i>, <i>View roles</i>, <i>View settings</i>, <i>Export data</i>, <i>Import / provision data</i>, <i>View system logs</i>, <i>Arbitrate disputes</i>, <i>Configure LMS</i>, la continuité et la passation ; et il ne détenait <b>pas</b> <i>Approve skill assessments</i>, <i>Manage talent reviews</i>, <i>Manage roles</i>, <i>Manage settings</i>, <i>Manage local admins</i>, <i>Manage surveys</i>, <i>Manage mobility</i>, <i>Override risk-of-loss</i>, ni les deux capacités de conformité. Chaque domaine de configuration est <b>scindé lecture / écriture</b> : on peut recevoir <i>View settings</i> sans <i>Manage settings</i>, et la page des Paramètres s’ouvre alors avec le bandeau « <b>View-only access — you can browse this page but editing requires additional permissions.</b> »',
                    en: 'Two independent locks, and you need both. The <b>capability</b> says what you can do; the <b>scope</b> says on whom. The "My access" page shows them side by side: for the observed account, <code>LocalAdmin · <b>41 employees covered</b> · <b>21/31 capabilities</b> · SITE: Riverside, no expiry</code>, then <b>the full 31-capability catalogue</b> with each entry marked GRANTED / NOT GRANTED and described — "Anything greyed out is not granted to you — ask an administrator for it if your work requires it". The observed account held <i>Manage employees (full)</i>, <i>Manage skill assessments</i>, <i>Manage assessment cycles</i>, <i>Manage onboarding</i>, <i>Manage organization</i>, <i>Manage domains & skills</i>, <i>View roles</i>, <i>View settings</i>, <i>Export data</i>, <i>Import / provision data</i>, <i>View system logs</i>, <i>Arbitrate disputes</i>, <i>Configure LMS</i>, continuity and handover; it did <b>not</b> hold <i>Approve skill assessments</i>, <i>Manage talent reviews</i>, <i>Manage roles</i>, <i>Manage settings</i>, <i>Manage local admins</i>, <i>Manage surveys</i>, <i>Manage mobility</i>, <i>Override risk-of-loss</i>, nor either compliance capability. Every configuration area is <b>split read / write</b>: you can receive <i>View settings</i> without <i>Manage settings</i>, and the Settings page then opens with the banner "<b>View-only access — you can browse this page but editing requires additional permissions.</b>"',
                },
            },
            {
                icon: '📈',
                img: 'la-01-dashboard',
                title: {
                    fr: 'Votre tableau de bord — les mêmes analyses, recalculées sur votre périmètre',
                    en: 'Your dashboard — the same analytics, recomputed on your scope',
                },
                where: { fr: 'Tableau de bord (accueil)', en: 'Dashboard (home)' },
                what: {
                    fr: 'Ce n’est pas le tableau de bord de l’organisation filtré à l’affichage : les chiffres sont <b>recalculés</b> sur votre population. Pour le périmètre <i>Site : Riverside</i> : <b>Score de santé 74 — Modéré</b> (contre 80 org-wide), <b>81,7 % de maîtrise</b> « over the 972 of 1,824 requirements assessed (53,3 %) », <b>25 / 36 prêts au poste</b> « of 36 employees measured », <b>852 exigences jamais évaluées</b>, <b>21 postes à risque</b>. Le sélecteur de site ne propose <b>qu’Riverside</b> et le sélecteur de service ne liste que les services du site. Les cinq priorités de formation sont celles d’Riverside, pas celles du groupe. Une phrase honnête accompagne la courbe quand l’historique manque : « <b>No recorded history for this scope</b> (snapshots exist per site and org-wide) » — l’absence d’historique est dite, pas arrondie à zéro.',
                    en: 'This is not the org dashboard filtered at display time: the figures are <b>recomputed</b> on your population. For the <i>Site: Riverside</i> scope: <b>Health score 74 — Modéré</b> (against 80 org-wide), <b>81.7 % proficiency</b> "over the 972 of 1,824 requirements assessed (53.3 %)", <b>25 / 36 role-ready</b> "of 36 employees measured", <b>852 requirements never assessed</b>, <b>21 roles at risk</b>. The site selector offers <b>Riverside only</b> and the service selector lists only that site\'s services. The top-five training priorities are Riverside\'s, not the group\'s. An honest sentence accompanies the trend chart when history is missing: "<b>No recorded history for this scope</b> (snapshots exist per site and org-wide)".',
                },
            },
            {
                icon: '👥',
                img: null,
                imgRetired: 'la-02-employees',
                title: {
                    fr: 'Vos collaborateurs — 41 personnes, et 403 sur toutes les autres',
                    en: 'Your people — 41 employees, and 403 on everybody else',
                },
                where: { fr: 'Collaborateurs (/employees)', en: 'Employees (/employees)' },
                what: {
                    fr: 'La liste s’ouvre sur <b>« 41 employees »</b>, tous à Riverside, et le filtre Site ne propose que <b>Riverside</b>. Le filtre de statut fonctionne comme pour le super-administrateur : <b>Tous</b> porte le total à <b>42</b> avec la fiche sortie <code>ERASED-90010</code> badgée <b>LEFT</b>. Ouvrir une fiche du périmètre donne <b>200</b> ; ouvrir une fiche d’un autre site donne <b>403</b>, avec une page qui ne laisse pas d’ambiguïté : « <b>Outside your scope</b> — This employee does not belong to the site, department or service assigned to you. <b>Nothing is missing from your capabilities: it is the scope.</b> » L’organigramme, la matrice, la campagne et le rapport de préparation racontent la même population : <b>41 personnes · 4 équipes · 3 non rattachées</b> pour l’organigramme, <b>42 fiches / 25 READY / 17 NOT READY / 60 %</b> pour le rapport.',
                    en: 'The list opens on <b>"41 employees"</b>, all in Riverside, and the Site filter offers <b>Riverside</b> only. The status filter behaves as for the super admin: <b>All</b> brings the total to <b>42</b> with the leaver <code>ERASED-90010</code> badged <b>LEFT</b>. Opening an in-scope record gives <b>200</b>; opening a record on another site gives <b>403</b>, with a page that leaves no ambiguity: "<b>Outside your scope</b> — This employee does not belong to the site, department or service assigned to you. <b>Nothing is missing from your capabilities: it is the scope.</b>" The org chart, matrix, campaign and readiness report tell the same population: <b>41 people · 4 teams · 3 unassigned</b> for the chart, <b>42 records / 25 READY / 17 NOT READY / 60 %</b> for the report.',
                },
            },
            {
                icon: '🏢',
                img: 'la-15-app-settings',
                title: {
                    fr: 'Configuration & données — ce que vous voyez, ce que vous pouvez écrire',
                    en: 'Configuration & data — what you see, what you may write',
                },
                where: {
                    fr: 'Blocs <b>Configuration</b> et <b>Outils</b> du menu de gauche : Organisation, Domaines & compétences, Postes, Paramètres, Gestion des données',
                    en: '<b>Configuration</b> and <b>Tools</b> blocks of the left menu: Organization, Domains & Skills, Roles, Settings, Data Management',
                },
                what: {
                    fr: 'Un menu absent signifie une capacité non accordée. Pour le compte observé, les cinq écrans s’ouvrent en <b>200</b> mais ne se comportent pas pareil. <b>Organisation</b> : un seul site, <i>Riverside · 41 PERSON(S) ATTACHED</i>, modifiable (capacité <code>manage_organization</code>). <b>Domaines & compétences</b> : accessible et modifiable (<code>manage_domains_skills</code>) — le référentiel n’a pas de périmètre, il est commun. <b>Postes</b> : consultable seulement (<code>view_roles</code> sans <code>manage_roles</code>) ; <code>POST /roles</code> répond <b>403</b>. <b>Paramètres</b> : ouverts avec le bandeau « <b>View-only access</b> » ; <code>POST /app-settings</code> répond <b>403</b>. <b>Gestion des données</b> : exports, modèles et imports disponibles (<code>export_data</code>, <code>import_data</code>) — mais la <b>console SQL</b> et la <b>réinitialisation de la base</b> restent hors d’atteinte : <code>/data-management/sql-console</code> renvoie <b>302 vers /dashboard</b>. Ce que le compte n’avait pas : <b>Conformité</b> (403 — <i>view_compliance</i>), <b>Administrateurs</b> (403 — <i>manage_admins</i>), <b>Revue d’accès</b>, <b>Clés API</b>, <b>Licence</b>, <b>Sessions</b> et <b>SSO</b> (302, réservés au super-administrateur).',
                    en: 'A missing menu means a capability that was not granted. For the observed account all five screens open <b>200</b> but do not behave the same. <b>Organization</b>: one site, <i>Riverside · 41 PERSON(S) ATTACHED</i>, editable (<code>manage_organization</code>). <b>Domains & Skills</b>: reachable and editable (<code>manage_domains_skills</code>) — the framework has no scope, it is shared. <b>Roles</b>: read-only (<code>view_roles</code> without <code>manage_roles</code>); <code>POST /roles</code> answers <b>403</b>. <b>Settings</b>: open with the "<b>View-only access</b>" banner; <code>POST /app-settings</code> answers <b>403</b>. <b>Data Management</b>: exports, templates and imports available (<code>export_data</code>, <code>import_data</code>) — but the <b>SQL console</b> and the <b>database reset</b> stay out of reach: <code>/data-management/sql-console</code> answers <b>302 to /dashboard</b>. What the account did not have: <b>Compliance</b> (403 — <i>view_compliance</i>), <b>Admins</b> (403 — <i>manage_admins</i>), <b>Access Review</b>, <b>API Keys</b>, <b>License</b>, <b>Sessions</b> and <b>SSO</b> (302, super-admin only).',
                },
            },
            {
                icon: '📜',
                img: 'la-16-system-logs',
                title: {
                    fr: 'Journaux système — délégables, et déjà limités à votre périmètre',
                    en: 'System Logs — delegable, and already limited to your scope',
                },
                where: {
                    fr: 'Administration → Journaux système (/system-logs) — capacité <code>view_system_logs</code>',
                    en: 'Administration → System Logs (/system-logs) — <code>view_system_logs</code> capability',
                },
                what: {
                    fr: 'La même page que pour le super-administrateur, avec les mêmes filtres et les mêmes exports — mais pas le même contenu : <b>158 entrées</b> pour le compte observé contre <b>4 895</b> pour le super-administrateur. Accorder la lecture des journaux ne revient donc pas à ouvrir tout l’audit de l’organisation. Vos propres refus y figurent, ce qui rend la frontière lisible : <code>test.local — ACCESS_DENIED — 403 — GET /admins</code>.',
                    en: "The same page as for the super admin, with the same filters and exports — but not the same content: <b>158 entries</b> for the observed account against <b>4,895</b> for the super admin. Granting log reading is therefore not the same as opening the whole organisation's audit. Your own refusals appear there, which makes the boundary legible: <code>test.local — ACCESS_DENIED — 403 — GET /admins</code>.",
                },
            },
            {
                icon: '👁️',
                img: 'viewer-18-mon-acces',
                title: {
                    fr: 'Lecteur — un rôle en lecture seule, qui ne voit rien tant qu’on ne lui donne pas de périmètre',
                    en: 'Viewer — a read-only role that sees nothing until it is given a scope',
                },
                where: { fr: 'Mon accès (/mon-acces)', en: 'My access (/mon-acces)' },
                what: {
                    fr: 'Le compte observé affiche <code>Viewer · <b>0 collaborateur couvert</b> · <b>0/31 capacités</b></code> et, sous « Mon périmètre », un encadré <b>NO SCOPE</b> : « <b>No scope is assigned to you, so you see no employees at all.</b> Ask an administrator to assign you a country, site, department or service. » Un lecteur n’est donc pas « quelqu’un qui voit tout sans pouvoir écrire » : c’est un rôle qui n’écrit jamais <b>et</b> qui ne voit que le périmètre qu’on lui attribue. Le catalogue des 31 capacités s’affiche intégralement, toutes marquées <b>NOT GRANTED</b> — ce qui en fait le meilleur écran pour comprendre ce qu’il faudrait accorder.',
                    en: 'The observed account reads <code>Viewer · <b>0 employees covered</b> · <b>0/31 capabilities</b></code> and, under "My scope", a <b>NO SCOPE</b> panel: "<b>No scope is assigned to you, so you see no employees at all.</b> Ask an administrator to assign you a country, site, department or service." A viewer is therefore not "someone who sees everything but cannot write": it is a role that never writes <b>and</b> only sees the scope it is given. The 31-capability catalogue is displayed in full, every entry marked <b>NOT GRANTED</b> — which makes this the best screen for deciding what to grant.',
                },
            },
            {
                icon: '🚫',
                img: 'viewer-02-employees-403',
                title: {
                    fr: 'Ce qu’un lecteur ne peut pas ouvrir — et le message qu’il obtient',
                    en: 'What a viewer cannot open — and the message they get',
                },
                where: { fr: 'N’importe quel écran non accordé', en: 'Any screen not granted' },
                what: {
                    fr: 'Statuts réellement observés pour un lecteur sans habilitation : <b>403</b> sur Collaborateurs, une fiche collaborateur, la modification d’une fiche, Domaines & compétences, Postes, Campagnes, Administrateurs, Paramètres, Journaux système, Gestion des données, Conformité, Onboarding, Délégation et Invitations ; <b>302 vers /dashboard</b> sur Revue d’accès, Clés API, Licence, Sessions, SSO et Console SQL. La page de refus nomme la capacité manquante, la décrit, et indique qui peut l’accorder — par exemple : « <b>Missing capability — View employees</b> <code>view_employees</code> · Browse the employee directory and open an employee record… <b>Qui peut vous l’accorder</b> : le nom affiché des super-administrateurs réellement joignables — jamais un identifiant de démonstration, jamais une adresse e-mail ». Côté écriture, tout est refusé sans exception : <code>POST /organization/sites</code>, <code>POST /skills</code>, <code>POST /roles</code>, <code>POST /app-settings</code>, <code>POST /employees/create</code> répondent tous <b>403</b>.',
                    en: 'Statuses actually observed for a viewer with no grants: <b>403</b> on Employees, an employee record, editing a record, Domains & Skills, Roles, Campaigns, Admins, Settings, System Logs, Data Management, Compliance, Onboarding, Delegation and Invitations; <b>302 to /dashboard</b> on Access Review, API Keys, License, Sessions, SSO and the SQL Console. The refusal page names the missing capability, describes it, and says who can grant it — e.g. "<b>Missing capability — View employees</b> <code>view_employees</code> … <b>Who can grant it</b>: the display names of the SuperAdmins who can actually be reached — never a demo login, never an e-mail address". On the write side nothing gets through: <code>POST /organization/sites</code>, <code>POST /skills</code>, <code>POST /roles</code>, <code>POST /app-settings</code>, <code>POST /employees/create</code> all answer <b>403</b>.',
                },
            },
            {
                icon: '⚠️',
                img: 'viewer-01-dashboard',
                title: {
                    fr: 'Lire un écran de lecteur sans périmètre : des zéros de portée, pas des zéros de performance',
                    en: 'Reading a scope-less viewer screen: zeros of scope, not zeros of performance',
                },
                where: {
                    fr: 'Tableau de bord, Matrice de compétences, Organisation, Rapports — les écrans qui restent ouverts au lecteur',
                    en: 'Dashboard, Skill Matrix, Organization, Reports — the screens that stay open to a viewer',
                },
                what: {
                    fr: 'Les écrans autorisés s’ouvrent, mais sur une population vide. Relevé : tableau de bord <b>Score 40 — À risque</b> avec « <b>0 / 0 prêts au poste</b> of 0 employees measured » et une maîtrise moyenne à « — » ; matrice <b>Total Employees 0 · Total Skills 1126 · Ready Employees 0</b> ; rapport de préparation <b>0 / 0 / 0 / 0 %</b> ; Organisation <b>« No sites found »</b>. <b>Ces zéros décrivent le périmètre, pas l’organisation.</b> Le référentiel, lui, reste visible : le Benchmark affiche les 6 piliers, les 49 sous-domaines, les 13 familles de rôles et les 41 postes, parce que c’est une donnée de référence et non une donnée de personnes. Un lecteur à qui l’on veut faire lire des chiffres doit recevoir un <b>périmètre</b> ; sans lui, le tableau de bord n’est pas faux, il est vide.',
                    en: 'The permitted screens open, but on an empty population. Observed: dashboard <b>Score 40 — À risque</b> with "<b>0 / 0 role-ready</b> of 0 employees measured" and average proficiency at "—"; matrix <b>Total Employees 0 · Total Skills 1126 · Ready Employees 0</b>; readiness report <b>0 / 0 / 0 / 0 %</b>; Organization <b>"No sites found"</b>. <b>These zeros describe the scope, not the organisation.</b> The framework itself stays visible: Benchmark shows the 6 pillars, 49 sub-domains, 13 role families and 41 roles, because that is reference data, not people data. A viewer who is meant to read numbers must be given a <b>scope</b>; without one the dashboard is not wrong, it is empty.',
                },
            },
        ],
    },
    {
        id: 'superadmin',
        icon: '⚙️',
        color: '#15803d',
        name: { en: 'Super Admin', fr: 'Super administrateur' },
        tagline: {
            en: 'Set up the framework, run campaigns, delegate access with an expiry, and keep the numbers honest.',
            fr: 'Configurez le référentiel, lancez les campagnes, déléguez l’accès avec une échéance, et gardez les chiffres honnêtes.',
        },
        features: [
            {
                icon: '📊',
                img: 'sa-01-dashboard',
                title: {
                    fr: 'Tableau de bord exécutif — lire le score AVEC sa couverture',
                    en: 'Executive dashboard — read the score WITH its coverage',
                },
                where: {
                    fr: 'Tableau de bord (accueil) · onglets Executive Overview / Training Priorities / Talent Development / Capability Map / Comparator',
                    en: 'Dashboard (home) · tabs Executive Overview / Training Priorities / Talent Development / Capability Map / Comparator',
                },
                what: {
                    fr: 'La page rapporte toujours un chiffre ET la mesure sur laquelle il repose. Sur cette instance : <b>Score de santé 80 — Sain</b>, <b>82,1 % de maîtrise moyenne</b> « sur les 2 474 des 3 327 exigences évaluées (74,4 %) », <b>48 / 72 prêts au poste</b> « of 72 employees measured », <b>853 exigences jamais évaluées</b>. L’encadré <b>HOW TO READ THIS</b> le dit explicitement : « The 853 never assessed are a blind spot, not a level 0 ». Un filtre Site / Département / Service en tête re-calcule tout l’onglet ; le bandeau SCOPE rappelle la population retenue. Les cartes Compliance et Campaign affichent « — » et « No open campaign » quand il n’y a rien à mesurer, jamais 0 %.',
                    en: 'The page always reports a figure AND the measurement it rests on. On this instance: <b>Health score 80 — Sain</b>, <b>82.1 % average proficiency</b> "over the 2,474 of 3,327 requirements assessed (74.4 %)", <b>48 / 72 role-ready</b> "of 72 employees measured", <b>853 requirements never assessed</b>. The <b>HOW TO READ THIS</b> panel states it: "The 853 never assessed are a blind spot, not a level 0". A Site / Department / Service filter re-scopes the whole tab; the SCOPE banner names the population. The Compliance and Campaign cards show "—" and "No open campaign" when there is nothing to measure — never 0 %.',
                },
            },
            {
                icon: '🎯',
                img: null,
                imgRetired: 'sa-21-reports-readiness',
                title: {
                    fr: 'Score de préparation vs VERDICT « prêt au poste » — deux nombres différents',
                    en: 'Readiness SCORE vs role-ready VERDICT — two different numbers',
                },
                where: {
                    fr: 'Rapports → Préparation (/reports/readiness) · le même verdict alimente la carte « prêts au poste » du tableau de bord',
                    en: 'Reports → Readiness (/reports/readiness) · the same verdict feeds the dashboard "role-ready" card',
                },
                what: {
                    fr: 'La colonne <b>READINESS %</b> est un <b>score</b> : les points obtenus rapportés aux seules exigences <b>réellement évaluées</b>. Quand rien n’a été évalué elle affiche <b>« Not measured »</b> — jamais 0 %. La colonne <b>STATUS</b> est un <b>verdict</b> : READY exige que la préparation calculée sur <b>TOUTES</b> les exigences (chaque exigence non évaluée comptant pour 0) atteigne le seuil de <b>80 %</b> ET que <b>toutes les compétences critiques</b> soient satisfaites. D’où des lignes qui surprennent et sont pourtant justes : <b>ERASED-90010 — 100 % — 2 / 13 — NOT READY</b> (100 % des deux compétences mesurées, 11 jamais mesurées) ; <b>Bintou NORDIN — 91 % — 43 / 63 — NOT READY</b> ; <b>Joseph DAHLÉN — Not measured — 0 / 152 — NOT READY</b>. Total observé : <b>78 collaborateurs, 48 READY, 30 NOT READY, 62 %</b> — les 48 sont exactement les 48 de la carte « 48 / 72 » du tableau de bord ; seul le dénominateur change (78 fiches contre 72 personnes mesurées).',
                    en: 'The <b>READINESS %</b> column is a <b>score</b>: points earned over the requirements that were <b>actually assessed</b>. When nothing was assessed it reads <b>"Not measured"</b> — never 0 %. The <b>STATUS</b> column is a <b>verdict</b>: READY requires readiness over <b>ALL</b> requirements (every unassessed one counted as a 0) to reach the <b>80 %</b> threshold AND every <b>critical skill</b> to be met. Hence rows that look odd and are right: <b>ERASED-90010 — 100 % — 2 / 13 — NOT READY</b> (100 % of the two skills measured, 11 never measured); <b>Bintou NORDIN — 91 % — 43 / 63 — NOT READY</b>; <b>Joseph DAHLÉN — Not measured — 0 / 152 — NOT READY</b>. Observed totals: <b>78 employees, 48 READY, 30 NOT READY, 62 %</b> — the same 48 as the dashboard\'s "48 / 72" card; only the denominator differs (78 records vs 72 measured people).',
                },
            },
            {
                icon: '👥',
                img: null,
                imgRetired: 'sa-02-employees',
                title: {
                    fr: 'Annuaire et filtre de statut : Actifs / Sortis / Tous',
                    en: 'Directory and the status filter: Active / Leavers / All',
                },
                where: {
                    fr: 'Collaborateurs (menu de gauche) → le sélecteur « Statut du compte » à côté du filtre Site',
                    en: 'Employees (left menu) → the "Account status" selector next to the Site filter',
                },
                what: {
                    fr: 'La liste s’ouvre sur <b>Actifs</b> : <b>77 collaborateurs</b>. Le sélecteur offre trois valeurs — <b>Actifs</b> / <b>Sortis (désactivés)</b> / <b>Tous</b>. En <b>Sortis</b> : <b>1 employee</b>, la fiche <code>ERASED-90010 · Erased 90010</code> portant le badge <b>LEFT</b>. En <b>Tous</b> : <b>78 collaborateurs</b>, la ligne sortie apparaissant en tête, atténuée et badgée. C’est le seul chemin d’interface vers une fiche désactivée — sans lui, un compte à réactiver serait inatteignable. Un sortant reste <b>exclu de la matrice de compétences</b> (77 personnes, pas 78) tout en restant compté par le rapport de préparation (78) et par les statistiques de Gestion des données (« TOTAL EMPLOYEES 78 »).',
                    en: 'The list opens on <b>Active</b>: <b>77 employees</b>. The selector offers three values — <b>Active</b> / <b>Leavers (deactivated)</b> / <b>All</b>. On <b>Leavers</b>: <b>1 employee</b>, record <code>ERASED-90010 · Erased 90010</code> carrying the <b>LEFT</b> badge. On <b>All</b>: <b>78 employees</b>, the leaver first, muted and badged. This is the only UI route to a deactivated record — without it an account awaiting reactivation would be unreachable. A leaver stays <b>excluded from the skill matrix</b> (77 people, not 78) while still being counted by the readiness report (78) and by the Data Management statistics ("TOTAL EMPLOYEES 78").',
                },
            },
            {
                icon: '🛡️',
                img: null,
                imgRetired: 'sa-12-admins',
                title: {
                    fr: 'Administrateurs — déléguer une capacité DANS un périmètre',
                    en: 'Admins — delegate a capability WITHIN a scope',
                },
                where: {
                    fr: 'Administration → Administrateurs (/admins) · Créer : /admins/create',
                    en: 'Administration → Admins (/admins) · Create: /admins/create',
                },
                what: {
                    fr: 'La console compte, sur cette instance, <b>20 comptes</b> : <b>10 sans capacité</b>, <b>1 sans périmètre</b>, <b>0 expirant sous 30 j</b>, <b>7 désactivés</b>. Un bandeau alerte en tête : « <b>9 account(s) have a perimeter but no capability — they cannot do anything.</b> » Chaque ligne affiche l’état d’accès, le périmètre et le nombre de capacités : <code>test.local — LocalAdmin — Custom — 18 capabilities — Site : Riverside</code>, <code>test.viewer — Viewer — Custom — 0 capability — No perimeter</code>. Un accès délégué a une <b>durée</b> : le formulaire de création propose « Jusqu’au » (par défaut <b>12 mois</b>) ou « Accès permanent — sans date de fin, à réserver aux comptes de gouvernance ». Le mot de passe y est annoncé « au moins 12 caractères avec majuscule, minuscule, chiffre et caractère spécial ».',
                    en: 'On this instance the console shows <b>20 accounts</b>: <b>10 with no capability</b>, <b>1 with no perimeter</b>, <b>0 expiring in 30 days</b>, <b>7 deactivated</b>. A banner leads: "<b>9 account(s) have a perimeter but no capability — they cannot do anything.</b>" Each row shows access state, perimeter and capability count: <code>test.local — LocalAdmin — Custom — 18 capabilities — Site: Riverside</code>, <code>test.viewer — Viewer — Custom — 0 capability — No perimeter</code>. Delegated access has a <b>duration</b>: the create form offers "Until" (default <b>12 months</b>) or "Permanent access — no end date, reserve this for governance accounts". The password field announces "at least 12 characters with uppercase, lowercase, number, and special character".',
                },
            },
            {
                icon: '🔑',
                img: 'sa-47-mon-acces',
                title: {
                    fr: 'Mon accès — le catalogue de 31 capacités, et ce que chacun détient',
                    en: 'My access — the 31-capability catalogue and what each account holds',
                },
                where: {
                    fr: 'Mon accès (/mon-acces) · le lien « View my access » figure aussi sur chaque page de refus',
                    en: 'My access (/mon-acces) · a "View my access" link also sits on every refusal page',
                },
                what: {
                    fr: 'Une page par compte, qui ne montre jamais que le sien. Elle affiche le rôle, le nombre de <b>collaborateurs couverts</b>, le compteur <b>capacités détenues / 31</b>, le périmètre ligne par ligne avec son expiration, puis <b>le catalogue complet</b> avec le statut GRANTED / NOT GRANTED de chacune. Relevé : <code>test.super — SuperAdmin — 77 collaborateurs — 31/31 — ORGANIZATION-WIDE</code> ; <code>test.local — LocalAdmin — 41 collaborateurs — 21/31 — SITE : Riverside, sans expiration</code> ; <code>test.viewer — Viewer — 0 collaborateur — 0/31 — NO SCOPE</code> (« No scope is assigned to you, so you see no employees at all »). Les 31 capacités se répartissent en 6 domaines : people_assessments (9), configuration (7), data (2), governance (4), continuity_learning (7), operational_compliance (2). Chaque domaine de configuration est <b>scindé lecture / écriture</b> (view_roles vs manage_roles, view_app_settings vs manage_app_settings) : on peut donner la consultation sans le pouvoir de modifier.',
                    en: 'One page per account that only ever shows its own. It gives the role, the number of <b>employees covered</b>, a <b>capabilities held / 31</b> counter, the scope line by line with its expiry, then <b>the full catalogue</b> with each entry marked GRANTED / NOT GRANTED. Observed: <code>test.super — SuperAdmin — 77 employees — 31/31 — ORGANIZATION-WIDE</code>; <code>test.local — LocalAdmin — 41 employees — 21/31 — SITE: Riverside, no expiry</code>; <code>test.viewer — Viewer — 0 employees — 0/31 — NO SCOPE</code> ("No scope is assigned to you, so you see no employees at all"). The 31 split across 6 areas: people_assessments (9), configuration (7), data (2), governance (4), continuity_learning (7), operational_compliance (2). Every configuration area is <b>split read / write</b> (view_roles vs manage_roles, view_app_settings vs manage_app_settings): you can grant reading without granting change.',
                },
            },
            {
                icon: '🔍',
                img: null,
                imgRetired: 'sa-13-access-review',
                title: {
                    fr: 'Revue d’accès — recertifier les comptes privilégiés',
                    en: 'Access Review — recertify privileged accounts',
                },
                where: {
                    fr: 'Administration → Revue d’accès (/admin/access-review) — super-administrateur uniquement',
                    en: 'Administration → Access Review (/admin/access-review) — super admin only',
                },
                what: {
                    fr: 'Un tableau de tous les comptes d’administration avec, par ligne, le rôle, le profil d’accès, le périmètre, les permissions, l’expiration, l’état <b>MFA</b>, la <b>dernière activité</b> et les <b>exceptions</b> détectées. Les compteurs relevés : <b>20 comptes</b>, <b>4 super-admins</b>, <b>9 périmètres sans capacité</b>, <b>13 sans MFA</b>, <b>0 expirant sous 30 j</b>, <b>2 dormants (90 j)</b>, <b>7 inactifs</b>. Les exceptions sont nommées en clair sur la ligne : « Perimeter without capability », « No MFA », « Dormant account ». Deux actions par ligne : <b>Attest</b> (l’attestation est écrite dans le journal d’audit inviolable) et <b>Manage</b>. Un <b>Export CSV</b> sort la revue complète.',
                    en: 'A table of every admin account with, per row, role, access profile, scope, permissions, expiry, <b>MFA</b> state, <b>last activity</b> and detected <b>exceptions</b>. Observed counters: <b>20 accounts</b>, <b>4 super-admins</b>, <b>9 perimeter-without-capability</b>, <b>13 without MFA</b>, <b>0 expiring in 30 days</b>, <b>2 stale (90 d)</b>, <b>7 inactive</b>. Exceptions are named in plain text on the row: "Perimeter without capability", "No MFA", "Dormant account". Two actions per row: <b>Attest</b> (the attestation is written to the tamper-evident audit log) and <b>Manage</b>. <b>Export CSV</b> exports the whole review.',
                },
            },
            {
                icon: '🗄️',
                img: 'sa-19-data-management',
                title: {
                    fr: 'Gestion des données — exports, modèles, imports et instantanés',
                    en: 'Data Management — exports, templates, imports and snapshots',
                },
                where: {
                    fr: 'Outils → Gestion des données (/data-management)',
                    en: 'Tools → Data Management (/data-management)',
                },
                what: {
                    fr: 'Six blocs, dans cet ordre à l’écran : <b>Export</b> (Organisation, Domaines & compétences, Collaborateurs, Administrateurs locaux, Évaluations, Historique — CSV, JSON ou Excel) ; <b>Modèles d’import</b> à télécharger vides ; <b>Import</b> ligne par ligne ; <b>Sauvegarde/restauration en un fichier</b> (Full System Export .xlsx, Full System Restore — « This additively merges data. Existing rows are updated, not duplicated ») ; <b>Migration JSON portable</b> avec un bouton <b>Preview changes</b> ; <b>Matrice de compétences (provisionnement en un fichier)</b> en Excel / JSON / XML / CSV / YAML, et enfin les <b>Instantanés</b>. Le pied de page donne les statistiques réelles : <b>TOTAL EMPLOYEES 78 · TOTAL ASSESSMENTS 2714 · HISTORY ENTRIES 396</b>. Tout en bas, une <b>DANGER ZONE</b> « Reset Database » qui énumère ce qui serait détruit et ce qui survivrait (le compte <code>admin</code>, son mot de passe, le schéma).',
                    en: 'Six blocks, in the on-screen order: <b>Export</b> (Organization, Domains & Skills, Employees, Local Admins, Assessments, History — CSV, JSON or Excel); <b>Import templates</b> to download empty; <b>Import</b> row by row; <b>One-shot backup/restore</b> (Full System Export .xlsx, Full System Restore — "This additively merges data. Existing rows are updated, not duplicated"); <b>Portable JSON migration</b> with a <b>Preview changes</b> button; <b>Skill Matrix single-file provisioning</b> in Excel / JSON / XML / CSV / YAML; and finally <b>Snapshots</b>. The footer gives the real statistics: <b>TOTAL EMPLOYEES 78 · TOTAL ASSESSMENTS 2714 · HISTORY ENTRIES 396</b>. At the very bottom a <b>DANGER ZONE</b> "Reset Database" listing what would be destroyed and what would survive (the <code>admin</code> account, its password, the schema).',
                },
            },
            {
                icon: '🧮',
                img: 'sa-44-import-counters',
                title: {
                    fr: 'Lire le compte rendu d’un import : créé / mis à jour / inchangé / ignoré / non évalué',
                    en: 'Reading an import report: created / updated / unchanged / skipped / not rated',
                },
                where: {
                    fr: 'Gestion des données → n’importe quel import → le panneau de résultat',
                    en: 'Data Management → any import → the result panel',
                },
                what: {
                    fr: 'Chaque compteur <b>nomme ce qui est arrivé à la ligne</b>, et non ce que l’import a bien voulu en dire. <b>créés</b> = la ligne n’existait pas et a été insérée · <b>mis à jour</b> = elle existait avec d’autres valeurs et a été <b>réécrite</b> · <b>inchangée(s)</b> = elle existait et correspondait déjà : rien n’a été écrit · <b>ignorés</b> = la ligne n’a pas été appliquée, et le motif figure dans les erreurs · <b>non évaluée(s)</b> = les cases laissées volontairement vides dans le modèle. Vérifié en réimportant à l’identique l’export produit par l’application elle-même : <code>domaines 6 inchangés · compétences 1116 inchangées, 10 ignorées (doublons dans le fichier) · postes 41 inchangés · exigences 1932 inchangées · collaborateurs 77 inchangés · évaluations 2712 mises à jour, <b>872 non évaluées</b></code>. <b>Une case vide n’est jamais un niveau 0</b> : elle est comptée à part, exactement comme l’export la restitue. Les compteurs de lignes en base étaient identiques avant et après : aucun enregistrement créé.',
                    en: "Each counter <b>names what happened to the row</b>, not what the importer felt like reporting. <b>created</b> = the row did not exist and was inserted · <b>updated</b> = it existed with different values and was <b>rewritten</b> · <b>unchanged</b> = it existed and already matched: nothing was written · <b>skipped</b> = the row was not applied, and the reason is in the errors · <b>not rated</b> = cells deliberately left blank in the template. Verified by re-importing the application's own export unchanged: <code>domains 6 unchanged · skills 1116 unchanged, 10 skipped (duplicates in the file) · roles 41 unchanged · requirements 1932 unchanged · employees 77 unchanged · assessments 2712 updated, <b>872 not rated</b></code>. <b>A blank cell is never a level 0</b>: it is counted separately, exactly as the export reports it. Table row counts were identical before and after: no record created.",
                },
            },
            {
                icon: '⌨️',
                img: 'sa-33-sql-console',
                title: {
                    fr: 'Console SQL — l’outil de dernier recours, avec point de restauration automatique',
                    en: 'SQL Console — the last-resort tool, with an automatic restore point',
                },
                where: {
                    fr: 'Outils → Gestion des données → <b>Ouvrir la console SQL</b> (/data-management/sql-console) — <b>super-administrateur uniquement</b> ; un administrateur local est redirigé (302) vers le tableau de bord',
                    en: 'Tools → Data Management → <b>Open SQL Console</b> (/data-management/sql-console) — <b>super admin only</b>; a local admin is redirected (302) to the dashboard',
                },
                what: {
                    fr: 'À utiliser quand aucun écran ne peut faire le travail, et pas avant. La page le dit elle-même : « Statements run with full database privileges. <b>Before any script that changes the database, an automatic restore point (full backup) is created</b> — you can revert to it below at any time. » Les scripts compatibles s’exécutent <b>atomiquement</b> (une erreur annule tout) ; ceux que PostgreSQL interdit en transaction (VACUUM, CREATE INDEX CONCURRENTLY, ALTER SYSTEM…) s’exécutent un par un et sont <b>revertis automatiquement</b> depuis le point de restauration en cas d’échec. Les <code>BEGIN</code>/<code>COMMIT</code> collés sont retirés. Le mode <b>Dry run</b> prévisualise sans rien enregistrer. Deux refus sont câblés et ont été vérifiés : <code>DELETE FROM system_logs</code> → « <b>Refused: system_logs cannot be modified.</b> The audit trail (assessment_history, system_logs, review_signatures) is append-only and cannot be altered from the SQL console — reverting a restore point does not erase it either » ; <code>ALTER TABLE … DISABLE TRIGGER ALL</code> → « <b>Refused: disabling triggers is not allowed from the SQL console.</b> » Un <code>SELECT</code> en Dry run renvoie ses lignes normalement (relevé : <code>employees = 78</code>). Les 20 derniers points de restauration sont conservés ; un revert ramène la base opérationnelle mais <b>ne réécrit pas l’historique</b> : le journal chaîné est extrait avant restauration puis rattaché, chaîne intacte, et les lignes qui ne peuvent plus se rattacher sont placées en quarantaine plutôt que supprimées silencieusement.',
                    en: 'For when no screen can do the job — and not before. The page says so itself: "Statements run with full database privileges. <b>Before any script that changes the database, an automatic restore point (full backup) is created</b> — you can revert to it below at any time." Transaction-safe scripts run <b>atomically</b> (any error rolls the whole script back); statements PostgreSQL forbids in a transaction (VACUUM, CREATE INDEX CONCURRENTLY, ALTER SYSTEM…) run one by one and are <b>automatically reverted</b> from the restore point if one fails. Pasted <code>BEGIN</code>/<code>COMMIT</code> are stripped. <b>Dry run</b> previews without saving. Two refusals are wired in and were verified: <code>DELETE FROM system_logs</code> → "<b>Refused: system_logs cannot be modified.</b> The audit trail (assessment_history, system_logs, review_signatures) is append-only and cannot be altered from the SQL console — reverting a restore point does not erase it either"; <code>ALTER TABLE … DISABLE TRIGGER ALL</code> → "<b>Refused: disabling triggers is not allowed from the SQL console.</b>" A <code>SELECT</code> under Dry run returns its rows normally (observed: <code>employees = 78</code>). The last 20 restore points are kept; a revert rolls the operational database back but <b>does not rewind history</b>: the hash-chained log is copied out before the restore and re-attached with its chain intact, and rows that can no longer be re-attached go to a quarantine schema rather than being silently dropped.',
                },
            },
            {
                icon: '📜',
                img: null,
                imgRetired: 'sa-17-system-logs',
                title: {
                    fr: 'Journaux système — traçabilité, et déjà limités au périmètre',
                    en: 'System Logs — traceability, already scoped',
                },
                where: {
                    fr: 'Administration → Journaux système (/system-logs) · onglets « Log entries », « Events & reconciliation », « Analytics & trends »',
                    en: 'Administration → System Logs (/system-logs) · tabs "Log entries", "Events & reconciliation", "Analytics & trends"',
                },
                what: {
                    fr: 'Chaque action porte l’acteur, la route, le statut HTTP, la latence, l’IP et un identifiant de requête. Filtres : acteur, route, statut, sévérité (info / warn / error / critical), identifiant de requête, période, et une case <b>PROBLEMS ONLY</b>. Export CSV et JSON. Le journal est déjà cloisonné : <b>4 895 entrées</b> pour le super-administrateur, <b>158</b> pour <code>test.local</code> — un délégué ne lit que ce qui relève de lui. Les refus y sont visibles nommément, ce qui en fait la meilleure preuve d’une frontière de périmètre : <code>test.local — ACCESS_DENIED — 403 — GET /admins → 403 [admin#69]</code>.',
                    en: 'Every action carries actor, route, HTTP status, latency, IP and a request id. Filters: actor, route, status, severity (info / warn / error / critical), request id, date range, plus a <b>PROBLEMS ONLY</b> checkbox. CSV and JSON export. The log is already partitioned: <b>4,895 entries</b> for the super admin, <b>158</b> for <code>test.local</code> — a delegate reads only what concerns them. Refusals are logged by name, which makes this the best evidence of a scope boundary: <code>test.local — ACCESS_DENIED — 403 — GET /admins → 403 [admin#69]</code>.',
                },
            },
            {
                // ---- SECTION operations — operations () ----
                icon: '❤️‍🩹',
                title: {
                    fr: 'Santé de l’instance — les tâches, les sauvegardes, la messagerie et la base',
                    en: 'Instance health — jobs, backups, e-mail and the database',
                },
                where: {
                    fr: 'Administration → Santé de l’instance (/admin/health) — super-administrateur uniquement',
                    en: 'Administration → Instance health (/admin/health) — super administrator only',
                },
                what: {
                    fr: 'La page qui répond après un incident. <b>Vingt-et-une tâches planifiées</b> y figurent avec, pour chacune, la dernière exécution, son état, sa durée, la prochaine échéance, le dernier succès et la dernière erreur — le tout lu dans le registre <code>job_runs</code>, écrit par l’ordonnanceur, par le worker Redis et par le bouton <b>Exécuter maintenant</b> (qui inscrit votre nom dans la piste d’audit). La carte <b>Sauvegardes</b> donne l’emplacement (<code>%ProgramData%\\IDevelop\\backups</code> par défaut, <code>BACKUP_DIR</code> pour l’imposer), le dernier fichier avec son <b>chemin et sa taille</b>, la place occupée et l’espace libre, la prochaine exécution, et un bouton <b>Sauvegarder maintenant</b> ; <b>un fichier de 0 octet est un échec</b>, jamais une sauvegarde. Suivent la <b>messagerie</b> (serveur, interrupteur général, dernier test réussi et par qui, échecs des 7 derniers jours) et la <b>base de données</b> (taille, plus grosses tables, <b>migrations en attente</b>, rétentions). Une tâche en échec, une sauvegarde de plus de 36 heures ou une licence expirée déclenchent une notification aux super-administrateurs, dédoublonnée une fois par jour, et rejoignent le récapitulatif e-mail quand celui-ci est actif. <b>Aucune valeur n’est inventée : ce qui n’est pas mesuré s’affiche « — », jamais 0.</b>',
                    en: 'The page that answers after an incident. <b>Twenty-one scheduled jobs</b> are listed with, for each, the last run, its status, its duration, the next due moment, the last success and the last error — all read from the <code>job_runs</code> ledger, written by the scheduler, by the Redis worker and by the <b>Run now</b> button (which writes your name into the audit trail). The <b>Backups</b> card gives the location (<code>%ProgramData%\\IDevelop\\backups</code> by default, <code>BACKUP_DIR</code> to force it), the last file with its <b>path and size</b>, space used and free, the next run, and a <b>Back up now</b> button; <b>a 0-byte file is a failure</b>, never a backup. Then <b>e-mail</b> (server, master switch, last successful test and by whom, failures in the last 7 days) and the <b>database</b> (size, largest tables, <b>pending migrations</b>, retention windows). A failing job, a backup older than 36 hours or an expired licence raises a notification to the super administrators, de-duplicated once a day, and joins the digest e-mail when that is on. <b>No value is invented: anything not measured reads "—", never 0.</b>',
                },
            },
            {
                icon: '🖥️',
                img: null,
                imgRetired: 'sa-18-admin-sessions',
                title: {
                    fr: 'Moniteur de sessions — voir et fermer toute session ouverte',
                    en: 'Session Monitor — see and close any open session',
                },
                where: {
                    fr: 'Administration → Sessions (/admin/sessions) — super-administrateur uniquement (un administrateur local est redirigé en 302)',
                    en: 'Administration → Sessions (/admin/sessions) — super admin only (a local admin is redirected 302)',
                },
                what: {
                    fr: 'Une ligne par session active : utilisateur, <b>type</b> (ADMIN / MANAGER / EMPLOYEE), appareil, adresse IP, heure de connexion, dernière activité, et un bouton <b>Close</b>. Votre propre session est marquée <b>THIS DEVICE / current</b> et ne peut pas se fermer elle-même par mégarde. La page précise ce qu’elle ne montre pas : « <b>38 anonymous pre-login session(s)</b> (login page, SSO handshake) are not listed. » Les sessions expirent aussi seules — l’inactivité est réglée à <code>sessionIdleMinutes = 60</code> et la durée maximale à <code>sessionTimeout = 24</code> heures dans les Paramètres.',
                    en: 'One row per active session: user, <b>type</b> (ADMIN / MANAGER / EMPLOYEE), device, IP address, signed-in time, last activity, and a <b>Close</b> button. Your own session is marked <b>THIS DEVICE / current</b> and cannot close itself by accident. The page states what it omits: "<b>38 anonymous pre-login session(s)</b> (login page, SSO handshake) are not listed." Sessions also expire on their own — idle is set by <code>sessionIdleMinutes = 60</code> and the ceiling by <code>sessionTimeout = 24</code> hours in Settings.',
                },
            },
            {
                icon: '⚙️',
                img: 'sa-16-app-settings',
                title: {
                    fr: 'Paramètres de l’application — 66 réglages en 12 catégories, plus le marquage',
                    en: 'App Settings — 66 settings in 12 categories, plus branding',
                },
                where: {
                    fr: 'Configuration → Paramètres (/app-settings) · bouton « Single Sign-On (SSO) » en tête · « Reset to Defaults »',
                    en: 'Configuration → Settings (/app-settings) · a "Single Sign-On (SSO)" button at the top · "Reset to Defaults"',
                },
                what: {
                    fr: 'Douze catégories observées : <b>General</b> (appName = IDevelop, <b>featureLocalContent = DISABLED</b>, localContentHomeCountry vide) · <b>Readiness</b> (<b>readinessThreshold = 80</b>) · <b>Security</b> (maxLoginAttempts = 5, mfaRequiredForPrivileged = DISABLED, sessionIdleMinutes = 60, sessionTimeout = 24) · <b>Notifications</b> · <b>Email (SMTP)</b> · <b>Email Triggers</b> (14 bascules par domaine : accès, coaching, conformité, récapitulatifs, contestations, engagement, cycle de vie, mobilité, revues, enquêtes, actions talent, validations, flux d’évaluation, sécurité) · <b>Self-Service Onboarding</b> · <b>Disputes & SLAs</b> (L0 5 j, L1 7 j, L2 7 j, auto-finalisation à expiration) · <b>Optional modules</b> · <b>Talent copilot (AI)</b> · <b>Scheduled jobs</b> (backupHour = 2, backupKeep = 14, digestDow = 1, digestHour = 7, rétentions) · <b>Data Management</b>. Trois panneaux d’action complètent la page : <b>Email Delivery Test</b>, <b>Branding & white-label</b> (nom, accroche de connexion, couleur d’accent — <code>#7C6CFF</code> ici —, logo ≤ 300 Ko, favicon ≤ 100 Ko, « Save branding » / « Reset to default identity ») et <b>Copilot LLM connection test</b>. <b>Changer readinessThreshold déplace d’un coup tous les verdicts « prêt au poste »</b> : à modifier rarement, et à annoncer.',
                    en: 'Twelve categories observed: <b>General</b> (appName = IDevelop, <b>featureLocalContent = DISABLED</b>, localContentHomeCountry blank) · <b>Readiness</b> (<b>readinessThreshold = 80</b>) · <b>Security</b> (maxLoginAttempts = 5, mfaRequiredForPrivileged = DISABLED, sessionIdleMinutes = 60, sessionTimeout = 24) · <b>Notifications</b> · <b>Email (SMTP)</b> · <b>Email Triggers</b> (14 per-domain switches) · <b>Self-Service Onboarding</b> · <b>Disputes & SLAs</b> (L0 5 d, L1 7 d, L2 7 d, auto-finalize on expiry) · <b>Optional modules</b> · <b>Talent copilot (AI)</b> · <b>Scheduled jobs</b> (backupHour = 2, backupKeep = 14, digestDow = 1, digestHour = 7, retentions) · <b>Data Management</b>. Three action panels complete the page: <b>Email Delivery Test</b>, <b>Branding & white-label</b> (name, login tagline, accent colour — <code>#7C6CFF</code> here —, logo ≤ 300 KB, favicon ≤ 100 KB, "Save branding" / "Reset to default identity") and <b>Copilot LLM connection test</b>. <b>Changing readinessThreshold shifts every role-ready verdict at once</b>: change it rarely, and announce it.',
                },
            },
            {
                icon: '🔐',
                img: 'sa-34-sso',
                title: {
                    fr: 'Authentification unique (SSO) — l’écran de configuration',
                    en: 'Single Sign-On (SSO) — the configuration screen',
                },
                where: {
                    fr: 'Configuration → Paramètres → bouton <b>Single Sign-On (SSO)</b> (/app-settings/sso) — super-administrateur uniquement',
                    en: 'Configuration → Settings → <b>Single Sign-On (SSO)</b> button (/app-settings/sso) — super admin only',
                },
                what: {
                    fr: 'La page annonce sa règle en tête : « SSO maps an external identity to an <b>existing</b> IDevelop account (admin or employee) by email — there is <b>no auto-provisioning</b> ». Un <b>interrupteur maître</b> (« Currently controlled by SSO_ENABLED in .env; saving here takes over ») et une option <b>SSO-only</b> qui désactive le mot de passe local dès qu’une connexion SSO a réussi — « SuperAdmins are always exempt (break-glass), so a broken IdP can never lock you out of admin ». Quatre fournisseurs, chacun avec son URL de rappel affichée et un bouton <b>Test</b> : <b>Microsoft Entra ID</b> (<code>/auth/sso/entra/callback</code> — tenant, client, secret, libellé), <b>OpenID Connect générique</b> (<code>/auth/sso/oidc/callback</code> — issuer, autorisation, jeton, userinfo, scopes), <b>SAML 2.0</b> (<code>/auth/sso/saml/callback</code> — entry point, entity ID, ACS, certificat PEM) et <b>Google Workspace</b> (<code>/auth/sso/google/callback</code> — restriction de domaine). « Changes apply immediately — no restart. » <b>Sur cette instance les quatre fournisseurs sont INACTIVE et /about affiche « SINGLE SIGN-ON (SSO) : Disabled » : le parcours de connexion de bout en bout n’a donc pas pu être exercé et n’est pas documenté ici.</b>',
                    en: 'The page states its rule up front: "SSO maps an external identity to an <b>existing</b> IDevelop account (admin or employee) by email — there is <b>no auto-provisioning</b>". A <b>master switch</b> ("Currently controlled by SSO_ENABLED in .env; saving here takes over") and an <b>SSO-only</b> option that turns off the local password once an SSO sign-in has succeeded — "SuperAdmins are always exempt (break-glass), so a broken IdP can never lock you out of admin". Four providers, each with its callback URL displayed and a <b>Test</b> button: <b>Microsoft Entra ID</b> (<code>/auth/sso/entra/callback</code>), <b>generic OpenID Connect</b> (<code>/auth/sso/oidc/callback</code>), <b>SAML 2.0</b> (<code>/auth/sso/saml/callback</code>) and <b>Google Workspace</b> (<code>/auth/sso/google/callback</code>). "Changes apply immediately — no restart." <b>On this instance all four providers read INACTIVE and /about reports "SINGLE SIGN-ON (SSO): Disabled": the end-to-end sign-in flow could not be exercised and is not documented here.</b>',
                },
            },
            {
                icon: '🔌',
                img: 'sa-14-api-keys',
                title: {
                    fr: 'Clés API & flux Power BI — une clé par audience, cloisonnée par profil',
                    en: 'API keys & Power BI feeds — one key per audience, partitioned by profile',
                },
                where: {
                    fr: 'Administration → Clés API / Power BI (/admin/api-keys) — super-administrateur uniquement (302 pour un administrateur local)',
                    en: 'Administration → API Keys / Power BI (/admin/api-keys) — super admin only (302 for a local admin)',
                },
                what: {
                    fr: 'Le formulaire demande un <b>libellé</b>, un <b>profil (habilitation)</b> — la liste déroulante propose « — Organisation entière (système) — » puis <b>chacun des 20 comptes d’administration</b> avec son rôle —, une <b>portée</b> (<code>powerbi.read (read-only)</code> ou <code>read</code>) et une <b>expiration facultative</b>. La règle est écrite sur la page : « Each key is bound to a profile — the data it returns is filtered to that profile’s clearance (RBAC scope). A superadmin-owned key sees the whole org; a site-admin-owned key sees only that site. <b>The raw key is shown once.</b> » Le tableau des clés émises donne libellé, profil, portée, création, dernière utilisation, expiration, statut et un bouton <b>Révoquer</b> (une clé <code>EXPIRED</code> y figure). Les flux documentés à l’écran : <code>/api/powerbi/employees</code>, <code>/api/powerbi/assessments</code>, <code>/api/powerbi/readiness</code>, <code>/api/powerbi/organization</code> — à consommer dans Power BI en <b>OData feed</b> avec l’en-tête <code>X-API-Key</code>.',
                    en: 'The form asks for a <b>label</b>, a <b>profile (clearance)</b> — the dropdown offers "— Full organization (system) —" (French: « Organisation entière (système) ») then <b>each of the 20 admin accounts</b> with its role —, a <b>scope</b> (<code>powerbi.read (read-only)</code> or <code>read</code>) and an optional <b>expiry</b>. The rule is printed on the page: "Each key is bound to a profile — the data it returns is filtered to that profile\'s clearance (RBAC scope). A superadmin-owned key sees the whole org; a site-admin-owned key sees only that site. <b>The raw key is shown once.</b>" The issued-keys table gives label, profile, scope, created, last used, expires, status and a <b>Revoke</b> button (one <code>EXPIRED</code> key is listed). Feeds documented on screen: <code>/api/powerbi/employees</code>, <code>/api/powerbi/assessments</code>, <code>/api/powerbi/readiness</code>, <code>/api/powerbi/organization</code> — consumed in Power BI as an <b>OData feed</b> with the <code>X-API-Key</code> header.',
                },
            },
            {
                icon: '✔️',
                img: 'sa-45-approvals-queue',
                title: {
                    fr: 'File d’approbations — la règle des quatre yeux',
                    en: 'Approvals queue — the two-person rule',
                },
                where: {
                    fr: 'Campagnes → Approbations (/v2/uam/maker-checker/queue) — super-administrateur uniquement',
                    en: 'Campaigns → Approvals (/v2/uam/maker-checker/queue) — super administrator only',
                },
                what: {
                    fr: 'Certaines actions sensibles ne s’appliquent qu’après une seconde signature : celui qui les demande (l’<b>initiateur</b>) ne peut jamais approuver sa propre demande. La file liste, pour chaque demande, le <b>type traduit</b> (par exemple « Ouverture d’un plan de performance (PIP) », jamais <code>pip.create</code>), un <b>résumé lisible</b> de ce qui est demandé — la personne concernée et les dates —, le <b>nom</b> de l’initiateur, la date localisée et l’<b>état</b> (En attente / Approuvée / Appliquée / Rejetée / Échec / Annulée). Trois filtres serveur : état, type et site (le site vient de la personne concernée) ; la vue s’ouvre par défaut sur « En attente », et « Tous les états » montre l’historique. <b>Approuver</b> exécute l’action immédiatement, dans une transaction, et l’inscrit à votre nom ; <b>Rejeter</b> exige un <b>motif écrit</b>. Rien n’est supprimé : chaque décision est horodatée, nominative et conservée, et l’initiateur reçoit une notification du résultat.',
                    en: 'Some sensitive actions only take effect after a second signature: whoever asks for them (the <b>maker</b>) can never approve their own request. For each request the queue shows the <b>translated kind</b> (e.g. “Open a performance plan (PIP)”, never <code>pip.create</code>), a <b>readable summary</b> of what is being asked — the person concerned and the dates —, the maker’s <b>name</b>, a localised date and the <b>state</b> (Pending / Approved / Applied / Rejected / Failed / Cancelled). Three server-side filters: state, kind and site (the site comes from the person concerned); the view opens on “Pending” by default, and “All states” shows the history. <b>Approve</b> runs the action immediately, in a transaction, and records it in your name; <b>Reject</b> requires a <b>written reason</b>. Nothing is deleted: every decision is timestamped, named and kept, and the maker is notified of the outcome.',
                },
            },
            {
                icon: '⚖️',
                img: 'sa-15-license',
                title: {
                    fr: 'Licence & droits d’usage — application souple, jamais bloquante',
                    en: 'License & entitlement — soft enforcement, never a lock-out',
                },
                where: {
                    fr: 'Administration → Licence (/admin/license) — super-administrateur uniquement',
                    en: 'Administration → License (/admin/license) — super admin only',
                },
                what: {
                    fr: 'La page l’écrit : « This appliance is licensed to one customer. <b>Seat = one active employee.</b> Enforcement is soft — <b>you are never locked out of your own data.</b> » État relevé : <b>Unmanaged</b> — « No license configured — all features enabled, no seat limit », <b>SEATS (ACTIVE EMPLOYEES) : 77 / unlimited</b>, ISSUED TO « — », FEATURES « All modules ». On colle une licence JSON (<code>customer</code>, <code>seats</code>, <code>features</code>, <code>expiresOn</code>) pour formaliser le droit d’usage ; vider le champ revient à l’état non géré. Une case <b>Hard-block new employees over the seat cap</b> existe et est <b>désactivée par défaut</b> : « normally the appliance only warns ».',
                    en: 'The page says it: "This appliance is licensed to one customer. <b>Seat = one active employee.</b> Enforcement is soft — <b>you are never locked out of your own data.</b>" Observed state: <b>Unmanaged</b> — "No license configured — all features enabled, no seat limit", <b>SEATS (ACTIVE EMPLOYEES): 77 / unlimited</b>, ISSUED TO "—", FEATURES "All modules". Paste a JSON licence (<code>customer</code>, <code>seats</code>, <code>features</code>, <code>expiresOn</code>) to formalise entitlement; emptying the field returns to unmanaged. A <b>Hard-block new employees over the seat cap</b> checkbox exists and is <b>off by default</b>: "normally the appliance only warns".',
                },
            },
            {
                icon: '🗓️',
                img: 'sa-11-cycles',
                title: {
                    fr: 'Campagnes d’évaluation — où en est chacune, et qui n’a pas démarré',
                    en: 'Assessment campaigns — where each stands, and who has not started',
                },
                where: {
                    fr: 'Administration → Suivi des campagnes (/cycles) → « Nouvelle campagne » ou « Ouvrir la console » sur une ligne. Depuis la revue de septembre 2026, la console crée, lance, étend, rouvre, verrouille et clôture la campagne (l’ancienne page « Cycles d’évaluation » y redirige) ; les participants se filtrent par site / département / service / poste / responsable, s’excusent en lot avec une catégorie et un motif, et se relancent d’un clic.',
                    en: 'Administration → Campaign tracking (/cycles) → "New campaign" or "Open console" on a row. Since the September 2026 review the console creates, launches, extends, reopens, locks and closes the campaign (the old "Assessment cycles" page redirects here); participants filter by site / department / service / role / manager, are excused in bulk with a category and a reason, and are chased in one click.',
                },
                what: {
                    fr: 'Sept campagnes à l’écran, avec code, libellé, <b>statut traduit</b> (Brouillon / Ouverte / Verrouillée / Clôturée / Annulée — plus jamais la valeur brute de la base), dates et <b>avancement</b>. La colonne d’avancement dit la vérité plutôt qu’un pourcentage flatteur : une campagne jamais lancée affiche « <b>Non lancée — aucun participant inscrit</b> » et son avancement se lit « <b>—</b> », jamais « 0 % » (un dénominateur vide n’est pas une performance). Sur l’instance de démonstration, <code>2026-Q3</code> (Verrouillée, 1/6→31/8, <b>En retard (11 j)</b>) affiche 76 personnes concernées sur 77 inscrites — 75 non démarrées, 1 en cours, 1 excusée — et 0 % approuvé. Un administrateur local voit la même campagne recalculée sur son périmètre, et les deux comptes concordent désormais : <b>41 personnes côté super-administrateur comme côté administrateur local</b> pour Riverside ; un sujet effacé (droit à l’effacement) n’est plus listé ni compté nulle part. La console filtre les participants par <b>site / département / service / poste / responsable</b> (dont « Sans responsable »), combinables avec l’état et la recherche ; les lignes des répartitions sont cliquables et rejouent le même filtre. On coche des lignes pour <b>« Excuser la sélection (n) »</b> ou <b>« … tout le filtre »</b> : une seule requête, une <b>catégorie</b> (absence longue durée / départ / mutation / autre), un <b>motif écrit obligatoire</b>, une date de reprise facultative — et une ligne de journal par personne, portant l’auteur et la date. Réintégrer quelqu’un conserve l’historique de son exclusion. Les personnes désactivées ou effacées sont excusées automatiquement avec un motif système, sur campagne ouverte <b>comme verrouillée</b>, pour qu’une clôture ne compte jamais un fantôme comme « jamais démarré ». Le pied de page pose la règle : « <b>Le nombre de compétences évaluées par poste est conçu par chaque département : il est conservé en entier ici et n’est jamais réduit.</b> La seule exclusion possible porte sur une PERSONNE, avec un motif. »',
                    en: 'Seven campaigns on screen, with code, label, <b>translated status</b> (Draft / Open / Locked / Closed / Cancelled — never the raw database value again), dates and <b>progress</b>. The progress column tells the truth rather than a flattering percentage: a campaign that was never launched reads "<b>Not launched — no participant enrolled</b>" and its progress shows "<b>—</b>", never "0 %" (an empty denominator is not a performance). On the demo instance <code>2026-Q3</code> (Locked, 1 Jun→31 Aug, <b>11 days overdue</b>) shows 76 people in scope out of 77 enrolled — 75 not started, 1 in progress, 1 excused — and 0 % approved. A local admin sees the same campaign recomputed on their scope, and the two counts now agree: <b>41 people for the super administrator and for the local administrator alike</b> on Riverside; an erased subject (right to erasure) is no longer listed or counted anywhere. The console filters participants by <b>site / department / service / role / manager</b> (including "No manager"), combinable with state and search; breakdown rows are links that replay the same filter. Tick rows to <b>"Excuse the selection (n)"</b> or <b>"… the whole filter"</b>: one request, a <b>category</b> (long leave / departure / transfer / other), a <b>mandatory written reason</b>, an optional return date — and one log line per person carrying the author and the date. Re-including someone keeps the history of their exclusion. Deactivated or erased subjects are excused automatically with a system reason, on open <b>and locked</b> campaigns, so a close never counts a ghost as "never started". The footer states the rule: "<b>The number of skills assessed per role is designed by each department: it is kept in full here and is never reduced.</b> The only exclusion available applies to a PERSON, with a reason."',
                },
            },
            {
                icon: '🎖️',
                img: null,
                imgRetired: 'sa-24-compliance',
                title: {
                    fr: 'Conformité opérationnelle — certificats, règles de couverture, absences prévues',
                    en: 'Operational Compliance — certificates, coverage rules, planned absences',
                },
                where: {
                    fr: 'Conformité (menu de gauche, bloc COMPLIANCE & AUDIT) — /compliance ; exige la capacité <code>view_compliance</code>',
                    en: 'Compliance (left menu, COMPLIANCE & AUDIT block) — /compliance; requires the <code>view_compliance</code> capability',
                },
                what: {
                    fr: 'En tête, l’état des certifications : <b>VALID 0 · EXPIRING (IN WINDOW) 1 · EXPIRED 0 · LAPSED SKILL LEVELS 0 · COVERAGE RULES IN BREACH 0 / 1</b>. Puis les règles de <b>couverture de poste (« Safe-Shift »)</b> — l’instance en compte une : <code>Demo — coverage: Budget & Cost Control (IT) · Budget & Cost Control (≥1) · requis ≥ 1 · qualifiés 5 · COVERED</code>. Ensuite les <b>absences prévues</b>, projetées sur 14 jours avec les expirations de certificat : « a rule that would drop below its minimum shows a predicted date and alerts before it happens » (aucune enregistrée ici). Enfin un générateur de règles en masse par pilier et par site ou département, avec un <b>Preview</b> obligatoire qui annonce « how many rules would be in BREACH the moment they exist — <b>a grid that is entirely in breach is an alert storm, not a compliance programme</b> ».',
                    en: 'At the top, certification status: <b>VALID 0 · EXPIRING (IN WINDOW) 1 · EXPIRED 0 · LAPSED SKILL LEVELS 0 · COVERAGE RULES IN BREACH 0 / 1</b>. Then <b>position coverage ("Safe-Shift") rules</b> — one on this instance: <code>Demo — coverage: Budget & Cost Control (IT) · Budget & Cost Control (≥1) · required ≥ 1 · qualified 5 · COVERED</code>. Then <b>planned absences</b>, projected over 14 days alongside certificate expiries: "a rule that would drop below its minimum shows a predicted date and alerts before it happens" (none recorded here). Finally a bulk rule generator by pillar and by site or department, with a mandatory <b>Preview</b> that reports "how many rules would be in BREACH the moment they exist — <b>a grid that is entirely in breach is an alert storm, not a compliance programme</b>".',
                },
            },
            {
                icon: '📑',
                img: null,
                imgRetired: 'sa-42-report-templates',
                title: {
                    fr: 'Générateur de rapports, modèles et envois planifiés',
                    en: 'Report builder, templates and scheduled sends',
                },
                where: {
                    fr: 'Insights → Rapports (/reports/builder) · onglet <b>TEMPLATES</b> · bouton <b>Schedules</b> → /reports/schedules',
                    en: 'Insights → Reports (/reports/builder) · <b>TEMPLATES</b> tab · <b>Schedules</b> button → /reports/schedules',
                },
                what: {
                    fr: 'Le générateur assemble un rapport section par section : <b>source</b> (Employee Readiness, Skill Gaps, Domain Capability, Employee Details, Resolved Assessments, Assessment Coverage, Requirement Provenance, 9-Box Talent), dimension et dimension secondaire, métrique, agrégation, <b>type de graphique</b> (14 dont Heatmap, Gauge, KPI Cards), palette, <b>mise en forme conditionnelle</b> (Readiness < 50 rouge / 50-79 ambre / 80+ vert, Gap, Level, Coverage), tri, limite et largeur. Les panneaux <b>SQL / DATA / RULES</b> montrent la requête générée. <b>Vérifié de bout en bout</b> : un modèle enregistré apparaît immédiatement dans la liste, devient sélectionnable dans « New schedule », et l’envoi planifié s’inscrit au tableau — <code>modèle | destinataires | weekly (Mon) · 07:00 | dernière exécution — | dernier statut —</code>. Une planification exige un <b>modèle enregistré</b> et au moins une <b>adresse valide</b> (jusqu’à 20) ; sans modèle la page affiche « No saved report templates yet — build a report and save it as a template first ». Une deuxième forme d’abonnement, indépendante, existe sur la même page : le <b>récapitulatif départemental personnel</b> (bimensuel ou mensuel, heure au choix), limité à ce que vous gouvernez.',
                    en: 'The builder assembles a report section by section: <b>source</b> (Employee Readiness, Skill Gaps, Domain Capability, Employee Details, Resolved Assessments, Assessment Coverage, Requirement Provenance, 9-Box Talent), dimension and secondary dimension, metric, aggregation, <b>chart type</b> (14, including Heatmap, Gauge, KPI Cards), palette, <b>conditional formatting</b> (Readiness < 50 red / 50-79 amber / 80+ green, Gap, Level, Coverage), sort, limit and width. The <b>SQL / DATA / RULES</b> panels show the generated query. <b>Verified end to end</b>: a saved template appears in the list immediately, becomes selectable in "New schedule", and the schedule lands in the table — <code>template | recipients | weekly (Mon) · 07:00 | last run — | last status —</code>. A schedule requires a <b>saved template</b> and at least one <b>valid email</b> (up to 20); with no template the page reads "No saved report templates yet — build a report and save it as a template first". A second, independent subscription lives on the same page: the <b>personal departmental digest</b> (bi-weekly or monthly, hour of your choice), limited to what you govern.',
                },
            },
            {
                icon: '🔑',
                img: null,
                imgRetired: 'sa-51-employee-edit-credentials',
                title: {
                    fr: 'Identifiants, politique d’authentification et désactivation d’un compte',
                    en: 'Credentials, authentication policy and deactivating an account',
                },
                where: {
                    fr: 'Collaborateurs → ouvrir une personne → <b>Edit</b> (/employees/:id/edit) → bas de page : encadrés <b>Login credentials</b> et <b>Accès & authentification / Access & authentication</b>',
                    en: 'Employees → open a person → <b>Edit</b> (/employees/:id/edit) → bottom of the page: the <b>Login credentials</b> and <b>Access & authentication</b> cards',
                },
                what: {
                    fr: '<b>Login credentials</b> : « Set or change this employee’s username and/or password. Works whether or not the account already exists. <b>Leave password blank to keep the current one.</b> » avec une case « Require a password change at next login ». <b>Accès & authentification</b> : un sélecteur de <b>politique d’authentification</b> — <i>Default (password or SSO)</i> / <i>SSO only</i> / <i>Password only</i> / <i>MFA required</i> — puis trois boutons : <b>Email credentials</b>, <b>Unlock</b> et <b>Désactiver / Deactivate</b>. Un encadré <b>Account Status</b> affiche l’état du compte, l’identifiant et la dernière connexion. La politique de mot de passe est <b>appliquée côté serveur à 12 caractères</b>, y compris depuis ce panneau : un envoi à 6 caractères est refusé en <code>400 — « Password must be at least 12 characters long »</code>, et une suite de clavier est refusée même à 14 caractères (<code>« Password must not contain sequential characters »</code>).',
                    en: '<b>Login credentials</b>: "Set or change this employee\'s username and/or password. Works whether or not the account already exists. <b>Leave password blank to keep the current one.</b>" plus a "Require a password change at next login" checkbox. <b>Access & authentication</b>: an <b>authentication policy</b> selector — <i>Default (password or SSO)</i> / <i>SSO only</i> / <i>Password only</i> / <i>MFA required</i> — then three buttons: <b>Email credentials</b>, <b>Unlock</b> and <b>Deactivate</b>. An <b>Account Status</b> card shows account state, username and last login. The password policy is <b>enforced server-side at 12 characters</b>, including from this panel: a 6-character submission is refused <code>400 — "Password must be at least 12 characters long"</code>, and a keyboard sequence is refused even at 14 characters (<code>"Password must not contain sequential characters"</code>).',
                },
            },
            {
                icon: '🪪',
                img: null,
                imgRetired: 'sa-56-employee-profile',
                title: {
                    fr: 'Accès & Identité — lier une identité SSO, accorder l’administration',
                    en: 'Access & Identity — link an SSO identity, grant administrator access',
                },
                where: {
                    fr: 'Collaborateurs → ouvrir une personne (/employees/:id) → panneau <b>Access & Identity</b>, sous « Employee Information »',
                    en: 'Employees → open a person (/employees/:id) → the <b>Access & Identity</b> panel, below "Employee Information"',
                },
                what: {
                    fr: 'Deux blocs. <b>Authentication methods</b> : l’état du mot de passe local (« Local password enabled ») avec un bouton <b>Disable (force SSO)</b>, la liste des identités SSO liées (« No SSO identities linked » ici) et un formulaire d’ajout — fournisseur <code>entra</code> / <code>oidc</code> / <code>saml</code> / <code>google</code> plus l’identifiant externe — dont le texte donne la raison d’être : « Add one so an existing AD / O365 sign-in resolves to <b>this</b> account (no duplicate) ». <b>Administrator access</b> : un sélecteur de rôle (<i>Local admin</i> / <i>Viewer (read-only)</i> / <i>Super admin</i>) et un bouton <b>Grant admin access</b>. Le comportement réel est écrit sur l’écran et il faut le lire avant de cliquer : « <b>A separate admin account is created</b> — admins sign in with a <b>password + two-factor authentication (not SSO)</b>, so set their admin password on the Admins page afterwards. <b>Their SSO stays on this employee account</b> for their business view. »',
                    en: 'Two blocks. <b>Authentication methods</b>: local-password state ("Local password enabled") with a <b>Disable (force SSO)</b> button, the list of linked SSO identities ("No SSO identities linked" here) and an add form — provider <code>entra</code> / <code>oidc</code> / <code>saml</code> / <code>google</code> plus the external id — whose copy gives the reason: "Add one so an existing AD / O365 sign-in resolves to <b>this</b> account (no duplicate)". <b>Administrator access</b>: a role selector (<i>Local admin</i> / <i>Viewer (read-only)</i> / <i>Super admin</i>) and a <b>Grant admin access</b> button. The real behaviour is printed on the screen and should be read before clicking: "<b>A separate admin account is created</b> — admins sign in with a <b>password + two-factor authentication (not SSO)</b>, so set their admin password on the Admins page afterwards. <b>Their SSO stays on this employee account</b> for their business view."',
                },
            },
            {
                icon: '🙋',
                img: 'sa-53-onboarding-queue',
                title: {
                    fr: 'Onboarding en libre-service — la file d’attente et son interrupteur',
                    en: 'Self-service onboarding — the queue and its switch',
                },
                where: {
                    fr: 'Administration → Onboarding (/onboarding) · réglages : Paramètres → catégorie <b>Self-Service Onboarding</b>',
                    en: 'Administration → Onboarding (/onboarding) · settings: Settings → <b>Self-Service Onboarding</b> category',
                },
                what: {
                    fr: 'La file explique elle-même sa règle : « People who self-registered (open signup or SSO) are waiting here. <b>Place each into a site / department / service and role</b>, optionally with a supervisor or manager — <b>that creates their account</b> and grants full access. <b>Reject</b> removes the request. » Sur cette instance la file est vide (« No pending onboarding requests »), donc les boutons de placement n’ont pas pu être exercés. Les six réglages qui la gouvernent sont dans les Paramètres et étaient <b>tous ENABLED</b> ici : <code>onboarding.enabled</code> (interrupteur maître), <code>onboarding.allowSignup</code> (page publique « Créer un compte »), <code>onboarding.allowSso</code> (demande créée automatiquement quand un SSO arrive sans compte), <code>onboarding.allowOpenSignup</code> (accepter n’importe quel domaine), <code>onboarding.allowedDomains</code> (liste blanche, vide ici) et <code>invitationExpiryDays = 14</code> (« After expiry the login is refused — invitation expired — contact your administrator »).',
                    en: 'The queue explains its own rule: "People who self-registered (open signup or SSO) are waiting here. <b>Place each into a site / department / service and role</b>, optionally with a supervisor or manager — <b>that creates their account</b> and grants full access. <b>Reject</b> removes the request." On this instance the queue is empty ("No pending onboarding requests"), so the placement buttons could not be exercised. The six settings that govern it live in Settings and were <b>all ENABLED</b> here: <code>onboarding.enabled</code> (master switch), <code>onboarding.allowSignup</code> (public "Create account" page), <code>onboarding.allowSso</code> (a request is created automatically when an SSO sign-in arrives with no account), <code>onboarding.allowOpenSignup</code> (accept any domain), <code>onboarding.allowedDomains</code> (allow-list, blank here) and <code>invitationExpiryDays = 14</code>.',
                },
            },
            {
                icon: '🎓',
                img: 'sa-52-lms-hub',
                title: {
                    fr: 'Hub LMS — connecter Cornerstone, MyPath ou tout LMS xAPI/LTI',
                    en: 'LMS Hub — connect Cornerstone, MyPath or any xAPI/LTI LMS',
                },
                where: {
                    fr: '<b>/v2/lms</b> — lien « LMS Hub » dans le menu de gauche, visible seulement avec la capacité <code>configure_lms</code>',
                    en: '<b>/v2/lms</b> — the "LMS Hub" link in the left menu, shown only with the <code>configure_lms</code> capability',
                },
                what: {
                    fr: 'Console de configuration en quatre parties. <b>Configure a provider</b> : type (<code>xapi</code> / <code>lti</code> / <code>cornerstone</code> / <code>mypath</code>), nom, URL de base, <b>secret de webhook</b>, activation, et une <b>Auth config (JSON)</b> dont le format est donné à l’écran — Cornerstone <code>{"client_id","client_secret","scope"}</code>, MyPath <code>{"token"}</code>, LTI <code>{"client_id","deployment_id","private_key","kid"}</code>. <b>Add a course & map it to a skill</b> : fournisseur, identifiant externe, titre, puis la colonne <b>MAP SKILL</b>. <b>Curation queue</b> : les compétences les plus demandées (écarts + objectifs de PDI) qui n’ont <b>aucun cours associé</b>. <b>Simulate a completion</b> : un injecteur de complétion (fournisseur, e-mail du collaborateur, identifiant de cours, score) pour tester sans LMS vivant. La promesse est écrite en tête : « Map courses to skills so completions automatically raise readiness and close successor gaps. <b>Completions never override a supervisor review.</b> » <b>Sur cette instance : « No providers configured » et « No courses cached » — la boucle complétion → montée de niveau → recalcul de préparation n’a pas pu être exercée et n’est pas documentée comme observée.</b>',
                    en: 'A four-part configuration console. <b>Configure a provider</b>: type (<code>xapi</code> / <code>lti</code> / <code>cornerstone</code> / <code>mypath</code>), name, base URL, <b>webhook secret</b>, enabled flag, and an <b>Auth config (JSON)</b> whose shape is given on screen — Cornerstone <code>{"client_id","client_secret","scope"}</code>, MyPath <code>{"token"}</code>, LTI <code>{"client_id","deployment_id","private_key","kid"}</code>. <b>Add a course & map it to a skill</b>: provider, external id, title, then the <b>MAP SKILL</b> column. <b>Curation queue</b>: the most in-demand skills (gaps + IDP objectives) with <b>no mapped course</b>. <b>Simulate a completion</b>: a completion injector (provider, employee email, course external id, score) for testing without a live LMS. The promise is printed at the top: "Map courses to skills so completions automatically raise readiness and close successor gaps. <b>Completions never override a supervisor review.</b>" <b>On this instance: "No providers configured" and "No courses cached" — the completion → level rise → readiness recompute loop could not be exercised and is not documented as observed.</b>',
                },
            },
            {
                icon: '💾',
                img: 'sa-19-data-management',
                title: {
                    fr: 'Sauvegardes & restauration — deux niveaux distincts',
                    en: 'Backups & recovery — two distinct layers',
                },
                where: {
                    fr: 'Automatique : Paramètres → <b>Scheduled jobs</b> (<code>backupHour</code>, <code>backupKeep</code>) · Manuel : Outils → Gestion des données → bloc <b>Snapshots</b>',
                    en: 'Automatic: Settings → <b>Scheduled jobs</b> (<code>backupHour</code>, <code>backupKeep</code>) · Manual: Tools → Data Management → <b>Snapshots</b> block',
                },
                what: {
                    fr: '<b>1) Sauvegarde quotidienne automatique.</b> Réglée dans les Paramètres, catégorie <i>Scheduled jobs</i> : <code>backupHour = 2</code> (« Hour of day (0-23, server time) after which the daily database backup runs ») et <code>backupKeep = 14</code> (« How many daily backup files to keep »). Rien à faire au quotidien. <b>2) Instantanés manuels.</b> Bloc <b>Snapshots</b> de la Gestion des données : bouton <b>Create Snapshot</b>, puis un tableau nom / description / créé par / créé le, avec <b>View</b>, <b>Restore</b> et <b>Delete</b> par ligne. Quatre instantanés existants sur cette instance, dont <i>« Before data entry »</i> et <i>« pre-installation »</i> — la bonne habitude est visible : on nomme l’instantané d’après ce qu’on s’apprête à faire, avant de le faire.',
                    en: '<b>1) Automatic daily backup.</b> Configured in Settings, <i>Scheduled jobs</i> category: <code>backupHour = 2</code> ("Hour of day (0-23, server time) after which the daily database backup runs") and <code>backupKeep = 14</code> ("How many daily backup files to keep"). Nothing to do day to day. <b>2) Manual snapshots.</b> The <b>Snapshots</b> block in Data Management: a <b>Create Snapshot</b> button, then a name / description / created by / created at table with <b>View</b>, <b>Restore</b> and <b>Delete</b> per row. Four snapshots exist on this instance, among them <i>"Before data entry"</i> and <i>"pre-installation"</i> — the good habit is visible: name the snapshot after what you are about to do, before you do it.',
                },
            },
            {
                icon: '🏳️',
                img: 'sa-16-app-settings',
                title: {
                    fr: 'Module Contenu local — présent, désactivé par défaut',
                    en: 'Local Content module — present, off by default',
                },
                where: {
                    fr: 'Configuration → Paramètres → catégorie <b>General</b> : <code>Activer le module contenu local / featureLocalContent</code> et <code>Pays de référence (contenu local) / localContentHomeCountry</code> · une fois activé, le rapport se trouve à <b>/reports/local-content</b>',
                    en: 'Configuration → Settings → <b>General</b> category: <code>featureLocalContent</code> and <code>localContentHomeCountry</code> · once enabled, the report lives at <b>/reports/local-content</b>',
                },
                what: {
                    fr: 'Pour les industries soumises à des quotas de nationalisation (décrets de contenu local miniers). <b>Le module existe mais il est DÉSACTIVÉ par défaut</b>, et il l’était sur une instance d’exemple : <code>featureLocalContent = DISABLED</code>, <code>localContentHomeCountry</code> vide — et l’appel direct à <code>/reports/local-content</code> répond <b>302 vers /dashboard</b> pour les trois profils, y compris le super-administrateur. Un écran absent n’est donc pas ici une fonction manquante : c’est un interrupteur. Pour l’activer : Paramètres → catégorie <b>General</b> → <b>Éditer</b> <code>featureLocalContent</code> et le passer à activé, puis renseigner <code>localContentHomeCountry</code> avec <b>une seule orthographe canonique</b> du pays (la comparaison ignore la casse mais pas l’orthographe : « Côte d’Ivoire » ≠ « Ivory Coast »). Un champ Nationalité apparaît alors sur les fiches, et le rapport devient accessible sous Outils. <b>Le contenu du rapport lui-même n’a pas pu être observé et n’est pas décrit ici.</b>',
                    en: 'For industries under nationalisation quotas (mining local-content decrees). <b>The module exists but is OFF by default</b>, and was off on a sample instance: <code>featureLocalContent = DISABLED</code>, <code>localContentHomeCountry</code> blank — and a direct call to <code>/reports/local-content</code> answers <b>302 to /dashboard</b> for all three profiles, super admin included. A missing screen here is not a missing feature: it is a switch. To turn it on: Settings → <b>General</b> → <b>Edit</b> <code>featureLocalContent</code> and enable it, then fill <code>localContentHomeCountry</code> with <b>one canonical spelling</b> of the country (the match ignores case but not spelling). A Nationality field then appears on employee records and the report becomes reachable under Tools. <b>The report content itself could not be observed and is not described here.</b>',
                },
            },
            {
                icon: '🏢',
                img: 'sa-04-organization',
                title: {
                    fr: 'Organisation — pays, sites, départements, services',
                    en: 'Organization — countries, sites, departments, services',
                },
                where: {
                    fr: 'Configuration → Organisation (/organization) · cinq onglets : <b>Countries & regions</b>, <b>Sites</b>, <b>Departments</b>, <b>Services</b>, <b>Employees</b>',
                    en: 'Configuration → Organization (/organization) · five tabs: <b>Countries & regions</b>, <b>Sites</b>, <b>Departments</b>, <b>Services</b>, <b>Employees</b>',
                },
                what: {
                    fr: 'La structure qui porte les rattachements, les périmètres d’administration et tous les filtres. Neuf sites observés, chacun avec son pays et son effectif : <b>Riverside (Côte d’Ivoire) 41 · Stonebridge (Sénégal) 8 · Lakeside 6 · Southport 5 · Exploration 5 · Westbrook (Burkina Faso) 4 · Hillcrest (Burkina Faso) 4 · Eastgate (Burkina Faso) 3 · Northfield (Mali) 1</b>. Une unité peuplée <b>ne peut pas être désactivée</b> : le bouton est accompagné du message « <b>41 PERSON(S) ATTACHED — MOVE THEM FIRST</b> ». Un bloc <b>Deactivated units</b> en bas rappelle la nuance : « These units are hidden everywhere (lists, menus, cascades, report filters) <b>but are not deleted</b>. Reactivate one to bring it back. » (0 ici.)',
                    en: 'The structure that carries placements, admin scopes and every filter. Nine sites observed, each with its country and headcount: <b>Riverside (Côte d\'Ivoire) 41 · Stonebridge (Senegal) 8 · Lakeside 6 · Southport 5 · Exploration 5 · Westbrook (Burkina Faso) 4 · Hillcrest (Burkina Faso) 4 · Eastgate (Burkina Faso) 3 · Northfield (Mali) 1</b>. A populated unit <b>cannot be deactivated</b>: the button carries the message "<b>41 PERSON(S) ATTACHED — MOVE THEM FIRST</b>". A <b>Deactivated units</b> block at the bottom states the nuance: "These units are hidden everywhere (lists, menus, cascades, report filters) <b>but are not deleted</b>. Reactivate one to bring it back." (0 here.)',
                },
            },
            {
                icon: '🚀',
                img: null,
                imgRetired: 'sa-55-setup',
                title: {
                    fr: 'Liste de mise en route — neuf étapes, chacune avec son compteur réel',
                    en: 'Getting-started checklist — nine steps, each with its real count',
                },
                where: {
                    fr: '/setup — une bannière « Finish setting up IDevelop » figure aussi en tête du tableau de bord tant que la liste n’est pas masquée',
                    en: '/setup — a "Finish setting up IDevelop" banner also sits at the top of the dashboard until the list is dismissed',
                },
                what: {
                    fr: 'Neuf étapes, dans l’ordre des dépendances, chacune affichant un compteur vivant et un lien vers le bon écran. Relevé : <b>1. Créer votre organisation</b> — 9/10/17 sites/départements/services · <b>2. Charger le référentiel</b> — 1126 (« the capability framework ships pre-loaded ») · <b>3. Définir les postes et leurs exigences</b> — 41 (41) · <b>4. Ajouter vos collaborateurs</b> — 77 · <b>5. Donner un relecteur à chacun</b> — <b>7</b> (« employees with NO supervisor and NO manager — their self-assessment would reach no review queue ») · <b>6. Rendre les personnes joignables</b> <i>optionnel</i> — <b>77</b> (« active employees without an email address — they can receive neither invitations nor notifications ») · <b>7. Ouvrir une campagne</b> <i>optionnel</i> — 0 (« Nothing is assessed until a cycle is open ») · <b>8. Enregistrer les premières évaluations</b> — 2714 · <b>9. Configurer l’e-mail (SMTP)</b> <i>optionnel</i> — « — ». Un bouton <b>Hide the setup banner from the dashboard</b> ferme la bannière sans fermer la liste.',
                    en: 'Nine steps in dependency order, each showing a live count and a link to the right screen. Observed: <b>1. Create your organization</b> — 9/10/17 · <b>2. Load the skills framework</b> — 1126 ("the capability framework ships pre-loaded") · <b>3. Define roles and their requirements</b> — 41 (41) · <b>4. Add your people</b> — 77 · <b>5. Give everyone a reviewer</b> — <b>7</b> ("employees with NO supervisor and NO manager — their self-assessment would reach no review queue") · <b>6. Make people contactable</b> <i>optional</i> — <b>77</b> ("active employees without an email address") · <b>7. Open an assessment campaign</b> <i>optional</i> — 0 ("Nothing is assessed until a cycle is open") · <b>8. Record first assessments</b> — 2714 · <b>9. Configure email (SMTP)</b> <i>optional</i> — "—". A <b>Hide the setup banner from the dashboard</b> button closes the banner without closing the list.',
                },
            },
            {
                icon: 'ℹ️',
                img: null,
                imgRetired: 'sa-54-about',
                title: {
                    fr: 'À propos — l’instance exacte que vous avez sous les yeux',
                    en: 'About — the exact instance you are looking at',
                },
                where: {
                    fr: '/about — lien « À propos » dans le menu de compte et en pied de page',
                    en: '/about — the "About" link in the account menu and the footer',
                },
                what: {
                    fr: 'Page en lecture seule, à citer telle quelle dans toute demande de support. Trois blocs. <b>Sovereignty & trust</b> : déploiement « On-premise appliance », résidence des données « Your environment — no data leaves the estate », copilote IA « On-prem, behind an anonymization firewall », appels CDN externes « Web fonts only (set DISABLE_EXTERNAL_FONTS=1 for zero third-party requests) », piste d’audit « Append-only, SHA-256 hash-chained (tamper-evident) ». <b>System</b>, relevé ici : version <b>3.22.85</b>, environnement <i>development</i>, port <b>3100</b>, Node <b>v24.14.1</b>, <i>win32 x64</i>, base <b>PostgreSQL 17.9 · demo dataset</b>, <b>99 migrations</b> (dernière <code>96_movement_feed_reviewer_identity</code>), tâches de fond « in-process scheduler », <b>SSO Disabled</b>. <b>Capability Framework</b> : <b>6 piliers · 49 sous-domaines · 56 familles de rôles · 1126 compétences · 827 items standard · 315 hérités rattachés · 1218 liens compétence↔famille</b>, référentiel chargé le 2026-06-30.',
                    en: 'A read-only page to quote verbatim in any support request. Three blocks. <b>Sovereignty & trust</b>: deployment "On-premise appliance", data residency "Your environment — no data leaves the estate", AI copilot "On-prem, behind an anonymization firewall", external CDN calls "Web fonts only", audit trail "Append-only, SHA-256 hash-chained (tamper-evident)". <b>System</b>, as observed: version <b>3.22.85</b>, environment <i>development</i>, port <b>3100</b>, Node <b>v24.14.1</b>, <i>win32 x64</i>, database <b>PostgreSQL 17.9 · demo dataset</b>, <b>99 migrations</b> (latest <code>96_movement_feed_reviewer_identity</code>), background jobs "in-process scheduler", <b>SSO Disabled</b>. <b>Capability Framework</b>: <b>6 pillars · 49 sub-domains · 56 role families · 1126 skills · 827 standard items · 315 legacy mapped · 1218 skill↔family links</b>, framework loaded 2026-06-30.',
                },
            },
            {
                icon: '🔒',
                img: 'sa-41-password-policy',
                title: {
                    fr: 'Politique de mot de passe — 12 caractères, annoncés et appliqués',
                    en: 'Password policy — 12 characters, announced and enforced',
                },
                where: {
                    fr: 'Partout où un mot de passe se saisit : /change-password, /admins/create, la fiche admin, la création de collaborateur, la réinitialisation par lien',
                    en: 'Everywhere a password is entered: /change-password, /admins/create, the admin record, employee creation, the reset-link page',
                },
                what: {
                    fr: 'Le message est le même sur tous ces écrans : « <b>Doit contenir au moins 12 caractères avec majuscule, minuscule, chiffre et caractère spécial</b> ». Les champs portent <code>minlength="12"</code>, et la règle est aussi <b>appliquée côté serveur</b> — vérifié en contournant la validation du navigateur : un mot de passe de 7 caractères est refusé et l’ancien reste valide ; depuis le panneau d’identifiants d’un collaborateur, 6 caractères donnent <code>400 — « Password must be at least 12 characters long »</code>. La longueur n’est pas le seul critère : les mots courants, les suites de clavier et les séquences sont rejetés, même au-delà de 12 caractères (<code>« Password must not contain sequential characters (e.g. "abcd", "1234", "qwerty") »</code>).',
                    en: 'The message is the same on all of them: "<b>Must be at least 12 characters with uppercase, lowercase, number, and special character</b>". Fields carry <code>minlength="12"</code>, and the rule is also <b>enforced server-side</b> — verified by bypassing the browser validation: a 7-character password is refused and the old one still works; from an employee\'s credentials panel, 6 characters give <code>400 — "Password must be at least 12 characters long"</code>. Length is not the only test: common words, keyboard patterns and sequences are rejected even beyond 12 characters (<code>"Password must not contain sequential characters"</code>).',
                },
            },
            // ---- SECTION accounts — Accounts console & lifecycle (2026-09-10) ----
            {
                icon: '👥',
                title: {
                    fr: 'Comptes — qui a un accès, qui ne s’est jamais connecté, qui est verrouillé',
                    en: 'Accounts — who has access, who never signed in, who is locked',
                },
                where: {
                    fr: 'Administration → <b>Comptes</b> (/admin/accounts ; l’ancien lien « Invitations » y redirige) · tout administrateur détenant « Réinitialiser les mots de passe » pour son périmètre · le bouton « Comptes » du haut de la liste des collaborateurs',
                    en: 'Administration → <b>Accounts</b> (/admin/accounts; the old "Invitations" link redirects there) · any administrator holding "Reset employee passwords" for their scope · the "Accounts" button at the top of the employee list',
                },
                what: {
                    fr: 'UNE liste de tous les collaborateurs actifs du périmètre, chaque ligne portant l’<b>état du compte</b> — <i>jamais invité</i> (identifiants importés, personne ne l’a invité), <i>invité, jamais connecté</i>, <i>en attente</i>, <i>invitation expirée</i>, <i>actif</i>, <i>verrouillé jusqu’à HH:MM (n échecs)</i>, <i>connexion désactivée</i>, <i>SSO</i>, <i>aucun accès</i> — le <b>moyen de connexion</b> (mot de passe / SSO / les deux), l’identifiant, la date d’invitation et la <b>dernière connexion</b> (une connexion SSO compte aussi). Les compteurs du haut sont des filtres : « jamais connectés » est exactement le recensement SQL <code>is_active AND password_hash IS NOT NULL AND last_login_at IS NULL</code>. La recherche trouve un <b>identifiant</b> (« qa.employee ») comme un nom. Par ligne ou en sélection : <b>Débloquer</b>, <b>Envoyer les identifiants</b> (e-mail de bienvenue ou, sans adresse / SMTP éteint, une <b>fiche d’identifiants à usage unique</b> à télécharger), <b>Réinitialiser le mot de passe</b>, <b>Définir un mot de passe</b>, <b>Désactiver / Réactiver la connexion</b> (fiche et identifiants conservés) et, pour le SuperAdmin, la politique d’authentification. Chaque personne est vérifiée contre le périmètre de l’administrateur (« hors périmètre » est compté, jamais exécuté). Les <b>demandes des managers</b> (« débloquer / renvoyer ») arrivent ici et dans la cloche des administrateurs concernés. <b>Exporter (CSV)</b> produit l’inventaire des accès tel que filtré. Chaque action écrit les Journaux système ET le fil des mouvements (flux <i>Compte</i>), lisible par l’administrateur de site.',
                    en: 'ONE list of every active employee in scope, each row carrying the <b>account state</b> — <i>never invited</i> (imported credentials nobody invited), <i>invited, never signed in</i>, <i>pending</i>, <i>invitation expired</i>, <i>active</i>, <i>locked until HH:MM (n failures)</i>, <i>login disabled</i>, <i>SSO</i>, <i>no access</i> — the <b>sign-in method</b> (password / SSO / both), the username, the invitation date and the <b>last sign-in</b> (an SSO sign-in counts too). The counters at the top are filters: "never signed in" is exactly the SQL census <code>is_active AND password_hash IS NOT NULL AND last_login_at IS NULL</code>. Search finds a <b>username</b> ("qa.employee") like a name. Per row or by selection: <b>Unlock</b>, <b>Send credentials</b> (welcome e-mail or, with no address / SMTP off, a downloadable <b>one-time credentials sheet</b>), <b>Reset password</b>, <b>Set a password</b>, <b>Disable / Re-enable login</b> (record and credentials kept) and, for the SuperAdmin, the authentication policy. Every person is checked against the administrator’s scope ("out of scope" is counted, never acted on). <b>Manager requests</b> ("unlock / resend") land here and in the bell of the administrators concerned. <b>Export (CSV)</b> produces the access inventory as filtered. Every action writes System Logs AND the movement feed (<i>Account</i> stream), readable by the site administrator.',
                },
                tip: {
                    fr: 'Un compte dormant (identifiants jamais utilisés depuis plus de 30 jours — réglage <code>dormantAccountDays</code>) vous est rappelé une fois par mois dans la cloche ; « Désactiver la connexion » suffit pour une absence, le départ (Cycle de vie) est réservé à celui qui part.',
                    en: 'A dormant account (credentials unused for more than 30 days — <code>dormantAccountDays</code> setting) is reminded to you once a month in the bell; "Disable login" is enough for an absence, a departure (Lifecycle) is for someone who leaves.',
                },
            },
            {
                icon: '🔄',
                title: {
                    fr: 'Cycle de vie — un départ a un motif, une date, et se demande avant de s’exécuter',
                    en: 'Lifecycle — a departure has a reason, a date, and is requested before it runs',
                },
                where: {
                    fr: 'Talents → <b>Cycle de vie</b> (/v2/lifecycle) · la fiche collaborateur (modification) émet automatiquement une <i>mobilité</i> quand site, département, service ou poste change ; la création et l’intégration d’une personne émettent une <i>arrivée</i>',
                    en: 'Talent → <b>Lifecycle</b> (/v2/lifecycle) · the employee form emits a <i>mobility</i> automatically when site, department, service or role changes; creating or onboarding a person emits an <i>arrival</i>',
                },
                what: {
                    fr: 'Le registre se filtre (événement, état, site, recherche) et se pagine ; le sélecteur de personne se cherche au clavier. Un <b>départ</b> exige un <b>motif</b> et accepte une <b>date d’effet</b> : dans le futur, il est <i>planifié</i> et exécuté par le service à l’heure (compte désactivé, sessions fermées, compte administrateur lié suspendu, plan de passation créé). Un <b>manager</b> ne peut que <b>demander</b> un départ : la ligne attend (<i>demande en attente</i>) qu’un administrateur détenant « Modifier les collaborateurs » sur cette personne l’<b>approuve</b> ou la <b>refuse</b> (motif obligatoire) — la même règle des quatre yeux que les cancellations. Ce même administrateur peut <b>annuler</b> un départ enregistré par erreur dans son périmètre (l’accès revient, y compris le compte administrateur lié) ; arrivée et mobilité restent SuperAdmin. Les états sont dits en clair : <i>traité</i>, <i>planifié</i>, <i>ignoré : aucune campagne ouverte à l’arrivée</i>, <i>refusé</i>, <i>annulé</i> — jamais un tiret.',
                    en: 'The ledger filters (event, state, site, search) and pages; the person picker is keyboard-searchable. A <b>departure</b> requires a <b>reason</b> and takes an <b>effective date</b>: in the future it is <i>scheduled</i> and executed by the hourly job (account switched off, sessions closed, linked admin account suspended, handover plan created). A <b>manager</b> may only <b>request</b> a departure: the row waits (<i>request pending</i>) for an administrator holding "Edit employees" over that person to <b>approve</b> or <b>decline</b> it (reason required) — the same two-person rule as cancellations. That administrator may also <b>revert</b> a departure recorded by mistake inside their scope (access comes back, linked admin account included); arrival and mobility stay SuperAdmin. States are said plainly: <i>processed</i>, <i>scheduled</i>, <i>skipped: no campaign was open at arrival</i>, <i>declined</i>, <i>reverted</i> — never a dash.',
                },
                tip: {
                    fr: 'L’effacement RGPD d’une personne se fait depuis <b>Maintenance → Export / Effacement (RGPD)</b> : motif + ressaisie du matricule ; il exécute d’abord la cascade de départ puis pseudonymise la fiche et tout identifiant administrateur lié. Irréversible.',
                    en: 'A person’s GDPR erasure is done from <b>Maintenance → Export / Erase (GDPR)</b>: reason + retyping the employee number; it runs the departure cascade first, then pseudonymises the record and any linked admin login. Irreversible.',
                },
            },
            // ---- end SECTION accounts ----
            {
                icon: '🛠️',
                title: {
                    fr: 'Maintenance — corriger une donnée fausse sans rien supprimer',
                    en: 'Maintenance — fix wrong data without deleting anything',
                },
                where: {
                    fr: 'Administration → <b>Maintenance</b> (/admin/maintenance) · SuperAdmin uniquement (un administrateur local ou un manager reçoit un refus, pas une page)',
                    en: 'Administration → <b>Maintenance</b> (/admin/maintenance) · SuperAdmin only (a local admin or a manager gets a refusal, not a page)',
                },
                what: {
                    fr: 'Le panneau des enregistrements « qui n’auraient pas dû exister » — vérifié sur l’instance 3.22.91. Cinq sections, chacune bornée à 200 lignes pour ne jamais devenir une page de plusieurs mégaoctets : <b>PDI et PIP</b> ouverts (bouton Annuler), <b>Auto-évaluations</b> (trois boutons selon l’état — <b>Annuler</b> : elle passe à <i>rejetée</i>, l’état terminal que tous les écrans excluent ; <b>Retirer la revue</b>, visible en <i>revue</i>, <i>modification demandée</i> ou <i>revue par le superviseur</i> : la revue est retirée, le dossier revient à <i>soumise</i> tel que déposé et réintègre la file du relecteur ; <b>Demander une modification</b>, visible sur une <i>approuvée</i> : la validation et le verrou sont levés, elle revient au collaborateur), <b>Positions 9-box</b> (Annuler : la position passe à <i>archivée</i>, le miroir de calibration est nettoyé), <b>Fiche collaborateur</b> (« vider » une fiche saisie deux fois : inactive + motif, réversible depuis la section <b>Fiches annulées</b> — refusé tant que la personne a encore des subordonnés actifs), et <b>Actions de maintenance récentes</b>. Une bannière le dit en clair : ces actions <b>contournent la règle des quatre yeux</b> (demandeur = approbateur, avec la mention « maintenance override » dans la décision). Chaque action exige un <b>motif</b> et écrit <b>trois traces</b> : les Journaux système (actions <code>MAINT_*</code>, sévérité avertissement, catégorie <i>maintenance</i>), le fil des mouvements (source <i>maintenance</i>) et la trace propre de l’enregistrement (demande de cancellation, événement 9-box, événement du workflow d’auto-évaluation). Ce que le panneau ne fait <b>jamais</b> : supprimer une ligne, réécrire le profil de compétences officiel (un niveau promu reste jusqu’à une nouvelle approbation), toucher une revue contestée ou une auto-évaluation en arbitrage.',
                    en: 'The panel for records "that should not exist" — verified on the 3.22.91 instance. Five sections, each capped at 200 rows so it can never become a multi-megabyte page: open <b>IDPs and PIPs</b> (Cancel), <b>Self-assessments</b> (three buttons by state — <b>Cancel</b>: it moves to <i>rejected</i>, the terminal state every screen excludes; <b>Withdraw the review</b>, shown while <i>under review</i>, <i>changes requested</i> or <i>reviewed</i>: the review is withdrawn, the file returns to <i>submitted</i> as filed and re-enters the reviewer’s queue; <b>Request a change</b>, shown on an <i>approved</i> one: the approval and the lock are lifted, it goes back to the employee), <b>9-box positions</b> (Cancel: the position becomes <i>archived</i>, the calibration mirror is cleared), <b>Employee record</b> (void a record entered twice: inactive + reason, reversible from the <b>Voided records</b> section — refused while the person still has active reports), and <b>Recent maintenance actions</b>. A banner says it plainly: these actions <b>bypass the two-person rule</b> (requester = approver, with "maintenance override" written in the decision). Every action requires a <b>reason</b> and writes <b>three trails</b>: System Logs (<code>MAINT_*</code> actions, warning severity, <i>maintenance</i> category), the movement feed (source <i>maintenance</i>) and the record’s own trail (cancellation request, 9-box event, self-assessment workflow event). What the panel <b>never</b> does: delete a row, rewrite the official skill profile (a promoted level stays until a new approval), touch a disputed review or an assessment in arbitration.',
                },
                steps: {
                    fr: [
                        'Ouvrez <b>Administration → Maintenance</b> et repérez l’enregistrement dans sa section.',
                        'Cliquez sur l’action proposée pour son état — le panneau n’affiche que ce qui s’applique (une auto-évaluation approuvée n’a pas « Retirer la revue », une soumise n’a pas « Demander une modification »).',
                        'Saisissez le <b>motif</b> dans la boîte de dialogue et confirmez ; sans motif, l’action est refusée.',
                        'Vérifiez le résultat là où les utilisateurs le verront : la file de revue du superviseur, la page du collaborateur, le fil des mouvements.',
                        'Pour annuler un vidage de fiche, utilisez <b>Restaurer</b> dans « Fiches annulées » : la personne revient <i>inactive</i> ; la réactiver est une décision distincte, prise depuis sa fiche.',
                    ],
                    en: [
                        'Open <b>Administration → Maintenance</b> and find the record in its section.',
                        'Click the action offered for its state — the panel only shows what applies (an approved self-assessment has no "Withdraw the review", a submitted one has no "Request a change").',
                        'Type the <b>reason</b> in the dialog and confirm; without a reason the action is refused.',
                        'Check the result where users will see it: the supervisor’s review queue, the employee’s page, the movement feed.',
                        'To undo a voided record, use <b>Restore</b> under "Voided records": the person comes back <i>inactive</i>; reactivating them is a separate decision, taken from their record.',
                    ],
                },
                tip: {
                    fr: 'Pour un plan vivant que quelqu’un conteste, préférez la file de cancellation ordinaire (à quatre yeux). Ce panneau est fait pour les données simplement fausses — et un effacement RGPD reste un acte séparé, irréversible, sous Gestion des données.',
                    en: 'For a live plan somebody disagrees with, prefer the ordinary (two-person) cancellation queue. This panel is for data that is simply wrong — and a GDPR erasure remains a separate, irreversible act under Data Management.',
                },
            },
        ],
    },
];

const GLOSSARY = [
    [
        'Not measured (“—”)',
        '« Non mesuré » (« — »)',
        'The single most important idea in this product: <b>an absence of measurement is not a result</b>. A skill nobody has assessed shows “—” and “Not measured”; it is never rounded to 0 and never counted as a gap. A level <b>0</b> is the opposite — somebody looked and found nothing. Both appear side by side on the same dashboard: “Training &amp; Mentorship” required 1 / current <b>0</b> / gap <b>−1</b> (a measured zero, counted as a gap) against “Budget &amp; Cost Control” required 1 / current <b>—</b> / <b>Not measured</b> (never assessed, not counted). That is why the counter is split: “9 skill gaps · 0 critical · <b>1 not measured</b>”. The arithmetic closes: 39 met + 9 measured gaps + 1 unmeasured = 49, and 39/49 = 89%.',
        'L’idée la plus importante du produit : <b>une absence de mesure n’est pas un résultat</b>. Une compétence que personne n’a évaluée affiche « — » et « Non mesuré » ; elle n’est jamais arrondie à 0 ni comptée comme un écart. Un niveau <b>0</b> est l’inverse : quelqu’un a regardé et a constaté un niveau nul. Les deux cohabitent sur le même tableau de bord : « Training &amp; Mentorship » requis 1 / actuel <b>0</b> / écart <b>−1</b> (un zéro mesuré, compté comme écart) face à « Budget &amp; Cost Control » requis 1 / actuel <b>—</b> / <b>Non mesuré</b> (jamais évaluée, non comptée). D’où le compteur décomposé : « 9 écarts de compétences · 0 critique(s) · <b>1 Non mesuré</b> ». L’arithmétique se referme : 39 atteintes + 9 écarts mesurés + 1 non mesurée = 49, et 39/49 = 89 %.',
    ],
    [
        'Skill level 0–4',
        'Niveau de compétence 0–4',
        'The rating scale actually shown on screen: <b>0 None · 1 Basic awareness · 2 Guided · 3 Autonomous · 4 Expert</b> (the dashboard footer spells the same scale out as “0 No knowledge · 1 Basic awareness · 2 Guided performance · 3 Autonomous · 4 Expert / can teach”). <b>2 “Guided” means you need someone with you; 3 “Autonomous” means you do not</b> — that boundary is the one most decisions turn on. Until a level is chosen, the selector reads “— Choose —” and the skill counts as not measured, not as a 0.',
        'L’échelle réellement affichée : <b>0 Aucun · 1 Notions de base · 2 Guidé · 3 Autonome · 4 Expert</b> (le pied du tableau de bord détaille la même échelle : « 0 Aucune connaissance · 1 Notions de base · 2 Performance guidée · 3 Autonome · 4 Expert / peut former »). <b>2 « Guidé » signifie qu’il faut quelqu’un avec vous ; 3 « Autonome » signifie que non</b> — c’est la frontière sur laquelle reposent la plupart des décisions. Tant qu’aucun niveau n’est choisi, le sélecteur affiche « — Choisir — » et la compétence compte comme non mesurée, pas comme un 0.',
    ],
    [
        'Skill gap',
        'Écart de compétence',
        'A <b>measured</b> shortfall: the level a role requires minus the level actually observed. A requirement that was never assessed produces no gap at all — it is reported separately as “not measured”. “Go and measure” and “go and train” are two different instructions, and the product refuses to merge them.',
        'Une insuffisance <b>mesurée</b> : le niveau requis par le poste moins le niveau réellement constaté. Une exigence jamais évaluée ne produit aucun écart — elle est rapportée à part, en « non mesuré ». « Aller mesurer » et « aller former » sont deux consignes différentes, et le produit refuse de les confondre.',
    ],
    [
        'Supervisor',
        'Superviseur',
        'Whoever is named in an employee’s <b>“supervisor”</b> column. They instruct the file: open the review, comment, send it back, enter their own rating, approve or reject; they draft 9-Box placements and run coaching. They <b>cannot</b> manager-validate a reviewed file, arbitrate a disagreement, or approve / reject / archive / disclose a 9-Box placement — all six answer <b>HTTP 403 “Not authorized: manager/admin only”</b>, measured, with the data strictly unchanged afterwards.',
        'Personne inscrite dans la colonne <b>« superviseur »</b> d’un collaborateur. Elle instruit le dossier : ouvrir la revue, commenter, renvoyer, saisir sa propre note, approuver ou rejeter ; elle prépare les positionnements 9-Box et pilote le coaching. Elle <b>ne peut pas</b> valider un dossier au nom du manager, arbitrer un désaccord, ni approuver / rejeter / archiver / restituer un positionnement 9-Box — les six actions répondent <b>HTTP 403 « Not authorized: manager/admin only »</b>, mesuré, la donnée restant strictement inchangée.',
    ],
    [
        'Manager',
        'Manager',
        'Whoever is named in an employee’s <b>“manager”</b> column (manager type “employee”). A manager holds <b>everything a supervisor holds</b>, plus four powers that are theirs alone: validate a file already reviewed by the supervisor, arbitrate a disagreement, and approve / reject / archive / disclose a 9-Box placement. The relationship is strictly one-way: no supervisor action is closed to a manager. Their span contains their supervisors’ — on the demonstration data, 16 people against 15, the supervisor herself included.',
        'Personne inscrite dans la colonne <b>« manager »</b> d’un collaborateur (type de manager « employé »). Un manager détient <b>tout ce que détient un superviseur</b>, plus quatre pouvoirs qui n’appartiennent qu’à lui : valider un dossier déjà revu par le superviseur, arbitrer un désaccord, et approuver / rejeter / archiver / restituer un positionnement 9-Box. La relation est strictement à sens unique : aucune action du superviseur n’est fermée au manager. Son périmètre englobe celui de ses superviseurs — sur le jeu de démonstration, 16 personnes contre 15, la superviseure elle-même comprise.',
    ],
    [
        'Supervisor vs Manager — the difference at a glance',
        'Superviseur vs Manager — la différence en un coup d’œil',
        'Both sign in with the same “Manager” badge and exactly the same 39-entry menu, so the difference is invisible on screen and only appears when acting.<br><br><b>Both can:</b> receive and open reviews · request changes (comment mandatory) · approve or reject a skill · enter their own rating with a mandatory gap reason · run coaching, development plans, PIPs and gap analysis · draft and submit a 9-Box placement · resolve an L0/L1 dispute within their span.<br><b>Manager only:</b> 9-Box <b>approve / reject / archive / disclose</b> · <b>manager validation</b> of a reviewed file · <b>arbitration</b> of a disagreement.<br><b>Neither:</b> HR arbitration at L2 (an administrator holding “Arbitrate disputes”) · approving their own file.<br><br>A self-assessment goes <b>first to the supervisor</b>; with none set it goes to the manager; with neither it falls into the relevant administrator’s queue.',
        'Les deux se connectent avec le même badge « Manager » et exactement le même menu de 39 entrées : la différence est invisible à l’écran et n’apparaît qu’au moment d’agir.<br><br><b>Les deux peuvent :</b> recevoir et ouvrir les revues · demander des modifications (commentaire obligatoire) · approuver ou rejeter une compétence · saisir leur propre note avec un motif d’écart obligatoire · piloter coaching, plans de développement, PIP et analyse des écarts · créer et soumettre un positionnement 9-Box · résoudre une contestation L0/L1 dans leur périmètre.<br><b>Manager uniquement :</b> 9-Box <b>approuver / rejeter / archiver / restituer</b> · <b>validation manager</b> d’un dossier revu · <b>arbitrage</b> d’un désaccord.<br><b>Ni l’un ni l’autre :</b> l’arbitrage RH en L2 (un administrateur détenant « Arbitrer les litiges ») · approuver son propre dossier.<br><br>Une auto-évaluation part <b>d’abord au superviseur</b> ; à défaut au manager ; à défaut des deux, dans la file de l’administrateur compétent.',
    ],
    [
        'Span of control',
        'Périmètre de gouvernance',
        'Everyone an account can see and act on: their full sub-tree, reached through the supervision OR the management relationship. Outside that span every action is refused with 403, whatever the role — and forms follow the same rule, so forcing an id into a URL changes nothing.',
        'L’ensemble des personnes qu’un compte peut voir et sur lesquelles il peut agir : son sous-arbre complet, atteint par la relation de supervision OU de management. Hors de ce périmètre, toute action est refusée en 403, quel que soit le rôle — et les formulaires suivent la même règle : forcer un identifiant dans une URL ne change rien.',
    ],
    [
        'Readiness SCORE',
        'Score de préparation',
        'A percentage: points obtained over the requirements that were <b>actually assessed</b>. When nothing has been assessed it reads “Not measured”, never 0 %. It answers “how good is what we measured?”.',
        'Un pourcentage : les points obtenus rapportés aux seules exigences <b>réellement évaluées</b>. Quand rien n’a été évalué, il affiche « Non mesuré », jamais 0 %. Il répond à « ce que nous avons mesuré, est-il bon ? ».',
    ],
    [
        'Role-ready VERDICT',
        'Verdict « prêt au poste »',
        'A yes/no, and a different question from the score: READY requires readiness computed over <b>ALL</b> requirements (each unassessed one counting as a 0) to reach the threshold (<b>80 %</b> by default) <b>AND</b> every critical skill to be met. That is why a row can honestly read “100 % — 2 / 13 — NOT READY”: 100 % of what was measured, with eleven requirements never measured. The score judges the measurement; the verdict judges the person against the whole job.',
        'Un oui/non, et une autre question que le score : READY exige que la préparation calculée sur <b>TOUTES</b> les exigences (chaque exigence non évaluée comptant pour 0) atteigne le seuil (<b>80 %</b> par défaut) <b>ET</b> que toutes les compétences critiques soient satisfaites. C’est pourquoi une ligne peut honnêtement afficher « 100 % — 2 / 13 — NOT READY » : 100 % de ce qui a été mesuré, avec onze exigences jamais mesurées. Le score juge la mesure ; le verdict juge la personne face au poste entier.',
    ],
    [
        'Coverage',
        'Couverture',
        'The share of the requirements in play that have actually been assessed. It is printed next to every score for one reason: a low figure at low coverage means “go and assess these people”, not “these people are weak”.',
        'La part des exigences concernées qui ont réellement été évaluées. Elle accompagne chaque score pour une raison : un chiffre faible avec une couverture faible signifie « allez évaluer ces personnes », pas « ces personnes sont faibles ».',
    ],
    [
        'Required level',
        'Niveau requis',
        'The 0–4 proficiency a role demands for a given skill, optionally flagged critical. It is the target a current level is compared against. A requirement set to 0 stays in the list to assess but can create neither a gap nor an achievement — which is why one role can list 50 skills to rate while readiness is computed over 49.',
        'La maîtrise 0–4 qu’un poste exige pour une compétence donnée, éventuellement marquée critique. C’est la cible à laquelle le niveau actuel est comparé. Une exigence fixée à 0 reste dans la liste à évaluer mais ne peut créer ni écart ni atteinte — c’est pourquoi un poste peut lister 50 compétences à noter alors que la préparation se calcule sur 49.',
    ],
    [
        'Pillar (Domain)',
        'Pilier (Domaine)',
        'The top level of the capability framework. There are <b>6</b>: 1. HSE &amp; Operational Risk · 2. Functional Technical · 3. Digital, Data &amp; Work Tools · 4. Compliance &amp; Certification · 5. Business Acumen · 6. People Management.',
        'Le niveau supérieur du référentiel de capacités. Il y en a <b>6</b> : 1. HSE &amp; Risque opérationnel · 2. Technique fonctionnel · 3. Numérique, Données &amp; Outils · 4. Conformité &amp; Certification · 5. Sens des affaires · 6. Management des personnes.',
    ],
    [
        'Sub-Domain / Competency Element',
        'Sous-domaine / Élément de compétence',
        'The middle level — a competency element inside a pillar, with a one-line definition. There are <b>49</b> (8–9 per pillar).',
        'Le niveau intermédiaire — un élément de compétence dans un pilier, avec une définition d’une ligne. Il y en a <b>49</b> (8–9 par pilier).',
    ],
    [
        'Capability Item (Skill)',
        'Item de capacité (Compétence)',
        'The most granular level — an individual skill hanging off a sub-domain, and what people rate 0–4. The About page reports the live counts of the loaded framework (on a sample instance: 6 pillars, 49 sub-domains, 56 role families, 1 126 skills).',
        'Le niveau le plus fin — une compétence individuelle rattachée à un sous-domaine, évaluée de 0 à 4. La page À propos affiche les compteurs vivants du référentiel chargé (sur une instance d’exemple : 6 piliers, 49 sous-domaines, 56 familles de rôles, 1 126 compétences).',
    ],
    [
        'Role Family',
        'Famille de rôles',
        'A grouping that skills map to. A role can be created from a role family, which pre-suggests that family’s skills instead of starting from a blank list.',
        'Un regroupement auquel les compétences sont associées. Un poste peut être créé depuis une famille de rôles, qui pré-suggère ses compétences au lieu de partir d’une liste vierge.',
    ],
    [
        'Department-designed skill count',
        'Nombre de compétences conçu par le département',
        'The number of skills a role carries is designed by the department that owns the role, and the platform states on the campaign console that it is <b>kept in full and never reduced</b>. The only exclusion the product offers applies to a <b>person</b>, with a reason — never to a skill.',
        'Le nombre de compétences d’un poste est conçu par le département qui détient ce poste, et la console de campagne l’affirme : il est <b>conservé intégralement et jamais réduit</b>. La seule exclusion prévue porte sur une <b>personne</b>, avec un motif — jamais sur une compétence.',
    ],
    [
        'Self-assessment',
        'Auto-évaluation',
        'When you rate your own skills, before a reviewer looks at them. A row you never touched stays empty (“— Choose —”, status NOT STARTED); it is not a 0.',
        'Quand vous évaluez vos propres compétences, avant qu’un relecteur les examine. Une ligne jamais touchée reste vide (« — Choisir — », statut NON COMMENCÉ) ; ce n’est pas un 0.',
    ],
    [
        'Reviewer rating',
        'Note du responsable',
        'The 0–4 rating the reviewer enters themselves in the review console, pre-filled with the employee’s self-rating. <b>That</b> rating — not the self-rating — becomes the official level on approval. If it differs from the self-rating, a short written reason is <b>mandatory</b> and the save is refused without it.',
        'La note 0–4 que le relecteur saisit lui-même dans la console de revue, pré-remplie avec l’auto-évaluation. C’est <b>cette</b> note — pas l’auto-évaluation — qui devient le niveau officiel à l’approbation. Si elle diffère de l’auto-évaluation, une courte justification écrite est <b>obligatoire</b> et l’enregistrement est refusé sans elle.',
    ],
    [
        'Rejection',
        'Rejet',
        'A reviewer decision that requires a reason and produces <b>no rating at all</b>: the skill stays unmeasured, and no IDP or PIP is triggered. A rejection is not an agreement.',
        'Une décision de relecteur qui exige un motif et ne produit <b>aucune note</b> : la compétence reste non mesurée, et aucun PDI ni PIP n’est déclenché. Un rejet ne vaut pas accord.',
    ],
    [
        'Assessment campaign (cycle)',
        'Campagne d’évaluation (cycle)',
        'A timed window with four states: <b>Draft → Open → Locked → Closed</b>. Only <b>opening</b> enrols participants and builds the roster; a draft campaign has nobody in it and sends no reminder, and the console says exactly that: “Not launched — no participant enrolled”.',
        'Une fenêtre datée à quatre états : <b>Brouillon → Ouverte → Verrouillée → Close</b>. Seule l’<b>ouverture</b> inscrit les participants et construit le roster ; une campagne en brouillon ne contient personne et n’envoie aucun rappel, et la console le dit : « Non lancée — aucun participant inscrit ».',
    ],
    [
        'Roster',
        'Roster (effectif inscrit)',
        'The list of people enrolled when a campaign is opened, each with the full department-designed count of skills expected, frozen at launch. It is what campaign progress is measured against.',
        'La liste des personnes inscrites à l’ouverture d’une campagne, chacune avec le nombre complet de compétences attendues conçu par son département, figé au lancement. C’est la base de calcul de l’avancement.',
    ],
    [
        'Dispute ladder (L0 → L1 → L2)',
        'Échelle de litige (L0 → L1 → L2)',
        'A timed escalation so no contested rating can stall a campaign: <b>L0</b> the supervisor (5 days by default), <b>L1</b> the manager (7 days), <b>L2</b> HR arbitration — a local admin holding the “Arbitrate disputes” capability (7 days) — then <b>automatic finalisation</b> on the supervisor’s rating, logged and notified to the employee. The SLAs are set in Settings → Disputes.',
        'Une escalade minutée pour qu’aucune note contestée ne bloque une campagne : <b>L0</b> le superviseur (5 jours par défaut), <b>L1</b> le manager (7 jours), <b>L2</b> l’arbitrage RH — un administrateur local détenant la capacité « Arbitrer les litiges » (7 jours) — puis la <b>finalisation automatique</b> sur la note du superviseur, tracée et notifiée au collaborateur. Les délais se règlent dans Réglages → Litiges.',
    ],
    [
        '9-Box',
        '9-Box',
        'A grid of Performance × Potential with nine cells, used to calibrate talent. Placements are confidential by default and each person appears <b>exactly once</b> — the chip shown is always the <b>approved</b> placement; a ◌ marks a proposal with no approval behind it, a • an approved position with a newer draft awaiting a decision.',
        'Une grille Performance × Potentiel à neuf cases, pour calibrer les talents. Les positionnements sont confidentiels par défaut et chaque personne n’apparaît qu’<b>une seule fois</b> — la pastille affichée est toujours le positionnement <b>approuvé</b> ; un ◌ signale une proposition sans approbation, un • une position approuvée avec un brouillon plus récent en attente.',
    ],
    [
        'Red zone / blue zone',
        'Zone rouge / zone bleue',
        'What approving a placement triggers. The <b>red zone is ALL low performance</b>, whatever the potential — <b>three cells</b>, not just the low/low corner — and it opens a 90-day PIP plus a coaching plan. The <b>blue zone</b> is high potential with medium performance, or medium potential with high performance, and it opens a 180-day IDP. The top-right corner (“Gold Star”) triggers <b>nothing</b>: it is a recognition cell, not an action cell. No duplicate is created if a plan is already open.',
        'Ce que déclenche l’approbation d’un positionnement. La <b>zone rouge est TOUTE performance basse</b>, quel que soit le potentiel — <b>trois cases</b>, pas seulement le coin bas/bas — et elle ouvre un PIP de 90 jours plus un plan de coaching. La <b>zone bleue</b> est potentiel élevé avec performance moyenne, ou potentiel moyen avec performance élevée, et elle ouvre un PDI de 180 jours. Le coin en haut à droite (« Gold Star ») ne déclenche <b>rien</b> : c’est une case de reconnaissance, pas une case d’action. Aucun doublon si un plan est déjà ouvert.',
    ],
    [
        '9-Box disclosure',
        'Restitution 9-Box',
        'A manager’s explicit choice to let an employee see their own placement. Off by default, and only an <b>approved</b> placement can be disclosed — never a proposal. The disclosure notification carries no value, only a link.',
        'Le choix explicite d’un manager de laisser un collaborateur voir son propre positionnement. Désactivé par défaut, et seul un positionnement <b>approuvé</b> peut être restitué — jamais une proposition. La notification de restitution ne contient aucune valeur, seulement un lien.',
    ],
    [
        'Supersede-by-archive',
        'Remplacement par archivage',
        'Approving a new 9-box placement <b>archives</b> the previous approved one rather than deleting it: nothing is erased, the old row is marked archived with what replaced it, and exactly one approved placement survives per person.',
        'Approuver un nouveau positionnement 9-box <b>archive</b> le précédent au lieu de l’effacer : rien n’est supprimé, l’ancien passe en « archivé » avec la mention de ce qui l’a remplacé, et un seul positionnement approuvé subsiste par personne.',
    ],
    [
        'PIP',
        'PIP',
        'Performance Improvement Plan — a support structure with a deadline for someone persistently below the bar. Propose → <b>activate</b> (this is when the period starts running) → close with an outcome. One open PIP per person. The success rate counts only closures whose period actually ran, and below four measured closures it reads “Not measured” rather than a flattering percentage.',
        'Plan d’amélioration de la performance — une structure d’appui avec échéance pour une personne durablement sous la barre. Proposer → <b>activer</b> (c’est là que la période commence à courir) → clôturer avec un résultat. Un seul PIP ouvert par personne. Le taux de réussite ne compte que les clôtures dont la période a réellement couru, et en dessous de quatre clôtures mesurées il affiche « Non mesuré » plutôt qu’un pourcentage flatteur.',
    ],
    [
        'IDP',
        'PDI',
        'Individual Development Plan — grows a person against named skills and target levels. <b>One open IDP per person, all campaigns combined.</b> Objectives are seeded from validated gaps; a skill that was never assessed produces an objective worded “current level not assessed”, not “from level 0”.',
        'Plan de développement individuel — fait progresser une personne sur des compétences nommées et des niveaux cibles. <b>Un seul PDI ouvert par personne, toutes campagnes confondues.</b> Les objectifs sont pré-remplis depuis les écarts validés ; une compétence jamais évaluée produit un objectif « niveau actuel non évalué », et non « depuis le niveau 0 ».',
    ],
    [
        'Coaching context',
        'Contexte de coaching',
        'Every coaching or mentoring plan must be anchored to an IDP, a PIP or a specific skill gap. The platform refuses a context-free plan — coaching always targets a named need.',
        'Tout plan de coaching ou de mentorat doit être rattaché à un PDI, un PIP ou un écart de compétence précis. La plateforme refuse un plan sans contexte — le coaching cible toujours un besoin nommé.',
    ],
    [
        'Capability (permission)',
        'Capacité (permission)',
        'One named thing an account may do. The catalogue holds <b>31 capabilities across 6 areas</b> (people &amp; assessments 9, configuration 7, data 2, governance 4, continuity &amp; learning 7, operational compliance 2), and every configuration area is <b>split read / write</b> — “View roles” can be granted without “Manage roles”. Your own page, <b>My access</b> (/mon-acces), lists all 31 with GRANTED / NOT GRANTED against your account.',
        'Une chose nommée qu’un compte a le droit de faire. Le catalogue compte <b>31 capacités réparties en 6 domaines</b> (personnes &amp; évaluations 9, configuration 7, données 2, gouvernance 4, continuité &amp; apprentissage 7, conformité opérationnelle 2), et chaque domaine de configuration est <b>scindé lecture / écriture</b> — « Voir les postes » s’accorde sans « Gérer les postes ». Votre propre page <b>Mon accès</b> (/mon-acces) liste les 31 avec le statut ACCORDÉE / NON ACCORDÉE pour votre compte.',
    ],
    [
        'Scope (perimeter)',
        'Périmètre',
        'Who an account may act on: a country, site, department or service. <b>Capability and scope are granted separately and you need both</b> — a capability with no scope acts on nobody, and a scope with no capability does nothing at all. on a sample instance ten local admins held a perimeter and zero capability, and the Admins page says so in a banner.',
        'Sur qui un compte a le droit d’agir : un pays, un site, un département ou un service. <b>Capacité et périmètre s’accordent séparément et il faut les deux</b> — une capacité sans périmètre n’agit sur personne, un périmètre sans capacité ne fait rien. Sur une instance d’exemple, dix administrateurs locaux détenaient un périmètre et zéro capacité, et la page Administrateurs l’affiche en bandeau.',
    ],
    [
        'Delegated-access expiry',
        'Expiration d’un accès délégué',
        'Delegated administration has a duration. The create form offers “Until” (default <b>12 months</b>) or “Permanent access”, with the reminder that permanent access should stay the exception. An unreadable or lapsed date fails <b>closed</b> — the access stops rather than being assumed valid.',
        'L’administration déléguée a une durée. Le formulaire de création propose « Jusqu’au » (par défaut <b>12 mois</b>) ou « Accès permanent », avec le rappel que le permanent doit rester l’exception. Une date illisible ou dépassée <b>échoue fermé</b> — l’accès s’arrête plutôt que d’être présumé valide.',
    ],
    [
        'Access Review',
        'Revue d’accès',
        'A super-admin screen (/admin/access-review) listing every admin account with its role, scope, capabilities, expiry, MFA state, last activity and the exceptions detected in plain words (“Perimeter without capability”, “No MFA”, “Dormant account”). Each row can be <b>attested</b>, and the attestation is written to the tamper-evident audit log. CSV export included.',
        'Un écran super-administrateur (/admin/access-review) listant chaque compte d’administration avec son rôle, son périmètre, ses capacités, son expiration, l’état MFA, la dernière activité et les exceptions détectées en clair (« périmètre sans capacité », « pas de MFA », « compte dormant »). Chaque ligne peut être <b>attestée</b>, et l’attestation est écrite dans le journal d’audit inviolable. Export CSV inclus.',
    ],
    [
        'Access ledger',
        'Registre des accès',
        'The record of every grant, revoke, scope change, profile application and expiry extension. It is <b>evidence, not permission</b>: authority lives in the capabilities and scopes, never in the ledger.',
        'La trace de chaque attribution, retrait, changement de périmètre, application de profil et prolongation. C’est une <b>preuve, pas une permission</b> : l’autorisation réside dans les capacités et les périmètres, jamais dans le registre.',
    ],
    [
        'Scoped audit log',
        'Journal d’audit cloisonné',
        'The system log is already partitioned by scope: on a sample instance the super admin saw <b>4 895</b> entries and a site-scoped local admin <b>158</b>. Granting “View system logs” is therefore not the same as opening the whole organisation’s audit. Refusals are logged by name, which makes the log the clearest proof of where a boundary actually sits.',
        'Le journal système est déjà cloisonné par périmètre : sur une instance d’exemple, le super-administrateur voyait <b>4 895</b> entrées et un administrateur local limité à un site <b>158</b>. Accorder « Voir les journaux » ne revient donc pas à ouvrir tout l’audit de l’organisation. Les refus y figurent nommément, ce qui en fait la preuve la plus claire de l’endroit où passe réellement une frontière.',
    ],
    [
        'Import counters',
        'Compteurs d’import',
        'Every import reports what happened to each row, not a flattering total: <b>created</b> (did not exist, inserted) · <b>updated</b> (existed with other values, rewritten) · <b>unchanged</b> (already matched, nothing written) · <b>skipped</b> (not applied, reason in the errors) · <b>not rated</b> (cells deliberately left blank in the template). A blank cell is never a level 0. Re-importing the application’s own export produced 1 116 skills unchanged, 1 932 requirements unchanged and 872 not rated — with zero rows created.',
        'Chaque import indique ce qui est arrivé à chaque ligne, pas un total flatteur : <b>créés</b> (n’existait pas, inséré) · <b>mis à jour</b> (existait avec d’autres valeurs, réécrit) · <b>inchangés</b> (correspondait déjà, rien d’écrit) · <b>ignorés</b> (non appliqué, motif dans les erreurs) · <b>non évaluées</b> (cases volontairement vides dans le modèle). Une case vide n’est jamais un niveau 0. Réimporter l’export de l’application elle-même a produit 1 116 compétences inchangées, 1 932 exigences inchangées et 872 non évaluées — avec zéro ligne créée.',
    ],
    [
        'Password rule',
        'Règle de mot de passe',
        '<b>At least 12 characters</b> with uppercase, lowercase, number and special character — announced under the field and enforced by the server everywhere a password is set. Length alone is not enough: common words, keyboard patterns and sequences are refused even beyond 12 characters. Changing your password signs out all your other sessions.',
        '<b>Au moins 12 caractères</b> avec majuscule, minuscule, chiffre et caractère spécial — annoncé sous le champ et appliqué par le serveur partout où un mot de passe se définit. La longueur ne suffit pas : les mots courants, les motifs de clavier et les suites sont refusés même au-delà de 12 caractères. Changer votre mot de passe déconnecte toutes vos autres sessions.',
    ],
    [
        'Active session',
        'Session active',
        'A device or browser currently signed in as you. <b>Every employee</b> — not only administrators — can list their own at /account/sessions and sign the others out in one click. Separately, a super admin has a platform-wide session monitor.',
        'Un appareil ou navigateur actuellement connecté sous votre compte. <b>Tout collaborateur</b> — pas seulement les administrateurs — peut lister les siennes sur /account/sessions et déconnecter les autres en un clic. À part, un super-administrateur dispose d’un moniteur de sessions à l’échelle de la plateforme.',
    ],
    [
        'Quiet hours',
        'Heures calmes',
        'A personal window (both times, or neither) during which nothing appears in your bell and no email is sent. <b>Nothing is dropped — everything is delivered when the window ends.</b>',
        'Une fenêtre personnelle (les deux heures, ou aucune) pendant laquelle rien n’apparaît dans votre cloche et aucun e-mail n’est envoyé. <b>Rien n’est supprimé — tout est délivré à la fin de la fenêtre.</b>',
    ],
    [
        'Two-factor auth (2FA/MFA)',
        'Authentification 2FA (MFA)',
        'A second sign-in step — a 6-digit code from an authenticator app — plus 10 single-use backup codes. Optional for everyone by default; an administrator can force it on an account through its authentication policy.',
        'Une seconde étape de connexion — un code à 6 chiffres d’une application d’authentification — plus 10 codes de secours à usage unique. Optionnelle par défaut ; un administrateur peut l’imposer sur un compte via sa politique d’authentification.',
    ],
    [
        'Single sign-on (SSO)',
        'Authentification unique (SSO)',
        'Signing in with your organisation’s identity provider (Microsoft Entra ID, generic OIDC, SAML 2.0 or Google Workspace). It maps an external identity to an <b>existing</b> account by email — there is no auto-provisioning unless self-service onboarding is also on. Note: <b>granting someone administrator access creates a SEPARATE admin account that signs in with a password plus two-factor authentication, not by SSO; their SSO identity stays on their employee account.</b> on a sample instance all four providers were inactive, so the end-to-end sign-in was not exercised.',
        'Se connecter avec le fournisseur d’identité de votre organisation (Microsoft Entra ID, OIDC générique, SAML 2.0 ou Google Workspace). Il relie une identité externe à un compte <b>existant</b> par e-mail — aucune création automatique de compte sauf si l’onboarding en libre-service est aussi activé. À noter : <b>accorder l’accès administrateur crée un compte admin SÉPARÉ, qui se connecte par mot de passe et double authentification, pas par SSO ; l’identité SSO de la personne reste sur son compte collaborateur.</b> Sur une instance d’exemple, les quatre fournisseurs étaient inactifs : le parcours de connexion n’a donc pas été exercé.',
    ],
    [
        'Self-service onboarding',
        'Onboarding en libre-service',
        'People register themselves (open signup or SSO) and wait in a queue until an administrator places them into a <b>site, department, service and role</b> — that placement is what creates their account. Off by default on a fresh installation, and refused by default when no email domain is allow-listed.',
        'Les personnes s’inscrivent elles-mêmes (inscription ouverte ou SSO) et attendent dans une file qu’un administrateur les rattache à un <b>site, un département, un service et un poste</b> — ce rattachement est ce qui crée leur compte. Désactivé par défaut sur une installation neuve, et refusé par défaut si aucun domaine d’e-mail n’est autorisé.',
    ],
    [
        'Benchmark',
        'Référentiel (Benchmark)',
        'The set of required levels each role demands, skill by skill — role data, not people data. The Benchmark view lines roles up side by side against skills grouped by pillar → sub-domain (the <b>Δ</b> column is the spread between the most and least demanding role) and, below, measures how the current occupants fit. In the French interface the menu entry is labelled <b>« Référentiel »</b>.',
        'L’ensemble des niveaux requis par chaque poste, compétence par compétence — une donnée de postes, pas de personnes. La vue Benchmark aligne les postes côte à côte face aux compétences groupées par pilier → sous-domaine (la colonne <b>Δ</b> est l’écart entre le poste le plus exigeant et le moins exigeant) et, en dessous, mesure l’adéquation des titulaires actuels. Dans l’interface française, l’entrée de menu s’intitule <b>« Référentiel »</b>.',
    ],
    [
        'Benchmark Fit',
        'Adéquation au benchmark',
        'For a role, how well the people currently in it meet its required levels on average — a percentage of required points achieved. Critical Fit is the same measure over critical skills only. Always read it next to Coverage.',
        'Pour un poste, dans quelle mesure les personnes qui l’occupent atteignent en moyenne les niveaux requis — un pourcentage des points requis atteints. L’adéquation critique est la même mesure sur les seules compétences critiques. À lire toujours à côté de la Couverture.',
    ],
    [
        'Skill matrix',
        'Matrice de compétences',
        'A grid of people × skills with their current levels. Deactivated leavers are excluded from it, which is why its headcount can be one lower than the readiness report’s.',
        'Une grille personnes × compétences et leurs niveaux actuels. Les partants désactivés en sont exclus, d’où un effectif parfois inférieur d’une unité à celui du rapport de préparation.',
    ],
    [
        'Org chart',
        'Organigramme',
        'A graphical tree built from the data — manager line, supervisor line and the Site / Department / Service structure — with search and a Focus mode. Read-only: the hierarchy is edited on employee records, and the chart only reflects it.',
        'Un arbre graphique construit à partir des données — ligne manager, ligne superviseur et structure Site / Département / Service — avec recherche et mode Focus. En lecture seule : la hiérarchie se modifie sur les fiches des collaborateurs, l’organigramme ne fait que la refléter.',
    ],
    [
        'Critical role',
        'Rôle critique',
        'A role designated as essential. It is treated as critical <b>from a criticality score of 4</b>, and that is the unit of succession planning: below that score no succession plan is opened.',
        'Un poste désigné comme essentiel. Il n’est traité comme critique <b>qu’à partir d’un score de criticité de 4</b>, et c’est l’unité de la planification de succession : en dessous, aucun plan n’est ouvert.',
    ],
    [
        'Succession bench &amp; readiness band',
        'Vivier de succession &amp; disponibilité',
        'The named successors for a critical role, each with a band. The first three bands are <b>computed</b> from readiness (Ready-now ≥ 90 %, 1–2 yrs ≥ 70 %, otherwise 3+ yrs); <b>“Emergency cover” is never assigned automatically</b> — a human names it. An expired certificate drops the effective level to 0 in this calculation.',
        'Les successeurs nommés d’un rôle critique, chacun avec une bande de disponibilité. Les trois premières sont <b>calculées</b> depuis la préparation (Prêt ≥ 90 %, 1–2 ans ≥ 70 %, sinon 3+ ans) ; la <b>« relève d’urgence » n’est jamais attribuée automatiquement</b> — c’est un humain qui la désigne. Un certificat périmé ramène le niveau effectif à 0 dans ce calcul.',
    ],
    [
        'Risk-of-loss',
        'Risque de perte',
        'A per-person signal combining likelihood of leaving and impact of loss. Hard rules: <b>nobody ever sees their own record</b>, the 9-box key is stripped from the factors returned, and a manager is notified only when someone <b>crosses</b> into “high”, as a count, in-app.',
        'Un signal par personne combinant le risque de départ et l’impact de la perte. Règles dures : <b>personne ne voit jamais sa propre fiche</b>, la clé 9-box est retirée des facteurs renvoyés, et un manager n’est prévenu qu’au <b>franchissement</b> vers « élevé », en compte, dans l’application.',
    ],
    [
        'Knowledge handover',
        'Passation de connaissances',
        'A checklist of critical knowledge and transition tasks, auto-created from a leaver or mover event and auto-closed when every item is done.',
        'Une liste des connaissances critiques et des tâches de transition, créée automatiquement depuis un événement départ ou mobilité, et clôturée d’elle-même quand tous les éléments sont faits.',
    ],
    [
        'Certification &amp; VOC',
        'Certification &amp; VOC',
        'A recorded certificate or verification of competency, with a validity in months and a revalidation window (90 days by default). Alerts fire at <b>90 / 60 / 30 days and on the day it lapses</b>, once per step. A requirement with nothing recorded reads <b>NOT HELD</b> — which means “nothing on file”, not “failed”. Employees see their own at My certifications, read-only: recording one is done by a manager or by compliance, with the evidence.',
        'Un certificat ou une vérification de compétence enregistrée, avec une validité en mois et une fenêtre de revalidation (90 jours par défaut). Les alertes partent à <b>90 / 60 / 30 jours puis le jour du dépassement</b>, une seule fois par palier. Une exigence sans rien d’enregistré affiche <b>NON DÉTENUE</b> — ce qui signifie « rien au dossier », pas « échouée ». Le collaborateur consulte les siennes dans Mes certifications, en lecture seule : l’enregistrement est fait par un responsable ou par la conformité, avec la pièce justificative.',
    ],
    [
        'Coverage rule (safe-shift)',
        'Règle de couverture (safe-shift)',
        'An operational minimum: “this site or department must always have ≥ N people at level ≥ L in skill S, with a valid certificate”. Rules are evaluated hourly, alert only on a <b>transition</b>, and are projected 14 days ahead against planned absences and certificate expiries so a breach is announced before it happens.',
        'Un minimum opérationnel : « ce site ou département doit toujours compter ≥ N personnes au niveau ≥ L dans la compétence S, avec un certificat valide ». Les règles sont évaluées chaque heure, n’alertent qu’au <b>franchissement</b>, et sont projetées à 14 jours contre les absences prévues et les échéances de certificats, pour qu’une rupture soit annoncée avant de survenir.',
    ],
    [
        'LMS Hub &amp; course–skill mapping',
        'Hub LMS &amp; association cours–compétence',
        'The integration console that connects an external learning system (Cornerstone, MyPath, or any xAPI/LTI LMS) and maps a course to the skill it builds, so a completion raises that skill. Configuring it requires the <b>Configure LMS</b> capability — it is an administrator surface, not a manager one. A reported completion is recorded as its own audited source and <b>never overrides a supervisor review</b>. on a sample instance no provider and no course were configured, so the completion loop was not exercised.',
        'La console d’intégration qui connecte un système d’apprentissage externe (Cornerstone, MyPath, ou tout LMS xAPI/LTI) et associe un cours à la compétence qu’il développe, pour qu’une complétion fasse monter cette compétence. Sa configuration exige la capacité <b>Configurer le LMS</b> — c’est une surface d’administration, pas de manager. Une complétion remontée est enregistrée comme source auditée propre et <b>n’écrase jamais une revue de superviseur</b>. Sur une instance d’exemple, aucun fournisseur ni cours n’était configuré : la boucle de complétion n’a pas été exercée.',
    ],
    [
        'Calibration',
        'Calibration',
        'A facilitated session where placements are reviewed side by side and adjusted with a <b>mandatory rationale</b> (the platform refuses an empty one). Finalising writes the result into both reading systems so they cannot diverge; a session with no adjustment at all is returned as “no adjustments” rather than stamped “finalised”.',
        'Une séance animée où les positionnements sont examinés côte à côte et ajustés avec une <b>justification obligatoire</b> (la plateforme refuse un champ vide). La finalisation écrit le résultat dans les deux systèmes de lecture pour qu’ils ne divergent pas ; une séance sans aucun ajustement est rendue « aucun ajustement » plutôt que tamponnée « finalisée ».',
    ],
    [
        'Bias scan',
        'Analyse de biais',
        'A sweep comparing each site and department against the mean. Below <b>5 placements overall or 3 per group</b> it produces no alert and says the sample is too small — read that as “we do not know”, never as “nothing to report”.',
        'Un balayage comparant chaque site et département à la moyenne. En dessous de <b>5 positionnements au total ou 3 par groupe</b>, il ne produit aucune alerte et déclare l’échantillon trop petit — à lire comme « on ne sait pas », jamais comme « rien à signaler ».',
    ],
    [
        'Engagement survey / eNPS',
        'Sondage d’engagement / eNPS',
        'A pulse or engagement survey. Results are suppressed below a minimum response count so no individual is ever exposed, and they feed risk-of-loss.',
        'Un sondage pulse ou d’engagement. Les résultats sont supprimés sous un nombre minimal de réponses pour ne jamais exposer un individu, et ils alimentent le risque de perte.',
    ],
    [
        'DEI analytics',
        'Analytique DEI',
        'Representation, 9-box and PIP rates by group — always suppressed below a minimum group size; demographic data is sealed.',
        'Représentation, taux de 9-box et de PIP par groupe — toujours supprimés sous une taille de groupe minimale ; les données démographiques sont scellées.',
    ],
    [
        'AI Copilot (on-prem)',
        'Copilote IA (on-premise)',
        'An assistant that answers questions about your people using ONLY data you are cleared to see, running on your own infrastructure behind an anonymisation firewall — no data leaves the estate. The About page states this as the deployment posture.',
        'Un assistant qui répond aux questions sur vos collaborateurs en utilisant UNIQUEMENT les données que vous êtes autorisé à voir, exécuté sur votre propre infrastructure derrière un pare-feu d’anonymisation — aucune donnée ne quitte le domaine. La page À propos l’affiche comme posture de déploiement.',
    ],
    [
        'Local content',
        'Contenu local',
        'An <b>optional module, off by default</b>: while <code>featureLocalContent</code> is disabled, /reports/local-content redirects to the dashboard for everyone, super admin included. A super admin enables it in Settings → General, together with one canonical spelling of the home country; a Nationality field then appears on employee records.',
        'Un <b>module optionnel, désactivé par défaut</b> : tant que <code>featureLocalContent</code> est désactivé, /reports/local-content redirige vers le tableau de bord pour tout le monde, super-administrateur compris. Un super-administrateur l’active dans Réglages → General, avec une orthographe canonique unique du pays d’origine ; un champ Nationalité apparaît alors sur les fiches.',
    ],
    [
        'Manager digest',
        'Récapitulatif manager',
        'A team summary — pending reviews, open IDP actions, <b>measured</b> critical gaps and, separately, critical skills <b>not yet assessed</b>, certificates due within 60 days, coverage breaches, campaign funnel. It runs on a configurable day and hour (<code>digestDow</code>, <code>digestHour</code>; Monday 07:00 by default) and sends <b>nothing at all</b> when there is nothing to say.',
        'Un résumé d’équipe — revues en attente, actions PDI ouvertes, écarts critiques <b>mesurés</b> et, à part, compétences critiques <b>non encore évaluées</b>, certificats à moins de 60 jours, ruptures de couverture, entonnoir de campagne. Il tourne un jour et une heure configurables (<code>digestDow</code>, <code>digestHour</code> ; lundi 07:00 par défaut) et n’envoie <b>rien du tout</b> quand il n’y a rien à dire.',
    ],
    [
        'Report schedule',
        'Planification de rapport',
        'A saved report template + recipients + frequency, emailed automatically as a <b>CSV attachment</b>. It requires a template saved in the report builder first — with no template, no schedule can be created. Each run executes with the <b>RBAC identity of the person who created it</b>, which is exactly what determines what the recipients receive.',
        'Un modèle de rapport enregistré + destinataires + fréquence, envoyé automatiquement en <b>pièce jointe CSV</b>. Il exige d’abord un modèle enregistré dans le générateur — sans modèle, aucune planification n’est créable. Chaque exécution utilise l’<b>identité RBAC de son créateur</b>, ce qui détermine exactement ce que les destinataires reçoivent.',
    ],
    [
        'Snapshot',
        'Instantané',
        'A manual, named point-in-time copy you can restore in one click — take one before any risky change. Know its limits: a snapshot does <b>not</b> carry PIPs, IDPs, coaching, 9-box, disputes, lifecycle, notifications or the log, and restoring <b>erases</b> what it does not cover. Nightly automatic backups run separately (hour and retention set in Settings → Scheduled jobs; <b>0 = keep everything</b>).',
        'Une copie manuelle et nommée à un instant donné, restaurable en un clic — à créer avant tout changement risqué. Connaissez ses limites : un instantané ne contient <b>pas</b> les PIP, PDI, coaching, 9-box, litiges, cycle de vie, notifications ni le journal, et la restauration <b>efface</b> ce qu’il ne couvre pas. Les sauvegardes nocturnes automatiques tournent à part (heure et conservation dans Réglages → Scheduled jobs ; <b>0 = tout garder</b>).',
    ],
    [
        'Append-only audit trail',
        'Journal en ajout seul',
        'The audit tables (<code>assessment_history</code>, <code>system_logs</code>, <code>review_signatures</code>) are append-only and SHA-256 hash-chained. The SQL console refuses to modify them, the telemetry pruner never touches the system log, and reverting a restore point does not rewind history: the chain is copied out and re-attached intact, with anything that can no longer attach quarantined rather than silently dropped.',
        'Les tables d’audit (<code>assessment_history</code>, <code>system_logs</code>, <code>review_signatures</code>) sont en ajout seul et chaînées par hachage SHA-256. La console SQL refuse de les modifier, la purge de télémétrie ne touche jamais le journal système, et revenir à un point de restauration ne réécrit pas l’historique : la chaîne est extraite puis rattachée intacte, ce qui ne peut plus se rattacher étant mis en quarantaine plutôt que supprimé en silence.',
    ],
    [
        'Maker-checker',
        'Maker-checker',
        'A second-pair-of-eyes control where one admin proposes a sensitive change and another approves it. In practice only <b>one</b> operation type is actually enrolled in the mechanism today (opening a PIP), and the approval queue was empty on a sample instance — do not plan controls around more than that.',
        'Un contrôle à quatre yeux où un administrateur propose un changement sensible et un autre l’approuve. En pratique, <b>un seul</b> type d’opération y est réellement inscrit aujourd’hui (l’ouverture d’un PIP), et la file d’approbation était vide sur une instance d’exemple — n’adossez pas de contrôle à davantage.',
    ],
    [
        'Readiness threshold',
        'Seuil de préparation',
        'The percentage at which the role-ready verdict flips, <b>80 %</b> by default, set in Settings → Readiness. Changing it moves every role-ready verdict in the platform at once: change it rarely, and announce it.',
        'Le pourcentage à partir duquel le verdict « prêt au poste » bascule, <b>80 %</b> par défaut, réglé dans Réglages → Readiness. Le modifier déplace d’un coup tous les verdicts de la plateforme : à changer rarement, et à annoncer.',
    ],
];

const FAQ = [
    [
        'A skill of mine shows “—” and “Not measured”. Is that a zero?',
        'Une de mes compétences affiche « — » et « Non mesuré ». Est-ce un zéro ?',
        'No — and the difference matters. “—” means nobody has assessed that skill yet: it is not counted as a gap, it does not lower your readiness, and it does not protect you either. It simply says nothing. A <b>0</b> is the opposite: somebody looked and recorded a nil level, and that <b>is</b> counted as a gap. On the same dashboard you can see both: “Training &amp; Mentorship” at required 1 / current 0 / gap −1, and “Budget &amp; Cost Control” at required 1 / current — / Not measured. Make a “—” disappear by rating the skill; that is the only way to get an honest figure.',
        'Non — et la différence compte. « — » signifie que personne n’a encore évalué cette compétence : elle n’est pas comptée comme écart, elle ne baisse pas votre préparation, et elle ne vous protège pas non plus. Elle ne dit rien. Un <b>0</b> est l’inverse : quelqu’un a regardé et constaté un niveau nul, et cela <b>compte</b> comme un écart. Sur le même tableau de bord vous voyez les deux : « Training &amp; Mentorship » requis 1 / actuel 0 / écart −1, et « Budget &amp; Cost Control » requis 1 / actuel — / Non mesuré. Faites disparaître un « — » en évaluant la compétence ; c’est la seule façon d’obtenir un chiffre honnête.',
    ],
    [
        'Why does my self-assessment list 50 skills while my dashboard says 39/49?',
        'Pourquoi mon auto-évaluation liste 50 compétences alors que mon tableau de bord dit 39/49 ?',
        'Both numbers are right. Your role carries <b>50</b> requirements and every one of them is there to assess — the number of skills per role is designed by your department and nothing is removed from the list. But <b>one of the 50 has a required level of 0</b>, and a requirement of 0 can create neither a gap nor an achievement, so readiness is computed over the <b>49</b> that actually demand a level. The arithmetic then closes exactly: 39 met + 9 measured gaps + 1 not measured = 49, and 39/49 = 89 %.',
        'Les deux chiffres sont justes. Votre poste porte <b>50</b> exigences et toutes sont à évaluer — le nombre de compétences par poste est conçu par votre département et rien n’est retiré de la liste. Mais <b>l’une des 50 a un niveau requis de 0</b>, et une exigence à 0 ne peut créer ni écart ni atteinte : la préparation se calcule donc sur les <b>49</b> qui exigent réellement un niveau. L’arithmétique se referme alors exactement : 39 atteintes + 9 écarts mesurés + 1 non mesurée = 49, et 39/49 = 89 %.',
    ],
    [
        'My readiness says 100 % but my status says NOT READY. Which is wrong?',
        'Ma préparation affiche 100 % mais mon statut dit NOT READY. Lequel est faux ?',
        'Neither — they answer two different questions on purpose. The <b>readiness score</b> is measured over what has actually been assessed: 100 % means everything that was looked at is at level. The <b>role-ready verdict</b> is measured over the <b>whole job</b>: every requirement, with the ones never assessed counted as 0, must reach the threshold (80 % by default) <b>and</b> every critical skill must be met. So “100 % — 2 / 13 — NOT READY” reads: excellent on the two skills we measured, and eleven we have never looked at. The fix is not a better rating, it is an assessment.',
        'Aucun des deux — ils répondent volontairement à deux questions différentes. Le <b>score de préparation</b> se mesure sur ce qui a réellement été évalué : 100 % signifie que tout ce qui a été regardé est au niveau. Le <b>verdict « prêt au poste »</b> se mesure sur le <b>poste entier</b> : toutes les exigences, celles jamais évaluées comptant pour 0, doivent atteindre le seuil (80 % par défaut) <b>et</b> toutes les compétences critiques doivent être satisfaites. « 100 % — 2 / 13 — NOT READY » se lit donc : excellent sur les deux compétences mesurées, et onze jamais regardées. Le remède n’est pas une meilleure note, c’est une évaluation.',
    ],
    [
        'Can I attach a file or a certificate to my self-assessment?',
        'Puis-je joindre un fichier ou un certificat à mon auto-évaluation ?',
        '<b>No.</b> The self-assessment form has no file upload: the columns are Skill, Required level, Your self-rating, Status and <b>Notes</b>. Use the Notes box to give a concrete example in writing — that is what a reviewer reads, and it is what makes a rating approved quickly and disputed rarely. Certificates and VOCs are recorded separately, and not by you: your manager or compliance records them with the supporting evidence, and you see the result on <b>My certifications</b>.',
        '<b>Non.</b> Le formulaire d’auto-évaluation ne comporte aucun téléversement de fichier : les colonnes sont Compétence, Niveau requis, Votre auto-évaluation, Statut et <b>Notes</b>. Utilisez la zone Notes pour donner un exemple concret par écrit — c’est ce que lit le relecteur, et c’est ce qui fait qu’une note est approuvée vite et contestée rarement. Les certificats et VOC sont enregistrés à part, et pas par vous : votre responsable ou la conformité les saisit avec la pièce justificative, et vous en voyez le résultat sur <b>Mes certifications</b>.',
    ],
    [
        'What is the difference between a supervisor and a manager?',
        'Quelle est la différence entre un superviseur et un manager ?',
        'They are TWO distinct roles, carried by two different fields on the employee record: “supervisor” on one side, “manager” on the other. The supervisor <b>instructs</b> the file: opens the review, comments, sends it back, enters their own rating, approves or rejects, drafts the 9-Box placement and runs coaching. The manager does <b>all of that</b>, and only they can additionally: validate a file already reviewed by the supervisor, arbitrate a disagreement, and approve, reject, archive or disclose a 9-Box placement. There is no reverse — no supervisor action is closed to a manager.<br><br>Mind one interface trap: both profiles show the same <b>“Manager” badge and exactly the same menu</b>. The difference is invisible on screen and shows up only when acting, as a <b>403 “Not authorized: manager/admin only”</b> for the supervisor. An administrator who fills in a “supervisor” thinking they are granting manager powers grants neither manager validation, nor arbitration, nor 9-Box approval.<br><br>Also worth knowing: a self-assessment goes first to the <b>supervisor</b>; with none set it goes to the <b>manager</b>; with neither it falls into the relevant administrator’s queue. And the manager’s span contains their supervisors’ — on the demonstration data, 16 people for the manager against 15 for the supervisor, the supervisor herself included.',
        'Ce sont DEUX rôles distincts, portés par deux champs différents de la fiche du collaborateur : « superviseur » d’un côté, « manager » de l’autre. Le superviseur <b>instruit</b> le dossier : il ouvre la revue, commente, renvoie, saisit sa propre note, approuve ou rejette, prépare le positionnement 9-Box et pilote le coaching. Le manager fait <b>tout cela</b>, et lui seul peut en plus : valider un dossier déjà revu par le superviseur, arbitrer un désaccord, et approuver, rejeter, archiver ou restituer un positionnement 9-Box. L’inverse n’existe pas — aucune action du superviseur n’est fermée au manager.<br><br>Attention à un piège d’interface : les deux profils affichent le même <b>badge « Manager » et exactement le même menu</b>. La différence ne se voit pas à l’écran ; elle apparaît au moment d’agir, sous la forme d’un <b>403 « Not authorized: manager/admin only »</b> pour le superviseur. Un administrateur qui renseigne un « superviseur » en pensant accorder les pouvoirs de manager n’accorde ni la validation manager, ni l’arbitrage, ni l’approbation 9-Box.<br><br>À retenir aussi : une auto-évaluation part d’abord au <b>superviseur</b> ; s’il n’y en a pas, au <b>manager</b> ; s’il n’y a ni l’un ni l’autre, elle tombe dans la file de l’administrateur compétent. Et le périmètre du manager englobe celui de ses superviseurs — sur le jeu de démonstration, 16 personnes pour le manager contre 15 pour la superviseure, la superviseure elle-même comprise.',
    ],
    [
        'Why does the Approve button work for me but the API says “manager/admin only”?',
        'Pourquoi le bouton Approuver fonctionne-t-il alors que l’API répond « manager/admin only » ?',
        'Because they are not the same action. The review console offers three verbs — <b>Approve, Request changes, Reject</b> — and all three are open to anyone who governs the person, supervisor included; that is how a supervisor finalises a reviewed file in the screen today. The two manager-only verbs, <b>manager validation</b> and <b>arbitration</b>, are API endpoints with <b>no button in the console at present</b>: they are verified to work, but you will not find them on the page. The one manager exclusivity you can actually click is on the 9-Box: approve, reject, archive and disclose.',
        'Parce que ce ne sont pas les mêmes actions. La console de revue propose trois verbes — <b>Approuver, Demander des modifications, Rejeter</b> — et les trois sont ouverts à quiconque gouverne la personne, superviseur compris ; c’est ainsi qu’un superviseur finalise aujourd’hui un dossier revu dans l’écran. Les deux verbes réservés au manager, la <b>validation manager</b> et l’<b>arbitrage</b>, sont des points d’API <b>sans bouton dans la console à ce jour</b> : ils sont vérifiés fonctionnels, mais vous ne les trouverez pas sur la page. La seule exclusivité manager réellement cliquable est sur la 9-Box : approuver, rejeter, archiver, restituer.',
    ],
    [
        'My password keeps being refused',
        'Mon mot de passe est systématiquement refusé',
        'The rule is <b>at least 12 characters</b>, with an uppercase, a lowercase, a number and a special character — announced under the field and enforced by the server, so a shorter one is refused however you submit it. Length alone is not enough either: common words, keyboard patterns and sequences (“abcd”, “1234”, “qwerty”) are rejected even beyond 12 characters. A long, unique passphrase satisfies the rule with no memory effort. Note that changing your password signs out every other session.',
        'La règle est <b>au moins 12 caractères</b>, avec une majuscule, une minuscule, un chiffre et un caractère spécial — annoncée sous le champ et appliquée par le serveur, donc un mot de passe plus court est refusé quelle que soit la façon de l’envoyer. La longueur ne suffit pas non plus : les mots courants, les motifs de clavier et les suites (« abcd », « 1234 », « qwerty ») sont rejetés même au-delà de 12 caractères. Une phrase de passe longue et unique satisfait la règle sans effort de mémoire. À noter : changer votre mot de passe déconnecte toutes vos autres sessions.',
    ],
    [
        'I forgot my password / I am locked out',
        'J’ai oublié mon mot de passe / je suis bloqué',
        'Open <b>/forgot-password</b> (the “Forgot your password?” link is shown on the sign-in page when email sending is configured; the page itself is reachable either way). Enter your username or email and a reset link is sent — to the address recorded on <b>your</b> record, which is the one you set yourself in <b>My profile</b>. The answer is deliberately the same whether the identifier exists or not, so no account is revealed. If a banner says email sending is not configured, or you never filled in your email, an administrator has to reset it for you — which is exactly why you should fill in your email <i>before</i> you need it.',
        'Ouvrez <b>/forgot-password</b> (le lien « Mot de passe oublié ? » apparaît sur la page de connexion quand l’envoi d’e-mails est configuré ; la page reste accessible dans tous les cas). Saisissez votre identifiant ou votre e-mail et un lien de réinitialisation est envoyé — à l’adresse enregistrée sur <b>votre</b> fiche, celle que vous saisissez vous-même dans <b>Mon profil</b>. La réponse est volontairement la même que l’identifiant existe ou non, pour ne révéler aucun compte. Si un bandeau indique que l’envoi d’e-mails n’est pas configuré, ou si vous n’avez jamais renseigné votre e-mail, un administrateur doit le réinitialiser pour vous — raison pour laquelle il faut renseigner son e-mail <i>avant</i> d’en avoir besoin.',
    ],
    [
        'Where do I set my email address?',
        'Où est-ce que je saisis mon adresse e-mail ?',
        'Account menu → <b>My profile</b> (/account), a page every employee has since 3.22.85. Email and phone are the only two fields you can change there; your name, employee number, username, role, site, department, service and supervisor are managed by your administrator and are refused if submitted — report an error in those to your manager or HR administrator.',
        'Menu de compte → <b>Mon profil</b> (/account), une page dont tout collaborateur dispose depuis la 3.22.85. L’e-mail et le téléphone sont les deux seuls champs modifiables ; votre nom, matricule, identifiant, poste, site, département, service et superviseur sont gérés par votre administrateur et sont refusés s’ils sont envoyés — signalez-y une erreur à votre responsable ou à l’administrateur RH.',
    ],
    [
        'Can I see the devices signed in to my account?',
        'Puis-je voir les appareils connectés à mon compte ?',
        'Yes — <b>every employee</b> can, not just administrators. Account menu → <b>Active Sessions</b> (/account/sessions) lists each device with its IP, sign-in time and last activity, marks the one you are using as THIS DEVICE, and offers “Sign out all other sessions (N)”. Make it a reflex after using a shared machine. If you see a session you do not recognise, sign the others out and change your password.',
        'Oui — <b>tout collaborateur</b> le peut, pas seulement les administrateurs. Menu de compte → <b>Sessions actives</b> (/account/sessions) liste chaque appareil avec son IP, l’heure de connexion et la dernière activité, marque celui que vous utilisez « CET APPAREIL », et propose « Déconnecter toutes les autres sessions (N) ». Prenez-en le réflexe après un poste partagé. Si vous voyez une session inconnue, déconnectez les autres et changez votre mot de passe.',
    ],
    [
        'Can I turn off notification emails without losing anything?',
        'Puis-je couper les e-mails de notification sans rien perdre ?',
        'Yes. Account menu → <b>Notifications</b> (/account/notifications): switching email off keeps everything in the in-app bell, it only stops the email copy. The same page has <b>quiet hours</b> — set <b>both</b> times or leave both empty — during which nothing appears and nothing is sent; nothing is dropped, it is all delivered when the window ends.',
        'Oui. Menu de compte → <b>Notifications</b> (/account/notifications) : couper l’e-mail conserve tout dans la cloche de l’application, cela n’arrête que la copie par e-mail. La même page porte les <b>heures calmes</b> — renseignez les <b>deux</b> heures ou laissez-les vides — pendant lesquelles rien n’apparaît et rien n’est envoyé ; rien n’est supprimé, tout est délivré à la fin de la fenêtre.',
    ],
    [
        'Can I change my self-assessment after submitting?',
        'Puis-je modifier mon auto-évaluation après l’avoir soumise ?',
        'Yes — update your ratings and submit again; it simply goes back to your reviewer, with no duplicate submission. If a reviewer asks for changes, the line comes back to you with their comment. Once approved, the reviewer’s rating — not your self-rating — becomes your official current level.',
        'Oui — modifiez vos niveaux et soumettez à nouveau ; cela retourne simplement à votre relecteur, sans doublon de soumission. Si un relecteur demande une modification, la ligne vous revient avec son commentaire. Une fois approuvée, c’est la note du relecteur — pas votre auto-évaluation — qui devient votre niveau officiel.',
    ],
    [
        'My reviewer gave me a different rating from mine. Can they just do that?',
        'Mon relecteur m’a donné une autre note que la mienne. Peut-il faire ça ?',
        'They can, and they must justify it: the review console pre-fills their rating with yours, and the moment they change it a dialog demands a short written reason — the save is refused without one, and the reason is kept and visible in the review. If you still disagree, open a <b>dispute</b> from your reviews page: it climbs a timed ladder (supervisor → manager → HR arbitration) so it cannot stall, and the final decided level is shown to you.',
        'Il le peut, et il doit le justifier : la console de revue pré-remplit sa note avec la vôtre, et dès qu’il la modifie une fenêtre exige une courte justification écrite — l’enregistrement est refusé sans elle, et la justification est conservée et visible dans la revue. Si vous n’êtes toujours pas d’accord, ouvrez une <b>contestation</b> depuis votre page de revues : elle gravit une échelle minutée (superviseur → manager → arbitrage RH) pour ne jamais bloquer, et le niveau final retenu vous est affiché.',
    ],
    [
        'My coaching plan will not save',
        'Mon plan de coaching ne s’enregistre pas',
        'A coaching or mentoring plan must be anchored to a <b>context</b> — an IDP, a PIP, or a specific skill gap — and the platform refuses a plan without one; an inline message points to the field. That rule exists so coaching always targets a named need rather than a vague intention.',
        'Un plan de coaching ou de mentorat doit être rattaché à un <b>contexte</b> — un PDI, un PIP ou un écart de compétence précis — et la plateforme refuse un plan sans contexte ; un message vous indique le champ. Cette règle existe pour que le coaching cible toujours un besoin nommé plutôt qu’une intention vague.',
    ],
    [
        'The 9-box created a PIP / an IDP by itself',
        'La 9-Box a créé un PIP / un PDI toute seule',
        'Yes — approval is the trigger point. <b>Low performance</b>, whatever the potential (three cells, not just the low/low corner), opens a 90-day PIP with a paired coaching plan. <b>High potential with medium performance, or medium potential with high performance</b>, opens a 180-day IDP. The top-right “Gold Star” corner triggers <b>nothing</b>. Nothing is duplicated: if a plan is already open, the existing one is adopted.',
        'Oui — l’approbation est le point de déclenchement. Une <b>performance basse</b>, quel que soit le potentiel (trois cases, pas seulement le coin bas/bas), ouvre un PIP de 90 jours avec un plan de coaching associé. Un <b>potentiel élevé avec performance moyenne, ou un potentiel moyen avec performance élevée</b>, ouvre un PDI de 180 jours. Le coin « Gold Star » en haut à droite ne déclenche <b>rien</b>. Aucun doublon : si un plan est déjà ouvert, l’existant est adopté.',
    ],
    [
        'Why can I see a menu entry but get “Access denied” on it?',
        'Pourquoi une entrée de menu m’affiche-t-elle « Accès refusé » ?',
        'There are two independent locks and you need both: the <b>capability</b> says what you may do, the <b>scope</b> says on whom. The refusal page names which one stopped you — “Missing capability”, with the capability code, its description and who can grant it, or “Outside your scope”, which says in as many words that nothing is missing from your capabilities: it is the perimeter. A third form exists for the six strictly super-admin screens (access review, API keys, license, sessions, SSO, SQL console): they redirect to the dashboard instead of showing a refusal. Your own page <b>My access</b> (/mon-acces) lists all 31 capabilities with what you hold.',
        'Il y a deux verrous indépendants et il faut les deux : la <b>capacité</b> dit ce que vous pouvez faire, le <b>périmètre</b> dit sur qui. La page de refus nomme celui qui vous a arrêté — « Capacité manquante », avec le code de la capacité, sa description et qui peut l’accorder, ou « Hors de votre périmètre », qui dit explicitement que rien ne manque à vos capacités : c’est le périmètre. Une troisième forme existe pour les six écrans strictement super-administrateur (revue d’accès, clés API, licence, sessions, SSO, console SQL) : ils redirigent vers le tableau de bord au lieu d’afficher un refus. Votre page <b>Mon accès</b> (/mon-acces) liste les 31 capacités et ce que vous détenez.',
    ],
    [
        'I gave a local admin a perimeter but they still cannot do anything',
        'J’ai donné un périmètre à un administrateur local et il ne peut toujours rien faire',
        'That is expected, and it is by design: a scope without a capability does nothing, and a capability without a scope acts on nobody. A brand-new delegate starts with <b>no capability at all</b> until you tick some. The Admins page even counts the cases for you in a banner (“N account(s) have a perimeter but no capability — they cannot do anything”). Grant capabilities on their record, remembering that each configuration area is split read/write, and set a duration — the form defaults to 12 months rather than permanent.',
        'C’est normal, et c’est volontaire : un périmètre sans capacité ne fait rien, une capacité sans périmètre n’agit sur personne. Un nouveau délégué démarre <b>sans aucune capacité</b> tant que vous n’en cochez pas. La page Administrateurs compte même les cas en bandeau (« N compte(s) ont un périmètre mais aucune capacité — ils ne peuvent rien faire »). Accordez les capacités sur sa fiche, en gardant à l’esprit que chaque domaine de configuration est scindé lecture/écriture, et fixez une durée — le formulaire propose 12 mois par défaut plutôt que permanent.',
    ],
    [
        'If I grant someone admin access, do they still sign in with SSO?',
        'Si j’accorde l’accès administrateur à quelqu’un, se connecte-t-il toujours en SSO ?',
        '<b>No, and this is worth reading before you click.</b> Granting admin access creates a <b>separate admin account</b>. Administrators sign in with a <b>password plus two-factor authentication, not by SSO</b> — so you must set their admin password on the Admins page afterwards, or they cannot get in. Their <b>SSO identity stays on their employee account</b>, which they keep for their business view. One person, two accounts, on purpose.',
        '<b>Non, et cela mérite d’être lu avant de cliquer.</b> Accorder l’accès administrateur crée un <b>compte administrateur séparé</b>. Les administrateurs se connectent par <b>mot de passe et double authentification, pas par SSO</b> — vous devez donc définir ensuite leur mot de passe admin sur la page Administrateurs, sinon ils ne peuvent pas entrer. Leur <b>identité SSO reste sur leur compte collaborateur</b>, qu’ils conservent pour leur vue métier. Une personne, deux comptes, volontairement.',
    ],
    [
        'An import said “unchanged” everywhere. Did it do nothing?',
        'Un import affiche « inchangé » partout. N’a-t-il rien fait ?',
        'It did exactly what it should: it compared and found nothing to write. The counters are deliberately explicit — <b>created</b> (inserted), <b>updated</b> (existed with other values, rewritten), <b>unchanged</b> (already matched, nothing written), <b>skipped</b> (not applied, reason listed in the errors) and <b>not rated</b> (cells left blank in the template). “Unchanged” is the honest answer to a re-import, and “not rated” is never turned into a level 0. Always run <b>Preview</b> first: it validates every row and writes nothing.',
        'Il a fait exactement ce qu’il fallait : il a comparé et n’a rien trouvé à écrire. Les compteurs sont volontairement explicites — <b>créés</b> (insérés), <b>mis à jour</b> (existaient avec d’autres valeurs, réécrits), <b>inchangés</b> (correspondaient déjà, rien d’écrit), <b>ignorés</b> (non appliqués, motif dans les erreurs) et <b>non évaluées</b> (cases laissées vides dans le modèle). « Inchangé » est la réponse honnête à une réimportation, et « non évaluée » n’est jamais converti en niveau 0. Lancez toujours <b>Prévisualiser</b> d’abord : il valide chaque ligne et n’écrit rien.',
    ],
    [
        'Is my data backed up?',
        'Mes données sont-elles sauvegardées ?',
        'Yes, on two layers. An <b>automatic nightly database backup</b> runs at the hour set in Settings → Scheduled jobs and keeps the last N files (0 means keep everything); its date and status are published on the About page. Separately, an administrator can take a named <b>snapshot</b> before a risky change and restore it in one click — but a snapshot does not carry PIPs, IDPs, coaching, 9-box, disputes, lifecycle, notifications or the audit log, and restoring erases what it does not cover. A backup you have never restored is a hope, not a plan.',
        'Oui, sur deux niveaux. Une <b>sauvegarde nocturne automatique</b> de la base tourne à l’heure fixée dans Réglages → Scheduled jobs et conserve les N derniers fichiers (0 = tout garder) ; sa date et son état sont publiés sur la page À propos. À part, un administrateur peut créer un <b>instantané</b> nommé avant un changement risqué et le restaurer en un clic — mais un instantané ne contient pas les PIP, PDI, coaching, 9-box, litiges, cycle de vie, notifications ni le journal d’audit, et la restauration efface ce qu’il ne couvre pas. Une sauvegarde jamais restaurée est un espoir, pas un plan.',
    ],
    [
        'Where is the Local Content report? I cannot see it.',
        'Où est le rapport Contenu local ? Je ne le vois pas.',
        'It is an optional module and it is <b>off by default</b>: while it is off, /reports/local-content redirects to the dashboard for everyone, super admin included — a missing screen here is a switch, not a missing feature. A super admin enables it in Settings → <b>General</b> (<code>featureLocalContent</code>) and fills the home country there too, using one canonical spelling. A Nationality field then appears on employee records.',
        'C’est un module optionnel et il est <b>désactivé par défaut</b> : tant qu’il l’est, /reports/local-content redirige vers le tableau de bord pour tout le monde, super-administrateur compris — un écran absent est ici un interrupteur, pas une fonction manquante. Un super-administrateur l’active dans Réglages → <b>General</b> (<code>featureLocalContent</code>) et y renseigne le pays d’origine, avec une orthographe canonique unique. Un champ Nationalité apparaît alors sur les fiches.',
    ],
    [
        'Is there an HR role? Who settles a dispute nobody answered?',
        'Existe-t-il un rôle RH ? Qui tranche un litige que personne n’a traité ?',
        'There is no separate “HR” account type — the platform is manager-owned by design. HR is modelled as a local admin holding the <b>Arbitrate disputes</b> capability, and that person is the final (L2) arbiter for disputes a manager did not resolve in time. If no arbiter acts within the L2 SLA, the dispute <b>auto-finalises on the supervisor’s rating</b>, the reason is annotated “[auto-finalized: no HR decision within SLA]”, the employee is told their contested rating is now official, and the whole thing is logged. Everything stays inside the system and audited; nothing is handled off-platform.',
        'Il n’y a pas de type de compte « RH » distinct — la plateforme est pilotée par les managers par conception. Les RH sont modélisées comme un administrateur local détenant la capacité <b>Arbitrer les litiges</b>, et cette personne est l’arbitre final (L2) des litiges qu’un manager n’a pas résolus à temps. Si aucun arbitre n’agit dans le délai L2, le litige est <b>finalisé automatiquement sur la note du superviseur</b>, le motif est annoté « [auto-finalized: no HR decision within SLA] », le collaborateur est informé que sa note contestée est devenue officielle, et le tout est tracé. Tout reste dans le système et audité ; rien n’est traité hors plateforme.',
    ],
    [
        'As a manager, what can I do on a campaign?',
        'En tant que manager, que puis-je faire sur une campagne ?',
        'Since September 2026 you open the campaign console (/cycles) and see your team there: who has not started, who is in progress, who is waiting on your review, and how many days the campaign is overdue. You can chase — one report at a time, or "Chase all my non-starters" — and the same person is only chased once a day. Your landing page carries the item "N reports have not started campaign X". What stays with administration is the campaign itself: launching, extending, reopening, locking and closing decide what an entire population is measured on, and excusing someone (a written reason, kept in the log) belongs to an administrator holding "Manage campaigns" for their scope.',
        'Depuis septembre 2026 vous ouvrez la console de campagne (/cycles) et y voyez votre équipe : qui n’a pas démarré, qui est en cours, qui attend votre revue, et de combien de jours l’échéance est dépassée. Vous pouvez relancer — un collaborateur à la fois, ou « Relancer tous mes non-démarrés » — et une même personne n’est relancée qu’une fois par jour. Votre page d’accueil porte l’action « N collaborateurs n’ont pas démarré la campagne X ». Ce qui reste à l’administration, c’est la campagne elle-même : lancer, étendre, rouvrir, verrouiller et clôturer décident ce sur quoi toute une population est mesurée, et excuser quelqu’un (motif écrit, conservé au journal) revient à un administrateur détenant « Gérer les campagnes » sur son périmètre.',
    ],
    [
        'I am a manager but I get no weekly digest',
        'Je suis manager mais je ne reçois pas de récapitulatif hebdomadaire',
        'Three things decide it. The digest runs on a <b>configurable day and hour</b> (Monday 07:00 by default) — check those before assuming it is broken. It sends <b>nothing at all when there is nothing to say</b>, so an empty week produces no message, which is the intended behaviour rather than a failure. And for the email copy you need SMTP configured, the digest email category enabled, and an email address on your record; without those you still get the in-app copy in the 🔔 bell.',
        'Trois choses le déterminent. Le récapitulatif tourne un <b>jour et une heure configurables</b> (lundi 07:00 par défaut) — vérifiez-les avant de conclure à une panne. Il n’envoie <b>rien du tout quand il n’y a rien à dire</b>, donc une semaine vide ne produit aucun message : c’est le comportement voulu, pas un échec. Et pour la copie par e-mail il faut le SMTP configuré, la catégorie e-mail du récapitulatif activée, et une adresse e-mail sur votre fiche ; sans cela, vous conservez la copie interne dans la 🔔 cloche.',
    ],
    [
        'I built a report but cannot schedule it',
        'J’ai construit un rapport mais je ne peux pas le programmer',
        'A schedule sends a <b>saved template</b>, so save your report as a template in the report builder first — with no template the Schedules page says exactly that and offers nothing to pick. Then choose recipients (up to 20 valid addresses) and a frequency. The attachment format is <b>CSV</b>. Each run executes with the RBAC identity of whoever created the schedule, so recipients receive exactly what that person is allowed to see — check that before adding an audience.',
        'Une planification envoie un <b>modèle enregistré</b> : commencez donc par enregistrer votre rapport comme modèle dans le générateur — sans modèle, la page Planifications le dit et ne propose rien à choisir. Choisissez ensuite les destinataires (jusqu’à 20 adresses valides) et une fréquence. Le format de la pièce jointe est le <b>CSV</b>. Chaque exécution utilise l’identité RBAC du créateur de la planification : les destinataires reçoivent exactement ce que cette personne a le droit de voir — vérifiez-le avant d’ajouter une audience.',
    ],
    [
        'A dashboard shows zeros everywhere. Is the organisation empty?',
        'Un tableau de bord affiche des zéros partout. L’organisation est-elle vide ?',
        'Check your scope before your conclusions. An account with <b>no perimeter</b> sees a real population of zero: 0 employees covered, an empty skill matrix, “No sites found”, and a health score computed on nobody. <b>Those zeros describe the perimeter, not the organisation.</b> Reference data still shows — the framework, its pillars, sub-domains and roles are visible because they are not people data. If someone is meant to read numbers, give them a scope; without one the dashboard is not wrong, it is empty.',
        'Vérifiez votre périmètre avant vos conclusions. Un compte <b>sans périmètre</b> voit une population réellement nulle : 0 collaborateur couvert, une matrice vide, « Aucun site », et un score de santé calculé sur personne. <b>Ces zéros décrivent le périmètre, pas l’organisation.</b> Les données de référence restent visibles — le référentiel, ses piliers, sous-domaines et postes s’affichent parce que ce ne sont pas des données de personnes. Si quelqu’un doit lire des chiffres, donnez-lui un périmètre ; sans lui, le tableau de bord n’est pas faux, il est vide.',
    ],
    [
        'How do I remove a review, cancel a self-assessment, or cancel a plan that was raised in error?',
        'Comment retirer une revue, annuler une auto-évaluation ou annuler un plan créé par erreur ?',
        'As a <b>SuperAdmin</b>, from <b>Administration → Maintenance</b> (/admin/maintenance). Nothing is ever deleted there — each action is a state plus a written reason. On a self-assessment the button depends on its state: <b>Withdraw the review</b> while it is under review, sent back or reviewed by the supervisor (the review is withdrawn, the file returns to <i>submitted</i> exactly as the employee filed it and re-enters the reviewer’s queue); <b>Request a change</b> once it is <i>approved</i> (the approval and the lock are lifted, it goes back to the employee); <b>Cancel</b> for one that should not exist at all (it moves to <i>rejected</i>). The official skill level that was promoted is never rewritten by any of the three — it stays until a new approval replaces it. IDPs, PIPs and 9-box positions are cancelled from the same page, and an employee record entered twice is <b>voided</b> (reversible — not a departure, not an erasure). Every action bypasses the two-person cancellation rule on purpose and says so in the System Logs, on the movement feed and in the record’s own trail. Two things the panel refuses: a review under dispute (resolve the dispute first) and an assessment in arbitration (the manager decides it).',
        'En tant que <b>SuperAdmin</b>, depuis <b>Administration → Maintenance</b> (/admin/maintenance). Rien n’y est jamais supprimé — chaque action est un état plus un motif écrit. Sur une auto-évaluation, le bouton dépend de son état : <b>Retirer la revue</b> tant qu’elle est en revue, renvoyée ou revue par le superviseur (la revue est retirée, le dossier revient à <i>soumise</i> tel que le collaborateur l’a déposé et repasse dans la file du relecteur) ; <b>Demander une modification</b> une fois <i>approuvée</i> (la validation et le verrou sont levés, elle revient au collaborateur) ; <b>Annuler</b> pour une auto-évaluation qui n’aurait pas dû exister (elle passe à <i>rejetée</i>). Le niveau officiel promu n’est réécrit par aucune des trois — il reste jusqu’à ce qu’une nouvelle approbation le remplace. Les PDI, PIP et positionnements 9-box s’annulent depuis la même page, et une fiche collaborateur saisie deux fois est <b>vidée</b> (réversible — ni un départ, ni un effacement). Chaque action contourne volontairement la règle des quatre yeux et le dit dans les Journaux système, sur le fil des mouvements et dans la trace propre de l’enregistrement. Deux refus du panneau : une revue contestée (résolvez d’abord la contestation) et une auto-évaluation en arbitrage (c’est le manager qui tranche).',
    ],
    [
        'Can two accounts share the same e-mail address?',
        'Deux comptes peuvent-ils partager la même adresse e-mail ?',
        '<b>Yes.</b> An e-mail address is contact information, not an identity: a person may hold several accounts (an employee record and an admin account, two records across entities, a shared departmental mailbox). When you type an address that is already in use — on an employee, an admin, your own profile, or the Invitations console — the screen <b>advises</b> you (“already used by …”) and lets you continue; nothing is refused. The advisory names only the accounts you are allowed to see and counts the rest. Two things follow from it: <b>sign in with your username</b> when your address is shared (signing in by e-mail is refused when it would have to guess between accounts, and the audit line says why), and the <b>forgot-password</b> mail sends <b>one link per account</b>, each naming the account it resets. Single sign-on never auto-links a shared address either — the intended account is linked by its external id.',
        '<b>Oui.</b> Une adresse e-mail est une coordonnée, pas une identité : une personne peut détenir plusieurs comptes (une fiche collaborateur et un compte admin, deux fiches dans deux entités, une boîte de service partagée). Quand vous saisissez une adresse déjà utilisée — sur un collaborateur, un administrateur, votre propre profil ou la console des invitations — l’écran vous <b>avertit</b> (« déjà utilisée par … ») et vous laisse continuer ; rien n’est refusé. L’avertissement ne nomme que les comptes que vous avez le droit de voir et compte les autres. Deux conséquences : <b>connectez-vous avec votre identifiant</b> quand votre adresse est partagée (la connexion par e-mail est refusée dès qu’il faudrait deviner entre plusieurs comptes, et la ligne d’audit le dit), et le mail « mot de passe oublié » envoie <b>un lien par compte</b>, chacun nommant le compte concerné. L’authentification unique ne relie jamais automatiquement une adresse partagée non plus — le compte voulu est relié par son identifiant externe.',
    ],
    [
        'How do I switch language or theme?',
        'Comment changer de langue ou de thème ?',
        'Use the FR/EN switcher in the app (sidebar / top bar); your choice is remembered on that browser. Use the 🌙/☀️ icon for the dark or light theme. This guide has its own English / Français selector at the top — if it opens in the other language, switch it there.',
        'Utilisez le sélecteur FR/EN dans l’application (menu latéral / barre du haut) ; votre choix est mémorisé sur ce navigateur. Utilisez l’icône 🌙/☀️ pour le thème sombre ou clair. Ce guide possède son propre sélecteur English / Français en haut — s’il s’ouvre dans l’autre langue, changez-le là.',
    ],
];

const GETTING = [
    {
        // Stated on the FIRST card of the manual, and in both languages, because a
        // reader who meets "Norah HARTLEY, case « Étoile montante »" three pages in
        // has to know instantly that no colleague is being discussed. The previous
        // edition named real people and said nothing — which is how a talent
        // placement ended up legible to anyone holding the document.
        icon: '📖',
        img: null,
        title: { fr: 'Comment lire ce guide', en: 'How to read this guide' },
        where: {
            fr: 'À lire une fois, avant tout le reste',
            en: 'Read once, before anything else',
        },
        what: {
            fr: "Deux conventions traversent tout le manuel. <b>1. Les personnes citées sont fictives.</b> <i>Norah HARTLEY</i>, <i>Aïcha FARRELL</i>, <i>Zoumana WALSH</i>, <i>Souleymane LARSÈN</i> et les autres n'existent pas, et leurs matricules commencent par <code>DEMO-</code> pour qu'aucun doute ne subsiste. Les <b>chiffres</b>, eux, sont ceux que les écrans ont réellement affichés : ce sont les personnes qui ont été remplacées, pas les mesures. Un manuel ne doit jamais donner à lire le positionnement talent d'un collègue — une case 9-box ne se découvre que par une restitution assumée, par le manager, avec un motif écrit. <b>2. Une absence de mesure n'est pas un zéro.</b> Partout où le produit écrit <b>« — »</b> ou <b>« Non mesuré »</b>, cela signifie « jamais évalué » : ce n'est pas un niveau 0, ce n'est pas un écart, et ce n'est jamais arrondi. Un <b>0</b> est un constat ; un <b>«&nbsp;—&nbsp;»</b> est une question ouverte. Les deux appellent des actions différentes : « faire évaluer » et « faire former ».",
            en: "Two conventions run through the whole manual. <b>1. The people it names are invented.</b> <i>Norah HARTLEY</i>, <i>Aïcha FARRELL</i>, <i>Zoumana WALSH</i>, <i>Souleymane LARSÈN</i> and the rest do not exist, and their staff numbers start with <code>DEMO-</code> so that nothing is ambiguous. The <b>figures</b>, on the other hand, are the ones the screens actually displayed: the people were replaced, not the measurements. A manual must never let a colleague's talent placement be read — a 9-box cell is learnt through a deliberate disclosure, made by the manager, with a written reason. <b>2. An absence of measurement is not a zero.</b> Wherever the product writes <b>“—”</b> or <b>“Not measured”</b> it means “never assessed”: it is not a level 0, it is not a gap, and it is never rounded. A <b>0</b> is a finding; a <b>“—”</b> is an open question. They call for different actions: “go and measure” and “go and train”.",
        },
        tip: {
            fr: "Si vous reconnaissez un nom dans ce guide, c'est une coïncidence — et un défaut : signalez-le, la règle est qu'aucune personne réelle n'y figure.",
            en: 'If you recognise a name in this guide it is a coincidence — and a defect: report it, the rule is that no real person appears here.',
        },
    },
    {
        icon: '🚪',
        img: 'emp-00-login',
        title: { fr: 'Se connecter', en: 'Sign in' },
        where: { fr: 'Page /login', en: 'The /login page' },
        what: {
            fr: "L'écran affiche le titre <b>IDevelop — Système de gestion de la performance</b> et deux champs : <b>Nom d'utilisateur ou e-mail</b> et <b>Mot de passe</b>, avec le bouton <b>Se connecter</b>. Deux mentions accompagnent le formulaire : « <i>Le système détectera automatiquement votre profil à partir de vos identifiants</i> » — il n'y a pas de sélecteur de rôle à choisir — et « <i>Nouveau ici ? Créer un compte — un administrateur configurera votre accès</i> ». Après connexion, un collaborateur atterrit directement sur <b>/employee/dashboard</b>. Si l'authentification unique (SSO) est configurée, des boutons « Se connecter avec… » apparaissent sous le formulaire. Le lien <b>« Mot de passe oublié ? »</b> n'apparaît sur cette page que si l'envoi d'e-mails est configuré sur l'installation ; la page <b>/forgot-password</b> reste néanmoins accessible directement.",
            en: 'The screen shows the <b>IDevelop — Performance management system</b> title and two fields: <b>Username or email</b> and <b>Password</b>, with a <b>Sign in</b> button. Two notes accompany the form: “<i>The system will automatically detect your profile from your credentials</i>” — there is no role selector to pick — and “<i>New here? Create an account — an administrator will configure your access</i>”. After signing in, an employee lands directly on <b>/employee/dashboard</b>. If single sign-on is configured, “Sign in with…” buttons appear under the form. The <b>“Forgot your password?”</b> link only appears on this page when email sending is configured on the installation; the <b>/forgot-password</b> page stays reachable directly regardless.',
        },
        steps: {
            fr: [
                "Ouvrez l'adresse de l'application dans votre navigateur.",
                "Saisissez votre <b>nom d'utilisateur ou e-mail</b> et votre <b>mot de passe</b>, puis cliquez sur <b>Se connecter</b>.",
                "Ou, si un bouton SSO est affiché, utilisez l'authentification unique de votre organisation.",
                'À la première connexion, un changement de mot de passe peut vous être demandé.',
            ],
            en: [
                'Open the application address in your browser.',
                'Enter your <b>username or email</b> and your <b>password</b>, then click <b>Sign in</b>.',
                "Or, if an SSO button is shown, use your organisation's single sign-on.",
                'On first sign-in you may be asked to change your password.',
            ],
        },
    },
    {
        icon: '🙋',
        img: null,
        title: {
            en: 'New here? Create an account (self-onboarding)',
            fr: 'Nouveau ? Créer un compte (auto-inscription)',
        },
        where: {
            en: 'The “Create an account” link on /login (only when self-service onboarding is switched on)',
            fr: 'Le lien « Créer un compte » sur /login (seulement si l’onboarding en libre-service est activé)',
        },
        what: {
            en: 'Self-service onboarding is a switch an administrator turns on; it ships <b>off</b> on a fresh installation. When it is on, you can register yourself — but you do <b>not</b> get access immediately: your request waits in an Onboarding queue until an administrator places you into a <b>site, department, service and role</b> (those four are the mandatory fields), which is what actually creates your account. The same applies if you sign in through SSO without an existing account: a request is queued rather than an account created. If your email domain is not on the allow-list, the request is refused by default.',
            fr: 'L’onboarding en libre-service est un interrupteur qu’un administrateur active ; il est <b>désactivé</b> sur une installation neuve. Quand il est actif, vous pouvez vous inscrire vous-même — mais vous n’obtenez <b>pas</b> un accès immédiat : votre demande attend dans une file d’onboarding jusqu’à ce qu’un administrateur vous rattache à un <b>site, un département, un service et un poste</b> (ces quatre champs sont obligatoires), ce qui crée réellement votre compte. Idem si vous vous connectez via SSO sans compte existant : une demande est mise en file, aucun compte n’est créé. Si votre domaine d’e-mail n’est pas autorisé, la demande est refusée par défaut.',
        },
        steps: {
            en: [
                'On the login page, click <b>Create an account</b> (if the link is shown).',
                'Enter your <b>work email</b>, your name and a password of <b>at least 12 characters</b>, then submit.',
                'You land on an <b>“awaiting setup”</b> page. An administrator places you into the organization.',
                'Once placed, sign in with the <b>email</b> and password you registered (or via SSO).',
            ],
            fr: [
                'Sur la page de connexion, cliquez sur <b>Créer un compte</b> (si le lien est affiché).',
                'Saisissez votre <b>e-mail professionnel</b>, votre nom et un mot de passe d’<b>au moins 12 caractères</b>, puis validez.',
                'Une page <b>« en attente de configuration »</b> s’affiche. Un administrateur vous rattachera à l’organisation.',
                'Une fois rattaché, connectez-vous avec l’<b>e-mail</b> et le mot de passe d’inscription (ou via SSO).',
            ],
        },
        tip: {
            en: 'No password reaches an inbox and no access is granted until an admin reviews and places you — that is the security measure, not a delay.',
            fr: 'Aucun mot de passe n’est envoyé par e-mail et aucun accès n’est accordé tant qu’un administrateur ne vous a pas examiné et rattaché — c’est la mesure de sécurité, pas un retard.',
        },
    },
    {
        icon: '🧭',
        img: 'mgr-01-supervisor-dashboard',
        title: { en: 'Find your way around', fr: 'Se repérer' },
        where: { en: 'Left sidebar + top bar', fr: 'Menu latéral gauche + barre du haut' },
        what: {
            en: 'The left sidebar holds your menu, grouped and adapted to your profile. The real groups are <b>MAIN</b>, <b>MY SPACE</b>, <b>TEAM</b>, <b>TALENT</b>, <b>STEERING</b> and <b>COMPLIANCE &amp; AUDIT</b> — there is no "Talent &amp; Development" or "Tools" group. The top bar carries the 🔔 Action Center, the 🌙/☀️ theme toggle and your account menu (My profile, Notifications, Active Sessions, Change Password, Two-Factor Auth, About, User Guide, Log out).',
            fr: 'Le menu latéral gauche contient vos entrées, groupées et adaptées à votre profil. Les groupes réels sont <b>PRINCIPAL</b>, <b>MON ESPACE</b>, <b>ÉQUIPE</b>, <b>TALENTS</b>, <b>PILOTAGE</b> et <b>CONFORMITÉ &amp; SUIVI</b> — il n’existe pas de groupe « Talent &amp; Développement » ni « Outils ». La barre du haut porte le 🔔 centre d’actions, le bouton de thème 🌙/☀️ et votre menu de compte (Mon profil, Notifications, Sessions actives, Changer le mot de passe, Vérification en deux étapes, À propos, Guide de l’utilisateur, Déconnexion).',
        },
        steps: {
            en: [
                'Use the <b>left menu</b> to open features — what is not listed is not granted to you.',
                'Use the <b>🔔 bell</b> to see what needs your attention, and <b>View all</b> for the full <code>/notifications</code> page.',
                'Use your <b>account menu</b> (top-right) for your profile, sessions, password and this guide.',
            ],
            fr: [
                'Utilisez le <b>menu de gauche</b> pour ouvrir les fonctions — ce qui n’y figure pas ne vous est pas accordé.',
                'Utilisez la <b>🔔 cloche</b> pour voir ce qui vous attend, et <b>Voir tout</b> pour la page complète <code>/notifications</code>.',
                'Utilisez votre <b>menu de compte</b> (en haut à droite) pour votre profil, vos sessions, votre mot de passe et ce guide.',
            ],
        },
        tip: {
            en: 'A menu entry you cannot see is a capability you were not granted — not a broken page. Ask an administrator, and point them at your <b>My access</b> page.',
            fr: 'Une entrée de menu absente est une capacité non accordée — pas une page cassée. Demandez-la à un administrateur, en lui indiquant votre page <b>Mon accès</b>.',
        },
    },
    {
        icon: '🔐',
        img: null,
        imgRetired: 'emp-13-account',
        title: {
            en: 'Your account: email, notifications, sessions, password, 2FA',
            fr: 'Votre compte : e-mail, notifications, sessions, mot de passe, 2FA',
        },
        where: {
            en: 'Account menu (top-right): My profile (/account) · Notifications (/account/notifications) · Active Sessions (/account/sessions) · Change Password (/change-password) · Two-Factor Auth',
            fr: 'Menu de compte (en haut à droite) : Mon profil (/account) · Notifications (/account/notifications) · Sessions actives (/account/sessions) · Changer le mot de passe (/change-password) · Vérification en deux étapes',
        },
        what: {
            en: 'Five personal pages, all reachable by <b>every</b> signed-in user — none of them is admin-only. <b>My profile</b> (new in 3.22.85) is where you set your <b>email address</b>: it is the only address the "forgot password" link can reach, so filling it in is what makes self-service recovery possible at all. <b>Notifications</b> holds the email toggle and <b>quiet hours</b> (nothing is dropped, everything is deferred to the end of the window). <b>Active Sessions</b> lists the devices signed in as you, with "Sign out all other sessions (N)". <b>Change Password</b> enforces <b>at least 12 characters</b> with uppercase, lowercase, number and special character — announced on the field and enforced by the server. <b>Two-Factor Auth</b> adds a 6-digit code from an authenticator app plus 10 single-use backup codes.',
            fr: 'Cinq pages personnelles, accessibles à <b>tout</b> utilisateur connecté — aucune n’est réservée aux administrateurs. <b>Mon profil</b> (nouveau en 3.22.85) est l’endroit où vous saisissez votre <b>adresse e-mail</b> : c’est la seule adresse que le lien « mot de passe oublié » sait joindre, donc la renseigner est ce qui rend la récupération en libre-service possible. <b>Notifications</b> porte l’interrupteur e-mail et les <b>heures calmes</b> (rien n’est supprimé, tout est différé à la fin de la fenêtre). <b>Sessions actives</b> liste les appareils connectés sous votre compte, avec « Déconnecter toutes les autres sessions (N) ». <b>Changer le mot de passe</b> exige <b>au moins 12 caractères</b> avec majuscule, minuscule, chiffre et caractère spécial — annoncé sous le champ et appliqué par le serveur. <b>Vérification en deux étapes</b> ajoute un code à 6 chiffres d’une application d’authentification et 10 codes de secours à usage unique.',
        },
        steps: {
            en: [
                'Open <b>My profile</b> and fill in your <b>email address</b> — do it before you need it.',
                'Open <b>Notifications</b> to choose whether you get email, and to set quiet hours (fill in <b>both</b> times, or leave both empty).',
                'Open <b>Active Sessions</b> after using a shared machine and sign the other devices out.',
                'Use <b>Change Password</b> for a passphrase of 12+ characters; changing it signs out every other session.',
                'Turn on <b>Two-Factor Auth</b> and store the 10 backup codes somewhere other than that phone.',
            ],
            fr: [
                'Ouvrez <b>Mon profil</b> et renseignez votre <b>adresse e-mail</b> — faites-le avant d’en avoir besoin.',
                'Ouvrez <b>Notifications</b> pour choisir de recevoir ou non les e-mails, et régler les heures calmes (renseignez les <b>deux</b> heures, ou laissez-les vides).',
                'Ouvrez <b>Sessions actives</b> après avoir utilisé un poste partagé et déconnectez les autres appareils.',
                'Utilisez <b>Changer le mot de passe</b> pour une phrase de passe d’au moins 12 caractères ; le changement déconnecte toutes vos autres sessions.',
                'Activez la <b>vérification en deux étapes</b> et conservez les 10 codes de secours ailleurs que sur ce téléphone.',
            ],
        },
        tip: {
            en: 'Your name, employee number, role, site, department, service and supervisor are <b>not</b> editable on My profile — that is deliberate. Report an error there to your manager or HR administrator.',
            fr: 'Votre nom, matricule, poste, site, département, service et superviseur ne sont <b>pas</b> modifiables dans Mon profil — c’est volontaire. Signalez une erreur à votre responsable ou à l’administrateur RH.',
        },
    },
    {
        icon: '🌐',
        img: 'emp-17-guide',
        title: {
            en: 'Switch the app language (FR/EN) & get help anywhere',
            fr: 'Changer la langue (FR/EN) & obtenir de l’aide partout',
        },
        where: {
            en: 'Language switcher (sidebar/top bar) · the round “?” button, bottom-right of every page · User Guide (/guide)',
            fr: 'Sélecteur de langue (menu/barre du haut) · le bouton rond « ? » en bas à droite de chaque page · Guide de l’utilisateur (/guide)',
        },
        what: {
            en: 'The interface exists in French and English — one click switches it and the choice is remembered on that browser. On every page the round <b>“?”</b> button opens the contextual help panel with two tabs: <b>Current page</b> (what this screen is for, how to use it, good practices) and <b>Full manual</b>. The <b>/guide</b> page shows this manual filtered to your clearance: an employee sees “Your guide for: Employee” with the Start here, Employee, Processes, Glossary and FAQ sections and a reading-progress counter; the manager, admin and super-admin sections are simply not there.',
            fr: 'L’interface existe en français et en anglais — un clic change la langue et le choix est mémorisé sur ce navigateur. Sur chaque page, le bouton rond <b>« ? »</b> ouvre le panneau d’aide contextuelle à deux onglets : <b>Page actuelle</b> (à quoi sert l’écran, comment l’utiliser, bonnes pratiques) et <b>Manuel complet</b>. La page <b>/guide</b> affiche ce manuel filtré par votre habilitation : un collaborateur voit « Votre guide pour : Collaborateur » avec les sections Pour commencer, Collaborateur, Processus, Glossaire et FAQ et un compteur de progression de lecture ; les sections manager, administrateur et super-administrateur n’y figurent pas.',
        },
        steps: {
            en: [
                'Click the <b>FR/EN</b> switcher to change the interface language — it persists across visits.',
                'Stuck on a page? Click the <b>“?”</b> button (bottom-right): the <b>Current page</b> tab explains exactly where you are.',
                'The <b>Full manual</b> tab (or /guide) opens this guide, filtered to your profile; use its own <b>English / Français</b> selector if it opens in the other language.',
            ],
            fr: [
                'Cliquez sur le sélecteur <b>FR/EN</b> pour changer la langue — le choix est conservé.',
                'Bloqué sur une page ? Cliquez sur le bouton <b>« ? »</b> (en bas à droite) : l’onglet <b>Page actuelle</b> explique exactement où vous êtes.',
                'L’onglet <b>Manuel complet</b> (ou /guide) ouvre ce guide filtré selon votre profil ; utilisez son propre sélecteur <b>English / Français</b> s’il s’ouvre dans l’autre langue.',
            ],
        },
        tip: {
            en: 'The help panel answers “what do I do on THIS page?” — the manual answers “how does the whole process work?”. Use both.',
            fr: 'Le panneau d’aide répond à « que faire sur CETTE page ? » — le manuel répond à « comment fonctionne le processus complet ? ». Utilisez les deux.',
        },
    },
];

// ---------------------------------------------------------------------------
// End-to-end PROCESS FLOWS: who does what, in what order, a concrete example
// taken from the running instance, and the practices that make each work.
// ---------------------------------------------------------------------------
const FLOWS = [
    {
        icon: '🗓️',
        title: {
            fr: 'La campagne d’évaluation — du brouillon au niveau officiel, deux machines à états qui avancent ensemble',
            en: 'The assessment campaign — from draft to official level, two state machines advancing together',
        },
        actors: {
            fr: 'Admin avec « Gérer les campagnes » (crée, ouvre, verrouille, clôt) · Collaborateur (s’auto-évalue) · Superviseur ou Manager (revoit) · Admin local avec « Arbitrer les litiges » (arbitrage RH) · Le planificateur (verrouille à l’échéance)',
            en: 'Admin with “Manage cycles” (creates, opens, locks, closes) · Employee (self-assesses) · Supervisor or Manager (reviews) · Local admin with “Arbitrate disputes” (HR arbitration) · The scheduler (locks at the deadline)',
        },
        when: {
            fr: '1 à 2 fois par an. La campagne a quatre états : Brouillon → Ouverte → Verrouillée → Close (un brouillon peut aussi être Annulé avec un motif, et une campagne verrouillée rouverte avec une nouvelle échéance). Seul le lancement inscrit les participants.',
            en: 'Once or twice a year. A campaign has four states: Draft → Open → Locked → Closed (a draft can also be Cancelled with a reason, and a locked campaign reopened with a new deadline). Only launching enrols the participants.',
        },
        steps: {
            fr: [
                '<b>Créer</b> la campagne (Administration → Suivi des campagnes → « Nouvelle campagne ») : code unique, libellé, dates (la clôture ne peut précéder l’ouverture). Elle naît en <b>Brouillon</b> — personne n’y est encore inscrit, et la console l’affiche honnêtement : « Non lancée — aucun participant inscrit ».',
                '<b>Lancer</b> la campagne depuis sa console (super-administrateur). C’est le lancement, et lui seul, qui construit le <b>ROSTER</b> : tout collaborateur actif dont le poste porte des exigences est inscrit, avec le <b>nombre COMPLET de compétences attendues</b> conçu par son département, figé au lancement. Chacun reçoit l’annonce. La console passe alors de « non lancée » à un vrai décompte.',
                '<b>Chaque collaborateur</b> ouvre l’Auto-évaluation, note 0 à 4, ajoute au besoin une justification écrite dans la colonne <b>NOTES</b> et soumet. Une ligne <b>jamais notée reste NULL</b> — « pas encore répondu » n’est pas la note « Aucun (0) ».',
                '<b>À la soumission</b>, la plateforme crée la ligne de revue et la route : superviseur s’il existe, sinon manager, sinon la file de l’admin dont le périmètre couvre la personne. La revue naît <b>vide</b> : ni note superviseur, ni écart, ni date. Rien n’est affiché comme « d’accord » avant que quelqu’un ait regardé.',
                '<b>Le réviseur</b> ouvre la revue (l’état passe en « en revue »), puis choisit : <b>demander des modifications</b> (commentaire obligatoire, la ligne repart au collaborateur), <b>rejeter</b> (motif obligatoire, terminal — et la note reste NON MESURÉE, le rejet ne vaut pas accord), ou <b>approuver</b>. À l’approbation il peut saisir <b>sa propre note</b> ; s’il s’écarte de celle du collaborateur, <b>une raison courte est exigée</b> et l’enregistrement est refusé sans elle.',
                '<b>La note approuvée devient le NIVEAU OFFICIEL</b> : elle est écrite dans le profil de compétences avec la provenance « validé par le superviseur », et l’historique conserve l’avant/après. Un cours LMS terminé peut faire monter une compétence, mais <b>jamais par-dessus une décision de superviseur</b> — il s’arrête et le note.',
                '<b>Verrouiller</b> puis <b>clore</b>. Le verrouillage ferme la saisie et laisse les revues se terminer ; il est <b>automatique à l’échéance</b> (réglage « Tâches planifiées »), et les responsables qui détiennent encore des soumissions sont rappelés chaque semaine. Une campagne verrouillée trop tôt se <b>rouvre</b> avec une nouvelle échéance (les personnes encore attendues sont prévenues). Pendant la campagne, la console permet d’<b>excuser une personne</b> (catégorie + motif, éventuellement « jusqu’au ») et de <b>relancer</b> nommément les retardataires. La clôture finalise les lignes sans litige ouvert, marque « terminé » les seuls participants réellement arrivés au bout, écrit au journal ce qui manquait, et déclenche la génération des <b>PDI</b> à partir des écarts validés.',
            ],
            en: [
                '<b>Create</b> the campaign (Administration → Campaign tracking → “New campaign”): unique code, label, dates (closing cannot precede opening). It is born in <b>Draft</b> — nobody is enrolled yet, and the console says so honestly: “Not launched — no participant enrolled”.',
                '<b>Launch</b> it from its console (super administrator). Launching — and only launching — builds the <b>ROSTER</b>: every active employee whose role carries requirements is enrolled, with the <b>FULL department-designed count</b> of expected skills, frozen at launch. Everyone is announced to. The console then switches from “not launched” to a real count.',
                '<b>Each employee</b> opens Self-Assessment, rates 0–4, adds a written justification in the <b>NOTES</b> column where it helps, and submits. A line <b>never rated stays NULL</b> — “not answered yet” is not the rating “None (0)”.',
                '<b>On submission</b> the platform creates the review row and routes it: supervisor if one exists, else manager, else the queue of the admin whose scope covers the person. The review is born <b>empty</b>: no supervisor rating, no gap, no date. Nothing shows as “agreed” before someone has looked.',
                '<b>The reviewer</b> opens the review (state becomes “under review”), then chooses: <b>request changes</b> (comment mandatory, the line returns to the employee), <b>reject</b> (reason mandatory, terminal — and the rating stays UNMEASURED, a rejection is not an agreement), or <b>approve</b>. On approval they may enter <b>their own rating</b>; if it differs from the employee’s, <b>a short reason is required</b> and the save is refused without it.',
                '<b>The approved rating becomes the OFFICIAL LEVEL</b>: written into the skill profile with provenance “supervisor validated”, and the history keeps the before/after. A completed LMS course can raise a skill, but <b>never over a supervisor decision</b> — it stops and records why.',
                '<b>Lock</b> then <b>close</b>. Locking ends data entry and lets reviews finish; it happens <b>automatically at the deadline</b> (“Scheduled jobs” setting), and managers still holding submissions are reminded weekly. A campaign locked too early can be <b>reopened</b> with a new deadline (the people still expected are notified). While the campaign runs, the console lets you <b>excuse a person</b> (category + reason, optionally “until”) and <b>chase</b> latecomers by name. Closing finalises the lines with no open dispute, stamps “completed” only on the participants who genuinely finished, writes the shortfall to the log, and triggers <b>IDP</b> generation from the validated gaps.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives (parcours joué le 2026-09-02) :</b> la campagne <b>2026-Q3</b> est <i>Verrouillée</i>, ouverte le 01/06, échéance 31/08 ; 78 personnes inscrites pour <b>3 340 compétences attendues</b>. La console affiche « 0 % approuvé · 76 non commencés · 0 en revue · 78 personnes ». Sur un parcours joué de bout en bout : <b>Souleymane LARSÈN</b> note « Procurement Support » à 3 → il soumet (la revue naît note=NULL, écart=NULL, date=NULL) → son superviseur <b>Fabrice BECKER</b> ouvre la revue → demande une modification → Souleymane resoumet → le superviseur approuve <b>à 2</b> : sans raison la sauvegarde est <b>refusée</b> (« Merci d’indiquer une raison courte pour cette note différente ») ; avec la raison, la revue devient <i>terminée, décision=approuver, note=2, écart=−1</i> et le niveau officiel bascule à <b>2</b>, historisé comme <i>supervisor_review</i>. Les six campagnes « UAT » qui n’ont jamais été ouvertes affichent toutes « Non lancée — aucun participant inscrit » : l’absence de mesure y est nommée, pas convertie en 0 %.',
            en: '<b>Example, on invented people (run played on 2026-09-02):</b> campaign <b>2026-Q3</b> is <i>Locked</i>, opened 01/06, due 31/08; 78 people enrolled for <b>3,340 expected skills</b>. The console shows “0% approved · 76 not started · 0 in review · 78 people”. On a run played end to end: <b>Souleymane LARSÈN</b> rates “Procurement Support” 3 → submits (the review is born rating=NULL, gap=NULL, date=NULL) → his supervisor <b>Fabrice BECKER</b> opens the review → requests changes → Souleymane resubmits → the supervisor approves <b>at 2</b>: with no reason the save is <b>refused</b> (“Please give a short reason for rating this skill differently”); with the reason, the review becomes <i>completed, decision=approve, rating=2, gap=−1</i> and the official level moves to <b>2</b>, historised as <i>supervisor_review</i>. The six “UAT” campaigns that were never opened all read “Not launched — no participant enrolled”: the absence of measurement is named there, not converted into 0%.',
        },
        practices: {
            fr: [
                'Ouvrez la campagne pour de bon : tant qu’elle est en brouillon, personne n’est inscrit et aucun rappel ne part.',
                'Superviseurs : videz la file en jours. Une revue jamais ouverte n’affiche ni note ni écart — c’est voulu, et c’est visible.',
                'Demandez une justification écrite dans les NOTES sur les notes élevées ; les revues deviennent rapides et les litiges rares.',
                'Une note différente de celle du collaborateur se motive — le champ est obligatoire, ne le contournez pas par une note identique de complaisance.',
                'N’excluez jamais des COMPÉTENCES pour alléger une campagne : la seule exclusion prévue porte sur une PERSONNE, avec un motif.',
            ],
            en: [
                'Actually open the campaign: while it is a draft, nobody is enrolled and no reminder goes out.',
                'Supervisors: clear the queue in days. A review nobody opened shows no rating and no gap — that is deliberate, and it is visible.',
                'Ask for a written justification in the NOTES column on high ratings; reviews become fast and disputes rare.',
                'A rating that differs from the employee’s must be explained — the field is mandatory, do not dodge it with a complacent identical rating.',
                'Never exclude SKILLS to lighten a campaign: the only exclusion designed in applies to a PERSON, with a reason.',
            ],
        },
    },
    {
        icon: '🔁',
        title: {
            fr: 'Arrivée / Mobilité / Départ (JML) — et ce qu’un retour arrière défait, ou ne défait pas',
            en: 'Joiner / Mover / Leaver (JML) — and what a revert does, or does not, undo',
        },
        actors: {
            fr: 'Manager ou Admin (déclare l’événement) · La plateforme (exécute les effets) · SuperAdmin seul (retour arrière)',
            en: 'Manager or Admin (declares the event) · The platform (runs the effects) · SuperAdmin only (revert)',
        },
        when: {
            fr: 'À chaque arrivée, mutation ou départ. Trois types seulement : arrivée, mobilité, départ.',
            en: 'On every arrival, transfer or departure. Three kinds only: joiner, mover, leaver.',
        },
        steps: {
            fr: [
                '<b>Arrivée</b> — la personne est inscrite à la campagne ouverte (si aucune n’est ouverte, l’événement s’arrête là et le dit), et une ligne d’auto-évaluation vide est créée pour chaque compétence de son poste. <b>Ces lignes sont NULL, pas 0</b> : « pas encore évalué » ne doit jamais se lire comme la note « Aucun ». Le collaborateur reçoit sa notification d’accueil.',
                '<b>Mobilité</b> — l’historique d’évaluation est conservé, et un <b>plan de passation</b> est ouvert automatiquement, échéance 30 jours.',
                '<b>Départ</b> — le compte est désactivé, <b>toutes ses sessions sont révoquées</b>, un éventuel compte d’administration lié est désactivé et ses clés API révoquées (les identifiants exacts sont enregistrés dans l’événement), une tâche de purge des données personnelles est programmée selon le délai légal du pays, et un <b>plan de passation</b> s’ouvre, échéance 14 jours, pré-rempli de 5 rubriques : travaux en cours, contacts clés, systèmes et accès, tâches récurrentes, savoirs tacites. Le manager est notifié.',
                '<b>Le plan de passation se pilote</b> rubrique par rubrique. Il ne peut pas être marqué terminé tant qu’il reste une rubrique ouverte : la plateforme refuse et dit combien il en reste. Sans cette règle un plan « terminé » sortait de la liste de relance et n’était plus jamais poursuivi.',
                '<b>Retour arrière</b> (SuperAdmin uniquement, note obligatoire) : l’événement n’est jamais supprimé, il est <b>marqué annulé</b>, daté, signé, motivé.',
                '<b>Ce qu’un retour arrière DÉFAIT</b> : arrivée → supprime les seules lignes d’auto-évaluation restées vierges de la campagne d’origine ; départ → réactive le collaborateur, réactive les comptes d’administration et les clés API <b>dont l’événement avait consigné les identifiants</b>, supprime la purge de données non encore exécutée ; arrivée et départ → annule le plan de passation créé, <b>sauf s’il est déjà terminé</b>.',
                '<b>Ce qu’un retour arrière NE DÉFAIT PAS</b> : l’inscription à la campagne reste ; les rubriques de passation ne sont pas supprimées ; les sessions révoquées ne reviennent pas ; les notifications déjà parties restent ; le journal d’audit reste ; l’événement reste marqué « traité » ; et la réactivation <b>ajoute un nouveau mouvement</b> inactif→actif — l’historique s’allonge, il ne se réécrit pas. Une mobilité n’a rien de structurel à défaire : seul son plan de passation est annulé.',
            ],
            en: [
                '<b>Joiner</b> — the person is enrolled into the open campaign (if none is open the event stops there and says so), and one empty self-assessment line is created per skill of their role. <b>Those lines are NULL, not 0</b>: “not yet assessed” must never read as the rating “None”. The employee gets their welcome notification.',
                '<b>Mover</b> — assessment history is kept, and a <b>handover plan</b> opens automatically, due in 30 days.',
                '<b>Leaver</b> — the account is deactivated, <b>every session is revoked</b>, any linked admin account is deactivated and its API keys revoked (the exact ids are recorded on the event), a personal-data cleanup job is scheduled per the country’s legal delay, and a <b>handover plan</b> opens, due in 14 days, pre-seeded with 5 items: in-flight work, key contacts, systems &amp; access, recurring duties, tacit knowledge. The manager is notified.',
                '<b>The handover plan is driven</b> item by item. It cannot be marked completed while an item is still open: the platform refuses and says how many remain. Without that rule a “completed” plan dropped out of the chase list and was never followed up again.',
                '<b>Revert</b> (SuperAdmin only, note mandatory): the event is never deleted, it is <b>marked reverted</b>, dated, signed, explained.',
                '<b>What a revert DOES undo</b>: joiner → deletes only the self-assessment lines still untouched, in the origin campaign; leaver → reactivates the employee, reactivates the admin accounts and API keys <b>whose ids the event recorded</b>, deletes the not-yet-run data cleanup; joiner and leaver → cancels the handover plan it created, <b>unless it is already completed</b>.',
                '<b>What a revert does NOT undo</b>: the campaign enrolment stays; handover items are not deleted; revoked sessions do not come back; notifications already sent stay; the audit trail stays; the event stays marked “processed”; and reactivation <b>adds a new movement</b> inactive→active — history grows, it is not rewritten. A mover has nothing structural to undo: only its handover plan is cancelled.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives :</b> événement <i>départ</i> déclaré sur <b>Yao HALVORSEN (DEMO-3007)</b>. Effet immédiat : compte inactif, événement horodaté « traité » avec la liste (vide ici) des comptes admin et clés API révoqués, <b>plan de passation n°4 ouvert, échéance 2026-09-16</b>, propriétaire l’admin n°1, 5 rubriques créées, purge de données programmée au <b>2026-10-02</b> pour la Côte d’Ivoire, et un mouvement <i>statut : actif → inactif</i> capturé. Retour arrière ensuite : <i>{ réactivé: true, comptes admin réactivés: 0, clés API restaurées: 0 }</i> — le collaborateur redevient actif, le plan passe en <i>annulé</i> mais <b>ses 5 rubriques restent</b>, la purge disparaît, l’événement reste « traité », les notifications <i>lifecycle.leaver</i> restent, et un <b>second mouvement</b> <i>inactif → actif</i> vient s’ajouter au premier.',
            en: '<b>Example, on invented people:</b> a <i>leaver</i> event declared on <b>Yao HALVORSEN (DEMO-3007)</b>. Immediate effect: account inactive, event stamped “processed” with the (here empty) list of revoked admin accounts and API keys, <b>handover plan #4 opened, due 2026-09-16</b>, owner admin #1, 5 items created, data cleanup scheduled for <b>2026-10-02</b> for Côte d’Ivoire, and a movement <i>status: active → inactive</i> captured. Then the revert: <i>{ reactivated: true, adminAccountsReactivated: 0, apiKeysRestored: 0 }</i> — the employee is active again, the plan becomes <i>cancelled</i> but <b>its 5 items remain</b>, the cleanup disappears, the event stays “processed”, the <i>lifecycle.leaver</i> notifications stay, and a <b>second movement</b> <i>inactive → active</i> is appended to the first.',
        },
        practices: {
            fr: [
                'Déclarez le départ le jour où il est connu : la passation démarre à cet instant, pas la dernière semaine.',
                'Le retour arrière est une correction d’erreur de saisie, pas une annulation de décision RH — il ne rend ni les sessions, ni les messages déjà partis.',
                'Après un retour arrière de départ, vérifiez les clés API : seules celles que l’événement avait consignées reviennent ; sur un événement ancien, elles sont signalées « non consignées » plutôt que devinées.',
                'Ne fermez un plan de passation qu’une fois toutes ses rubriques terminées ou explicitement annulées.',
            ],
            en: [
                'Declare the departure the day it is known: the handover starts then, not in the final week.',
                'A revert is a data-entry correction, not the cancellation of an HR decision — it restores neither sessions nor messages already sent.',
                'After reverting a leaver, check the API keys: only those the event recorded come back; on a legacy event they are reported “not recorded” rather than guessed.',
                'Only close a handover plan once every item is completed or explicitly cancelled.',
            ],
        },
    },
    {
        icon: '🎯',
        title: {
            fr: 'Le plan de développement individuel (PDI) — d’où il vient, comment il s’active, comment il se ferme',
            en: 'The individual development plan (IDP) — where it comes from, how it activates, how it closes',
        },
        actors: {
            fr: 'La plateforme (génère) · Manager ou Superviseur (complète, signe) · Collaborateur (exécute, signe) · LMS (remonte les complétions)',
            en: 'The platform (generates) · Manager or Supervisor (fills in, signs) · Employee (executes, signs) · LMS (reports completions)',
        },
        when: {
            fr: 'Trois déclencheurs : la clôture d’une campagne, une 9-box en zone bleue, ou une création manuelle. Un seul plan ouvert par personne à la fois, toutes campagnes confondues.',
            en: 'Three triggers: closing a campaign, a blue-zone 9-box, or a manual creation. One open plan per person at a time, across all campaigns.',
        },
        steps: {
            fr: [
                '<b>Génération à la clôture d’une campagne</b> : la plateforme reprend chaque exigence où <b>le superviseur a lui-même relevé un niveau inférieur au requis</b> — jamais un rejet, jamais une auto-évaluation non validée — et crée un plan en brouillon, un objectif SMART par écart, une action de formation datée, reliée à la compétence.',
                '<b>Génération depuis la 9-box</b> : un positionnement approuvé en <b>zone bleue</b> (potentiel élevé / performance moyenne, ou potentiel moyen / performance élevée) propose un plan sur 180 jours pré-rempli des <b>5 plus gros écarts</b> du poste. Si un plan est déjà ouvert, il est adopté — jamais dupliqué.',
                '<b>Rédaction honnête des objectifs</b> : un écart sur une compétence <b>jamais évaluée</b> s’écrit « Atteindre le niveau N (niveau actuel non évalué) », et non « du niveau 0 au niveau N ». Le plan ne fabrique pas un point de départ qui n’a pas été mesuré.',
                '<b>Attacher les moyens</b> : un cours du catalogue LMS associé à la compétence est proposé automatiquement ; un plan de coaching peut être ouvert, obligatoirement rattaché à ce PDI.',
                '<b>Double signature</b> : le collaborateur et le superviseur signent chacun une fois (adresse IP et navigateur horodatés). <b>Quand les deux signatures sont là, le plan passe de brouillon à actif</b> et les deux parties sont notifiées.',
                '<b>Clôture d’une action</b> avec une note post-action : si elle dépasse le niveau connu, la compétence monte et l’écart se referme à la campagne suivante.',
                '<b>Annulation</b> : un PDI ne se supprime pas. Il se demande en annulation avec un motif, et un <b>second administrateur</b> décide — le demandeur ne peut pas approuver sa propre demande.',
            ],
            en: [
                '<b>Generated at campaign close</b>: the platform takes every requirement where <b>the supervisor personally recorded a level below the required one</b> — never a rejection, never an unvalidated self-rating — and creates a draft plan, one SMART objective per gap, one dated training action linked to the skill.',
                '<b>Generated from the 9-box</b>: an approved <b>blue-zone</b> placement (high potential / medium performance, or medium potential / high performance) proposes a 180-day plan pre-seeded with the role’s <b>5 largest gaps</b>. If a plan is already open it is adopted — never duplicated.',
                '<b>Honest objective wording</b>: a gap on a skill <b>never assessed</b> is written “Reach level N (current level not assessed)”, not “from level 0 to level N”. The plan does not invent a starting point nobody measured.',
                '<b>Attach the means</b>: a catalogue course mapped to the skill is proposed automatically; a coaching plan can be opened, compulsorily anchored to this IDP.',
                '<b>Dual sign-off</b>: employee and supervisor each sign once (IP and browser timestamped). <b>Once both signatures exist the plan moves from draft to active</b> and both parties are notified.',
                '<b>Closing an action</b> with a post-rating: if it exceeds the known level, the skill rises and the gap closes at the next campaign.',
                '<b>Cancellation</b>: an IDP is not deleted. It is requested for cancellation with a reason, and a <b>second administrator</b> decides — the requester cannot approve their own request.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives :</b> le manager approuve une 9-box <i>potentiel élevé / performance moyenne</i> (« Shooting Star », case 8) sur <b>Norah HARTLEY (DEMO-1115)</b>, poste <i>Data Platform Lead</i>. La plateforme crée immédiatement le <b>PDI n°12</b>, brouillon, priorité moyenne, du 2026-09-02 au 2027-03-01, avec <b>5 objectifs</b> tirés des plus gros écarts du poste : « Développer « Security, Privacy &amp; Compliance » du niveau 1 au niveau 4 », « … Ways of Working &amp; Operating Model Design … 1 au 4 », « … Adoption, Change &amp; Stakeholder Management … 1 au 3 », « … Business Problem Framing &amp; Value Orientation … 1 au 3 », « … Data Governance &amp; Quality … 1 au 3 ». La collaboratrice et son superviseur sont notifiés. Le plan reste en <i>brouillon</i> tant que les deux signatures ne sont pas là.',
            en: '<b>Example, on invented people:</b> the manager approves a <i>high potential / medium performance</i> 9-box (“Shooting Star”, box 8) on <b>Norah HARTLEY (DEMO-1115)</b>, role <i>Data Platform Lead</i>. The platform immediately creates <b>IDP #12</b>, draft, medium priority, 2026-09-02 → 2027-03-01, with <b>5 objectives</b> drawn from the role’s largest gaps: “Develop ‘Security, Privacy &amp; Compliance’ from level 1 to level 4”, “… Ways of Working &amp; Operating Model Design … 1 to 4”, “… Adoption, Change &amp; Stakeholder Management … 1 to 3”, “… Business Problem Framing &amp; Value Orientation … 1 to 3”, “… Data Governance &amp; Quality … 1 to 3”. Employee and supervisor are notified. The plan stays a <i>draft</i> until both signatures exist.',
        },
        practices: {
            fr: [
                'Un PDI ouvert à la fois par personne, toutes campagnes confondues : fermez l’ancien avant d’en attendre un nouveau.',
                'Deux à trois objectifs réels valent mieux que cinq vœux — le générateur en propose cinq, taillez.',
                'Datez les actions et clôturez-les avec une note : « fait » sans mesure n’apprend rien et ne fait pas bouger la couverture.',
                'Un objectif « niveau actuel non évalué » n’est pas une erreur d’affichage : c’est une invitation à faire évaluer la compétence d’abord.',
            ],
            en: [
                'One open IDP per person at a time, across all campaigns: close the old one before expecting a new one.',
                'Two or three real objectives beat five wishes — the generator proposes five, prune it.',
                'Date the actions and close them with a rating: “done” without measurement teaches nothing and moves no readiness figure.',
                'An objective reading “current level not assessed” is not a display bug: it is an invitation to get the skill assessed first.',
            ],
        },
    },
    {
        icon: '🛟',
        title: {
            fr: 'Le plan d’amélioration (PIP) — proposition, activation, clôture, et ce que « taux de réussite » signifie vraiment',
            en: 'The improvement plan (PIP) — proposal, activation, closure, and what “success rate” actually means',
        },
        actors: {
            fr: 'Manager (pilote toute la procédure, sans passage RH) · Collaborateur · La plateforme (l’ouvre elle-même sur une 9-box rouge) · Un second administrateur (pour toute annulation)',
            en: 'Manager (owns the whole procedure, no HR gate) · Employee · The platform (opens one itself on a red 9-box) · A second administrator (for any cancellation)',
        },
        when: {
            fr: 'Quand la performance reste sous la barre malgré le coaching — ou automatiquement dès qu’un positionnement 9-box en performance basse est approuvé.',
            en: 'When performance stays below the bar despite coaching — or automatically as soon as a low-performance 9-box placement is approved.',
        },
        steps: {
            fr: [
                '<b>Proposer</b> : objectifs, critères de réussite, points d’étape, appuis offerts, et surtout une <b>période datée</b> — début et fin. L’état est « proposé ». Un seul PIP ouvert par personne : la plateforme refuse le doublon plutôt que d’en empiler deux.',
                '<b>Ouverture automatique</b> : un positionnement 9-box approuvé en <b>performance basse</b> (quel que soit le potentiel) ouvre un PIP de <b>90 jours</b> et, avec lui, un <b>plan de coaching</b> dont les actions listent les écarts critiques du poste. Le texte du PIP ne nomme jamais la case de la grille — le positionnement reste confidentiel.',
                '<b>Activer</b> et l’annoncer en tête-à-tête. L’état passe à « actif » : <b>c’est le moment où la période commence réellement à courir</b>. Un PIP jamais activé n’a rien mesuré.',
                '<b>Accompagner</b> avec le plan de coaching associé : séances GROW, notes de progression, objectifs reportés d’une séance à l’autre.',
                '<b>Clore</b> avec un résultat : <b>réussite</b> ou <b>échec</b>, plus une note libre. La note explique, l’état décide.',
                '<b>Lire le taux de réussite honnêtement.</b> Le tableau de bord ne compte <b>que les clôtures dont la période a réellement couru</b> — une fin déclarée, et déjà atteinte au moment de la clôture. Un PIP ouvert et refermé le lendemain d’une période de trois mois n’est pas un succès : c’est une clôture administrative, et elle est comptée à part, sous « non mesuré ». Tant qu’il n’y a pas au moins <b>4 clôtures mesurées</b>, le tableau affiche « <b>Non mesuré</b> » et non un pourcentage.',
                '<b>Annuler</b> un PIP passe par une demande motivée décidée par un <b>second administrateur</b> ; l’état devient « annulé », rien n’est supprimé.',
            ],
            en: [
                '<b>Propose</b>: objectives, success criteria, review checkpoints, support offered, and above all a <b>dated period</b> — start and end. State is “proposed”. One open PIP per person: the platform refuses the duplicate rather than stacking two.',
                '<b>Automatic opening</b>: an approved 9-box placement at <b>low performance</b> (whatever the potential) opens a <b>90-day</b> PIP and, with it, a <b>coaching plan</b> whose actions list the role’s critical gaps. The PIP text never names the grid cell — the placement stays confidential.',
                '<b>Activate</b> it and say so face to face. State becomes “active”: <b>this is when the period actually starts running</b>. A PIP never activated measured nothing.',
                '<b>Support</b> through the paired coaching plan: GROW sessions, progress notes, objectives carried from one session to the next.',
                '<b>Close</b> with an outcome: <b>success</b> or <b>failure</b>, plus a free-text note. The note explains, the state decides.',
                '<b>Read the success rate honestly.</b> The dashboard counts <b>only the closures whose period actually ran</b> — a declared end date, already reached at the moment of closing. A PIP opened and shut the day after over a three-month period is not a success: it is an administrative closure, and it is counted separately, under “not measured”. Until there are at least <b>4 measured closures</b>, the dashboard shows “<b>Not measured</b>”, not a percentage.',
                '<b>Cancelling</b> a PIP goes through a reasoned request decided by a <b>second administrator</b>; the state becomes “cancelled”, nothing is deleted.',
            ],
        },
        example: {
            fr: '<b>Exemple observé (base de démonstration, 2026-09-02) :</b> quatre PIP existent — n°12 <i>proposé</i> (jamais activé), n°13 <i>échec</i> clos le 15/06 pour une période finissant le 31/12, n°14 <i>réussite</i> clos le 15/06 pour une période finissant le 31/07, n°19 <i>réussite</i> clos le 02/09 pour une période finissant le 30/11. <b>Aucune de ces quatre clôtures n’a laissé sa période courir</b>. L’agrégat lu en direct donne donc : 2 réussites, 1 échec, mais <b>0 clôture mesurée</b> — et le tableau de bord affiche « <b>Non mesuré</b> », pas « 67 % ». Un cinquième PIP joué en sonde (proposé le 02/09, période jusqu’au 01/12, activé, puis clos en réussite le jour même) n’a pas davantage bougé le compteur mesuré : il est resté à 0.',
            en: '<b>Observed example (demo dataset, 2026-09-02):</b> four PIPs exist — #12 <i>proposed</i> (never activated), #13 <i>failure</i> closed 15/06 over a period ending 31/12, #14 <i>success</i> closed 15/06 over a period ending 31/07, #19 <i>success</i> closed 02/09 over a period ending 30/11. <b>None of those four closures let its period run</b>. The live aggregate therefore reads: 2 successes, 1 failure, but <b>0 measured closures</b> — and the dashboard shows “<b>Not measured</b>”, not “67%”. A fifth PIP played as a probe (proposed 02/09, period to 01/12, activated, then closed as a success the same day) did not move the measured counter either: it stayed at 0.',
        },
        practices: {
            fr: [
                'Datez la fin, et respectez-la : sans date de fin atteinte, la clôture ne compte pas — et c’est ce qui protège la statistique.',
                'Activez le PIP. Un PIP « proposé » que l’on clôt n’a jamais rien mesuré, et la plateforme le dit.',
                'Des critères mesurables et atteignables dans la fenêtre : un PIP impossible est une lettre de licenciement déguisée.',
                'Consignez chaque séance : la documentation protège les DEUX parties.',
                'Un « Non mesuré » sur le taux de réussite n’est pas un bug : c’est le refus de publier une statistique sur trois dossiers refermés le jour de leur ouverture.',
            ],
            en: [
                'Set the end date, and respect it: without an end date that has been reached, the closure does not count — and that is what protects the statistic.',
                'Activate the PIP. A “proposed” PIP that gets closed never measured anything, and the platform says so.',
                'Criteria must be measurable and reachable inside the window: an impossible PIP is a dismissal letter in disguise.',
                'Log every session: the documentation protects BOTH sides.',
                'A “Not measured” success rate is not a bug: it is the refusal to publish a statistic based on three files shut the day they opened.',
            ],
        },
    },
    {
        icon: '🤝',
        title: {
            fr: 'Coaching et mentorat — toujours rattachés à quelque chose',
            en: 'Coaching and mentoring — always anchored to something',
        },
        actors: {
            fr: 'Manager, Superviseur ou Admin dans son périmètre (ouvre, valide) · Coach ou mentor désigné · Collaborateur',
            en: 'Manager, Supervisor or Admin within scope (opens, validates) · Named coach or mentor · Employee',
        },
        when: {
            fr: 'En continu. Un plan de coaching accompagne un PDI, un PIP, ou un écart de compétence précis — jamais rien d’autre.',
            en: 'Continuously. A coaching plan supports an IDP, a PIP, or one specific skill gap — never anything else.',
        },
        steps: {
            fr: [
                '<b>Choisir le contexte, obligatoirement</b> : PDI, PIP, ou écart de compétence. La plateforme refuse un plan sans rattachement (« Un plan de coaching/mentorat doit être lié à un contexte »), et vérifie que le PDI ou le PIP choisi appartient bien à cette personne.',
                '<b>Choisir la nature</b> : coaching ou mentorat. Le titre, l’objectif, le résultat attendu et une date cible.',
                '<b>Ajouter des actions</b> — sur un plan ouvert automatiquement par une 9-box rouge, elles sont déjà écrites, une par écart critique du poste.',
                '<b>Tenir les séances</b> en format GROW (Objectif, Réalité, Options, Chemin). Les objectifs encore ouverts d’une séance sont <b>reportés automatiquement</b> sur la suivante, avec le lien vers celle d’origine.',
                '<b>Suivre l’avancement</b> de 0 à 100 %. Le tableau de suivi distingue les plans actifs des plans <b>en retard</b> (date cible dépassée).',
                '<b>Valider la fin</b> : le plan passe à « terminé », 100 %, avec le nom du valideur et la date ; le collaborateur est notifié. Un plan déjà terminé ne peut pas être re-validé.',
                '<b>Plusieurs plans ouverts sont légitimes</b> pour une même personne — un par contexte. Ce n’est pas un doublon, et la plateforme ne l’empêche pas.',
            ],
            en: [
                '<b>Pick the context, compulsorily</b>: IDP, PIP, or skill gap. The platform refuses an unanchored plan (“A coaching/mentoring plan must be linked to a context”), and checks the chosen IDP or PIP really belongs to that person.',
                '<b>Pick the nature</b>: coaching or mentoring. Title, objective, expected outcome and a target date.',
                '<b>Add actions</b> — on a plan opened automatically by a red 9-box they are already written, one per critical gap of the role.',
                '<b>Run the sessions</b> in GROW format (Goal, Reality, Options, Way forward). Objectives still open at the end of a session are <b>carried forward automatically</b> to the next one, linked back to the original.',
                '<b>Track progress</b> 0 to 100%. The monitor separates active plans from <b>overdue</b> ones (target date passed).',
                '<b>Validate completion</b>: the plan becomes “completed”, 100%, with the validator’s name and date; the employee is notified. An already-completed plan cannot be re-validated.',
                '<b>Several open plans are legitimate</b> for one person — one per context. That is not a duplicate, and the platform does not block it.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives :</b> à l’approbation d’une 9-box <i>performance basse / potentiel bas</i> (« Concern ») sur <b>Norah HARTLEY</b>, la plateforme ouvre le PIP n°7 <b>et</b> le plan de coaching n°9, <i>actif</i>, contexte « pip », intitulé « Coaching to support PIP », avec ses actions déjà rédigées : « Develop “Security, Privacy &amp; Compliance” from level 1 to 4 », « Develop “Ways of Working &amp; Operating Model Design” from level 1 to 4 », « … Adoption, Change &amp; Stakeholder Management … 1 to 3 », « … Business Problem Framing &amp; Value Orientation … 1 to 3 ». Sur la base réelle, les 13 plans existants se répartissent en 5 actifs, 4 annulés, 4 terminés, et tous portent un contexte (« pip » ou « skill_gap »).',
            en: '<b>Example, on invented people:</b> on approving a <i>low performance / low potential</i> 9-box (“Concern”) on <b>Norah HARTLEY</b>, the platform opens PIP #7 <b>and</b> coaching plan #9, <i>active</i>, context “pip”, titled “Coaching to support PIP”, with its actions already written: “Develop ‘Security, Privacy &amp; Compliance’ from level 1 to 4”, “Develop ‘Ways of Working &amp; Operating Model Design’ from level 1 to 4”, “… Adoption, Change &amp; Stakeholder Management … 1 to 3”, “… Business Problem Framing &amp; Value Orientation … 1 to 3”. On a test instance the 13 existing plans split into 5 active, 4 cancelled, 4 completed, and every one carries a context (“pip” or “skill_gap”).',
        },
        practices: {
            fr: [
                'Un plan sans contexte est refusé — c’est voulu : le coaching sert un PDI, un PIP ou un écart nommé, sinon il ne se mesure pas.',
                'Datez la cible : c’est elle qui alimente la liste « en retard » du suivi.',
                'Laissez le report automatique faire son travail — un objectif non tenu réapparaît, il ne se perd pas entre deux séances.',
                'Validez la fin explicitement : sans validation, le plan reste actif et continue d’apparaître comme du travail en cours.',
            ],
            en: [
                'An unanchored plan is refused — deliberately: coaching serves an IDP, a PIP or a named gap, otherwise it cannot be measured.',
                'Set the target date: it is what feeds the monitor’s “overdue” list.',
                'Let the automatic carry-forward work — an unmet objective comes back, it is not lost between two sessions.',
                'Validate the ending explicitly: without validation the plan stays active and keeps showing as work in progress.',
            ],
        },
    },
    {
        icon: '🧭',
        title: {
            fr: 'La 9-box — proposition, approbation, remplacement par archivage, restitution, et les suites automatiques',
            en: 'The 9-box — proposal, approval, supersede-by-archive, disclosure, and the automatic follow-through',
        },
        actors: {
            fr: 'Superviseur (rédige la proposition) · Manager ou Admin dans son périmètre (approuve, restitue) · Comité de calibration (harmonise) · Collaborateur (ne voit rien avant restitution)',
            en: 'Supervisor (drafts the proposal) · Manager or Admin within scope (approves, discloses) · Calibration panel (harmonises) · Employee (sees nothing before disclosure)',
        },
        when: {
            fr: 'Après chaque campagne, et au minimum tous les 3 mois — la plateforme signale d’elle-même les positionnements à revoir.',
            en: 'After each campaign, and at least every 3 months — the platform flags placements due for review by itself.',
        },
        steps: {
            fr: [
                '<b>Proposition</b> : le superviseur note performance et potentiel (bas / moyen / élevé) ; la plateforme calcule la case (1 à 9) et son intitulé. Elle peut aussi <b>suggérer</b> une position à partir de la préparation mesurée — et quand la couverture d’évaluation est trop faible, elle le dit (« Non mesuré : 0 / N exigence(s) évaluée(s) ») et <b>ne descend jamais au niveau bas</b>, parce que c’est ce niveau qui déclenche un PIP.',
                '<b>Une seule proposition ouverte par personne</b> : réévaluer met à jour la proposition existante, cela n’en crée pas une deuxième.',
                '<b>Soumission puis approbation</b>. À l’approbation, <b>tout positionnement approuvé antérieur est archivé</b> — c’est le remplacement par archivage : rien n’est effacé, l’ancien passe en « archivé » avec la mention de ce qui l’a remplacé, et un seul positionnement approuvé subsiste par personne.',
                '<b>L’approbation est le point de déclenchement</b> : potentiel élevé/performance moyenne ou potentiel moyen/performance élevée → <b>PDI de 180 jours</b>. Performance basse → <b>aucun plan n’est ouvert par le logiciel</b> (arbitrage A3) : une <b>tâche</b> est créée pour le responsable hiérarchique, qui ouvre le plan d’amélioration avec un <b>motif écrit</b> — et peut le <b>retirer lui-même</b>, sans procédure à deux personnes. La « zone rouge » est <b>toute performance basse</b>, quel que soit le potentiel — <b>trois cases</b>, pas seulement le coin bas/bas ; et le coin haut/haut (« Gold Star ») ne déclenche <b>rien</b> : c’est une case de reconnaissance, pas une case d’action. Une seule tâche ouverte par personne, et aucune tâche si un plan est déjà ouvert.',
                '<b>Restitution</b> : le positionnement est <b>confidentiel par défaut</b>. Tant qu’il n’est pas explicitement restitué, le collaborateur ne le voit pas — et seul un positionnement <b>approuvé</b> peut être restitué. La restitution, comme son retrait, exige un <b>motif écrit</b> ; le positionnement garde <b>qui</b> l’a restitué et <b>quand</b>, et la personne voit ces trois éléments avec sa case. Aucun texte lisible par elle ne nomme la case tant qu’elle n’est pas restituée. La notification de restitution ne contient <b>aucune valeur</b>, juste le lien.',
                '<b>Calibration</b> : en séance, chaque déplacement exige une <b>justification</b> — la plateforme la refuse vide. La finalisation écrit le nouveau positionnement <b>dans les deux systèmes de lecture</b> (la grille et le référentiel talent) pour qu’ils ne divergent pas. Une séance <b>sans aucun ajustement n’est pas finalisée</b> : elle est rendue telle quelle, « aucun ajustement », plutôt que tamponnée « finalisée ».',
                '<b>Analyse de biais</b> : un balayage compare chaque site et chaque département à la moyenne. Sous <b>5 positionnements au total</b> ou <b>3 par groupe</b>, aucune alerte n’est produite — l’échantillon est déclaré trop petit, pas « conforme ».',
            ],
            en: [
                '<b>Proposal</b>: the supervisor rates performance and potential (low / medium / high); the platform computes the box (1 to 9) and its label. It can also <b>suggest</b> a position from measured readiness — and when assessment coverage is too thin it says so (“Not measured: 0 / N requirement(s) assessed”) and <b>never drops to the lower tier</b>, because that tier is what triggers a PIP.',
                '<b>One open proposal per person</b>: re-assessing updates the existing proposal, it does not create a second one.',
                '<b>Submit then approve</b>. On approval, <b>any earlier approved placement is archived</b> — that is supersede-by-archive: nothing is erased, the old one becomes “archived” with a note of what replaced it, and exactly one approved placement survives per person.',
                '<b>Approval is the trigger point</b>: high potential/medium performance or medium potential/high performance → <b>180-day IDP</b>. Low performance → <b>the software opens no plan</b> (arbitration A3): a <b>task</b> is raised for the hierarchical manager, who opens the improvement plan with a <b>written reason</b> — and can <b>withdraw it themselves</b>, with no two-person procedure. The “red zone” is <b>ALL low performance</b>, whatever the potential — <b>three cells</b>, not just the low/low corner; and the top-right corner (“Gold Star”) triggers <b>nothing</b>: it is a recognition cell, not an action cell. One open task per person, and no task at all if a plan is already open.',
                '<b>Disclosure</b>: the placement is <b>confidential by default</b>. Until it is explicitly disclosed the employee cannot see it — and only an <b>approved</b> placement can be disclosed. Disclosing it, and retracting it, both require a <b>written reason</b>; the placement keeps <b>who</b> disclosed it and <b>when</b>, and the person sees those three things beside their cell. No text they can read names the cell until it has been disclosed. The disclosure notification carries <b>no value at all</b>, only the link.',
                '<b>Calibration</b>: in session, every move requires a <b>rationale</b> — the platform refuses an empty one. Finalising writes the new placement <b>into both reading systems</b> (the grid and the talent record) so they cannot diverge. A session <b>with no adjustment at all is not finalised</b>: it is returned as-is, “no adjustments”, rather than stamped “finalised”.',
                '<b>Bias scan</b>: a sweep compares each site and department against the mean. Below <b>5 placements overall</b> or <b>3 per group</b>, no alert is produced — the sample is declared too small, not “clean”.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives (parcours joué le 13/09/2026) :</b> sur <b>Norah HARTLEY (DEMO-1115)</b>, un brouillon <i>bas/bas</i> — case 1, source « manager » — est soumis puis approuvé. Le journal de la grille enregistre <i>create</i>, <i>submit</i>, <i>approve</i>. À l’approbation, <b>aucun plan n’est créé</b> : la plateforme crée <b>une tâche</b> pour la responsable hiérarchique (employée 201) et la lui notifie, et écrit le miroir talent <i>box « low-low », source « override »</i>. La responsable ouvre ensuite le <b>PIP n°15</b> avec son motif écrit, et le <b>plan de coaching n°11</b> est rattaché à ce plan-là. Le positionnement reste <b>non restitué</b> : mesuré par HTTP, la page « Mon développement » de la collaboratrice ne contient <b>nulle part</b> l’intitulé de la case. Après restitution motivée par <i>uat.admin</i>, la même page affiche « <b>Point de vigilance</b> — communiqué par uat.admin le 13/09/2026 », avec le motif. Rejoué en <i>moyen/élevé</i> (case 8), c’est un <b>PDI</b> qui s’ouvre. En base, l’état des 37 positionnements est parlant : 23 archivés, 11 brouillons, 3 approuvés — l’archivage est bien le mécanisme de remplacement. Sur la liste 9-box, les personnes jamais positionnées sont affichées « <b>— non évalué — ⏰ À faire</b> », jamais rangées dans une case par défaut.',
            en: '<b>Example, on invented people (run played on 13/09/2026):</b> on <b>Norah HARTLEY (DEMO-1115)</b>, a <i>low/low</i> draft — box 1, source “manager” — is submitted then approved. The grid log records <i>create</i>, <i>submit</i>, <i>approve</i>. On approval <b>no plan is created</b>: the platform raises <b>one task</b> for the hierarchical manager (employee 201) and notifies her, and writes the talent mirror <i>box “low-low”, source “override”</i>. The manager then opens <b>PIP #15</b> with her written reason, and <b>coaching plan #11</b> is attached to that plan. The placement stays <b>undisclosed</b>: measured over HTTP, the employee’s “My development” page contains the cell name <b>nowhere</b>. After a reasoned disclosure by <i>uat.admin</i>, the same page shows “<b>Point de vigilance</b> — disclosed by uat.admin on 13/09/2026”, with the reason. Replayed as <i>medium/high</i> (box 8), it is an <b>IDP</b> that opens. On a test instance the state of the 37 placements tells the story: 23 archived, 11 drafts, 3 approved — archiving really is the supersede mechanism. On the 9-box roster, people never placed read “<b>— not assessed — ⏰ Due</b>”, never filed into a default box.',
        },
        practices: {
            fr: [
                'Calibrez avant de restituer : une justification écrite rend le positionnement défendable.',
                'Restituez en personne, en tête-à-tête. La grille ouvre une conversation, elle ne rend pas un verdict.',
                'Ne restituez jamais une proposition : seule une position approuvée peut l’être, et la plateforme le refuse autrement.',
                'Une suggestion « non mesuré » signifie qu’il faut évaluer avant de positionner, pas positionner au jugé.',
                'Lancez l’analyse de biais à chaque campagne — et lisez « échantillon trop petit » comme « on ne sait pas », pas comme « rien à signaler ».',
            ],
            en: [
                'Calibrate before disclosing: a written rationale makes the placement defensible.',
                'Disclose in person, one to one. The grid starts a conversation, it does not hand down a verdict.',
                'Never disclose a proposal: only an approved placement can be, and the platform refuses otherwise.',
                'A “not measured” suggestion means assess first, then place — not place on a hunch.',
                'Run the bias scan every campaign — and read “sample too small” as “we do not know”, not as “nothing to report”.',
            ],
        },
    },
    {
        icon: '🔗',
        title: {
            fr: 'Continuité — rôles critiques, viviers de succession, risque de perte et passations',
            en: 'Continuity — critical roles, succession benches, risk of loss and handovers',
        },
        actors: {
            fr: 'Manager ou Admin avec « Gérer la succession » (son périmètre) · Admin avec « Gérer le risque de rétention » · Le planificateur (recalcule, relance)',
            en: 'Manager or Admin with “Manage succession” (their scope) · Admin with “Manage retention risk” · The scheduler (recomputes, chases)',
        },
        when: {
            fr: 'Revue tous les 6 mois par plan — la plateforme la réclame elle-même — et action immédiate à tout départ sur un rôle critique.',
            en: 'Every plan is reviewed every 6 months — the platform asks for it itself — and immediately on any departure from a critical role.',
        },
        steps: {
            fr: [
                '<b>Marquer les rôles critiques</b> : un score de criticité de 1 à 5, un risque de vacance (bas / moyen / élevé), un impact métier, un délai de recrutement. <b>Le risque de vacance n’est pas calculé</b> : c’est un jugement humain, saisi et assumé. Un rôle est traité comme critique <b>à partir du score 4</b> — porter une fiche de criticité ne suffit pas.',
                '<b>Créer un plan de succession</b> par rôle critique — <b>un seul plan non archivé par rôle</b>. La plateforme fixe elle-même la prochaine revue à 6 mois.',
                '<b>Alimenter le vivier</b> : la plateforme propose les meilleurs candidats en calculant leur préparation contre le référentiel du rôle cible, avec un seuil plancher. Le classement en découle : <b>≥ 90 % → prêt maintenant, ≥ 70 % → 1-2 ans, sinon 3 ans et plus</b>. La bande « <b>relève d’urgence</b> » n’est <b>jamais attribuée automatiquement</b> — c’est une désignation humaine, comme la relève d’urgence nommée séparément sur le plan.',
                '<b>Un certificat périmé fait tomber le niveau effectif à 0</b> dans ce calcul de préparation : on ne classe pas « prêt » quelqu’un dont l’habilitation n’est plus valide.',
                '<b>Risque de perte</b> : la plateforme recalcule chaque nuit un score sur 100 = impact de la perte (jusqu’à 50, tiré du positionnement 9-box) + risque de départ (jusqu’à 50 : haut potentiel sans PDI actif, PIP en cours, moral en baisse mesuré par les sondages). Un manager peut forcer les bandes à la main ; le score, lui, continue d’être recalculé pour l’audit.',
                '<b>Confidentialité stricte du risque de perte</b> : <b>personne ne voit son propre dossier</b> — la requête l’exclut explicitement, et une tentative de recalcul ou de forçage sur soi-même est refusée. La clé de positionnement 9-box est <b>retirée</b> des facteurs renvoyés à un manager, parce que cette page couvre toute son arborescence alors que la 9-box, elle, ne se restitue que nominativement. Le manager n’est prévenu qu’au <b>franchissement</b> vers « élevé », une fois, et seulement en compte de personnes.',
                '<b>Passation</b> : ouverte automatiquement à toute mobilité (30 jours) ou tout départ (14 jours), avec ses 5 rubriques. La liste de relance ne réclame que ce qui est <b>en retard</b>, <b>bientôt dû avec des rubriques ouvertes</b>, ou <b>dormant depuis 30 jours sans date</b> — un plan qui vient d’être créé n’est délibérément pas réclamé.',
                '<b>Revue de cadence</b> : chaque semaine, la plateforme envoie <b>une seule</b> notification agrégée par destinataire — plans en retard de revue et rôles critiques sans vivier, en compte, sans nommer personne.',
            ],
            en: [
                '<b>Mark the critical roles</b>: a criticality score 1 to 5, a vacancy risk (low / medium / high), a business impact, a time to fill. <b>Vacancy risk is not calculated</b>: it is a human judgement, entered and owned. A role counts as critical <b>from score 4 upwards</b> — merely carrying a criticality record is not enough.',
                '<b>Create a succession plan</b> per critical role — <b>one non-archived plan per role</b>. The platform sets the next review at 6 months by itself.',
                '<b>Seed the bench</b>: the platform proposes the best candidates by computing their readiness against the target role’s framework, with a floor. The banding follows: <b>≥ 90% → ready now, ≥ 70% → 1–2 years, otherwise 3+ years</b>. The “<b>emergency</b>” band is <b>never assigned automatically</b> — it is a human designation, as is the emergency cover named separately on the plan.',
                '<b>A lapsed certificate drops the effective level to 0</b> in that readiness computation: nobody is banded “ready” while their ticket is no longer valid.',
                '<b>Risk of loss</b>: the platform recomputes a score out of 100 every night = impact of loss (up to 50, from the 9-box placement) + flight risk (up to 50: high potential with no active IDP, a live PIP, morale falling in the surveys). A manager may force the bands by hand; the score keeps being recomputed for audit.',
                '<b>Strict confidentiality of risk of loss</b>: <b>nobody sees their own record</b> — the query excludes them explicitly, and recomputing or overriding one’s own is refused. The 9-box key is <b>stripped</b> from the factors returned to a manager, because that page spans their whole sub-tree while the 9-box is only disclosed person by person. The manager is told only on a <b>crossing</b> into “high”, once, and only as a count.',
                '<b>Handover</b>: opened automatically on every mover (30 days) or leaver (14 days), with its 5 items. The chase list only asks for what is <b>overdue</b>, <b>due soon with open items</b>, or <b>dormant for 30 days with no date</b> — a freshly created plan is deliberately not chased.',
                '<b>Review cadence</b>: every week the platform sends <b>one</b> aggregated notification per recipient — plans past their review date and critical roles with no bench, as counts, naming nobody.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives :</b> l’événement <i>départ</i> sur <b>Yao HALVORSEN</b> ouvre le plan de passation n°4, échéance <b>2026-09-16</b>, propriétaire l’admin n°1, et ses cinq rubriques (« In-flight work &amp; deadlines », « Key contacts &amp; stakeholders », « Systems, accounts &amp; access », « Recurring duties &amp; cadence », « Tacit knowledge &amp; gotchas »). Sur la base réelle, <b>78 fiches de risque de rétention</b> sont calculées, tandis que <b>0 plan de succession et 0 rôle marqué critique</b> existent : le module attend d’être amorcé, et l’écran « Commencer » de Continuité le dit plutôt que d’afficher une couverture de 100 %. Les cinq plans de passation existants sont quatre <i>ouverts</i> et un <i>terminé</i>, ce dernier avec un remplaçant nommé et une échéance au 31/12.',
            en: '<b>Example, on invented people:</b> the <i>leaver</i> event on <b>Yao HALVORSEN</b> opens handover plan #4, due <b>2026-09-16</b>, owner admin #1, with its five items (“In-flight work &amp; deadlines”, “Key contacts &amp; stakeholders”, “Systems, accounts &amp; access”, “Recurring duties &amp; cadence”, “Tacit knowledge &amp; gotchas”). On a test instance <b>78 retention-risk records</b> are computed, while <b>0 succession plans and 0 roles marked critical</b> exist: the module is waiting to be seeded, and Continuity’s “Get started” panel says so rather than showing 100% coverage. The five existing handover plans are four <i>open</i> and one <i>completed</i>, the latter with a named incoming person and a 31/12 due date.',
        },
        practices: {
            fr: [
                'Un rôle n’est critique qu’à partir du score 4 — au-dessous, il ne remonte dans aucune alerte de vivier.',
                'Chaque rôle critique a au moins un « prêt maintenant » OU une relève d’urgence nommée. « On verra » n’est pas un plan.',
                'Le risque de perte est confidentiel par conception — personne ne voit le sien. Tenez la même règle dans les conversations.',
                'Commencez la passation le jour où le départ est connu ; le plan ne se ferme qu’une fois toutes les rubriques soldées.',
                'Un vivier vide se lit comme un vivier vide : la plateforme le compte et le réclame, elle ne le comble pas d’office.',
            ],
            en: [
                'A role is critical only from score 4 up — below that it appears in no bench alert.',
                'Every critical role has at least one “ready now” OR a named emergency cover. “We’ll figure it out” is not a plan.',
                'Risk of loss is confidential by design — nobody sees their own. Hold the same line in conversation.',
                'Start the handover the day the departure is known; the plan closes only once every item is settled.',
                'An empty bench reads as an empty bench: the platform counts it and chases it, it does not fill it in for you.',
            ],
        },
    },
    {
        icon: '🎖️',
        title: {
            fr: 'Certification et conformité — validité, fenêtre de revalidation, péremption, couverture de poste',
            en: 'Certification and compliance — validity, revalidation window, lapse, position coverage',
        },
        actors: {
            fr: 'Admin avec « Gérer la conformité » (politiques, règles) · Manager (relances d’équipe) · Collaborateur (dépose son titre) · Le planificateur (alerte, prédit)',
            en: 'Admin with “Manage compliance” (policies, rules) · Manager (team chasing) · Employee (files their ticket) · The scheduler (alerts, predicts)',
        },
        when: {
            fr: 'Politique définie une fois par compétence certifiante. Ensuite tout est automatique : alertes à 90, 60, 30 jours et à l’expiration.',
            en: 'Policy set once per certifying skill. After that everything is automatic: alerts at 90, 60, 30 days and on expiry.',
        },
        steps: {
            fr: [
                '<b>Déclarer la politique</b> sur la compétence : durée de validité en mois (<b>vide = ne périme jamais</b>), <b>fenêtre de revalidation</b> en jours (défaut 90), et durée de décroissance éventuelle.',
                '<b>Enregistrer un titre</b> : numéro, date de délivrance, pièce jointe analysée par antivirus. La date d’expiration est calculée depuis la politique si elle n’est pas fournie, en <b>butant sur le dernier jour du mois</b> plutôt qu’en débordant. Une délivrance <b>datée dans le futur est refusée</b> — sans cette règle un titre postdaté redevenait « le certificat courant » et masquait une péremption réelle.',
                '<b>Quatre états, et pas un de plus</b> : <b>valide</b> · <b>expirant</b> (dans la fenêtre de revalidation — encore valide aujourd’hui, c’est une piste d’atterrissage, pas une perte d’habilitation) · <b>expiré</b> · <b>sans échéance</b>. Une personne <b>qui n’a jamais eu de titre n’a aucun état</b> : elle est absente de la liste, elle n’est pas « expirée ».',
                '<b>Péremption</b> : quelqu’un qui a détenu un titre et ne l’a plus. Son <b>niveau effectif tombe à 0</b> pour cette compétence dans la préparation, le benchmark et la succession — mais l’évaluation reste enregistrée : ce qui bouge, c’est le verdict « cette personne est-elle qualifiée aujourd’hui », pas la mesure. La cause est distinguée : <b>expiré</b> ou <b>révoqué</b>.',
                '<b>Révocation</b> : elle notifie la personne. Auparavant on cessait d’être qualifié en silence.',
                '<b>Règles de couverture de poste</b> (« safe-shift ») : sur un périmètre, une compétence, un niveau minimum et un effectif minimum qualifié. Le niveau minimum est borné à l’<b>échelle réelle 1 à 4</b> — une règle « ≥ 5 » était insatisfaisable, donc une alerte permanente. Une règle <b>peut exiger un certificat valide</b>, et c’est ce réglage qui décide si un porteur périmé compte encore : sans lui, il compte ; avec lui, il est écarté.',
                '<b>Prédiction</b> : sur 14 jours, la plateforme projette les absences planifiées et les expirations de certificats, et signale une règle qui <b>va</b> passer sous son minimum, avec la date.',
                '<b>Alerte une seule fois par transition</b>, jamais à chaque tour d’horloge, et au-delà de 25 règles en rupture, un <b>seul</b> message groupé part — le plafond limite le bruit, jamais l’enregistrement.',
            ],
            en: [
                '<b>Declare the policy</b> on the skill: validity in months (<b>empty = never expires</b>), <b>revalidation window</b> in days (default 90), and an optional decay period.',
                '<b>Record a certificate</b>: number, issue date, virus-scanned attachment. The expiry is computed from the policy when not supplied, <b>clamping to the last day of the month</b> rather than overflowing. An issue date <b>in the future is refused</b> — without that rule a post-dated ticket became “the current certificate” and hid a real lapse.',
                '<b>Four states, and no more</b>: <b>valid</b> · <b>expiring</b> (inside the revalidation window — still valid today, that is a runway, not a loss of qualification) · <b>expired</b> · <b>no expiry</b>. Somebody <b>who never held a ticket has no state at all</b>: they are absent from the list, they are not “expired”.',
                '<b>Lapse</b>: somebody who held a certificate and no longer does. Their <b>effective level drops to 0</b> for that skill in readiness, benchmark and succession — but the assessment record stays: what moves is the verdict “is this person qualified today”, not the measurement. The cause is distinguished: <b>expired</b> or <b>revoked</b>.',
                '<b>Revocation</b> notifies the person. Before, one stopped being qualified in silence.',
                '<b>Position coverage rules</b> (“safe-shift”): a scope, a skill, a minimum level and a minimum qualified headcount. The minimum level is bounded to the <b>real 1–4 scale</b> — a “≥ 5” rule was unsatisfiable, hence a permanent alert. A rule <b>may require a valid certificate</b>, and that switch decides whether a lapsed holder still counts: without it they do; with it they are excluded.',
                '<b>Prediction</b>: over 14 days the platform projects planned absences and certificate expiries, and flags a rule that <b>will</b> fall below its minimum, with the date.',
                '<b>Alert once per transition</b>, never once per tick, and beyond 25 breached rules a <b>single</b> batched message goes out — the cap limits the paging, never the record.',
            ],
        },
        example: {
            fr: '<b>Exemple observé (2026-09-02) :</b> la politique de « <b>Budget &amp; Cost Control</b> » est : validité 12 mois, fenêtre de revalidation 90 jours, décroissance 6 mois. Le seul titre en base — n° <b>VOC-TEST-001</b>, délivré le 31/08/2025, expirant le <b>14/09/2026</b> — est en état « <b>expirant</b> », à <b>12 jours</b> de l’échéance : il est <b>encore valide</b>, et l’écran Conformité l’affiche bien en « EXPIRANT (DANS LA FENÊTRE) 1 », avec « VALIDE 0 », « EXPIRÉ 0 » et « NIVEAUX DE COMPÉTENCE PÉRIMÉS 0 ». La liste des périmés est <b>vide</b> — personne n’a perdu d’habilitation. La règle « Demo — coverage: Budget &amp; Cost Control (IT) » exige ≥ 1 personne au niveau ≥ 1, sans certificat valide obligatoire : elle compte <b>5 qualifiés</b> et est <b>COUVERTE</b>, sans rupture prévue.',
            en: '<b>Observed example (2026-09-02):</b> the “<b>Budget &amp; Cost Control</b>” policy is: 12 months validity, 90-day revalidation window, 6-month decay. The only certificate on file — no. <b>VOC-TEST-001</b>, issued 31/08/2025, expiring <b>14/09/2026</b> — is “<b>expiring</b>”, <b>12 days</b> out: it is <b>still valid</b>, and the Compliance screen shows exactly “EXPIRING (IN WINDOW) 1”, with “VALID 0”, “EXPIRED 0” and “LAPSED SKILL LEVELS 0”. The lapsed list is <b>empty</b> — nobody has lost a qualification. The rule “Demo — coverage: Budget &amp; Cost Control (IT)” requires ≥ 1 person at level ≥ 1, with no valid-certificate requirement: it counts <b>5 qualified</b> and reads <b>COVERED</b>, with no predicted breach.',
        },
        practices: {
            fr: [
                '« Expirant » veut dire « encore valide, renouvelez maintenant » — ne le lisez pas comme une rupture.',
                'Aucun certificat au dossier n’est pas la même chose qu’un certificat expiré : le premier ne dégrade rien, le second ramène le niveau effectif à 0.',
                'Cochez « certificat valide obligatoire » sur les règles où la loi l’exige — c’est ce réglage, et lui seul, qui exclut un porteur périmé du décompte.',
                'Ne générez pas la grille de règles d’un coup sans passer par l’aperçu : il annonce combien de règles seraient en rupture à l’instant de leur création.',
                'Une date de délivrance ne se saisit jamais dans le futur ; la plateforme le refuse, et c’est ce qui protège la lecture de conformité.',
            ],
            en: [
                '“Expiring” means “still valid, renew now” — do not read it as a breach.',
                'No certificate on file is not the same as an expired one: the first degrades nothing, the second drops the effective level to 0.',
                'Tick “valid certificate required” on the rules the law demands it for — that switch, and only that switch, excludes a lapsed holder from the count.',
                'Do not bulk-generate the rule grid without the preview: it states how many rules would be in breach the moment they exist.',
                'An issue date is never entered in the future; the platform refuses it, and that is what protects the compliance reading.',
            ],
        },
    },
    {
        icon: '⚖️',
        title: {
            fr: 'Contester une revue — l’échelle L0 → L1 → L2 et le délai qui l’empêche de bloquer',
            en: 'Contesting a review — the L0 → L1 → L2 ladder and the SLA that stops it blocking',
        },
        actors: {
            fr: 'Collaborateur (ouvre) · Superviseur (L0) · Manager (L1) · Admin local avec « Arbitrer les litiges » — l’arbitrage RH (L2) · Le planificateur (escalade toutes les 15 minutes)',
            en: 'Employee (opens) · Supervisor (L0) · Manager (L1) · Local admin with “Arbitrate disputes” — the HR arbitration (L2) · The scheduler (escalates every 15 minutes)',
        },
        when: {
            fr: 'Dès qu’un collaborateur n’est pas d’accord avec la note retenue. Trois délais réglables dans Réglages → Litiges.',
            en: 'As soon as an employee disagrees with the recorded rating. Three SLAs, configurable in Settings → Disputes.',
        },
        steps: {
            fr: [
                '<b>Ouvrir</b> le litige avec un motif. Effet immédiat : la ligne d’auto-évaluation repasse en <b>provisoire</b>, la revue est marquée <b>contestée</b>, et le superviseur qui a noté est prévenu.',
                '<b>Un litige ouvert empêche la clôture de finaliser cette ligne</b> — c’est exactement pourquoi l’échelle est minutée : sans délai, un litige oublié bloquerait la campagne indéfiniment.',
                '<b>L0 — le superviseur</b> tranche dans les <b>5 jours</b> (défaut). Il fixe la note retenue et motive ; le motif est obligatoire.',
                '<b>Escalade automatique vers L1</b> passé le délai : le litige devient « escaladé », et <b>le manager du collaborateur</b> est prévenu. Il a <b>7 jours</b> (défaut), comptés depuis l’escalade.',
                '<b>Escalade automatique vers L2</b> passé ce second délai : l’<b>arbitrage RH</b> — un admin local détenteur de la permission « Arbitrer les litiges ». Il est prévenu une seule fois par lot, avec le nombre de dossiers, jamais un message par dossier. Il a <b>7 jours</b> (défaut).',
                '<b>Finalisation automatique</b> si l’arbitrage n’a pas eu lieu : le litige passe à « finalisé automatiquement », <b>sur la note du superviseur</b>, avec la mention « [auto-finalized: no HR decision within SLA] » ajoutée au motif, la revue est marquée terminée, la ligne est finalisée, et le collaborateur est prévenu que sa note contestée est devenue officielle. Le tout est tracé au journal.',
                '<b>À chaque niveau, la décision écrit la note retenue dans le profil officiel</b> et lève le verrou de la ligne, de sorte que la campagne peut se clore.',
            ],
            en: [
                '<b>Open</b> the dispute with a reason. Immediate effect: the self-assessment line goes back to <b>provisional</b>, the review is marked <b>disputed</b>, and the supervisor who rated is notified.',
                '<b>An open dispute stops the close from finalising that line</b> — which is exactly why the ladder is timed: with no SLA, one forgotten dispute would block the campaign indefinitely.',
                '<b>L0 — the supervisor</b> decides within <b>5 days</b> (default). They set the decided rating and explain; the reason is mandatory.',
                '<b>Automatic escalation to L1</b> past that SLA: the dispute becomes “escalated”, and <b>the employee’s manager</b> is notified. They have <b>7 days</b> (default), counted from the escalation.',
                '<b>Automatic escalation to L2</b> past that second SLA: <b>HR arbitration</b> — a local admin holding the “Arbitrate disputes” permission. They are notified once per batch, with a count, never once per file. They have <b>7 days</b> (default).',
                '<b>Automatic finalisation</b> if the arbitration never happened: the dispute becomes “auto-finalised”, <b>on the supervisor’s rating</b>, with “[auto-finalized: no HR decision within SLA]” appended to the reason, the review is marked completed, the line is finalised, and the employee is told their contested rating is now official. All of it is logged.',
                '<b>At every level, the decision writes the decided rating into the official profile</b> and lifts the line’s lock, so the campaign can close.',
            ],
        },
        example: {
            fr: '<b>Exemple, sur des personnes fictives :</b> après l’approbation à 2 de « Procurement Support » pour <b>Souleymane LARSÈN</b>, il ouvre un litige. Constat immédiat : le litige naît <b>L0 / ouvert</b>, l’auto-évaluation repasse en <i>provisoire</i> et la revue devient <i>contestée</i>. Le délai L0 dépassé, l’escalade automatique le fait passer <b>L1 / escaladé</b> ; le délai L1 dépassé, elle le fait passer <b>L2 / escaladé</b>. Les deux escalades sont bien exécutées et retournent chacune 1 dossier traité. <b>La finalisation automatique du L2 échouait</b> jusqu’à cette version — elle écrivait un auteur nul dans une colonne obligatoire, laissant le litige bloqué en « L2 / escaladé » — ; <b>le défaut est corrigé</b> : la promotion de la note attribue désormais l’écriture à un compte système, exactement comme le fait déjà la voie de revue normale. Sur la base réelle, il n’existe aujourd’hui <b>aucun litige</b> (0 ligne) : l’écran des litiges ouverts est vide, ce qui est un état, pas un résultat de zéro contestation.',
            en: '<b>Example, on invented people:</b> after the approval at 2 of “Procurement Support” for <b>Souleymane LARSÈN</b>, he opens a dispute. Immediately: the dispute is born <b>L0 / open</b>, the self-assessment reverts to <i>provisional</i> and the review becomes <i>disputed</i>. Past the L0 SLA, automatic escalation moves it to <b>L1 / escalated</b>; past the L1 SLA, to <b>L2 / escalated</b>. Both escalations execute and each returns 1 file handled. <b>The L2 automatic finalisation used to fail</b> up to this release — it wrote a null author into a NOT NULL column, leaving the dispute stuck at “L2 / escalated” — ; <b>that defect is fixed</b>: promoting the rating now attributes the write to a system account, exactly as the normal review path already did. On a test instance there is currently <b>no dispute at all</b> (0 rows): the open-disputes screen is empty, which is a state, not a result of zero contestation.',
        },
        practices: {
            fr: [
                'Tranchez au niveau le plus bas : un litige réglé par le superviseur en 48 h coûte moins qu’un arbitrage RH trois semaines plus tard.',
                'Le motif de décision est obligatoire à chaque niveau — c’est lui qui rend la décision opposable.',
                'Réglez les trois délais avant d’ouvrir une campagne, pas pendant.',
                'Une escalade ne signifie pas que quelqu’un a mal travaillé : elle signifie que le temps est passé. C’est le rôle du délai.',
            ],
            en: [
                'Settle at the lowest level: a dispute resolved by the supervisor in 48 h costs less than an HR arbitration three weeks later.',
                'The decision reason is mandatory at every level — it is what makes the decision defensible.',
                'Set the three SLAs before opening a campaign, not during it.',
                'An escalation does not mean somebody did a bad job: it means time passed. That is what the SLA is for.',
            ],
        },
    },
    {
        icon: '🚪',
        title: {
            fr: 'De l’auto-inscription au rattachement — la file d’attente d’intégration',
            en: 'From self-registration to placement — the onboarding queue',
        },
        actors: {
            fr: 'Candidat ou nouvel arrivant (s’inscrit, ou se connecte via SSO) · Admin avec « Gérer l’intégration » (rattache, fusionne, refuse)',
            en: 'Candidate or newcomer (registers, or first signs in via SSO) · Admin with “Manage onboarding” (places, merges, rejects)',
        },
        when: {
            fr: 'À chaque embauche non saisie à l’avance. La fonction est <b>désactivée par défaut</b> et s’ouvre dans les Réglages.',
            en: 'On every hire not entered in advance. The feature is <b>off by default</b> and is opened in Settings.',
        },
        steps: {
            fr: [
                '<b>Ouvrir la porte</b> dans les Réglages : activer l’intégration, autoriser l’inscription libre et/ou le SSO, et surtout <b>limiter les domaines d’adresse</b> acceptés. Sans liste de domaines et sans autorisation explicite d’inscription ouverte, la plateforme <b>refuse par défaut</b>.',
                '<b>La personne s’inscrit</b> (nom, adresse, mot de passe) ou <b>se connecte pour la première fois via votre annuaire</b>. Dans les deux cas rien n’est créé côté RH : une <b>demande</b> est déposée, en attente. Le mot de passe choisi est déjà chiffré et conservé pour plus tard.',
                '<b>Une seule demande en attente par adresse</b> : re-tenter renvoie « déjà en attente », cela ne crée pas de doublon.',
                '<b>La personne peut revenir sur la page d’attente</b> à tout moment : elle y lit l’état réel de sa demande, pas un texte figé.',
                '<b>Les administrateurs habilités sont notifiés</b> et voient la file.',
                '<b>Rattacher</b> : site, département, service et poste sont <b>tous obligatoires</b>. Un admin à périmètre ne peut rattacher que dans son périmètre. Le rattachement crée le collaborateur, lui donne un identifiant unique, réutilise le mot de passe choisi lors de l’inscription, l’active, et marque la demande approuvée en gardant le lien vers la fiche créée.',
                '<b>Ou fusionner</b> : quand la demande vient du SSO et correspond à une personne déjà présente, l’administrateur rattache l’identité à la fiche existante <b>au lieu de créer un doublon</b>. Les adresses doivent concorder, sinon la fusion est refusée.',
                '<b>Ou refuser</b>, avec un motif : la personne n’a pas de boîte de réception dans l’application, elle reçoit donc un courriel bilingue, et la page d’attente affiche la décision même si l’envoi de courriel est coupé.',
            ],
            en: [
                '<b>Open the door</b> in Settings: enable onboarding, allow open signup and/or SSO, and above all <b>restrict the accepted address domains</b>. With no domain list and no explicit open-signup authorisation, the platform <b>refuses by default</b>.',
                '<b>The person registers</b> (name, address, password) or <b>first signs in through your directory</b>. Either way nothing is created on the HR side: a <b>request</b> is filed, pending. The chosen password is already hashed and kept for later.',
                '<b>One pending request per address</b>: retrying returns “already pending”, it does not create a duplicate.',
                '<b>The person can come back to the waiting page</b> at any time: it shows the real state of their request, not a fixed leaflet.',
                '<b>The entitled administrators are notified</b> and see the queue.',
                '<b>Place them</b>: site, department, service and role are <b>all mandatory</b>. A scoped admin can only place inside their scope. Placement creates the employee, gives them a unique login, reuses the password chosen at signup, activates them, and marks the request approved keeping the link to the created record.',
                '<b>Or merge</b>: when the request comes from SSO and matches somebody already present, the administrator attaches the identity to the existing record <b>instead of creating a duplicate</b>. Addresses must match, otherwise the merge is refused.',
                '<b>Or reject</b>, with a reason: the person has no inbox inside the application, so they receive a bilingual email, and the waiting page shows the decision even when email sending is off.',
            ],
        },
        example: {
            fr: '<b>Exemple observé :</b> les cinq réglages en base sont <i>enabled=true, allowSignup=true, allowSso=true, allowOpenSignup=true, allowedDomains=(vide)</i>. Une inscription est déposée : la plateforme répond « Thanks! Your request was received and is awaiting administrator approval. » et crée la demande n°3, <i>source=signup, fournisseur=local, statut=pending, mot de passe déjà chiffré</i>. Le rattachement est ensuite exécuté sur <b>Riverside / IT / CyberSecurity / Application Support officer</b> : la demande passe à <i>approuvée</i>, décidée par l’admin n°1, avec le lien vers la fiche créée ; le collaborateur naît avec le matricule <b>ONB-90003</b>, l’identifiant <b>doc.probe</b>, actif, compte actif, sans changement de mot de passe forcé. Deux notifications sont écrites : <i>onboarding.submitted</i> aux administrateurs et <i>lifecycle.joiner</i> au nouvel arrivant. Sur la base réelle la file est <b>vide</b> (0 demande) — l’écran « Votre compte est en cours de configuration » ne s’affiche à personne aujourd’hui.',
            en: '<b>Observed example:</b> the five live settings are <i>enabled=true, allowSignup=true, allowSso=true, allowOpenSignup=true, allowedDomains=(empty)</i>. A signup is filed: the platform answers “Thanks! Your request was received and is awaiting administrator approval.” and creates request #3, <i>source=signup, provider=local, status=pending, password already hashed</i>. Placement is then executed on <b>Riverside / IT / CyberSecurity / Application Support officer</b>: the request becomes <i>approved</i>, decided by admin #1, with the link to the created record; the employee is born with number <b>ONB-90003</b>, login <b>doc.probe</b>, active, account active, no forced password change. Two notifications are written: <i>onboarding.submitted</i> to the administrators and <i>lifecycle.joiner</i> to the newcomer. On a test instance the queue is <b>empty</b> (0 requests) — the “Your account is awaiting setup” page is shown to nobody today.',
        },
        practices: {
            fr: [
                'Renseignez la liste des domaines autorisés avant d’ouvrir l’inscription : sans elle, l’inscription ouverte doit être autorisée explicitement, et c’est une décision, pas un oubli.',
                'Rattachez vite : la personne est bloquée tant que ce n’est pas fait, et sa page d’attente le lui dit.',
                'Sur une demande SSO, cherchez d’abord une fiche existante et fusionnez — deux fiches pour une personne faussent tous les décomptes.',
                'Refusez avec un motif : c’est le seul texte que la personne verra.',
            ],
            en: [
                'Fill the allowed-domain list before opening signup: without it, open signup has to be authorised explicitly, and that is a decision, not an oversight.',
                'Place people quickly: they are locked out until you do, and their waiting page tells them so.',
                'On an SSO request, look for an existing record first and merge — two records for one person distort every count.',
                'Reject with a reason: it is the only text the person will ever see.',
            ],
        },
    },
    {
        icon: '🗝️',
        title: {
            fr: 'Déléguer l’administration — le périmètre et la capacité s’accordent séparément',
            en: 'Delegating administration — scope and capability are granted separately',
        },
        actors: {
            fr: 'SuperAdmin (délègue, révoque, atteste) · Admin avec « Gérer les administrateurs » (voit la délégation) · Le planificateur (relance la revue chaque mois)',
            en: 'SuperAdmin (delegates, revokes, attests) · Admin with “Manage admins” (sees the delegation) · The scheduler (chases the review monthly)',
        },
        when: {
            fr: 'À la mise en route, puis revue trimestrielle et à chaque changement de fonction.',
            en: 'At go-live, then reviewed quarterly and on every role change.',
        },
        steps: {
            fr: [
                '<b>Comprendre les deux moitiés.</b> Le <b>périmètre</b> répond à « sur QUI ? » (site, département, service, pays, région). La <b>capacité</b> répond à « pour FAIRE QUOI ? » (le catalogue de permissions). <b>Les deux se donnent séparément</b>, et l’une sans l’autre ne fait rien : un compte avec un périmètre et zéro permission est un compte <b>sans pouvoir</b> ; une permission sans périmètre ne porte sur personne.',
                '<b>Accorder</b> via un profil d’accès prêt (RH de site, responsable de département…) qui coche les bonnes cases, ou permission par permission. Une permission peut porter une <b>date d’expiration</b> ; une date illisible ou déjà passée fait <b>refuser toute la modification</b>, parce que « vide » veut dire « permanent » et qu’une faute de frappe créait un droit éternel.',
                '<b>Les garde-fous travaillent seuls</b> : un délégué ne peut accorder que ce qu’il détient lui-même ; il ne peut pas sortir de son propre périmètre ; un lecteur ne peut jamais exercer une permission d’écriture même si elle lui est stockée ; et surtout <b>un délégué ne peut administrer un compte que si ce compte ne gouverne personne qu’il ne gouverne déjà</b>. En cas de doute, la règle refuse.',
                '<b>Tout est consigné</b> dans un registre des accès : attribution, retrait, ajout ou retrait de périmètre, application d’un profil, prolongation. Ce registre est une <b>preuve, pas une permission</b> — l’autorisation reste dans les permissions et les périmètres.',
                '<b>La revue d’accès</b> nomme quatre exceptions par compte : <b>périmètre sans capacité</b>, <b>MFA absente</b>, <b>droit expirant sous 30 jours</b>, <b>compte inactif depuis 90 jours</b> ; plus la <b>dérive de profil</b> (« provisionné comme X, ne ressemble plus à X »).',
                '<b>Attester</b> compte par compte : « approprié » ou « à révoquer ». L’attestation part dans le journal chaîné, en ajout seul.',
                '<b>La vue Délégation</b> répond à la question inverse : pour ce site, ce pays, <b>qui a autorité sur mes gens ?</b> — et signale une unité peuplée que personne ne couvre.',
                '<b>Désactiver, jamais supprimer.</b> « Désactiver » (motif obligatoire) conserve les droits et les périmètres du compte — signalés « révoqués » — ferme ses sessions et ses clés API, et « Réactiver » (motif, mot de passe à changer) restaure exactement le périmètre précédent. Un compte dont les droits ont expiré se lit « Expiré le … », jamais « jamais provisionné » ; un compte verrouillé après trop d’échecs de connexion se déverrouille depuis la liste. La vue Délégation est accessible depuis <b>Administrateurs → Délégation d’autorité</b> (<code>/admin/delegation</code>).',
                '<b>Certaines opérations sensibles passent par un second regard</b> (maker-checker) : celui qui soumet ne peut jamais approuver sa propre demande.',
            ],
            en: [
                '<b>Understand the two halves.</b> <b>Scope</b> answers “over WHOM?” (site, department, service, country, region). <b>Capability</b> answers “to DO WHAT?” (the permission catalogue). <b>They are granted separately</b>, and either alone does nothing: an account with a scope and zero permissions is a <b>powerless</b> account; a permission with no scope reaches nobody.',
                '<b>Grant</b> through a ready-made access profile (site HR, department lead…) which ticks the right boxes, or permission by permission. A permission can carry an <b>expiry</b>; an unreadable or already-past date makes the <b>whole change refused</b>, because “empty” means “permanent” and a typo used to mint an eternal grant.',
                '<b>The guardrails work by themselves</b>: a delegate can only grant what they hold; they cannot step outside their own scope; a viewer can never exercise a write permission even if one is stored for them; and above all <b>a delegate may administer an account only if that account governs nobody they do not already govern</b>. In doubt, the rule refuses.',
                '<b>Everything is recorded</b> in an access ledger: grant, revoke, scope added or removed, profile applied, expiry extended. That ledger is <b>evidence, not permission</b> — authorisation stays in the permissions and the scopes.',
                '<b>The access review</b> names four exceptions per account: <b>scoped but powerless</b>, <b>no MFA</b>, <b>grant expiring within 30 days</b>, <b>account idle for 90 days</b>; plus <b>profile drift</b> (“provisioned as X, no longer looks like X”).',
                '<b>Attest</b> account by account: “appropriate” or “to revoke”. The attestation goes into the hash-chained, append-only log.',
                '<b>The Delegation view</b> answers the reverse question: for this site, this country, <b>who has authority over my people?</b> — and flags a populated unit nobody covers.',
                '<b>Deactivate, never delete.</b> “Deactivate” (reason required) keeps the account’s capabilities and scopes — marked “revoked” — closes its sessions and API keys, and “Reactivate” (reason, password change forced) restores exactly the previous perimeter. An account whose grants have expired reads “Expired on …”, never “never provisioned”; an account locked after too many failed sign-ins is unlocked from the list. The Delegation view is reachable from <b>Administrators → Delegation of authority</b> (<code>/admin/delegation</code>).',
                '<b>Some sensitive operations go through a second pair of eyes</b> (maker-checker): the submitter can never approve their own request.',
            ],
        },
        example: {
            fr: '<b>Exemple observé (2026-09-02) :</b> sur les 13 comptes d’administration actifs, <b>dix administrateurs locaux ont un périmètre vivant mais ZÉRO capacité vivante</b> — <i>ops.local</i> (2 périmètres, 0 permission), <i>hse.local</i> (1, 0), <i>maint.local</i> (1, 0), <i>proc.local</i> (2, 0), <i>fin.local</i> (1, 0), <i>hr.local</i> (2, 0), <i>it.local</i> (2, 0), <i>geo.local</i> (1, 0), <i>lab.local</i> (1, 0). Seul <b>test.local</b> porte réellement des droits : 18 capacités vivantes sur 1 périmètre. C’est exactement l’exception « <b>périmètre sans capacité</b> » que la revue d’accès nomme, et c’est le défaut le plus fréquent de cette famille. Le registre des accès compte <b>0 ligne</b> : il n’a rien à raconter parce que ces droits sont antérieurs à sa mise en place — la vue Délégation affiche alors l’origine comme « inconnue » plutôt que de l’inventer.',
            en: '<b>Observed example (2026-09-02):</b> of the 13 active admin accounts, <b>ten local administrators hold a live scope but ZERO live capability</b> — <i>ops.local</i> (2 scopes, 0 permissions), <i>hse.local</i> (1, 0), <i>maint.local</i> (1, 0), <i>proc.local</i> (2, 0), <i>fin.local</i> (1, 0), <i>hr.local</i> (2, 0), <i>it.local</i> (2, 0), <i>geo.local</i> (1, 0), <i>lab.local</i> (1, 0). Only <b>test.local</b> actually carries rights: 18 live capabilities over 1 scope. That is precisely the “<b>scoped but powerless</b>” exception the access review names, and it is the most common defect in this family. The access ledger holds <b>0 rows</b>: it has nothing to tell because those grants predate it — the Delegation view therefore shows the origin as “unknown” rather than inventing one.',
        },
        practices: {
            fr: [
                'Donnez les deux moitiés ou aucune : un périmètre sans permission crée un administrateur qui ne peut rien, et le croit pouvoir.',
                'Datez les droits : l’accès doit expirer sauf renouvellement, pas persister sauf révocation.',
                'Ne partagez jamais un compte SuperAdmin — déléguez la permission exacte, dans le périmètre exact.',
                'Passez la revue chaque trimestre et attestez : « périmètre sans capacité », « sans MFA » et « inactif 90 jours » sont les trois premières lignes à traiter.',
                'Le registre des accès est une preuve d’audit, pas une source d’autorisation — ne le lisez jamais pour décider qui a le droit de faire quoi.',
            ],
            en: [
                'Give both halves or neither: a scope with no permission creates an administrator who can do nothing, and believes otherwise.',
                'Time-bound the grants: access should expire unless renewed, not persist unless revoked.',
                'Never share a SuperAdmin account — delegate the exact permission, in the exact scope.',
                'Run the review quarterly and attest: “scoped but powerless”, “no MFA” and “idle 90 days” are the first three lines to clear.',
                'The access ledger is audit evidence, not a source of authority — never read it to decide who may do what.',
            ],
        },
    },
    {
        icon: '🔔',
        title: {
            fr: 'Être prévenu sans être noyé — application d’abord, courriel ensuite, et jamais deux fois',
            en: 'Being told without being flooded — in-app first, email second, and never twice',
        },
        actors: {
            fr: 'Tout le monde (reçoit) · Chacun (règle ses heures calmes et son opt-out) · Admin (règle les familles de courriels) · Le planificateur (relance, regroupe)',
            en: 'Everyone (receives) · Each person (sets their quiet hours and opt-out) · Admin (sets the email families) · The scheduler (chases, groups)',
        },
        when: {
            fr: 'En continu. Rappels quotidiens, hebdomadaires ou mensuels selon la nature.',
            en: 'Continuously. Daily, weekly or monthly reminders depending on the kind.',
        },
        steps: {
            fr: [
                '<b>Application d’abord, toujours.</b> Tout événement dépose une notification dans la cloche. Le courriel n’est qu’un second canal, et il est filtré : certaines familles ne partent <b>jamais</b> par courriel, d’autres attendent le <b>récapitulatif quotidien</b>, seules les plus urgentes partent immédiatement.',
                '<b>La cloche additionne deux compteurs</b> : les actions qui vous attendent réellement, et les notifications non lues. Le badge est la somme, plafonnée à 99+.',
                '<b>Heures calmes</b> : chacun définit une plage. Une notification levée dedans est <b>différée</b>, pas perdue — elle réapparaît à la fin de la plage, et elle réapparaît même si le planificateur n’a pas tourné. Un courriel urgent levé dans la plage est <b>rédigé tout de suite</b> et mis de côté, pour ne pas être dégradé quelques heures plus tard.',
                '<b>Rien de confidentiel ne sort.</b> Les messages sont des phrases <b>fixes</b> : aucune note, aucun niveau, aucun commentaire, aucun contenu de PIP ni positionnement 9-box n’est interpolé. Le détail est derrière le lien, protégé par les droits.',
                '<b>Les rappels ne se répètent pas.</b> Chaque relance est <b>réservée avant d’être envoyée</b> dans un registre, par période (jour, semaine, mois) : une panne ne peut pas produire un doublon, et un envoi raté <b>libère</b> la réservation pour être réessayé au tour suivant.',
                '<b>Les alertes talent sont agrégées et anonymes</b> : « 3 plans à revoir », jamais « le plan de X ». Le risque de rétention et les positionnements 9-box ne partent qu’en interne à l’application, jamais vers un webhook.',
                '<b>Quatre récapitulatifs</b> : le <b>digest manager</b> hebdomadaire (lundi), le <b>digest départemental</b> sur abonnement, le <b>digest personnel</b> quotidien de vos non-lus, et le <b>brief de planification</b> mensuel. Un destinataire qui n’a rien à lire <b>ne reçoit rien</b>.',
                '<b>Le digest manager distingue le mesuré du non mesuré</b> : les écarts critiques constatés sont en rouge, les compétences critiques <b>non encore évaluées</b> sont listées à part, en orange. Le digest départemental affiche « non mesuré » plutôt que 0 quand la préparation n’a pas de base.',
            ],
            en: [
                '<b>In-app first, always.</b> Every event drops a notification in the bell. Email is only a second channel, and it is filtered: some families <b>never</b> go by email, others wait for the <b>daily rollup</b>, only the most urgent go immediately.',
                '<b>The bell adds two counters</b>: the actions genuinely waiting for you, and unread notifications. The badge is the sum, capped at 99+.',
                '<b>Quiet hours</b>: each person sets a window. A notification raised inside it is <b>deferred</b>, not lost — it resurfaces at the end of the window, and it resurfaces even if the scheduler never ran. An urgent email raised inside the window is <b>composed immediately</b> and parked, so it is not downgraded hours later.',
                '<b>Nothing confidential leaves.</b> Messages are <b>fixed</b> sentences: no rating, no level, no comment, no PIP content and no 9-box placement is interpolated. The detail sits behind the link, protected by permissions.',
                '<b>Reminders do not repeat.</b> Every chase is <b>claimed before it is sent</b> in a ledger, by period (day, week, month): a crash cannot produce a duplicate, and a failed send <b>releases</b> the claim to be retried next time.',
                '<b>Talent alerts are aggregated and anonymous</b>: “3 plans to review”, never “X’s plan”. Retention risk and 9-box placements stay inside the application, never reaching a webhook.',
                '<b>Four rollups</b>: the weekly <b>manager digest</b> (Monday), the subscription-based <b>departmental digest</b>, the daily <b>personal digest</b> of your unread items, and the monthly <b>planning brief</b>. A recipient with nothing to read <b>gets nothing</b>.',
                '<b>The manager digest separates measured from unmeasured</b>: observed critical gaps are red, critical skills <b>not yet assessed</b> are listed separately, in amber. The departmental digest shows “not measured” rather than 0 when readiness has no base.',
            ],
        },
        example: {
            fr: '<b>Exemple observé (base de démonstration) :</b> 215 notifications, dont <b>156 rappels de campagne</b>, 11 digests manager, 10 « auto-évaluation approuvée », 6 « plan de coaching créé », 4 « revue d’accès », 3 « plan talent à échéance », 3 « passation à échéance », 3 « escalade de campagne », 2 « expiration de certificat » et 2 « expiration de certificat — équipe », 2 « PDI créé », 2 « PIP créé », 2 « départ », 1 « couverture en rupture », 1 « couverture — rupture prévue ». <b>Toutes en canal application.</b> Le registre des rappels compte 167 réservations : <b>153 « campagne non commencée »</b> (une par personne et par semaine), 4 « revue d’accès » (mensuel), 3 « plan talent à échéance », 3 « passation à échéance », 2 « brief de planification », 2 « verrouillage automatique de campagne » — dernière écriture le 2026-09-02.',
            en: '<b>Observed example (demo dataset):</b> 215 notifications, of which <b>156 campaign reminders</b>, 11 manager digests, 10 “self-assessment approved”, 6 “coaching plan created”, 4 “access review”, 3 “talent plan due”, 3 “handover due”, 3 “campaign escalation”, 2 “certificate expiry” and 2 “certificate expiry — team”, 2 “IDP created”, 2 “PIP created”, 2 “leaver”, 1 “coverage breached”, 1 “coverage — predicted breach”. <b>All on the in-app channel.</b> The reminder ledger holds 167 claims: <b>153 “campaign not started”</b> (one per person per week), 4 “access review” (monthly), 3 “talent plan due”, 3 “handover due”, 2 “planning brief”, 2 “campaign auto-lock” — last written 2026-09-02.',
        },
        practices: {
            fr: [
                'Réglez vos heures calmes plutôt que de vous désabonner : ce qui est différé revient, ce qui est désabonné ne revient pas.',
                'Ne cherchez pas le détail dans la notification : il n’y est pas, volontairement. Suivez le lien.',
                'Vérifiez les familles de courriels après tout changement SMTP — une famille coupée ne coupe jamais la cloche.',
                'Un digest qui n’arrive pas parce qu’il n’y avait rien à dire est un digest qui fonctionne.',
            ],
            en: [
                'Set your quiet hours rather than opting out: what is deferred comes back, what is opted out does not.',
                'Do not look for the detail in the notification: it is deliberately not there. Follow the link.',
                'Check the email families after any SMTP change — a disabled family never disables the bell.',
                'A digest that does not arrive because there was nothing to say is a digest that works.',
            ],
        },
    },
    {
        icon: '🧱',
        title: {
            fr: 'Faire entrer et sortir les données — modèles, aperçu, aller-retour, instantanés, console SQL',
            en: 'Getting data in and out — templates, preview, round trip, snapshots, SQL console',
        },
        actors: {
            fr: 'SuperAdmin ou admin avec « Importer » / « Exporter » les données (la console SQL et les instantanés sont SuperAdmin uniquement)',
            en: 'SuperAdmin or admin with “Import” / “Export” data (the SQL console and snapshots are SuperAdmin only)',
        },
        when: {
            fr: 'Au démarrage, puis à chaque évolution de l’organisation ou du référentiel.',
            en: 'At go-live, then on every change to the organisation or the framework.',
        },
        steps: {
            fr: [
                '<b>Partir du modèle</b>, jamais d’un fichier improvisé : organisation, domaines et compétences, rôles, collaborateurs, évaluations, référentiel complet, certifications, administrateurs locaux — en Excel ou en JSON, avec un modèle « système complet » pré-rempli d’un exemple. Chaque téléchargement est tracé.',
                '<b>Aperçu obligatoire avant tout import.</b> L’aperçu Excel valide la structure en acceptant <b>les mêmes noms de feuilles que l’import</b>. L’aperçu JSON est une <b>vraie simulation</b> qui n’écrit rien : il annonce, par entité, combien de lignes sont nouvelles et combien existent déjà — et combien d’identifiants de connexion seraient créés.',
                '<b>L’aller-retour est fidèle.</b> Dans la matrice des rôles, une cellule porte deux faits : le niveau requis, et une <b>étoile</b> qui marque l’exigence critique (« 3* »). Sans elle, un aller-retour Excel effaçait silencieusement le caractère critique de chaque exigence. Le niveau <b>0 est une note valide</b> et survit à l’aller-retour ; une cellule <b>vide veut dire « non évalué »</b>, ce qui est différent.',
                '<b>L’import fusionne, il ne remplace jamais tout</b> : il crée ou met à jour, et rend compte des deux. Un collaborateur dont le site, le département, le service ou le poste ne se résout pas est <b>écarté avec une erreur nommée</b> — il n’est pas inséré à moitié.',
                '<b>Instantané avant toute manœuvre risquée.</b> Un instantané capture l’organisation, le référentiel, les rôles et exigences, les collaborateurs (<b>sans mots de passe</b>), les évaluations et leur historique, les administrateurs et périmètres, et les réglages. Il ne capture <b>pas</b> les PIP, PDI, coaching, 9-box, litiges, événements de cycle de vie, notifications ni le journal.',
                '<b>Restaurer un instantané</b> exige d’abord une <b>sauvegarde complète</b> ; si elle échoue, la restauration <b>est annulée</b> et le dit. La restauration efface ce que l’instantané ne couvre pas plutôt que de laisser des lignes orphelines : c’est une remise à l’état de l’instantané, et le manuel doit le dire.',
                '<b>Console SQL</b> (SuperAdmin) : elle prend la main sur la transaction, refuse toute instruction qui toucherait aux <b>trois tables en ajout seul</b> (historique d’évaluation, journal système, signatures de revue) — y compris déguisée en bloc dynamique — et prend un <b>point de restauration complet avant toute écriture</b>. Si le point de restauration échoue, le script <b>ne tourne pas</b>.',
                '<b>Retour arrière de la console</b> : la restauration préserve les trois tables protégées, les remet en place <b>avec leur chaîne d’empreintes intacte</b>, et ne libère la zone de quarantaine que si <b>toutes</b> les lignes sont revenues ; sinon elles sont nommées et conservées.',
                '<b>Les points de restauration sont des copies non chiffrées de toutes les données personnelles</b> : ils sont donc plafonnés en nombre et purgés au-delà de 7 jours.',
            ],
            en: [
                '<b>Start from the template</b>, never an improvised file: organisation, domains and skills, roles, employees, assessments, full framework, certifications, local admins — in Excel or JSON, with a “full system” template pre-filled with an example. Every download is logged.',
                '<b>Preview is mandatory before any import.</b> The Excel preview validates the structure accepting <b>the same sheet names the importer accepts</b>. The JSON preview is a <b>true dry run</b> that writes nothing: it states, per entity, how many rows are new and how many already exist — and how many logins would be minted.',
                '<b>The round trip is faithful.</b> In the role matrix a cell carries two facts: the required level, and a <b>star</b> marking the requirement critical (“3*”). Without it an Excel round trip silently cleared the critical flag on every requirement. Level <b>0 is a valid rating</b> and survives the round trip; an <b>empty cell means “not assessed”</b>, which is different.',
                '<b>Import merges, it never truncates</b>: it creates or updates, and reports both. An employee whose site, department, service or role cannot be resolved is <b>skipped with a named error</b> — not half inserted.',
                '<b>Snapshot before any risky manoeuvre.</b> A snapshot captures the organisation, the framework, roles and requirements, employees (<b>without passwords</b>), assessments and their history, admins and scopes, and settings. It does <b>not</b> capture PIPs, IDPs, coaching, 9-box, disputes, lifecycle events, notifications or the log.',
                '<b>Restoring a snapshot</b> requires a <b>full backup first</b>; if that fails the restore <b>is aborted</b> and says so. The restore clears what the snapshot does not cover rather than leaving orphan rows: it is a reset to the snapshot’s state, and the manual must say so.',
                '<b>SQL console</b> (SuperAdmin): it owns the transaction, refuses any statement that would touch the <b>three append-only tables</b> (assessment history, system log, review signatures) — including one disguised inside a dynamic block — and takes a <b>full restore point before any write</b>. If the restore point fails, the script <b>does not run</b>.',
                '<b>Console revert</b>: the restore preserves the three protected tables, puts them back <b>with their hash chain intact</b>, and only frees the quarantine area once <b>every</b> row is back; otherwise they are named and kept.',
                '<b>Restore points are unencrypted copies of all personal data</b>: they are therefore capped in number and purged beyond 7 days.',
            ],
        },
        example: {
            fr: '<b>Exemple observé :</b> la base porte <b>4 instantanés</b>. L’écran Gestion des données expose bien les téléchargements de modèles, l’aperçu, l’import, les instantanés et la console SQL, sur un compte SuperAdmin uniquement. <b>Non exécuté par cette lane</b> : aucun import, aucune restauration, aucun script de console SQL n’a été lancé — ces opérations écrivent hors transaction (sauvegarde <i>pg_dump</i>, restauration, purge) et ne peuvent pas être annulées proprement. Elles sont documentées d’après le code et le schéma.',
            en: '<b>Observed example:</b> the database holds <b>4 snapshots</b>. The Data Management screen does expose template downloads, preview, import, snapshots and the SQL console, on a SuperAdmin account only. <b>Not executed by this lane</b>: no import, no restore and no SQL-console script was run — those operations write outside a transaction (<i>pg_dump</i> backup, restore, purge) and cannot be rolled back cleanly. They are documented from the code and schema.',
        },
        practices: {
            fr: [
                'Jamais d’import sans aperçu ; jamais de changement massif sans instantané.',
                'Gardez l’étoile dans la matrice des rôles : sans elle, l’aller-retour efface le caractère critique de vos exigences.',
                'Une cellule vide n’est pas un zéro. Ne remplissez pas les blancs pour « faire propre » : vous transformeriez une absence de mesure en résultat.',
                'Un instantané ne remplace pas une sauvegarde : il ne contient ni PIP, ni PDI, ni coaching, ni 9-box, ni journal.',
                'Les points de restauration de la console SQL sont des copies complètes non chiffrées : traitez-les comme telles, et laissez la purge à 7 jours faire son travail.',
            ],
            en: [
                'Never import without a preview; never bulk-change without a snapshot.',
                'Keep the star in the role matrix: without it the round trip clears the critical flag on your requirements.',
                'An empty cell is not a zero. Do not fill the blanks to “tidy up”: you would turn an absence of measurement into a result.',
                'A snapshot is not a backup: it contains no PIP, no IDP, no coaching, no 9-box and no log.',
                'SQL-console restore points are complete unencrypted copies: treat them as such, and let the 7-day purge do its job.',
            ],
        },
    },
    {
        icon: '⏱️',
        title: {
            fr: 'Ce qui tourne pendant que personne ne regarde — sauvegardes, purges et calendrier des tâches',
            en: 'What runs while nobody is watching — backups, pruning and the job calendar',
        },
        actors: {
            fr: 'La plateforme (exécute) · SuperAdmin (règle les heures, les durées de conservation) · Exploitation (surveille /about)',
            en: 'The platform (runs it) · SuperAdmin (sets hours and retention) · Operations (watches /about)',
        },
        when: {
            fr: 'Toutes les 15 minutes, toutes les heures, chaque jour, chaque semaine, chaque mois selon la tâche.',
            en: 'Every 15 minutes, hourly, daily, weekly, monthly depending on the job.',
        },
        steps: {
            fr: [
                '<b>Un seul planificateur à la fois.</b> Sur une installation simple, les tâches tournent dans le processus de l’application, protégées par un verrou : si deux instances démarrent, une seule exécute le calendrier.',
                '<b>Sauvegarde quotidienne</b> : la première exécution horaire à partir de l’heure configurée produit un <i>pg_dump</i> compressé, nommé par la date — donc idempotent : une seconde exécution le même jour ne fait rien. Le mot de passe passe par l’environnement, jamais par la ligne de commande. Un fichier partiel est supprimé pour ne pas faire croire au succès. La <b>date et l’état de la dernière sauvegarde sont publiés</b> sur la page À propos.',
                '<b>Conservation des sauvegardes</b> : on garde les N plus récentes. <b>0 signifie « tout garder »</b>, et la valeur est arrondie à l’entier inférieur — une valeur fractionnaire effaçait autrefois l’intégralité du jeu.',
                '<b>Purge de télémétrie</b> — et <b>uniquement</b> de la télémétrie : traces de performance (30 jours), notifications <b>déjà lues</b> (120 jours), registre de rappels (180 jours). Là encore <b>0 = conserver indéfiniment</b>. Le <b>journal système n’est jamais purgé</b> : c’est une pièce d’audit à chaîne d’empreintes.',
                '<b>Verrouillage automatique des campagnes</b> à l’échéance (activé par défaut). La <b>clôture automatique est désactivée par défaut</b> : elle ne s’active qu’en donnant un délai de grâce positif, parce que clore une campagne est une décision, pas une conséquence du calendrier.',
                '<b>Les relances ne doublonnent jamais</b> : chaque tâche réserve son envoi dans le registre avant de l’émettre, et libère la réservation si l’envoi échoue.',
                '<b>Tout ce qui alerte n’alerte qu’au changement</b> : une règle de couverture n’avertit qu’au moment où elle bascule, pas à chaque tour ; un certificat n’avertit qu’une fois par palier (90, 60, 30, expiré).',
            ],
            en: [
                '<b>One scheduler at a time.</b> On a simple install the jobs run inside the application process, protected by a lock: if two instances start, only one runs the calendar.',
                '<b>Daily backup</b>: the first hourly run at or after the configured hour produces a compressed <i>pg_dump</i>, named by date — hence idempotent: a second run the same day does nothing. The password goes through the environment, never the command line. A partial file is deleted so it cannot look like a success. The <b>date and status of the last backup are published</b> on the About page.',
                '<b>Backup retention</b>: the newest N are kept. <b>0 means “keep everything”</b>, and the value is floored — a fractional value used to wipe the entire set.',
                '<b>Telemetry pruning</b> — and <b>only</b> telemetry: performance traces (30 days), <b>already-read</b> notifications (120 days), the reminder ledger (180 days). Again <b>0 = keep forever</b>. The <b>system log is never pruned</b>: it is a hash-chained audit artefact.',
                '<b>Automatic campaign locking</b> at the deadline (on by default). <b>Automatic closing is off by default</b>: it only turns on by giving a positive grace period, because closing a campaign is a decision, not a consequence of the calendar.',
                '<b>Chases never duplicate</b>: every job claims its send in the ledger before emitting it, and releases the claim if the send fails.',
                '<b>Everything that alerts, alerts only on a change</b>: a coverage rule warns when it flips, not every tick; a certificate warns once per stage (90, 60, 30, expired).',
            ],
        },
        example: {
            fr: '<b>Exemple observé (base de démonstration) :</b> les instantanés de KPI ont été écrits chaque jour d’activité — 22, 24, 25, 26, 27, 28 août puis 1er et 2 septembre, <b>10 lignes par jour</b> (l’organisation plus chaque site). La photo du 2026-09-02 dit : 79 personnes, <b>73 mesurées</b>, préparation moyenne <b>82,3 % sur les mesurés</b> contre <b>73,9 % sur tout le monde</b>, couverture d’évaluation <b>73,8 %</b> (2 476 exigences évaluées sur 3 353), 23 rôles à risque, 181 détenteurs uniques, <b>147 rôles sans personne qualifiée</b>, 1 certificat expirant sous 90 jours. Les deux moyennes sont publiées côte à côte : c’est ainsi qu’on ne confond pas « 82 % des mesurés » avec « 82 % des gens ». <b>Non exécuté</b> : aucune tâche n’a été déclenchée manuellement par cette lane.',
            en: '<b>Observed example (demo dataset):</b> the KPI snapshots were written on every active day — 22, 24, 25, 26, 27, 28 August then 1 and 2 September, <b>10 rows per day</b> (the organisation plus each site). The 2026-09-02 picture reads: 79 people, <b>73 measured</b>, average readiness <b>82.3% over the measured</b> against <b>73.9% over everyone</b>, assessment coverage <b>73.8%</b> (2,476 requirements assessed out of 3,353), 23 roles at risk, 181 sole holders, <b>147 roles with nobody qualified</b>, 1 certificate expiring within 90 days. Both averages are published side by side: that is how “82% of the measured” is never mistaken for “82% of the people”. <b>Not executed</b>: no job was triggered manually by this lane.',
        },
        practices: {
            fr: [
                'Vérifiez la date et l’état de la dernière sauvegarde sur la page À propos, pas la présence d’un fichier.',
                'Ne mettez jamais une valeur fractionnaire dans une durée de conservation : 0 veut dire « tout garder », et rien d’autre ne veut dire « tout effacer ».',
                'N’activez la clôture automatique des campagnes qu’en connaissance de cause — elle génère les PDI.',
                'Ne cherchez pas à purger le journal système : il est en ajout seul, par conception, et c’est votre preuve.',
            ],
            en: [
                'Check the date and status of the last backup on the About page, not the presence of a file.',
                'Never put a fractional value in a retention setting: 0 means “keep everything”, and nothing else means “delete everything”.',
                'Only enable automatic campaign closing deliberately — it generates the IDPs.',
                'Do not try to prune the system log: it is append-only by design, and it is your evidence.',
            ],
        },
    },
    {
        icon: '🧾',
        title: {
            fr: 'Ce qui a changé, et comment le corriger proprement — mouvements, révisions post-approbation, annulations',
            en: 'What changed, and how to correct it cleanly — movements, post-approval revisions, cancellations',
        },
        actors: {
            fr: 'La base (capture les mouvements toute seule) · Manager ou Admin (conteste une note approuvée, demande une annulation) · Un SECOND administrateur (décide)',
            en: 'The database (captures movements by itself) · Manager or Admin (contests an approved rating, requests a cancellation) · A SECOND administrator (decides)',
        },
        when: {
            fr: 'En continu pour les mouvements ; à la demande pour les deux procédures de correction.',
            en: 'Continuously for movements; on demand for the two correction procedures.',
        },
        steps: {
            fr: [
                '<b>Les mouvements se capturent tout seuls</b>, au niveau de la base : sept dimensions surveillées — site, département, service, poste, manager, superviseur, statut. Une ligne par dimension réellement changée, avec le <b>libellé résolu au moment du changement</b> : l’historique ne se réécrit pas quand un service est renommé plus tard.',
                '<b>Le fil des mouvements</b> réunit trois flux : les changements structurels, les évaluations de compétences, et les revues. Il est filtré par le périmètre du lecteur avant tout regroupement.',
                '<b>Révision post-approbation</b> : quand une note approuvée est manifestement fausse, on ne la réécrit pas en base. On dépose une demande motivée qui porte le niveau approuvé et le niveau proposé. <b>Une seule demande vivante par auto-évaluation.</b> Un <b>administrateur</b> décide ; la base elle-même <b>interdit une décision sans décideur ni date</b>. Approuvée, la demande met à jour la note de la revue.',
                '<b>Annulation d’un plan</b> (coaching, mentorat, PIP, PDI) : jamais une suppression. Une demande motivée, un état capturé avant, et un <b>second administrateur</b> qui décide — <b>le demandeur ne peut pas approuver sa propre demande</b>. Approuvée, le plan passe simplement à « annulé ».',
                '<b>Un plan déjà terminé, clos ou archivé ne s’annule pas</b> : la plateforme répond « déjà clôturé ».',
            ],
            en: [
                '<b>Movements capture themselves</b>, at database level: seven watched dimensions — site, department, service, role, manager, supervisor, status. One row per dimension that actually changed, with the <b>label resolved at the moment of the change</b>: history is not rewritten when a service is renamed later.',
                '<b>The movement feed</b> merges three streams: structural changes, skill assessments, and reviews. It is filtered by the reader’s scope before any aggregation.',
                '<b>Post-approval revision</b>: when an approved rating is plainly wrong, it is not rewritten in place. A reasoned request is filed carrying the approved level and the proposed level. <b>One live request per self-assessment.</b> An <b>administrator</b> decides; the database itself <b>forbids a decision with no decider and no date</b>. Approved, the request updates the review’s rating.',
                '<b>Cancelling a plan</b> (coaching, mentoring, PIP, IDP): never a deletion. A reasoned request, the prior state captured, and a <b>second administrator</b> deciding — <b>the requester cannot approve their own request</b>. Approved, the plan simply becomes “cancelled”.',
                '<b>A plan already completed, closed or archived cannot be cancelled</b>: the platform answers “already closed”.',
            ],
        },
        example: {
            fr: '<b>Exemple observé (base de démonstration) :</b> 16 mouvements enregistrés. Douze concernent des changements de <i>service</i> du 04/08 — par exemple <b>« Data &amp; Insights (IT / Riverside) → Enterprise Applications (IT / Riverside) »</b> puis le retour, chaque libellé étant qualifié par son département et son site. Les quatre derniers portent sur la fiche sortie <code>ERASED-90010</code> : un changement de <i>manager</i> « FARRELL, Aïcha → BECKER, Fabrice » le 01/09, puis <i>statut</i> actif → inactif, inactif → actif le 01/09, et de nouveau actif → inactif le 02/09. <b>L’historique s’allonge à chaque fois, il ne se corrige jamais en place.</b> À ce jour, <b>0 révision post-approbation</b> et <b>0 demande d’annulation</b> existent en base : les deux files sont vides.',
            en: '<b>Observed example (demo dataset):</b> 16 movements recorded. Twelve are <i>service</i> changes on 04/08 — for instance <b>“Data &amp; Insights (IT / Riverside) → Enterprise Applications (IT / Riverside)”</b> then back, each label qualified by its department and site. The last four concern the leaver record <code>ERASED-90010</code>: a <i>manager</i> change “FARRELL, Aïcha → BECKER, Fabrice” on 01/09, then <i>status</i> active → inactive, inactive → active on 01/09, and active → inactive again on 02/09. <b>History grows every time, it is never corrected in place.</b> To date, <b>0 post-approval revisions</b> and <b>0 cancellation requests</b> exist: both queues are empty.',
        },
        practices: {
            fr: [
                'Ne corrigez jamais une note approuvée en base : déposez une révision post-approbation, elle laisse une trace décidée et datée.',
                'Une annulation exige un second regard — c’est la règle, ne cherchez pas à la contourner en supprimant.',
                'Lisez le fil des mouvements avant de conclure qu’une donnée a « disparu » : elle a le plus souvent été déplacée, et le fil le dit.',
                'Deux files vides ne veulent pas dire « aucune erreur » : elles veulent dire qu’aucune procédure de correction n’est en cours.',
            ],
            en: [
                'Never correct an approved rating in place: file a post-approval revision, it leaves a decided, dated trail.',
                'A cancellation requires a second pair of eyes — that is the rule, do not work around it by deleting.',
                'Read the movement feed before concluding data has “disappeared”: more often it was moved, and the feed says so.',
                'Two empty queues do not mean “no errors”: they mean no correction procedure is currently running.',
            ],
        },
    },
];

// Which guide sections each clearance unlocks.
//
// Supervisor and manager are DIFFERENT roles on two different columns, and the
// workflow enforces the difference: a supervisor (`supervisor_id`) satisfies
// canSupervise — open a review, request changes; a manager (`manager_id` with
// manager_type='employee') additionally satisfies canManage — manager
// validation and dispute arbitration, which a pure supervisor is excluded from.
// A manager therefore reads the supervisor section too; a supervisor must NOT
// read the manager section, or the guide promises them decisions they cannot make.
const SECTIONS_FOR = {
    employee: ['employee'],
    supervisor: ['employee', 'supervisor'],
    manager: ['employee', 'supervisor', 'manager'],
    localadmin: ['supervisor', 'manager', 'localadmin'],
    superadmin: ['supervisor', 'manager', 'localadmin', 'superadmin'],
};

// Resolve a user (req.user) to a clearance key.
//
// `userType === 'manager'` covers BOTH governance lines (it is set from
// EmployeeModel.governanceOf, which tests supervisor_id OR manager_id), so the
// two are told apart by `isPeopleManager`. When that flag is absent — an old
// session serialized before this release — we deliberately fall back to the
// NARROWER clearance: showing a supervisor manager-only powers would be a false
// promise, while a manager briefly seeing one section less is only a gap.
function clearanceOf(user) {
    if (!user) return 'employee';
    if (user.userType === 'employee') return 'employee';
    if (user.userType === 'manager') return user.isPeopleManager ? 'manager' : 'supervisor';
    if (user.userType === 'admin') return user.role === 'superadmin' ? 'superadmin' : 'localadmin';
    return 'employee';
}

module.exports = { PROFILES, GLOSSARY, FAQ, GETTING, FLOWS, SECTIONS_FOR, clearanceOf };
