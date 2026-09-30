# Innovation & business performance committee — round 1

Four seats reviewed IDevelop Community Edition 1.0 against the code, the running
product and the market:

- **Innovation & business performance chair**
- **HR / enterprise representative** — a 600-person, multi-site buyer
- **User representative** — employees and line managers
- **Product benchmark & competition manager**

This document records what they found, what was decided and what has shipped.

## Verdict

| Seat            | Score    | Headline                                                                                                             |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| HR / enterprise | 6.5 / 10 | Conditional yes for a pilot. Needs a works-council pack, AI Act guardrails and real HRIS sync before a full rollout. |
| Employee        | 6.5 / 10 | Honest and safe on a shared device, but "what's in it for me" is thin once the self-assessment is submitted.         |
| Line manager    | 6 / 10   | Good review console. No roster of my people and approvals are one person at a time.                                  |
| Benchmark       | —        | A rare self-hosted, open-source suite that is deep on skills and talent. Gaps: taxonomy, 360, in-flow nudges.        |

## Positioning

> For regulated, industrial and sovereignty-conscious organisations, IDevelop CE
> is a self-hosted, open-source skills and talent suite that goes deeper than the
> open-source HR tools: auditable, bilingual and free of licence fees. It is not
> (yet) a continuous-performance platform: 360 feedback, rich OKRs and HRIS
> connectors are on the roadmap.

**The three things to lead with:**

1. **Fair and defensible by design.**
    - "Not measured" is never shown as zero, and readiness always carries its denominator.
    - Succession refuses "Ready-Now" on thin evidence.
    - Bias scans suppress small groups.
    - Disputes run under SLAs, with maker-checker approval.
    - The audit trail is hash-chained.
2. **Sovereign and GDPR-native.**
    - It runs on your own servers, including air-gapped ones.
    - Export and erasure come with legal hold, and erasures survive a restore.
    - The AI copilot is off by default and anonymised when switched on.
3. **The whole talent cycle, with no per-seat fee.**
    - Framework, assessment, calibration, IDP, succession and mobility, in French and English.
    - SSO, SCIM and LMS connectors are included.

**Competitive frame:**

- Workday, Cornerstone and SAP sell the skills cloud inside a six-figure HCM contract.
- Lattice and Leapsome sell modules per seat (roughly €3–22 per employee per month) and win on in-flow adoption.
- Skills Base keeps SSO and analytics in its paid tier.
- Odoo keeps appraisal in its Enterprise edition.
- IDevelop CE gives all of that away. **Do not take it back.**

## Business model (open core, AGPL-friendly)

The core talent workflows stay free and ungated. That rule is enforced by a
test in `EntitlementService`. Revenue comes from what an organisation cannot
easily do itself:

| Layer                              | Why buyers pay                                             |
| ---------------------------------- | ---------------------------------------------------------- |
| Managed hosting (EU or in-country) | No ops team; sovereignty without running servers           |
| Support, SLA and LTS releases      | The HR seat's condition for a "yes"                        |
| Commercial licence exception       | For buyers whose policy excludes the AGPL (requires a CLA) |
| Premium HRIS connectors            | Workday, SAP SuccessFactors, Personio, BambooHR            |
| Curated taxonomies and role packs  | FR/EN sector frameworks built on ESCO, ready on day one    |
| Hosted, anonymised copilot         | EU-hosted model, no data retention                         |
| Sector compliance packs            | Safety certification rules, nationalisation reporting      |

**Rough total cost of ownership for a 600-person organisation:**

- Self-hosted IDevelop CE: about €30–50k a year, including 0.3 FTE of administration.
- Comparable SaaS: €45–110k a year.
- The biggest one-off cost is writing role frameworks, not IT. That is why the ESCO import matters.

**North-star metric:** weekly validated skill decisions. These are ratings that
were reviewed, disputes that were closed and development actions that started.

## Decisions and delivery

### Shipped in this round

| Item                                                                                                                                    | Seat             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| ESCO taxonomy import (`npm run import:esco`), then `db:seed:starter -- --file`; CC-BY attribution in `NOTICE`                           | Benchmark, HR    |
| Survey templates (eNPS, engagement pulse, onboarding, manager effectiveness), FR/EN, CC0                                                | Benchmark        |
| Slack / Microsoft Teams webhooks (`format`: json, slack, teams); chat messages never carry ratings, talent labels or contact details    | Benchmark        |
| Works-council (CSE) register generated from the live configuration, printable (`/compliance/register`)                                  | HR               |
| "What is recorded about me" page for every employee (`/employee/my-data`)                                                               | HR, users        |
| EU AI Act guardrails: AI label on every answer, no named-person ranking by default, EU-only providers by default, human-oversight audit | HR               |
| SQL console off unless the operator sets `SQL_CONSOLE_ENABLED=1` (separation of duties)                                                 | HR               |
| Core workflows never gated by a licence (`EntitlementService.CORE_FEATURES`, tested)                                                    | Chair            |
| Employee growth: gap against my target role, roles I'm closest to, learning suggested for my gaps                                       | Users, benchmark |
| 9-box explainer for employees and a setting to hide the 9-box from them                                                                 | Users            |
| Manager "My team" roster and team-wide approval of agreed ratings, with ready-made change reasons                                       | Users            |
| Recognition feed scoped to the team circle; thanks limited to colleagues                                                                | Users            |
| Getting-started progress in the sidebar and on the dashboard, with a link to the next step                                              | UX               |
| Readiness legends and a Role column in the gap report                                                                                   | UX               |
| Card tables on phones, one filter-bar pattern, compact row actions                                                                      | UX               |

### Roadmap

| Item                                                                                        | Seats         | Size      |
| ------------------------------------------------------------------------------------------- | ------------- | --------- |
| 360 / multi-rater feedback on the survey anonymity machinery (small-cell floor)             | HR, benchmark | 2–4 weeks |
| Shared 1:1 space (both sides add topics, outcomes linked to IDP objectives)                 | Users, HR     | 2 weeks   |
| HRIS connector layer (`src/integrations/hris/`), SCIM placement rules, SFTP delta imports   | HR, benchmark | 3–6 weeks |
| Board-ready quarterly talent review pack                                                    | HR            | 1 week    |
| Phased-adoption presets (Stage 1: framework + assessment, Stage 2: + talent, Stage 3: + AI) | HR            | 1 week    |
| Goal / OKR cascade linked to review forms                                                   | Benchmark     | 3 weeks   |
| AI-assisted skill extraction from role descriptions and CVs, confirmed by a person          | Benchmark     | 2 weeks   |
| More languages (DE, ES, PT), LTS channel, ISO 27001 / SOC 2 control mapping                 | HR            | ongoing   |
| Opt-in, anonymous usage telemetry (off by default, documented payload)                      | Chair         | 3 days    |

### Go-to-market: the first 100 organisations

1. **Ship a day-one framework.** ESCO import plus the FR/EN starter pack, so an evaluation starts with real content.
2. **Target the gaps SaaS leaves.** Francophone Africa, Quebec, EU public sector and industrial sites: offline, bilingual and sovereign.
3. **Recruit integrators before sales staff.** HR consultancies earn from implementation, and the product stays free.
4. **Make the works council an ally.** Publish the transparency register, so the consultation becomes a demo.
5. **Community.** Good-first-issue labels, a CLA bot, and public roadmap voting.
