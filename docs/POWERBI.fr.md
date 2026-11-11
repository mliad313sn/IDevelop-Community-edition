# Flux Power BI

IDevelop publie des flux en lecture seule pour Power BI (ou tout outil qui lit un flux JSON de type OData). Cette page les liste, explique comment s’y connecter et décrit les flux versionnés.

English version: [POWERBI.md](POWERBI.md).

## Se connecter

1. Un super-administrateur émet une clé dans **Administration › Clés d’API**, avec la portée `powerbi.read`.
    - La clé est rattachée à un profil. Une clé du profil système voit toute l’organisation ; une clé d’un administrateur local ne voit que son périmètre.
    - La clé n’est affichée qu’une fois. Rangez-la dans les identifiants de la source de données Power BI, jamais dans un fichier de rapport.
2. Dans Power BI Desktop, utilisez **Obtenir les données › Requête vide › Éditeur avancé** et envoyez la clé dans l’en-tête `X-API-Key`. Une clé passée dans l’adresse (`?apiKey=`) est refusée.

```
let
    Source = Json.Document(Web.Contents("https://<serveur>/api/powerbi/v2/assessments",
        [Headers = [#"X-API-Key" = "<votre clé>"]])),
    Lignes = Table.FromRecords(Source[value])
in
    Lignes
```

Chaque flux renvoie les données que le profil de la clé est habilité à voir, et rien d’autre.

## Les flux

| Flux                          | Une ligne par              | Remarques                                                    |
| ----------------------------- | -------------------------- | ------------------------------------------------------------ |
| `/api/powerbi/employees`      | personne                   | l’annuaire                                                   |
| `/api/powerbi/v2/assessments` | personne et compétence     | **version 2** : les niveaux que comptent les indicateurs     |
| `/api/powerbi/assessments`    | évaluation                 | version 1, dépréciée (voir plus bas)                         |
| `/api/powerbi/v2/readiness`   | personne                   | **version 2** : les quatre états de préparation des rapports |
| `/api/powerbi/readiness`      | personne                   | version 1, dépréciée                                         |
| `/api/powerbi/organization`   | site, département, service |                                                              |
| `/api/powerbi/certifications` | certificat                 | échéance et état                                             |
| `/api/powerbi/coverage`       | règle de couverture        | état de chaque règle de couverture des postes                |
| `/api/powerbi/ninebox`        | personne                   | dernier placement 9 cases                                    |
| `/api/powerbi/pips`           | plan                       | plans d’amélioration de la performance                       |
| `/api/powerbi/idp`            | plan                       | plans de développement                                       |
| `/api/powerbi/coaching`       | plan                       | plans de coaching                                            |
| `/api/powerbi/goals`          | objectif                   | objectifs                                                    |

## Les flux versionnés

Quand le sens d’un flux change, IDevelop publie une version 2 à une nouvelle adresse et garde la version 1 inchangée pendant une version. La version 1 répond alors avec deux en-têtes HTTP :

- `Deprecation: true` ;
- `Link: </api/powerbi/v2/...>; rel="successor-version"`.

Chaque réponse porte aussi `X-IDevelop-Feed-Version`. Faites basculer vos rapports vers la version 2 avant la version suivante : la version 1 disparaît alors.

### Évaluations, version 2

La version 1 renvoyait les lignes d’évaluation brutes. Elle comparait n’importe quel niveau saisi à l’exigence : une compétence que personne n’avait encore évaluée manquait (au lieu d’être « non mesurée »), une compétence que le poste n’exige pas pouvait se lire « atteinte » ou « non atteinte », et un niveau au-dessus de l’exigence donnait un écart négatif.

La version 2 renvoie les niveaux que comptent les indicateurs (la même source que la préparation K1 à K4) :

| Colonne                       | Sens                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IsRequired`                  | le poste de la personne exige cette compétence                                                                                                                          |
| `RequiredLevel`, `IsCritical` | l’exigence (`RequiredLevel` est vide pour une compétence que le poste n’exige pas)                                                                                      |
| `CurrentLevel`                | le niveau enregistré, tel que saisi                                                                                                                                     |
| `LevelUsed`                   | le niveau retenu par les indicateurs : le dernier niveau officiel ou approuvé, et 0 tant qu’un certificat exigé est échu. Vide tant que la compétence n’est pas évaluée |
| `IsAssessed`, `CertLapsed`    | pourquoi `LevelUsed` vaut ce qu’il vaut                                                                                                                                 |
| `MeetsRequirement`            | vrai ou faux pour une compétence exigée et évaluée ; **vide** tant qu’elle n’est pas évaluée, et pour une compétence que le poste n’exige pas                           |
| `Gap`                         | l’écart sous l’exigence, jamais négatif (un niveau au-dessus de l’exigence n’est pas crédité) ; vide quand `MeetsRequirement` l’est                                     |

La réponse donne aussi `feedVersion` et `kpiContract`, la version des définitions des indicateurs. Les notes en texte libre ne font pas partie de la version 2.

Dans un rapport, comptez « non atteint » avec `MeetsRequirement = false`, jamais avec « différent de vrai » : une valeur vide signifie « pas encore mesuré », pas un échec.

### Préparation, version 2

`ReadinessState` vaut `ready`, `not_ready`, `partial`, `not_assessed` ou `no_requirement`. `IsReady` vaut vrai ou faux pour les deux premiers seulement, et reste vide sinon. La part de personnes prêtes est `ready ÷ (ready + not_ready)`, le même chiffre que le tableau de bord.
