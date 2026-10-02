'use strict';

/**
 * Security posture shown on the About page and in docs/SECURITY-MEASURES.md.
 *
 * Every control names the files that implement it (`evidence`) and the Jest
 * suites that prove it (`tests`). tests/unit/securityPostureEvidence.test.js
 * fails when a cited file or suite disappears, so the page never claims a
 * control the code no longer has.
 */
const CATEGORIES = [
    {
        id: 'identity',
        icon: 'fa-user-lock',
        title: { fr: 'Identité et accès', en: 'Identity and access' },
        controls: [
            {
                id: 'passwords',
                fr: 'Mots de passe hachés avec bcrypt ; 12 caractères minimum, sans règle de composition (NIST 800-63B) ; mots de passe courants ou divulgués refusés hors ligne ; jauge de robustesse ; changement imposé à la première connexion.',
                en: 'Passwords hashed with bcrypt; 12 characters minimum, no composition rules (NIST 800-63B); common and breached passwords refused offline; a strength meter; a forced change at first sign-in.',
                evidence: [
                    'src/utils/passwordValidator.js',
                    'src/data/common-passwords.txt',
                    'public/js/password-strength.js',
                    'src/middleware/forcePasswordChange.js',
                ],
                tests: ['passwordValidator.test.js', 'passwordResetEligibility.test.js'],
            },
            {
                id: 'lockout',
                fr: 'Ralentissement progressif des connexions par adresse et par compte (sans bloquer tout un site derrière une même adresse) ; comptes administrateurs verrouillés après 10 échecs avec alerte aux super-administrateurs ; changement de mot de passe et vérifications de double authentification limités par utilisateur.',
                en: 'Progressive sign-in throttling per address and per account (without blocking a whole site behind one address); administrator accounts locked after 10 failures with an alert to the super-administrators; password change and two-factor checks rate-limited per user.',
                evidence: ['src/middleware/rateLimiter.js', 'src/controllers/AuthController.js'],
                tests: [
                    'loginRateLimiterCountsFailures.test.js',
                    'lotC-lockout-reminders.test.js',
                    'loginThrottleProgressive.test.js',
                    'accountLockoutPolicy.test.js',
                    'reauthLimiters.test.js',
                ],
            },
            {
                id: 'mfa',
                fr: 'Double authentification TOTP avec codes de secours, obligatoire pour tous les administrateurs et pour les managers qui se connectent par mot de passe (période de grâce après une mise à jour) ; le contrôle refuse l’accès en cas d’erreur.',
                en: 'Two-factor authentication (TOTP) with backup codes, mandatory for every administrator and for managers who sign in with a password (grace period after an upgrade); the check refuses access on error.',
                evidence: ['src/services/MfaService.js', 'src/middleware/mfaEnforcement.js'],
                tests: [
                    'mfaSetupIsSafeOnGet.test.js',
                    'authLogin.test.js',
                    'mfaPolicyFailClosed.test.js',
                    'authLoginFailClosed.test.js',
                ],
            },
            {
                id: 'sessions',
                fr: 'Cookies de session httpOnly, SameSite et Secure en HTTPS (nom de cookie verrouillé sur l’hôte quand il est toujours sécurisé) ; expiration après 30 min d’inactivité et 12 h au plus par défaut.',
                en: 'httpOnly, SameSite and Secure (over HTTPS) session cookies, with a host-locked cookie name when the cookie is always Secure; idle timeout 30 min and absolute 12 h by default.',
                evidence: [
                    'server.js',
                    'src/middleware/sessionActivity.js',
                    'src/middleware/httpHardening.js',
                ],
                tests: [
                    'c319-real-session.test.js',
                    'sessionBucketsBothTypes.test.js',
                    'httpHardening.test.js',
                ],
            },
            {
                id: 'reauth',
                fr: 'Actions sensibles (clé d’API, attribution du rôle de super-administrateur, changement de son mot de passe ou de son e-mail, désactivation de la double authentification) : connexion de moins de 15 minutes ou mot de passe actuel exigé.',
                en: 'Sensitive actions (API key, SuperAdmin grant, changing one’s own password or e-mail, turning off two-factor) need a sign-in in the last 15 minutes or the current password.',
                evidence: ['src/middleware/recentAuth.js', 'src/controllers/AuthController.js'],
                tests: ['recentAuth.test.js', 'accountProfileAndAuthLocale.test.js'],
            },
            {
                id: 'sso',
                fr: 'Authentification unique OpenID Connect (dont Microsoft Entra ID), SAML 2.0 et Google ; provisionnement SCIM.',
                en: 'Single sign-on with OpenID Connect (including Microsoft Entra ID), SAML 2.0 and Google; SCIM provisioning.',
                evidence: ['src/services/SsoService.js', 'src/routes/scim.js'],
                tests: [
                    'ssoService.test.js',
                    'c319-sso-enforcement.test.js',
                    'scimReadOnlyKeyCannotWrite.test.js',
                ],
            },
            {
                id: 'rbac',
                fr: 'Droits fins par rôle, périmètres géographiques et organisationnels, validation à quatre yeux et revues d’accès.',
                en: 'Fine-grained role permissions, geographic and organisational scopes, maker-checker approval and access reviews.',
                evidence: [
                    'src/services/RBACService.js',
                    'src/utils/rbacScope.js',
                    'src/services/AccessReviewService.js',
                ],
                tests: [
                    'rbac-scope.test.js',
                    'employeeScopeGuards.test.js',
                    'c317-B-workflow-authz-makerchecker.test.js',
                    'delegationOfAuthority.test.js',
                ],
            },
            {
                id: 'apikeys',
                fr: 'Clés d’API par client, stockées sous forme de hachage, avec portée lecture ou écriture ; transmises dans un en-tête (une clé dans l’adresse est refusée, sauf exception clé par clé) ; limite de débit propre à chaque clé valide uniquement.',
                en: 'Per-client API keys, stored hashed, with read or write scope; sent in a header (a key in the address is refused, except key by key); a rate-limit bucket of its own only for a key that validates.',
                evidence: ['src/services/ApiKeyService.js', 'src/middleware/apiAuth.js'],
                tests: [
                    'apiKeyService.test.js',
                    'apiWriteScope.test.js',
                    'apiKeyDeactivatedOwner.test.js',
                    'apiKeyQueryString.test.js',
                    'apiRateLimiterValidatedKeys.test.js',
                ],
            },
        ],
    },
    {
        id: 'web',
        icon: 'fa-shield-halved',
        title: { fr: 'Protection de l’application web', en: 'Web application protection' },
        controls: [
            {
                id: 'csp',
                fr: 'Politique de sécurité du contenu avec un nonce par requête ; aucun gestionnaire d’événement en ligne (onclick…) ne peut s’exécuter (script-src-attr none) ; en-têtes Helmet, HSTS en HTTPS, anti-clickjacking.',
                en: 'Content Security Policy with a per-request nonce; no inline event handler (onclick…) can run (script-src-attr none); Helmet headers, HSTS over HTTPS, clickjacking protection.',
                evidence: ['server.js', 'src/utils/tlsServer.js', 'public/js/csp-actions.js'],
                tests: ['webSecurityBaseline.test.js', 'noInlineHandlers.test.js'],
            },
            {
                id: 'headers',
                fr: 'En-têtes de sécurité : Permissions-Policy (caméra, micro, localisation, paiement, USB, Bluetooth refusés), isolation COOP/CORP, aucun référent vers un autre site (aucun du tout depuis les API), pas de bannière du framework ; pages dynamiques jamais mises en cache, cache du navigateur vidé à la déconnexion ; sondes de santé sans détail pour un appelant anonyme.',
                en: 'Security headers: Permissions-Policy (camera, microphone, location, payment, USB, Bluetooth denied), COOP/CORP isolation, no referrer to another site (none at all from the APIs), no framework banner; dynamic pages never cached, browser cache cleared at sign-out; health probes give no detail to an anonymous caller.',
                evidence: ['server.js', 'src/middleware/httpHardening.js'],
                tests: ['asvsHeaders.test.js', 'httpHardening.test.js'],
            },
            {
                id: 'api-content-type',
                fr: 'Les API JSON (/api/v1, SCIM) refusent tout corps de requête qui n’est pas du JSON (415).',
                en: 'JSON APIs (/api/v1, SCIM) refuse any request body that is not JSON (415).',
                evidence: ['src/middleware/jsonContentType.js'],
                tests: ['asvsHeaders.test.js'],
            },
            {
                id: 'csrf',
                fr: 'Jeton anti-CSRF sur chaque formulaire et appel qui modifie des données ; contrôle de l’origine sur toute requête qui modifie des données (une origine « null » est refusée).',
                en: 'Anti-CSRF token on every form and call that changes data; an origin check on every state-changing request (a "null" origin is refused).',
                evidence: ['server.js', 'src/middleware/httpHardening.js'],
                tests: ['webSecurityBaseline.test.js', 'httpHardening.test.js'],
            },
            {
                id: 'xss',
                fr: 'Échappement systématique des sorties ; les zones à risque XSS sont vérifiées par des tests.',
                en: 'Output escaped by default; XSS-prone sinks are checked by tests.',
                evidence: ['views/partials/json-script.ejs'],
                tests: ['c317-C-dom-xss.test.js', 'reauditXssSinks.test.js'],
            },
            {
                id: 'injection',
                fr: 'Requêtes SQL paramétrées ; exports CSV et Excel protégés contre l’injection de formules.',
                en: 'Parameterised SQL queries; CSV and Excel exports protected against formula injection.',
                evidence: ['src/database/PostgresDatabase.js', 'src/utils/csvSafe.js'],
                tests: ['csvSafe.test.js', 'sqlIdentifierIntegrity.test.js'],
            },
            {
                id: 'ssrf',
                fr: 'Webhooks et fournisseurs d’IA : les adresses internes, locales et de métadonnées sont refusées (un modèle d’IA hébergé sur site doit être autorisé nommément par un super-administrateur) ; connexion épinglée sur l’adresse vérifiée, sans redirection.',
                en: 'Webhooks and AI providers: internal, loopback and metadata addresses are refused (an on-premises AI model must be allowed by name by a super-administrator); the connection is pinned to the checked address, with no redirect.',
                evidence: ['src/services/WebhookService.js', 'src/services/CopilotService.js'],
                tests: [
                    'securityControls.test.js',
                    'copilotPresetsAndEmails.test.js',
                    'copilotEgressGate.test.js',
                ],
            },
            {
                id: 'uploads',
                fr: 'Fichiers importés contrôlés sur chaque route de dépôt : le contenu doit correspondre à l’extension (signature binaire, types OOXML, macros refusées), taille et nombre d’entrées plafonnés (anti « zip bomb »), erreurs d’analyse renvoyées en erreur client ; cellules échappées à l’affichage ; logo SVG servi sous une politique qui interdit tout script.',
                en: 'Uploaded files checked on every upload route: the content must match the extension (magic bytes, OOXML content types, macros refused), size and entry count capped (zip-bomb protection), parser errors answered as client errors; cell values escaped on display; an SVG logo is served under a policy that forbids any script.',
                evidence: [
                    'src/utils/importGuards.js',
                    'src/utils/fileSignature.js',
                    'src/middleware/uploadGuard.js',
                    'src/routes/index.js',
                ],
                tests: [
                    'securityAudit20260929.test.js',
                    'asvsHeaders.test.js',
                    'uploadFileSignature.test.js',
                    'uploadGuardMounts.test.js',
                ],
            },
            {
                id: 'redirects',
                fr: 'Redirections limitées au site ; liens de réinitialisation construits depuis l’adresse configurée, jamais depuis l’en-tête Host.',
                en: 'Redirects restricted to the site; reset links built from the configured address, never the Host header.',
                evidence: ['src/utils/safeRedirect.js', 'src/controllers/AuthController.js'],
                tests: ['safeRedirect.test.js', 'emailLinkOrigin.test.js'],
            },
            {
                id: 'limits',
                fr: 'Taille des requêtes bornée et limitation du débit des actions coûteuses.',
                en: 'Request size capped and expensive actions rate limited.',
                evidence: ['server.js', 'src/middleware/rateLimiter.js'],
                tests: ['webSecurityBaseline.test.js', 'loginRateLimiterCountsFailures.test.js'],
            },
        ],
    },
    {
        id: 'data',
        icon: 'fa-database',
        title: { fr: 'Protection des données et RGPD', en: 'Data protection and GDPR' },
        controls: [
            {
                id: 'encryption',
                fr: 'Secrets stockés (MFA, SSO, LMS, SMTP, fournisseur d’IA, webhooks, connecteurs SIRH) chiffrés en AES-256-GCM sous une clé dérivée d’APP_KEY, format versionné ; démarrage refusé en production sans APP_KEY robuste ; secrets jamais copiés dans les instantanés ; rotation outillée.',
                en: 'Stored secrets (MFA, SSO, LMS, SMTP, AI provider, webhooks, HRIS connectors) encrypted with AES-256-GCM under a key derived from APP_KEY, in a versioned format; production refuses to start without a strong APP_KEY; secrets never copied into snapshots; tooled key rotation.',
                evidence: [
                    'src/utils/secretBox.js',
                    'src/services/MfaService.js',
                    'src/models/AppSettingsModel.js',
                    'src/services/SnapshotService.js',
                    'scripts/rotate-app-key.js',
                ],
                tests: [
                    'securityControls.test.js',
                    'installerSecretChannel.test.js',
                    'secretBoxV2.test.js',
                    'appSettingsSecrets.test.js',
                    'snapshotSecrets.test.js',
                    'rotateAppKey.test.js',
                ],
            },
            {
                id: 'hris-sync',
                fr: 'Synchronisation SIRH (CSV déposé, Personio, Lucca) : identifiants chiffrés au repos et jamais réaffichés, modifiables seulement après une connexion récente ou le mot de passe actuel ; appels sortants limités aux adresses https publiques (adresses internes refusées, connexion épinglée, sans redirection, avec délai d’expiration) ; essai à blanc avant toute application ; au-delà de 10 % de départs en une exécution (seuil réglable), rien n’est appliqué et les super-administrateurs sont alertés ; chaque exécution et chaque action sont journalisées.',
                en: 'HRIS synchronisation (dropped CSV, Personio, Lucca): credentials encrypted at rest and never shown again, changeable only after a recent sign-in or with the current password; outbound calls limited to public https addresses (internal addresses refused, connection pinned, no redirect, with a timeout); a dry run before anything is applied; above 10% leavers in one run (configurable), nothing is applied and the super-administrators are alerted; every run and every action is logged.',
                evidence: [
                    'src/services/HrisSyncService.js',
                    'src/integrations/hris/http.js',
                    'src/integrations/hris/planner.js',
                ],
                tests: [
                    'hrisConnectors.test.js',
                    'hrisPlanner.test.js',
                    'hrisSync-db.test.js',
                    'hrisRoutesAndScim.test.js',
                ],
            },
            {
                id: 'audit',
                fr: 'Journal d’audit en ajout seul, chaîné par hachage et ancré chaque jour : toute altération est détectable.',
                en: 'Append-only, hash-chained audit trail anchored daily: any tampering is detectable.',
                evidence: ['src/middleware/activityTrail.js', 'src/jobs/audit-anchor.js'],
                tests: ['c317-O-ops2-audit-anchor.test.js', 'c317-O-ops2-audit-owner.test.js'],
            },
            {
                id: 'security-events',
                fr: 'Événements de sécurité journalisés (connexions réussies et refusées, verrouillage, double authentification, droits, clés d’API, ré-authentification, refus d’accès) sans aucun secret dans les journaux.',
                en: 'Security events logged (sign-in success and failure, lockout, two-factor, permissions, API keys, re-authentication, access denials) with no secret in the logs.',
                evidence: ['src/services/LogService.js', 'src/middleware/logger.js'],
                tests: ['asvsLogging.test.js'],
            },
            {
                id: 'gdpr',
                fr: 'Export et effacement RGPD avec gel juridique ; l’effacement survit à une restauration ; purge selon la durée de conservation.',
                en: 'GDPR export and erasure with legal hold; erasure survives a restore; purge by retention period.',
                evidence: ['src/services/DSRService.js'],
                tests: [
                    'lotE-dashboard-dsr.test.js',
                    'c317-P-privacy-retention.test.js',
                    'snapshotRestoreProtectsJournals.test.js',
                ],
            },
            {
                id: 'confidential',
                fr: 'Données de talent confidentielles (9-box, risque de départ) protégées ; petits groupes masqués dans les statistiques.',
                en: 'Confidential talent data (9-box, flight risk) protected; small groups suppressed in statistics.',
                evidence: [
                    'src/services/TalentConfidentialityService.js',
                    'src/services/AnonymizationService.js',
                ],
                tests: [
                    'nineBoxEmployeeVisibility.test.js',
                    'anonymizationService.test.js',
                    'recognitionFeedScope.test.js',
                ],
            },
            {
                id: 'feedback-privacy',
                fr: 'Feedback 360° anonyme : une réponse est enregistrée sans identité ni horodatage de l’évaluateur ; les groupes de collègues, collaborateurs et autres ne sont montrés que regroupés à partir de 3 réponses (un groupe de 2 n’est jamais montré) ; commentaires sans nom et mélangés. Notes privées des entretiens individuels lisibles par leur seul auteur, administrateurs compris.',
                en: 'Anonymous 360° feedback: a response is stored with no rater identity or timestamp; peer, direct-report and other groups are only shown aggregated from 3 answers (a group of 2 is never shown); comments without names, shuffled. One-to-one private notes readable by their author only, administrators included.',
                evidence: [
                    'src/services/Feedback360Report.js',
                    'src/services/Feedback360Service.js',
                    'src/services/OneOnOneService.js',
                    'db/postgres/161_feedback_360.sql',
                ],
                tests: [
                    'feedback360Report.test.js',
                    'feedback360-db.test.js',
                    'oneOnOne-db.test.js',
                ],
            },
            {
                id: 'privacy-rights',
                fr: 'Notice d’information versionnée (français et anglais) dont chaque personne connectée prend connaissance ; téléchargement de ses données depuis « Ce qui est enregistré sur moi », limité et journalisé ; opposition au profilage : plus de score de risque de départ, plus de nom dans les détenteurs uniques ni dans les classements du copilote, actions automatiques soumises à une décision humaine.',
                en: 'Versioned privacy notice (French and English) acknowledged by every signed-in person; a download of one’s own data from "What is recorded about me", rate-limited and logged; objection to profiling: no retention-risk score, no name among sole holders or in the copilot’s rankings, automatic actions held for a human decision.',
                evidence: [
                    'src/services/PrivacyService.js',
                    'src/middleware/privacyNotice.js',
                    'src/controllers/PrivacyController.js',
                    'db/postgres/165_privacy_notice_objection.sql',
                ],
                tests: [
                    'privacy-db.test.js',
                    'privacyNoticeGate.test.js',
                    'privacyObjectionSurfaces.test.js',
                    'retentionObjectionJob.test.js',
                ],
            },
            {
                id: 'erasure-registry',
                fr: 'Effacement complet piloté par le schéma : chaque colonne qui désigne un salarié et chaque autre table sont classées, un test échoue sur toute table nouvelle non classée ; fichiers déposés supprimés ; sous gel juridique, effacement refusé sauf dérogation motivée approuvée par un second super-administrateur ; notifications non lues et candidatures refusées purgées.',
                en: 'Complete, schema-driven erasure: every column that points at an employee and every other table is classified, and a test fails on any new unclassified table; uploaded files deleted; under legal hold, erasure refused unless a reasoned override is approved by a second super-administrator; unread notifications and rejected applicants pruned.',
                evidence: [
                    'src/services/erasureRegistry.js',
                    'src/services/DSRService.js',
                    'src/services/MaintenanceService.js',
                    'db/postgres/166_erasure_override_requests.sql',
                    'src/jobs/telemetry-prune.js',
                ],
                tests: ['erasureRegistry-db.test.js', 'erasureOverrideSurface.test.js'],
            },
            {
                id: 'transparency',
                fr: 'Registre pour les représentants du personnel et page « Ce qui est enregistré sur moi » pour chaque salarié.',
                en: 'Register for employee representatives and a "What is recorded about me" page for every employee.',
                evidence: ['src/services/ComplianceRegisterService.js'],
                tests: ['teamApprovalRuleAndRegister.test.js'],
            },
        ],
    },
    {
        id: 'ai',
        icon: 'fa-robot',
        title: { fr: 'IA responsable (AI Act européen)', en: 'Responsible AI (EU AI Act)' },
        controls: [
            {
                id: 'ai-off',
                fr: 'Copilote désactivé par défaut ; un fournisseur d’IA externe reste bloqué tant qu’un super-administrateur n’a pas enregistré la base juridique du transfert et l’accord de sous-traitance ; noms et identifiants anonymisés avant tout envoi à un modèle externe.',
                en: 'Copilot off by default; an external AI provider stays blocked until a super-administrator records the legal basis of the transfer and the processor agreement; names and identifiers anonymised before anything reaches an external model.',
                evidence: [
                    'src/services/CopilotService.js',
                    'src/services/AnonymizationService.js',
                    'src/controllers/CopilotEgressController.js',
                ],
                tests: ['copilotPrivacyFilter.test.js', 'copilotEgressGate.test.js'],
            },
            {
                id: 'ai-guardrails',
                fr: 'Mention « aide à la décision » sur chaque réponse, aucun classement nominatif par défaut, fournisseurs UE uniquement par défaut, supervision humaine journalisée.',
                en: '"Decision support" label on every answer, no named-person ranking by default, EU-only providers by default, human oversight logged.',
                evidence: ['src/services/CopilotService.js'],
                tests: ['copilotEuAiActGuardrails.test.js', 'c317-H-analytics-copilot.test.js'],
            },
            {
                id: 'companion',
                fr: 'Assistant intégré : fonctionne sans IA externe ; il ne montre que les écrans et les données autorisés à l’utilisateur ; aucune donnée personnelle n’est envoyée à un modèle ; les questions sont journalisées sous forme d’empreinte.',
                en: 'Built-in assistant: works without external AI; shows only the screens and data the user may access; no personal data is sent to a model; questions are logged as a hash.',
                evidence: ['src/services/CompanionService.js', 'src/config/companionKnowledge.js'],
                tests: ['companionService.test.js'],
            },
        ],
    },
    {
        id: 'ops',
        icon: 'fa-server',
        title: { fr: 'Exploitation et chaîne logicielle', en: 'Operations and supply chain' },
        controls: [
            {
                id: 'secrets-required',
                fr: 'En production, démarrage refusé sans secrets forts ; aucun mot de passe par défaut livré.',
                en: 'In production, start-up refused without strong secrets; no default password ships.',
                evidence: ['src/config/app.js', 'src/utils/bootstrapAdmin.js'],
                tests: ['bootstrapAdmin.test.js', 'c317-D-ops-security-installer.test.js'],
            },
            {
                id: 'safe-defaults',
                fr: 'Réglages sûrs par défaut : inscription publique, classement nominatif par l’IA et notifications désactivés à l’installation ; les réglages de sécurité (authentification, sessions, SSO, conservation, IA, serveur de messagerie, SIRH) ne sont modifiables que par un super-administrateur ; envoi des e-mails chiffré (TLS exigé, un seul relais interne peut en être dispensé, nommé et motivé par un super-administrateur).',
                en: 'Safe defaults: public signup, named-person AI ranking and notifications are off on a fresh install; security settings (authentication, sessions, SSO, retention, AI, mail server, HRIS) can be changed by a super-administrator only; outgoing mail encrypted (TLS required; one internal relay may be exempted, named with a reason by a super-administrator).',
                evidence: [
                    'src/models/AppSettingsModel.js',
                    'db/postgres/159_boolean_settings_repair.sql',
                    'src/utils/securitySettings.js',
                    'src/services/EmailService.js',
                ],
                tests: [
                    'booleanSettingsSeededOff.test.js',
                    'securityClassSettings.test.js',
                    'smtpRequireTls.test.js',
                ],
            },
            {
                id: 'sql-console',
                fr: 'Console SQL désactivée sauf activation explicite par l’exploitant (séparation des tâches) ; elle ne lit ni ne modifie jamais les secrets (sessions, seconds facteurs, jetons, empreintes, identifiants SIRH, réglages secrets) : refus audité, puis rôle de lecture sans droit sur les colonnes secrètes.',
                en: 'SQL console off unless the operator explicitly enables it (separation of duties); it never reads or changes secrets (sessions, second factors, tokens, hashes, HRIS credentials, secret settings): audited refusal, then a read role with no right on secret columns.',
                evidence: [
                    'src/middleware/sqlConsoleEnabled.js',
                    'src/services/SqlConsoleService.js',
                    'db/postgres/167_console_reader_role.sql',
                ],
                tests: [
                    'sqlConsoleSeparationOfDuties.test.js',
                    'sqlConsoleTamperGuard.test.js',
                    'sqlConsoleSecretGuard-db.test.js',
                    'migration167ConsoleReaderRole-db.test.js',
                ],
            },
            {
                id: 'backups',
                fr: 'Sauvegardes quotidiennes avec contrôle d’accès et exercices de restauration.',
                en: 'Daily backups with access control and restore drills.',
                evidence: ['scripts/Verify-BackupRestore.ps1'],
                tests: [
                    'c317-D-ops-security-backup-acl.test.js',
                    'installerRestoreAndPatchProof.test.js',
                ],
            },
            {
                id: 'container',
                fr: 'Image Docker exécutée sans privilèges root ; Compose refuse de démarrer sans secrets réels.',
                en: 'Docker image runs as a non-root user; Compose refuses to start without real secrets.',
                evidence: ['Dockerfile', 'docker-compose.yml'],
                tests: ['securityControls.test.js'],
            },
            {
                id: 'no-cdn',
                fr: 'Aucune dépendance à un CDN : polices, icônes et scripts sont hébergés par l’application.',
                en: 'No CDN dependency: fonts, icons and scripts are served by the application itself.',
                evidence: ['public/vendor/fonts/plus-jakarta-sans/OFL.txt'],
                tests: ['brandTokensAbsent.test.js'],
            },
            {
                id: 'ci',
                fr: 'Intégration continue sur PostgreSQL 16, 17 et 18 : lint, format et suite de tests complète à chaque modification.',
                en: 'Continuous integration on PostgreSQL 16, 17 and 18: lint, format and the full test suite on every change.',
                evidence: ['.github/workflows/ci.yml'],
                tests: [],
            },
            {
                id: 'supply-chain-gates',
                fr: 'Chaîne d’approvisionnement contrôlée à chaque modification : analyse statique CodeQL, revue des dépendances (vulnérabilités graves et licences incompatibles AGPL bloquées), npm audit, recherche de secrets dans tout l’historique git, Trivy sur le code et l’image, SBOM CycloneDX et actions CI épinglées par empreinte.',
                en: 'Supply chain checked on every change: CodeQL static analysis, dependency review (high-severity vulnerabilities and AGPL-incompatible licences blocked), npm audit, secret scanning of the full git history, Trivy on the code and the image, a CycloneDX SBOM and CI actions pinned by commit hash.',
                evidence: [
                    '.github/workflows/codeql.yml',
                    '.github/workflows/dependency-review.yml',
                    '.github/workflows/secret-scan.yml',
                    '.github/workflows/supply-chain.yml',
                    '.github/workflows/scorecard.yml',
                    '.github/dependabot.yml',
                    '.gitleaks.toml',
                    'scripts/security-check.js',
                    'docs/SECURITY-SUPPLY-CHAIN.md',
                ],
                tests: ['supplyChainHardening.test.js'],
            },
            {
                id: 'upload-malware-scan',
                fr: 'Analyse antivirus des justificatifs déposés : ClamAV (réseau ou socket), sinon Microsoft Defender, sinon fichier marqué « non analysé » sans bloquer l’application ; un fichier non analysé n’est téléchargeable que par son déposant, la ligne hiérarchique et les RH, toujours en pièce jointe ; nouvelle analyse planifiée.',
                en: 'Antivirus scan of uploaded evidence: ClamAV (network or socket), else Microsoft Defender, else the file is marked "not scanned" without blocking the application; an unscanned file is downloadable only by its uploader, the reporting line and HR, always as an attachment; scheduled rescan.',
                evidence: [
                    'src/services/MalwareScanService.js',
                    'db/postgres/164_malware_scan_chain.sql',
                    'src/jobs/index.js',
                ],
                tests: ['malwareScanChain.test.js', 'migration164MalwareScan-db.test.js'],
            },
            {
                id: 'installer-integrity',
                fr: 'Installateur Windows : téléchargements épinglés par empreinte SHA-256 et signature de l’éditeur (échec fermé) ; aucune fenêtre « trust » PostgreSQL ouverte sans consentement, chaque ouverture journalisée ; mots de passe jamais en ligne de commande ; alertes sur les lignes « trust » et l’horloge ; paquet sans fichier hors liste ni ligne secrète.',
                en: 'Windows installer: downloads pinned by SHA-256 and publisher signature (fail closed); no PostgreSQL "trust" window opened without consent, every opening logged; passwords never on a command line; warnings on "trust" lines and the clock; a package with no unlisted file and no secret row.',
                evidence: [
                    'installer/Install-IDevelop.ps1',
                    'installer/Manage-IDevelop.ps1',
                    'installer/Build-Package.ps1',
                    'installer/config.psd1',
                ],
                tests: ['installerIntegrityAndTrust.test.js'],
            },
            {
                id: 'container-hardening',
                fr: 'Conteneurs durcis selon le CIS Docker Benchmark : image de base épinglée par empreinte, système de fichiers en lecture seule, aucune capacité Linux, no-new-privileges, limites de ressources et base de données non exposée à l’hôte.',
                en: 'Containers hardened per the CIS Docker Benchmark: base image pinned by digest, read-only filesystem, no Linux capabilities, no-new-privileges, resource limits and a database not exposed to the host.',
                evidence: ['Dockerfile', 'docker-compose.yml', '.dockerignore'],
                tests: ['supplyChainHardening.test.js'],
            },
        ],
    },
];

