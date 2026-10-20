# Incidents de sécurité et violations de données personnelles

Cette procédure s’adresse à l’organisation qui exploite IDevelop : le
responsable de l’incident, le référent protection des données, les SuperAdmins
et l’exploitant informatique. Elle dit qui décide quoi, comment conserver les
preuves que détient IDevelop, et comment tenir le délai de 72 heures pour
notifier une violation de données personnelles. Adaptez-la à votre propre
politique d’incident et renseignez les contacts avant la mise en service
([GO-LIVE.fr.md](GO-LIVE.fr.md), section 5). English version:
[INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md).

IDevelop contient des données RH : évaluations, plans de développement et
d’amélioration, contestations, placements 9-box, certificats et, quand le module
de contenu local est activé, la nationalité. Leur fuite peut nuire aux
personnes concernées. Traitez tout doute comme un incident jusqu’à preuve du
contraire.

Une vulnérabilité du logiciel IDevelop lui-même se signale au projet comme
l’indique [SECURITY.md](../SECURITY.md), en plus de cette procédure.

## Qui fait quoi

| Rôle                                  | Qui dans votre organisation | Décide ou fait                                                                                                                                                               |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsable de l’incident             |                             | Ouvre et clôt l’incident, tient le journal, mobilise les autres, décide du confinement.                                                                                      |
| Responsable de traitement (direction) |                             | **Décide de notifier ou non** l’autorité de contrôle et les personnes concernées, sur avis du référent protection des données. L’organisation est responsable de traitement. |
| Référent protection des données (DPO) |                             | Évalue le risque pour les personnes, rédige les notifications, inscrit la violation au registre des violations, qu’elle soit notifiée ou non.                                |
| SuperAdmin (deux, jamais un seul)     |                             | Agit dans IDevelop : sessions, comptes, clés d’API, webhooks, paramètres, exports de la piste d’audit.                                                                       |
| Exploitant informatique               |                             | Agit sur le serveur : isolement, copies des journaux et des bases, renouvellement des secrets, restaurations.                                                                |
| Responsable RH et communication       |                             | Rédige le message aux salariés et aux représentants du personnel une fois la décision prise.                                                                                 |
| Hébergeur (le cas échéant)            |                             | En tant que sous-traitant, prévient le responsable de traitement d’une violation dans les meilleurs délais et aide à réunir les preuves.                                     |

Inscrivez les noms et deux moyens de joindre chaque personne (téléphone et une
adresse hors du système touché) dans la colonne vide, et gardez-en une copie
imprimée.

## Le délai

- **L’heure 0** est le moment où quelqu’un dans l’organisation a une certitude
  raisonnable qu’un incident de sécurité a touché des données personnelles.
  Notez-la en UTC.
- **Dans les 72 heures** suivant l’heure 0, le responsable de traitement
  notifie la violation à l’autorité de contrôle désignée par votre droit
  national, sauf si elle est peu susceptible d’engendrer un risque pour les
  personnes concernées. Si tout n’est pas encore connu, notifiez ce qui l’est
  et complétez ensuite ; motivez tout retard au-delà de 72 heures.
- **Dans les meilleurs délais**, quand le risque pour les personnes est élevé,
  le responsable de traitement les informe directement, en termes clairs : ce
  qui s’est passé, les conséquences probables, ce qui a été fait, ce qu’elles
  peuvent faire et qui contacter.
- **Toujours**, notifiée ou non, le référent protection des données inscrit la
  violation, ses effets et les mesures prises au registre des violations.

Le RGPD (articles 33 et 34) fixe ces règles dans l’Union européenne ; d’autres
droits en ont de semblables. Votre référent protection des données dit
lesquelles s’appliquent à vous.

## 1. Détecter et signaler

Signaux qu’IDevelop donne (chaque SuperAdmin les reçoit aussitôt) :

- notifications de sécurité : connexion par l’accès de secours, second facteur
  ou mot de passe d’un SuperAdmin modifié, compte administrateur verrouillé,
  connexion SSO refusée sur un compte SuperAdmin ;
- `ops.job_failed` : une tâche a échoué ou une tâche quotidienne n’a pas tourné
  depuis 36 heures (la sauvegarde, l’ancrage d’audit, les scellés d’audit) ;
- le contrôle de la chaîne d’audit dans les Journaux système signale une rupture
  (`brokenAt`) ;
- la sonde externe envoie un courriel quand l’application ne répond plus.

Signaux venus de l’extérieur : une personne qui voit des données qu’elle ne
devrait pas voir, un fichier de données RH trouvé là où il ne devrait pas être,
une clé d’API ou un webhook inconnu, un portable perdu avec une session
ouverte, une alerte de votre supervision.

Qui le remarque prévient aussitôt le responsable de l’incident, avec l’heure,
ce qu’il a vu et ce qu’il a déjà fait. Il ne change rien d’autre.

