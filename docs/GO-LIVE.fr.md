# Liste de contrôle de la mise en service

Cette page s’adresse à celles et ceux qui ouvrent une instance IDevelop à toute
l’organisation : le chef de projet RH, le SuperAdmin et l’exploitant
informatique. Elle dit ce qui doit être vrai avant la première vraie campagne,
dans l’ordre où on le fait d’habitude, et se termine par la réinitialisation de
mise en service qui vide les données d’essai. English version:
[GO-LIVE.md](GO-LIVE.md).

Pages liées (en anglais) : [OPERATIONS.md](OPERATIONS.md) (exploiter le
serveur), [BACKUPS.md](BACKUPS.md) (clés et restaurations),
[ROLLBACK.md](ROLLBACK.md) (revenir en arrière après une mise à jour),
[INCIDENT-RESPONSE.fr.md](INCIDENT-RESPONSE.fr.md) (incidents de sécurité et
violations de données personnelles), [SIZING.md](SIZING.md) et
[POWERBI.fr.md](POWERBI.fr.md).

Recopiez la liste dans votre plan de projet. Les délais entre crochets (J-20 :
vingt jours ouvrés avant le jour d’ouverture) sont indicatifs.

## 1. La plateforme (exploitant, J-20)

- [ ] Le serveur est installé depuis le paquet de la version (Windows :
      `Setup.bat` ; Linux ou Docker : [README.md](../README.md#quick-start)).
      Sous Windows, la version a été répétée sur une machine virtuelle
      ([installer/README.md](../installer/README.md), « Release rehearsal on a
      Windows VM »).
- [ ] L’adresse publique est en HTTPS avec un certificat reconnu, et
      `appBaseUrl` (Paramètres de l’application) ou `APP_BASE_URL` la donne :
      les liens de création de mot de passe des invitations l’utilisent.
      Derrière un proxy inverse, `TRUST_PROXY` nomme le proxy et
      `COOKIE_SECURE=1` est posé.
- [ ] `SESSION_SECRET` et `APP_KEY` sont de longues valeurs aléatoires, rangées
      dans votre coffre à secrets. Le démarrage en production refuse les
      valeurs faibles.
- [ ] La clé des sauvegardes a une copie de secours hors ligne, rangée à part
      des sauvegardes (Windows : `node scripts/backup-key.js export --out <fichier>` ;
      Linux et Docker : la ligne `APP_KEY`). Voir [BACKUPS.md](BACKUPS.md).
- [ ] `BACKUP_OFFHOST_DIR` désigne un stockage sur une autre machine, et un
      exercice de restauration a été fait sur une base jetable
      ([OPERATIONS.md](OPERATIONS.md#restore-drill)).
- [ ] Le serveur de messagerie sortant utilise TLS, un message de test est
      arrivé, et `mailDefaultLanguage` est la langue que lisent la plupart des
      personnes.
- [ ] Administration › Santé de l’instance (`/admin/health`) n’affiche ni
      migration en attente ni tâche en échec.

## 2. Le contenu (chef de projet RH, J-15)

Le bloc « Premiers pas » de `/setup` les reprend ; chaque ligne mène à la page
qui la complète.

- [ ] Modules : seuls les modules utilisés sont activés (`/admin/modules`).
- [ ] Organisation : sites, départements et services.
- [ ] Référentiel de compétences, postes et leurs exigences, avec les
      compétences critiques signalées.
- [ ] Les personnes, chacune avec un poste, un site et quelqu’un qui l’évalue.
- [ ] Une campagne d’essai a été menée de bout en bout sur un petit groupe
      pilote : autoévaluation, revue, contestation, plan de développement.

## 3. « Prêt pour la mise en service » sur `/setup` (SuperAdmin, J-10)

Le second bloc de `/setup` mesure l’instance à l’ouverture de la page. Chaque
ligne est une mesure ou une décision que vous avez prise :

| État                          | Sens                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Fait                          | Mesuré maintenant, plus rien à faire.                                                      |
| À faire                       | Mesuré maintenant ; le compte dit ce qui reste.                                            |
| Rien à mesurer pour l’instant | Aucune population à mesurer (par exemple personne dans le périmètre du lecteur).           |
| Non mesuré                    | La source n’a pas pu être lue. Jamais compté comme fait : trouvez pourquoi avant d’ouvrir. |
| Décision                      | Un choix que vous avez fait. Rapporté, jamais noté.                                        |

| Ligne                                        | Ce qu’elle compte                                                              | Où on la traite        |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| Règles d’habilitation sécurité des postes    | postes actifs avec exigences et sans règle d’habilitation sécurité active      | `/safety-gate/config`  |
| Postes critiques et leurs successeurs        | postes critiques, puis ceux sans successeur actif (module talents seulement)   | `/v2/continuity`       |
| Compétences critiques signalées              | exigences de poste marquées critiques                                          | `/roles`               |
| Tout le monde mesurable                      | personnes dont le poste n’a aucune exigence                                    | `/roles`               |
| Cibles des indicateurs décidées              | indicateurs qui ont une cible                                                  | `/kpi/targets`         |
| Second facteur pour chaque administrateur    | comptes administrateurs actifs sans second facteur confirmé                    | `/admin/access-review` |
| Accès des administrateurs revus ce trimestre | administrateurs (hors SuperAdmins) dont l’accès n’est pas attesté ce trimestre | `/admin/access-review` |
| Notice de confidentialité publiée            | versions publiées de la notice                                                 | `/compliance/register` |
| Dernière sauvegarde vérifiée                 | la date de la dernière sauvegarde de nuit dont la vérification a réussi        | `/admin/health`        |
| Authentification unique                      | décision : activée ou non                                                      | `/app-settings/sso`    |
| Mode poste partagé                           | décision : activé ou non                                                       | `/app-settings`        |
| Contenu local (chiffres de nationalité)      | décision : activé ou non                                                       | `/admin/modules`       |

Les administrateurs locaux peuvent ouvrir la page en lecture seule : leurs
comptes de personnes sont ceux de leur périmètre, une ligne ne mène qu’à une
page qu’ils peuvent ouvrir, et seul un SuperAdmin masque le bandeau. Demandez à
l’administrateur local de chaque site de la lire avant le jour d’ouverture.

- [ ] Chaque ligne notée dit « Fait », ou le chef de projet a écrit pourquoi
      une ligne reste « À faire » et qui la traitera.
- [ ] Aucune ligne ne dit « Non mesuré ».

## 4. Décisions à consigner (chef de projet et SuperAdmin, J-10)

Consignez chaque choix au dossier de projet avec sa date et son auteur. Tous se
règlent dans les Paramètres de l’application sauf mention contraire ; ceux de
gouvernance sont réservés au SuperAdmin.

| Paramètre                                                  | Valeur d’une nouvelle installation | Question à trancher                                                                                    |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Qui peut agir sur une personne (`authority.ladder`)        | `strict`                           | La hiérarchie au-dessus du manager direct, et les administrateurs locaux, agissent-ils ou lisent-ils ? |
| Quatre yeux sur la 9-box (`nineBoxFourEyes`)               | activé                             | Chaque équipe a-t-elle un second approbateur pour les placements 9-box ?                               |
| Contestation — finalisation automatique à l’échéance       | désactivé                          | Qui détient `arbitrate_disputes` et tranche à temps les contestations de niveau 2 ?                    |
| Plans d’amélioration — visa RH avant activation            | désactivé                          | Les RH doivent-elles voir chaque plan d’amélioration avant son lancement ?                             |
| Points « Ce qui a changé » (`personaDigestsEnabled`)       | désactivé                          | Les personnes recevront-elles le point hebdomadaire par courriel ?                                     |
| « Nouveau dans le poste » (`newInRoleMonths`)              | 6                                  | Combien de mois une personne est-elle signalée comme nouvelle dans son poste ?                         |
| Purge de conservation (`retentionPurgeMode`)               | `report`                           | Quand la purge passe-t-elle du simple rapport à `apply` ?                                              |
| Authentification unique, mode poste partagé, contenu local | désactivé                          | Comme rapporté sur `/setup`.                                                                           |

- [ ] Les personnes qui décident des cibles d’indicateurs détiennent
      `manage_kpi_targets`, et celles qui peuvent lire les chiffres de
      nationalité détiennent `view_local_content`. Aucun profil d’accès ne les
      donne par défaut.

## 5. Confidentialité et gouvernance (référent protection des données, J-10)

- [ ] La notice de confidentialité est publiée (FR et EN là où les deux sont
      lues) ; chacun en prend connaissance à sa prochaine connexion.
- [ ] L’analyse d’impact relative à la protection des données couvre les
      évaluations, la 9-box, les plans d’amélioration et tout usage de
      l’assistant. Les représentants du personnel ont été consultés là où
      votre droit national le demande.
- [ ] Le registre des activités de traitement mentionne IDevelop ; le registre
      de conformité (`/compliance/register`) est un point de départ, pas le
      registre lui-même.
- [ ] La procédure d’incident et de violation est connue des personnes qu’elle
      désigne ([INCIDENT-RESPONSE.fr.md](INCIDENT-RESPONSE.fr.md)), avec leurs
      coordonnées renseignées.

## 6. La réinitialisation de mise en service (SuperAdmin avec l’exploitant, J-2)

La réinitialisation vide les données de l’essai pour que la première vraie
campagne parte de zéro. Elle **garde** l’organisation, le référentiel (postes,
exigences, politiques, règles de couverture), la liste des personnes, les
comptes administrateurs avec leurs facteurs de connexion et leurs clés d’API,
les paramètres, la piste d’audit et le registre des demandes relatives aux
données personnelles. Elle **vide** les évaluations, campagnes, revues,
contestations, plans de développement et propositions, plans d’amélioration et
leurs points d’étape, placements 9-box, comptes rendus de fin de campagne,
décisions de séance et dossiers enregistrés, notifications et les autres données
d’exploitation. Le fichier `.env` n’est jamais modifié.

1. Prévenez le groupe pilote que ses données d’essai vont disparaître.
2. Lisez d’abord le plan. C’est une simulation qui ne change rien :
   `node scripts/reset-for-golive.js` (ou `npm run db:reset:golive`). Il liste
   chaque table gardée et chaque table vidée, avec leur nombre de lignes. Une
   table qui ne figure dans aucune des deux listes arrête l’exécution :
   signalez-la comme un défaut, ne la contournez pas.
3. Lancez-la. Sous Windows, l’option **R** de `Setup.bat` affiche le même plan,
   demande de taper `PRODUCTION`, prend un point de restauration et lance la
   réinitialisation. Ailleurs :

    ```bash
    node scripts/reset-for-golive.js --confirm --confirm-word=PRODUCTION
    ```

    Sans le mot tapé, ou avec un autre, le script s’arrête avant de lire quoi
    que ce soit. Il prend une copie `pg_dump` dans `backups/` avant de vider
    quoi que ce soit ; `--skip-backup` est réservé à une copie jetable.

4. Vérifiez : `/setup` montre toujours l’organisation, le référentiel et les
   personnes ; le tableau de bord dit « pas encore évalué » au lieu de
   chiffres ; un compte de test se connecte.
5. Gardez le point de restauration ou la copie jusqu’à ce que la première
   campagne soit ouverte sans incident, puis supprimez-la comme toute autre
   copie de données RH.

« Réinitialiser les valeurs par défaut » sur la page des paramètres est une
autre action : elle remet les paramètres, pas les données, et demande de taper
`RÉINITIALISER` (ou `RESET`). Aucune des deux n’est nécessaire pour une mise à
jour.

## 7. Le jour d’ouverture et la première semaine (tout le monde)

- [ ] La première campagne est ouverte et annoncée (les invitations partent
      avec les liens de création de mot de passe si les personnes n’utilisent
      pas l’authentification unique).
- [ ] Chaque matin de la première semaine, le SuperAdmin lit la Santé de
      l’instance et les notifications de tâches en échec, et le chef de projet
      RH lit « Qualité des données » (`/admin/data-quality`) et « Usage par
      site » (`/admin/usage`).
- [ ] À la fin de la première semaine, le chef de projet et le SuperAdmin
      constatent que l’instance est en exploitation normale ; à partir de là,
      [OPERATIONS.md](OPERATIONS.md) s’applique.

## Validation

| Rôle                            | Nom | Date | Signature |
| ------------------------------- | --- | ---- | --------- |
| Chef de projet RH               |     |      |           |
| SuperAdmin                      |     |      |           |
| Exploitant informatique         |     |      |           |
| Référent protection des données |     |      |           |