/**
 * OWASP ASVS 4.0.3 level 2 self-assessment, as counted in docs/ASVS-L2.md.
 * tests/unit/asvsL2Document.test.js recounts the document's rows and fails
 * when these figures (shown on About → Security) drift from it.
 */
const ASVS_L2 = {
    version: '4.0.3',
    level: 2,
    total: 258,
    pass: 167,
    fixed: 17,
    partial: 38,
    gap: 2,
    na: 29,
    notVerified: 5,
};

/**
 * Standards the product's controls are mapped to. `basis` is 'self-assessed'
 * (requirement by requirement) or 'mapped' (controls mapped to the framework's
 * items); none of them is a certification. The About page writes each line
 * with its own literal translation key; `doc` is where the detail lives.
 */
const FRAMEWORKS = [
    {
        id: 'asvs',
        name: 'OWASP ASVS 4.0.3 — Level 2',
        basis: 'self-assessed',
        doc: 'docs/ASVS-L2.md',
    },
    {
        id: 'top10',
        name: 'OWASP Top 10 (2021)',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
    { id: 'cwe', name: 'CWE Top 25 (2024)', basis: 'mapped', doc: 'docs/COMPLIANCE-MAPPING.md' },
    {
        id: 'iso27001',
        name: 'ISO/IEC 27001:2022 Annex A',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
    {
        id: 'soc2',
        name: 'SOC 2 (CC6, CC7, CC8)',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
    {
        id: 'gdpr',
        name: 'GDPR (Articles 5, 15–17, 25, 30, 32, 35)',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
    {
        id: 'aiact',
        name: 'EU AI Act (Articles 13, 14)',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
    {
        id: 'ssdf',
        name: 'NIST SSDF (SP 800-218)',
        basis: 'mapped',
        doc: 'docs/COMPLIANCE-MAPPING.md',
    },
];

/** Controls and categories in one language, for rendering. */
function postureFor(lang) {
    const l = String(lang || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr';
    return CATEGORIES.map((c) => ({
        id: c.id,
        icon: c.icon,
        title: c.title[l],
        controls: c.controls.map((x) => ({
            id: x.id,
            text: x[l],
            evidence: x.evidence,
            tests: x.tests,
        })),
    }));
}

function totals() {
    const controls = CATEGORIES.reduce((n, c) => n + c.controls.length, 0);
    const suites = new Set();
    for (const c of CATEGORIES) for (const x of c.controls) x.tests.forEach((t) => suites.add(t));
    return { categories: CATEGORIES.length, controls, suites: suites.size };
}

module.exports = { CATEGORIES, ASVS_L2, FRAMEWORKS, postureFor, totals };