## 2. Confiner

Choisissez la plus petite action qui arrête le dommage. Chacune est tracée
dans IDevelop.

| Situation                                              | Action dans IDevelop                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Un compte est compromis                                | Administration › Sessions (`/admin/sessions`) : fermez ses sessions. Puis désactivez la personne (sessions, comptes administrateurs liés et clés d’API sont coupés ensemble), ou réinitialisez le mot de passe et le second facteur. |
| Un compte administrateur est compromis                 | Retirez son accès d’administration (`/admins/:id/revoke-access`) ou désactivez-le ; vérifiez ce qu’il a modifié dans les Journaux système.                                                                                           |
| Une clé d’API a fuité (un fichier Power BI, un script) | Administration › Clés API / Power BI : révoquez la clé, émettez-en une nouvelle à son titulaire.                                                                                                                                     |
| Des données sortent par un webhook                     | La page des webhooks (`/v2/cap/webhooks`) : désactivez l’abonnement.                                                                                                                                                                 |
| Des données partent vers l’assistant IA                | Paramètres de l’application : désactivez le copilote et révoquez la base de transfert.                                                                                                                                               |
| La console SQL est en cause                            | Retirez `SQL_CONSOLE_ENABLED` et redémarrez.                                                                                                                                                                                         |
| Le serveur lui-même est compromis                      | Coupez-le du réseau au proxy inverse ou au pare-feu. Ne l’éteignez pas avant que l’exploitant ait copié la mémoire et les disques si votre politique d’investigation le demande.                                                     |

Ne raccourcissez la durée de session ou n’activez le mode poste partagé que
s’ils aident pour cet incident ; notez les anciennes valeurs pour les remettre.

## 3. Conserver les preuves

Faites-le **avant** toute restauration, tout renouvellement ou tout nettoyage,
et notez au journal de l’incident qui a copié quoi, quand, et l’empreinte
SHA-256 de chaque copie.

| Preuve                                       | Comment la conserver                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La piste d’audit                             | Journaux système (`/system-logs`) : filtrez sur la période et les comptes concernés, puis exportez. Le détail d’une requête (`/system-logs/request/:id`) montre tout ce qu’elle a fait.                                                                                                                                      |
| La preuve que la piste d’audit est intacte   | Dans les Journaux système, lancez le contrôle de la chaîne (`GET /v2/cap/audit/verify`, SuperAdmin) et gardez sa réponse. Copiez `%ProgramData%\IDevelop\audit-anchors\chain-head.log` (Linux et Docker : `data/audit-anchors`) : il est écrit chaque jour hors de la base, donc une chaîne réécrite ne lui correspond plus. |
| La sortie de l’application                   | Copiez `<InstallDir>\service\logs` (Windows) ou les journaux du conteneur pour la période.                                                                                                                                                                                                                                   |
| La base telle qu’elle est maintenant         | Santé de l’instance › « Sauvegarder maintenant », ou un `pg_dump` de l’exploitant, chiffré ([BACKUPS.md](BACKUPS.md)). Gardez-la hors de la rotation quotidienne.                                                                                                                                                            |
| Les journaux du proxy inverse et du pare-feu | Votre équipe d’infrastructure.                                                                                                                                                                                                                                                                                               |

La piste d’audit ne contient jamais de mot de passe, de jeton ni de clé, et ses
textes libres sur une personne effacée sont caviardés par une entrée chaînée
que le contrôle accepte. Les preuves exportées sont elles-mêmes des données
personnelles : gardez-les en accès restreint, et seulement le temps que fixe
votre politique.

## 4. Évaluer

Répondez, et notez les réponses au journal de l’incident :

- Quelles données : quelles pages, quels exports, rapports, flux ou tables ;
  sur quelle période.
- Les données de qui : combien de personnes, quels sites. L’export d’accès
  d’une personne (`/v2/cap/dsr/:employeeId/export`, SuperAdmin) liste ce
  qu’IDevelop détient sur elle, y compris les textes de séance qui la nomment.
- Quelle sensibilité : les plans d’amélioration, les contestations, les
  placements 9-box, le risque de départ, les chiffres de nationalité et les
  habilitations sécurité pèsent plus qu’un nom et un intitulé de poste.
- Confidentialité, intégrité ou disponibilité : des données ont-elles été vues,
  modifiées ou perdues ? Pour une modification, la piste d’audit et le
  contrôle de la chaîne disent quoi et par qui.
- Est-ce toujours en cours ?

Le référent protection des données en tire un niveau de risque pour les
personnes concernées : peu probable, un risque, ou un risque élevé.

## 5. Décider et notifier

Le responsable de traitement décide, sur avis du référent protection des
données, et la décision est consignée avec ses motifs :

