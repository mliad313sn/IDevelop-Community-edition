document.addEventListener('DOMContentLoaded', () => {
    const helpFab = document.getElementById('helpFab');
    const helpPanel = document.getElementById('helpPanel');
    const helpClose = document.getElementById('helpClose');
    const helpTabs = document.querySelectorAll('.help-tab');
    const helpSections = document.querySelectorAll('.help-section');

    if (!helpFab || !helpPanel) return;

    // Bilingual picker. The contextual help is a static client script (it cannot use
    // the i18next __ helper), so each string carries both languages and we pick by
    // the <html lang> the server rendered. Default to French (the primary UI language).
    const LANG =
        String(document.documentElement.lang || 'fr')
            .toLowerCase()
            .indexOf('en') === 0
            ? 'en'
            : 'fr';
    const L = (en, fr) => (LANG === 'en' ? en : fr == null ? en : fr);

    // Focus management for the modal dialog (WCAG 2.4.3 / aria-modal honesty):
    // move focus in on open, trap Tab inside, restore focus to the trigger on close.
    let lastFocused = null;
    function focusables() {
        return Array.from(
            helpPanel.querySelectorAll(
                'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'
            )
        ).filter((el) => el.offsetParent !== null);
    }
    function trapTab(e) {
        if (e.key !== 'Tab') return;
        const f = focusables();
        if (!f.length) return;
        const first = f[0],
            last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
    function openHelp() {
        lastFocused = document.activeElement;
        helpPanel.classList.add('active');
        helpFab.setAttribute('aria-expanded', 'true');
        const f = focusables();
        (helpClose || f[0] || helpPanel).focus && (helpClose || f[0] || helpPanel).focus();
        helpPanel.addEventListener('keydown', trapTab);
    }
    function closeHelp() {
        helpPanel.classList.remove('active');
        helpFab.setAttribute('aria-expanded', 'false');
        helpPanel.removeEventListener('keydown', trapTab);
        if (lastFocused && lastFocused.focus) lastFocused.focus();
        else helpFab.focus();
    }
    function toggleHelp() {
        helpPanel.classList.contains('active') ? closeHelp() : openHelp();
    }

    helpFab.addEventListener('click', toggleHelp);
    if (helpClose) helpClose.addEventListener('click', closeHelp);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpPanel.classList.contains('active')) closeHelp();
    });
    document.addEventListener('click', (e) => {
        if (
            helpPanel.classList.contains('active') &&
            !helpPanel.contains(e.target) &&
            !helpFab.contains(e.target)
        )
            closeHelp();
    });

    // ---------------------------------------------------------------------------
    // Per-module help. Each entry: title, why (process/purpose), steps (how to use),
    // practices (good practices), value (how to get the most value). Every string is
    // L(en, fr) so the panel matches the page language.
    // Matched by exact path first, then by longest startsWith prefix.
    // ---------------------------------------------------------------------------
    const HELP_CONTENT = {
        '/dashboard': {
            title: L('Workforce Capability Dashboard', 'Tableau de bord des capacités'),
            why: L(
                '<strong>Process:</strong> The decision cockpit. It aggregates skills, readiness, talent and engagement data into one scannable view so managers and admins can spot risk and act. Tabs: <em>Executive Overview</em> (risk index, health scorecard, Workforce &amp; Talent measures), <em>Training Priorities</em>, <em>Talent Development</em> (coaching/IDP/PIP/9-box rollups), <em>Capability Map</em>, <em>Comparator</em>.',
                "<strong>Processus :</strong> le cockpit de décision. Il regroupe les données de compétences, de préparation, de talent et d'engagement dans une vue unique et lisible, pour que managers et administrateurs repèrent les risques et agissent. Onglets : <em>Vue exécutive</em> (indice de risque, tableau de santé, mesures Effectif &amp; Talent), <em>Priorités de formation</em>, <em>Développement des talents</em> (synthèses coaching/PDI/PIP/9-box), <em>Carte des capacités</em>, <em>Comparateur</em>."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Filter first:</strong> set Site / Department / Service at the top, then Apply — every chart and measure re-scopes to that population.',
                        "<strong>Filtrez d'abord :</strong> réglez Site / Département / Service en haut, puis Appliquer — chaque graphique et mesure se recentre sur cette population."
                    ),
                },
                {
                    text: L(
                        '<strong>Read the Risk Index:</strong> the gauge blends readiness, coverage, compliance, staffing and freshness into one 0-100 score.',
                        "<strong>Lisez l'indice de risque :</strong> la jauge combine préparation, couverture, conformité, effectif et fraîcheur en un score unique de 0 à 100."
                    ),
                },
                {
                    text: L(
                        '<strong>Scan the Health Scorecard + Workforce &amp; Talent measures</strong> for headcount, span of control, 9-box placement, active coaching/IDP/PIP, goals and check-in cadence.',
                        "<strong>Parcourez le tableau de santé + les mesures Effectif &amp; Talent</strong> : effectif, périmètre d'encadrement, positionnement 9-box, coaching/PDI/PIP actifs, objectifs et cadence des points."
                    ),
                },
                {
                    text: L(
                        "<strong>Read the Sub-Domain Capability radar</strong> (Executive tab): actual vs required proficiency by competency element. Pick a pillar from the selector to drill the axes into that pillar's sub-domains.",
                        '<strong>Lisez le radar des capacités par sous-domaine</strong> (onglet Exécutif) : niveau réel vs requis par élément de compétence. Choisissez un pilier dans le sélecteur pour détailler les axes en sous-domaines de ce pilier.'
                    ),
                },
                {
                    text: L(
                        '<strong>Switch tabs</strong> to drill from the executive summary into training priorities and the talent-development rollup.',
                        "<strong>Changez d'onglet</strong> pour passer de la synthèse exécutive aux priorités de formation et à la synthèse du développement des talents."
                    ),
                },
            ],
            practices: [
                L(
                    'Review weekly, not annually — the data is continuous.',
                    'Consultez-le chaque semaine, pas une fois par an — les données sont continues.'
                ),
                L(
                    'Use the Sub-Domain radar to target the widest actual-vs-required gaps per competency element.',
                    'Servez-vous du radar par sous-domaine pour cibler les plus grands écarts réel-vs-requis par élément de compétence.'
                ),
                L(
                    'Always set the org filter before reading numbers, so you are looking at your own population.',
                    'Réglez toujours le filtre organisationnel avant de lire les chiffres, pour ne voir que votre population.'
                ),
                L(
                    'Treat the Risk Index as a trigger to drill down, not as a final verdict.',
                    "Traitez l'indice de risque comme un déclencheur d'analyse, pas comme un verdict final."
                ),
            ],
            value: L(
                'Use the dashboard as your standing agenda: each weak metric points to a concrete action (assess, calibrate, coach, set goals) you can launch from the relevant module.',
                'Utilisez le tableau de bord comme ordre du jour permanent : chaque indicateur faible pointe vers une action concrète (évaluer, calibrer, coacher, fixer des objectifs) lançable depuis le module concerné.'
            ),
        },

        '/skill-matrix': {
            title: L('Skill Matrix', 'Matrice de compétences'),
            why: L(
                '<strong>Process:</strong> The single source of truth for who-can-do-what. Employees (rows) x skills (columns) as a colour-coded grid showing current level vs the level the role requires, with the gap and readiness status. Assessing a cell writes the official level and an immutable history entry.',
                "<strong>Processus :</strong> la source unique de vérité sur qui-sait-faire-quoi. Collaborateurs (lignes) x compétences (colonnes) dans une grille en couleurs montrant le niveau actuel vs le niveau requis par le poste, avec l'écart et le statut de préparation. Évaluer une cellule inscrit le niveau officiel et une entrée d'historique immuable."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Filter / search</strong> by site, department, service, role or readiness; use the search box to find a person by name or number.',
                        '<strong>Filtrez / recherchez</strong> par site, département, service, poste ou préparation ; utilisez la recherche pour trouver une personne par nom ou matricule.'
                    ),
                },
                {
                    text: L(
                        '<strong>Open a cell</strong> to assess: set the level (0-4) and add notes; required level and the gap are shown in the modal.',
                        "<strong>Ouvrez une cellule</strong> pour évaluer : réglez le niveau (0-4) et ajoutez des notes ; le niveau requis et l'écart s'affichent dans la fenêtre."
                    ),
                },
                {
                    text: L(
                        '<strong>Read colour + badges:</strong> cells are coloured by proficiency; "Required" and "Critical" markers show role expectations.',
                        '<strong>Lisez couleur + badges :</strong> les cellules sont colorées selon le niveau ; les marqueurs « Requis » et « Critique » indiquent les attentes du poste.'
                    ),
                },
                {
                    text: L(
                        "<strong>History tab</strong> in the modal shows the skill's evolution over time (who assessed, when, movement).",
                        "<strong>L'onglet Historique</strong> de la fenêtre montre l'évolution de la compétence (qui a évalué, quand, la progression)."
                    ),
                },
                {
                    text: L(
                        '<strong>Export CSV</strong> for offline analysis (formula-injection safe).',
                        "<strong>Exportez en CSV</strong> pour une analyse hors ligne (protégé contre l'injection de formules)."
                    ),
                },
            ],
            practices: [
                L(
                    'Keep assessments current — the dashboard "Assessment Freshness" measure rewards recent data.',
                    'Gardez les évaluations à jour — la mesure « Fraîcheur des évaluations » du tableau de bord récompense les données récentes.'
                ),
                L(
                    'Use 0-4 honestly: inflated levels hide real gaps and break readiness.',
                    'Utilisez le 0-4 honnêtement : des niveaux gonflés masquent les vrais écarts et faussent la préparation.'
                ),
                L(
                    "Assess against the role requirement, not against the person's effort.",
                    "Évaluez par rapport à l'exigence du poste, pas par rapport à l'effort de la personne."
                ),
            ],
            value: L(
                'Once the matrix is populated and fresh, every downstream module (readiness, 9-box, gap reports, coaching context) becomes accurate automatically — it is the foundation, so invest here first.',
                "Une fois la matrice remplie et à jour, chaque module en aval (préparation, 9-box, rapports d'écarts, contexte de coaching) devient exact automatiquement — c'est le socle, investissez-y en premier."
            ),
        },

        '/employees': {
            title: L(
                'Employees &amp; Employee Profile',
                'Collaborateurs &amp; fiche collaborateur'
            ),
            why: L(
                '<strong>Process:</strong> The people directory and the hub for everything about one person. The profile (open an employee) is where you run the continuous-performance loop: <em>Goals &amp; OKRs</em>, <em>Check-ins / 1-on-1s</em>, plus the development sections (coaching, IDP, PIP) and the 9-box position.',
                "<strong>Processus :</strong> l'annuaire des personnes et le hub de tout ce qui concerne une personne. La fiche (ouvrez un collaborateur) est l'endroit où vous menez la boucle de performance continue : <em>Objectifs &amp; OKR</em>, <em>Points / entretiens individuels</em>, ainsi que les sections de développement (coaching, PDI, PIP) et le positionnement 9-box."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Search by name</strong> (or number/email) to find a person, then open the profile.',
                        '<strong>Recherchez par nom</strong> (ou matricule/e-mail) pour trouver une personne, puis ouvrez la fiche.'
                    ),
                },
                {
                    text: L(
                        '<strong>Goals &amp; OKRs:</strong> add an objective, then measurable key results under it; update progress to track delivery.',
                        "<strong>Objectifs &amp; OKR :</strong> ajoutez un objectif, puis des résultats clés mesurables ; mettez à jour l'avancement pour suivre la réalisation."
                    ),
                },
                {
                    text: L(
                        '<strong>Check-ins:</strong> log 1-on-1 / feedback / pulse conversations with agenda + action items and a mood rating.',
                        "<strong>Points :</strong> consignez les entretiens individuels / feedbacks / échanges rapides avec ordre du jour + actions et une note d'humeur."
                    ),
                },
                {
                    text: L(
                        '<strong>Assign structure &amp; role</strong> (edit profile): site/department/service + job role drive required skills and the org chart.',
                        "<strong>Affectez structure &amp; poste</strong> (modifier la fiche) : site/département/service + poste déterminent les compétences requises et l'organigramme."
                    ),
                },
                {
                    text: L(
                        '<strong>Manager / supervisor</strong> links here define the reporting lines used by RBAC, the org chart and talent rollups.',
                        "<strong>Les liens manager / superviseur</strong> définis ici fixent les lignes hiérarchiques utilisées par les droits d'accès, l'organigramme et les synthèses de talent."
                    ),
                },
            ],
            practices: [
                L(
                    'Keep the manager/supervisor links accurate — they govern who can see and act on whom.',
                    'Gardez les liens manager/superviseur exacts — ils déterminent qui peut voir et agir sur qui.'
                ),
                L(
                    'Set OKRs that map to real skill gaps or development needs, not vanity targets.',
                    'Fixez des OKR reliés à de vrais écarts de compétence ou besoins de développement, pas des cibles de façade.'
                ),
                L(
                    'Use check-ins as the recurring rhythm to review goals and coaching/IDP actions together.',
                    'Utilisez les points comme rythme récurrent pour passer en revue objectifs et actions de coaching/PDI ensemble.'
                ),
            ],
            value: L(
                'Run the loop on the profile: review skills/9-box &rarr; set OKRs &rarr; discuss them in regular check-ins &rarr; capture action items &rarr; feed coaching/IDP. That cadence is where the platform pays off.',
                "Déroulez la boucle sur la fiche : revoir compétences/9-box &rarr; fixer les OKR &rarr; en discuter lors de points réguliers &rarr; consigner les actions &rarr; alimenter coaching/PDI. C'est cette cadence qui rentabilise la plateforme."
            ),
        },

        '/org-chart': {
            title: L('Org Chart', 'Organigramme'),
            why: L(
                '<strong>Process:</strong> A live, graphical view of the organisation built from the manager and supervisor relationships, plus a structural view by Site / Department / Service. It is read-only — the hierarchy itself is edited on employee profiles.',
                "<strong>Processus :</strong> une vue graphique et vivante de l'organisation construite à partir des relations manager et superviseur, plus une vue structurelle par Site / Département / Service. En lecture seule — la hiérarchie elle-même se modifie sur les fiches collaborateur."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Switch view:</strong> Manager line, Supervisor line, or Site / Dept / Service structure.',
                        '<strong>Changez de vue :</strong> ligne Manager, ligne Superviseur, ou structure Site / Dépt / Service.'
                    ),
                },
                {
                    text: L(
                        '<strong>Search</strong> a name/role/unit — matches highlight and their branch auto-expands.',
                        '<strong>Recherchez</strong> un nom/poste/unité — les correspondances se surlignent et leur branche se déploie automatiquement.'
                    ),
                },
                {
                    text: L(
                        '<strong>Focus</strong> on a person (target icon) to view just their team; "Full chart" returns.',
                        '<strong>Ciblez</strong> une personne (icône cible) pour voir seulement son équipe ; « Organigramme complet » revient en arrière.'
                    ),
                },
                {
                    text: L(
                        '<strong>Zoom and collapse/expand</strong> to navigate large trees.',
                        '<strong>Zoomez et repliez/dépliez</strong> pour naviguer dans les grands arbres.'
                    ),
                },
            ],
            practices: [
                L(
                    'Use Focus to brief on one team without the noise of the whole org.',
                    "Utilisez le ciblage pour présenter une équipe sans le bruit de toute l'organisation."
                ),
                L(
                    'If the chart looks wrong, fix the manager/supervisor field on the employee profile — the chart just reflects it.',
                    "Si l'organigramme semble faux, corrigez le champ manager/superviseur sur la fiche collaborateur — l'organigramme ne fait que le refléter."
                ),
            ],
            value: L(
                'Toggle Manager vs Supervisor lines to verify reporting integrity, and use the Structure view to sanity-check headcount distribution across sites and departments.',
                "Basculez entre lignes Manager et Superviseur pour vérifier l'intégrité hiérarchique, et servez-vous de la vue Structure pour contrôler la répartition des effectifs entre sites et départements."
            ),
        },

        '/coaching/plans': {
            title: L('Coaching &amp; Mentoring', 'Coaching &amp; mentorat'),
            why: L(
                '<strong>Process:</strong> Structured development engagements. Coaching and mentoring share ONE workflow (pick the emphasis as a type). Every plan MUST be anchored to a development context — an <em>IDP</em>, a <em>PIP</em>, or a <em>skill gap</em> — so progress is measurable and auditable. Plans run as GROW-style sessions with SMART objectives that carry forward.',
                "<strong>Processus :</strong> des accompagnements de développement structurés. Coaching et mentorat partagent UN seul flux (choisissez l'accent comme type). Chaque plan DOIT être rattaché à un contexte de développement — un <em>PDI</em>, un <em>PIP</em> ou un <em>écart de compétence</em> — pour que la progression soit mesurable et auditable. Les plans se déroulent en séances de type GROW avec des objectifs SMART reportés d'une séance à l'autre."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick an employee</strong> in your span, then "Start plan" and choose the type (Coaching or Mentoring).',
                        '<strong>Choisissez un collaborateur</strong> de votre périmètre, puis « Démarrer un plan » et choisissez le type (Coaching ou Mentorat).'
                    ),
                },
                {
                    text: L(
                        '<strong>Link the context</strong> (required): an IDP, a PIP, or a specific skill gap — this is what the engagement closes.',
                        "<strong>Reliez le contexte</strong> (obligatoire) : un PDI, un PIP ou un écart de compétence précis — c'est ce que l'accompagnement doit combler."
                    ),
                },
                {
                    text: L(
                        '<strong>Set title, objective, expected outcome, target date.</strong>',
                        '<strong>Renseignez titre, objectif, résultat attendu, date cible.</strong>'
                    ),
                },
                {
                    text: L(
                        '<strong>Run sessions</strong> (GROW): record notes and SMART objectives; open objectives carry into the next session.',
                        '<strong>Menez les séances</strong> (GROW) : consignez notes et objectifs SMART ; les objectifs ouverts se reportent à la séance suivante.'
                    ),
                },
                {
                    text: L(
                        '<strong>Validate completion</strong> when the development goal is met.',
                        "<strong>Validez la clôture</strong> quand l'objectif de développement est atteint."
                    ),
                },
            ],
            practices: [
                L(
                    'Always tie a plan to a real context (gap/IDP/PIP) — context-free coaching is not measurable.',
                    "Rattachez toujours un plan à un vrai contexte (écart/PDI/PIP) — un coaching sans contexte n'est pas mesurable."
                ),
                L(
                    'Keep sessions short and regular; let objectives carry forward rather than re-creating them.',
                    'Gardez des séances courtes et régulières ; laissez les objectifs se reporter plutôt que de les recréer.'
                ),
                L(
                    'Use mentoring for breadth/career growth, coaching for a specific performance/skill target.',
                    "Utilisez le mentorat pour l'ouverture/l'évolution de carrière, le coaching pour une cible précise de performance/compétence."
                ),
            ],
            value: L(
                'Pair coaching with the OKRs and check-ins on the employee profile: the plan defines the development work, OKRs make it measurable, and the 1-on-1 is where you review it.',
                "Associez le coaching aux OKR et aux points de la fiche collaborateur : le plan définit le travail de développement, les OKR le rendent mesurable, et l'entretien individuel est le moment où vous le passez en revue."
            ),
        },

        '/talent/nine-box': {
            title: L('9-Box Talent Grid', 'Grille de talents 9-box'),
            why: L(
                '<strong>Process:</strong> Performance x potential calibration. A supervisor drafts a placement; a manager approves/publishes it. Placements are confidential by default. A high-potential (blue) box proposes an IDP. A low-performance (red) box does NOT open a performance plan: it raises a task for the manager, who opens the plan with a written reason — and can withdraw it themselves.',
                "<strong>Processus :</strong> une calibration performance x potentiel. Un superviseur ébauche un positionnement ; un manager l'approuve/le publie. Les positionnements sont confidentiels par défaut. Une case haut potentiel (bleue) propose un PDI. Une case faible performance (rouge) n'ouvre PAS de plan de performance : elle crée une tâche pour le manager, qui ouvre le plan avec un motif écrit — et peut le retirer lui-même."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Assess</strong> an employee (or accept the system suggestion), setting performance + potential and in-box tier.',
                        '<strong>Évaluez</strong> un collaborateur (ou acceptez la suggestion du système), en réglant performance + potentiel et le rang dans la case.'
                    ),
                },
                {
                    text: L(
                        '<strong>Submit then approve</strong> (manager) to publish. A blue box proposes an IDP; a red box raises a task in the PIP console.',
                        '<strong>Soumettez puis approuvez</strong> (manager) pour publier. Une case bleue propose un PDI ; une case rouge crée une tâche dans la console PIP.'
                    ),
                },
                {
                    text: L(
                        '<strong>Disclose</strong> an approved placement when you want the employee to see their own position (off by default). A written reason is required, and the person then sees the date and who disclosed it.',
                        "<strong>Divulguez</strong> un positionnement approuvé quand vous voulez que le collaborateur voie sa propre position (désactivé par défaut). Un motif écrit est obligatoire, et la personne voit ensuite la date et l'auteur de la divulgation."
                    ),
                },
                {
                    text: L(
                        '<strong>Review the grid</strong> — you only see your own collaborators (hierarchically scoped).',
                        '<strong>Consultez la grille</strong> — vous ne voyez que vos propres collaborateurs (périmètre hiérarchique).'
                    ),
                },
            ],
            practices: [
                L(
                    'Calibrate as a group to reduce bias; use evidence (skills, results), not impressions.',
                    'Calibrez en groupe pour réduire les biais ; appuyez-vous sur des preuves (compétences, résultats), pas des impressions.'
                ),
                L(
                    'Keep placements confidential unless you have a development conversation ready — then disclose deliberately.',
                    "Gardez les positionnements confidentiels tant qu'une conversation de développement n'est pas prête — puis divulguez délibérément."
                ),
                L(
                    'Clear your decision queue: a red box leaves a task, and a task nobody answers is a person nobody decided about.',
                    "Videz votre file de décisions : une case rouge laisse une tâche, et une tâche sans réponse est une personne sur laquelle personne n'a tranché."
                ),
            ],
            value: L(
                "Treat 9-box as the entry point to development, not a label: every placement should lead to a decision (IDP for blue, a manager's decision for red, stretch goals for stars).",
                "Traitez le 9-box comme le point d'entrée du développement, pas comme une étiquette : chaque positionnement doit mener à une décision (PDI pour les bleus, une décision du manager pour les rouges, objectifs ambitieux pour les stars)."
            ),
        },

        '/talent/actions': {
            title: L('Talent Actions', 'Actions de talent'),
            why: L(
                '<strong>Process:</strong> A consolidated cockpit of all active talent interventions for your span — PIPs, IDPs, coaching/mentoring and 9-box — in one place, so nothing falls through the cracks.',
                '<strong>Processus :</strong> un cockpit consolidé de toutes les interventions de talent actives sur votre périmètre — PIP, PDI, coaching/mentorat et 9-box — au même endroit, pour que rien ne passe à travers les mailles.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Scan</strong> open PIPs, IDPs and coaching plans across your team.',
                        '<strong>Parcourez</strong> les PIP, PDI et plans de coaching ouverts dans votre équipe.'
                    ),
                },
                {
                    text: L(
                        '<strong>Drill into</strong> any item to act (advance state, add actions, validate).',
                        "<strong>Ouvrez</strong> n'importe quel élément pour agir (faire avancer l'état, ajouter des actions, valider)."
                    ),
                },
                {
                    text: L(
                        '<strong>Use as a follow-up list</strong> in your 1-on-1s and calibration reviews.',
                        '<strong>Utilisez-le comme liste de suivi</strong> lors de vos entretiens individuels et revues de calibration.'
                    ),
                },
            ],
            practices: [
                L(
                    'Work this list weekly so interventions actually progress rather than stalling as "proposed".',
                    'Traitez cette liste chaque semaine pour que les interventions progressent vraiment au lieu de stagner à « proposé ».'
                ),
                L(
                    'Close items honestly (success/failure) — clean state powers accurate dashboards.',
                    'Clôturez les éléments honnêtement (succès/échec) — un état propre alimente des tableaux de bord exacts.'
                ),
            ],
            value: L(
                'This is your single backlog for people-development; keeping it short and moving is the clearest sign the talent process is healthy.',
                "C'est votre backlog unique pour le développement des personnes ; le garder court et en mouvement est le signe le plus clair que le processus de talent est sain."
            ),
        },

        '/benchmark': {
            title: L('Benchmark', 'Référentiel'),
            why: L(
                '<strong>Process:</strong> A reference view over the role DEFINITIONS, not individuals. The <em>matrix</em> lines roles up (columns) against skills grouped by pillar &rarr; sub-domain (rows); each cell is the level that role requires (0-4), and the <strong>&Delta; (variation)</strong> column is the spread between the highest- and lowest-requiring role for that skill. The <em>fit table</em> then measures how well the people currently in each role meet its benchmark. The matrix is org-wide reference data (unscoped); the fit table is scoped to your people.',
                "<strong>Processus :</strong> une vue de référence sur les DÉFINITIONS de postes, pas sur les individus. La <em>matrice</em> aligne les postes (colonnes) face aux compétences groupées par pilier &rarr; sous-domaine (lignes) ; chaque cellule est le niveau requis par ce poste (0-4), et la colonne <strong>&Delta; (variation)</strong> est l'écart entre le poste le plus exigeant et le moins exigeant pour cette compétence. La <em>table d'adéquation</em> mesure ensuite dans quelle mesure les personnes actuellement en poste atteignent son référentiel. La matrice est une donnée de référence à l'échelle de l'organisation (sans périmètre) ; la table d'adéquation est limitée à vos personnes."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Filter the matrix:</strong> pillar, sub-domain, role family, a specific role, or capability type (Technical / Behavioral / Safety / Compliance); "critical only" narrows to must-have skills.',
                        '<strong>Filtrez la matrice :</strong> pilier, sous-domaine, famille de postes, un poste précis, ou type de capacité (Technique / Comportemental / Sécurité / Conformité) ; « critiques seulement » réduit aux compétences incontournables.'
                    ),
                },
                {
                    text: L(
                        "<strong>Read the cells:</strong> each is a role's required level; the <strong>&Delta;</strong> column flags skills whose requirement varies most across roles (a candidate to standardise).",
                        "<strong>Lisez les cellules :</strong> chacune est le niveau requis d'un poste ; la colonne <strong>&Delta;</strong> signale les compétences dont l'exigence varie le plus entre postes (à standardiser en priorité)."
                    ),
                },
                {
                    text: L(
                        '<strong>Read the fit table:</strong> per role, Benchmark Fit % (avg share of required points met), Critical Fit, Coverage (share of required skills assessed), occupants with a critical gap, and how many are Ready &ge;80%.',
                        "<strong>Lisez la table d'adéquation :</strong> par poste, % d'adéquation au référentiel (part moyenne des points requis atteints), adéquation critique, couverture (part des compétences requises évaluées), titulaires avec un écart critique, et combien sont Prêts &ge;80 %."
                    ),
                },
                {
                    text: L(
                        '<strong>Read Coverage next to Fit:</strong> a low fit at low coverage means the people are not assessed yet, not that they are weak.',
                        "<strong>Lisez la couverture à côté de l'adéquation :</strong> une faible adéquation à faible couverture signifie que les personnes ne sont pas encore évaluées, pas qu'elles sont faibles."
                    ),
                },
                {
                    text: L(
                        '<strong>Export CSV</strong> for the full matrix (one column per role), formula-injection safe.',
                        "<strong>Exportez en CSV</strong> la matrice complète (une colonne par poste), protégé contre l'injection de formules."
                    ),
                },
            ],
            practices: [
                L(
                    'Treat a high &Delta; on a critical skill as a governance signal: either the requirement is genuinely role-specific, or two similar roles have drifted and should be aligned.',
                    "Traitez un &Delta; élevé sur une compétence critique comme un signal de gouvernance : soit l'exigence est réellement propre au poste, soit deux postes similaires ont dérivé et devraient être alignés."
                ),
                L(
                    'Chase coverage before chasing fit — you cannot trust a fit number built on a handful of assessments.',
                    "Cherchez la couverture avant l'adéquation — un chiffre d'adéquation bâti sur une poignée d'évaluations n'est pas fiable."
                ),
                L(
                    'Use the role-name links from the dashboard "Benchmark Fit by Role" table to jump straight to that role\'s matrix.',
                    'Utilisez les liens de nom de poste de la table « Adéquation au référentiel par poste » du tableau de bord pour aller directement à la matrice de ce poste.'
                ),
            ],
            value: L(
                'Benchmark turns the role library into a decision tool: it shows where requirements are inconsistent across roles and where the people in a role are genuinely short of what the role demands — the two inputs to fixing role definitions and targeting development.',
                'Le référentiel transforme la bibliothèque de postes en outil de décision : il montre où les exigences sont incohérentes entre postes et où les personnes en poste sont réellement en deçà de ce que le poste demande — les deux leviers pour corriger les définitions de postes et cibler le développement.'
            ),
        },

        '/v2/pip': {
            title: L(
                'Performance Improvement Plan (PIP)',
                "Plan d'amélioration de la performance (PIP)"
            ),
            why: L(
                '<strong>Process:</strong> A manager-owned plan to address under-performance. Manager-direct (no HR maker-checker): propose &rarr; activate &rarr; close (success or failure). Often auto-proposed from a red 9-box.',
                "<strong>Processus :</strong> un plan piloté par le manager pour traiter une sous-performance. Direct manager (sans double contrôle RH) : proposer &rarr; activer &rarr; clôturer (succès ou échec). Souvent proposé automatiquement à partir d'une case 9-box rouge."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Propose</strong> a PIP for a report with a summary and start/end dates.',
                        '<strong>Proposez</strong> un PIP pour un collaborateur avec un résumé et des dates de début/fin.'
                    ),
                },
                {
                    text: L(
                        '<strong>Activate</strong> when the plan is agreed with the employee.',
                        '<strong>Activez</strong> quand le plan est convenu avec le collaborateur.'
                    ),
                },
                {
                    text: L(
                        '<strong>Support it</strong> with a coaching plan linked to the PIP context.',
                        '<strong>Soutenez-le</strong> par un plan de coaching relié au contexte du PIP.'
                    ),
                },
                {
                    text: L(
                        '<strong>Close</strong> as success or failure with an outcome note.',
                        '<strong>Clôturez</strong> en succès ou échec avec une note de résultat.'
                    ),
                },
            ],
            practices: [
                L(
                    'Pair every PIP with concrete coaching and measurable goals — a PIP without support rarely succeeds.',
                    'Associez chaque PIP à un coaching concret et des objectifs mesurables — un PIP sans soutien réussit rarement.'
                ),
                L(
                    'Document objectively and review in regular check-ins.',
                    "Documentez de façon objective et faites le point lors d'entretiens réguliers."
                ),
                L(
                    'Set realistic dates; close promptly when the outcome is clear.',
                    'Fixez des dates réalistes ; clôturez sans tarder dès que le résultat est clair.'
                ),
            ],
            value: L(
                'Used early and supportively (not as a last step), the PIP + coaching combination turns a struggling performer around and creates a defensible record either way.',
                'Utilisée tôt et de façon bienveillante (pas comme dernier recours), la combinaison PIP + coaching redresse un collaborateur en difficulté et crée une trace défendable quel que soit le résultat.'
            ),
        },

        '/v2/idp': {
            title: L('Individual Development Plan (IDP)', 'Plan de développement individuel (PDI)'),
            why: L(
                '<strong>Process:</strong> A forward-looking growth plan (objectives + actions) for high-potential or developing employees. Often auto-proposed from a blue 9-box. Actions can carry a post-rating that promotes a skill level on completion.',
                "<strong>Processus :</strong> un plan de croissance prospectif (objectifs + actions) pour les collaborateurs à haut potentiel ou en développement. Souvent proposé automatiquement à partir d'une case 9-box bleue. Les actions peuvent porter une note finale qui relève un niveau de compétence à leur achèvement."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Open the IDP</strong> (proposed automatically, or create one) and review its objectives.',
                        '<strong>Ouvrez le PDI</strong> (proposé automatiquement, ou créez-en un) et passez en revue ses objectifs.'
                    ),
                },
                {
                    text: L(
                        '<strong>Add development actions</strong> with owners and target dates.',
                        '<strong>Ajoutez des actions de développement</strong> avec responsables et dates cibles.'
                    ),
                },
                {
                    text: L(
                        '<strong>Sign off</strong> actions as they complete; a post-rating can lift the related skill level.',
                        "<strong>Validez</strong> les actions à mesure qu'elles s'achèvent ; une note finale peut relever le niveau de la compétence concernée."
                    ),
                },
                {
                    text: L(
                        '<strong>Support with coaching/mentoring</strong> anchored to the IDP.',
                        '<strong>Soutenez par du coaching/mentorat</strong> rattaché au PDI.'
                    ),
                },
            ],
            practices: [
                L(
                    'Tie IDP actions to specific skill gaps so completion visibly improves readiness.',
                    'Reliez les actions du PDI à des écarts de compétence précis pour que leur achèvement améliore visiblement la préparation.'
                ),
                L(
                    'Keep 2-4 active actions — focus beats a long wish-list.',
                    "Gardez 2 à 4 actions actives — la concentration vaut mieux qu'une longue liste de souhaits."
                ),
                L(
                    'Review progress in check-ins, not just at cycle end.',
                    'Suivez la progression lors des points, pas seulement en fin de cycle.'
                ),
            ],
            value: L(
                'The IDP is how you retain and grow your best people; linking actions to skills means development shows up directly in the matrix and 9-box.',
                'Le PDI est la façon de retenir et faire grandir vos meilleurs éléments ; relier les actions aux compétences fait que le développement se voit directement dans la matrice et le 9-box.'
            ),
        },

        '/supervisor/self-assessment-reviews': {
            title: L('Self-Assessment Reviews', "Revues d'auto-évaluation"),
            why: L(
                '<strong>Process:</strong> Employees self-rate their skills; supervisors/managers review and approve or adjust. Approval promotes the rating to the official skill level (advancing both the legacy status and the V2 workflow state together) and records history.',
                "<strong>Processus :</strong> les collaborateurs auto-évaluent leurs compétences ; superviseurs/managers examinent et approuvent ou ajustent. L'approbation promeut la note au niveau de compétence officiel (en faisant avancer ensemble le statut historique et l'état de flux V2) et inscrit l'historique."
            ),
            steps: [
                {
                    text: L(
                        "<strong>Open the review queue</strong> for your team's submissions.",
                        '<strong>Ouvrez la file de revue</strong> des soumissions de votre équipe.'
                    ),
                },
                {
                    text: L(
                        '<strong>Per employee:</strong> compare self-rating vs evidence; approve, adjust, or reject with a reason.',
                        "<strong>Par collaborateur :</strong> comparez l'auto-note aux preuves ; approuvez, ajustez, ou rejetez avec un motif."
                    ),
                },
                {
                    text: L(
                        '<strong>Bulk-approve</strong> straightforward submissions to save time.',
                        '<strong>Approuvez en lot</strong> les soumissions évidentes pour gagner du temps.'
                    ),
                },
                {
                    text: L(
                        'Approved levels flow into the Skill Matrix and readiness automatically.',
                        'Les niveaux approuvés alimentent automatiquement la matrice de compétences et la préparation.'
                    ),
                },
            ],
            practices: [
                L(
                    'Review promptly so employees get feedback while it is fresh.',
                    'Examinez rapidement pour que les collaborateurs reçoivent un retour à chaud.'
                ),
                L(
                    'Adjust with a note rather than silently rejecting — it builds trust and calibration.',
                    'Ajustez avec une note plutôt que de rejeter en silence — cela renforce la confiance et la calibration.'
                ),
                L(
                    'You cannot review your own self-assessment (separation of duties) — route it to your manager.',
                    'Vous ne pouvez pas examiner votre propre auto-évaluation (séparation des tâches) — orientez-la vers votre manager.'
                ),
            ],
            value: L(
                'A disciplined review cadence keeps the whole skills dataset trustworthy, which is what makes every report and dashboard credible.',
                'Une cadence de revue rigoureuse maintient la fiabilité de tout le jeu de données de compétences, ce qui rend chaque rapport et tableau de bord crédible.'
            ),
        },

        '/employee/self-assessment': {
            title: L('My Self-Assessment', 'Mon auto-évaluation'),
            why: L(
                "<strong>Process:</strong> Where you rate your own skills against your role's requirements and submit them for your manager to validate. Your honest input is the starting point of the whole capability picture.",
                "<strong>Processus :</strong> l'endroit où vous évaluez vos propres compétences par rapport aux exigences de votre poste et les soumettez à la validation de votre manager. Votre saisie honnête est le point de départ de toute la cartographie des capacités."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Rate each required skill</strong> 0-4 with an honest current level.',
                        '<strong>Évaluez chaque compétence requise</strong> de 0 à 4 avec un niveau actuel honnête.'
                    ),
                },
                {
                    text: L(
                        '<strong>Add notes/evidence</strong> where useful to help your reviewer.',
                        "<strong>Ajoutez notes/preuves</strong> là où c'est utile pour aider votre évaluateur."
                    ),
                },
                {
                    text: L(
                        '<strong>Submit</strong> — your manager reviews and approves or adjusts.',
                        '<strong>Soumettez</strong> — votre manager examine et approuve ou ajuste.'
                    ),
                },
            ],
            practices: [
                L(
                    'Be honest — under-rating hides your strengths, over-rating hides real development needs.',
                    'Soyez honnête — sous-évaluer masque vos forces, surévaluer masque de vrais besoins de développement.'
                ),
                L(
                    'Note recent examples; they make the review faster and fairer.',
                    'Notez des exemples récents ; ils rendent la revue plus rapide et plus juste.'
                ),
            ],
            value: L(
                'A thoughtful self-assessment is your fastest route to relevant development: accurate gaps lead to the right IDP, coaching and goals for you.',
                'Une auto-évaluation réfléchie est votre chemin le plus rapide vers un développement pertinent : des écarts justes mènent au bon PDI, au bon coaching et aux bons objectifs pour vous.'
            ),
        },

        '/domains-skills': {
            title: L(
                'Capability Framework (Domains &amp; Skills)',
                'Référentiel de capacités (domaines &amp; compétences)'
            ),
            why: L(
                '<strong>Process:</strong> The competency catalogue, standardized on the built-in capability framework: <strong>Domain / Pillar → Sub-Domain (Competency Element) → Skill / Capability Item</strong>. Six pillars (HSE &amp; Operational Risk, Functional Technical, Digital/Data/Work Tools, Compliance &amp; Certification, Business Acumen, People Management) each hold defined sub-domains; skills hang off a sub-domain. Skills also carry a <strong>Role Family</strong> (the department/section dimension) so a role can be built from a family. This catalogue is what roles require and employees are assessed against.',
                "<strong>Processus :</strong> le catalogue de compétences, normalisé sur le référentiel de capacités intégré : <strong>Domaine / Pilier → Sous-domaine (élément de compétence) → Compétence / élément de capacité</strong>. Six piliers (HSE &amp; risque opérationnel, Technique fonctionnel, Numérique/Données/Outils de travail, Conformité &amp; certification, Sens des affaires, Management des personnes) contiennent chacun des sous-domaines définis ; les compétences se rattachent à un sous-domaine. Les compétences portent aussi une <strong>famille de postes</strong> (la dimension département/section) pour qu'un poste puisse être construit à partir d'une famille. Ce catalogue est ce que les postes exigent et ce sur quoi les collaborateurs sont évalués."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Browse by pillar → sub-domain</strong> — each sub-domain has a definition (the competency element it covers).',
                        "<strong>Parcourez par pilier → sous-domaine</strong> — chaque sous-domaine a une définition (l'élément de compétence qu'il couvre)."
                    ),
                },
                {
                    text: L(
                        '<strong>Add skills</strong> under the right sub-domain, with a clear, unambiguous name.',
                        '<strong>Ajoutez des compétences</strong> sous le bon sous-domaine, avec un nom clair et sans ambiguïté.'
                    ),
                },
                {
                    text: L(
                        '<strong>Tag the role family</strong> so the skill is offered when building roles for that family.',
                        '<strong>Étiquetez la famille de postes</strong> pour que la compétence soit proposée lors de la construction des postes de cette famille.'
                    ),
                },
                {
                    text: L(
                        '<strong>Keep names stable</strong> — they are referenced by roles and assessments.',
                        '<strong>Gardez les noms stables</strong> — ils sont référencés par les postes et les évaluations.'
                    ),
                },
            ],
            practices: [
                L(
                    'Place each skill in the sub-domain whose definition fits best — that drives the domain/sub-domain radar.',
                    'Placez chaque compétence dans le sous-domaine dont la définition correspond le mieux — cela pilote le radar domaine/sous-domaine.'
                ),
                L(
                    'Curate deliberately — a bloated catalogue makes assessment a chore and dilutes signal.',
                    "Curez délibérément — un catalogue pléthorique rend l'évaluation pénible et dilue le signal."
                ),
            ],
            value: L(
                'A tight, well-organised catalogue on the standardized pillar/sub-domain taxonomy is the backbone of accurate role requirements, the capability radar and gap analysis.',
                "Un catalogue resserré et bien organisé sur la taxonomie normalisée pilier/sous-domaine est la colonne vertébrale d'exigences de postes justes, du radar de capacités et de l'analyse des écarts."
            ),
        },

        '/roles': {
            title: L('Roles &amp; Requirements', 'Postes &amp; exigences'),
            why: L(
                '<strong>Process:</strong> Defines job roles and the skills + expected levels each role requires. Requirements are the benchmark that turns raw skill data into readiness and gaps. In V3 a role can be linked to a <strong>Role Family</strong>, so its candidate skills come straight from that family — faster, more consistent role creation.',
                '<strong>Processus :</strong> définit les postes et les compétences + niveaux attendus que chaque poste exige. Les exigences sont le référentiel qui transforme les données brutes de compétence en préparation et en écarts. En V3, un poste peut être relié à une <strong>famille de postes</strong>, ses compétences candidates venant directement de cette famille — création de postes plus rapide et cohérente.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Create a role</strong> (job title) and an optional career level/description; optionally link a Role Family.',
                        '<strong>Créez un poste</strong> (intitulé) et un niveau/description de carrière facultatif ; reliez éventuellement une famille de postes.'
                    ),
                },
                {
                    text: L(
                        '<strong>Edit requirements:</strong> select the skills the role needs and the expected level (0-4); mark critical ones. The role family pre-suggests the relevant skills.',
                        '<strong>Modifiez les exigences :</strong> sélectionnez les compétences dont le poste a besoin et le niveau attendu (0-4) ; marquez les critiques. La famille de postes présélectionne les compétences pertinentes.'
                    ),
                },
                {
                    text: L(
                        '<strong>Assign the role</strong> to employees on their profile.',
                        '<strong>Affectez le poste</strong> aux collaborateurs depuis leur fiche.'
                    ),
                },
            ],
            practices: [
                L(
                    'Mark genuinely critical skills as critical — they drive compliance and readiness weighting.',
                    'Marquez comme critiques les compétences réellement critiques — elles pèsent sur la conformité et la préparation.'
                ),
                L(
                    'Set realistic required levels; everything-at-expert makes readiness meaningless.',
                    'Fixez des niveaux requis réalistes ; du « tout au niveau expert » vide la préparation de son sens.'
                ),
                L(
                    'Review requirements when the job actually changes, not constantly.',
                    'Revoyez les exigences quand le poste change réellement, pas en permanence.'
                ),
            ],
            value: L(
                'Accurate role requirements are what make readiness %, the 9-box and gap reports trustworthy — get these right and the analytics follow.',
                "Des exigences de postes justes sont ce qui rend fiables le % de préparation, le 9-box et les rapports d'écarts — réglez-les bien et l'analytique suit."
            ),
        },

        '/reports/builder': {
            title: L('Reports', 'Rapports'),
            why: L(
                '<strong>Process:</strong> Two engines — a flexible report builder (filter + columns &rarr; CSV) and ready-made chart/section views (readiness, gaps, talent overview). For evidence, exports and stakeholder packs.',
                "<strong>Processus :</strong> deux moteurs — un générateur de rapports flexible (filtres + colonnes &rarr; CSV) et des vues graphiques/sections prêtes à l'emploi (préparation, écarts, aperçu talent). Pour les preuves, les exports et les dossiers destinés aux parties prenantes."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick a report type</strong> or build one with filters and columns.',
                        '<strong>Choisissez un type de rapport</strong> ou construisez-en un avec filtres et colonnes.'
                    ),
                },
                {
                    text: L(
                        '<strong>Scope it</strong> by site/department/service/role.',
                        '<strong>Délimitez-le</strong> par site/département/service/poste.'
                    ),
                },
                {
                    text: L(
                        '<strong>Export</strong> to CSV (formula-injection safe) for sharing or deeper analysis.',
                        "<strong>Exportez</strong> en CSV (protégé contre l'injection de formules) pour le partage ou une analyse approfondie."
                    ),
                },
            ],
            practices: [
                L(
                    'Save common report templates so recurring reporting is one click.',
                    'Enregistrez les modèles de rapports courants pour que le reporting récurrent tienne en un clic.'
                ),
                L(
                    'Scope before exporting to keep packs focused and confidential.',
                    "Délimitez avant d'exporter pour garder des dossiers ciblés et confidentiels."
                ),
            ],
            value: L(
                'Use reports to turn the live data into board-ready evidence — readiness by unit, top gaps, and talent distribution in a few clicks.',
                'Utilisez les rapports pour transformer les données vivantes en preuves prêtes pour le comité — préparation par unité, principaux écarts et répartition des talents en quelques clics.'
            ),
        },

        '/system-logs': {
            title: L('System Logs &amp; Analytics', 'Journaux système &amp; analytique'),
            why: L(
                '<strong>Process:</strong> The full audit trail of activity and security events (logins, access-denials, data changes, exports, talent actions). The Analytics tab turns the log into trends and flags possible anomalies (spikes in risk-relevant events). SuperAdmin only.',
                "<strong>Processus :</strong> la piste d'audit complète de l'activité et des événements de sécurité (connexions, refus d'accès, modifications de données, exports, actions de talent). L'onglet Analytique transforme le journal en tendances et signale d'éventuelles anomalies (pics d'événements à risque). Réservé au SuperAdmin."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Log entries tab:</strong> browse/paginate the chronological audit trail; export CSV/JSON.',
                        "<strong>Onglet Entrées de journal :</strong> parcourez/paginez la piste d'audit chronologique ; exportez en CSV/JSON."
                    ),
                },
                {
                    text: L(
                        '<strong>Analytics tab:</strong> review activity-over-time, risk events, and top actions/users/hours/IPs.',
                        "<strong>Onglet Analytique :</strong> examinez l'activité dans le temps, les événements à risque, et le top des actions/utilisateurs/heures/IP."
                    ),
                },
                {
                    text: L(
                        '<strong>Watch the anomaly banner</strong> — it highlights days with elevated risk-relevant activity.',
                        "<strong>Surveillez la bannière d'anomalie</strong> — elle met en évidence les jours à activité à risque élevée."
                    ),
                },
                {
                    text: L(
                        '<strong>Adjust the window</strong> (7/30/90 days) to spot trends.',
                        '<strong>Ajustez la fenêtre</strong> (7/30/90 jours) pour repérer les tendances.'
                    ),
                },
            ],
            practices: [
                L(
                    'Check the analytics weekly for failed-login or access-denied spikes.',
                    "Consultez l'analytique chaque semaine pour repérer les pics d'échecs de connexion ou de refus d'accès."
                ),
                L(
                    'Export periodically for off-system retention if your policy requires it.',
                    "Exportez périodiquement pour une conservation hors système si votre politique l'exige."
                ),
            ],
            value: L(
                'The analytics turn a raw log into an early-warning system — patterns of failed logins, lockouts or denials surface here before they become incidents.',
                "L'analytique transforme un journal brut en système d'alerte précoce — les schémas d'échecs de connexion, de verrouillages ou de refus émergent ici avant de devenir des incidents."
            ),
        },

        '/data-management': {
            title: L('Data Management', 'Gestion des données'),
            why: L(
                '<strong>Process:</strong> Bulk import/export and backup/restore. Includes a single-file Skill-Matrix Workbook (Excel/JSON/XML/CSV/YAML) to provision a whole org in one shot, plus snapshots and a guarded factory reset. SuperAdmin only.',
                "<strong>Processus :</strong> import/export en masse et sauvegarde/restauration. Comprend un classeur Matrice de compétences en fichier unique (Excel/JSON/XML/CSV/YAML) pour provisionner toute une organisation d'un coup, plus des instantanés et une réinitialisation d'usine protégée. Réservé au SuperAdmin."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Always export a full backup</strong> before importing or resetting.',
                        "<strong>Exportez toujours une sauvegarde complète</strong> avant d'importer ou de réinitialiser."
                    ),
                },
                {
                    text: L(
                        '<strong>Download a template</strong>, fill it, then preview before importing.',
                        "<strong>Téléchargez un modèle</strong>, remplissez-le, puis prévisualisez avant d'importer."
                    ),
                },
                {
                    text: L(
                        '<strong>Import</strong> the populated workbook; new logins get one-time credentials.',
                        '<strong>Importez</strong> le classeur rempli ; les nouveaux accès reçoivent des identifiants à usage unique.'
                    ),
                },
                {
                    text: L(
                        '<strong>Factory reset wipes data</strong> (default admin preserved) — use with extreme caution.',
                        "<strong>La réinitialisation d'usine efface les données</strong> (l'admin par défaut est conservé) — à utiliser avec une extrême prudence."
                    ),
                },
            ],
            practices: [
                L(
                    'Backup first, every time — exports are your undo button.',
                    "Sauvegardez d'abord, à chaque fois — les exports sont votre bouton d'annulation."
                ),
                L(
                    'Use Preview to check new-vs-existing counts before committing an import.',
                    'Utilisez la prévisualisation pour vérifier les décomptes nouveau-vs-existant avant de valider un import.'
                ),
                L(
                    'Prune test accounts before provisioning a customer baseline.',
                    'Purgez les comptes de test avant de provisionner une base de référence client.'
                ),
            ],
            value: L(
                'The single-file workbook lets you stand up or mass-update an entire organisation in minutes; the snapshot/restore makes that safe to do confidently.',
                "Le classeur en fichier unique permet de monter ou de mettre à jour en masse toute une organisation en quelques minutes ; l'instantané/restauration rend l'opération sûre et sereine."
            ),
        },

        '/app-settings': {
            title: L('Settings', 'Paramètres'),
            why: L(
                '<strong>Process:</strong> Global configuration that shapes behaviour across the app. Key settings include: <em>Readiness threshold</em> (the % at which someone counts as "ready"), <em>App name</em>, <em>Session timeout</em> (hours), <em>Email notifications</em> on/off, <em>Max login attempts</em> before lockout, and <em>Assessment-history retention</em> (days; 0 = forever). Grouped categories also configure <em>Self-Service Onboarding</em> (open signup / SSO self-registration), <em>Disputes &amp; SLAs</em> (the L0→L1→L2 escalation timers for assessment disputes), the <em>Local Content module</em> (nationality/home-country features, off by default), and the <strong>Single Sign-On (SSO)</strong> button (top of the page) for identity providers. The screen always shows the full current set.',
                "<strong>Processus :</strong> la configuration globale qui façonne le comportement de toute l'application. Réglages clés : <em>Seuil de préparation</em> (le % à partir duquel une personne est « prête »), <em>Nom de l'application</em>, <em>Expiration de session</em> (heures), <em>Notifications e-mail</em> activées/désactivées, <em>Tentatives de connexion max</em> avant verrouillage, et <em>Rétention de l'historique d'évaluation</em> (jours ; 0 = illimité). Des catégories groupées configurent aussi l'<em>Onboarding en libre-service</em> (inscription ouverte / auto-inscription SSO), les <em>Litiges &amp; SLA</em> (les minuteurs d'escalade L0→L1→L2 des litiges d'évaluation), le <em>module Contenu local</em> (fonctions nationalité/pays d'origine, désactivées par défaut), et le bouton <strong>Authentification unique (SSO)</strong> (en haut de la page) pour les fournisseurs d'identité. L'écran affiche toujours l'ensemble courant complet."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Readiness threshold:</strong> the bar (0–100) at which a person counts as "ready" — it drives every readiness number.',
                        '<strong>Seuil de préparation :</strong> la barre (0–100) à partir de laquelle une personne est « prête » — elle pilote chaque chiffre de préparation.'
                    ),
                },
                {
                    text: L(
                        '<strong>Session timeout / max login attempts:</strong> security tuning for how long sessions last and when an account locks.',
                        '<strong>Expiration de session / tentatives de connexion max :</strong> réglages de sécurité pour la durée des sessions et le moment où un compte se verrouille.'
                    ),
                },
                {
                    text: L(
                        '<strong>History retention:</strong> how long assessment history is kept.',
                        "<strong>Rétention de l'historique :</strong> la durée de conservation de l'historique d'évaluation."
                    ),
                },
                {
                    text: L(
                        'Change a value and <strong>Save</strong> — it applies app-wide.',
                        "Modifiez une valeur et <strong>Enregistrez</strong> — cela s'applique à toute l'application."
                    ),
                },
            ],
            practices: [
                L(
                    'Change the readiness threshold rarely and communicate it — it shifts every readiness number at once.',
                    "Changez le seuil de préparation rarement et communiquez-le — il déplace tous les chiffres de préparation d'un coup."
                ),
                L(
                    'Keep assessment-history retention generous (or 0 = forever) so skill-evolution charts stay meaningful.',
                    "Gardez une rétention d'historique généreuse (ou 0 = illimité) pour que les courbes d'évolution des compétences restent parlantes."
                ),
            ],
            value: L(
                'Tuning the threshold to your real "competent" bar makes readiness a number leadership can trust and act on.',
                'Ajuster le seuil à votre vraie barre de « compétent » fait de la préparation un chiffre auquel la direction peut se fier et sur lequel agir.'
            ),
        },

        '/admins': {
            title: L(
                'Administrators, Roles &amp; Granular Permissions',
                'Administrateurs, rôles &amp; permissions granulaires'
            ),
            why: L(
                '<strong>Process:</strong> Manage admin accounts. Three roles — <em>SuperAdmin</em> (holds every capability, org-wide), <em>LocalAdmin</em> (holds ONLY the capabilities you grant, within an assigned scope), <em>Viewer</em> (read-only). The point of granular permissions is to <strong>delegate routine governance to scoped local admins instead of using SuperAdmin</strong>. A new local admin starts with NO permissions until you grant them.',
                "<strong>Processus :</strong> gérez les comptes administrateurs. Trois rôles — <em>SuperAdmin</em> (détient toutes les capacités, à l'échelle de l'organisation), <em>LocalAdmin</em> (détient UNIQUEMENT les capacités que vous accordez, dans un périmètre assigné), <em>Observateur</em> (lecture seule). L'intérêt des permissions granulaires est de <strong>déléguer la gouvernance courante à des admins locaux délimités plutôt que d'utiliser le SuperAdmin</strong>. Un nouvel admin local démarre SANS aucune permission jusqu'à ce que vous lui en accordiez."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Create an admin</strong>, pick LocalAdmin or Viewer, and set the <strong>scope</strong> (the sites/departments/services they govern).',
                        "<strong>Créez un admin</strong>, choisissez LocalAdmin ou Observateur, et définissez le <strong>périmètre</strong> (les sites/départements/services qu'il gouverne)."
                    ),
                },
                {
                    text: L(
                        '<strong>Tick the exact permissions</strong> to grant. The screen shows the full current catalogue, grouped by area: <em>People &amp; Assessments</em> (manage employees, manage assessments, manage onboarding, reset employee password), <em>Configuration</em> (organization, domains &amp; skills, roles, settings — each with a view-only vs manage split), <em>Data</em> (export, import/provision), <em>Governance</em> (view system logs, manage local admins, arbitrate disputes), and <em>Talent Continuity &amp; Learning</em> (view continuity, manage succession, view retention risk, manage handover, configure LMS). Always defer to the live list on the screen — it is the source of truth.',
                        "<strong>Cochez les permissions exactes</strong> à accorder. L'écran montre le catalogue courant complet, groupé par domaine : <em>Personnes &amp; évaluations</em> (gérer les collaborateurs, gérer les évaluations, gérer l'onboarding, réinitialiser le mot de passe d'un collaborateur), <em>Configuration</em> (organisation, domaines &amp; compétences, postes, paramètres — chacun avec une distinction lecture seule vs gérer), <em>Données</em> (exporter, importer/provisionner), <em>Gouvernance</em> (voir les journaux système, gérer les admins locaux, arbitrer les litiges), et <em>Continuité des talents &amp; apprentissage</em> (voir la continuité, gérer la succession, voir le risque de rétention, gérer la passation, configurer le LMS). Fiez-vous toujours à la liste vivante à l'écran — c'est la source de vérité."
                    ),
                },
                {
                    text: L(
                        '<strong>Viewer + write grant</strong> is ignored — viewers are read-only; write boxes are disabled.',
                        "<strong>Observateur + droit d'écriture</strong> est ignoré — les observateurs sont en lecture seule ; les cases d'écriture sont désactivées."
                    ),
                },
                {
                    text: L(
                        'Edit any admin later to add/remove grants; the sidebar reveals exactly the areas they hold.',
                        "Modifiez un admin plus tard pour ajouter/retirer des droits ; le menu latéral révèle exactement les domaines qu'il détient."
                    ),
                },
            ],
            practices: [
                L(
                    'Grant least privilege — give a local admin only the capabilities and the scope they actually need.',
                    'Accordez le moindre privilège — donnez à un admin local uniquement les capacités et le périmètre dont il a réellement besoin.'
                ),
                L(
                    'Delegate instead of sharing SuperAdmin: e.g. grant "manage roles" to an HR lead, "export data" to a reporting analyst.',
                    'Déléguez au lieu de partager le SuperAdmin : p. ex. accordez « gérer les postes » à un responsable RH, « exporter les données » à un analyste reporting.'
                ),
                L(
                    "Guardrails are automatic: a delegate cannot create/edit a SuperAdmin, cannot grant a permission they don't themselves hold, and is limited to their own scope. Destructive ops (DB reset, snapshots) stay SuperAdmin-only.",
                    "Les garde-fous sont automatiques : un délégué ne peut ni créer/modifier un SuperAdmin, ni accorder une permission qu'il ne détient pas lui-même, et il est limité à son propre périmètre. Les opérations destructrices (réinitialisation BD, instantanés) restent réservées au SuperAdmin."
                ),
                L(
                    'Turn on Two-Factor (MFA) for privileged accounts; never leave the default admin on its default password.',
                    "Activez la double authentification (MFA) pour les comptes privilégiés ; ne laissez jamais l'admin par défaut sur son mot de passe par défaut."
                ),
            ],
            value: L(
                'Granular, scoped delegation lets the right people run their own area (config, provisioning, audit) with the minimum rights — so you rarely need to hand out SuperAdmin at all.',
                "Une délégation granulaire et délimitée permet aux bonnes personnes de gérer leur propre domaine (config, provisionnement, audit) avec le minimum de droits — vous n'avez donc presque jamais besoin de distribuer le SuperAdmin."
            ),
        },

        '/talent/career-path': {
            title: L('Career Path', 'Parcours de carrière'),
            why: L(
                '<strong>Process:</strong> Shows progression routes between roles based on the skills each role requires, so employees and managers can plan growth toward a target role.',
                "<strong>Processus :</strong> montre les voies de progression entre postes d'après les compétences que chaque poste exige, pour que collaborateurs et managers planifient l'évolution vers un poste cible."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick a target role</strong> to see the skill delta from the current role.',
                        "<strong>Choisissez un poste cible</strong> pour voir l'écart de compétences par rapport au poste actuel."
                    ),
                },
                {
                    text: L(
                        '<strong>Turn the delta into development</strong> via IDP actions and goals.',
                        "<strong>Transformez l'écart en développement</strong> via des actions de PDI et des objectifs."
                    ),
                },
            ],
            practices: [
                L(
                    'Use the gap to the next role as the basis for the IDP — it makes development purposeful.',
                    "Utilisez l'écart vers le poste suivant comme base du PDI — cela donne un but au développement."
                ),
            ],
            value: L(
                'Connecting today\'s gaps to a desired role turns vague "development" into a concrete, motivating plan and aids retention.',
                "Relier les écarts d'aujourd'hui à un poste souhaité transforme un « développement » vague en un plan concret et motivant, et favorise la rétention."
            ),
        },

        // ---- SECTION operations — operations health () ----
        '/admin/health': {
            title: L('Instance health', "Santé de l'instance"),
            why: L(
                "<strong>Process:</strong> The one page that answers the operator's questions after an incident. Every scheduled job with its last run, status, duration, next due and last error; the database backups with their location, size, disk space and next run; outbound e-mail (configured, master switch, last successful test, recent failures); the database (size, largest tables, pending migrations, retention windows) and the licence. Every number is a measurement — anything not measured reads « — », never 0. SuperAdmin only, because the page runs jobs and writes backups.",
                "<strong>Processus :</strong> la page qui répond aux questions de l'exploitant après un incident. Chaque tâche planifiée avec sa dernière exécution, son état, sa durée, sa prochaine échéance et sa dernière erreur ; les sauvegardes de la base avec leur emplacement, leur taille, l'espace disque et la prochaine exécution ; la messagerie sortante (configurée, interrupteur général, dernier test réussi, échecs récents) ; la base de données (taille, plus grosses tables, migrations en attente, rétentions) et la licence. Chaque valeur est une mesure — une valeur non mesurée affiche « — », jamais 0. Réservé au SuperAdmin, car la page exécute des tâches et écrit des sauvegardes."
            ),
            steps: [
                {
                    text: L(
                        'Read the <strong>summary strip</strong> first: failed jobs, overdue jobs, last backup, SMTP, pending migrations, licence.',
                        "Lisez d'abord la <strong>bande de synthèse</strong> : tâches en échec, tâches en retard, dernière sauvegarde, SMTP, migrations en attente, licence."
                    ),
                },
                {
                    text: L(
                        'In the jobs table, a red row is a failure and the <strong>Result / error</strong> column carries the reason. <strong>Run now</strong> re-runs that job immediately and records your name in the audit trail.',
                        "Dans le tableau des tâches, une ligne rouge est un échec et la colonne <strong>Résultat / erreur</strong> porte la raison. <strong>Exécuter maintenant</strong> relance la tâche immédiatement et inscrit votre nom dans la piste d'audit."
                    ),
                },
                {
                    text: L(
                        '<strong>Back up now</strong> writes a full dump to the backup folder; the path and size appear on the card. A 0-byte dump is reported as a failure, never as a backup.',
                        '<strong>Sauvegarder maintenant</strong> écrit un export complet dans le dossier de sauvegarde ; le chemin et la taille apparaissent sur la carte. Un fichier de 0 octet est signalé comme un échec, jamais comme une sauvegarde.'
                    ),
                },
                {
                    text: L(
                        'A failing job, a backup older than 36 hours or a licence problem also raises a notification to every super-administrator, de-duplicated once a day.',
                        'Une tâche en échec, une sauvegarde de plus de 36 heures ou un problème de licence déclenchent aussi une notification à chaque super-administrateur, dédoublonnée une fois par jour.'
                    ),
                },
            ],
            practices: [
                L(
                    'Open it after every upgrade: « pending migrations » must be 0 and no job overdue.',
                    'Ouvrez-la après chaque mise à jour : « migrations en attente » doit valoir 0 et aucune tâche ne doit être en retard.'
                ),
                L(
                    'Check the backup location and the free disk space monthly — a full disk is the usual cause of a silent backup failure.',
                    "Vérifiez chaque mois l'emplacement des sauvegardes et l'espace disque libre — un disque plein est la cause habituelle d'une sauvegarde qui échoue en silence."
                ),
            ],
            value: L(
                'Silent automation failures — backups, reminders, campaign closing, digests — are caught the same day instead of weeks later.',
                "Les défaillances silencieuses de l'automatisation — sauvegardes, rappels, clôture des campagnes, récapitulatifs — sont détectées le jour même au lieu de semaines plus tard."
            ),
        },

        '/about': {
            title: L('About / Version', 'À propos / version'),
            why: L(
                '<strong>Process:</strong> Full detail of the running version — application version, environment, HTTP port, Node runtime, platform, uptime, database engine/name, schema-migration count + latest migration, background-jobs mode and SSO state. It also shows the live <strong>Capability Framework</strong> stats (pillars, sub-domains,role families, skill counts, skill↔family links) and the module list.',
                '<strong>Processus :</strong> le détail complet de la version en cours — version applicative, environnement, port HTTP, runtime Node, plateforme, disponibilité, moteur/nom de base de données, nombre de migrations de schéma + dernière migration, mode des tâches de fond et état SSO. Il affiche aussi les statistiques vivantes du <strong>référentiel de capacités</strong> (piliers, sous-domaines,familles de postes, décomptes de compétences, liens compétence↔famille) et la liste des modules.'
            ),
            steps: [
                {
                    text: L(
                        'Check the <strong>version</strong> and <strong>latest migration</strong> before reporting an issue or after an update.',
                        'Vérifiez la <strong>version</strong> et la <strong>dernière migration</strong> avant de signaler un problème ou après une mise à jour.'
                    ),
                },
                {
                    text: L(
                        'Confirm the <strong>capability framework</strong> is loaded (pillars/sub-domains/skills populated).',
                        'Confirmez que le <strong>référentiel de capacités</strong> est chargé (piliers/sous-domaines/compétences remplis).'
                    ),
                },
            ],
            practices: [
                L(
                    'Quote the version + latest migration when raising support requests.',
                    'Indiquez la version + la dernière migration lors de vos demandes de support.'
                ),
            ],
            value: L(
                'One place to confirm exactly which release is live, that the database schema and capability framework are in the expected state, and what modules are active.',
                "Un seul endroit pour confirmer exactement quelle version est en ligne, que le schéma de base de données et le référentiel de capacités sont dans l'état attendu, et quels modules sont actifs."
            ),
        },

        '/employee/dashboard': {
            title: L(
                'My Workspace (Employee Dashboard)',
                'Mon espace (tableau de bord collaborateur)'
            ),
            why: L(
                '<strong>Process:</strong> Your personal landing page. It shows your role-readiness %, your skill gaps, your current assessment state, and your 9-box position (only once a manager has approved AND chosen to disclose it). Quick-action cards jump you to your self-assessment, status, coaching and development.',
                "<strong>Processus :</strong> votre page d'accueil personnelle. Elle montre votre % de préparation au poste, vos écarts de compétence, l'état actuel de votre évaluation, et votre position 9-box (seulement une fois qu'un manager l'a approuvée ET choisi de la divulguer). Des cartes d'action rapide vous mènent à votre auto-évaluation, votre statut, votre coaching et votre développement."
            ),
            steps: [
                {
                    text: L(
                        'Read the snapshot cards: <strong>readiness, gaps, assessment state, 9-box</strong>.',
                        "Lisez les cartes de synthèse : <strong>préparation, écarts, état de l'évaluation, 9-box</strong>."
                    ),
                },
                {
                    text: L(
                        'Scan the <strong>gap table</strong> to see which skills to improve next.',
                        'Parcourez le <strong>tableau des écarts</strong> pour voir quelles compétences améliorer ensuite.'
                    ),
                },
                {
                    text: L(
                        'Use the quick-action cards to open <strong>My Self-Assessment, My Status, My Coaching, My Development</strong>.',
                        "Utilisez les cartes d'action rapide pour ouvrir <strong>Mon auto-évaluation, Mon statut, Mon coaching, Mon développement</strong>."
                    ),
                },
            ],
            practices: [
                L(
                    'Check it after each assessment cycle — your gaps drive your development plan.',
                    "Consultez-le après chaque cycle d'évaluation — vos écarts pilotent votre plan de développement."
                ),
                L(
                    "If your 9-box isn't shown, that's normal: it's confidential until your manager discloses it.",
                    "Si votre 9-box n'apparaît pas, c'est normal : il est confidentiel jusqu'à ce que votre manager le divulgue."
                ),
            ],
            value: L(
                'One screen tells you where you stand and what to do next — no need to hunt through menus.',
                'Un seul écran vous dit où vous en êtes et quoi faire ensuite — sans avoir à fouiller dans les menus.'
            ),
        },

        '/employee/assessment-status': {
            title: L('My Status', 'Mon statut'),
            why: L(
                '<strong>Process:</strong> Tracks where each of your submitted skills is in the review flow — draft, submitted, under review, changes requested, reviewed, or approved — and lets you open a discussion thread with your reviewer.',
                "<strong>Processus :</strong> suit où en est chacune de vos compétences soumises dans le flux de revue — brouillon, soumis, en cours de revue, modifications demandées, revu, ou approuvé — et vous permet d'ouvrir un fil de discussion avec votre évaluateur."
            ),
            steps: [
                {
                    text: L(
                        'Read the <strong>status badge</strong> for each skill.',
                        'Lisez le <strong>badge de statut</strong> de chaque compétence.'
                    ),
                },
                {
                    text: L(
                        'If a skill shows <strong>changes requested</strong>, reopen My Self-Assessment, adjust and submit again.',
                        'Si une compétence affiche <strong>modifications demandées</strong>, rouvrez Mon auto-évaluation, ajustez et soumettez à nouveau.'
                    ),
                },
                {
                    text: L(
                        'Use <strong>Discuss / Respond</strong> to talk to your reviewer in-thread.',
                        'Utilisez <strong>Discuter / Répondre</strong> pour échanger avec votre évaluateur dans le fil.'
                    ),
                },
            ],
            practices: [
                L(
                    'Act on "changes requested" promptly so your level stays current.',
                    'Traitez rapidement les « modifications demandées » pour que votre niveau reste à jour.'
                ),
                L(
                    'Once approved, a rating becomes your official current level — no further action needed.',
                    'Une fois approuvée, une note devient votre niveau actuel officiel — aucune autre action nécessaire.'
                ),
            ],
            value: L(
                "Full transparency on your assessment — you always know what's pending and what's settled.",
                'Une transparence totale sur votre évaluation — vous savez toujours ce qui est en attente et ce qui est réglé.'
            ),
        },

        // ---- ---
        '/assessment-changes': {
            title: L('Requests for change', 'Demandes de modification'),
            why: L(
                '<strong>Process:</strong> An assessment stops being freely editable the moment it is submitted. From then on — submitted, under review, reviewed or validated — a change goes through a written request that a named person grants or refuses. Until it is validated, a supervisor or manager may instead <strong>cancel</strong> it directly, with a reason. A closed campaign refuses both.',
                '<strong>Processus :</strong> une évaluation cesse d’être librement modifiable dès qu’elle est soumise. À partir de là — soumise, en revue, revue ou validée — une modification passe par une demande écrite qu’une personne nommée accorde ou refuse. Tant qu’elle n’est pas validée, le superviseur ou le manager peut au contraire l’<strong>annuler</strong> directement, avec un motif. Une campagne close refuse les deux.'
            ),
            steps: [
                {
                    text: L(
                        'Pick the assessment and write <strong>why</strong> — the reason is mandatory and the decider reads it.',
                        'Choisissez l’évaluation et écrivez <strong>pourquoi</strong> — le motif est obligatoire et le décideur le lit.'
                    ),
                },
                {
                    text: L(
                        'The decider grants or refuses. <strong>Granting is the only thing that reopens the right to edit</strong>; a refusal must carry its own reason.',
                        'Le décideur accorde ou refuse. <strong>L’octroi est la seule chose qui rouvre le droit de modifier</strong> ; un refus porte son propre motif.'
                    ),
                },
                {
                    text: L(
                        'Once granted, the assessment comes back to the person and they edit it as a draft, then submit again.',
                        'Une fois accordée, l’évaluation revient à la personne, qui la modifie comme un brouillon puis la soumet à nouveau.'
                    ),
                },
            ],
            practices: [
                L(
                    'A validated assessment can only be reopened by the manager or an administrator — never by the person who asked.',
                    'Une évaluation validée ne peut être rouverte que par le manager ou un administrateur — jamais par la personne qui a demandé.'
                ),
                L(
                    'Cancelling is a state plus a reason: nothing is deleted, and an official level already validated is not rewritten.',
                    'Annuler est un état plus un motif : rien n’est supprimé, et un niveau officiel déjà validé n’est pas réécrit.'
                ),
                L(
                    'You have 30 days from the decision to contest it, and never inside a campaign that has closed.',
                    'Vous disposez de 30 jours à partir de la décision pour la contester, et jamais dans une campagne close.'
                ),
            ],
            value: L(
                'A mistake can be corrected without either freezing the record or handing everyone an override — and every correction names who asked, who decided, and why.',
                'Une erreur peut être corrigée sans figer le dossier ni donner à chacun un passe-droit — et chaque correction nomme qui a demandé, qui a décidé, et pourquoi.'
            ),
        },
        // ---- ---

        '/organization': {
            title: L(
                'Organization (Sites, Departments, Services)',
                'Organisation (sites, départements, services)'
            ),
            why: L(
                '<strong>Process:</strong> Defines the org structure — sites → departments → services — that employees are attached to. These units power the scope of local admins and every dashboard/report filter. Anyone can view; editing needs the <em>Manage organization</em> permission.',
                "<strong>Processus :</strong> définit la structure organisationnelle — sites → départements → services — à laquelle les collaborateurs sont rattachés. Ces unités alimentent le périmètre des admins locaux et chaque filtre de tableau de bord/rapport. Tout le monde peut consulter ; la modification requiert la permission <em>Gérer l'organisation</em>."
            ),
            steps: [
                {
                    text: L(
                        'Browse the tabs: <strong>Sites, Departments, Services</strong> (you see only what your scope allows).',
                        'Parcourez les onglets : <strong>Sites, Départements, Services</strong> (vous ne voyez que ce que votre périmètre autorise).'
                    ),
                },
                {
                    text: L(
                        'With <strong>Manage organization</strong>, add or edit units; departments belong to a site, services to a department.',
                        "Avec <strong>Gérer l'organisation</strong>, ajoutez ou modifiez des unités ; les départements appartiennent à un site, les services à un département."
                    ),
                },
            ],
            practices: [
                L(
                    'Keep the hierarchy clean — it is the backbone of scoping, filtering and the org chart.',
                    "Gardez la hiérarchie propre — c'est la colonne vertébrale du périmétrage, du filtrage et de l'organigramme."
                ),
                L(
                    "Don't delete a unit with people still attached; move them first.",
                    "Ne supprimez pas une unité à laquelle des personnes sont encore rattachées ; déplacez-les d'abord."
                ),
            ],
            value: L(
                'A correct structure makes scoped delegation, dashboards and the org chart all "just work".',
                'Une structure correcte fait que délégation délimitée, tableaux de bord et organigramme « fonctionnent tout seuls ».'
            ),
        },

        '/change-password': {
            title: L('Change Password', 'Changer le mot de passe'),
            why: L(
                '<strong>Process:</strong> Update your own password. New passwords must be at least 12 characters with upper + lower case, a number and a special character; common words, sequences and keyboard patterns are rejected.',
                '<strong>Processus :</strong> mettez à jour votre propre mot de passe. Les nouveaux mots de passe doivent comporter au moins 12 caractères avec majuscule + minuscule, un chiffre et un caractère spécial ; les mots courants, les suites et les motifs de clavier sont refusés.'
            ),
            steps: [
                {
                    text: L(
                        'Enter your <strong>current password</strong>, then the new one twice.',
                        'Saisissez votre <strong>mot de passe actuel</strong>, puis le nouveau deux fois.'
                    ),
                },
                {
                    text: L(
                        "Save — you'll use the new password next time you log in.",
                        'Enregistrez — vous utiliserez le nouveau mot de passe à votre prochaine connexion.'
                    ),
                },
            ],
            practices: [
                L(
                    "Use a unique passphrase you don't reuse elsewhere.",
                    'Utilisez une phrase de passe unique que vous ne réutilisez pas ailleurs.'
                ),
                L(
                    "On first login after an admin reset, you may be required to change it — that's expected.",
                    "À la première connexion après une réinitialisation par un admin, un changement peut vous être demandé — c'est normal."
                ),
            ],
            value: L(
                'Keeps your account yours — a strong, regularly-changed password is your first line of defence.',
                'Garde votre compte à vous — un mot de passe fort et changé régulièrement est votre première ligne de défense.'
            ),
        },

        '/v2/uam/mfa/manage': {
            title: L(
                'Two-Factor Authentication (2FA / MFA)',
                'Double authentification (2FA / MFA)'
            ),
            why: L(
                '<strong>Process:</strong> Adds a second login step — a 6-digit code from an authenticator app — so your account is safe even if your password leaks. Opt-in for everyone; strongly recommended for privileged (admin) accounts.',
                "<strong>Processus :</strong> ajoute une deuxième étape de connexion — un code à 6 chiffres d'une application d'authentification — pour que votre compte reste sûr même si votre mot de passe fuit. Facultatif pour tous ; fortement recommandé pour les comptes privilégiés (admin)."
            ),
            steps: [
                {
                    text: L(
                        'Click <strong>Activate two-factor authentication</strong>.',
                        'Cliquez sur <strong>Activer la double authentification</strong>.'
                    ),
                },
                {
                    text: L(
                        '<strong>Scan the QR code</strong> with Microsoft/Google Authenticator (or enter the key), then confirm a 6-digit code.',
                        '<strong>Scannez le QR code</strong> avec Microsoft/Google Authenticator (ou saisissez la clé), puis confirmez un code à 6 chiffres.'
                    ),
                },
                {
                    text: L(
                        '<strong>Save your 10 backup codes</strong> somewhere safe — each works once if you lose your phone.',
                        '<strong>Conservez vos 10 codes de secours</strong> en lieu sûr — chacun sert une fois si vous perdez votre téléphone.'
                    ),
                },
                {
                    text: L(
                        'To turn it off, enter a current code.',
                        'Pour la désactiver, saisissez un code en cours.'
                    ),
                },
            ],
            practices: [
                L(
                    "Admins: turn this on — it's the single biggest account-security win.",
                    "Admins : activez-la — c'est le plus grand gain de sécurité de compte à lui seul."
                ),
                L(
                    'Store backup codes in a password manager, not on the same phone as the app.',
                    "Stockez les codes de secours dans un gestionnaire de mots de passe, pas sur le même téléphone que l'application."
                ),
            ],
            value: L(
                "Even a stolen password can't get into a 2FA-protected account.",
                'Même un mot de passe volé ne peut pas entrer dans un compte protégé par 2FA.'
            ),
        },

        '/v2/slf/disputes': {
            title: L(
                'Disputes (three-level ladder with SLAs)',
                'Litiges (échelle à trois niveaux avec SLA)'
            ),
            why: L(
                "<strong>Process:</strong> When an employee disagrees with a review, they raise a dispute. It climbs a timed ladder so it can never stall: <strong>L0</strong> supervisor ↔ employee → (after the L0 SLA) <strong>L1</strong> manager → (after the L1 SLA) <strong>L2 HR arbitration</strong> → (after the L2 SLA) auto-finalized with the supervisor's rating so the cycle can still close. Every SLA and the auto-finalize switch are set in <em>Settings → Disputes &amp; SLAs</em>. <strong>HR is a role inside the system</strong>: a local admin holding the <em>Arbitrate assessment disputes</em> permission — not a separate account type, and not handled outside the app.",
                "<strong>Processus :</strong> quand un collaborateur est en désaccord avec une revue, il ouvre un litige. Celui-ci gravit une échelle chronométrée pour ne jamais s'enliser : <strong>L0</strong> superviseur ↔ collaborateur → (après le SLA L0) <strong>L1</strong> manager → (après le SLA L1) <strong>arbitrage RH L2</strong> → (après le SLA L2) finalisé automatiquement avec la note du superviseur pour que le cycle puisse tout de même se clôturer. Chaque SLA et l'interrupteur de finalisation automatique se règlent dans <em>Paramètres → Litiges &amp; SLA</em>. <strong>Les RH sont un rôle dans le système</strong> : un admin local détenant la permission <em>Arbitrer les litiges d'évaluation</em> — pas un type de compte distinct, et pas géré hors de l'application."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Managers</strong> resolve L0 (uphold/adjust) and, if it escalated, L1 — with a short note.',
                        "Les <strong>managers</strong> résolvent le L0 (maintenir/ajuster) et, en cas d'escalade, le L1 — avec une courte note."
                    ),
                },
                {
                    text: L(
                        '<strong>HR arbiters</strong> (the Arbitrate-disputes grant) see L2 rows and click <strong>Arbitrate (HR)</strong> to make the final decision.',
                        'Les <strong>arbitres RH</strong> (droit Arbitrer-les-litiges) voient les lignes L2 et cliquent sur <strong>Arbitrer (RH)</strong> pour prendre la décision finale.'
                    ),
                },
                {
                    text: L(
                        'If nobody acts, the ladder auto-escalates on the SLAs; an overdue L2 auto-finalizes (if that setting is on) — always audited.',
                        "Si personne n'agit, l'échelle escalade automatiquement selon les SLA ; un L2 en retard se finalise automatiquement (si ce réglage est activé) — toujours audité."
                    ),
                },
                {
                    text: L(
                        'Tune the SLA days and the auto-finalize toggle in <strong>Settings → Disputes &amp; SLAs</strong>.',
                        'Réglez les jours de SLA et la bascule de finalisation automatique dans <strong>Paramètres → Litiges &amp; SLA</strong>.'
                    ),
                },
            ],
            practices: [
                L(
                    'Set SLAs to your real review calendar — short enough that a cycle closes on time, long enough for a fair conversation.',
                    "Réglez les SLA sur votre vrai calendrier de revue — assez courts pour qu'un cycle se clôture à temps, assez longs pour une conversation équitable."
                ),
                L(
                    'Grant "Arbitrate assessment disputes" to your HR business partner (a scoped local admin) so escalations have a real owner.',
                    "Accordez « Arbitrer les litiges d'évaluation » à votre partenaire RH (un admin local délimité) pour que les escalades aient un vrai responsable."
                ),
                L(
                    'Leave auto-finalize ON unless HR truly must decide every case — otherwise a single un-actioned dispute can block cycle close.',
                    'Laissez la finalisation automatique ACTIVÉE sauf si les RH doivent vraiment trancher chaque cas — sinon un seul litige non traité peut bloquer la clôture du cycle.'
                ),
            ],
            value: L(
                'A fair, time-bound appeal path that always terminates: employees get a real escalation to HR, and the assessment cycle can never be held hostage by one unresolved dispute.',
                "Une voie de recours équitable et bornée dans le temps qui se termine toujours : les collaborateurs obtiennent une vraie escalade vers les RH, et le cycle d'évaluation ne peut jamais être pris en otage par un litige non résolu."
            ),
        },

        '/v2/lifecycle': {
            title: L(
                'Lifecycle Events (Joiner / Mover / Leaver)',
                'Événements de cycle de vie (arrivée / mobilité / départ)'
            ),
            why: L(
                '<strong>Process:</strong> Record a Joiner, Mover or Leaver for someone in your span. A <em>Leaver</em> deactivates the account, so it is confirmed twice.',
                '<strong>Processus :</strong> enregistrez une arrivée, une mobilité ou un départ pour une personne de votre périmètre. Un <em>Départ</em> désactive le compte, il est donc confirmé deux fois.'
            ),
            steps: [
                {
                    text: L(
                        'Pick the person and the event: <strong>Joiner, Mover, or Leaver</strong>.',
                        "Choisissez la personne et l'événement : <strong>Arrivée, Mobilité ou Départ</strong>."
                    ),
                },
                {
                    text: L(
                        'Confirm. A Leaver asks for an extra confirmation because it disables the login.',
                        "Confirmez. Un départ demande une confirmation supplémentaire car il désactive l'accès."
                    ),
                },
            ],
            practices: [
                L(
                    'Record movers promptly so role, scope and required skills stay accurate.',
                    'Enregistrez les mobilités rapidement pour que poste, périmètre et compétences requises restent justes.'
                ),
                L(
                    'Use Leaver rather than deleting — it preserves history while closing access.',
                    "Utilisez Départ plutôt que la suppression — cela préserve l'historique tout en fermant l'accès."
                ),
            ],
            value: L(
                'Keeps the workforce picture (and access) accurate as people join, move and leave.',
                'Maintient la cartographie des effectifs (et les accès) à jour au fil des arrivées, mobilités et départs.'
            ),
        },

        '/v2/slf/cycles': {
            title: L('Assessment Cycles', "Cycles d'évaluation"),
            why: L(
                '<strong>Process:</strong> A cycle is a time window in which people self-assess. SuperAdmin opens it, locks it, then closes it; closing can auto-generate IDP drafts from the gaps found. Codes must be unique.',
                "<strong>Processus :</strong> un cycle est une fenêtre de temps pendant laquelle les personnes s'auto-évaluent. Le SuperAdmin l'ouvre, le verrouille, puis le clôture ; la clôture peut générer automatiquement des brouillons de PDI à partir des écarts trouvés. Les codes doivent être uniques."
            ),
            steps: [
                {
                    text: L(
                        'Create a cycle with a unique <strong>code</strong>, label and dates.',
                        'Créez un cycle avec un <strong>code</strong> unique, un libellé et des dates.'
                    ),
                },
                {
                    text: L(
                        '<strong>Open</strong> it to let people self-assess; <strong>lock/close</strong> when the window ends.',
                        "<strong>Ouvrez-le</strong> pour laisser les personnes s'auto-évaluer ; <strong>verrouillez/clôturez</strong> à la fin de la fenêtre."
                    ),
                },
            ],
            practices: [
                L(
                    'Communicate the open/close dates so people self-assess in time.',
                    "Communiquez les dates d'ouverture/clôture pour que les personnes s'auto-évaluent à temps."
                ),
                L(
                    'Reusing a code is refused on purpose — always pick a fresh one.',
                    'Réutiliser un code est refusé volontairement — choisissez toujours un code neuf.'
                ),
            ],
            value: L(
                'Cycles turn skills upkeep into a predictable rhythm rather than a one-off scramble.',
                "Les cycles transforment l'entretien des compétences en un rythme prévisible plutôt qu'en une course ponctuelle."
            ),
        },

        // ---- SECTION campaigns — campaign console (/cycles, /cycles/:id, /cycles/new) ----
        '/cycles': {
            title: L('Assessment campaigns — the console', "Campagnes d'évaluation — la console"),
            why: L(
                '<strong>Process:</strong> one page per campaign: create it (draft), <strong>launch</strong> it (enrols every active person whose role carries requirements and announces it), follow it (who has not started, which manager is sitting on submissions), <strong>extend or reopen</strong> its deadline, lock it, then <strong>close</strong> it honestly (the shortfall is written to the log). Launch, deadline and close are reserved to the super administrator; an admin holding <em>Manage cycles</em> excuses or re-includes people of their scope; a manager chases their own reports.',
                "<strong>Processus :</strong> une page par campagne : créez-la (brouillon), <strong>lancez</strong>-la (inscrit toute personne active dont le poste porte des exigences et l'annonce), suivez-la (qui n'a pas démarré, chez quel responsable les soumissions s'accumulent), <strong>étendez ou rouvrez</strong> son échéance, verrouillez-la, puis <strong>clôturez</strong>-la honnêtement (le manque est écrit au journal). Lancement, échéance et clôture sont réservés au super-administrateur ; un admin détenant <em>Gérer les cycles</em> excuse ou réintègre les personnes de son périmètre ; un manager relance ses propres collaborateurs."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Filter the roster</strong> by site, department, service, role, manager (or « no manager »), state and search — the by-site / by-manager rows are links that apply the filter. Sort any column; export the filtered list (CSV).',
                        '<strong>Filtrez les participants</strong> par site, département, service, poste, responsable (ou « sans responsable »), état et recherche — les lignes des tableaux par site / par responsable sont des liens qui appliquent le filtre. Triez chaque colonne ; exportez la liste filtrée (CSV).'
                    ),
                },
                {
                    text: L(
                        '<strong>Excuse people, never skills</strong>: tick the rows (or « the whole filter ») → one category (long leave / departure / transfer / other) + a written reason, optionally « excused until » a date — the person comes back automatically after it. Who excused whom, when and why is shown on the row and audited; re-inclusion keeps the history.',
                        "<strong>Excusez des personnes, jamais des compétences</strong> : cochez les lignes (ou « tout le filtre ») → une catégorie (absence longue durée / départ / mutation / autre) + un motif écrit, avec au besoin « excusé jusqu'au » — la personne revient automatiquement ensuite. Qui a excusé qui, quand et pourquoi s'affiche sur la ligne et part au journal ; la réintégration garde l'historique."
                    ),
                },
                {
                    text: L(
                        '<strong>Chase</strong>: « Relancer » on a person, on a manager row (pending reviews) or « all non-starters » — one reminder per person per day; the « Last reminder » column shows the date. Deactivated or erased people are excused automatically and never chased.',
                        '<strong>Relancez</strong> : « Relancer » sur une personne, sur une ligne de responsable (revues en attente) ou « tous les non-démarrés » — une relance par personne et par jour ; la colonne « Dernière relance » donne la date. Les comptes désactivés ou effacés sont excusés automatiquement et jamais relancés.'
                    ),
                },
                {
                    text: L(
                        '<strong>Give them one more week</strong>: on a locked campaign, « Reopen / extend deadline » sets a new closing date and tells the people still expected; « Cancel draft » retires a draft with a reason (nothing is deleted).',
                        "<strong>Donnez une semaine de plus</strong> : sur une campagne verrouillée, « Rouvrir / étendre l'échéance » fixe une nouvelle date de clôture et prévient les personnes encore attendues ; « Annuler le brouillon » retire un brouillon avec un motif (rien n'est supprimé)."
                    ),
                },
            ],
            practices: [
                L(
                    "The number of skills per role is the department's design — the console never reduces it; excuse a PERSON with a reason instead.",
                    'Le nombre de compétences par poste est la conception du département — la console ne le réduit jamais ; excusez une PERSONNE avec un motif.'
                ),
                L(
                    'A « — » means nothing is measured yet (draft, or everyone excused) — it is never a 0 %.',
                    "Un « — » signifie que rien n'est encore mesuré (brouillon, ou tout le monde excusé) — ce n'est jamais un 0 %."
                ),
            ],
            value: L(
                'The daily chase becomes minutes: filter a site, excuse a crew on rotation in one action, remind the rest, and close with an honest record.',
                'La relance quotidienne prend quelques minutes : filtrez un site, excusez une équipe en rotation en une action, relancez les autres, et clôturez avec un enregistrement honnête.'
            ),
        },

        '/v2/uam/maker-checker/queue': {
            title: L('Approvals (Maker-Checker)', 'Validations (double contrôle)'),
            why: L(
                '<strong>Process:</strong> A control where one admin proposes a sensitive change and a different admin approves it — separation of duties for high-risk actions.',
                "<strong>Processus :</strong> un contrôle où un admin propose un changement sensible et un autre admin l'approuve — séparation des tâches pour les actions à haut risque."
            ),
            steps: [
                {
                    text: L(
                        'Review each pending change and its proposer.',
                        'Examinez chaque changement en attente et son auteur.'
                    ),
                },
                {
                    text: L(
                        '<strong>Approve</strong> or reject; approval applies the change and is audited.',
                        "<strong>Approuvez</strong> ou rejetez ; l'approbation applique le changement et est auditée."
                    ),
                },
            ],
            practices: [
                L(
                    "Don't approve your own proposals — the whole point is a second pair of eyes.",
                    "N'approuvez pas vos propres propositions — tout l'intérêt est d'avoir un second regard."
                ),
            ],
            value: L(
                'Two-person control on sensitive changes prevents mistakes and abuse.',
                'Le contrôle à deux personnes sur les changements sensibles prévient erreurs et abus.'
            ),
        },

        '/app-settings/sso': {
            title: L('Single Sign-On (SSO)', 'Authentification unique (SSO)'),
            why: L(
                '<strong>Process:</strong> Configure how people sign in with your identity provider. Four methods can run together — <em>Microsoft Entra ID</em>, generic <em>OpenID Connect</em> (Okta, Auth0, Keycloak…), <em>SAML 2.0</em> and <em>Google Workspace</em>. SSO maps an external identity to an EXISTING account (immutable id, a mapping prepared in SSO migration, or verified e-mail — no auto-creation unless self-service onboarding is on). Stored in settings (not a file); saving re-registers providers live — no restart. SuperAdmin only.',
                "<strong>Processus :</strong> configurez la façon dont les personnes se connectent avec votre fournisseur d'identité. Quatre méthodes peuvent coexister — <em>Microsoft Entra ID</em>, <em>OpenID Connect</em> générique (Okta, Auth0, Keycloak…), <em>SAML 2.0</em> et <em>Google Workspace</em>. Le SSO relie une identité externe à un compte EXISTANT (identifiant immuable, rattachement préparé dans Migration SSO, ou e-mail vérifié — pas de création automatique sauf si l'onboarding en libre-service est activé). Stocké dans les paramètres (pas un fichier) ; l'enregistrement ré-inscrit les fournisseurs en direct — sans redémarrage. Réservé au SuperAdmin."
            ),
            steps: [
                {
                    text: L(
                        '<strong>1. Test.</strong> Import the identity provider’s metadata (or complete the provider fields) and <strong>Save</strong> — leave the master switch OFF. Run <strong>Test sign-in</strong>: a real round trip that signs nobody in and shows the account that would open. It works before activation.',
                        '<strong>1. Test.</strong> Importez les métadonnées du fournisseur d’identité (ou complétez ses champs) et <strong>Enregistrez</strong> — interrupteur général toujours DÉSACTIVÉ. Lancez le <strong>Test de connexion</strong> : un aller-retour réel qui ne connecte personne et montre le compte qui serait ouvert. Il fonctionne avant l’activation.'
                    ),
                },
                {
                    text: L(
                        '<strong>2. Migration.</strong> In <em>SSO migration</em>, map every existing employee onto their directory identity (dry run, then apply). Each migrated account receives the SSO invitation when SSO goes live.',
                        '<strong>2. Migration.</strong> Dans <em>Migration SSO</em>, rattachez chaque collaborateur existant à son identité d’annuaire (simulation, puis application). Chaque compte migré reçoit l’invitation SSO à la mise en service.'
                    ),
                },
                {
                    text: L(
                        '<strong>3. Readiness.</strong> The <em>readiness report</em> at the top of this page lists who would have no way in once SSO is on: administrators with no SSO path or no two-factor, employees with no identity and no mapping, super administrators without two-factor. Close the gaps before activating.',
                        '<strong>3. Préparation.</strong> Le <em>rapport de préparation</em> en haut de cette page liste qui n’aurait plus aucun moyen d’entrer une fois le SSO activé : administrateurs sans accès SSO ou sans double authentification, collaborateurs sans identité ni rattachement, super administrateurs sans double authentification. Comblez ces manques avant l’activation.'
                    ),
                },
                {
                    text: L(
                        '<strong>4. Exceptions.</strong> An employee who cannot use SSO can be listed by a super administrator as an <em>SSO exception</em> (employee record → « SSO exception », reason required, logged): they keep password sign-in and reset, and receive no SSO invitation. Never an administrator account.',
                        '<strong>4. Exceptions.</strong> Un collaborateur qui ne peut pas utiliser le SSO peut être déclaré <em>exception SSO</em> par un super administrateur (fiche du collaborateur → « Exception SSO », raison obligatoire, journalisée) : il garde la connexion et la réinitialisation par mot de passe, et ne reçoit pas d’invitation SSO. Jamais un compte administrateur.'
                    ),
                },
                {
                    text: L(
                        '<strong>5. Announcement.</strong> Set the <em>planned go-live date</em>: 48 hours before it (or at once if it is closer), every migrated account receives one short notice « From …, you will sign in with your … account ». Exceptions and super administrators are excluded.',
                        '<strong>5. Annonce.</strong> Renseignez la <em>date de mise en service prévue</em> : 48 heures avant (ou tout de suite si elle est plus proche), chaque compte migré reçoit une seule fois un court message « À partir du …, vous vous connecterez avec votre compte … ». Exceptions et super administrateurs exclus.'
                    ),
                },
                {
                    text: L(
                        '<strong>6. Activation.</strong> Tick <strong>Enable Single Sign-On</strong> and save: you are asked to confirm how many accounts have no SSO access (exceptions not counted). From then on every account signs in with SSO; the invitations go out.',
                        '<strong>6. Activation.</strong> Cochez <strong>Activer l’authentification unique</strong> et enregistrez : il vous est demandé de confirmer combien de comptes n’ont aucun accès SSO (exceptions non comptées). Dès lors, tous les comptes se connectent par SSO ; les invitations partent.'
                    ),
                },
            ],
            practices: [
                L(
                    '<strong>Break-glass:</strong> while SSO is on, only the super administrator signs in with a password (discreet « Emergency access » link on the sign-in page), always with two-factor authentication — a super administrator never signs in through SSO. Keep at least two super administrators with two-factor.',
                    '<strong>Accès de secours :</strong> tant que le SSO est actif, seul le super administrateur se connecte par mot de passe (lien discret « Accès de secours » sur la page de connexion), toujours avec double authentification — un super administrateur ne se connecte jamais par SSO. Gardez au moins deux super administrateurs avec double authentification.'
                ),
                L(
                    '<strong>Enrolment codes:</strong> an administrator whose identity provider does not assert two-factor and who has no local two-factor yet signs in with a one-time <em>enrolment code</em> issued by a super administrator (administrator record), then sets up two-factor at once.',
                    '<strong>Codes d’enrôlement :</strong> un administrateur dont le fournisseur d’identité n’atteste pas la double authentification et qui n’a pas encore de double authentification locale se connecte avec un <em>code d’enrôlement</em> à usage unique émis par un super administrateur (fiche de l’administrateur), puis configure aussitôt sa double authentification.'
                ),
                L(
                    'Use HTTPS callback URLs in production (most IdPs reject plain http except localhost); set TRUST_PROXY behind a TLS proxy.',
                    'Utilisez des URL de callback en HTTPS en production (la plupart des IdP refusent le http simple sauf localhost) ; réglez TRUST_PROXY derrière un proxy TLS.'
                ),
                L(
                    'Fill in <em>Who to contact</em>: it is printed on the sign-in page, in every refusal message and in the invitations.',
                    'Renseignez <em>Qui contacter</em> : il figure sur la page de connexion, dans chaque message de refus et dans les invitations.'
                ),
            ],
            value: L(
                'One-click corporate sign-in with no extra password to manage, while access still maps to the account and scope you already control here.',
                "Une connexion d'entreprise en un clic sans mot de passe supplémentaire à gérer, tandis que l'accès reste rattaché au compte et au périmètre que vous contrôlez déjà ici."
            ),
        },

        '/onboarding': {
            title: L('Onboarding Queue', "File d'onboarding"),
            why: L(
                '<strong>Process:</strong> People who self-register (open signup or SSO without an account) wait here as pending requests — they are NOT employees yet, because an employee needs a site/department/service/role. You "place" each person, which creates their active account. Gated by the <em>Manage onboarding</em> permission.',
                "<strong>Processus :</strong> les personnes qui s'inscrivent d'elles-mêmes (inscription ouverte ou SSO sans compte) attendent ici en tant que demandes en attente — elles ne sont PAS encore des collaborateurs, car un collaborateur a besoin d'un site/département/service/poste. Vous « placez » chaque personne, ce qui crée son compte actif. Conditionné par la permission <em>Gérer l'onboarding</em>."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Review each request</strong> (email, name, source: signup or SSO).',
                        '<strong>Examinez chaque demande</strong> (e-mail, nom, source : inscription ou SSO).'
                    ),
                },
                {
                    text: L(
                        '<strong>Fill the placement:</strong> site, department, service and role (required), plus an optional supervisor and/or manager; adjust the name and employee number if needed.',
                        '<strong>Remplissez le placement :</strong> site, département, service et poste (obligatoires), plus un superviseur et/ou manager facultatif ; ajustez le nom et le matricule si besoin.'
                    ),
                },
                {
                    text: L(
                        'Click <strong>Place &amp; create account</strong> — this creates the employee, linking their password (signup) or SSO identity, and grants access.',
                        "Cliquez sur <strong>Placer &amp; créer le compte</strong> — cela crée le collaborateur, en reliant son mot de passe (inscription) ou son identité SSO, et accorde l'accès."
                    ),
                },
                {
                    text: L(
                        'Or <strong>Reject</strong> with an optional reason. Rejected people may register again.',
                        "Ou <strong>Rejetez</strong> avec un motif facultatif. Les personnes rejetées peuvent s'inscrire à nouveau."
                    ),
                },
            ],
            practices: [
                L(
                    'Work the queue promptly so new joiners aren\'t left waiting on the "awaiting setup" page.',
                    'Traitez la file rapidement pour que les nouveaux arrivants ne restent pas bloqués sur la page « en attente de configuration ».'
                ),
                L(
                    'Verify the person is genuine before placing — placement grants real access to your data.',
                    'Vérifiez que la personne est authentique avant de la placer — le placement accorde un accès réel à vos données.'
                ),
                L(
                    'Restrict open signup to your email domains (Settings → Self-Service Onboarding → allowedDomains) to cut noise.',
                    "Restreignez l'inscription ouverte à vos domaines de messagerie (Paramètres → Onboarding en libre-service → allowedDomains) pour réduire le bruit."
                ),
            ],
            value: L(
                'Self-service onboarding offloads data entry to the joiner while you keep full control: nobody gets access until you place them into the right team.',
                "L'onboarding en libre-service décharge la saisie sur l'arrivant tout en vous laissant le contrôle total : personne n'obtient d'accès tant que vous ne l'avez pas placé dans la bonne équipe."
            ),
        },

        '/v2/continuity': {
            title: L(
                'People Continuity (Succession, Risk-of-loss &amp; Handover)',
                'Continuité des personnes (succession, risque de perte &amp; passation)'
            ),
            why: L(
                '<strong>Process:</strong> Protect business continuity for your critical roles. Designate <em>critical roles</em>, build a succession <em>bench</em> of named successors (auto-seeded from readiness against the target role and ranked by a Ready-now / 1–2yr / 3+yr / Emergency band), track <em>risk-of-loss</em> for key people (flight-risk × impact-of-loss, computed from existing signals and adjustable), and capture a <em>knowledge handover</em> when someone leaves or moves. Separation of duties: you can never own the plan for your own seat, nor see your own risk record. Scoped by RBAC to your people.',
                "<strong>Processus :</strong> protégez la continuité d'activité de vos postes critiques. Désignez des <em>postes critiques</em>, constituez un <em>vivier</em> de succession de successeurs nommés (pré-alimenté depuis la préparation face au poste cible et classé par bande Prêt-maintenant / 1–2 ans / 3+ ans / Urgence), suivez le <em>risque de perte</em> des personnes clés (risque de départ × impact de la perte, calculé à partir de signaux existants et ajustable), et consignez une <em>passation de connaissances</em> quand quelqu'un part ou change de poste. Séparation des tâches : vous ne pouvez jamais posséder le plan de votre propre poste, ni voir votre propre fiche de risque. Périmètre limité à vos personnes par les droits d'accès."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Designate a critical role</strong> (criticality 1–5, vacancy risk, time-to-fill) so it appears in the coverage table.',
                        "<strong>Désignez un poste critique</strong> (criticité 1–5, risque de vacance, délai de pourvoi) pour qu'il apparaisse dans la table de couverture."
                    ),
                },
                {
                    text: L(
                        '<strong>Open a succession plan</strong> for the role; click <strong>Seed bench</strong> to auto-rank candidates by readiness, or add a successor manually. Set an <strong>emergency cover</strong> for the hit-by-a-bus case.',
                        "<strong>Ouvrez un plan de succession</strong> pour le poste ; cliquez sur <strong>Alimenter le vivier</strong> pour classer automatiquement les candidats par préparation, ou ajoutez un successeur manuellement. Définissez une <strong>relève d'urgence</strong> pour le cas de départ soudain."
                    ),
                },
                {
                    text: L(
                        '<strong>Adjust readiness bands</strong> as people develop; the bench re-evaluates automatically when a mapped LMS course is completed.',
                        "<strong>Ajustez les bandes de préparation</strong> à mesure que les personnes se développent ; le vivier se réévalue automatiquement à l'achèvement d'un cours LMS mappé."
                    ),
                },
                {
                    text: L(
                        '<strong>Risk-of-loss:</strong> recompute or override flight-risk / impact-of-loss for your team (your own record is never shown).',
                        "<strong>Risque de perte :</strong> recalculez ou forcez le risque de départ / l'impact de la perte pour votre équipe (votre propre fiche n'est jamais affichée)."
                    ),
                },
                {
                    text: L(
                        '<strong>Knowledge handover:</strong> a leaver/mover auto-creates a plan with default items; complete each item — the plan closes itself when all are done.',
                        '<strong>Passation de connaissances :</strong> un départ/une mobilité crée automatiquement un plan avec des éléments par défaut ; complétez chaque élément — le plan se clôture de lui-même quand tout est fait.'
                    ),
                },
            ],
            practices: [
                L(
                    'Designate criticality honestly — a 5 should be a role that genuinely hurts to leave vacant; over-flagging dilutes focus.',
                    "Désignez la criticité honnêtement — un 5 doit être un poste dont la vacance fait réellement mal ; sur-signaler dilue l'attention."
                ),
                L(
                    'Aim for at least one Ready-now (or a named emergency cover) on every critical role; a gap there is your biggest continuity risk.',
                    "Visez au moins un Prêt-maintenant (ou une relève d'urgence nommée) sur chaque poste critique ; un manque à ce niveau est votre plus grand risque de continuité."
                ),
                L(
                    'Treat risk-of-loss as a prompt for a retention conversation, not a verdict — and keep it confidential.',
                    'Traitez le risque de perte comme une invitation à une conversation de rétention, pas comme un verdict — et gardez-le confidentiel.'
                ),
            ],
            value: L(
                'Continuity stays live without manual upkeep: development → LMS completion → skill rise → readiness recompute → a successor flips to Ready-now and the plan owner is notified, closing the coverage gap on its own.',
                'La continuité reste vivante sans entretien manuel : développement → achèvement LMS → hausse de compétence → recalcul de préparation → un successeur passe à Prêt-maintenant et le propriétaire du plan est notifié, comblant le manque de couverture de lui-même.'
            ),
        },

        '/v2/lms': {
            title: L('LMS Integration Hub', "Hub d'intégration LMS"),
            why: L(
                '<strong>Process:</strong> Connect external learning so development actually moves the skill matrix. A pluggable, standards-first framework (xAPI/LTI) with first-class <em>Cornerstone OnDemand</em> and <em>MyPath</em> adapters — any conformant LMS can connect. Map a course to the skill it builds once; afterwards a completion (reported by webhook and/or hourly poll) raises that skill as an audited <em>LMS completion</em> source — which never overrides a supervisor review — and readiness/continuity update automatically. Provider credentials are encrypted at rest; configuring providers needs the <em>Configure LMS integration</em> permission.',
                "<strong>Processus :</strong> connectez l'apprentissage externe pour que le développement fasse réellement bouger la matrice de compétences. Un cadre enfichable, axé standards (xAPI/LTI) avec des adaptateurs de premier plan <em>Cornerstone OnDemand</em> et <em>MyPath</em> — tout LMS conforme peut se connecter. Mappez une fois un cours à la compétence qu'il construit ; ensuite un achèvement (rapporté par webhook et/ou interrogation horaire) relève cette compétence comme source <em>achèvement LMS</em> auditée — qui ne remplace jamais une revue de superviseur — et la préparation/continuité se mettent à jour automatiquement. Les identifiants des fournisseurs sont chiffrés au repos ; configurer les fournisseurs requiert la permission <em>Configurer l'intégration LMS</em>."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Configure a provider</strong> (admins): pick it (e.g. cornerstone), set base URL, webhook secret, and Auth config JSON — Cornerstone uses OAuth2 <code>{client_id, client_secret, scope}</code>. <strong>Test</strong>, then <strong>Sync catalog</strong>.',
                        "<strong>Configurez un fournisseur</strong> (admins) : choisissez-le (p. ex. cornerstone), réglez l'URL de base, le secret de webhook, et le JSON de config Auth — Cornerstone utilise OAuth2 <code>{client_id, client_secret, scope}</code>. <strong>Testez</strong>, puis <strong>Synchronisez le catalogue</strong>."
                    ),
                },
                {
                    text: L(
                        '<strong>Map courses to skills</strong> (managers too): pick the skill a course builds and the level it confers.',
                        "<strong>Mappez les cours aux compétences</strong> (les managers aussi) : choisissez la compétence qu'un cours construit et le niveau qu'il confère."
                    ),
                },
                {
                    text: L(
                        '<strong>Assign</strong> a mapped course to someone in your span — they’re enrolled in the connected LMS (and auto-assigned when a 9-box “blue” IDP is triggered).',
                        '<strong>Assignez</strong> un cours mappé à une personne de votre périmètre — elle est inscrite dans le LMS connecté (et assignée automatiquement quand un PDI « bleu » 9-box est déclenché).'
                    ),
                },
                {
                    text: L(
                        '<strong>Register the webhook URL</strong> <code>/integrations/lms/&lt;provider&gt;/webhook</code> in the LMS (header <code>x-webhook-secret</code>) so completions post back; otherwise the hourly poll fetches them.',
                        "<strong>Enregistrez l'URL de webhook</strong> <code>/integrations/lms/&lt;provider&gt;/webhook</code> dans le LMS (en-tête <code>x-webhook-secret</code>) pour que les achèvements soient renvoyés ; sinon l'interrogation horaire les récupère."
                    ),
                },
                {
                    text: L(
                        '<strong>Curation queue:</strong> shows in-demand skills (from successor gaps + IDP objectives) that still have no mapped course — close those to maximise auto-uplift.',
                        "<strong>File de curation :</strong> montre les compétences demandées (issues des écarts de successeurs + objectifs de PDI) qui n'ont encore aucun cours mappé — comblez-les pour maximiser la montée en compétence automatique."
                    ),
                },
            ],
            practices: [
                L(
                    'Map the few high-demand skills first (use the curation queue) — that is where automatic gap-closing pays off most.',
                    "Mappez d'abord les quelques compétences très demandées (via la file de curation) — c'est là que le comblement automatique des écarts rapporte le plus."
                ),
                L(
                    'Keep the webhook secret in the header, never the URL/body; the endpoint rejects any call without a matching per-provider secret.',
                    "Gardez le secret de webhook dans l'en-tête, jamais dans l'URL/le corps ; le point d'accès rejette tout appel sans secret correspondant par fournisseur."
                ),
                L(
                    'Let completions raise skills automatically; only adjust manually when a supervisor needs to override.',
                    "Laissez les achèvements relever les compétences automatiquement ; n'ajustez manuellement que lorsqu'un superviseur doit corriger."
                ),
            ],
            value: L(
                'The hub turns learning from a disconnected activity into a measurable driver: a completed course visibly lifts the matrix, closes readiness gaps and advances succession — with a full, auditable provenance trail.',
                "Le hub transforme l'apprentissage d'une activité déconnectée en un levier mesurable : un cours terminé relève visiblement la matrice, comble les écarts de préparation et fait avancer la succession — avec une piste de provenance complète et auditable."
            ),
        },

        '/v2/cap': {
            title: L('Talent &amp; Engagement Suite', 'Suite Talent &amp; engagement'),
            why: L(
                '<strong>Process:</strong> One hub for the higher-order talent functions that build on the skills/9-box core: <em>Calibration</em> (a facilitated session that moves placements with mandatory rationale, append-only), <em>Goal cascading</em> (company/site/department objectives that employee OKRs align to, with roll-up), <em>Internal mobility</em> (post gigs/projects/roles; the engine ranks candidates by skill coverage + adjacency), <em>Engagement surveys</em> (eNPS/pulse with anonymity suppression, feeding risk-of-loss), <em>Recognition &amp; feedback</em>, <em>DEI analytics</em> (representation / 9-box / PIP-rate by group, suppressed below a minimum group size), <em>Skills graph &amp; inference</em> (suggest skills a person likely has from completed learning + adjacency), and the on-prem <em>AI Copilot</em>. Every view is RBAC-scoped to your people; demographics are sealed.',
                "<strong>Processus :</strong> un hub unique pour les fonctions de talent d'ordre supérieur qui s'appuient sur le socle compétences/9-box : <em>Calibration</em> (une séance facilitée qui déplace les positionnements avec justification obligatoire, en ajout seul), <em>Cascade d'objectifs</em> (objectifs entreprise/site/département auxquels les OKR des collaborateurs s'alignent, avec consolidation), <em>Mobilité interne</em> (publiez missions/projets/postes ; le moteur classe les candidats par couverture de compétences + adjacence), <em>Enquêtes d'engagement</em> (eNPS/pulse avec suppression pour l'anonymat, alimentant le risque de perte), <em>Reconnaissance &amp; feedback</em>, <em>Analytique DEI</em> (représentation / 9-box / taux de PIP par groupe, supprimée sous une taille de groupe minimale), <em>Graphe de compétences &amp; inférence</em> (suggère les compétences qu'une personne a probablement d'après l'apprentissage terminé + l'adjacence), et le <em>Copilote IA</em> sur site. Chaque vue est limitée à vos personnes par les droits d'accès ; les données démographiques sont scellées."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Calibration:</strong> open a session for a scope, move placements with a required rationale (it’s append-only), watch the live distribution, then finalize.',
                        '<strong>Calibration :</strong> ouvrez une séance pour un périmètre, déplacez les positionnements avec une justification obligatoire (en ajout seul), suivez la distribution en direct, puis finalisez.'
                    ),
                },
                {
                    text: L(
                        '<strong>Goal alignment:</strong> create an org objective and align team/individual OKR goals to it; the cascade view rolls up contribution progress.',
                        "<strong>Alignement d'objectifs :</strong> créez un objectif organisationnel et alignez-y les OKR d'équipe/individuels ; la vue cascade consolide l'avancement des contributions."
                    ),
                },
                {
                    text: L(
                        '<strong>Mobility:</strong> post an opportunity with the skills it needs; open “Match” to see ranked candidates (direct skills + learnable adjacents) within your scope.',
                        '<strong>Mobilité :</strong> publiez une opportunité avec les compétences requises ; ouvrez « Match » pour voir les candidats classés (compétences directes + adjacentes apprenables) dans votre périmètre.'
                    ),
                },
                {
                    text: L(
                        '<strong>Surveys:</strong> create an engagement/eNPS/pulse survey, open it, and read results — anything below the response threshold is suppressed so individuals are never exposed.',
                        "<strong>Enquêtes :</strong> créez une enquête d'engagement/eNPS/pulse, ouvrez-la, et lisez les résultats — tout ce qui est sous le seuil de réponses est supprimé pour ne jamais exposer d'individus."
                    ),
                },
                {
                    text: L(
                        '<strong>Skills inference:</strong> run “Infer skills” for a report to get suggested skills (from completed courses + adjacency); accept to record a level (never lowers an existing one) or dismiss.',
                        "<strong>Inférence de compétences :</strong> lancez « Inférer les compétences » pour un collaborateur afin d'obtenir des compétences suggérées (d'après les cours terminés + l'adjacence) ; acceptez pour enregistrer un niveau (n'abaisse jamais un niveau existant) ou écartez."
                    ),
                },
                {
                    text: L(
                        '<strong>Copilot:</strong> ask plain-English questions about your team — it answers only from data you’re cleared to see, on-prem.',
                        '<strong>Copilote :</strong> posez des questions en langage naturel sur votre équipe — il répond uniquement à partir des données que vous êtes autorisé à voir, sur site.'
                    ),
                },
            ],
            practices: [
                L(
                    'Calibrate as a group and always capture the rationale — that record is what makes the talent process defensible.',
                    "Calibrez en groupe et consignez toujours la justification — c'est cette trace qui rend le processus de talent défendable."
                ),
                L(
                    'Keep surveys anonymous and respect the suppression threshold; trust is what keeps response rates up.',
                    "Gardez les enquêtes anonymes et respectez le seuil de suppression ; c'est la confiance qui maintient les taux de réponse."
                ),
                L(
                    'Use the mobility match + skills inference together: they turn your existing skills data into employee-facing opportunity.',
                    "Utilisez ensemble le match de mobilité + l'inférence de compétences : ils transforment vos données de compétences existantes en opportunités offertes aux collaborateurs."
                ),
            ],
            value: L(
                'This suite converts the raw skills/9-box data into the things leaders actually act on — fair calibration, aligned goals, internal opportunity, engagement signal, and answers on demand — without any data leaving your environment.',
                "Cette suite convertit les données brutes compétences/9-box en ce sur quoi les dirigeants agissent réellement — calibration équitable, objectifs alignés, opportunités internes, signal d'engagement, et réponses à la demande — sans qu'aucune donnée ne quitte votre environnement."
            ),
        },

        '/admin/api-keys': {
            title: L('API Keys &amp; Power BI', 'Clés API &amp; Power BI'),
            why: L(
                '<strong>Process:</strong> Issue API keys for external dashboards (Power BI, Tableau, any OData/REST client) to read live data out of IDevelop. The key point is <em>clearance</em>: each key is bound to a <strong>profile</strong> (an admin account), and every feed it powers returns ONLY the data that profile is allowed to see (RBAC scope). A superadmin-owned key sees the whole org; a site-admin-owned key sees just that site; a leave-blank “Full organization (system)” key is the legacy org-wide feed. So the same Power BI report, pointed at two keys, shows two different populations — you build one dashboard and hand each leader a key scoped to their area. Read-only. SuperAdmin only.',
                "<strong>Processus :</strong> émettez des clés API pour des tableaux de bord externes (Power BI, Tableau, tout client OData/REST) afin de lire les données vivantes de IDevelop. Le point clé est l'<em>habilitation</em> : chaque clé est liée à un <strong>profil</strong> (un compte admin), et chaque flux qu'elle alimente ne renvoie QUE les données que ce profil est autorisé à voir (périmètre des droits d'accès). Une clé détenue par un superadmin voit toute l'organisation ; une clé détenue par un admin de site ne voit que ce site ; une clé « Organisation complète (système) » laissée vide est le flux historique à l'échelle de l'organisation. Ainsi le même rapport Power BI, pointé vers deux clés, montre deux populations différentes — vous construisez un tableau de bord et remettez à chaque dirigeant une clé délimitée à son domaine. Lecture seule. Réservé au SuperAdmin."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Create a key:</strong> give it a label, pick the <strong>profile</strong> whose clearance it should inherit, optionally an expiry, then <strong>Create</strong>.',
                        "<strong>Créez une clé :</strong> donnez-lui un libellé, choisissez le <strong>profil</strong> dont elle doit hériter de l'habilitation, éventuellement une expiration, puis <strong>Créer</strong>."
                    ),
                },
                {
                    text: L(
                        '<strong>Copy the key once</strong> — it is shown a single time and stored only as a hash; if lost, revoke and re-issue.',
                        "<strong>Copiez la clé une fois</strong> — elle n'est affichée qu'une seule fois et stockée uniquement sous forme de hachage ; en cas de perte, révoquez et réémettez."
                    ),
                },
                {
                    text: L(
                        '<strong>In Power BI:</strong> Get Data → OData feed → one of the <code>/api/powerbi/*</code> URLs, and add the header <code>X-API-Key: &lt;key&gt;</code> (Advanced editor / Web.Contents).',
                        "<strong>Dans Power BI :</strong> Obtenir des données → flux OData → l'une des URL <code>/api/powerbi/*</code>, et ajoutez l'en-tête <code>X-API-Key: &lt;clé&gt;</code> (éditeur avancé / Web.Contents)."
                    ),
                },
                {
                    text: L(
                        '<strong>Revoke</strong> any key instantly; expired keys stop working on their own.',
                        "<strong>Révoquez</strong> n'importe quelle clé instantanément ; les clés expirées cessent de fonctionner d'elles-mêmes."
                    ),
                },
            ],
            practices: [
                L(
                    'One key per audience: bind each to the narrowest profile that still covers what that dashboard should show — least privilege.',
                    'Une clé par public : liez chacune au profil le plus restreint qui couvre encore ce que ce tableau de bord doit montrer — moindre privilège.'
                ),
                L(
                    'Set an expiry for time-boxed or external recipients; rotate keys periodically.',
                    'Fixez une expiration pour les destinataires temporaires ou externes ; faites tourner les clés périodiquement.'
                ),
                L(
                    'Prefer the X-API-Key header over the ?apiKey= query param (the query string can leak into proxy/access logs).',
                    "Préférez l'en-tête X-API-Key au paramètre ?apiKey= (la chaîne de requête peut fuir dans les journaux de proxy/accès)."
                ),
            ],
            value: L(
                'Clearance-aware keys let you safely extend dashboards to many audiences from one report: every recipient sees exactly — and only — their own population, with no separate report build and no data-leak risk.',
                "Des clés conscientes de l'habilitation vous permettent d'étendre en toute sécurité les tableaux de bord à de nombreux publics à partir d'un seul rapport : chaque destinataire voit exactement — et uniquement — sa propre population, sans construire de rapport séparé et sans risque de fuite de données."
            ),
        },

        '/setup': {
            title: L('Getting Started (Setup Checklist)', 'Prise en main (liste de configuration)'),
            why: L(
                '<strong>Process:</strong> The first-run checklist that walks a new installation to a working platform, in the right order: <em>1. Organization</em> (sites → departments → services) → <em>2. Skills framework</em> (pillars/sub-domains/skills — the capability framework ships pre-loaded) → <em>3. Roles + required levels</em> (this powers readiness, gaps and the benchmark) → <em>4. People</em> (create or bulk-import) → <em>5. First assessments</em> (baseline everyone) → <em>6. Email (optional)</em> for notifications, digests and scheduled reports. Each step shows a live count and turns green when done.',
                '<strong>Processus :</strong> la liste de premier lancement qui amène une nouvelle installation à une plateforme opérationnelle, dans le bon ordre : <em>1. Organisation</em> (sites → départements → services) → <em>2. Référentiel de compétences</em> (piliers/sous-domaines/compétences — le référentiel de capacités est préchargé) → <em>3. Postes + niveaux requis</em> (cela alimente préparation, écarts et référentiel) → <em>4. Personnes</em> (créer ou importer en masse) → <em>5. Premières évaluations</em> (établir la base de tous) → <em>6. E-mail (facultatif)</em> pour notifications, synthèses et rapports planifiés. Chaque étape affiche un décompte en direct et passe au vert une fois faite.'
            ),
            steps: [
                {
                    text: L(
                        "Work <strong>top to bottom</strong> — each step depends on the one above (you can't require skill levels for roles that don't exist).",
                        "Procédez <strong>de haut en bas</strong> — chaque étape dépend de la précédente (impossible d'exiger des niveaux de compétence pour des postes qui n'existent pas)."
                    ),
                },
                {
                    text: L(
                        'Click <strong>Start / Review</strong> on a step to jump to the right screen, do the work, come back — the count updates.',
                        'Cliquez sur <strong>Démarrer / Revoir</strong> sur une étape pour aller au bon écran, faire le travail, revenir — le décompte se met à jour.'
                    ),
                },
                {
                    text: L(
                        'Prefer <strong>Data Management templates</strong> (Tools → Data Management) for bulk loads: download the Excel template, fill it, Preview, Import.',
                        'Préférez les <strong>modèles de Gestion des données</strong> (Outils → Gestion des données) pour les chargements en masse : téléchargez le modèle Excel, remplissez-le, prévisualisez, importez.'
                    ),
                },
                {
                    text: L(
                        'When every required step is green, the dashboard banner disappears; you can also <strong>dismiss</strong> it manually.',
                        'Quand chaque étape requise est verte, la bannière du tableau de bord disparaît ; vous pouvez aussi la <strong>masquer</strong> manuellement.'
                    ),
                },
            ],
            practices: [
                L(
                    'Baseline assessments before you trust any dashboard number — readiness computed on 3 assessed people out of 77 is noise.',
                    "Établissez une base d'évaluations avant de vous fier à un chiffre du tableau de bord — une préparation calculée sur 3 personnes évaluées sur 77 est du bruit."
                ),
                L(
                    'Set role REQUIRED levels with the managers who own the roles; they define what "ready" means.',
                    'Fixez les niveaux REQUIS des postes avec les managers qui possèdent ces postes ; ce sont eux qui définissent ce que « prêt » veut dire.'
                ),
                L(
                    'Configure SMTP early if you want notifications, weekly digests and scheduled reports — everything else works without it.',
                    'Configurez le SMTP tôt si vous voulez notifications, synthèses hebdomadaires et rapports planifiés — tout le reste fonctionne sans.'
                ),
            ],
            value: L(
                'Following the checklist order gets a brand-new install to a trustworthy, fully-operational platform in one sitting, with no step forgotten.',
                "Suivre l'ordre de la liste amène une installation neuve à une plateforme fiable et pleinement opérationnelle en une seule session, sans oublier une étape."
            ),
        },

        '/reports/local-content': {
            title: L('Local Content / Nationalization', 'Contenu local / nationalisation'),
            why: L(
                "<strong>Process:</strong> The compliance report for regulated industries (e.g. mining local-content decrees): what share of the workforce is <em>national</em> (nationality = the configured home country), broken down by department, role family and site — plus the <strong>nationalization pipeline</strong>: every expatriate-held position, with how many national peers already hold the same role and a one-click jump to that role's succession view. This is an <strong>optional module</strong>: a SuperAdmin activates it in Settings (feature toggle + home country), which also reveals the Nationality field on employee forms.",
                "<strong>Processus :</strong> le rapport de conformité pour les industries réglementées (p. ex. décrets de contenu local minier) : quelle part de l'effectif est <em>nationale</em> (nationalité = le pays d'origine configuré), ventilée par département, famille de postes et site — plus le <strong>pipeline de nationalisation</strong> : chaque poste occupé par un expatrié, avec combien de pairs nationaux occupent déjà le même poste et un accès en un clic à la vue succession de ce poste. C'est un <strong>module facultatif</strong> : un SuperAdmin l'active dans les Paramètres (bascule de fonction + pays d'origine), ce qui révèle aussi le champ Nationalité sur les formulaires collaborateur."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Activate first (SuperAdmin):</strong> Settings → set <em>Local content module</em> ON and fill <em>Home country</em> (e.g. "Ivory Coast").',
                        "<strong>Activez d'abord (SuperAdmin) :</strong> Paramètres → mettez le <em>module Contenu local</em> sur ACTIVÉ et renseignez le <em>Pays d'origine</em> (p. ex. « Côte d'Ivoire »)."
                    ),
                },
                {
                    text: L(
                        '<strong>Fill nationalities:</strong> the employee create/edit form now shows a Nationality field; fill it (or bulk-update via import). Unspecified people are counted apart — they never inflate the national %.',
                        '<strong>Renseignez les nationalités :</strong> le formulaire de création/modification de collaborateur montre désormais un champ Nationalité ; remplissez-le (ou mettez à jour en masse via import). Les personnes non spécifiées sont comptées à part — elles ne gonflent jamais le % national.'
                    ),
                },
                {
                    text: L(
                        'Read the <strong>KPIs</strong> (workforce, national %, expatriates, unspecified) and the three tables (department / role family / site).',
                        'Lisez les <strong>KPI</strong> (effectif, % national, expatriés, non spécifiés) et les trois tables (département / famille de postes / site).'
                    ),
                },
                {
                    text: L(
                        'For each expatriate position, check <strong>National peers</strong> and click <strong>Succession</strong> to see ready national successors on the role benchmark.',
                        "Pour chaque poste d'expatrié, vérifiez les <strong>pairs nationaux</strong> et cliquez sur <strong>Succession</strong> pour voir les successeurs nationaux prêts sur le référentiel du poste."
                    ),
                },
                {
                    text: L(
                        '<strong>Export CSV</strong> for the regulator — it contains all three breakdowns.',
                        '<strong>Exportez en CSV</strong> pour le régulateur — il contient les trois ventilations.'
                    ),
                },
            ],
            practices: [
                L(
                    'Nationality exactly matching the home-country spelling counts as national — keep one canonical spelling (the match is case-insensitive but not fuzzy).',
                    "Une nationalité correspondant exactement à l'orthographe du pays d'origine compte comme nationale — gardez une orthographe canonique unique (la correspondance est insensible à la casse mais pas approximative)."
                ),
                L(
                    'Drive the "unspecified" count to zero first; a report with holes convinces no regulator.',
                    "Ramenez d'abord le décompte « non spécifié » à zéro ; un rapport troué ne convainc aucun régulateur."
                ),
                L(
                    'Use the Succession link on expat positions to build the nationalization plan the decree usually asks for.',
                    "Utilisez le lien Succession sur les postes d'expatriés pour bâtir le plan de nationalisation que le décret demande généralement."
                ),
            ],
            value: L(
                'Turns a painful yearly compliance spreadsheet into a live, always-correct report — with the succession evidence that shows a credible nationalization path, not just a quota snapshot.',
                'Transforme un pénible tableur de conformité annuel en un rapport vivant et toujours exact — avec la preuve de succession qui montre une trajectoire de nationalisation crédible, pas seulement un instantané de quota.'
            ),
        },

        '/reports/schedules': {
            title: L('Scheduled Reports (Email Delivery)', 'Rapports planifiés (envoi par e-mail)'),
            why: L(
                '<strong>Process:</strong> Recurring email delivery of saved report templates. You build a report once in the Report Builder, save it as a template, then schedule it: recipients + frequency (daily / weekly+day / monthly+day) + format (CSV / Excel). The scheduler sends it automatically with the report attached; each schedule shows its last-run status.',
                "<strong>Processus :</strong> l'envoi récurrent par e-mail de modèles de rapports enregistrés. Vous construisez un rapport une fois dans le Générateur de rapports, l'enregistrez comme modèle, puis le planifiez : destinataires + fréquence (quotidien / hebdomadaire+jour / mensuel+jour) + format (CSV / Excel). Le planificateur l'envoie automatiquement avec le rapport en pièce jointe ; chaque planification affiche l'état de sa dernière exécution."
            ),
            steps: [
                {
                    text: L(
                        'In <strong>Reports → Report Builder</strong>, build the report and <strong>Save as template</strong>.',
                        'Dans <strong>Rapports → Générateur de rapports</strong>, construisez le rapport et <strong>Enregistrez comme modèle</strong>.'
                    ),
                },
                {
                    text: L(
                        'Open <strong>Schedules</strong>, pick the template, type recipient emails (comma-separated), choose frequency and format, <strong>Create</strong>.',
                        'Ouvrez <strong>Planifications</strong>, choisissez le modèle, saisissez les e-mails des destinataires (séparés par des virgules), choisissez la fréquence et le format, <strong>Créez</strong>.'
                    ),
                },
                {
                    text: L(
                        'Check the <strong>last run</strong> column after the first occurrence; delete or recreate a schedule any time.',
                        'Vérifiez la colonne <strong>dernière exécution</strong> après la première occurrence ; supprimez ou recréez une planification à tout moment.'
                    ),
                },
            ],
            practices: [
                L(
                    'Email (SMTP) must be configured in Settings — a schedule without working email silently delivers nothing.',
                    "L'e-mail (SMTP) doit être configuré dans les Paramètres — une planification sans e-mail fonctionnel ne livre rien, en silence."
                ),
                L(
                    "Schedule to role inboxes (e.g. hse-managers@…) rather than individuals, so staffing changes don't break delivery.",
                    'Planifiez vers des boîtes de rôle (p. ex. hse-managers@…) plutôt que des individus, pour que les mouvements de personnel ne cassent pas la livraison.'
                ),
                L(
                    'One report, one audience: make a template per audience instead of one giant report everyone ignores.',
                    "Un rapport, un public : faites un modèle par public plutôt qu'un rapport géant que tout le monde ignore."
                ),
            ],
            value: L(
                'The people who need numbers get them in their inbox on a rhythm — no one has to remember to log in and pull the report.',
                "Les personnes qui ont besoin des chiffres les reçoivent dans leur boîte à un rythme régulier — personne n'a à penser à se connecter pour extraire le rapport."
            ),
        },

        '/admin/sessions': {
            title: L(
                'Session Monitor (platform-wide)',
                'Moniteur de sessions (plateforme entière)'
            ),
            why: L(
                "<strong>Process:</strong> Every active session on the platform — who is signed in, from which device/IP, since when, and their last activity. SuperAdmin only. The <strong>Close</strong> button force-terminates a single session: that device is signed out on its next request. Complements the automatic protections (idle timeout for everyone; password change revokes the user's other sessions).",
                "<strong>Processus :</strong> chaque session active sur la plateforme — qui est connecté, depuis quel appareil/IP, depuis quand, et sa dernière activité. Réservé au SuperAdmin. Le bouton <strong>Fermer</strong> met fin de force à une session : cet appareil est déconnecté à sa prochaine requête. Complète les protections automatiques (expiration sur inactivité pour tous ; un changement de mot de passe révoque les autres sessions de l'utilisateur)."
            ),
            steps: [
                {
                    text: L(
                        'Use the <strong>filter box</strong> to find a user, IP or device across the whole list.',
                        'Utilisez le <strong>champ de filtre</strong> pour trouver un utilisateur, une IP ou un appareil dans toute la liste.'
                    ),
                },
                {
                    text: L(
                        '<strong>Close</strong> any suspicious or forgotten session — the action is audited (System Logs).',
                        "<strong>Fermez</strong> toute session suspecte ou oubliée — l'action est auditée (Journaux système)."
                    ),
                },
                {
                    text: L(
                        "Your own current session can't be closed here — use Logout.",
                        'Votre propre session en cours ne peut pas être fermée ici — utilisez Déconnexion.'
                    ),
                },
                {
                    text: L(
                        'To sign a user out of EVERYTHING (e.g. a departure or compromise), reset their password — that revokes all their sessions at once.',
                        "Pour déconnecter un utilisateur de TOUT (p. ex. un départ ou une compromission), réinitialisez son mot de passe — cela révoque toutes ses sessions d'un coup."
                    ),
                },
            ],
            practices: [
                L(
                    'Sweep after incidents and departures: any session belonging to someone who just left gets closed immediately.',
                    'Faites un balayage après incidents et départs : toute session appartenant à une personne qui vient de partir est fermée immédiatement.'
                ),
                L(
                    'A session from an unexpected country/IP for a privileged account = close it first, investigate second.',
                    "Une session depuis un pays/IP inattendu pour un compte privilégié = fermez d'abord, enquêtez ensuite."
                ),
                L(
                    'Prefer password reset over one-by-one closing when the ACCOUNT (not one device) is in question.',
                    "Préférez la réinitialisation du mot de passe à la fermeture une par une quand c'est le COMPTE (et non un appareil) qui est en cause."
                ),
            ],
            value: L(
                'One screen answers "who is on the platform right now?" and gives you the kill switch per device — incident response in two clicks, fully audited.',
                "Un seul écran répond à « qui est sur la plateforme en ce moment ? » et vous donne l'interrupteur d'arrêt par appareil — réponse à incident en deux clics, entièrement auditée."
            ),
        },

        '/admin/notifications': {
            title: L('Notifications Monitor (SuperAdmin)', 'Suivi des notifications (SuperAdmin)'),
            why: L(
                '<strong>Process:</strong> Every notification the platform produced across the whole organisation — IN-APP and EMAIL alike — with its recipient, kind, and delivery state (Queued, Sent, Failed, Snoozed). One place to answer "did that reminder/alert actually go out?" and to re-attempt a delivery that failed. SuperAdmin only, because it shows who was notified of what org-wide.',
                "<strong>Processus :</strong> toutes les notifications produites par la plateforme dans toute l'organisation — IN-APP comme E-MAIL — avec leur destinataire, leur type et leur état d'envoi (En file, Envoyée, En échec, Différée). Un seul endroit pour répondre à « ce rappel/cette alerte est-il bien parti ? » et pour relancer un envoi en échec. Réservé au SuperAdmin, car il montre qui a été notifié de quoi à l'échelle de l'organisation."
            ),
            steps: [
                {
                    text: L(
                        'Filter by <strong>channel</strong> (in-app / email), <strong>state</strong>, kind, recipient type or a name/email search, and by date range.',
                        'Filtrez par <strong>canal</strong> (in-app / e-mail), <strong>état</strong>, type, type de destinataire ou une recherche nom/e-mail, et par plage de dates.'
                    ),
                },
                {
                    text: L(
                        'Watch the <strong>Failed</strong> card: a non-zero count means deliveries that did not go out.',
                        'Surveillez la carte <strong>En échec</strong> : un compte non nul signale des envois qui ne sont pas partis.'
                    ),
                },
                {
                    text: L(
                        'On a failed row, <strong>Re-queue</strong> hands it back to the sender for another attempt — the action is audited (System Logs).',
                        "Sur une ligne en échec, <strong>Remettre en file</strong> la redonne à l'expéditeur pour un nouvel essai — l'action est auditée (Journaux système)."
                    ),
                },
            ],
            practices: [
                L(
                    'If emails show as Failed in a batch, check the SMTP settings before re-queuing one by one.',
                    'Si des e-mails apparaissent En échec en série, vérifiez la configuration SMTP avant de les remettre en file un par un.'
                ),
                L(
                    'A notification never leaves this table as "sent" unless the sender really sent it — re-queue only moves Failed back to Queued.',
                    "Une notification ne quitte jamais cette table en « envoyée » sans que l'expéditeur l'ait réellement envoyée — la remise en file ne fait que repasser En échec vers En file."
                ),
            ],
            value: L(
                'Delivery is no longer a black box: you can prove a reminder went out, spot a broken channel early, and recover failed sends without touching the database.',
                "L'envoi n'est plus une boîte noire : vous pouvez prouver qu'un rappel est parti, repérer tôt un canal cassé et récupérer les envois en échec sans toucher à la base."
            ),
        },

        '/admin/maintenance': {
            title: L('Maintenance (SuperAdmin)', 'Maintenance (SuperAdmin)'),
            why: L(
                "<strong>Process:</strong> Fix a record that should not exist — <em>without deleting anything</em>. Cancel an IDP or a PIP raised in error, cancel a 9-box position, void an employee record entered twice (reversible), and act on a self-assessment three ways by its state: <strong>Cancel</strong> it (it moves to <em>rejected</em>), <strong>Withdraw the review</strong> (the supervisor's review goes, the file returns to <em>submitted</em> exactly as the employee filed it and re-enters the reviewer's queue) or <strong>Request a change</strong> on one already <em>approved</em> (the approval and the lock are lifted, it goes back to the employee). Every action asks for a written reason and deliberately bypasses the two-person cancellation rule — the bypass is labelled in the System Logs (category <em>maintenance</em>), on the movement feed and in the record's own trail. The official skill profile is never rewritten here: a promoted level stays until a new approval replaces it.",
                "<strong>Processus :</strong> corriger un enregistrement qui n'aurait pas dû exister — <em>sans rien supprimer</em>. Annuler un PDI ou un PIP créé par erreur, annuler un positionnement 9-box, annuler (« vider ») une fiche collaborateur saisie deux fois (réversible), et agir sur une auto-évaluation de trois façons selon son état : l'<strong>Annuler</strong> (elle passe à <em>rejetée</em>), <strong>Retirer la revue</strong> (la revue du superviseur est retirée, le dossier revient à <em>soumise</em> tel que le collaborateur l'a déposé et repasse dans la file du relecteur) ou <strong>Demander une modification</strong> sur une auto-évaluation déjà <em>approuvée</em> (la validation et le verrou sont levés, elle revient au collaborateur). Chaque action exige un motif écrit et contourne volontairement la règle des quatre yeux — le contournement est étiqueté dans les Journaux système (catégorie <em>maintenance</em>), sur le fil des mouvements et dans la trace propre de l'enregistrement. Le profil de compétences officiel n'est jamais réécrit ici : un niveau promu reste jusqu'à ce qu'une nouvelle approbation le remplace."
            ),
            steps: [
                {
                    text: L(
                        'Find the record in its section (IDP/PIP, Self-assessments, 9-box, Employee record) and click the action that matches its state — the panel only offers what applies.',
                        "Trouvez l'enregistrement dans sa section (PDI/PIP, Auto-évaluations, 9-box, Fiche collaborateur) et cliquez sur l'action qui correspond à son état — le panneau ne propose que ce qui s'applique."
                    ),
                },
                {
                    text: L(
                        'Write the reason in the dialog. It is mandatory: it is the only thing that distinguishes maintenance from tampering for whoever reads the audit trail later.',
                        "Écrivez le motif dans la boîte de dialogue. Il est obligatoire : c'est la seule chose qui distingue une maintenance d'une manipulation pour qui lira la piste d'audit plus tard."
                    ),
                },
                {
                    text: L(
                        '<strong>Withdraw the review</strong> is for a review opened, sent back or rated by the wrong person; <strong>Request a change</strong> is for a rating that was approved on a wrong reading; <strong>Cancel</strong> is for an assessment that should not exist at all.',
                        "<strong>Retirer la revue</strong> sert à une revue ouverte, renvoyée ou notée par la mauvaise personne ; <strong>Demander une modification</strong> à une note approuvée sur une mauvaise lecture ; <strong>Annuler</strong> à une auto-évaluation qui n'aurait pas dû exister."
                    ),
                },
                {
                    text: L(
                        "Check the result where the users will see it: the movement feed, the supervisor's review queue, the employee's page. The <em>Recent maintenance actions</em> list at the bottom is your own trail.",
                        'Vérifiez le résultat là où les utilisateurs le verront : le fil des mouvements, la file de revue du superviseur, la page du collaborateur. La liste <em>Actions de maintenance récentes</em> en bas est votre propre trace.'
                    ),
                },
            ],
            practices: [
                L(
                    'Prefer the ordinary two-person cancellation queue for a live plan somebody disagrees with; keep this panel for data that is simply wrong.',
                    "Préférez la file de cancellation ordinaire à quatre yeux pour un plan vivant que quelqu'un conteste ; réservez ce panneau aux données simplement fausses."
                ),
                L(
                    'Voiding an employee record is not offboarding and not erasure: a leaver is deactivated from their record; a GDPR erasure is a separate, irreversible act under Data Management.',
                    "Vider une fiche collaborateur n'est ni un départ ni un effacement : un départ se traite depuis la fiche ; un effacement RGPD est un acte distinct et irréversible sous Gestion des données."
                ),
                L(
                    'A review under dispute or an assessment in arbitration is not touched here — resolve the dispute first; that ladder owns the decision.',
                    "Une revue contestée ou une auto-évaluation en arbitrage ne se touche pas ici — résolvez d'abord la contestation ; c'est cette échelle qui décide."
                ),
            ],
            value: L(
                'Bad data gets fixed in one click by the one accountable identity, and every fix is findable from three independent trails — nobody has to choose between a clean database and an honest audit.',
                "Une donnée fausse se corrige en un clic par l'identité responsable, et chaque correction se retrouve depuis trois traces indépendantes — personne n'a à choisir entre une base propre et un audit honnête."
            ),
        },

        '/account/sessions': {
            title: L('My Active Sessions (admin accounts)', 'Mes sessions actives (comptes admin)'),
            why: L(
                '<strong>Process:</strong> Every device/browser where YOUR admin account is currently signed in — with device, IP and last-activity time — and a "Sign out everywhere else" button. Session monitoring is an admin capability: SuperAdmins additionally get the platform-wide monitor at /admin/sessions. Non-admin users are still protected automatically: sessions expire on idle, and changing a password signs out every other device.',
                "<strong>Processus :</strong> chaque appareil/navigateur où VOTRE compte admin est actuellement connecté — avec appareil, IP et heure de dernière activité — et un bouton « Déconnecter partout ailleurs ». Le suivi des sessions est une capacité d'admin : les SuperAdmins disposent en plus du moniteur global à /admin/sessions. Les utilisateurs non-admin restent protégés automatiquement : les sessions expirent sur inactivité, et changer un mot de passe déconnecte tous les autres appareils."
            ),
            steps: [
                {
                    text: L(
                        "Review the list: the <strong>current session</strong> is marked; anything you don't recognise is a red flag.",
                        "Passez la liste en revue : la <strong>session en cours</strong> est marquée ; tout ce que vous ne reconnaissez pas est un signal d'alerte."
                    ),
                },
                {
                    text: L(
                        'Click <strong>Sign out everywhere else</strong> to revoke all other sessions instantly.',
                        'Cliquez sur <strong>Déconnecter partout ailleurs</strong> pour révoquer toutes les autres sessions instantanément.'
                    ),
                },
                {
                    text: L(
                        "If you saw a session you don't recognise, also <strong>change your password</strong> (account menu) — that revokes everything and locks the intruder out.",
                        "Si vous avez vu une session que vous ne reconnaissez pas, <strong>changez aussi votre mot de passe</strong> (menu du compte) — cela révoque tout et verrouille l'intrus dehors."
                    ),
                },
            ],
            practices: [
                L(
                    'Check this page after using a shared or public computer.',
                    'Vérifiez cette page après avoir utilisé un ordinateur partagé ou public.'
                ),
                L(
                    'Unknown session = change password immediately, then tell your administrator.',
                    'Session inconnue = changez le mot de passe immédiatement, puis prévenez votre administrateur.'
                ),
            ],
            value: L(
                'You can see and kill every login of your account yourself, in two clicks — no need to wait for an admin when something looks wrong.',
                'Vous pouvez voir et supprimer vous-même chaque connexion de votre compte, en deux clics — sans attendre un admin quand quelque chose cloche.'
            ),
        },

        '/benchmark/role/': {
            title: L(
                'Role Benchmark (Drill-Through & Succession)',
                'Référentiel de poste (détail & succession)'
            ),
            why: L(
                "<strong>Process:</strong> One role in full detail: every required skill (with the required level and criticality) crossed with every current occupant's actual level — who meets the benchmark, who has which gap — plus the <strong>succession view</strong>: the best-fitting candidates NOT currently in the role, ranked by how much of the benchmark they already meet. The fit-history trend shows whether the role's occupants are collectively closing the gap over time.",
                "<strong>Processus :</strong> un poste en détail complet : chaque compétence requise (avec le niveau requis et la criticité) croisée avec le niveau réel de chaque titulaire actuel — qui atteint le référentiel, qui a quel écart — plus la <strong>vue succession</strong> : les candidats les mieux adaptés PAS actuellement en poste, classés selon la part du référentiel qu'ils atteignent déjà. La tendance de l'historique d'adéquation montre si les titulaires du poste comblent collectivement l'écart dans le temps."
            ),
            steps: [
                {
                    text: L(
                        'Read the <strong>occupant columns</strong>: green = meets required level, amber/red = gap; the fit % summarises each person.',
                        "Lisez les <strong>colonnes des titulaires</strong> : vert = atteint le niveau requis, orange/rouge = écart ; le % d'adéquation résume chaque personne."
                    ),
                },
                {
                    text: L(
                        'Check <strong>critical skills first</strong> — one missing critical skill matters more than three minor gaps.',
                        "Vérifiez d'abord les <strong>compétences critiques</strong> — une compétence critique manquante compte plus que trois écarts mineurs."
                    ),
                },
                {
                    text: L(
                        'Open the <strong>succession/candidates table</strong> to see who else could hold this role and what exactly they lack.',
                        "Ouvrez la <strong>table succession/candidats</strong> pour voir qui d'autre pourrait occuper ce poste et ce qui leur manque exactement."
                    ),
                },
                {
                    text: L(
                        "Turn a candidate's missing skills into an <strong>IDP</strong> — that is the succession plan in action.",
                        "Transformez les compétences manquantes d'un candidat en un <strong>PDI</strong> — c'est le plan de succession en action."
                    ),
                },
                {
                    text: L(
                        'Watch the <strong>trend chart</strong> after each assessment cycle to verify development is actually raising fit.',
                        "Suivez le <strong>graphique de tendance</strong> après chaque cycle d'évaluation pour vérifier que le développement relève réellement l'adéquation."
                    ),
                },
            ],
            practices: [
                L(
                    'Keep required levels honest — an inflated benchmark makes everyone look unready and hides real risk.',
                    'Gardez des niveaux requis honnêtes — un référentiel gonflé fait paraître tout le monde non prêt et masque le vrai risque.'
                ),
                L(
                    'For critical roles, aim for at least one "ready-now" candidate outside the current occupants.',
                    'Pour les postes critiques, visez au moins un candidat « prêt maintenant » en dehors des titulaires actuels.'
                ),
            ],
            value: L(
                'This is where staffing decisions get made on evidence: promote, develop, or hire — each backed by the exact skill delta instead of gut feel.',
                "C'est ici que les décisions de dotation se prennent sur preuves : promouvoir, développer ou recruter — chacune appuyée par l'écart de compétence exact plutôt que par l'intuition."
            ),
        },

        '/supervisor/gap-analysis': {
            title: L('Team Gap Analysis', "Analyse des écarts d'équipe"),
            why: L(
                '<strong>Process:</strong> The distribution of skill gaps across your team — per person and per skill — where a gap = required level (from the role) minus current level. It answers "where do I spend my limited training budget/time first?".',
                '<strong>Processus :</strong> la répartition des écarts de compétence dans votre équipe — par personne et par compétence — où un écart = niveau requis (du poste) moins niveau actuel. Il répond à « où dépenser en premier mon budget/temps de formation limité ? ».'
            ),
            steps: [
                {
                    text: L(
                        'Sort by <strong>largest or most critical gaps</strong> — criticals first, always.',
                        "Triez par <strong>écarts les plus grands ou les plus critiques</strong> — les critiques d'abord, toujours."
                    ),
                },
                {
                    text: L(
                        'Distinguish <strong>one person behind</strong> (coach them) from <strong>everyone behind</strong> (train the team / adjust the requirement).',
                        "Distinguez <strong>une personne en retard</strong> (à coacher) de <strong>tout le monde en retard</strong> (former l'équipe / ajuster l'exigence)."
                    ),
                },
                {
                    text: L(
                        'Act on it: open a <strong>coaching plan</strong>, an <strong>IDP</strong>, or assign an <strong>LMS course</strong> mapped to the gapped skill.',
                        'Agissez : ouvrez un <strong>plan de coaching</strong>, un <strong>PDI</strong>, ou assignez un <strong>cours LMS</strong> mappé à la compétence en écart.'
                    ),
                },
            ],
            practices: [
                L(
                    'A gap on a skill nobody has assessed recently may be stale — re-assess before investing in training.',
                    "Un écart sur une compétence que personne n'a évaluée récemment peut être périmé — réévaluez avant d'investir dans la formation."
                ),
                L(
                    'If the whole team "fails" one requirement, question the requirement with the role owner before questioning the team.',
                    "Si toute l'équipe « échoue » sur une exigence, remettez en question l'exigence avec le propriétaire du poste avant de remettre en question l'équipe."
                ),
            ],
            value: L(
                'Converts a wall of assessment data into a short, prioritised list of who needs what — the starting point of every development conversation.',
                "Convertit un mur de données d'évaluation en une courte liste priorisée de qui a besoin de quoi — le point de départ de chaque conversation de développement."
            ),
        },

        '/supervisor/dashboard': {
            title: L('My Team (Supervisor Home)', 'Mon équipe (accueil superviseur)'),
            why: L(
                '<strong>Process:</strong> Your landing page as a supervisor/manager: your team roster with each person\'s readiness, pending self-assessment reviews waiting on you, and shortcuts into reviews, gap analysis and coaching. It is the "what needs me today?" page.',
                "<strong>Processus :</strong> votre page d'accueil de superviseur/manager : la liste de votre équipe avec la préparation de chacun, les revues d'auto-évaluation en attente de vous, et des raccourcis vers les revues, l'analyse des écarts et le coaching. C'est la page « qu'attend-on de moi aujourd'hui ? »."
            ),
            steps: [
                {
                    text: L(
                        'Check <strong>pending reviews</strong> first — people are waiting on your approval to make their level official.',
                        "Vérifiez d'abord les <strong>revues en attente</strong> — des personnes attendent votre approbation pour officialiser leur niveau."
                    ),
                },
                {
                    text: L(
                        'Scan team <strong>readiness</strong>: anyone sliding down gets a conversation before it becomes a PIP.',
                        "Parcourez la <strong>préparation</strong> de l'équipe : quiconque décline mérite une conversation avant que cela ne devienne un PIP."
                    ),
                },
                {
                    text: L(
                        "Use the shortcuts to jump into <strong>SA Reviews</strong>, <strong>Gap analysis</strong> or a person's profile.",
                        "Utilisez les raccourcis pour accéder aux <strong>Revues d'auto-évaluation</strong>, à l'<strong>Analyse des écarts</strong> ou à la fiche d'une personne."
                    ),
                },
            ],
            practices: [
                L(
                    'Clear your review queue within a few days — a stale queue stalls the whole assessment cycle for your team.',
                    "Videz votre file de revue en quelques jours — une file en retard bloque tout le cycle d'évaluation de votre équipe."
                ),
                L(
                    'If you receive the weekly digest email, treat this page as the deep-dive behind that summary.',
                    "Si vous recevez la synthèse hebdomadaire par e-mail, considérez cette page comme l'approfondissement de ce résumé."
                ),
            ],
            value: L(
                'One glance tells you what your team needs from you today, so nothing waits silently in a queue.',
                "Un coup d'œil vous dit ce que votre équipe attend de vous aujourd'hui, pour que rien n'attende en silence dans une file."
            ),
        },

        '/employees/:id': {
            title: L('Employee Profile', 'Fiche collaborateur'),
            why: L(
                '<strong>Process:</strong> The complete file on one person: identity and placement (site/department/service, role, supervisor), readiness against their role, current skill levels, and the action buttons that start every people-process — Assess, History, Development, Timeline, Edit. Everything a manager decides about a person starts from this page.',
                "<strong>Processus :</strong> le dossier complet d'une personne : identité et placement (site/département/service, poste, superviseur), préparation face à son poste, niveaux de compétence actuels, et les boutons d'action qui lancent chaque processus RH — Évaluer, Historique, Développement, Chronologie, Modifier. Tout ce qu'un manager décide au sujet d'une personne part de cette page."
            ),
            steps: [
                {
                    text: L(
                        'Read the header: <strong>role, placement, readiness %</strong> — the one-line answer to "where does this person stand?".',
                        "Lisez l'en-tête : <strong>poste, placement, % de préparation</strong> — la réponse en une ligne à « où en est cette personne ? »."
                    ),
                },
                {
                    text: L(
                        '<strong>Assess</strong> opens the skill matrix to record levels; <strong>History</strong> shows how each skill evolved; <strong>Development</strong> shows triggered recommendations; <strong>Timeline</strong> shows their milestones.',
                        "<strong>Évaluer</strong> ouvre la matrice de compétences pour enregistrer les niveaux ; <strong>Historique</strong> montre l'évolution de chaque compétence ; <strong>Développement</strong> montre les recommandations déclenchées ; <strong>Chronologie</strong> montre ses jalons."
                    ),
                },
                {
                    text: L(
                        '<strong>Edit</strong> (with the edit-employees permission) updates placement, role, supervisor, credentials — and nationality when the Local Content module is on.',
                        '<strong>Modifier</strong> (avec la permission modifier-les-collaborateurs) met à jour placement, poste, superviseur, identifiants — et la nationalité quand le module Contenu local est activé.'
                    ),
                },
                {
                    text: L(
                        'The <strong>Access & Identity</strong> panel (manage-admins permission) shows how this person signs in — linked SSO identities and password sign-in. You can link/remove an SSO identity, disable the local password (SSO-only), or <strong>grant/revoke admin</strong>. Granting admin does not move the SSO identity: it stays on the person, who then chooses « continue as administrator » after SSO (a super administrator must have confirmed the identity; a second factor is always required). A super administrator never signs in through SSO.',
                        "Le panneau <strong>Accès & identité</strong> (permission gérer-les-admins) montre comment cette personne se connecte — identités SSO liées et connexion par mot de passe. Vous pouvez lier/retirer une identité SSO, désactiver le mot de passe local (SSO uniquement), ou <strong>accorder/révoquer le statut admin</strong>. Accorder le statut admin ne déplace pas l'identité SSO : elle reste sur la personne, qui choisit ensuite « continuer en tant qu'administrateur » après le SSO (un super administrateur doit avoir confirmé l'identité ; un second facteur est toujours exigé). Un super administrateur ne se connecte jamais par SSO."
                    ),
                },
                {
                    text: L(
                        'From here, open their <strong>Goals & OKRs</strong> and <strong>Check-ins</strong> tabs to run the ongoing conversation.',
                        'Depuis ici, ouvrez ses onglets <strong>Objectifs & OKR</strong> et <strong>Points</strong> pour mener la conversation continue.'
                    ),
                },
            ],
            practices: [
                L(
                    'Keep placement and supervisor accurate — RBAC scope, review queues and the digest all depend on them.',
                    'Gardez placement et superviseur exacts — le périmètre des droits, les files de revue et la synthèse en dépendent tous.'
                ),
                L(
                    'Before a 1-on-1, open this page: readiness + history + timeline is the whole story in three clicks.',
                    "Avant un entretien individuel, ouvrez cette page : préparation + historique + chronologie, c'est toute l'histoire en trois clics."
                ),
                L(
                    'Prefer linking an existing account over creating a new one: if someone already signs in with a password and later gets SSO, link the SSO identity in Access & Identity instead of creating a second profile.',
                    "Préférez lier un compte existant plutôt qu'en créer un nouveau : si quelqu'un se connecte déjà avec un mot de passe et obtient ensuite le SSO, liez l'identité SSO dans Accès & identité au lieu de créer un second profil."
                ),
            ],
            value: L(
                'One page per person that answers "where do they stand, how did they get here, what happens next" — plus how they sign in and whether they hold admin — no spreadsheet archaeology.',
                'Une page par personne qui répond à « où en est-elle, comment en est-elle arrivée là, que se passe-t-il ensuite » — plus comment elle se connecte et si elle détient le statut admin — sans archéologie de tableur.'
            ),
        },

        '/employees/:id/assessments': {
            title: L(
                'Assess an Employee (Skill Matrix)',
                'Évaluer un collaborateur (matrice de compétences)'
            ),
            why: L(
                "<strong>Process:</strong> Record a person's OFFICIAL skill levels directly — the admin/supervisor-driven alternative to the self-assessment cycle. Skills are grouped by pillar → sub-domain; each cell takes a 0–4 level (0 None · 1 Basic Awareness · 2 Guided · 3 Autonomous · 4 Expert). Requires the manage-assessments permission; every change is audited with source and date.",
                "<strong>Processus :</strong> enregistrez directement les niveaux de compétence OFFICIELS d'une personne — l'alternative pilotée par l'admin/superviseur au cycle d'auto-évaluation. Les compétences sont groupées par pilier → sous-domaine ; chaque cellule prend un niveau 0–4 (0 Aucun · 1 Sensibilisation · 2 Encadré · 3 Autonome · 4 Expert). Requiert la permission gérer-les-évaluations ; chaque changement est audité avec source et date."
            ),
            steps: [
                {
                    text: L(
                        'Rate <strong>only the skills you can actually judge</strong> — leave the rest unassessed rather than guessing a 2.',
                        'Évaluez <strong>uniquement les compétences que vous pouvez réellement juger</strong> — laissez le reste non évalué plutôt que de deviner un 2.'
                    ),
                },
                {
                    text: L(
                        'Use the scale honestly: <strong>3 (Autonomous)</strong> means they do it unaided; <strong>4 (Expert)</strong> means they teach it. Most competent people are 3, not 4.',
                        "Utilisez l'échelle honnêtement : <strong>3 (Autonome)</strong> signifie qu'elle le fait sans aide ; <strong>4 (Expert)</strong> signifie qu'elle l'enseigne. La plupart des personnes compétentes sont à 3, pas à 4."
                    ),
                },
                {
                    text: L(
                        'Focus first on the skills <strong>required by their role</strong> — those drive readiness, gaps and benchmark fit.',
                        "Concentrez-vous d'abord sur les compétences <strong>requises par leur poste</strong> — ce sont elles qui pilotent préparation, écarts et adéquation au référentiel."
                    ),
                },
                {
                    text: L(
                        '<strong>Save</strong> — levels apply immediately; the change lands in the history with you as the source.',
                        "<strong>Enregistrez</strong> — les niveaux s'appliquent immédiatement ; le changement entre dans l'historique avec vous comme source."
                    ),
                },
            ],
            practices: [
                L(
                    'Prefer the self-assessment cycle for breadth (the person + supervisor agree); use direct assessment for baselines, corrections and new joiners.',
                    "Préférez le cycle d'auto-évaluation pour la couverture (la personne + le superviseur s'accordent) ; utilisez l'évaluation directe pour les bases, les corrections et les nouveaux arrivants."
                ),
                L(
                    'Rate against the definition, not against the team average — calibrated levels are what make cross-team analytics meaningful.',
                    "Évaluez par rapport à la définition, pas à la moyenne de l'équipe — des niveaux calibrés sont ce qui rend l'analytique inter-équipes parlante."
                ),
                L(
                    'Never leave a critical role-required skill unassessed: unassessed reads as unknown risk on every dashboard.',
                    'Ne laissez jamais non évaluée une compétence critique requise par le poste : non évaluée se lit comme un risque inconnu sur chaque tableau de bord.'
                ),
            ],
            value: L(
                'Accurate, honest levels here are the raw material of EVERYTHING else — readiness, gaps, benchmark, 9-box context, succession. Garbage in, garbage everywhere.',
                'Des niveaux justes et honnêtes ici sont la matière première de TOUT le reste — préparation, écarts, référentiel, contexte 9-box, succession. Données erronées en entrée, erreurs partout.'
            ),
        },

        '/employees/:id/assessments/history': {
            title: L(
                'Assessment History (Skill Evolution)',
                "Historique d'évaluation (évolution des compétences)"
            ),
            why: L(
                "<strong>Process:</strong> How each of this person's skills changed over time — every rating with its date, source (self-assessment, supervisor review, direct assessment, LMS completion) and the reviewer. This is the audit trail behind the current levels and the evidence that development is (or isn't) working.",
                "<strong>Processus :</strong> comment chacune des compétences de cette personne a évolué dans le temps — chaque note avec sa date, sa source (auto-évaluation, revue de superviseur, évaluation directe, achèvement LMS) et l'évaluateur. C'est la piste d'audit derrière les niveaux actuels et la preuve que le développement fonctionne (ou non)."
            ),
            steps: [
                {
                    text: L(
                        'Pick a skill to see its <strong>full timeline</strong> — each point is one recorded rating with its source.',
                        'Choisissez une compétence pour voir sa <strong>chronologie complète</strong> — chaque point est une note enregistrée avec sa source.'
                    ),
                },
                {
                    text: L(
                        'Check the <strong>source mix</strong>: a level backed by a supervisor review carries more weight than a lone self-rating.',
                        "Vérifiez la <strong>composition des sources</strong> : un niveau appuyé par une revue de superviseur pèse plus qu'une auto-note isolée."
                    ),
                },
                {
                    text: L(
                        "Flat lines on gapped skills = development isn't landing; investigate the IDP/coaching for that skill.",
                        'Des courbes plates sur des compétences en écart = le développement ne prend pas ; examinez le PDI/coaching de cette compétence.'
                    ),
                },
            ],
            practices: [
                L(
                    'Review history before overriding a level — you may be undoing a supervisor-approved rating.',
                    "Consultez l'historique avant de forcer un niveau — vous pourriez défaire une note approuvée par un superviseur."
                ),
                L(
                    'Use rising trends in performance conversations: "your SQL went 1→2→3 in a year" beats vague praise.',
                    "Utilisez les tendances à la hausse dans les conversations de performance : « votre SQL est passé de 1→2→3 en un an » vaut mieux qu'un éloge vague."
                ),
            ],
            value: L(
                'Turns skill data from a snapshot into a story — proof of growth for the employee, proof of ROI for the training budget.',
                "Transforme les données de compétence d'un instantané en une histoire — preuve de progression pour le collaborateur, preuve de ROI pour le budget de formation."
            ),
        },

        '/employees/:id/development': {
            title: L(
                'Development View (Triggers & Recommendations)',
                'Vue développement (déclencheurs & recommandations)'
            ),
            why: L(
                '<strong>Process:</strong> The platform\'s recommendations for this person, derived from their gaps: which skills to develop next, the triggers fired by 9-box placements, and links to open the corresponding IDP or coaching plan. It is the bridge between "here are the gaps" and "here is the plan".',
                "<strong>Processus :</strong> les recommandations de la plateforme pour cette personne, dérivées de ses écarts : quelles compétences développer ensuite, les déclencheurs activés par les positionnements 9-box, et des liens pour ouvrir le PDI ou le plan de coaching correspondant. C'est le pont entre « voici les écarts » et « voici le plan »."
            ),
            steps: [
                {
                    text: L(
                        'Read the <strong>prioritised gap list</strong> — critical role-required skills first.',
                        "Lisez la <strong>liste priorisée des écarts</strong> — les compétences critiques requises par le poste d'abord."
                    ),
                },
                {
                    text: L(
                        'Check <strong>active triggers</strong> (e.g. a red 9-box auto-created a PIP+coaching; a blue one proposed an IDP).',
                        'Vérifiez les <strong>déclencheurs actifs</strong> (p. ex. un 9-box rouge a créé automatiquement un PIP+coaching ; un bleu a proposé un PDI).'
                    ),
                },
                {
                    text: L(
                        'Act: open or update the <strong>IDP</strong>, assign a mapped <strong>LMS course</strong>, or start <strong>coaching</strong> for the top gap.',
                        "Agissez : ouvrez ou mettez à jour le <strong>PDI</strong>, assignez un <strong>cours LMS</strong> mappé, ou démarrez un <strong>coaching</strong> pour l'écart prioritaire."
                    ),
                },
            ],
            practices: [
                L(
                    'Pick 2–3 development priorities, not ten — focus is what closes gaps.',
                    "Choisissez 2 à 3 priorités de développement, pas dix — c'est la concentration qui comble les écarts."
                ),
                L(
                    "Re-visit after each assessment cycle: closed gaps should disappear; if they don't, the plan needs changing.",
                    "Repassez après chaque cycle d'évaluation : les écarts comblés doivent disparaître ; sinon, le plan doit changer."
                ),
            ],
            value: L(
                'Every recommendation is traceable to a real gap against a real role requirement — development spending lands where it changes readiness.',
                "Chaque recommandation est traçable jusqu'à un vrai écart face à une vraie exigence de poste — la dépense de développement atterrit là où elle change la préparation."
            ),
        },

        '/employees/:id/timeline': {
            title: L('Employee Timeline', 'Chronologie du collaborateur'),
            why: L(
                '<strong>Process:</strong> The person\'s milestones in one stream: assessments, reviews, 9-box placements, IDPs/PIPs opened and closed, lifecycle events (joiner/mover), coaching sessions. The chronological answer to "what happened with this person?".',
                "<strong>Processus :</strong> les jalons de la personne dans un seul flux : évaluations, revues, positionnements 9-box, PDI/PIP ouverts et clôturés, événements de cycle de vie (arrivée/mobilité), séances de coaching. La réponse chronologique à « que s'est-il passé avec cette personne ? »."
            ),
            steps: [
                {
                    text: L(
                        "Scan top-down for the <strong>recent quarter</strong> — that's the context for today's conversation.",
                        "Parcourez de haut en bas le <strong>trimestre récent</strong> — c'est le contexte de la conversation d'aujourd'hui."
                    ),
                },
                {
                    text: L(
                        'Cross-check big changes (role move, new supervisor) against skill trends — transitions explain dips.',
                        'Recoupez les grands changements (mobilité, nouveau superviseur) avec les tendances de compétence — les transitions expliquent les creux.'
                    ),
                },
            ],
            practices: [
                L(
                    'Open the timeline before promotion/PIP discussions — decisions read differently with the full sequence in view.',
                    'Ouvrez la chronologie avant les discussions de promotion/PIP — les décisions se lisent différemment avec toute la séquence sous les yeux.'
                ),
            ],
            value: L(
                'Institutional memory per person: new managers inherit the story, not just the current numbers.',
                "Mémoire institutionnelle par personne : les nouveaux managers héritent de l'histoire, pas seulement des chiffres actuels."
            ),
        },

        '/roles/:id': {
            title: L('Role Detail — Requirements Editor', "Détail du poste — éditeur d'exigences"),
            why: L(
                '<strong>Process:</strong> Where a role\'s <em>benchmark</em> is defined: the list of skills the role requires, each with a required level (1–4) and an optional <strong>critical</strong> flag. These requirements ARE the definition of "ready" — readiness %, gaps, benchmark fit, career paths and succession all compute against them. The page also shows current occupants and their readiness stats.',
                "<strong>Processus :</strong> là où le <em>référentiel</em> d'un poste se définit : la liste des compétences requises par le poste, chacune avec un niveau requis (1–4) et un indicateur <strong>critique</strong> facultatif. Ces exigences SONT la définition de « prêt » — % de préparation, écarts, adéquation au référentiel, parcours de carrière et succession se calculent tous par rapport à elles. La page montre aussi les titulaires actuels et leurs statistiques de préparation."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Add a requirement:</strong> pick the skill, set the <strong>required level</strong> (1 Basic Awareness → 4 Expert), tick <strong>Critical</strong> if the role fails without it.',
                        '<strong>Ajoutez une exigence :</strong> choisissez la compétence, réglez le <strong>niveau requis</strong> (1 Sensibilisation → 4 Expert), cochez <strong>Critique</strong> si le poste échoue sans elle.'
                    ),
                },
                {
                    text: L(
                        "Set levels for <strong>what the job actually needs</strong>, not the best incumbent's profile — requirement inflation makes everyone look unready.",
                        "Fixez les niveaux pour <strong>ce dont le poste a réellement besoin</strong>, pas le profil du meilleur titulaire — l'inflation des exigences fait paraître tout le monde non prêt."
                    ),
                },
                {
                    text: L(
                        'Mark <strong>critical</strong> sparingly: safety-critical, licence-to-operate, single-point-of-failure skills. If everything is critical, nothing is.',
                        "Marquez <strong>critique</strong> avec parcimonie : compétences critiques pour la sécurité, la licence d'exploitation, les points de défaillance uniques. Si tout est critique, rien ne l'est."
                    ),
                },
                {
                    text: L(
                        'Adjust or remove requirements any time — all downstream numbers recompute automatically.',
                        'Ajustez ou retirez les exigences à tout moment — tous les chiffres en aval se recalculent automatiquement.'
                    ),
                },
                {
                    text: L(
                        'Check the <strong>occupant readiness stats</strong> at the top after editing: a sudden org-wide readiness drop usually means an over-ambitious requirement, not a skills collapse.',
                        "Vérifiez les <strong>statistiques de préparation des titulaires</strong> en haut après modification : une chute soudaine de préparation à l'échelle de l'organisation signifie généralement une exigence trop ambitieuse, pas un effondrement des compétences."
                    ),
                },
            ],
            practices: [
                L(
                    "Define requirements WITH the role's operational owner — the platform computes, the business defines.",
                    'Définissez les exigences AVEC le propriétaire opérationnel du poste — la plateforme calcule, le métier définit.'
                ),
                L(
                    'Review requirements yearly and when the role genuinely changes; stale benchmarks quietly corrupt every metric.',
                    'Revoyez les exigences chaque année et quand le poste change réellement ; des référentiels périmés corrompent silencieusement chaque indicateur.'
                ),
                L(
                    '10–25 required skills per role is the useful range; 60 requirements is a job description, not a benchmark.',
                    "10 à 25 compétences requises par poste est la plage utile ; 60 exigences, c'est une fiche de poste, pas un référentiel."
                ),
            ],
            value: L(
                'Well-set requirements turn every dashboard from decoration into a decision tool — this page is where that quality is won or lost.',
                "Des exigences bien réglées transforment chaque tableau de bord d'une décoration en un outil de décision — c'est sur cette page que cette qualité se gagne ou se perd."
            ),
        },

        '/employees/create': {
            title: L('Create / Edit an Employee', 'Créer / modifier un collaborateur'),
            why: L(
                '<strong>Process:</strong> The employee record that everything else hangs off: identity, employee number, <strong>placement</strong> (site → department → service), <strong>role</strong> (drives their benchmark), <strong>supervisor and manager</strong> (drives review queues, RBAC scope and the digest), optional account credentials for self-service login — and <strong>nationality</strong> when the Local Content module is enabled.',
                '<strong>Processus :</strong> la fiche collaborateur à laquelle tout le reste se rattache : identité, matricule, <strong>placement</strong> (site → département → service), <strong>poste</strong> (pilote son référentiel), <strong>superviseur et manager</strong> (pilotent les files de revue, le périmètre des droits et la synthèse), identifiants de compte facultatifs pour la connexion en libre-service — et <strong>nationalité</strong> quand le module Contenu local est activé.'
            ),
            steps: [
                {
                    text: L(
                        'Fill identity + <strong>placement</strong>: the site/department/service determine which admins and managers can see this person.',
                        'Remplissez identité + <strong>placement</strong> : le site/département/service déterminent quels admins et managers peuvent voir cette personne.'
                    ),
                },
                {
                    text: L(
                        "Pick the <strong>role</strong> — from that moment the person is measured against that role's required skills.",
                        'Choisissez le <strong>poste</strong> — dès cet instant la personne est mesurée par rapport aux compétences requises de ce poste.'
                    ),
                },
                {
                    text: L(
                        'Set <strong>supervisor</strong> (reviews their self-assessments) and, where used, the <strong>manager</strong>.',
                        'Définissez le <strong>superviseur</strong> (qui examine ses auto-évaluations) et, le cas échéant, le <strong>manager</strong>.'
                    ),
                },
                {
                    text: L(
                        'Optionally set a <strong>username/password</strong> (or let them self-register later); the account can also be activated afterwards.',
                        "Définissez éventuellement un <strong>identifiant/mot de passe</strong> (ou laissez la personne s'inscrire plus tard) ; le compte peut aussi être activé après coup."
                    ),
                },
                {
                    text: L(
                        '<strong>Save</strong>, then open their profile and record a first assessment so they appear in analytics.',
                        "<strong>Enregistrez</strong>, puis ouvrez sa fiche et consignez une première évaluation pour qu'elle apparaisse dans l'analytique."
                    ),
                },
            ],
            practices: [
                L(
                    'For more than ~10 people, use the Excel import in Data Management instead of this form.',
                    "Pour plus d'une dizaine de personnes, utilisez l'import Excel de la Gestion des données plutôt que ce formulaire."
                ),
                L(
                    'A person without a role is invisible to readiness/benchmark — always assign one.',
                    'Une personne sans poste est invisible pour la préparation/le référentiel — assignez-en toujours un.'
                ),
                L(
                    'Update placement on transfer the same week; stale placement leaks visibility to the wrong managers.',
                    "Mettez à jour le placement lors d'une mutation la semaine même ; un placement périmé laisse fuir la visibilité vers les mauvais managers."
                ),
            ],
            value: L(
                'Accurate placement + role + supervisor here is what makes security scoping, review routing and every analytic correct downstream.',
                "Un placement + poste + superviseur justes ici sont ce qui rend corrects, en aval, le périmétrage de sécurité, l'acheminement des revues et chaque analytique."
            ),
        },

        '/reports/readiness': {
            title: L(
                'Readiness Report (ready-made view)',
                "Rapport de préparation (vue prête à l'emploi)"
            ),
            why: L(
                '<strong>Process:</strong> The pre-built answer to "who is ready for their role?" — readiness % per person/role against the threshold set in Settings, with the distribution across the population. No configuration needed; for custom columns use the Report Builder.',
                '<strong>Processus :</strong> la réponse préconstruite à « qui est prêt pour son poste ? » — % de préparation par personne/poste face au seuil défini dans les Paramètres, avec la répartition sur la population. Aucune configuration requise ; pour des colonnes personnalisées, utilisez le Générateur de rapports.'
            ),
            steps: [
                {
                    text: L(
                        'Filter to your <strong>site/department</strong>, read the distribution, then the individuals below the bar.',
                        'Filtrez sur votre <strong>site/département</strong>, lisez la répartition, puis les individus sous la barre.'
                    ),
                },
                {
                    text: L(
                        'For each low-readiness person, jump to their profile → <strong>Development</strong> to see the plan (or the absence of one).',
                        'Pour chaque personne à faible préparation, allez à sa fiche → <strong>Développement</strong> pour voir le plan (ou son absence).'
                    ),
                },
                {
                    text: L(
                        '<strong>Export</strong> for the management review pack.',
                        '<strong>Exportez</strong> pour le dossier de revue de direction.'
                    ),
                },
            ],
            practices: [
                L(
                    'Readiness moves after assessment cycles — date your exports so period-over-period comparisons are honest.',
                    "La préparation bouge après les cycles d'évaluation — datez vos exports pour que les comparaisons d'une période à l'autre soient honnêtes."
                ),
            ],
            value: L(
                'The single number leadership asks for, computed the same way every time.',
                'Le chiffre unique que réclame la direction, calculé de la même façon à chaque fois.'
            ),
        },

        '/reports/gaps': {
            title: L('Gaps Report (ready-made view)', "Rapport des écarts (vue prête à l'emploi)"),
            why: L(
                '<strong>Process:</strong> The pre-built skill-gap listing: every person × role-required skill where current level < required level, with criticality. It is the org-wide training shopping list.',
                "<strong>Processus :</strong> la liste préconstruite des écarts de compétence : chaque personne × compétence requise par le poste où niveau actuel < niveau requis, avec la criticité. C'est la liste de courses de formation à l'échelle de l'organisation."
            ),
            steps: [
                {
                    text: L(
                        'Sort by <strong>critical</strong> first, then by gap size.',
                        "Triez par <strong>critique</strong> d'abord, puis par taille d'écart."
                    ),
                },
                {
                    text: L(
                        'Group mentally by skill: many people short on ONE skill = organise a course; one person short on many = coach that person.',
                        'Regroupez mentalement par compétence : beaucoup de personnes en manque sur UNE compétence = organisez un cours ; une personne en manque sur plusieurs = coachez cette personne.'
                    ),
                },
                {
                    text: L(
                        '<strong>Export</strong> and hand the top items to the training plan.',
                        '<strong>Exportez</strong> et transmettez les éléments prioritaires au plan de formation.'
                    ),
                },
            ],
            practices: [
                L(
                    'Re-run after every cycle and compare: the gap list shrinking is the truest measure that development works.',
                    "Relancez après chaque cycle et comparez : une liste d'écarts qui rétrécit est la mesure la plus vraie que le développement fonctionne."
                ),
            ],
            value: L(
                'Training budgets aimed at measured gaps instead of habit — and the evidence trail to defend them.',
                "Des budgets de formation dirigés vers des écarts mesurés plutôt que vers l'habitude — et la trace probante pour les défendre."
            ),
        },

        '/employee/supervisor-reviews': {
            title: L('Your Review & Raising a Dispute', 'Votre revue & ouvrir un litige'),
            why: L(
                '<strong>Process:</strong> After your supervisor reviews your self-assessment, their rating and any recommendation appear here. If you disagree with a rated skill, you can raise a dispute during the open window — it escalates through a fair, time-boxed ladder (your supervisor → their manager → HR arbitration) so no disagreement is simply overruled.',
                "<strong>Processus :</strong> après que votre superviseur a examiné votre auto-évaluation, sa note et toute recommandation apparaissent ici. Si vous êtes en désaccord avec une compétence notée, vous pouvez ouvrir un litige pendant la fenêtre ouverte — il escalade via une échelle équitable et bornée dans le temps (votre superviseur → son manager → arbitrage RH) pour qu'aucun désaccord ne soit simplement écarté."
            ),
            steps: [
                {
                    text: L(
                        'Compare your <strong>self-rating</strong> with the <strong>supervisor rating</strong> for each skill — the gap is what a dispute is about.',
                        "Comparez votre <strong>auto-note</strong> à la <strong>note du superviseur</strong> pour chaque compétence — c'est l'écart qui fait l'objet d'un litige."
                    ),
                },
                {
                    text: L(
                        'To contest a skill, open the dispute and state your case with <strong>evidence</strong> (what you have delivered at that level). Be specific — evidence is what moves a level.',
                        'Pour contester une compétence, ouvrez le litige et exposez votre argumentaire avec des <strong>preuves</strong> (ce que vous avez livré à ce niveau). Soyez précis — ce sont les preuves qui font bouger un niveau.'
                    ),
                },
                {
                    text: L(
                        "Track the dispute's <strong>level and status</strong>. If it isn't resolved within the SLA it escalates automatically to the next level — you don't have to chase it.",
                        "Suivez le <strong>niveau et le statut</strong> du litige. S'il n'est pas résolu dans le SLA, il escalade automatiquement au niveau suivant — vous n'avez pas à le relancer."
                    ),
                },
                {
                    text: L(
                        'Once resolved (or auto-finalized), the agreed level becomes your official current level and the cycle can close.',
                        'Une fois résolu (ou finalisé automatiquement), le niveau convenu devient votre niveau actuel officiel et le cycle peut se clôturer.'
                    ),
                },
            ],
            practices: [
                L(
                    'Raise disputes early, inside the open window — a late dispute can miss the cycle close.',
                    'Ouvrez les litiges tôt, dans la fenêtre ouverte — un litige tardif peut manquer la clôture du cycle.'
                ),
                L(
                    "Lead with evidence, not opinion: “I ran X unaided across Y” beats “I think I'm better than that.”",
                    "Menez avec des preuves, pas des opinions : « j'ai réalisé X sans aide sur Y » vaut mieux que « je pense être meilleur que ça »."
                ),
            ],
            value: L(
                'A transparent, time-boxed way to be heard on your own ratings — disagreements get a fair hearing instead of being silently overruled.',
                "Un moyen transparent et borné dans le temps d'être entendu sur vos propres notes — les désaccords obtiennent une audience équitable au lieu d'être écartés en silence."
            ),
        },

        '/account': {
            title: L('My profile', 'Mon profil'),
            why: L(
                '<strong>Process:</strong> Your contact details — the e-mail address is where password-reset links are sent, so changing it asks for your current password. Everything organisational (role, site, manager) is shown read-only and managed by your administrator.',
                '<strong>Processus :</strong> vos coordonnées — l’adresse e-mail reçoit les liens de réinitialisation du mot de passe, c’est pourquoi la modifier demande votre mot de passe actuel. Tout ce qui est organisationnel (rôle, site, responsable) est affiché en lecture seule et géré par votre administrateur.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Update</strong> your e-mail or phone and save; enter your current password when the e-mail changes.',
                        '<strong>Modifiez</strong> votre e-mail ou votre téléphone puis enregistrez ; saisissez votre mot de passe actuel si l’e-mail change.'
                    ),
                },
                {
                    text: L(
                        '<strong>Manage</strong> notifications, password, two-factor authentication and active sessions from the account menu (top right).',
                        '<strong>Gérez</strong> notifications, mot de passe, double authentification et sessions actives depuis le menu du compte (en haut à droite).'
                    ),
                },
            ],
        },
        '/safety-gate': {
            title: L('Safety clearances', 'Habilitations sécurité'),
            why: L(
                '<strong>Process:</strong> Who may be rostered on a post right now. Each role lists its critical skills (minimum level, mandatory certificate); a person is CLEARED, EXPIRING (a certificate lapses soon) or BLOCKED — with the reason. A skill never assessed blocks as "not assessed", never as level 0.',
                '<strong>Processus :</strong> qui peut être affecté à un poste, maintenant. Chaque rôle liste ses compétences critiques (niveau minimum, certificat obligatoire) ; une personne est HABILITÉE, EN EXPIRATION (un certificat arrive à échéance) ou BLOQUÉE — avec la raison. Une compétence jamais évaluée bloque comme « non évaluée », jamais comme un niveau 0.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Configure</strong> the critical skills per role (and site if needed) in Configuration.',
                        '<strong>Configurez</strong> les compétences critiques par rôle (et par site si besoin) dans Configuration.'
                    ),
                },
                {
                    text: L(
                        '<strong>Review</strong> the blocked people and the certificates expiring soon, filtered by site and role.',
                        '<strong>Consultez</strong> les personnes bloquées et les certificats bientôt échus, filtrés par site et rôle.'
                    ),
                },
                {
                    text: L(
                        '<strong>Connect</strong> the access-control or permit-to-work system with an API key of scope safety.read (Admin › API keys), or a signed webhook.',
                        '<strong>Connectez</strong> le contrôle d’accès ou le permis de travail avec une clé API de portée safety.read (Admin › Clés API), ou un webhook signé.'
                    ),
                },
            ],
        },
        '/qualified': {
            title: L('Who Is Qualified', 'Qui est qualifié'),
            why: L(
                '<strong>Process:</strong> The operational "who can do this, right now?" lookup a supervisor needs — filter by a skill at a minimum level (and a valid certification where required), scoped to the people you govern.',
                '<strong>Processus :</strong> la recherche opérationnelle « qui peut faire ça, maintenant ? » dont un superviseur a besoin — filtrez par une compétence à un niveau minimum (et une certification valide si requise), limitée aux personnes que vous encadrez.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick a skill</strong> and a minimum level; add a certification/currency filter if the task requires it.',
                        "<strong>Choisissez une compétence</strong> et un niveau minimum ; ajoutez un filtre de certification/validité si la tâche l'exige."
                    ),
                },
                {
                    text: L(
                        '<strong>Read the list</strong> of people who qualify today, with their level and site.',
                        "<strong>Lisez la liste</strong> des personnes qualifiées aujourd'hui, avec leur niveau et leur site."
                    ),
                },
            ],
            practices: [
                L(
                    'Use it to staff a shift or a task from evidence, not memory.',
                    'Utilisez-la pour affecter une équipe ou une tâche sur preuve, pas de mémoire.'
                ),
            ],
            value: L(
                'Turns the competency database into a live dispatch tool — the question a supervisor actually asks, answered in seconds.',
                "Transforme la base de compétences en un outil d'affectation vivant — la question qu'un superviseur pose vraiment, répondue en quelques secondes."
            ),
        },

        '/cancellations': {
            title: L('Cancellations (approval queue)', "Annulations (file d'approbation)"),
            why: L(
                '<strong>Process:</strong> Cancelling a coaching/mentoring plan, a PIP or an IDP is a governed action: a manager requests it with a reason, and a different local admin approves it (two-person rule). Nothing is cancelled until approved.',
                "<strong>Processus :</strong> annuler un plan de coaching/mentorat, un PIP ou un PDI est une action gouvernée : un manager la demande avec un motif, et un autre admin local l'approuve (règle des deux personnes). Rien n'est annulé tant que ce n'est pas approuvé."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Managers</strong> request a cancellation from the plan (a reason is required).',
                        '<strong>Les managers</strong> demandent une annulation depuis le plan (un motif est obligatoire).'
                    ),
                },
                {
                    text: L(
                        '<strong>A local admin</strong> reviews the queue and approves or rejects — you cannot approve your own request.',
                        '<strong>Un admin local</strong> examine la file et approuve ou rejette — vous ne pouvez pas approuver votre propre demande.'
                    ),
                },
                {
                    text: L(
                        '<strong>Withdraw</strong> a pending request you raised if it is no longer needed.',
                        "<strong>Retirez</strong> une demande en attente que vous avez émise si elle n'est plus nécessaire."
                    ),
                },
            ],
            practices: [
                L(
                    'Always give a real reason — the approval trail is audited.',
                    "Donnez toujours un vrai motif — la trace d'approbation est auditée."
                ),
            ],
            value: L(
                'A defensible, two-person control over cancelling development plans — governance without blocking legitimate change.',
                "Un contrôle défendable à deux personnes sur l'annulation des plans de développement — de la gouvernance sans bloquer les changements légitimes."
            ),
        },

        '/movements': {
            title: L('Movement Trail', 'Journal des mouvements'),
            why: L(
                "<strong>Process:</strong> The chronological record of a person's moves — joiner, mover, leaver and role/placement changes — so the history of who moved where, and when, is never lost.",
                "<strong>Processus :</strong> l'enregistrement chronologique des mouvements d'une personne — arrivée, mobilité, départ et changements de poste/placement — pour que l'historique de qui a bougé où, et quand, ne soit jamais perdu."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Browse</strong> the movements, most recent first; filter by person or type.',
                        "<strong>Parcourez</strong> les mouvements, les plus récents d'abord ; filtrez par personne ou type."
                    ),
                },
            ],
            practices: [
                L(
                    'Cross-check a skill dip against a role move — transitions explain a lot.',
                    'Recoupez une baisse de compétence avec une mobilité — les transitions expliquent beaucoup.'
                ),
            ],
            value: L(
                'Institutional memory of workforce movement — context for every talent decision.',
                "La mémoire institutionnelle des mouvements d'effectif — le contexte de chaque décision talent."
            ),
        },

        '/reviews/post-approval': {
            title: L('Post-Approval Reviews', 'Revues post-approbation'),
            why: L(
                "<strong>Process:</strong> A second-look control: certain approved changes are re-reviewed after the fact, so an approval that shouldn't have happened is caught and can be revisited.",
                "<strong>Processus :</strong> un contrôle de second regard : certains changements approuvés sont réexaminés après coup, pour qu'une approbation qui n'aurait pas dû avoir lieu soit détectée et puisse être revue."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Review</strong> the flagged approved items and confirm or raise a concern.',
                        '<strong>Examinez</strong> les éléments approuvés signalés et confirmez ou soulevez une réserve.'
                    ),
                },
            ],
            practices: [
                L(
                    'Work it on a regular cadence so nothing sits unreviewed.',
                    'Traitez-la à une cadence régulière pour que rien ne reste non revu.'
                ),
            ],
            value: L(
                'Defence-in-depth on approvals — trust, but verify, with an audit trail.',
                "Défense en profondeur sur les approbations — faire confiance, mais vérifier, avec une piste d'audit."
            ),
        },

        '/admin/sso-migration': {
            title: L('SSO migration', 'Migration SSO'),
            why: L(
                "<strong>Process:</strong> Before switching the organisation to single sign-on, map every existing employee onto their directory identity, so their first SSO sign-in lands on <em>their</em> account — no duplicate, no onboarding request. Nothing is linked on the strength of the file alone: each mapping is claimed by the person's first signed sign-in.",
                "<strong>Processus :</strong> avant de basculer l'organisation en authentification unique, rattachez chaque salarié existant à son identité d'annuaire, pour qu'à sa première connexion SSO il retrouve <em>son</em> compte — sans doublon ni demande d'intégration. Rien n'est lié sur la foi du seul fichier : chaque rattachement est réclamé par la première connexion signée de la personne."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Export the directory</strong> (Entra → Users → Download users) and run the <em>dry run</em>: every row gets an outcome and its reason.',
                        "<strong>Exportez l'annuaire</strong> (Entra → Utilisateurs → Télécharger les utilisateurs) et lancez la <em>simulation</em> : chaque ligne reçoit un résultat et sa raison."
                    ),
                },
                {
                    text: L(
                        '<strong>Resolve</strong> the rows that need a decision by picking the employee, then re-run the dry run.',
                        '<strong>Tranchez</strong> les lignes à résoudre en choisissant le salarié, puis relancez la simulation.'
                    ),
                },
                {
                    text: L(
                        '<strong>Apply</strong> by typing the number of mappings; a batch can be undone while its mappings are unclaimed.',
                        '<strong>Appliquez</strong> en saisissant le nombre de rattachements ; un lot peut être annulé tant que ses rattachements ne sont pas réclamés.'
                    ),
                },
            ],
            practices: [
                L(
                    'Pilot with a few people first; once “Signed in via SSO” covers the population, plan the go-live in SSO settings (announcement 48 h before), then switch SSO on.',
                    'Faites un pilote avec quelques personnes ; quand « Déjà connectés via SSO » couvre la population, planifiez la mise en service dans Paramètres SSO (annonce 48 h avant), puis activez le SSO.'
                ),
                L(
                    'Administrators are out of scope: they keep password + two-factor sign-in.',
                    'Les administrateurs ne sont pas concernés : ils gardent la connexion par mot de passe + double authentification.'
                ),
            ],
            value: L(
                'A cut-over with no duplicate accounts and no one locked out.',
                'Une bascule sans compte en double et sans personne bloquée.'
            ),
        },

        '/admin/access-review': {
            title: L('Access Review', 'Revue des accès'),
            why: L(
                '<strong>Process:</strong> The periodic privileged-access review a security audit expects: every admin account with its role, scope, granted permissions, MFA-enrolment and last activity. Attesting an account records that a reviewer confirmed it — into the tamper-evident audit log.',
                "<strong>Processus :</strong> la revue périodique des accès privilégiés qu'attend un audit de sécurité : chaque compte admin avec son rôle, son périmètre, ses permissions, l'activation MFA et la dernière activité. Attester un compte enregistre qu'un relecteur l'a confirmé — dans le journal d'audit inviolable."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Scan the flags</strong>: accounts without MFA, stale (no recent activity) or inactive stand out.',
                        '<strong>Repérez les signaux</strong> : les comptes sans MFA, inactifs (aucune activité récente) ou désactivés ressortent.'
                    ),
                },
                {
                    text: L(
                        "<strong>Attest</strong> the accounts that are still appropriate; open <em>Manage</em> to fix the ones that aren't.",
                        '<strong>Attestez</strong> les comptes toujours appropriés ; ouvrez <em>Gérer</em> pour corriger les autres.'
                    ),
                },
                {
                    text: L(
                        '<strong>Export CSV</strong> as the evidence artefact for the audit.',
                        "<strong>Exportez en CSV</strong> comme pièce probante pour l'audit."
                    ),
                },
            ],
            practices: [
                L(
                    'Run it quarterly and after any departure; revoke on role change the same day.',
                    'Effectuez-la chaque trimestre et après chaque départ ; révoquez au changement de rôle le jour même.'
                ),
                L(
                    'Enrol MFA on every privileged account — the review makes the gaps obvious.',
                    'Activez la MFA sur chaque compte privilégié — la revue rend les manques évidents.'
                ),
            ],
            value: L(
                'The evidence a procurement/security review asks for first — who has privileged access, is it still justified, and who confirmed it.',
                "La preuve qu'une revue achats/sécurité demande en premier — qui détient un accès privilégié, est-il toujours justifié, et qui l'a confirmé."
            ),
        },

        '/admin/license': {
            title: L('License &amp; Entitlement', 'Licence &amp; droits'),
            why: L(
                '<strong>Process:</strong> This appliance is licensed to one customer. A seat = one active employee. You set the license (customer, seats, features, expiry); enforcement is soft — over-seat or expired only raises a banner, you are never locked out of your own data.',
                "<strong>Processus :</strong> cette instance est licenciée pour un seul client. Un siège = un collaborateur actif. Vous définissez la licence (client, sièges, fonctions, expiration) ; l'application est souple — un dépassement de sièges ou une expiration n'affiche qu'une bannière, vous n'êtes jamais bloqué hors de vos données."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read the status</strong>: seats used vs licensed, expiry, and enabled features.',
                        '<strong>Lisez le statut</strong> : sièges utilisés vs licenciés, expiration et fonctions activées.'
                    ),
                },
                {
                    text: L(
                        '<strong>Paste the license JSON</strong> and save; leave it empty to run unmanaged (unlimited).',
                        '<strong>Collez le JSON de licence</strong> et enregistrez ; laissez vide pour fonctionner en non gérée (illimité).'
                    ),
                },
                {
                    text: L(
                        'Optionally turn on the <strong>hard seat cap</strong> to refuse new employees beyond the licensed seats.',
                        'Activez éventuellement le <strong>plafond de sièges strict</strong> pour refuser les nouveaux collaborateurs au-delà des sièges licenciés.'
                    ),
                },
            ],
            practices: [
                L(
                    'Keep enforcement soft unless you truly need a hard cap — sovereignty means never locking the customer out.',
                    "Gardez l'application souple sauf besoin réel d'un plafond strict — la souveraineté, c'est ne jamais bloquer le client."
                ),
            ],
            value: L(
                'A clear, self-managed entitlement for the appliance model — no phone-home, no lock-in.',
                "Un droit d'usage clair et auto-géré pour le modèle par instance — sans appel externe, sans verrouillage."
            ),
        },

        '/admin/modules': {
            title: L('Modules &amp; adoption stage', 'Modules et étape d’adoption'),
            why: L(
                '<strong>Process:</strong> Choose how much of the platform your organisation uses. Stage 1 covers the skills framework, assessments, reviews, readiness, gaps, reports and campaigns; stage 2 adds development, talent and mobility; stage 3 adds engagement and the AI copilot. Custom lets you switch each module yourself.',
                '<strong>Processus :</strong> choisissez quelle part de la plateforme votre organisation utilise. L’étape 1 couvre le référentiel, les évaluations, les revues, la préparation, les écarts, les rapports et les campagnes ; l’étape 2 ajoute le développement, les talents et la mobilité ; l’étape 3 ajoute l’engagement et le copilote IA. Personnalisé vous laisse activer chaque module.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick a stage</strong> (or Custom and tick the modules you want).',
                        '<strong>Choisissez une étape</strong> (ou Personnalisé, puis cochez les modules voulus).'
                    ),
                },
                {
                    text: L(
                        '<strong>Read the preview</strong>: the menus that will appear or disappear for everyone.',
                        '<strong>Lisez l’aperçu</strong> : les menus qui apparaîtront ou disparaîtront pour tout le monde.'
                    ),
                },
                {
                    text: L(
                        '<strong>Save</strong>: the change applies on the next page, without a restart, and is recorded in the audit log.',
                        '<strong>Enregistrez</strong> : le changement s’applique dès la page suivante, sans redémarrage, et il est tracé dans le journal d’audit.'
                    ),
                },
            ],
            practices: [
                L(
                    'Start at stage 1 and move on once assessments run smoothly — switching a module off hides it but keeps its data.',
                    'Commencez à l’étape 1 et avancez quand les évaluations tournent bien — désactiver un module le masque mais conserve ses données.'
                ),
            ],
            value: L(
                'A first-time administrator sees only what the organisation is ready to use.',
                'Un administrateur qui débute ne voit que ce que l’organisation est prête à utiliser.'
            ),
        },

        '/employee/opportunities': {
            title: L('My Growth', 'Mon évolution'),
            why: L(
                '<strong>Process:</strong> Your personal growth hub — internal opportunities you can apply to, your mobility aspirations, open engagement surveys, and the recognition you have received.',
                "<strong>Processus :</strong> votre espace d'évolution — les opportunités internes auxquelles postuler, vos aspirations de mobilité, les enquêtes d'engagement ouvertes et les reconnaissances reçues."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Apply</strong> to an opportunity (add an optional note); withdraw any time while it is still undecided.',
                        "<strong>Postulez</strong> à une opportunité (note facultative) ; retirez votre candidature tant qu'elle n'est pas décidée."
                    ),
                },
                {
                    text: L(
                        '<strong>Set your aspirations</strong> so the right moves are suggested to you.',
                        "<strong>Renseignez vos aspirations</strong> pour qu'on vous propose les bons mouvements."
                    ),
                },
                {
                    text: L(
                        '<strong>Answer open surveys</strong> — anonymous ones are clearly tagged.',
                        '<strong>Répondez aux enquêtes ouvertes</strong> — celles anonymes sont clairement indiquées.'
                    ),
                },
            ],
            value: L(
                'One place to steer your own career and be seen for it.',
                'Un seul endroit pour piloter votre carrière et être reconnu(e).'
            ),
        },
        '/employee/okr': {
            title: L('My OKRs &amp; 1-on-1s', 'Mes OKR &amp; 1-à-1'),
            why: L(
                '<strong>Process:</strong> Your objectives and the record of your one-on-one conversations with your manager — what you are working toward and how it is going.',
                '<strong>Processus :</strong> vos objectifs et le suivi de vos entretiens individuels avec votre manager — ce que vous visez et où vous en êtes.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Review your objectives</strong> and keep progress current.',
                        '<strong>Consultez vos objectifs</strong> et tenez la progression à jour.'
                    ),
                },
                {
                    text: L(
                        '<strong>Prepare your 1-on-1</strong> using the shared notes.',
                        "<strong>Préparez votre 1-à-1</strong> à l'aide des notes partagées."
                    ),
                },
            ],
            value: L(
                'Clear objectives and regular conversations are what turn effort into recognized progress.',
                "Des objectifs clairs et des échanges réguliers transforment l'effort en progrès reconnu."
            ),
        },
        '/one-on-one': {
            title: L('One-to-ones', 'Entretiens individuels'),
            why: L(
                '<strong>Process:</strong> The space you share with your manager: a joint agenda for the next meeting, shared and private notes, and the actions you agree on.',
                '<strong>Processus :</strong> l’espace que vous partagez avec votre responsable : un ordre du jour commun pour le prochain entretien, des notes partagées et privées, et les actions convenues.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Add your topics</strong> before the meeting — the other person is notified.',
                        '<strong>Ajoutez vos sujets</strong> avant l’entretien — l’autre personne est prévenue.'
                    ),
                },
                {
                    text: L(
                        '<strong>Write shared notes</strong> for both of you, and <strong>private notes</strong> that only you can read.',
                        '<strong>Écrivez des notes partagées</strong> pour vous deux, et des <strong>notes privées</strong> que vous seul(e) pouvez lire.'
                    ),
                },
                {
                    text: L(
                        '<strong>Agree actions</strong> with an owner and a due date, linked to a development objective or a goal if useful, then <strong>mark the meeting as held</strong>.',
                        '<strong>Convenez d’actions</strong> avec un responsable et une échéance, liées si utile à un objectif de développement ou à un objectif (OKR), puis <strong>marquez l’entretien comme tenu</strong>.'
                    ),
                },
            ],
            practices: [
                L(
                    'Private notes are never visible to anyone else — not the other person, not HR, not an administrator.',
                    'Les notes privées ne sont visibles de personne d’autre — ni de l’autre personne, ni des RH, ni d’un administrateur.'
                ),
            ],
            value: L(
                'Regular, prepared conversations turn into agreed actions that are followed up.',
                'Des échanges réguliers et préparés deviennent des actions convenues et suivies.'
            ),
        },
        '/feedback-360': {
            title: L('My 360° feedback', 'Mon feedback 360°'),
            why: L(
                '<strong>Process:</strong> How your manager, colleagues, direct reports and others see your skills and behaviours — next to your own view — and the questionnaires others have asked you to fill in.',
                '<strong>Processus :</strong> le regard de votre responsable, de vos collègues, de vos collaborateurs et d’autres personnes sur vos compétences et comportements — à côté du vôtre — et les questionnaires qu’on vous demande de remplir.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Choose your raters</strong> when a round is launched for you; your manager approves the list.',
                        '<strong>Choisissez vos évaluateurs</strong> quand un tour est lancé pour vous ; votre responsable valide la liste.'
                    ),
                },
                {
                    text: L(
                        '<strong>Answer</strong> the questionnaires waiting for you: a level from 0 to 4, or “not observed” — never counted as 0.',
                        '<strong>Répondez</strong> aux questionnaires qui vous attendent : un niveau de 0 à 4, ou « non observé » — jamais compté comme 0.'
                    ),
                },
                {
                    text: L(
                        '<strong>Read your report</strong> once it is released, and add what you want to work on to your development plan.',
                        '<strong>Lisez votre rapport</strong> une fois communiqué, et ajoutez à votre plan de développement ce que vous voulez travailler.'
                    ),
                },
            ],
            practices: [
                L(
                    'Answers from peers, direct reports and others are only shown grouped, from a minimum number of answers; nobody sees who answered what.',
                    'Les réponses des collègues, collaborateurs et autres ne sont montrées que regroupées, à partir d’un nombre minimum de réponses ; personne ne voit qui a répondu quoi.'
                ),
            ],
            value: L(
                'Seeing the gap between how you see yourself and how others see you points to what is worth developing.',
                'Voir l’écart entre votre regard et celui des autres montre ce qui vaut la peine d’être développé.'
            ),
        },
        '/feedback-360/manage': {
            title: L('360° feedback console', 'Console feedback 360°'),
            why: L(
                '<strong>Process:</strong> Launch a 360° round for one person or a campaign for several, approve their raters, follow who has answered and release the reports.',
                '<strong>Processus :</strong> lancez un tour 360° pour une personne ou une campagne pour plusieurs, validez leurs évaluateurs, suivez qui a répondu et communiquez les rapports.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Launch</strong> with a deadline, a minimum number of raters per group and an anonymity threshold (3 or more).',
                        '<strong>Lancez</strong> avec une échéance, un nombre minimum d’évaluateurs par groupe et un seuil d’anonymat (3 ou plus).'
                    ),
                },
                {
                    text: L(
                        '<strong>Remind</strong> the raters who have not answered; the round closes by itself after the deadline.',
                        '<strong>Relancez</strong> les évaluateurs qui n’ont pas répondu ; le tour se clôt tout seul après l’échéance.'
                    ),
                },
            ],
            practices: [
                L(
                    'You see who has answered, never what they answered: a response is stored without the rater’s identity.',
                    'Vous voyez qui a répondu, jamais ce qu’il a répondu : une réponse est enregistrée sans l’identité de l’évaluateur.'
                ),
            ],
            value: L(
                'Multi-rater feedback at scale, without putting anyone’s anonymity at risk.',
                'Le feedback multi-évaluateurs à grande échelle, sans mettre en jeu l’anonymat de quiconque.'
            ),
        },
        '/employee/my-progress': {
            title: L('My Progress', 'Ma progression'),
            why: L(
                "<strong>Process:</strong> How your assessed levels have evolved over time and where you stand against your role's requirements.",
                "<strong>Processus :</strong> l'évolution de vos niveaux évalués dans le temps et votre position par rapport aux exigences de votre poste."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read the trend</strong> to see skills that are improving or stalling.',
                        '<strong>Lisez la tendance</strong> pour repérer les compétences qui progressent ou stagnent.'
                    ),
                },
            ],
            value: L(
                'Seeing your own trajectory keeps development motivating and concrete.',
                'Voir votre trajectoire rend le développement motivant et concret.'
            ),
        },
        '/notifications': {
            title: L('Notifications', 'Notifications'),
            why: L(
                '<strong>Process:</strong> Everything that needs your attention — invitations, approvals, decisions and reminders — each with a direct link to exactly where to act.',
                "<strong>Processus :</strong> tout ce qui requiert votre attention — invitations, approbations, décisions et rappels — chacun avec un lien direct vers l'endroit où agir."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Open an item</strong> to jump straight to the action it needs.',
                        "<strong>Ouvrez un élément</strong> pour aller directement à l'action attendue."
                    ),
                },
                {
                    text: L(
                        '<strong>Mark as read</strong> to keep your list focused on what remains.',
                        '<strong>Marquez comme lu</strong> pour garder la liste centrée sur ce qui reste.'
                    ),
                },
            ],
            value: L(
                'Nothing important slips through — every request reaches you with a one-click path to resolve it.',
                "Rien d'important ne passe à travers — chaque demande vous parvient avec un chemin en un clic pour la traiter."
            ),
        },
        '/v2/coaching': {
            title: L('Coaching Sessions', 'Séances de coaching'),
            why: L(
                '<strong>Process:</strong> The scheduled and completed coaching or mentoring sessions, each tied to what triggered it — a development plan, an improvement plan, or a specific skill.',
                "<strong>Processus :</strong> les séances de coaching ou de mentorat prévues et réalisées, chacune rattachée à ce qui l'a déclenchée — un plan de développement, un plan d'amélioration, ou une compétence précise."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Review the upcoming sessions</strong> and the context each one serves.',
                        '<strong>Consultez les séances à venir</strong> et le contexte que chacune sert.'
                    ),
                },
                {
                    text: L(
                        '<strong>Record what happened</strong> after a session so the plan reflects reality.',
                        "<strong>Consignez ce qui s'est passé</strong> après une séance pour que le plan reflète la réalité."
                    ),
                },
            ],
            practices: [
                L(
                    'A session without a recorded outcome cannot support a later decision — log it while it is fresh.',
                    "Une séance sans résultat consigné ne peut pas appuyer une décision ultérieure — consignez-la tant que c'est frais."
                ),
            ],
            value: L(
                'Coaching becomes traceable support attached to a goal, not an informal conversation.',
                'Le coaching devient un accompagnement traçable rattaché à un objectif, pas une conversation informelle.'
            ),
        },
        // every href in views/partials/sidebar.ejs now resolves to a
        // help entry (see lotE/help-diff.js). These four were the gap.
        '/employee/my-coaching': {
            title: L('My coaching', 'Mon coaching'),
            why: L(
                '<strong>Process:</strong> The coaching or mentoring your manager opened for you — sessions, actions and the progress you record yourself.',
                "<strong>Processus :</strong> le coaching ou le mentorat ouvert par votre responsable — séances, actions, et l'avancement que vous déclarez vous-même."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read the objective</strong> of the plan and the actions attached to it.',
                        "<strong>Lisez l'objectif</strong> du plan et les actions qui y sont rattachées."
                    ),
                },
                {
                    text: L(
                        '<strong>Record your progress</strong> on an action (0-100 %) — your manager sees it immediately.',
                        '<strong>Déclarez votre avancement</strong> sur une action (0-100 %) — votre responsable le voit immédiatement.'
                    ),
                },
            ],
            practices: [
                L(
                    'Update progress when something actually changes, not at the end — the point is the conversation, not the number.',
                    "Mettez l'avancement à jour quand quelque chose bouge vraiment, pas à la fin — l'intérêt est la conversation, pas le chiffre."
                ),
            ],
            value: L(
                'Coaching stops being a meeting you forget and becomes a short list you can act on.',
                "Le coaching cesse d'être une réunion oubliée pour devenir une courte liste sur laquelle agir."
            ),
        },
        '/employee/my-learning': {
            title: L('My learning', 'Mes formations'),
            why: L(
                '<strong>Process:</strong> The courses assigned to you, where they came from (a skill gap, a certification, a development plan) and how far along you are.',
                '<strong>Processus :</strong> les formations qui vous sont assignées, leur origine (un écart de compétence, une certification, un plan de développement) et votre avancement.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Open a course</strong> to see the skill it targets and its due date.',
                        '<strong>Ouvrez une formation</strong> pour voir la compétence visée et son échéance.'
                    ),
                },
                {
                    text: L(
                        '<strong>Mark it complete</strong> once finished — completion feeds back into your skill profile.',
                        "<strong>Marquez-la terminée</strong> une fois finie — l'achèvement remonte dans votre profil de compétences."
                    ),
                },
            ],
            practices: [
                L(
                    'A course with a due date in the past is not a failure — tell your manager what blocked it.',
                    "Une formation dont l'échéance est passée n'est pas un échec — dites à votre responsable ce qui l'a bloquée."
                ),
            ],
            value: L(
                'You see why each course was assigned, so training stops feeling random.',
                'Vous voyez pourquoi chaque formation vous a été assignée : elle cesse de paraître arbitraire.'
            ),
        },
        '/guide': {
            title: L('User guide', "Guide de l'utilisateur"),
            why: L(
                '<strong>Process:</strong> The complete manual, by profile — employee, manager, local admin, SuperAdmin. Each section names the page it talks about and what you can do there.',
                '<strong>Processus :</strong> le manuel complet, par profil — collaborateur, manager, administrateur local, super-administrateur. Chaque section nomme la page dont elle parle et ce que vous pouvez y faire.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Pick your profile</strong> at the top; the sections below follow the order of a real working day.',
                        "<strong>Choisissez votre profil</strong> en haut ; les sections suivent l'ordre d'une vraie journée de travail."
                    ),
                },
                {
                    text: L(
                        '<strong>Use the search</strong> if you already know the page name — each entry gives its path.',
                        '<strong>Utilisez la recherche</strong> si vous connaissez déjà le nom de la page — chaque entrée donne son chemin.'
                    ),
                },
            ],
            practices: [
                L(
                    'The "?" button on any page gives the short version of the same content, in context.',
                    'Le bouton « ? » de chaque page donne la version courte du même contenu, en contexte.'
                ),
            ],
            value: L(
                'One document to hand a new administrator, instead of a walkthrough you have to repeat.',
                "Un seul document à remettre à un nouvel administrateur, au lieu d'une visite guidée à refaire à chaque fois."
            ),
        },
        '/data-management/sql-console': {
            title: L('SQL console', 'Console SQL'),
            why: L(
                '<strong>Process:</strong> The SuperAdmin escape hatch: turn a filled Excel template into an idempotent SQL script, or run SQL directly. A full restore point is taken automatically before any statement that changes the database.',
                '<strong>Processus :</strong> la porte de secours du super-administrateur : convertir un modèle Excel rempli en script SQL idempotent, ou exécuter du SQL directement. Un point de restauration complet est pris automatiquement avant toute instruction qui modifie la base.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Always dry-run first</strong> — the preview runs the script and rolls it back; nothing is saved.',
                        "<strong>Faites toujours une exécution à blanc d'abord</strong> — l'aperçu exécute le script puis l'annule ; rien n'est enregistré."
                    ),
                },
                {
                    text: L(
                        '<strong>Read the restore point name</strong> printed after a real run; you can revert to it from the list below.',
                        '<strong>Notez le nom du point de restauration</strong> affiché après une exécution réelle ; vous pouvez y revenir depuis la liste en dessous.'
                    ),
                },
            ],
            practices: [
                L(
                    'The append-only audit tables (system_logs, assessment_history, review_signatures) refuse UPDATE/DELETE and survive a revert — the record of what you did cannot be erased here.',
                    "Les tables d'audit en écriture seule (system_logs, assessment_history, review_signatures) refusent UPDATE/DELETE et survivent à un retour arrière — la trace de ce que vous avez fait ne peut pas être effacée ici."
                ),
            ],
            value: L(
                'A correction that would otherwise need a database administrator, done in the application and audited.',
                "Une correction qui exigerait autrement un administrateur de base de données, faite dans l'application et tracée."
            ),
        },
        '/employee/my-development': {
            title: L('My Development', 'Mon développement'),
            why: L(
                '<strong>Process:</strong> Everything opened <em>for</em> you — development objectives, coaching or mentoring, and the actions that came out of a performance review — in one place, so you always know what is expected next.',
                "<strong>Processus :</strong> tout ce qui a été ouvert <em>pour vous</em> — objectifs de développement, coaching ou mentorat, et les actions issues d'une revue de performance — au même endroit, pour toujours savoir ce qui est attendu ensuite."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read your objectives</strong> and the skill each one targets, from your current level to the level the role requires.',
                        '<strong>Lisez vos objectifs</strong> et la compétence visée par chacun, de votre niveau actuel au niveau requis par le poste.'
                    ),
                },
                {
                    text: L(
                        '<strong>Follow the progress</strong> of each action and raise anything blocking with your manager.',
                        "<strong>Suivez l'avancement</strong> de chaque action et signalez tout blocage à votre manager."
                    ),
                },
            ],
            practices: [
                L(
                    'An objective names a skill and a target level — that is the whole contract; ask if either is unclear.',
                    "Un objectif nomme une compétence et un niveau cible — c'est tout le contrat ; demandez si l'un des deux n'est pas clair."
                ),
            ],
            value: L(
                'You always know what is expected of you and what support was put in place.',
                'Vous savez toujours ce qui est attendu de vous et quel accompagnement a été mis en place.'
            ),
        },
        '/employee/my-certifications': {
            title: L('My Certifications', 'Mes certifications'),
            why: L(
                '<strong>Process:</strong> The certifications you hold, whether each is still valid, and what is about to expire — so a lapse never takes you off a job without warning.',
                "<strong>Processus :</strong> les certifications que vous détenez, leur validité, et ce qui va expirer — pour qu'une échéance ne vous retire jamais d'un poste sans prévenir."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Check the expiry dates</strong>; anything close to lapsing is flagged.',
                        "<strong>Vérifiez les dates d'échéance</strong> ; ce qui approche de l'expiration est signalé."
                    ),
                },
                {
                    text: L(
                        '<strong>Start the renewal</strong> with your manager well before the date.',
                        '<strong>Lancez le renouvellement</strong> avec votre manager bien avant la date.'
                    ),
                },
            ],
            practices: [
                L(
                    'A certification is what makes you eligible for certain tasks — treat an expiry like a deadline, not a formality.',
                    'Une certification conditionne votre éligibilité à certaines tâches — traitez une échéance comme un délai, pas une formalité.'
                ),
            ],
            value: L(
                'No surprise lapse: you stay qualified and the site stays compliant.',
                'Aucune expiration surprise : vous restez qualifié et le site reste conforme.'
            ),
        },
        '/employee/my-data': {
            title: L('What is recorded about me', 'Ce qui est enregistré sur moi'),
            why: L(
                '<strong>Process:</strong> Every category of personal data the platform keeps about you, how many records each holds, who can see it and how long it is kept — the same list a formal access request returns.',
                "<strong>Processus :</strong> chaque catégorie de données personnelles que la plateforme conserve sur vous, le nombre d'enregistrements, qui peut les voir et combien de temps elles sont gardées — la même liste que celle d'une demande d'accès formelle."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read each category</strong> and who can see it.',
                        '<strong>Parcourez chaque catégorie</strong> et qui peut la consulter.'
                    ),
                },
                {
                    text: L(
                        '<strong>Ask HR or the data protection officer</strong> for a full export or an erasure.',
                        '<strong>Adressez-vous aux RH ou au délégué à la protection des données</strong> pour un export complet ou un effacement.'
                    ),
                },
            ],
            practices: [
                L(
                    'A category marked confidential is listed without a count; its full content is given to you on a formal access request.',
                    "Une catégorie marquée confidentielle est listée sans nombre ; son contenu complet vous est remis sur demande d'accès formelle."
                ),
            ],
            value: L(
                'No hidden file: you know what is kept about you and how to exercise your rights.',
                'Aucun dossier caché : vous savez ce qui est conservé sur vous et comment exercer vos droits.'
            ),
        },
        '/mon-acces': {
            title: L('My Access', 'Mon accès'),
            why: L(
                '<strong>Process:</strong> Exactly what you are allowed to do in the platform, over which scope, and who granted it — the answer to "why can\'t I see this page?" without opening a ticket.',
                "<strong>Processus :</strong> exactement ce que vous êtes autorisé à faire dans la plateforme, sur quel périmètre, et qui vous l'a accordé — la réponse à « pourquoi je ne vois pas cette page ? » sans ouvrir de ticket."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Read your permissions</strong> and the scope (sites, departments) each one applies to.',
                        "<strong>Lisez vos permissions</strong> et le périmètre (sites, départements) auquel chacune s'applique."
                    ),
                },
                {
                    text: L(
                        '<strong>Check the provenance</strong> — who granted it and when — before asking for more.',
                        "<strong>Vérifiez la provenance</strong> — qui a accordé et quand — avant d'en demander davantage."
                    ),
                },
            ],
            practices: [
                L(
                    'If a page refuses you, name the missing permission here when you request it — it gets resolved far faster.',
                    "Si une page vous refuse, citez ici la permission manquante lors de votre demande — c'est résolu bien plus vite."
                ),
            ],
            value: L(
                'Access stops being a mystery, and requests become specific instead of "give me admin".',
                "L'accès cesse d'être opaque, et les demandes deviennent précises au lieu de « donnez-moi admin »."
            ),
        },
        '/exec/key-person': {
            title: L('Key-Person Risk', 'Risque de personne clé'),
            why: L(
                '<strong>Process:</strong> The people who are the <em>only</em> one qualified for something critical. Named, with their site and role, because "3 roles at risk" is not something you can act on — a name is.',
                "<strong>Processus :</strong> les personnes qui sont les <em>seules</em> qualifiées pour quelque chose de critique. Nommées, avec leur site et leur poste, car « 3 postes à risque » n'est pas actionnable — un nom l'est."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Start at the top</strong> — the highest exposure is listed first.',
                        "<strong>Commencez par le haut</strong> — l'exposition la plus forte est en premier."
                    ),
                },
                {
                    text: L(
                        '<strong>Open a succession plan or a development plan</strong> for a second qualified person; that is the only thing that removes the risk.',
                        "<strong>Ouvrez un plan de succession ou de développement</strong> pour une deuxième personne qualifiée ; c'est la seule chose qui supprime le risque."
                    ),
                },
            ],
            practices: [
                L(
                    'A single point of failure is a planning decision, not bad luck — one departure or one absence is all it takes.',
                    'Un point de défaillance unique est une décision de planification, pas de la malchance — un départ ou une absence suffit.'
                ),
                L(
                    'You only see the people within your own scope; a director sees theirs.',
                    'Vous ne voyez que les personnes de votre périmètre ; un directeur voit le sien.'
                ),
            ],
            value: L(
                'Turns an abstract continuity risk into a named person and a next action.',
                'Transforme un risque de continuité abstrait en une personne nommée et une action concrète.'
            ),
        },
        '/exec/site-exposure': {
            title: L('Exposure by Site', 'Exposition par site'),
            why: L(
                '<strong>Process:</strong> The sites side by side on readiness, coverage, continuity and certification exposure — so you can see which one needs attention without reading four separate reports.',
                "<strong>Processus :</strong> les sites côte à côte sur la préparation, la couverture, la continuité et l'exposition aux certifications — pour voir lequel nécessite votre attention sans lire quatre rapports distincts."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Compare the columns</strong>, not just one metric — a strong readiness with weak coverage means the number rests on few measurements.',
                        '<strong>Comparez les colonnes</strong>, pas un seul indicateur — une bonne préparation avec une faible couverture signifie que le chiffre repose sur peu de mesures.'
                    ),
                },
                {
                    text: L(
                        '<strong>Drill into the weakest site</strong> to see which roles and people drive the gap.',
                        "<strong>Explorez le site le plus faible</strong> pour voir quels postes et quelles personnes expliquent l'écart."
                    ),
                },
            ],
            practices: [
                L(
                    'A dash means "not measured", not zero — treat it as a coverage gap to close, not a bad score.',
                    'Un tiret signifie « non mesuré », pas zéro — traitez-le comme une couverture à compléter, pas comme un mauvais score.'
                ),
            ],
            value: L(
                'One screen to decide where to send attention and budget next quarter.',
                "Un seul écran pour décider où porter l'attention et le budget le trimestre prochain."
            ),
        },
        '/exec/board-pack': {
            title: L('Board Pack', 'Pack Direction'),
            why: L(
                '<strong>Process:</strong> A print-ready summary of the workforce position — headline indicators, exposure and continuity — assembled for a management or board meeting.',
                '<strong>Processus :</strong> une synthèse prête à imprimer de la situation des effectifs — indicateurs clés, exposition et continuité — assemblée pour un comité de direction ou un conseil.'
            ),
            steps: [
                {
                    text: L(
                        '<strong>Check the scope</strong> shown at the top — the pack reflects what you are allowed to see.',
                        '<strong>Vérifiez le périmètre</strong> indiqué en haut — le pack reflète ce que vous êtes autorisé à voir.'
                    ),
                },
                {
                    text: L(
                        '<strong>Print or export</strong> once the figures are the ones you want to present.',
                        '<strong>Imprimez ou exportez</strong> une fois les chiffres validés pour votre présentation.'
                    ),
                },
            ],
            practices: [
                L(
                    'An indicator with no history shows no trend rather than a fabricated one — a first pack is a baseline.',
                    "Un indicateur sans historique n'affiche aucune tendance plutôt qu'une tendance inventée — un premier pack est une base de référence."
                ),
            ],
            value: L(
                'The workforce position presented from the system of record, not a hand-built slide.',
                'La situation des effectifs présentée depuis le système de référence, pas une diapositive refaite à la main.'
            ),
        },
        '/reports/dept-analytics': {
            title: L('Department Analytics', 'Analytique par département'),
            why: L(
                '<strong>Process:</strong> Site by department: headcount, campaign completion and the share of requirements actually met — where the organisation is progressing and where it has stalled.',
                "<strong>Processus :</strong> site par département : effectif, avancement de la campagne et part des exigences réellement atteintes — où l'organisation progresse et où elle est bloquée."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Sort by completion</strong> to find the departments that have not started.',
                        "<strong>Triez par avancement</strong> pour repérer les départements qui n'ont pas commencé."
                    ),
                },
                {
                    text: L(
                        "<strong>Contact those managers</strong> — a stalled department is usually one person's queue, not a system problem.",
                        "<strong>Contactez ces managers</strong> — un département bloqué, c'est souvent la file d'attente d'une personne, pas un problème système."
                    ),
                },
            ],
            practices: [
                L(
                    'Completion is measured against the enrolled roster, so people who never started are counted — the figure will not flatter you.',
                    "L'avancement est mesuré sur la liste des inscrits, donc les personnes n'ayant jamais commencé sont comptées — le chiffre ne vous flattera pas."
                ),
            ],
            value: L(
                'Shows exactly where a campaign is stuck, by department, while there is still time to act.',
                "Montre exactement où une campagne est bloquée, par département, tant qu'il est encore temps d'agir."
            ),
        },
        '/compliance': {
            title: L('Compliance', 'Conformité'),
            why: L(
                '<strong>Process:</strong> The status of certifications and mandatory requirements across your scope — what is valid, expiring, or overdue.',
                "<strong>Processus :</strong> l'état des certifications et exigences obligatoires sur votre périmètre — ce qui est valide, expire bientôt, ou est en retard."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Sort by expiry</strong> to act on what lapses first.',
                        "<strong>Triez par échéance</strong> pour traiter d'abord ce qui expire."
                    ),
                },
            ],
            value: L(
                'Staying ahead of expiries keeps sites audit-ready and people safe.',
                "Anticiper les échéances garde les sites prêts pour l'audit et les personnes en sécurité."
            ),
        },
        '/admin/invitations': {
            title: L('Invitations', 'Invitations'),
            why: L(
                '<strong>Process:</strong> Send sign-in invitations to employees so they can access their space — and see who has not yet been contacted (e.g. missing an email).',
                "<strong>Processus :</strong> envoyez des invitations de connexion aux collaborateurs pour qu'ils accèdent à leur espace — et repérez qui n'a pas encore été contacté (ex. e-mail manquant)."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Select</strong> the people to invite and send.',
                        '<strong>Sélectionnez</strong> les personnes à inviter et envoyez.'
                    ),
                },
                {
                    text: L(
                        '<strong>Fix missing emails</strong> flagged here so no one is left out.',
                        "<strong>Corrigez les e-mails manquants</strong> signalés ici pour n'oublier personne."
                    ),
                },
            ],
            value: L(
                'Fast, complete onboarding: everyone can reach their own workspace from day one.',
                'Une intégration rapide et complète : chacun accède à son espace dès le premier jour.'
            ),
        },
        // ---- SECTION accounts — Accounts console (2026-09-10) ----
        '/admin/accounts': {
            title: L('Accounts', 'Comptes'),
            why: L(
                '<strong>Process:</strong> ONE list of every active employee in your scope with the state of their sign-in account — never invited, invited (pending / expired), active, locked, login disabled, SSO — plus last sign-in, so "who has an account, who never signed in, who is locked" is answered on one page.',
                "<strong>Processus :</strong> UNE liste de tous les collaborateurs actifs de votre périmètre avec l'état de leur compte — jamais invité, invité (en attente / expiré), actif, verrouillé, connexion désactivée, SSO — et la dernière connexion : « qui a un compte, qui ne s'est jamais connecté, qui est verrouillé » se lit sur une seule page."
            ),
            steps: [
                {
                    text: L(
                        '<strong>Filter</strong> by site, department, state or search (name, number, <em>username</em>, e-mail); the counters at the top are the same filters.',
                        '<strong>Filtrez</strong> par site, département, état ou recherche (nom, matricule, <em>identifiant</em>, e-mail) ; les compteurs du haut sont les mêmes filtres.'
                    ),
                },
                {
                    text: L(
                        '<strong>Act per row</strong> (unlock, send credentials, set a password, disable / re-enable the login) or <strong>select rows</strong> for a bulk action — each id is checked against your scope.',
                        '<strong>Agissez par ligne</strong> (débloquer, envoyer les identifiants, définir un mot de passe, désactiver / réactiver la connexion) ou <strong>sélectionnez des lignes</strong> pour une action en masse — chaque personne est vérifiée contre votre périmètre.'
                    ),
                },
                {
                    text: L(
                        '<strong>No e-mail / SMTP off?</strong> The credentials come back ONCE on a downloadable sheet — hand them over in person.',
                        "<strong>Pas d'e-mail / SMTP éteint ?</strong> Les identifiants reviennent UNE fois sur une fiche à télécharger — remettez-les en main propre."
                    ),
                },
                {
                    text: L(
                        '<strong>Manager requests</strong> ("unlock / resend my report\'s credentials") appear as a counter and on the row; act on them or decline with a reason.',
                        '<strong>Les demandes des managers</strong> (« débloquer / renvoyer les identifiants de mon collaborateur ») apparaissent en compteur et sur la ligne ; traitez-les ou refusez-les avec un motif.'
                    ),
                },
                {
                    text: L(
                        '<strong>Export (CSV)</strong> the list as filtered — the access inventory auditors ask for.',
                        "<strong>Exportez (CSV)</strong> la liste telle que filtrée — l'inventaire des accès demandé par les auditeurs."
                    ),
                },
            ],
            practices: [
                L(
                    'Review the "never signed in" and "dormant" counters monthly; a reminder reaches you when dormant accounts exist.',
                    'Passez en revue les compteurs « jamais connectés » et « dormants » chaque mois ; un rappel vous parvient quand des comptes dormants existent.'
                ),
                L(
                    'Prefer "Disable login" to a departure when someone is only away: the record, history and credentials are kept.',
                    'Préférez « Désactiver la connexion » à un départ quand une personne est seulement absente : fiche, historique et identifiants sont conservés.'
                ),
            ],
            value: L(
                'The daily account tasks of a site administrator without a ticket to the SuperAdmin — and an honest picture of who can actually sign in.',
                "Les tâches quotidiennes sur les comptes d'un administrateur de site sans ticket au SuperAdmin — et une image honnête de qui peut réellement se connecter."
            ),
        },
        // ---- end SECTION accounts ----

        // __ENTRIES_END__,
        '/admin/delegation': {
            title: L('Delegation of authority', "Délégation d'autorité"),
            why: L(
                '<strong>Process:</strong> The readable view of who holds what authority, over whom, from whom and until when. <em>/admins</em> is an edit form; this page answers the two governance questions: for an administrator, what can they really do and over how many people (<strong>reach</strong>)? For a site or a country, <strong>who has authority over my people</strong>? Both are computed from the same resolver the enforcement path uses, so the page cannot drift from reality.',
                "<strong>Processus :</strong> la vue lisible de qui détient quels droits, sur qui, de la part de qui et jusqu'à quand. <em>/admins</em> est un formulaire d'édition ; cette page répond aux deux questions de gouvernance : pour un administrateur, que peut-il vraiment faire et sur combien de personnes (<strong>portée</strong>) ? Pour un site ou un pays, <strong>qui a autorité sur mes gens</strong> ? Les deux sont calculés avec le résolveur qu'utilise le contrôle d'accès lui-même : la page ne peut pas diverger de la réalité."
            ),
            steps: [
                {
                    text: L(
                        'Open it from <strong>Administrators → Delegation of authority</strong>. The findings block comes first: a scope with no capability, a capability with no scope, expired grants, a populated site nobody covers.',
                        "Ouvrez-la depuis <strong>Administrateurs → Délégation d'autorité</strong>. Le bloc « À traiter » vient en premier : périmètre sans droit, droit sans périmètre, droits expirés, site peuplé que personne ne couvre."
                    ),
                },
                {
                    text: L(
                        '<strong>Capability details</strong> under each count shows who granted each right and when. <em>Unknown origin (predates the ledger)</em> is said out loud: a grant made before the access ledger existed has no author on record, and the page never invents one. <em>Reconstructed from the system log</em> marks an origin derived by the one-off backfill.',
                        "<strong>Détail des droits</strong> sous chaque compteur montre qui a accordé chaque droit et quand. <em>Origine inconnue (avant journal)</em> est dit explicitement : un droit accordé avant le registre des accès n'a pas d'auteur enregistré, et la page n'en invente jamais. <em>Reconstitué du journal système</em> signale une origine dérivée par la reconstitution unique."
                    ),
                },
                {
                    text: L(
                        'The lower table inverts the question per country and site: the people count and the administrators who can act on them. A site with people and nobody listed is a governance gap — every request there escalates to a SuperAdmin.',
                        "Le tableau du bas inverse la question par pays et par site : l'effectif et les administrateurs qui peuvent agir dessus. Un site avec des personnes et personne de listé est une lacune de gouvernance — toute demande y remonte à un SuperAdmin."
                    ),
                },
            ],
            practices: [
                L(
                    'Read reach, not role: a "local admin" over one service and one over a whole country are the same role name with very different power.',
                    'Lisez la portée, pas le rôle : un « admin local » sur un service et un autre sur tout un pays portent le même nom de rôle avec un pouvoir très différent.'
                ),
                L(
                    'Fix "scope but no capability" first — it is the delegation that exists on paper only.',
                    "Traitez d'abord « périmètre sans droit » — c'est la délégation qui n'existe que sur le papier."
                ),
            ],
            value: L(
                'Answers "who can act on my people?" in one screen, with provenance — the question a country manager asks after an unexpected change.',
                "Répond à « qui peut agir sur mes gens ? » en un écran, avec la provenance — la question qu'un directeur pays pose après un changement inattendu."
            ),
        },
    };

    // Aliases so related/sub-paths map to the right entry.
    HELP_CONTENT['/admin/invitations'] = HELP_CONTENT['/admin/accounts']; // the old console redirects here
    HELP_CONTENT['/account/notifications'] = HELP_CONTENT['/notifications'];
    HELP_CONTENT['/employee/my-coaching'] = HELP_CONTENT['/coaching/plans'];
    HELP_CONTENT['/coaching'] = HELP_CONTENT['/coaching/plans'];
    HELP_CONTENT['/v2/coaching'] = HELP_CONTENT['/coaching/plans'];
    HELP_CONTENT['/supervisor/reviews'] = HELP_CONTENT['/supervisor/self-assessment-reviews'];
    HELP_CONTENT['/supervisor'] = HELP_CONTENT['/supervisor/self-assessment-reviews'];
    HELP_CONTENT['/reports'] = HELP_CONTENT['/reports/builder'];
    HELP_CONTENT['/talent/9box-grid'] = HELP_CONTENT['/talent/nine-box'];
    HELP_CONTENT['/v2/uam/mfa/setup'] = HELP_CONTENT['/v2/uam/mfa/manage'];
    HELP_CONTENT['/skills'] = HELP_CONTENT['/domains-skills'];
    HELP_CONTENT['/domains'] = HELP_CONTENT['/domains-skills'];
    HELP_CONTENT['/employees/:id/edit'] = HELP_CONTENT['/employees/create'];

    function render(content) {
        let html =
            '<div class="help-block help-guide-intro"><h4>' +
            content.title +
            '</h4>' +
            '<p class="help-why">' +
            content.why +
            '</p></div>';
        if (content.steps && content.steps.length) {
            html +=
                '<div class="help-block"><h5><i class="fas fa-list-ul" aria-hidden="true"></i> ' +
                L('How to use it', "Comment l'utiliser") +
                '</h5><ul class="help-steps">';
            content.steps.forEach((step, i) => {
                html +=
                    '<li><div class="step-content"><span class="step-number">' +
                    (i + 1) +
                    '.</span>' +
                    '<span class="step-text">' +
                    step.text +
                    '</span></div></li>';
            });
            html += '</ul></div>';
        }
        if (content.practices && content.practices.length) {
            html +=
                '<div class="help-block"><h5><i class="fas fa-circle-check" aria-hidden="true"></i> ' +
                L('Good practices', 'Bonnes pratiques') +
                '</h5><ul class="help-practices">';
            content.practices.forEach((p) => {
                html += '<li>' + p + '</li>';
            });
            html += '</ul></div>';
        }
        if (content.value) {
            html +=
                '<div class="help-block help-value"><h5><i class="fas fa-gem" aria-hidden="true"></i> ' +
                L('Get the most value', 'En tirer le maximum') +
                '</h5><p>' +
                content.value +
                '</p></div>';
        }
        return html;
    }

    function updateGuideContent() {
        const path = window.location.pathname;
        // Normalise numeric segments so detail pages can have their OWN entry
        // (e.g. /employees/123/assessments -> /employees/:id/assessments).
        const norm = path.replace(/\/\d+(?=\/|$)/g, '/:id');
        let content = HELP_CONTENT[path] || HELP_CONTENT[norm];
        if (!content) {
            // longest matching prefix wins (e.g. /employees/123 -> /employees)
            const key = Object.keys(HELP_CONTENT)
                .filter((k) => path.startsWith(k) || norm.startsWith(k))
                .sort((a, b) => b.length - a.length)[0];
            if (key) content = HELP_CONTENT[key];
        }
        const box = document.getElementById('guide-content');
        if (!box) return;
        box.innerHTML = content
            ? render(content)
            : '<div class="help-block"><h4><i class="fas fa-circle-info" aria-hidden="true"></i> ' +
              L('General help', 'Aide générale') +
              '</h4>' +
              '<p class="text-muted">' +
              L(
                  'No module-specific guide for this page yet. See the <strong>Full Manual</strong> tab for the end-to-end setup and usage walkthrough.',
                  "Pas encore de guide spécifique pour cette page. Consultez l'onglet <strong>Manuel complet</strong> pour la marche à suivre de bout en bout, de la configuration à l'utilisation."
              ) +
              '</p></div>';
    }

    updateGuideContent();

    helpTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            helpTabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            helpSections.forEach((s) => s.classList.remove('active'));
            const target = document.getElementById(tab.getAttribute('data-target'));
            if (target) target.classList.add('active');
        });
    });
});
