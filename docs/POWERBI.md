# Power BI feeds

IDevelop publishes read-only feeds for Power BI (or any tool that reads an OData-style JSON feed). This page lists them, says how to connect, and explains the versioned feeds.

French version: [POWERBI.fr.md](POWERBI.fr.md).

## Connecting

1. A super administrator issues a key under **Administration › API keys**, with the `powerbi.read` scope.
    - The key is bound to a profile. A key owned by the system profile sees the whole organisation; a key owned by a local administrator sees only that administrator's clearance.
    - The raw key is shown once. Store it in the Power BI data source credentials, not in a report file.
2. In Power BI Desktop, use **Get data › Blank query › Advanced editor** and send the key in the `X-API-Key` header. A key in the address (`?apiKey=`) is refused.

```
let
    Source = Json.Document(Web.Contents("https://<server>/api/powerbi/v2/assessments",
        [Headers = [#"X-API-Key" = "<your key>"]])),
    Rows = Table.FromRecords(Source[value])
in
    Rows
```

Every feed answers with the data the key's profile is cleared to see, and nothing else.

## The feeds

| Feed                          | One row per               | Notes                                                   |
| ----------------------------- | ------------------------- | ------------------------------------------------------- |
| `/api/powerbi/employees`      | person                    | the directory                                           |
| `/api/powerbi/v2/assessments` | person and skill          | **version 2**: the levels the indicators count          |
| `/api/powerbi/assessments`    | assessment                | version 1, deprecated (see below)                       |
| `/api/powerbi/v2/readiness`   | person                    | **version 2**: the four readiness states of the reports |
| `/api/powerbi/readiness`      | person                    | version 1, deprecated                                   |
| `/api/powerbi/organization`   | site, department, service |                                                         |
| `/api/powerbi/certifications` | certificate               | expiry and status                                       |
| `/api/powerbi/coverage`       | coverage rule             | status of each position-coverage rule                   |
| `/api/powerbi/ninebox`        | person                    | latest 9-box placement                                  |
| `/api/powerbi/pips`           | plan                      | performance improvement plans                           |
| `/api/powerbi/idp`            | plan                      | development plans                                       |
| `/api/powerbi/coaching`       | plan                      | coaching plans                                          |
| `/api/powerbi/goals`          | objective                 | objectives                                              |

## Versioned feeds

When a feed's meaning changes, IDevelop publishes a version 2 at a new address and keeps version 1 unchanged for one release. Version 1 then answers with two HTTP headers:

- `Deprecation: true`;
- `Link: </api/powerbi/v2/...>; rel="successor-version"`.

Every response also carries `X-IDevelop-Feed-Version`. Move your reports to version 2 before the next release: version 1 is removed then.

### Assessments, version 2

Version 1 returned the raw assessment rows. It compared any recorded level with the requirement, so a skill nobody had assessed yet was missing (not "not met"), a skill the role does not require could read as "met" or "not met", and a level above the requirement produced a negative gap.

Version 2 returns the levels the indicators count (the same source as readiness K1 to K4):

| Column                        | Meaning                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IsRequired`                  | the person's role requires this skill                                                                                                                     |
| `RequiredLevel`, `IsCritical` | the requirement (`RequiredLevel` is empty for a skill the role does not require)                                                                          |
| `CurrentLevel`                | the level recorded, as entered                                                                                                                            |
| `LevelUsed`                   | the level the indicators use: the latest official or approved level, and 0 while a required certificate has lapsed. Empty while the skill is not assessed |
| `IsAssessed`, `CertLapsed`    | why `LevelUsed` is what it is                                                                                                                             |
| `MeetsRequirement`            | true or false for an assessed required skill; **empty** while it is not assessed, and for a skill the role does not require                               |
| `Gap`                         | how far below the requirement, never negative (a level above the requirement is not credited); empty when `MeetsRequirement` is                           |

The response also gives `feedVersion` and `kpiContract`, the version of the indicator definitions. Free-text notes are not part of version 2.

In a report, count "not met" with `MeetsRequirement = false`, never with "not true": an empty value means "not measured yet", not a failure.

### Readiness, version 2

`ReadinessState` is one of `ready`, `not_ready`, `partial`, `not_assessed`, `no_requirement`. `IsReady` is true or false only for the first two and empty otherwise. The share of ready people is `ready ÷ (ready + not_ready)`, the same figure as the dashboard.