| Risque pour les personnes | Autorité de contrôle                          | Personnes concernées                   |
| ------------------------- | --------------------------------------------- | -------------------------------------- |
| Peu probable              | Pas de notification ; inscription au registre | Pas de message obligatoire             |
| Un risque                 | Dans les 72 heures suivant l’heure 0          | Selon votre politique                  |
| Un risque élevé           | Dans les 72 heures suivant l’heure 0          | Directement, dans les meilleurs délais |

Une notification à l’autorité indique : la nature de la violation, les
catégories et le nombre approximatif de personnes et d’enregistrements, le
contact du référent protection des données, les conséquences probables, et les
mesures prises ou envisagées. Utilisez le formulaire de l’autorité quand elle
en a un.

Les représentants du personnel sont informés comme le demandent votre droit
national et vos accords.

## 6. Rétablir

- **Secrets.** Renouvelez ce qui a pu être exposé : le mot de passe de la base,
  `APP_KEY` avec `scripts/rotate-app-key.js` (il rechiffre les secrets
  stockés ; lancez-le d’abord sans `--commit`, puis avec, puis redémarrez),
  `SESSION_SECRET` (toutes les sessions se ferment ; les empreintes des
  connexions échouées changent, voir [SECURITY-AUDIT.md](SECURITY-AUDIT.md),
  recommandation 10), le mot de passe SMTP, le secret client de
  l’authentification unique chez le fournisseur d’identité, les clés d’API et
  les secrets des webhooks.
- **Sauvegardes.** Les sauvegardes d’avant l’incident se lisent avec la clé
  qui les a écrites. Si cette clé a pu être copiée, traitez aussi ces
  sauvegardes comme exposées, et déplacez ou détruisez les copies que votre
  politique permet.
- **Données.** Si des données ont été modifiées, restaurez la base depuis la
  dernière sauvegarde antérieure à la modification ([BACKUPS.md](BACKUPS.md),
  « Restore by hand », ou [ROLLBACK.md](ROLLBACK.md) pour les étapes
  complètes), puis réappliquez les effacements faits depuis cette sauvegarde
  (`node scripts/reapply-erasures.js`). Les données saisies après la
  sauvegarde sont à ressaisir : listez-les depuis la piste d’audit.
- **Serveur.** Un serveur compromis se reconstruit, il ne se nettoie pas :
  [ROLLBACK.md](ROLLBACK.md), « Recovering on a new server ».
- Remettez les paramètres changés pendant le confinement.

## 7. Clore et apprendre

- Le référent protection des données complète l’inscription au registre des
  violations.
- Dans les deux semaines, le responsable de l’incident tient un court retour
  d’expérience : ce qui s’est passé, ce qui a marché, ce qu’il faut changer (un
  paramètre, une permission, une procédure, cette page). Un défaut d’IDevelop
  est signalé au projet via [SECURITY.md](../SECURITY.md).
- Le journal de l’incident, les preuves et les décisions sont conservés le
  temps que fixe votre politique, puis détruits.

## Un exemple, du début à la fin

Toutes les heures et tous les faits ci-dessous sont inventés.

- **Jour 1, 17 h 40 UTC.** Un manager d’équipe signale le vol, dans une
  voiture, du portable dont il se sert pour IDevelop ; le navigateur était
  connecté. L’heure 0 est 17 h 40.
- **17 h 55.** Un SuperAdmin ferme les sessions du manager dans Administration
  › Sessions et réinitialise son mot de passe. Le second SuperAdmin vérifie les
  Journaux système : rien depuis 16 h 10, dernière activité du manager.
- **18 h 30.** La piste d’audit du jour est exportée et le contrôle de la
  chaîne répond qu’elle est intacte ; les deux sont classés avec leur SHA-256.
- **Jour 2, 9 h 00.** Le référent protection des données évalue : la session
  a été fermée en moins de 15 minutes, aucune requête n’est venue de la
  session après 16 h 10, le disque était chiffré. Risque peu probable. Le
  responsable de traitement décide de ne pas notifier ; le registre des
  violations consigne l’événement, les motifs et les mesures.
- **Jour 9.** Le retour d’expérience ajoute une règle : les managers
  verrouillent leur écran et se déconnectent d’IDevelop sur les appareils
  partagés ou mobiles ; l’équipe sécurité vérifie que le chiffrement de disque
  est actif sur chaque portable.

## Contacts hors de l’organisation

| Qui                                                                            | Comment les joindre |
| ------------------------------------------------------------------------------ | ------------------- |
| L’autorité de contrôle désignée par votre droit national                       |                     |
| Le service sécurité de votre hébergeur (le cas échéant)                        |                     |
| Votre assureur ou votre conseil juridique (si votre politique les désigne)     |                     |
| Le projet IDevelop, pour un défaut du logiciel ([SECURITY.md](../SECURITY.md)) |                     |
