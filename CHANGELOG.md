# Changelog

All notable changes to IDevelop Community Edition are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 4.0.0 port — summary

The 4.0.0 port arrived in twelve waves; each has its own entry below.

- **Wave 0, security and privacy fixes:** a notification link changes nothing when fetched, approve-all needs the session token, an unlinked admin account is still its owner, the local content report needs `view_local_content`, the offline shell follows the deploy.
- **Wave 1, upgrade safety net:** an encrypted, verified database dump before every upgrade's migrations, pruned code copies, offline dependencies, a closed servicing folder, the rollback runbook.
- **Wave 2, the authority ladder:** one rule for who may act on a person's record (`strict` by default), the rung on the audit line, four eyes on 9-box placements, approval of selected skills.
- **Wave 3, capability rule and KPI definitions:** no credit above the requirement, indicator contract `kpi-2`, measurability under the health score, exposure by site on the dashboard's figures.
- **Wave 4, the development loop:** plan actions are started, reported and validated by the line, proposals from the person, target role to plan, K13/K28/K30.
- **Wave 5, employee experience:** the end-of-campaign record, what changed and the next step, rating on a phone, « new in the role ».
- **Wave 6, HR governance:** a dispute's first answer is a proposal, level-2 auto-finalisation off by default, PIP evidence and checkpoints, an optional HR visa, placements to disclose.
- **Wave 7, communications:** the employee's weekly point (opt-in), the D-7 line message, critical expired certificates, a short department brief mail, Outlook and dark-mode layouts, reminder effectiveness.
- **Wave 8, HSE operations:** K40 to K44 on the Safety tab and the certificate issuer.
- **Wave 9, board pack and executive KPIs:** board decisions with a name guard, the pack compared with the last one presented, targets and gaps, K17/K19/K20/K21.
- **Wave 10, manager home and administration pages:** « Waiting on me », « Data quality », « Usage by site », « Ready for go-live » on `/setup`, typed reset words.
- **Wave 11, interface and scale:** a folded menu, an AA-computed accent, one print sheet, interaction details, third-party notices, Power BI assessments version 2, a per-reader model cache.
- **Wave 12, documents:** an IT operations guide (`docs/OPERATIONS.md`), a go-live checklist (`docs/GO-LIVE.md`) and an incident and personal-data breach procedure (`docs/INCIDENT-RESPONSE.md`), both also in French; migrations 190 to 198 in `docs/ROLLBACK.md`; the compliance mapping, the ASVS rows and the audit updated; the Windows package carries every operator document in its `docs` folder.

**Upgrade checklist** (the details are in each wave's « Upgrade » line and in `docs/OPERATIONS.md`):

1. **Before:** free space on the backup volume for the pre-upgrade dump (the database's table data plus 256 MB; the Windows installer stops without it), and copy aside any code copy older than the five newest under `app-backups` that you still need. Back up `uploads` with your own file backup: code copies no longer hold it.
2. **Migrations 190 to 198**, all additive, nothing rewritten or deleted: 190 four eyes and the authority mode, 191 and 192 the development loop and proposals, 193 `review_records`, 194 the dispute proposal, 195 PIP evidence and `pip_reviews`, 196 the certificate issuer, 197 board decisions and their history, 198 recorded board packs. `review_records`, `board_decisions`, `board_decision_events` and `board_pack_runs` are append-only. If `SELECT count(*) FROM idp_actions WHERE estimated_hours < 0` is not 0, validate the hours constraint after fixing those rows.
3. **Settings changed on upgrade:** `nineBoxFourEyes` is left **off** (on for a new install) and `dispute.autoFinalizeOnExpiry` goes **off** where nobody had chosen it; every active SuperAdmin finds a notice for each. New settings: `authority.ladder` = `strict`, `newInRoleMonths` = 6, `pip.hrVisaRequired` = off. Decide them with the go-live checklist (`docs/GO-LIVE.md`).
4. **Permissions and scripts:** grant `view_local_content` to those who read nationality figures; scripts calling approve-all send the session's `x-csrf-token`; anything that runs `node scripts/reset-for-golive.js --confirm` adds `--confirm-word=PRODUCTION`.
5. **Figures:** indicator contract `kpi-2`; role, unit and heatmap figures go down where people exceed requirements, and movements, « What changed » and the digests restart from the first `kpi-2` snapshot. These are definition changes, not progress or decline.
6. **Power BI:** move reports from `/api/powerbi/assessments` and `/api/powerbi/readiness` to their `/api/powerbi/v2/…` successors before the next release, which removes version 1 (`docs/POWERBI.md`).
7. **Notices and cache:** a copy installed from source runs `npm run notices:build` once and restarts; `DASHBOARD_MODEL_CACHE`, `DASHBOARD_MODEL_CACHE_TTL_MS` and `DASHBOARD_MODEL_CACHE_MAX_ENTRIES` are optional (with several instances, lower the TTL or turn the cache off).
8. **After:** Instance health shows no pending migration and no failed job; keep the pre-upgrade dump named in the summary, and `docs/ROLLBACK.md` at hand, until the new version is accepted.

### 4.0.0 port — wave 11 (interface and scale)

- **The menu opens folded** (SA-67). Every group of the rail opens folded, except the one holding the current page; a group the person opens or closes keeps that choice, and a read-only account still finds its framework and reports unfolded. « Decisions » (`/exec/decisions`) has its own entry under « Board pack », with the pack's gate, and its help. The indicator targets have their own icon.
- **The organisation's accent is readable everywhere.** The accent colour of App Settings is resolved for each mode: the button text holds 4.5:1 on the colour, its hover and pressed states, the colour stands out 3:1 from every surface, and the accent text reads at 4.5:1 on every surface and on its own tint. A colour that passes is kept; another is moved the least it takes, never left failing, and the save says which ratios hold and whether it moved. The sign-in steps, onboarding and the error page carry the same colour.
- **One print sheet.** Every page of the main layout prints on the light colours whatever the screen shows, without the menu, the top bar or the buttons, on A4, with a header naming the product, the page, the date and « Internal use — do not distribute »; cards are never cut across two sheets and badges read without colour. A « Print » button uses it.
- **Interaction details.** The skill matrix draws one skill domain at a time (by default the one most required by the roles shown; « All domains » stays one choice away). The campaign roster's site, department, service, role and manager filters are checkbox lists, and « Excuse the whole filter » appears only while a filter is on (the server refuses it otherwise). A thin bar shows that the next page is loading. The offline page comes back by itself once the network returns.
- **Third-party notices.** « About » links to `/about/third-party-notices`: the licence of every production dependency and of the bundled icon font and typeface, written when the Docker image or the Windows package is built (`npm run notices:build`).
- **Power BI assessments, version 2.** `/api/powerbi/v2/assessments` gives, per person and required or assessed skill, the level the indicators count: empty while a required skill is not assessed, a gap that never credits a level above the requirement, and a skill the role does not require never met or missed. The API-key page lists every feed; `docs/POWERBI.md` and `docs/POWERBI.fr.md` describe them.
- **A per-reader cache** of the dashboard, the manager's home and the board pack: one reader's models for up to five minutes, never shared with another reader or another clearance, dropped by any successful save. The board pack says when its figures were computed. `docs/SIZING.md` explains how to size a server.
- **Upgrade:** no migration. Power BI reports that read `/api/powerbi/assessments` must move to `/api/powerbi/v2/assessments` before the next release: version 1 keeps its columns for this release and answers with `Deprecation: true` and a `Link` to version 2, then it is removed. Check the branding after the upgrade (the accent may be shown a little darker or lighter). Menu groups open folded. The new environment variables `DASHBOARD_MODEL_CACHE`, `DASHBOARD_MODEL_CACHE_TTL_MS` and `DASHBOARD_MODEL_CACHE_MAX_ENTRIES` are optional. A copy installed without the Docker image or the Windows package runs `npm run notices:build` once for the third-party notices.

### 4.0.0 port — wave 10 (manager home and administration pages)

- **The manager home says what waits** (SA-66). The manager's « Dashboard » gains « Waiting on me »: self-assessments to validate, level-0 disputes with no proposal yet, requests for change, plan actions reported done, proposed actions, plans late by more than 90 days, handovers past due and people blocked by a safety clearance, each as a count, a fact and the age of the oldest item (« arrived today », never « 0 days »), with how many wait for more than a week. The first line waiting is marked « Start here » and, on a phone, this block comes right after the title. A source that is not configured or cannot be read says so in a sentence, never 0; a module that is off leaves its line out. Beside it: « Expiring in my team » (the team's required certificates, from K8) and « Ready to move on » (the people ready in their role who also meet the readiness rule on a target role: a succession nomination or their own wish, each skill credited at most at the target's requirement; a target not fully assessed is « to assess »). Counts only; every line opens the page where the names are.
- **Data quality** (`/admin/data-quality`, « Framework & settings »). The records that keep an indicator from being measured, by area: people (nobody reviews them, no site, no role, no role start date, no nationality while local content is on, and the dashboard's own « no requirement » and « not assessed yet »), skills and roles (the « Skill quality » report, requirements, criticality while the talent module is on), development plans (actions without a due date, plans without an open action), required certificates (the record quality of K44), the nightly snapshots, the audit trail (chain, monthly seals, outside anchor) and privacy (erasure tombstones, retention deadlines, administrator accounts matching a person). Each area appears only for the permission that opens its module; the people areas cover the reader's clearance. A 0 is « no anomaly » only when something was there to check; « not configured » and « not measured » are never 0; under 5 records no percentage.
- **Usage by site** (`/admin/usage`, under « Data quality »): per site of the reader's clearance, accounts activated, people who assessed themselves in the last 90 days and the share of their lines validated within 14 days. A site of fewer than 5 people shows no figure, a share with nothing to measure is « not measured yet » (never 0 %), every share is rounded down. It measures use; the module stages stay on Administration › Modules, so the page is not called « adoption ».
- **Ready for go-live on `/setup`.** A second block, measured when the page opens: safety clearance rules for the roles, critical roles and their successors, critical skills, people the readiness indicators cannot measure, indicator targets, administrators without a second factor, access reviews of the quarter, the privacy notice and the last verified backup; single sign-on, shared-computer mode and local content are reported as decisions, never scored. A line that could not be read is « not measured », never « done ». `/setup` is now readable by every administrator: their people counts are those of their clearance, a line links only to a page they may open, the administrator-account lines show a state without a count, and only a SuperAdmin may hide the banner.
- **Typed words before a reset.** « Reset to defaults » on the settings page asks for RESET (or RÉINITIALISER), and the server refuses the reset without it. `scripts/reset-for-golive.js --confirm` now needs `--confirm-word=PRODUCTION` and aborts before connecting otherwise; Setup.bat (option R) passes it after its own prompt. The go-live wipe, the database cleanup and the data reset already cover the tables of the earlier 4.0.0 waves.
- **Upgrade:** no migration. Managers see three new blocks on their dashboard; administrators see « Data quality », « Usage by site » and, read-only, « Getting started » in the menu according to their permissions. Anything that runs `node scripts/reset-for-golive.js --confirm` outside Setup.bat must add `--confirm-word=PRODUCTION`.

### 4.0.0 port — wave 9 (board pack and executive KPIs)

- **Decisions on the board pack** (SA-65). « Decisions » (`/exec/decisions`, from the pack) records what the committee decided on the pack of a scope: one sentence, the owner as a ROLE (executive committee, HR director, health and safety, site management, training, local HR, managers, finance; never a person), the decision and pack dates, an optional due date and a linked indicator. A decision is never changed or deleted: only its follow-up moves (open, in progress, done, dropped, with an append-only history and notes; dropping needs a reason). A text that names a person the writer may see is refused before it is written, because it could never be erased; the person's access export lists any board text that names them and the erasure reports how many there are.
- **Since the last pack.** « Record this pack as presented » keeps what the pack says (the values as printed, the population as internal ids, the coverage, the KPI contract). The next pack of the same scope compares with that pack: people then and now, arrivals and departures (not under 5 people), coverage, and each indicator then → now. Under another KPI contract the pack says the definitions changed and prints no change. Opening or printing writes nothing. A reader who does not see the whole of a unit keeps their recorded packs and decisions under their own key, apart from the committee's.
- **Targets and gaps.** For each indicator of the pack: the target of the organisation or of a whole site (« Indicator targets »), the gap and « reached » decided on the printed value, when and by which role it was set, and the 90-day trend from snapshots of the same contract. Each site's 90-day movement where the reader sees the whole site.
- **Executive indicators**, born on contract `kpi-2` and documented in « How is it calculated? »: **K17** validation lead time (core; a Kaplan–Meier median with the rounds still waiting counted, a P90 from 10 approvals, the backlog in age bands; it can carry a target, lower is better, in days) on the Assessments tab; **K20** legal safety exposure (core; never « compliant » while anyone is exposed) on the Safety tab; **K21** key roles exposed (talent module and the retention-risk clearance; a flight risk never reviewed is « not assessed », never « low ») on the Succession tab; **K19** capability lost to departures (talent module), captured at each departure into the leaver event and never reconstructed.
- **A shorter, clearer pack.** It opens on the capability index, its measurability and « In brief »; sentence-case headings; a Development section (plan outcomes) for readers who have it; counts only, no figure under 5 people that could point at someone.
- **Upgrade:** migrations `197_board_decisions.sql` (`board_decisions`, `board_decision_events`) and `198_board_pack_runs.sql` (`board_pack_runs`) add three empty, append-only tables; nothing is rewritten or deleted. K19 reads « insufficient history » until the first departure processed after the upgrade. The pack's section headings lost their numbers.

### 4.0.0 port — wave 8 (HSE operations)

- **Health and safety operations on the Safety tab** (SA-64). Five new indicators of the KPI module, core and born on contract `kpi-2`, each documented in « How is it calculated? »: **K40** waivers and contests (waivers running now, renewals, the oldest, waivers granted in 30 days by route, open and decided contests; never « Compliant » while a waiver runs); **K41** blocks per week and their causes over 13 weeks (entries into an enforced « blocked » status; a week without a nightly recompute and without an entry is « Not measured », never 0); **K42** the required certificates expiring in the next 12 months, by month and by site, « no expiry date » apart; **K43** coverage rules in breach now, and the rules holding today that would break within 30, 60 and 90 days if nothing is renewed and planned leave is taken (never « Compliant » while a rule is broken); **K44** certificate record quality (expiry date, evidence scanned clean, field sign-off, number; never 100 % while one record is short). Counts only, on the reader's cleared population; no % under 5 people, and a site of fewer than 5 people is not named in the expiry pipeline.
- **Who issued a certificate.** The certification form of `/compliance` has an optional « Issuing body » (a training centre, a certifying body, an internal assessor), listed in the register and measured by K44 beside the four elements of a complete record. The person's own expiry mail names it; the line's mail and every subject do not. The erasure keeps it with the other facts of the certificate and the access export lists it.
- **Upgrade:** migration `196_certificate_issuer.sql` adds one nullable column, `employee_certifications.issuer` (trimmed, 1 to 200 characters), and nothing else. Certificates recorded before the upgrade stay « not recorded »: they are never back-filled, and the issuer is therefore not part of a « complete » record. The Safety tab shows five more blocks to everyone who already sees it; K41 reads « Not measured » for the weeks before the nightly safety-gate recompute ran, and K40/K41 read « To be set up » until a safety-gate rule is in `enforce` mode.

### 4.0.0 port — wave 7 (communications)

- **The employee's weekly point** (SA-63). Where an administrator has switched the « What changed » summaries on (`personaDigestsEnabled`, still off by default), an employee's summary opens with « Since your last summary of DD/MM »: levels validated, gaps closed, development actions done and trainings completed since the last one they were sent, read with the employee home's own definitions, in counts only (never a skill, a course, a name or a reason). A first summary says the comparison comes with the next one. It is e-mailed only when it carries a positive change or a step to take, never to an address shared by several accounts, and the person's own e-mail switches still apply; otherwise it stays in the app. The manager and department digests are unchanged and still sent (decision 7 of this port: upstream's switch-off of the old digests is not ported).
- **Summaries never repeat each other.** A summary (a « What changed » point, a department brief or digest, the manager or planning digest) is never a line of the daily digest, so one written in the app only does not come back by e-mail. The executive summary covers the time since the previous one instead of the same 30 days every week.
- **The line hears about its team at D-7.** Seven days before a campaign closes, the effective reviewer of the people who have not started gets one message (`cycle.team_reminder`) with how many they are and the close date, never a name, once per campaign. It counts against nobody's four-mail ceiling. The person's own D-7 and D-2 reminders say how many skills they already rated, every reminder says why the self-assessment matters, and the button reads « Start » while nothing is rated.
- **An expired certificate is critical.** The refresher course is assigned before the person is told, without a separate « course assigned » notice: the expiry mail says a refresher is waiting and its button opens it. An expired certificate is sent as « Critical » to the person and their line, with « do not do the work that requires it until it is renewed ».
- **Disputes.** The HR reminder two days before a level-2 deadline has its own kind (`dispute.hr_reminder`); the reminders sent by wave 6 as an escalation still read as a reminder. The person's proposal notice says by when to answer (the day the dispute goes up to the line without an answer), in the body, never in the subject.
- **A short department brief by e-mail.** The mail now carries the two headline figures with their change since the previous brief, « To do first » (the three highest-ranked lines as links), how many more there are and one button; the tables, the flow and the method stay on the brief's page. The comparison sentence follows the real basis.
- **Mails hold their layout.** A rounded VML button and a 600 px frame for Outlook on Windows, a dark rendering on IDevelop's Dusk tokens for clients that offer one (the inline look stays light), and a padded preheader.
- **Do reminders work?** The notification effectiveness page (SuperAdmin) adds the reminders × what people did next over 90 days: the campaign ladder (started or submitted within 7 days), a course not started (started within 14 days) and the person's own development actions due (one reported done within 14 days). Under five people reminded there is no rate; an unreadable ledger says so.
- **Webhooks.** `cycle.team_reminder` joins the default outgoing list (a campaign id, its close date and a link; the count stays inside). The dispute kinds, including the new reminder, never leave by webhook: a contest is HR data. `pip.created` is no longer sent (wave 6) and stays declared for the rows already stored.
- **Upgrade:** no migration. Mail changes only: e-mails now ask for a dark rendering where the client offers one, the department brief mail is shorter (the full brief is one click away), and an expired-certificate mail is marked critical. Where `personaDigestsEnabled` is on, employees with a positive change or a step to take start receiving their weekly point by e-mail (category « Reports and summaries »; each person can switch it off), and line managers get one more in-app message per campaign at D-7, mailed through the daily digest. The KPI alert mails keep carrying no figure (an IDevelop rule; upstream's figure line is not ported).

### 4.0.0 port — wave 6 (HR governance)

- **A dispute's first answer is a proposal** (SA-62). The level-0 rung, most often the supervisor whose rating is contested, no longer decides: they propose a rating, once, between the contested rating and the person's own, never below the contested one. The person sees it on « Supervisor reviews » with the proposer's reason and accepts it (the dispute is resolved with that rating and the official level follows) or refuses it (it goes to their manager at once). Without an answer it goes to the manager when the level-0 delay has run from the proposal. Only the person the review is about answers, and nobody acts on their own dispute. One rating dialog serves every level: both ratings and the person's words are recalled, five level buttons replace the typed digit, and the reason is mandatory and kept if the server refuses.
- **A contested rating waits for HR.** Level-2 auto-finalisation (« Dispute — auto-finalise at the deadline ») is now off by default: a rating stays provisional until HR decides, and the HR arbiters are reminded once, two days before the level-2 deadline.
- **The evidence of a performance-improvement plan.** A proposed plan is a working document between the manager and HR: its subject neither sees it nor is told about it until it is activated. The plan now records its real author, when and by whom it was activated, the person's reading (« I have read this plan », a date and never an agreement) and their observations, and the checkpoints held: the manager's note and the person's answer. The plan authority alone records a checkpoint, never in the future and never on their own plan. A printable letter of the plan is open to the plan authority and to the person for their own plan only; authors are named by role.
- **An optional HR visa.** With the governance setting **Improvement plans — HR visa before activation** (`pip.hrVisaRequired`, SuperAdmin only, off), a plan needs the visa of a SuperAdmin or of an administrator holding the dispute-arbitration permission for the person before it can be activated; whoever wrote the plan cannot give it. The plans waiting for it are a task for whoever may give it.
- **Tell the person their placement.** An approved 9-box placement not yet shared with the person is a task on « To do » for 30 days, for whoever may disclose it (talent module, and only while employees may see the 9-box).
- **The domain travels with the skill.** The skill pickers of the compliance page group the skills by domain, so two skills with one name are told apart, and their search box also finds a skill by its domain.
- **Upgrade:** migrations 194 (`assessment_disputes` proposal columns) and 195 (PIP evidence columns, `pip_reviews`, setting `pip.hrVisaRequired` = off); nothing is deleted. **Auto-finalisation changes on upgrade**: migration 194 sets `dispute.autoFinalizeOnExpiry` to off only where nobody had chosen it (`updated_by` empty, the original seed); a value an administrator set is kept, and every active SuperAdmin finds a notice in the app. Make sure someone holds `arbitrate_disputes`, or switch the setting back on. Plans still proposed at the upgrade disappear from their subjects' pages until activated. The proposer's note, the person's observations and the checkpoint texts are erased with the person and returned on an access request; `pip_reviews` is wiped by the go-live reset and cleared by the database cleanup.

### 4.0.0 port — wave 5 (employee experience)

- **The end-of-campaign record** (SA-61). Once a campaign is locked or closed, « My campaign records » (`/employee/review-record`) shows the person what was decided for them in it, skill by skill: their own rating, the level validated (only once the round was approved — a pending rating is never shown as validated), whether it differs and the reviewer's reason, a dispute still open, then their development plans. « I have read it » keeps a dated record of what was shown and says plainly that reading is not agreeing; the person may add a comment and change it later. Only the person reads and acknowledges their own records; another person's campaign answers « not found ». The record keeps ids, levels, states and dates only: the skill names and the reviewer's reasons are read live, so an erased reason disappears from it and nothing needs rewriting; the person's comment is erased with them and returned on an access request.
- **What changed, and the one next step.** The employee home and « My progress » open with « What changed since your last summary » (or the last 90 days, named): levels validated, gaps closed (a measured gap now at the required level — a first measurement closes nothing), development actions done and trainings completed. Only validated levels count, and the block is hidden rather than claiming « nothing new » when it cannot be read. « Next step » now follows the campaign lock (a person is never sent to rate in a locked campaign; the step names it instead), then offers the person's development step: an action or a training due, a measured gap with no plan (« Propose an action »), an action waiting for the manager, else the gaps still open. The development steps show only while the development module is on.
- **Honest figures for the person.** The home says where the person stands in one sentence and never « 0 of N skills met » for skills nobody has assessed; the capability rule (« a higher level never makes up for another skill ») is explained on the home and « My progress ». « My progress » compares validated levels only: an unreviewed draft is « pending », never a movement. « My development » folds the finished plans into a history after the active ones.
- **Rating on a phone.** Five large 0-4 buttons per skill (one tap, then the next unrated skill), the action bar at the bottom of the screen, the note behind « Add a note », and the last validated level hidden while rating on a phone too. Every rating select has a real label named by its row's skill; the estimate is an honest range (15 to 20 seconds a skill) and says the work can be split. With no open campaign and the person's latest campaign locked, the page is read-only (no save, no submit, no autosave) and says why. The offline status speaks the page language, uses the design tokens and docks in the action bar.
- **« New in the role ».** For `newInRoleMonths` months (default 6, 0 = never) after the start date recorded in the role, the 9-box roster and the PIP form show « new in the role » next to the name. Only a recorded date counts. An ordinary setting (not security-class).
- **Upgrade:** migration 193 (`review_records`, setting `newInRoleMonths` = 6); nothing is rewritten. The table refuses a DELETE through the shared append-only trigger and lets only the comment change, so the database cleanup, the data reset, the SQL console and the restore-point revert treat it like the other append-only tables; the go-live reset wipes it. « My progress » can show fewer movements than before: a movement now needs two validated levels.

### 4.0.0 port — wave 4 (the development loop)

- **A plan action moves** (SA-60). The person a development plan is for starts an action and says « I have done it », with a sentence and the hours spent; nothing official changes yet. Only the plan's line validates it (the direct supervisor or manager, a local administrator in clearance, a SuperAdmin; the line above only with `authority.ladder = extended`), never the person or a read-only account, with the level they observed on the action's skill, or « I cannot judge yet » (evidence only). An observed level higher than the official one, or a first one, becomes the official level, recorded with the validator in the assessment history; a lower observation never lowers it. Each action carries a skill (its own, else its objective's), planned hours and a due date; an objective on a skill gets one action at once.
- **Training and coaching feed the loop.** The line can give a training action a course from the catalogue (the courses mapped to its skill first) or an offline training with a date and a place. A course completion is evidence, never an uplift by itself: when it proposes no level it reports the action done for the line to validate, and when the line accepts the proposed level the action it served is closed with its evidence. The learner is told the decision (« Your level was validated » or « Your training was not accepted as evidence of level », the reason readable in the app only). Validating a coaching on a skill can record the level observed. A skill never assessed is proposed from « not assessed », never from level 0.
- **The person proposes, the line decides.** « Propose an action to my manager » (`/v2/idp/propose`) sends a 70-20-10 type, one sentence and, optionally, one of the person's skills. The line accepts it into the plan (a draft plan is created when none is open) or declines it with a reason the person reads; with no line, it goes to the local administrators whose clearance covers the person. The team console lists the proposals and the actions waiting for validation.
- **Target role, gap, plan.** The career path opens pre-filled from a link (`?employeeId=&targetRoleId=`, else the person's stated target role) and, when the development module is on, « Create the development plan towards this role » builds or extends the person's plan: the target role's unmet requirements become objectives measured at that role's level and tagged with it.
- **A plan is never signed empty, and prints.** Signing needs at least one action and a due date on every objective; the page says so before the button. « Print the plan » prints it with a signature block. A plan objective written by the machine is shown in the reader's language; a person's text is shown as written.
- **Development outcomes measured.** K13 now counts the product's own evidence: plan actions on their own skill, training-plan items and courses mapped to a skill that no plan action ordered; a validated observed level decides at once, and a rise above the requirement is credited at the requirement. New K28 « Effect of online training » and K30 « Plan outcomes » (development module), with a « Development outcomes » block on the dashboard's development tab: plans achieved and not, median durations, plans past due, hours planned and done (« not entered », never 0) and levels validated through development.
- **The development loop speaks.** Eight notification kinds, all in the development module, in the app and the daily summary: `idp.action_due` (the person's own actions due within 7 days or overdue, once a week, grouped), `idp.action_reported`, `idp.action_validated`, `idp.completed`, `idp.proposal_received`, `idp.proposal_decided`, `lms.uplift_accepted` and `lms.uplift_declined`. Their subjects never state a decision, and acting on them is counted on the notification effectiveness page.
- **Upgrade:** migrations 191 (`idp_action_progress`) and 192 (`dev_proposals`); nothing is rewritten. If `SELECT count(*) FROM idp_actions WHERE estimated_hours < 0` is not 0, the hours constraint is added NOT VALID: fix those rows, then validate it. Drafts generated earlier may need an action or a due date before they can be signed. K13 can move after the upgrade (new sources, credited at the requirement). The person's « done » note, the validator's note and the proposals are part of the person's file: exported on an access request and erased with them; the go-live reset wipes the proposals.

### 4.0.0 port — wave 3 (capability rule and KPI definitions)

- **No credit above the requirement.** Reaching the required level of a skill is one state, « met ». A level above it is credited at the requirement and never makes up for a gap on another skill or another person, so no role, unit or framework figure goes above 100 % (`src/utils/capability.js`: `credited`, `gapOf`, `skillAttainment`, `roleAttainment`). The dashboard's capability profile, comparison radar, heatmaps and capability map, the requirement-relative radars, the benchmark role matrix and the career-path gap follow it; compared with another role, every skill is re-evaluated against that role's requirement. The heat scale loses its two « above » steps: at or above the requirement reads « Met ». A person's own profile still lists the skills where they exceed their requirement.
- **The employee is told how a skill is counted.** The self-assessment page has a folded « How is a skill counted? » note: a higher level is a strength and stays recorded, but never makes up for another skill below its level, so readiness never goes above 100 %.
- **Indicator definitions version `kpi-2`.** Assessment freshness (the health score's « Assessments under 12 months ») is now over the assessed requirements, so coverage is no longer counted twice. Time to competence (K14) is a Kaplan–Meier median: people not ready yet count as still on the way instead of being left out, and under half ready reads « beyond N days ». The reconstructed trend ends on the live tile values. The capability map's « Whole framework » row and total print K2, the same estimator as the readiness tiles, with the columns ordered on it. The readiness tab shows K1 by site « with a comparable role mix » beside the observed rate. KPI alerts are decided on the whole percentage the tile prints and recover only after two consecutive OK passes. The glossary explains each change.
- **Measurability under the health score.** The overview says on how many people the score is computed (K1's own denominator), with the people without requirements for their role, the partly assessed and the « not yet assessed » apart, and names the areas not measured yet. Counts only, never a name; coloured only below 100 %.
- **Exposure by site is the dashboard's figures** (SA-59). Every column of `/exec/site-exposure` is the KPI for that site on the reader's population (K1, K2, K3, critical sole holders, certifications); the total row is the organisation's figure; a site under 5 people prints counts only; the « all skills held by one person » column is named apart from the K7 indicator; the two « weakest site » answers (fewest people fully ready, lowest level against the requirement) are named apart. The « Detail » link now opens the dashboard on that site.
- **Upgrade:** no migration. **Figures move and trends restart (contract `kpi-2`).** Role, unit and heatmap figures go down where people exceed their requirements, freshness and time to competence change definition: these are definition changes, not progress or decline. Movements, « What changed » and the digests compare only snapshots of the same contract, so they restart from the first `kpi-2` snapshot taken by the next daily run; older snapshots are kept and never compared with new ones. An open KPI alert now needs two OK daily passes before « back to normal » is sent.

### 4.0.0 port — wave 2 (the authority ladder)

- **One rule for who may act on a person's record** (SA-58). The self-assessment review, coaching, 9-box, performance improvement plans, development plans, LMS uplifts and rating disputes now ask one question, `AuthorityService.canAct`, instead of each keeping its own copy of the rule. The ladder runs supervisor, manager, local administrator inside their clearance, SuperAdmin, and an account holds everything it is (a manager who is also the supervisor holds the manager rung).
- **Nobody gains a right by default.** The new SuperAdmin setting **Authority — who may act on a person** (`authority.ladder`) is `strict` on new installs and upgrades: every service keeps exactly the rule it had. The line above the direct supervisor and manager reads and does not act, and a local administrator still needs `manage_talent_reviews` for the 9-box and `approve_assessments` to approve several skills or an LMS uplift. `extended` is a deliberate SuperAdmin choice. With it, the line above acts as the manager, and a local administrator inside their clearance acts without the feature permission. It adds rights and never removes one. 360° feedback rounds, one-to-ones and rating disputes at levels 0 and 1 keep the same reach in both modes.
- **Never on one's own record, never read-only.** In both modes nobody acts on their own record through any of their accounts, and a read-only account never acts. The 9-box and dispute levels 0 and 1 now also refuse an unlinked administration account that shares the person's e-mail or SSO identity.
- **The rung on the audit line, and a word to the direct manager.** Audit lines of the review services end with ` as=<rung>` (`supervisor`, `manager`, `reviewer`, `localadmin`, `superadmin`). Decisions at dispute levels 0 and 1 are now audited. When someone above the direct line approves a 9-box placement, activates a performance improvement plan or decides a dispute, the person's direct manager gets an in-app notice, « A decision about your team was taken above you » (kind `line.acted_above`). The notice is in the daily summary by e-mail, carries ids only, and is never sent to the person.
- **Four eyes on 9-box placements.** With the governance setting **9-box — four eyes** (`nineBoxFourEyes`), whoever drafted a placement cannot approve it, from either of their accounts. Another manager, a local administrator with `manage_talent_reviews` or a SuperAdmin approves it. A SuperAdmin may approve their own draft with a written reason of 10 characters or more; the console asks for it and the reason is kept in the audit log (`NINEBOX_FOUR_EYES_OVERRIDE`).
- **Approve the selected skills of one person.** The review console has a box on each line, « Select all » per person and a bar « Approve N skills ». The selected skills are approved together at the level shown on each line, or none is if one is refused: each refused line says why and the selection is kept. The person gets one notification for the round. A changed rating can carry its reason on the line, and a line without a self level no longer pre-selects level 0. The route `POST /api/self-assessment/employee/:employeeId/approve-selected` asks for the session's CSRF token, and several items ask what « Approve all » asks.
- **Upgrade:** migration 190. Nothing changes in who may act (`authority.ladder` = `strict`). On an upgrade, **9-box four eyes is left off** and every active SuperAdmin finds a notice in the app; switch it on in App Settings once every team has a second approver. A new install starts with it on. Before choosing `extended`, list the managers above the direct line and the local administrators who would gain the right to act, and watch the ` as=manager` / ` as=localadmin` audit lines afterwards. A local administrator without `approve_assessments` still approves skills one at a time; the selection boxes are shown only to accounts that may approve several.

### 4.0.0 port — wave 1 (upgrade safety net)

- **An encrypted, verified database dump before every upgrade's migrations** (SA-57). On an upgrade of an existing install (`-Patch`, `-Migrate`, or a plain re-run that migrates; never `-Reinstall` or an app-only patch), the Windows installer runs the new `scripts/pre-upgrade-dump.js` after the migration pre-flight and before the first migration: `pg_dump -Fc` encrypted as it is produced with the backup key into `%ProgramData%\IDevelop\backups\pre-upgrade-<db>-<old>-to-<new>-<stamp>.dump.enc`, with its signed manifest, restricted, then verified (`pg_restore --list` on the decrypted stream). **A failed dump stops the upgrade** before any migration (not enough disk space, no backup key, a `pg_dump` error, a failed verification): the database is unchanged and the previous code is put back. `-SkipPreMigrationDump` is the logged bypass. The daily retention never removes these dumps. The summary shows `DB dump (pre)`.
- **Code copies are pruned and lighter.** The code copy an upgrade takes under `app-backups` no longer holds `uploads` and `backups`, and only the newest `AppBackupKeep` copies are kept (new in `config.psd1`, default 5; 0 keeps all). The copy just taken and `retired-*` folders are never removed, and each removal is logged.
- **Offline install and upgrade.** `Build-Package.ps1` builds `npm-cache\` into the package (every production tarball of the lockfile, checked against its sha512; the new release tool `scripts/build-offline-cache.js`, never shipped). The installer runs `npm ci --offline` from it first and uses the registry only as a fallback; the summary says which (`Dependencies`). `-SkipOfflineCache` builds a package without it, for local use.
- **The servicing `config.psd1` is closed to local users.** `<InstallDir>\maintenance\config.psd1`, which can hold the standard PostgreSQL and admin passwords, is restricted to SYSTEM and Administrators after the copy and on every Setup and `Manage` run, with nothing for the service account. The maintenance scripts beside it stay readable, since they elevate themselves.
- **Rollback and recovery runbook:** `docs/ROLLBACK.md` (verify the dump, set the current database aside, restore, remove the newer migration files, put the previous code back, re-apply the erasures; rebuilding on a new server). `docs/BACKUPS.md` and `installer/README.md` describe the dump, and the Windows VM release checklist gains steps 9 to 12.
- **Upgrade:** no migration. The first upgrade with this installer prunes `app-backups` to the five newest code copies (copy aside an older one you still need) and needs free space on the backup volume for the dump (the database's table data plus 256 MB). Older code copies still hold `uploads`; from now on the evidence store must be covered by your own file backup.

### 4.0.0 port — wave 0 (security and privacy fixes)

- **A notification link changes nothing when it is fetched** (SA-56). Mail-security scanners follow every link of a message, and `GET /notifications/:id/go` marked the notification read and opened, so a scanner emptied the bell and counted as a reader. The link now only redirects, with the notification ids in the address fragment (never sent to a server); the landing page's static script `public/js/notif-open.js` posts them to the new `POST /notifications/opened` (signed in, same origin, session CSRF), which marks the owner's rows only and puts the original anchor back.
- **"Approve all" asks for the session's CSRF token** (SA-55). The per-person and team approve-all routes write many official levels at once; as `/api/*` routes they relied on the same-origin guard alone. They now also require the `x-csrf-token` header every signed-in page sends; a missing or wrong token is a 403 `csrf_required` in the page's language.
- **An unlinked admin account is still its owner** (SA-55). An administration account linked to no employee record but sharing an employee's e-mail, external SSO id or an SSO identity row counts as that person: it cannot review, approve (one by one or all), reject, validate, arbitrate or cancel their own self-assessment, and the maker-checker rules (cancellations, change requests, post-approval reviews) count the two logins as one person. The rule only ever refuses; a linked account is still judged by its link.
- **The local content report needs a permission and masks small groups** (SA-55). Nationality by unit was open to every manager and administrator. The report and its menu entry now need a SuperAdmin or the new read-only permission **`view_local_content`** (governance group, in no access profile); the localContent module stays the single switch. Breakdown cells under 5 people are masked on the page and in the CSV, with complementary suppression; people whose operating country is unknown are counted apart and the "no home country" warning appears only when there are some.
- **The header bell rests during the MFA enrolment hold.** A session held on two-factor enrolment no longer polls `/api/notifications` and `/api/my-actions` (both answer 403 while held): the server marks the hold and the setup page's bell fetches nothing until it is lifted.
- **The offline shell follows the deploy** (SA-56). The service worker is registered as `/service-worker.js?v=<assetVersion>`, names its cache after it and precaches the versioned addresses the pages request (the bare paths were never matched); a new deploy replaces the cache. The asset version now hashes every file of `public/css` and `public/js`, and such a versioned file is served immutable for a year in production. The three web manifests carry the App Settings → Branding name and favicon.
- **The audit-chain check runs at most once per request** (`AuditRetentionService.chainStatusOnce`), never across requests.
- **Upgrade:** no migration. Managers and administrators without `view_local_content` lose the local content report: grant the permission to those who need it. An administrator whose unlinked admin account shares their employee e-mail can no longer approve their own record; link the two accounts when they are the same person. Scripts that call the approve-all routes must send the session's `x-csrf-token`. From the upgrade on, a notification counts as opened only when its page loaded in the person's browser, so the opened figures of the notification measure drop to real readers. Browsers replace their offline cache on their first visit after the upgrade.

### Added

- HRIS synchronisation (`/admin/integrations/hris`, SuperAdmin): a CSV/TSV drop
  folder or upload, Personio and Lucca connectors (the two API connectors are
  implemented from public API documentation, not yet validated against a live
  tenant), value mappings, dry run then apply through the lifecycle, a
  mass-leaver guard (10% by default), a nightly job and SCIM placement through the
  same mappings. See `docs/HRIS-SYNC.md`; migration 160.
- **360° feedback** (development module, `/feedback-360`): an HR admin or a
  manager launches a round for one person or a campaign; the subject nominates
  peers, direct reports and others, the manager approves; raters rate the role
  skills 0–4 or "not observed" (never counted as 0), behaviour statements and
  keep / start / stop comments. Anonymous groups are shown only aggregated from
  3 answers, merged into "others" or hidden below it; responses are stored
  without rater identity. The report (self vs manager vs others, required level,
  blind spots, hidden strengths, shuffled comments) is released by the manager
  and feeds the development plan in one click. Reminders and closing at the
  deadline run on the job scheduler. **Shared one-to-one space** (engagement
  module, `/one-on-one`): joint agenda with notification of the other party,
  shared and author-only private notes, action items with owner, due date and a
  link to an IDP objective or a goal, meeting history feeding the "My team"
  roster. The self-assessment review console shows the person's current goals
  as read-only context. Migration `161_feedback_360.sql`.

### Changed

- The talent suite is no longer gated by the boot-time `V2_FEATURES=1`: optional
  modules (campaigns, development, talent, mobility, engagement, AI, local
  content) are switched from **Administration → Modules** (`/admin/modules`)
  without a restart, with three adoption stages (framework & assessment, plus
  talent & development, plus engagement & AI) or custom switches. A fresh install
  starts at stage 1; `V2_FEATURES=1` still forces every module on and an install
  started with it is recorded at stage 3. i18n no longer depends on
  `V2_FEATURES`.

### Dependencies

- Minor/patch group: compression 1.8.2, express-session 1.19.0,
  express-validator 7.3.2, fast-xml-parser 5.11.1, i18next-fs-backend 2.6.8,
  i18next-http-middleware 3.9.9, node-mocks-http 1.18.1, passport 0.7.0,
  pg 8.23.0, winston 3.19.0, yaml 2.9.1; dev: Playwright 1.63, nodemon 3.1.14,
  Prettier 3.9.9 (four files reformatted), supertest 7.3.0.
- **ejs 6.0.1** (from 3.1.10): locals are now copied into a null-prototype
  object before rendering. No template change was needed.
- **express-rate-limit 8.7.0** (from 7.5.1): IPv6 clients are limited per /56
  subnet. The custom key generators (API, write-action and account
  re-authentication limiters) now pass their IP fallback through
  `ipKeyGenerator`, so rotating addresses inside one subnet no longer resets
  the count.
- **otplib 13.5.0** (from 12.0.1): TOTP verification moves to `verifySync` with
  the same ±1 step tolerance. Existing enrolments and backup codes keep working.
  A malformed code is still a plain refusal.
- **bcryptjs 3.0.3** (from 2.4.3, installer password script only; the app uses
  native bcrypt): new hashes are `$2b$`, and existing `$2a$`/`$2b$` hashes still
  verify.
- Dev: **Jest 30.5** (ES-module dependencies reach tests through
  `tests/helpers/nativeEsmEnvironment.js`), **eslint-plugin-n 18.4** (Node
  builtin checks off for browser code under `public/`, global `fetch` allowed).
- Compose: **Redis 8** (`redis:8-alpine`, used under AGPLv3, one of the three
  licences it is offered under). PostgreSQL stays on `postgres:17-alpine`
  because a major tag bump does not upgrade an existing data volume. CI now also
  runs on PostgreSQL 18, and the README documents the dump/restore upgrade.
- Patched brace-expansion (exceljs → archiver) for three DoS advisories. The
  production `npm audit` reports 0 vulnerabilities.
- Deferred, with Dependabot ignore rules: ioredis 6 (BullMQ 5 pins ioredis 5,
  and v6 defaults to RESP3; it will move with BullMQ 6, which also drops the
  legacy `repeat` option the jobs use), and commitlint 21 (needs Node ≥ 22.12,
  while the project supports 20.19+).

### Security (webhooks, API population, input limits)

- **Outgoing webhooks carry an allow-list of events** (audit SA-21). Only
  operational kinds leave (lifecycle, campaigns, self-assessments, IDP,
  coaching, training, certifications, coverage, mobility postings); the 9-box,
  PIP, retention and privacy families never do, whatever a subscription asks
  for. 360° feedback, one-to-one and HRIS sync kinds leave only when a
  SuperAdmin lists them in the new security-class setting `webhookOptInEvents`
  (empty by default). Payloads are reduced to ids, ISO dates and an in-app link,
  for JSON, Slack and Teams alike.
- **`/api/v1` person feeds exclude leavers and erased people for every caller**,
  SuperAdmin keys included (SA-22).
- **`TRUST_PROXY` is validated at boot** (SA-23): `/0`, a short IPv4-mapped or
  zero-leading IPv6 subnet and anything that is not an address, a subnet, a hop
  count or `loopback` / `linklocal` / `uniquelocal` stop the start-up with the
  reason.
- The relaxed CSP of the standalone guides applies only to the guides and the
  offline page, not to any path ending in `.html` (SA-24).
- Free-text reasons are capped at 2 000 characters on every route (400 or the
  form with its draft); new admin usernames are letters, digits and `. _ @ -`,
  2 to 64 characters; the SQL console's function scan is linear (SA-25).
- `express-flash` is replaced by an in-house helper with the same API, which
  never creates a session for an anonymous visitor; `node-mocks-http` is a
  development dependency (SA-26).
- Webhook-family settings (`webhook*`) are security-class (SuperAdmin only).

### Notifications (catalogue, one renderer, delivery)

- **One catalogue of notifications** (SA-47). `src/services/notificationCatalogue.js` declares every kind the platform emits, IDevelop's own included (360° feedback, one-to-one topics, safety waivers and contests, scheduled reports, the assessment reset): its category, severity, e-mail tier, whether it is mandatory, whether it may leave by webhook (360° feedback and one-to-one kinds only on a SuperAdmin opt-in, HRIS and confidential kinds never) and its title and subject in French and English. A test fails when a kind is emitted that the catalogue does not declare.
- **One e-mail renderer, one language per mail.** Every mail — notifications, the daily summary, the manager, department and workforce-planning digests, the department brief, invitations, set-password and reset links, SSO notices, the SMTP test — is built from blocks by `utils/emailTemplate.js` (`renderEmail`): one layout, the logo as an inline attachment, a real plain-text part, and a footer that says why the mail was sent or that it is mandatory. A mail is written in ONE language: the recipient's when the sender knows it, else the new **`mailDefaultLanguage`** setting (App Settings → E-mail, `fr` by default). The bilingual side-by-side mails are gone.
- **No name, figure or status in a subject.** The subject is always « {app} — {catalogue subject} »; a decision or a status (« rejected », « blocked », a performance plan) has a neutral subject, and the campaign, the person, the dates and the counts are in the body only.
- **Delivery state, retry for 24 hours, suppression** (migration 182). A failed send is retried after 1 hour and after 23 more hours, then marked abandoned; the stored error masks every address. A person who has left, was voided or erased, or a deactivated administrator, is never e-mailed, including a mail held by quiet hours or waiting for a retry. The daily summary lists only what was not already e-mailed and its subject no longer carries a count. The notifications monitor shows each e-mail's state and attempts; « Re-queue » gives a failed e-mail one more real attempt instead of marking it sent.
- **Mandatory safety and security mails.** Safety-gate and security alerts are e-mailed even when the person switched e-mail off or the domain toggle is off; the global e-mail switch and the SMTP configuration still apply.
- `scripts/render-notification-samples.js` renders every kind in French and English, every block type and the daily summary to files for review.
- **Upgrade:** migration 182 is additive (four columns on `notifications`, two CHECKs, two partial indexes, the `mailDefaultLanguage` setting); sent e-mail rows are marked `sent`, older failed rows are not retried. Mails are French until an administrator sets `mailDefaultLanguage` to `en`: an English-speaking install should set it before the upgrade. Safety and security notifications now reach people who had switched e-mail off. Integrations or filters that matched a subject line (a person's name, a campaign code, « [IDevelop] ») must match the new subjects. The unused BullMQ `notifications` queue is no longer created. The delivery columns are erased with the person's own notifications and returned in the personal-data export; a held e-mail body about an erased person is removed.

### Notifications (preferences, measurement, calendar)

- **What reaches my mailbox** (My account → Notifications, SA-48). Each person chooses, category by category, what they also receive by e-mail (assessments and campaigns, development, compliance, talent, joiners and leavers, reports, account, other); everything stays in the app. The workplace-safety and account-security rows are greyed and cannot be switched off. The same page sets the **summary cadence** (every day, every Monday covering the week, or never), the **language of my e-mails** (French, English, or the site's `mailDefaultLanguage`), **calendar files** for deadlines, and quiet hours. Mandatory mails keep respecting the global e-mail switch.
- **One language per mail, the recipient's.** Notifications worded by the catalogue, the campaign reminders, certificate and coverage alerts, safety-gate mails and the manager, department and workforce-planning digests are written in the person's chosen language; a mail whose sender wrote fixed text keeps that text's language from greeting to footer.
- **Quiet hours per site.** A SuperAdmin sets a default window per site on the new notification catalogue page; it applies to the people of the site who have not chosen their own (server time). Changes are audited (`NOTIF_SITE_QUIET_HOURS`).
- **Calendar files.** The D-7 and D-2 campaign reminders, and a summary that announces a campaign launch, carry an `.ics` with the deadline: a date, a fixed phrase and the app link, never a name, a rating or a campaign title. One event per campaign: the second reminder updates it.
- **At most 4 mails per person per campaign.** The launch, a « not started yet » reminder three days later (only to those who have not started), then the D-7 and D-2 deadline reminders to everyone who has not submitted. A campaign shorter than 10 days gets the launch and D-2 only. The former weekly « not started » mail from day one is gone.
- **Summaries that nobody reads slow down.** Eight summaries in a row with nothing opened since step the cadence down one notch (daily → weekly → never); the preferences page says so and offers to turn it back on.
- **Measurement without tracking** (migration 183). Every event carries an id shared by its in-app and e-mail rows and the object it is about (identifiers only). « Opened » means the person followed the link (the bell, the centre, a mail button or a summary line goes through `/notifications/:id/go`); « Mark all as read » does not count and there is no pixel. « Acted upon » is recorded when the self-assessment is submitted, the review decided, the certificate recorded or the successor named.
- **Two SuperAdmin pages** linked from the notifications monitor: the **catalogue** (`/admin/notifications/catalogue`: every declared kind, its category, channels, webhook rule, recipients, mandatory flag, severity, subject and a sample mail in French and English, the 30-day volume, and the sites' quiet hours) and **effectiveness** (`/admin/notifications/metrics`: per kind over 30 days, notified, e-mailed, opened, acted upon, median time to action, opt-outs; aggregates only, leavers excluded, « not measured » below 5 people or without a closing action, never 0 %).
- **The bell and the notification centre are grouped by day** (today, yesterday, earlier this week, older), identical notifications of one day merged into one line « ×n » (opening it marks them all read), the severity shown as an icon shape with its name for screen readers, and a relative time with the exact one on hover. On a shared computer only the type of each notification is shown.
- **Upgrade:** migration 183 is additive (five columns on `notifications`, two tables, two columns on `sites`, three indexes) and ends with the console reader sync. Rows written before it are outside every measurement. Nobody's mail changes until they visit their preferences: the default is every category by e-mail, a daily summary and the site's mail language. A campaign running across the upgrade sends at most 4 mails per person, counting the weekly « not started » mails already sent; people who started but did not submit now get the D-7 and D-2 reminders. The existing manager and department digests keep running as before; they now follow the « Reports and summaries » row of each person's grid. The two new tables are in the erasure registry, the personal-data export, the compliance register and the go-live reset (kept, like `notification_preferences`).

### Navigation and shared components

- **One navigation config** (`src/config/navigation.js`, SA-49). Every destination is declared once (name, icon, address, the pages it covers) and gated by the permission its route checks and by the optional module that owns its route; the menu, the breadcrumbs, the quick search (Ctrl K, now also a visible « Rechercher » button), the account menu and the help titles all read it. A module switched off in Administration → Modules leaves no link anywhere, and the quick search only offers pages the person can open (skills and roles only to an admin holding their permission).
- **« Tableau de bord » first, for everyone.** It leads to the person's home (employee dashboard, the manager's team view, the indicators for an admin). Managers and admins who can act get **« À traiter »** (`/tasks`) second. Menus are grouped by task: my team, assessments, talent, safety & compliance, reports, my space and help for a manager; people, campaigns & assessments, talent, safety & compliance, reports, framework & settings, instance administration (SuperAdmin) and help for an admin. A read-only account is not offered work queues. New entries: 9-box movements, scheduled reports, department brief, gaps and readiness reports, clearance rules, training to approve, modules, HRIS sync, the notification catalogue and effectiveness; managers find the safety clearances of their team in the menu. Employees keep at most six entries; their profile, data and diversity pages are in the account menu.
- **« À traiter »** lists everything waiting for the person, grouped by kind, each line with a count, a verb (« Valider », « Relancer »…) and a link to a page they can open; a manager's list includes their own assessment and plans. Each task source checks the guard of its page and its module. The **bell's number counts actions only** (recognition received is listed, never counted); unread notifications are a dot, and both counts are in the bell's name for screen readers. A source that cannot be read says « may be incomplete », never « nothing to do ».
- **Accessible header and phone menu.** The account menu is a real button (arrow keys, Escape and focus return); every header control is 44 px. On a phone the menu is a modal drawer with a backdrop, focus kept inside and returned to the menu button; every row is a 44 px target; labels wrap instead of being cut. The header now comes before the menu in the tab order.
- **A SuperAdmin-only page opened by another signed-in account answers the explanatory 403 page** (what was refused, who can grant it) instead of a bounce to the dashboard. `/supervisor/reviews[/:id]` and `/v2/cap/calibration` answer a permanent redirect to the review queue and the calibration card (the latter only while the talent module is on); `/action-center` leads to « À traiter ».
- **Shared components on IDevelop's own design**: a status badge (icon and text, never colour alone), one confirmation dialog (verb-first buttons — « OK », « Oui » and « Yes » are refused for an action —, focus trap, Escape, focus return, a destructive dialog opens on « Annuler »), toasts with an icon and a spoken kind, form field and required-field legend partials, a bulk-action bar, a loading skeleton and « Sur cette page » on the settings page.
- **Layout guards.** An 8-step z-index scale; no text under 12 px in any stylesheet or view (icons aside); wide tables show a scroll cue and keep their actions column visible; no administration page is wider than a 390 px phone (tab bars, help sentences, long codes and status labels wrap; grid tracks never ask for more than the screen).
- **Upgrade:** no migration. The saved open/closed state of the menu sections is reset once (new storage key). Bookmarks of `/supervisor/reviews`, `/v2/cap/calibration` and `/action-center` keep working through permanent redirects. Monitoring or scripts that expected `302 → /dashboard` from a SuperAdmin-only page for a non-SuperAdmin should expect 403 (form posts and JSON callers are unchanged). The task labels « PIP » / « PDI » now read « Plans d'amélioration (PAP) » / « Plans de développement (PDI) ». A manager's dashboard entry now opens the team view; the organisation indicators are under Reports → Indicateurs.

### KPI module (one definition per indicator)

- **One function per indicator** (`src/services/KpiService.js`, SA-50): K1 role-ready rate, K2 average readiness, K3 assessment coverage, K4 critical-skill compliance, K5 bench strength, K6 critical roles without a ready successor, K7 single points of failure, K8 certifications expired or expiring within 90 days, K9 safety-gate fitness, K11 current campaign progress, K12 self versus validated gap, K13 development uplift, K14 time to competence, K15 level increases over 90 days, K16 active plans (there is no K10). One contract for all: the active, not-erased population within the reader's clearance; an absence of measurement is never folded into 0; fewer than 5 people never get a percentage (« 2 of 3 »); every status comes from one set of bands (`src/utils/kpiPredicates.js`, codes `compliant`, `watch`, `at_risk`, `not_measured`, `not_configured`, `small_n`, labels in French and English); a safety percentage (K4, K9) rounds down; `drill` is the exact list behind each figure; the sites add up to the organisation, with a « No site » row.
- **Module-aware.** Each indicator belongs to the core (K1–K4, K8, K9, K16) or to one optional module (campaigns: K11; talent: K5–K7; development: K12, K13, K15; mobility: K14). An indicator whose module is off is omitted, never shown as « not measured »; in K16 the performance and coaching plans count only while the development module is on.
- **« How is it calculated? »** (`/kpi/glossary`, Reports → Indicator definitions, managers and administrators): the definition, calculation, denominator, inclusions, thresholds, freshness and owner of every indicator the organisation's modules allow, each with its anchor, and a « See the list » link only to a page the reader's navigation offers.
- **Four-state readiness everywhere.** `/reports/readiness`, its CSV and JSON, the report builder (the KPI cards are now K1–K4 plus the active headcount and the « partially assessed » / « not assessed » counts; the Readiness source gains « Readiness state (K1) ») and the Power BI feed read the same K1: Ready ÷ (Ready + Not ready), « Partially assessed » and « Not assessed » beside it, never a failure. Each row of the report says why (critical skill not met, below the threshold, assessment incomplete, no skill assessed). The report gets a site filter limited to the reader's sites; another value is refused (400). The CSV headers follow the reader's language.
- **Campaign funnel.** Saving a rating stamps the participant's `started_at`, submitting stamps `submitted_at` (first date kept, open campaigns only), so K11 can show invited → started → submitted → validated.
- **Daily snapshots from the KPI module.** `jobs/kpi-snapshot.js` now writes what the indicators compute, with the contract version on each row.
- **Upgrade:** migration 184 is additive (seven nullable columns on `kpi_snapshots`, an index) and ends with the console reader sync; existing rows keep their values and get `kpi_contract` NULL. **Power BI:** a new feed `/api/powerbi/v2/readiness` carries `ReadinessState` (`ready`, `not_ready`, `partial`, `not_assessed`, `no_requirement`), `ReadinessReason` and an `IsReady` that is empty for a person without a verdict; the former `/api/powerbi/readiness` keeps its columns and values **for one release**, answering with `Deprecation: true` and a `Link` to version 2 — move your Power BI reports before the next release. `/api/v1` readiness keeps `isReady` unchanged (deprecated) and adds `readinessState` and `readyForRole`. **Figures change:** the readiness report and the builder now call a partially assessed person « Partially assessed » instead of « Not ready », so the role-ready rate of a partly assessed population rises or falls; the builder cards changed (K1–K4 replace « Skills met », « Critical gaps » and « Avg gap »); `certs_expiring_90d` now counts PEOPLE with a REQUIRED certificate expiring (it counted every certificate of the register) and `sole_holder_count` counts critical cells only, and `role_ready_count` requires every requirement assessed. The month-on-month movements of these three restart from the first snapshot after the upgrade; average readiness, coverage, critical compliance and the measured headcount keep their history (same definitions, proven by the reconciliation tests). K14 needs role start dates that are not recorded yet: it says « not measured » until a later release captures them. The dashboard pages keep their current tiles in this release; they move to the KPI module with the dashboard redesign.

### Charts, heatmaps and radars (one data-visualisation layer)

- **One layer for every chart, on IDevelop's own design** (`public/css/viz.css`, SA-51). Status, category and measure colours are `--viz-*` tokens measured against every surface of Daylight and Dusk (marks ≥ 3:1, status and text ≥ 4.5:1); a colour theme (Iris, Meadow, Sunrise, Ocean) changes the accent only, never what a colour means. Red means « At risk » and nothing else. « Not measured » is a hatch, never a colour and never 0, and fewer than 5 people never get a percentage.
- **One chart wrapper** (`public/js/viz.js`, partial `views/partials/viz/chart.ejs`): bars, lines, 100 % stacks and radars with a generated accessible summary, keyboard access (the arrow keys, Home and End move between the values, a polite live region reads them, Escape clears), « Show data » (the table behind every chart, also without JavaScript), a sorted list instead of the canvas under 480 px, threshold lines, gaps for missing values, a re-render when the mode or colour theme changes, a picture of every chart for printing, and no canvas text under 12 px. Numbers in the browser follow the page language exactly as on the server (`public/js/fmt.js`, the mirror of `kpiFormat`).
- **One heatmap component** (`views/partials/viz/heat.ejs`, `public/js/viz-heat.js`, model `src/utils/heatModel.js`): orange for how far below the requirement, blue above it, neutral at it, with the value and a ▼ always printed in the cell. One tab stop per grid and arrow-key navigation, a tooltip on focus and hover, screen-reader text per cell, a list of the cells furthest behind on a phone with the full grid on demand, the full grid on paper. Groups of fewer than 5 people are hidden (and a second cell with them so the first cannot be worked out), small units are pooled into « Others ».
- **Profile radar and gap bars** (`views/partials/viz/radar.ejs`, `views/partials/viz/dumbbell.ejs`): a sub-domain nobody was assessed on stays an open axis or a hatched track, never 0 and never « the widest gap »; the radar prints as a server-drawn picture.
- **Benchmark pages first.** In « Who has which gaps », a requirement nobody assessed is now a hatched « Not assessed » cell: it was painted as level 0 with a gap ring. The actual levels are coloured by what is missing against the requirement, the required-level matrices use a sequential scale instead of a red-to-green ramp, and percentages follow the reader's language. The role page adds the role's profile by sub-domain (radar and gap bars, assessed skills only) and draws the fit trend through the new layer; the benchmark page adds « Critical skills: who is at the required level, site by site? » (aggregates only, an unassessed person never counted as a gap).
- **KPI building blocks for the coming dashboard** (`src/services/KpiService.js`): critical-skill coverage by site, the 13-week required-certificate calendar, assessment freshness, K1 by site, department, service or role, and the readiness distribution. Same population as every indicator, each reconciled with the indicator it details (K1, K2, K3, K4, K8) and omitted when its module is off.
- **Upgrade:** no migration. Every page now loads `viz.css` (about 20 KB). Charts drawn by the theme's Chart.js defaults animate a little faster (400 ms) and follow the page's number locale. `kpiFormat` now treats a blank string or a boolean as « not measured » and never prints « -0 ». The benchmark role page no longer needs the fit history to show its profile; its matrix colours change as described above.

### The dashboard (one page, counts only)

- **One dashboard adapted to your rights** (`/dashboard`, SA-52). There is no choice of view by job: what a reader sees follows from their clearance, their permissions and the organisation's modules. It is rendered on the server from the KPI module: a **scope bar** (« You are viewing: … · N people · coverage »; a site or a department of the reader's own population), **« In brief »** (a few sentences in figures), a first row of at most five indicators (the most at risk first) with their status in a word and an icon, a movement and a sparkline, a « Not visible with your rights » line naming the areas the clearance hides, and **« What is left to set up »** (getting started for a SuperAdmin, no required certificate, no safety-gated role, no running campaign, no critical role), each with a link only when the reader's menu offers the page.
- **No person is named** on the dashboard, its tabs, the board pack, the manager's home or the manager and workforce-planning digests. Every count carries « See the list (n) »: `/dashboard/list` prints the exact population behind the figure, counted by site and by role (by skill for single holders), and « Open the list with names » leads to the page that holds the names only when the reader's navigation offers it. A list needs the capability of the block that shows the figure AND a people permission (403 otherwise, decided before anything is computed); the count it prints is the count the link printed.
- **Context tabs, loaded when opened**: Overview (the overall health score over the measured areas only, partial when one is missing, none under three; the role-ready rate recorded every day and, dashed, reconstructed from assessment dates as an estimate that never feeds a movement; the sites at a glance, risk rows first), Role readiness (the distribution with a reference curve from 20 people, readiness by site or department, one unit compared with the whole scope — by default the lowest with at least 5 people —, the pillar heatmap), Safety and certifications (13-week certificate calendar, critical-skill coverage heatmap), Talent (the approved 9-box positions as a doughnut, « Not placed » apart, cells under 5 grouped), Succession, Development (plans by type, the sub-domain heatmap) and Assessments (recent evidence, the current campaign's funnel, validations waiting). The slugs are English (`?tab=readiness`), the labels French and English; the former tab names still open the right tab. Each tab and block carries its module and its capability: **a tab or block of a module that is off is omitted**, never shown as « not measured », and no link leads into it. A heatmap cell opens the list of the people below the requirement on that pillar in that unit. « Print everything » puts every tab on paper.
- **The scope is remembered on the server** for the account and the page (migration 185), never in the browser, so a shared computer never hands one person's scope to the next; it is re-validated on every visit and dropped when it no longer fits. A URL naming a unit outside the reader's population is refused (400, not applied, not remembered).
- **Movements read snapshots of the same KPI contract**: the role-ready rate, certificates expired and expiring, safety fitness, critical-skill compliance, single holders and coverage compare with the most recent organisation or site snapshot of contract `kpi-1` at least 28 days old, only when the reader's population is exactly that scope. The movements of the role-ready, single-holder and expiring-certificate counts that the KPI module restarted are shown again from the first snapshots it wrote.
- **The manager's home** (`/supervisor/dashboard`) is their team in counts: role readiness, self-assessments to validate, certificates, plans, people by readiness state, next steps with their counts and the most frequent gaps. The named roster moves to **« My team »** (`/supervisor/team`, a new menu entry). **The employee's home** opens on one **next step** (a self-assessment to fix, continue or start, an answered change request, a blocked or expiring safety clearance, else « See my results »).
- **The board pack** (`/exec/board-pack`) carries the dashboard's figures for the same scope: in brief, the indicators with status and movement, the recorded trend, the sites, what is left to set up. It no longer lists single holders by name.
- **Workspace tabs**: the dashboard tab switches a SuperAdmin sets per administrator are now the new tabs (`tab:overview` … `tab:assessments`); a choice stored on a former tab applies to the tabs that replace it until it is saved again.
- **Upgrade:** migration 185 is additive (one table, `dashboard_scope_prefs`, ends with the console reader sync); the scope a person chose is exported with them, deleted on erasure and kept by the go-live reset. The former JSON endpoints of the dashboard (`/api/dashboard/*` except the module widgets, and `/api/benchmark/fit`) answer **410 Gone**: nothing in IDevelop calls them any more; move any script or integration to the dashboard pages, the reports or `/api/v1`. The module widgets (`/api/dashboard/v2/*`) now also need the capability of the block they feed (403). `views/pages/dashboard.ejs`, `public/js/dashboard.js` and the former dashboard controller are removed; the old dashboard bookmarks keep working (`/dashboard`, a former `?tab=` name opening the tab that replaces it). Managers find their named team list under « My team »; the manager and workforce-planning digests now give counts and a « See the list » button instead of names. Administrators whose former dashboard tabs were hidden keep that choice through the mapping above. A manager's « Dashboard » opens their team in counts; the organisation dashboard limited to their team stays under Reports → Indicators.

### Targets, alerts, « What changed » and the capability map

- **Indicator targets** (`/kpi/targets`, Reports → Indicator targets, SA-53). One target per indicator, for the organisation or a site, from a date, with a reason. Every decision is kept (a change or a withdrawal adds a line; nothing is edited or deleted) and audited (`KPI_TARGET_SET`, `KPI_TARGET_WITHDRAWN`); a site without its own target follows the organisation's. Every administrator account reads the page; deciding needs the new **`manage_kpi_targets`** permission for a site of the clearance (the organisation needs an unrestricted clearance; a viewer never decides). An indicator whose module is off is neither offered nor accepted.
- **Threshold alerts** (job `kpi-alerts`, one pass a day after `KPI_ALERTS_HOUR`, 6 by default): the role-ready rate below its target or « At risk » (when fewer than half the requirements are assessed, « coverage too low » instead), critical roles without a ready successor rising (talent module), people with an expired required certificate, safety fitness below 100 %, a running campaign behind its schedule (campaigns module). An alert fires **once** when an indicator enters an alert band, again only when it gets **worse** than its worst point, and once when it is **back to normal**. A site alert reaches the target managers, viewers and (certificates, safety) compliance holders whose clearance covers the site, else the SuperAdmins. In the app first; the certificate and safety alert is mandatory and e-mailed now, the others go to the daily summary. No name and no figure in a mail. The kinds `kpi.alert`, `safety.kpi_alert` and `kpi.recovered` are declared in the catalogue, which now also gives each kind its module (`moduleOf`).
- **« What changed »** on the dashboard (inside « In brief »): up to three fixed sentences over 30 days, from the daily snapshots of the same contract, only about what the reader's dashboard shows; never « +0 », never a percentage under 5 people, « History starts on … » until a comparison exists. The movements of the dashboard now also work on a department scope.
- **« What changed » summaries** (« My summaries », `/digests`), **opt-in**: nothing is sent until a SuperAdmin switches on `personaDigestsEnabled` (App Settings → Scheduled jobs). An administrator then gets the movements of the units its clearance covers whole and what is left to do; an employee gets one next step, in the app only; a manager keeps the weekly manager digest. Each summary is archived and readable in the app (by its owner only), each person chooses the frequency (every day, every week, never), and eight summaries in a row left unopened slow it down (« Restore » puts it back). Figures only, never a name.
- **« Time to reach the role » (K14) is measured** once role start dates exist: a role change stamps the date (database trigger, whatever the path, the HRIS sync included) and the arrival of a joiner stamps their first role. Nothing is back-filled.
- **Bench strength and critical roles without a ready successor** are recorded every day (K5, K6), and the continuity page's « Ready now » column and coverage gap now use the same rule as these indicators: an active successor ready for the target role by the role-ready rule. The band typed on a successor stays on the plan.
- **Capability map** (Role readiness tab): the whole framework, each pillar opening its sub-domains, « Whole framework » first, by site or department; same rules and colours as the other heatmaps (fewer than 5 people never shown, « Not measured » hatched, « Not required in this scope » a dot), a cell opens the list of the people below the requirement. The Overview tab shows the « Whole framework » row with a link to the full map. It replaces the pillar heatmap.
- **Upgrade:** migrations 186 to 189 are additive and idempotent and each ends with the console reader sync (186: targets and alert tables; 187: the department snapshot scope, `safety_fit_n`, the summary archive and frequencies; 188: `employees.role_start_date` and its trigger; 189: the bench columns of `kpi_snapshots`). The **existing manager and department digests are unchanged** and the « What changed » summaries stay **off** until switched on. The **first alert pass announces everything already in an alert band**: expect one alert per indicator and site already off target, then alerts only on changes. Grant `manage_kpi_targets` to the people who decide targets (no access profile includes it). K14 stays « not measured » until people who change role or join after the upgrade are ready; role start dates are never back-filled. The continuity page may now show **fewer « Ready now » successors**: it counts only successors who meet the role-ready rule for the target role, as the bench indicators do (the department brief's « critical roles without a successor » line still reads the bands). Department rows add a few snapshot rows a day. The summary archive, the summary frequency and the role start date are exported with the person; the archive and the frequency are deleted on erasure; the go-live reset keeps targets and frequencies and empties alerts and archived summaries.

### Page journeys, data rules and guard tests

- **« Mon auto-évaluation » on a phone.** The bar that stays at the top keeps only the progress, the autosave state and the two buttons (it covered about half of a phone screen); the filters and tools move to « Filtres et outils » just below, open on a wide screen and folded on a phone. The page's styles move to `public/css/self-assessment.css` on the design tokens, the row status is the shared status badge and the page uses the app-wide toast.
- **Coaching console.** No inline style; both tables follow the table pattern (cards on a phone, the actions column kept on screen); « Démarrer un plan » is a real dialog (Escape closes it, the focus stays inside and returns to the button, every label points at its control, one required marker); validating a plan asks first, with a verb on the button. « Note » and « Valider » become « Noter une séance » and « Valider le plan ».
- **Review queue.** One filter bar (campaign, sort and the two tabs) instead of three stacked cards; 44 px controls; the reviewer's rating has a visible label (« Ma note »); people with nothing left to decide fold under « Déjà traitées (N) »; a loading skeleton.
- **One status badge** (icon and text, never colour alone) on the self-assessment, the review queue, the coaching console, my coaching, my assessment status, the development and performance plan lists and the compliance evidence column, which now says why a file is not available (scan pending, infected, quarantined, scan failed, not scanned).
- **« il y a 0,8 mois »** on the 9-box console becomes days, weeks or months (`utils/agoBucket`, French and English plurals).
- **Admin forms repaired.** The administrator list nested each row's forms inside the bulk form: the browser drops a nested form, so a row button (unlock, extend, deactivate, reactivate) posted the bulk action and the selection lost every checkbox after the first row with an action. The role page printed its placeholder as « <em>…</em> ». Required labels on the administrator, campaign, organisation, onboarding, continuity and talent forms carried a typed « * » on top of the one the design system draws. « Effacer » / « Réinitialiser » / « Annuler » buttons that said nothing become « Réinitialiser les filtres » and « Annuler l’événement ». A link is shown only when the reader may open its page: the employee journal's « see the system log » needs `view_system_logs`, the access-review banner link is for a SuperAdmin.
- **Data rules.** The department brief's 9-box section counted placements in a status that does not exist (`submitted`; the CHECK says `under_review`), so it was always empty; its « stalled coaching » line now needs a recorded progress still at 0 (a plan nobody has updated is not measured, not stalled); its average readiness is coloured by the K2 bands of the KPI module (the readiness threshold of the settings, « watch » from 50) instead of a private 80 / 60 pair. The talent actions console counts only recorded progress in the average coaching progress (« — · Not measured » when none). A leaver's open goals no longer include finished ones (`done`). The personal-data export, the erasure and the opt-out measure no longer look for notifications addressed to a « manager », a value the database refuses. The HRIS nightly pass read its last-run DATE through `toISOString()`, which names the day before east of UTC, and could run twice a day. The LMS sync job swallowed a missing module and reported success.
- **Missing labels.** A cancelled development plan, the four reserved administrator roles, the antivirus verdicts, a cancelled campaign, a withdrawn application, and the placement, plan-signature and re-authentication messages (they printed their raw key). The site exposure page names K2 « Préparation moyenne » like the KPI module.
- **User guide.** Only the system log is hash-chained; the assessment tables are append-only but not chained.
- **Permanent guard tests** (`tests/unit/c334-GUARD-*`, `tests/helpers/guards/`): SQL literals against the CHECK and enum values of the database; enum-like text columns without a constraint (each kept open is allow-listed with its reason in `allowlist.json`, the 360° feedback, one-to-one, HRIS and newer tables included); a FR and EN label for every state value and every static key; a render of every page drawn without the layout, in both languages; no `toISOString()` on a DATE column; the same population in the dashboard, the employee list, the API and the access rules (with a rolled-back erased-but-active probe); every form and fetch target routed; columns written but never read pinned in `dead-columns.snapshot.json`; every job module present and failing loudly. A further test forbids a form nested in another in any view.
- **Upgrade:** no migration, no new setting, no new dependency. The department brief may now show 9-box placements awaiting approval it never showed, and fewer « stalled » coaching plans; the colour of its average readiness follows the readiness threshold of the settings. The talent actions console's average coaching progress may change or read « Not measured ». The HRIS nightly pass now runs once per day of the app's calendar. A failure of the LMS sync is now recorded as a failed run on the health page instead of a success. The guard suites that read the schema need the test database and are skipped without it.

### Security (uploads and escaping proofs)

- **Every upload passes the antivirus** (SA-45). Imports, the HRIS CSV, the skills-library archive, the skill quality and SQL console workbooks, branding images, certificates and evidence are all scanned (ClamAV, else Microsoft Defender) before they are used. One rule, App Setting **`uploadAvScan`** (on by default, SuperAdmin only): a threat is refused, deleted and audited (`UPLOAD_REJECTED_AV`); when no scanner gives a verdict the upload is refused while `requireMalwareScan` applies (`UPLOAD_REFUSED_NOT_SCANNED`), otherwise accepted, marked not scanned and audited (`UPLOAD_NOT_SCANNED`). Evidence and certificates record that verdict instead of scanning twice.
- **Safe file names.** A file whose name carries a folder path, a control character, only dots or more than 200 characters is refused with a message asking to rename it (FR/EN).
- **Escaping proofs** (SA-46). An inventory test pins every raw template output and every script that writes HTML, per file, and an escaped output inside an inline script is limited to ids and the CSRF token. Two suites over the real app prove that stored text (names, comments, justifications, branding, 360° feedback, one-to-one, HRIS runs…) and every query parameter of every page are escaped. They found and fixed: the admin scope editors turned a place name holding a `\u003c` escape into live markup; the campaign burn-down, two dashboard groupings, the dashboard employee list and the benchmark fit answered 500 on a malformed filter, now 400.
- **Mobile build gate.** `mobile/scripts/check-server-url.js` refuses a mobile build whose server address is not https (http://localhost only in a development build), and once the native projects exist, an Android manifest without `allowBackup="false"`, with cleartext traffic or debuggable in a release build, and an iOS Info.plist with App Transport Security off. Navigation stays on the configured host.
- **Upgrade:** no migration. The antivirus check starts on the first upload after the upgrade and adds about 0.5 to 3 seconds per file where a scanner answers. Without a scanner, uploads keep working and are marked not scanned, unless `requireMalwareScan` is true (or `auto` with a detected scanner that fails), in which case they are refused until the scanner answers. Integrations that sent a file name with a folder path, or a malformed dashboard filter, now get 400.

### Talent and workflow (authority, resets, decisions with reasons)

- **Workflow decisions only by their authority** (SA-42). The former `/v2/talent` rating and placement writes answer 410 and point to the 9-box console. A performance improvement plan is proposed, activated, closed or withdrawn only by the person's direct manager, a SuperAdmin or an administrator whose clearance covers the person; supervisors and managers higher up the line read it. Activation is journaled with its author, and « met » or « not met » only closes a plan that ran: a plan that never started is withdrawn with a reason. The former supervisor console decides only a pending review on an assessment still awaiting review, with a level from 0 to 4; a cancelled or rejected assessment is never revived. Requesting changes and withdrawing a review save everything together. An arbitrated rejection needs a reason, putting an assessment in arbitration needs an open dispute, and the person is told the outcome.
- **« Reset the assessment »** (SuperAdmin maintenance panel, migration 181). One assessment, or a whole employee × campaign, goes back to draft with the previous answer prefilled, and its review goes back to pending, so the person and their reviewer do it again. The official level does not change until a new approval. A reason is required; a whole campaign also needs the person's employee number typed again; a closed or locked campaign is refused. An open dispute or change request is closed. Nothing is deleted; the history shows « Self-assessment reset for redo » and the audit log `MAINT_RESET_ASSESSMENT`.
- **Nothing deleted, every decision says who, when and why** (migration 180, SA-43). A successor is removed with a reason instead of deleted, and stays off the bench until someone names them again; band overrides, incumbent changes and plan archives are audited. Coverage rules and planned absences are deactivated with a reason. An LMS uplift decision records who decided, when and why, and a decline needs a reason. Recording an arrival or a move needs the employee-edit right and a reason; without the right it becomes a request an administrator decides.
- **Survey results only once closed.** While a survey is open its owner sees whether the anonymity floor is reached, never a count or a result.
- **Flight risk** is read only by the person's manager or a holder of the retention-risk permission; a handover's incoming person must be in the caller's scope.
- **Development plan page.** The plan's authority adds objectives and actions from the page; empty lists say what to do next; the page says whose plan it is and names the action types in words. A plan created from the page is written in the reader's language (it was always French, with English action titles).
- **Export-only data page** (SA-44). An auditor, a read-only viewer or a local admin who may export but not import opens « Import & export » on the export blocks only, instead of being sent back to the dashboard.
- **Upgrade:** migrations 180 and 181 are additive. Existing successors, absences and rules stay active; the ones deleted before the upgrade cannot be recovered. `v_continuity_coverage` is recreated with the same columns, counting active successors only. Integrations that called the former `/v2/talent` rating or placement routes get 410. Supervisors lose the PIP buttons' effect (403) where they are not the person's manager. Supervisors and HR who decline an uplift, cancel an absence, remove a successor or deactivate a rule are now asked for a reason. The new reason columns are in the erasure registry and the personal-data export.

### Talent data (9-box movements, coaching signatures, data fixes)

- **9-box movements** (migration 175, SA-41). Each placement records the person's previous approved placement and the direction of the move: first placement, unchanged, moved up, moved down or sideways, judged on the two axes. A box change needs a written reason of at least 20 characters, a real sentence and not a copy of the person's previous reason, at submission, at approval, when a reviewer changes a submitted box and at calibration. The console shows « before → now », the previous placement in the assess dialog and, on request, where each person came from on the grid. A new **9-box movements** page (from the console) gives the counts by direction, the box-to-box matrix, filters by campaign, site, department and direction, and a CSV.
- **What the person sees.** The direction of a disclosed move appears on the employee's home page only when the previous placement was disclosed to them too; the reason is never shown to them. It is returned on a formal access request, withheld from the self-service download with the rest of the 9-box, and erased with the person. The 9-box journal records a move, and a calibration, by ids only.
- **Coaching signatures** (migration 177). Only the person coached and the coach named on the session can sign it; an administrator who can read the session is no longer able to sign for the coach. The signature records the account used.
- **Where an official skill level comes from** (migration 176). Every path that writes an official level now says whether it was validated (assessor entry, review, approval, dispute decision, validated training) or not (an import that changes a level). Existing levels are marked validated only where their note proves it.
- **Data fixes.** People erased before the tombstone table existed get a tombstone, so a restored backup cannot bring them back (migration 178). Applications to an opportunity accept only applied, withdrawn, accepted and declined (migration 179); the never-computed review priority index is marked deprecated.
- **Upgrade:** additive migrations. Placements decided before the upgrade are rebuilt as « rebuilt from history » with no reason, never an invented one. If `opportunity_applications` holds another status, the new CHECK is added NOT VALID with a NOTICE instead of failing the upgrade: correct those rows, then validate the constraint. The movement reason and the coaching `actor_ref` are in the erasure registry and the personal-data export.

### Safety gate (waivers, contests, rules required by law)

- **A human path on the safety-competency gate** (migration 174, SA-40). The person's line manager, or HSE within their scope, can grant a **waiver** on one blocking skill: a reason is required, it lasts 72 hours at most and can be renewed once. It is never granted by the person themselves. A new waiver waits 72 hours after the end of the previous one, and a person can be waived at most 144 hours per skill over any 30 days.
- **Authorised by waiver, never cleared.** While a waiver runs, the status is WAIVED: « Authorised by waiver (until …) » on the pages, and `cleared: true` with `waived: true` and `waiverExpiresAt` in the API and the webhook. When it ends, the computed status applies at once; the person and their line are told.
- **Contests.** A person, or their line manager, can contest a block with a reason. HSE or HR records the decision with its reason: block kept, or lifted by a waiver or a data correction. The person is told.
- **« My safety clearance »** (`/safety-gate/me`): the person's own status, waivers and contests, and the contest form, from the personal menu.
- **Rules required by law.** A rule can be marked as required by law: no waiver lifts it, running waivers end when it is marked, and it is always enforced. Only a SuperAdmin can remove the mark, with a reason. Switching any other rule to observe now needs a reason.
- **Upgrade:** additive migration; existing rules are not marked as required by law and keep their mode. The two new tables are in the erasure registry, the personal-data export, the compliance register and the go-live reset.

### Security (encrypted backups)

- **Backups are encrypted** (audit SA-39). The daily database backup and the
  SQL-console restore points are encrypted as `pg_dump` writes them (AES-256-GCM
  stream, `<db>-<date>.dump.enc`), with a signed SHA-256 manifest beside each
  file; no clear copy touches the disk, and no key means no backup rather than a
  clear one. Every restore checks the manifest and authenticates the whole file
  first and refuses a changed, truncated or extended one. After each backup the
  file is verified (`pg_restore --list` on the decrypted stream) and every
  backup on disk is checked to still have its key here; failures alert the
  super administrators. Admin → Instance health shows the key, the last
  verification and key check, the off-host copy, and flags each file « non
  chiffrée » / "not encrypted".
- **The key:** DPAPI-protected on Windows (`node scripts/backup-key.js init`,
  then `export` once and keep the recovery copy offline), derived from
  `APP_KEY` on Linux and Docker. `scripts/rotate-app-key.js` keeps older
  backups readable (the old derived key is retired into the keyring before the
  database is touched; the rotation stops if it cannot be). `backup-key.js`
  also imports a recovery copy or a previous `APP_KEY`, verifies, encrypts
  and streams a backup into `pg_restore`. `Verify-BackupRestore.ps1` verifies
  and restores encrypted backups. Optional off-host copy: `BACKUP_OFFHOST_DIR`.
  See `docs/BACKUPS.md`.
- **Upgrade note:** existing plaintext `.dump` files stay where they are, are
  restorable with a warning and leave through the usual retention. On Windows,
  run `node scripts/backup-key.js init` and `export --out <file>` once after the
  upgrade (the first backup creates the key otherwise; the health page warns
  until it is exported). On Linux and Docker, keep an offline copy of
  `APP_KEY`, and never change it by hand: older backups would be unreadable
  until the previous value is imported (`backup-key.js import-app-key`).

### Security (Windows installer)

> **Release gate:** these installer changes were verified from the PowerShell
> source and the database side only; their PowerShell functions run in the test
> suite on Windows. Rehearse the checklist in `installer/README.md` ("Release
> rehearsal on a Windows VM") on a clean Windows Server VM before releasing.

- **Least-privilege service account** (audit SA-54). `ServiceAccount = 'Auto'`:
  a new install runs the service as its virtual account `NT SERVICE\IDevelop`,
  with Modify on the data folders only (uploads, data, logs, backups, tmp,
  certs, the Data Management upload staging, the WinSW logs now in
  `service\logs`, and under `%ProgramData%\IDevelop` the backups, SQL restore
  points, audit anchors, TLS, keys and logs), Read on `.env` and the backup
  keyring, Read and execute only on the code, and nothing on the code backups.
  An upgrade keeps the account it runs as and is offered
  `-MigrateServiceAccount`: after the upgrade is healthy, the folders are granted
  (nothing is switched if one cannot be), the account is changed, and the
  service goes back to LocalSystem by itself if it does not pass its health
  check. `HRIS_DROP_ROOT` (local) is granted Read and execute.
- **Audit-trail ownership separation** keeps its role name
  `idevelop_audit_owner` (an older role is renamed in place) and is **off by
  default**, on new installs too, because it disables four SuperAdmin tools;
  `-EnableAuditOwnerSeparation` turns it on, and an upgrade keeps the state its
  database is in. With it on, GDPR erasure works again: the role owns every
  function that guards or rewrites the audit log, can read `employees`,
  `admins` and `pii_cleanup_jobs`, and the application keeps EXECUTE on the
  redaction, purge and seal functions.
- **OWNER RIGHTS** (the creator of a file) is accepted in the restricted
  folders the application closes itself, so they are no longer reported as
  partially restricted.
- **PostgreSQL hardening** with a report on every run: connection logging, a
  log prefix naming user, database and client, `CONNECT` for the application
  role only, and `listen_addresses = 'localhost'` when PostgreSQL is on the same
  machine. Applied on a server the installer created
  (`pg-created-by-installer.json`), offered elsewhere (`-ApplyPgHardening`).
  `pg_hba.conf` is never changed.
- **Release manifest.** The package carries `app\release-manifest.sha256`; the
  installer refuses an altered, missing or added file before it stops the
  service or copies anything, and reports files of the install directory the
  release does not ship (customer folders excluded). `-EnforceManifest` moves
  them to `app-backups\retired-<timestamp>`; nothing is deleted.
- **No password on a command line.** The PostgreSQL installer reads the
  superuser password from an option file in a private temporary folder;
  `scripts/set-admin-password.js` reads `SET_ADMIN_PASSWORD` from its
  environment (the argument form still works), and `Manage -SetAdminPassword`
  uses it, also against an older installed script.
- **Backup key on install, encrypted restore points.** Every installer run calls
  `backup-key.js init` (never replaces a key) and offers the one recovery-key
  export to a path you type, else to the server's key folder with a warning to
  move it offline. `Manage -Backup` writes `database.sql.enc` and refuses a
  plain restore point (unless `-AllowPlainBackup`, or the installed version has
  no key tool yet); `Manage -Restore` verifies the dump before it stops anything
  and decrypts it straight into `psql`.
- **Upgrade notes:** existing installs stay on LocalSystem until you run
  `-MigrateServiceAccount`; plan it and check backups, uploads and HRIS imports
  afterwards. A configured `AuditOwnerSeparation = $true` should become `'Auto'`
  or stay `$true`; a database that is separated stays separated under `'Auto'`.
  Before applying the PostgreSQL hardening on a shared server, grant `CONNECT`
  to any other role that reads this database. The restore point Setup takes
  before upgrading a version without the key tool stays plain (`[UNENCRYPTED]`).

### Security (mail privacy)

- **No password by e-mail** (audit SA-37). An invitation or a credentials resend
  now sends the username and a one-time **Set my password** link, valid 72 hours
  and usable once; the account holds a random password nobody knows until the
  person chooses theirs. Sending a new invitation burns the previous link. When
  nothing can be mailed (no address, e-mail off, a failed send) no link stays
  live and the temporary password is shown once on the administrator's
  credentials sheet, as before. A used, expired or unknown reset or
  set-password link answers 410 on the « forgot password » page.
- **Scheduled reports go to accounts, as a link** (SA-38). Recipients are chosen
  among the accounts (administrators and managers) whose clearance covers the
  report's scope; a typed address is refused. The clearance is checked again at
  every run and when the copy is downloaded. Each run keeps one in-app copy and
  the recipients are told in the app and by an e-mail that only links to it;
  the report is never attached. Copies are emptied after
  `reportRunRetentionDays` (default 90, 1 to 365, SuperAdmin-only) and when a
  person in their scope is erased; an emptied copy answers 410.
- **Upgrade note:** a schedule that e-mailed typed addresses keeps running only
  when every address matches exactly one active account, which becomes its
  recipient. Any other is **suspended** and its owner gets an in-app notice;
  choosing accounts on Reports → Schedules re-enables it. Nothing is deleted:
  the old addresses stay visible on the row.

### Security (privacy and sessions)

- **Diversity data is self-declared, with explicit consent** (audit SA-32).
  Only the person declares gender, age band, nationality and, for workplace
  accommodation, disability, from **My diversity data**
  (`/v2/cap/my-diversity`, linked from « What is recorded about me »); the page
  stays reachable whatever the talent module says, so consent can always be
  withdrawn. Disability needs its own consent. Withdrawal deletes every declared
  value at once; the consent ledger (field names, text version, dates, never a
  value) is kept and exported. A manager or an admin can no longer write
  someone's diversity data (403). Ethnicity is off until a SuperAdmin types a
  legal sign-off (audited). Disability is readable by the person and by HR
  holding « edit employees » only. Analytics count only consented
  self-declarations of active, non-erased people, with complementary small-cell
  suppression; values recorded before consent existed are set aside and listed
  for HR review (field names only, reason recorded).
- **One nationality switch** (SA-35): the Local content module. While it is off,
  a submitted nationality is ignored on employee create and edit, the bias scan
  leaves out the nationality axis, and the diversity analytics and the « My
  diversity data » page do not offer it. Nothing is deleted. The switch and the
  home country are SuperAdmin-only, audited and confirmed.
- **Back to the requested page after sign-in; no anonymous sessions** (SA-33).
  A link opened before sign-in is remembered in a short signed cookie (15 min,
  one use, same-origin relative paths only) and the password, MFA and SSO
  sign-ins land there; the login page shows a neutral notice instead of a red
  error. An anonymous visitor gets a session only on a page that renders a form.
- **Shared-computer mode, off by default** (SA-34): `kioskModeEnabled`
  (SuperAdmin) offers a « Shared computer » box at sign-in, or applies the mode
  to addresses in `kioskIpRanges`. A shared session idles out after
  `kioskIdleMinutes` (default 5), uses a browser-session cookie, signs out when
  the tab closes, shows a badge with one-click sign-out and resets the menu and
  language for the next person.
- **Offline drafts wiped**: a self-assessment rating is queued on the device only
  when it could not reach the server, and every sign-out removes the person's
  drafts from the browser.
- **SAML stays strict by default** (SA-36): the whole response and the assertion
  must be signed; a new « Strict » switch on the SuperAdmin SSO page
  (`samlStrict`) allows assertion-only signing, applied without a restart.
  `SAML_WANT_RESPONSE_SIGNED=0` still applies until the setting is stored.
- **Sensitive settings band**: on `/app-settings`, the nationality switch,
  shared-computer mode and mandatory MFA come first, each with its consequence,
  and every change asks for confirmation.

### Security (audit log)

- **Audit lines carry ids, not names** (audit SA-29). Sign-in, SSO, admin,
  campaign, onboarding, account-link, e-mail and HRIS lines name people as
  `employee:<id>` / `admin:<id>`; an unknown identifier typed at sign-in is kept
  only as a keyed `fp:<10 hex>` fingerprint; a failed e-mail is logged with a
  masked address. Whatever a caller writes, `LogService` replaces the row's own
  subjects' names, logins and addresses by their ref, masks every other e-mail
  address with a linear (ReDoS-safe) pattern and caps each logged string at
  4 KB. The system-logs page, its CSV/JSON export and the employee journal
  resolve the names when the log is read; an erased person reads "Erased person
  #id" in the reader's language. The actor filter still finds a person by name.
- **Erasure reaches the audit log**: inside the erasure transaction, the
  person's names, login and addresses (including older addresses recorded
  against them) are replaced by their ref; a chained `AUDIT_REDACTION` entry
  vouches for each changed row, which keeps its original hash. The erasure fails
  if this fails.
- **Seals, retention and one verifier** (SA-30): one `AUDIT_SEAL` entry per
  complete month; rows older than `auditLogRetentionYears` (new SuperAdmin
  setting, 1-10 years, default 5) are deleted by whole sealed months only,
  never a seal, redaction or purge entry, never a row about a person under
  legal hold, and only when the chain verifies (`audit-retention.tick`, daily
  after `AUDIT_RETENTION_HOUR`, default 2). `GET /v2/cap/audit/verify` and the
  new « Verify integrity » button of the system-logs page (SuperAdmin) use one
  verifier in the database that follows the hash links: historic forks left by
  the old id/lock race are reported as benign, any other change is flagged. The
  chain trigger now draws the row id under its lock.
- The redaction and purge functions are not executable by `PUBLIC` (so not by
  the SQL console's read role), and the SQL console refuses them and the
  `idevelop.audit_*` settings that open the path.

### Fixed

- An ordinary employee sign-in no longer leaves a spurious "unknown
  identifier" `LOGIN_FAILED` row; a failure is written once, when both the
  admin and the employee lookups miss (SA-31).

- A random production secret containing a year-like digit run (about 9 % of
  64-hex values) was refused and the service boot-looped; the year test now
  applies only to values that do not look random, and the Windows installer
  re-rolls such a secret.
- The LMS completion webhook was refused by the origin guard (no `Origin` on a
  server-to-server call); its validated `X-Webhook-Secret` now stands in for it.
- "Training completions to validate" crashed as soon as one completion was
  waiting (an undefined `locale`); uplift refusals are now translated.
- Erased people still marked active no longer appear on the employee list, in
  the active population behind scope filters or in a manager's governed team.
- The Power BI certification feed printed `IssuedOn` / `ExpiresOn` one day
  early on a server east of UTC (`dateFormat.sqlDateIso`, `appDayIso`).
- SAML refusals name their cause (signature, audience, issuer, clock,
  `InResponseTo`) on the test sign-in page and in `SSO_ERROR`.
- The critical-compliance KPI is floored, never rounded up: 1 999 of 2 000
  critical requirements met reads 99.9 %, not 100 %. Status colours are decided
  on the value printed (`utils/displayedValue.js`), on the dashboard and in the
  department brief.
- The dead hourly `priority-index.refresh` job (its service never existed) is
  removed.
- The audit-trail owner role of the Windows installer is now
  `idevelop_audit_owner`; a role under the legacy name is renamed in place by
  the installer and by migration 169.
- `.gitignore` covers `certs/`, `*.pfx`, `*.pfx.bak` and `*.p12` anywhere.

### Database

- **Migration 168** adds `public.fn_console_reader_sync()`, the SQL console
  read-role grant of migration 167 as a reusable function. Every later
  migration that adds a table, a view or a column ends with
  `SELECT public.fn_console_reader_sync();` (checked by a test).
- **Migration 169** renames a legacy audit-trail owner role.
- **Migration 170** adds the audit-log redaction, seal, sealed-purge and verify
  functions (`fn_system_logs_*`), lets `block_mutation()` through only on those
  vouched paths, draws the chain id under the advisory lock, indexes the chain
  links and seeds `auditLogRetentionYears`. No existing row is rewritten. It was
  rehearsed on a populated copy (about 30 000 chained rows over seven years,
  pre-chain rows and historic forks): the chain verified before and after.
- **Migration 171** adds the `dei_consents` ledger and the provenance,
  needs-review and HR-review columns of `employee_demographics`; rows that exist
  at upgrade are flagged `legacy_unknown` and leave every statistic. Re-grants
  the console reader.
- **Migration 172** adds `report_schedule_recipients` and `report_schedule_runs`
  and the `enabled` / `disabled_reason` columns of `report_schedules`, maps or
  suspends the schedules that sent to typed addresses (owner told once).
  **Migration 173** makes a copy's content emptiable (`purged_at`,
  `purge_reason`) and seeds `reportRunRetentionDays`. Both re-grant the console
  reader.
- **Migration 180** adds the successor state and removal columns, the LMS
  decision trail (`decided_by_ref`, `decided_at`, `decision_reason`), and the
  deactivation reason of coverage rules and planned absences, with CHECKs that a
  removal, a decline and a cancellation carry a reason; recreates
  `v_continuity_coverage` over active successors (same columns). Re-grants the
  console reader. **Migration 181** widens `employee_movements.kind` with
  `assessment_reset`, keeping every former value.

- **Migration 184** adds the KPI module's snapshot columns to `kpi_snapshots`
  (`not_ready_count`, `partial_count`, `unassessed_count`,
  `critical_unassessed`, `certs_expired`, `safety_fit_pct`, `kpi_contract`)
  and an index on the contract. Additive; re-grants the console reader.
- **Migration 185** adds `dashboard_scope_prefs`: the last dashboard scope each
  account chose, per page (a small JSON object of ids, CHECK on its shape).
  Additive; re-grants the console reader.

- **Migration 186** adds `kpi_targets` (append-only by `block_mutation`, a
  reason required), `kpi_alert_states` and `kpi_alert_events`. **Migration 187**
  widens `kpi_snapshots.scope_type` with `department`, adds `safety_fit_n`, and
  the `persona_digests` archive and `persona_digest_prefs`. **Migration 188**
  adds `employees.role_start_date` and the trigger that stamps a role change
  (column-granted to the console reader by the sync). **Migration 189** adds
  `bench_strength_pct`, `bench_critical_roles` and
  `critical_roles_without_ready` to `kpi_snapshots`. All additive and
  idempotent (rehearsed twice on a populated copy); each re-grants the console
  reader.

### Tests

- DB-backed suites are serialised across jest workers by a PostgreSQL advisory
  lock (`tests/helpers/dbSuiteEnvironment.js`), so `npm run test:unit` no
  longer deadlocks; they get a 60 s default timeout.
- Every suite guards on the database **name** (`tests/helpers/testDatabase.js`),
  never on a substring of `DATABASE_URL`.
- Real-app suites wait for the server's i18n middleware (`i18nReady()`) instead
  of a fixed sleep; dead skipped placeholders are removed.
- Audit log: `auditIdsOnly`, `auditSsoIdsOnly`, `auditLoginFailedOnce`,
  `auditLogLinearScrub`, and the database suites
  `auditChainRedactionSealPurge-db` and `auditErasureNeedles-db`.
- Privacy and sessions: `deiConsentSelfDeclaration`, `deiConsent-db`,
  `nationalitySwitch`, `returnToAfterSignIn`, `anonymousNoSession`,
  `sharedComputerMode`, `sharedComputerLoginView`, `selfAssessmentDraftsWiped`,
  `samlStrictMode` and `sensitiveSettingsBand`.
- Mail privacy: `accountSetupLink` and the database suite
  `reportScheduleAccounts-db`.
- Targets, alerts, « What changed », summaries and the capability map:
  `c327-A-alert-rules`, `c327-A-targets-page`, `c327-B-narrative`,
  `c327-B-digest-page`, `c332-CM-map` and the database suites
  `c327-A-targets-alerts-db`, `c327-B-persona-digest-db`,
  `c327-C-k14-bench-db` (with the idempotency of migrations 186 to 189) and
  `c332-CM-db`.
- Guard tests across the layers: `c334-GUARD-enum-literals`,
  `c334-GUARD-enum-columns`, `c334-GUARD-locale-states`,
  `c334-GUARD-render-standalone`, `c334-GUARD-date-lint`,
  `c334-GUARD-population-parity`, `c334-GUARD-routes`,
  `c334-GUARD-dead-columns` and `c334-GUARD-tick-registry` over
  `tests/helpers/guards/`; page journeys and repaired forms: `agoBucket`,
  `pageJourneys` and `adminFormsRepaired`.

### Security (CSRF on uploads, SSO notices, security panels)

- **CSRF on multipart uploads (audit SA-15, fixed).** The data-management and
  full-system imports, the skill-matrix workbook and the certificate evidence
  form were exempt from the CSRF token check because multer parses the body
  after it. Nothing is exempt now: the token travels in the `x-csrf-token`
  header (every same-origin `fetch` mutation gets it from `public/js/main.js`)
  or, for a native multipart form, as `?_csrf=` on its action (read for
  multipart requests only, redacted in the request log). A missing or wrong
  token is refused with 403. `/api/v1` keeps its key model. A test enumerates
  every upload mount (21 routes, HRIS CSV and ESCO upload included) from the
  live routers.
- **SSO invitations**: neutral wording ("your {{provider}} account"; the
  Windows/Outlook sentence only for a Microsoft account; "your company account"
  when the provider has no name); the reminder prefix in both halves of the
  subject; the in-app notice opens `/account/sso-change`, the same explanation
  as the e-mail for the signed-in person only, with the go-live date or the
  provider as its subtitle. A printed notice is due for everyone who never
  received the e-mail (no address or e-mail off).
- **Security panels** that the earlier ports left without a view: the
  unencrypted SMTP relay warning (settings page and dashboard) and its
  SuperAdmin form; the copilot egress gate (why the AI provider is off, the
  allowed private hosts, the recorded transfer basis and its form); a locked
  badge and notice on security-class settings for local admins; the MFA grace
  banner; the per-key `?apiKey=` toggle with a deprecation notice; the
  antivirus status on the Health and Compliance pages.
- **New App Settings**: `requireMalwareScan` (`auto` by default: required once a
  scanner is detected), `privacySelfExportPerHour` (5),
  `unreadNotificationRetentionDays` (blank follows the read window) and
  `onboardingRejectedRetentionDays` (180). All are SuperAdmin-only.

### Security (uploads, privacy, erasure, installer)

- **Upload content checks.** Every upload route, the HRIS CSV and the
  skills-library ESCO upload (CSV or zip) included, now checks that the file's
  content matches its extension (magic bytes, OOXML content types, macro parts
  refused, zip caps) and answers a malformed upload with a 4xx instead of a 500.
- **Malware scan chain** (migration 164): ClamAV over TCP or a socket, then the
  Microsoft Defender command line, then "not scanned". On the Windows installer
  every upload used to end in `scan_error` because only a Unix socket was tried.
  A host without a scanner no longer blocks uploads: an unscanned file can be
  downloaded only by its uploader, the reporting line and HR, as an attachment.
  Old `scan_error` files are re-queued and rescanned every 15 minutes.
  `REQUIRE_MALWARE_SCAN=1` holds unscanned files instead.
- **Privacy** (migration 165): a versioned FR/EN privacy notice, published by a
  SuperAdmin from the works-council register and acknowledged by every signed-in
  person; a JSON download of one's data on "What is recorded about me"; an
  objection to profiling that stops the retention-risk score, keeps the person
  out of the key-person names and the copilot's rankings, and holds automatic
  9-box actions for a human decision.
- **Erasure** (migration 166): manual erasure is refused under legal hold unless
  a reasoned override is approved by a second, different SuperAdmin. A
  schema-driven registry classifies every employee column and every table (a
  test fails on an unclassified one), uploaded files are deleted, and the export
  gains certifications, aspirations, applications, planned absences,
  notifications, HRIS links and training. Old unread notifications are pruned
  and rejected sign-up applicants pseudonymised.
- **Windows installer**: downloads pinned by SHA-256 and publisher signature;
  PostgreSQL 17.11; the `pg_hba.conf` trust window needs
  `-AllowPasswordRecovery` or a typed `TRUST` and is logged; passwords go to
  `psql` through stdin; warnings for `trust` lines and an unsynchronised clock;
  firewall rules tagged and reconciled; the service log folder restricted; the
  package root is an allow-list, `.gitleaks.toml` and `.dockerignore` no longer
  ship, and an `-IncludeData` package fails on any secret-table row.

### Security

- API rate limit: a request carrying an unknown key no longer gets a bucket of
  its own. The per-address bucket always applies; only a key that validates
  (an `api_keys` row or the legacy shared key) earns a second, per-key bucket
  (`API_IP_RATE_LIMIT`, default `API_RATE_LIMIT`).
- Sign-in fails closed when the MFA state cannot be read (it used to open the
  session on the password alone).
- Timing: an unknown, inactive, locked or not-yet-activated identifier costs the
  same bcrypt comparison as a real account; the password-reset mail is sent
  without holding the answer.
- Re-issuing MFA backup codes invalidates the unused older ones.
- A CSRF failure logs a short hash of the session id, never the id itself.
- Report builder and import: field names are looked up as own properties only
  (an inherited name such as `constructor` is not a column), an unknown data
  source is a 400, and `BaseModel.create()` checks column identifiers as
  `update()` does.
- `/api/v1` applies the same `APP_KEY` guard to the legacy shared key as the
  other API surfaces.
- The installer package no longer ships `.gitleaks.toml` or `.dockerignore`.
- The SSO page always shows the canonical SAML reply URL
  (`/auth/sso/saml/callback`), never a mistyped configured value.
- SSO reply URLs: a base URL that points at a page of the app (`…/login`,
  `…/dashboard`, `…/auth/…`) is normalised to the application root, with a
  warning in the log; `/login/auth/sso/:provider/callback` is answered by the
  same handler and `/login/login` redirects to `/login`; the SAML reply URL
  configured on the SSO page is answered too when it differs from the
  canonical one (same handler and checks; the origin guard and the CSRF skip
  accept it). The SSO settings page receives `callbackMismatch` to name the
  address to register instead.
- **Secrets at rest (audit SA-18 closed). `APP_KEY` is now required in
  production:** the service refuses to start when it is missing, shorter than
  32 characters or a placeholder, and `SESSION_SECRET` is never used as an
  encryption key there.
    - secretBox v2: `enc:v2:<purpose>:…`, AES-256-GCM under HKDF-SHA256 of
      `APP_KEY`, the purpose bound as additional data. Existing `enc:v1:` values
      stay readable and are re-encrypted on their next write or by the rotation
      script.
    - MFA secrets v2 (HKDF over the whole `APP_KEY` instead of its first 32
      characters); a v1 secret is re-encrypted after its next successful use.
      Confirming an already-active MFA enrolment is refused, and the code used to
      confirm is consumed.
    - The SMTP password and the AI provider key are encrypted in `app_settings`
      (lazily for existing values), shown only as a mask, never exported to JSON,
      never imported from JSON and never copied into snapshots; snapshots taken
      earlier are scrubbed once at start-up.
    - `scripts/rotate-app-key.js` re-encrypts every store, v1 and v2: app
      settings, LMS, webhooks, safety gate, HRIS connector credentials and MFA
      secrets.
- **Two-factor authentication is mandatory** for every administrator role and
  for managers who sign in with a password (SSO sessions rely on the identity
  provider's MFA), migration 162. An upgraded install gets a grace period
  (14 days for administrators, 30 for managers) with a countdown at each
  sign-in; a new install enforces it at once. The gate fails closed, and so
  does the per-account `mfa_required` policy. SuperAdmins can switch the
  policies off (`mfaRequiredForPrivileged`, `mfaRequiredForManagers`).
- **Session defaults: 30 minutes idle, 12 hours absolute** (they were 60 min
  and 24 h). An upgrade changes them only where the old default was never
  changed.
- Sign-in throttling: progressive delays per (address, identifier) and per
  endpoint, a per-address ceiling high enough for a site behind one address
  (`LOGIN_IP_CEILING`, default 100); administrator accounts are locked after
  10 failures (`ADMIN_HARD_LOCK_AFTER`) and the SuperAdmins alerted; other
  accounts are slowed, never refused, and the person is notified. A wrong
  current password on `/change-password` or a wrong code at `/login/mfa`,
  `/v2/uam/mfa/verify` or `/v2/uam/mfa/disable` counts toward the lockout,
  and those checks are rate-limited per user.
- **API keys go in headers** (`X-API-Key`, or an opaque bearer token in
  `Authorization`). A key in the URL (`?apiKey=`) is refused with a 401 that shows the
  header form, except for a key that carries the per-key compatibility flag
  (migration 163: keys that existed at the upgrade keep it, new keys never get
  it) or the env shared key with `API_KEY_QUERY_STRING=1`. A SuperAdmin
  switches the flag per key (`POST /api/v1/admin/api-keys/:id/query-string`,
  audited). In Power Query:
  `Web.Contents(url, [Headers=[#"X-API-Key"="ak_…"]])`.
- **Security-class settings are SuperAdmin-only** (refused server-side,
  audited): authentication, sessions, MFA, SSO, onboarding, data retention,
  AI/copilot, API, backup, the public base URL, the outgoing mail server and
  HRIS. Operational settings stay delegable (`manage_app_settings`). The
  settings page receives `locked` / `securityClass` per row for a read-only
  badge.
- **SMTP requires TLS.** STARTTLS is mandatory (`requireTLS`), so an attacker
  cannot strip it and credentials are never sent in clear. Product decision:
  one internal relay may be exempted by a SuperAdmin
  (`POST /app-settings/smtp/plaintext-relay`, reason mandatory, audited); it
  must resolve to a private or loopback address, it is reached at the pinned
  address, and SMTP credentials are still never sent to it without TLS. The
  dashboard and the settings page receive the relay status for a permanent
  warning.
- **Copilot egress gate (audit SA-17).** Product decision, safe by default:
  a private, loopback or link-local AI target is refused unless a SuperAdmin
  lists it in `copilotAllowedPrivateHosts` (or `copilotTrustedHosts`); plain
  http only for an allow-listed loopback model without an API key; the
  connection is pinned to the checked address and redirects are refused; an
  external provider stays blocked until a SuperAdmin records the legal basis
  of the transfer and the processor-agreement acknowledgement for that
  provider and host (`/app-settings/copilot/transfer-basis`, audited,
  withdrawable). A blocked call answers with the built-in engine and sends
  nothing. `COPILOT_BLOCK_PRIVATE_HOSTS` is no longer read.
- **SQL console secret guard.** The SuperAdmin SQL console refuses, read and
  write, every statement that reaches sessions, second factors, reset tokens,
  password and API-key hashes, LMS, webhook and safety-gate secrets, HRIS
  connector credentials and secret settings. The script is tokenised the way
  PostgreSQL reads it (comments, quoted and qualified names, views, routine
  and `DO` bodies, computed dynamic SQL), and the doors to the same data are
  closed (server files, large objects, `dblink`, `*_to_xml`, `SET ROLE`,
  role and extension management). Each refusal is audited
  (`SQL_CONSOLE_SECRET_REFUSED`); a top-level `SELECT *` that is allowed has
  its secret cells masked.
- **Migration 167: `sqlconsole_reader` role.** Pure reads from the console
  run under a read-only role that has no privilege on the secret tables or
  columns (column-level grants, including `hris_connectors.credentials`). Once
  it exists, `SELECT *` on a table with a secret column is refused by
  PostgreSQL and the console asks for a column list. Without CREATEROLE the
  migration logs a notice and the application guard still applies. A later
  migration that adds tables must repeat its grant block (CONTRIBUTING.md).
- HTTP hardening moved into `src/middleware/httpHardening.js`, with tests:
    - JSON detection is anchored on the MIME essence, so
      `text/plain; x=application/json` no longer skips the CSRF check;
    - `Origin: null` is refused on every state-changing request unless a machine
      credential validates, and a malformed `Origin` is refused on form posts too;
    - pages send `Referrer-Policy: same-origin` (our own form posts then carry a
      real `Origin`); `/api` and `/scim` keep `no-referrer`;
    - `Permissions-Policy` also denies Bluetooth and the Topics API;
    - the session cookie is `__Host-app.sid` whenever it is always `Secure`
      (`COOKIE_SECURE=1` or built-in TLS); an existing `app.sid` session is
      carried over once, so nobody is signed out by the upgrade;
    - logout sends `Clear-Site-Data: "cache"`;
    - `/health` and `/readyz` answer the status only, unless the caller passes the
      `/metrics` gate, which now also accepts `METRICS_ALLOW_IPS`;
    - an anonymous remote `GET /api/v1/` returns `{status:'ok'}` only and
      `/api/v1/openapi.json` needs a session, a valid key or a loopback caller
      (the installer's local check still reads the version);
    - `system_logs` no longer records every successful mutation (`HTTP_POST`…);
      it keeps 401, 403 and 5xx. Authenticated mutations stay in the bounded
      activity trail (`perf_events`).

## [1.0.0] — 2026-09-29

First public release of **IDevelop Community Edition**.

### Added

- Friendly "Open Horizon" interface (`public/css/horizon.css`): light-first
  Daylight mode and a soft Dusk dark mode, rounded surfaces, pill navigation and
  buttons, gradient page banners, sentence-case labels, no grid texture.
- UX & design committee round 1 (`docs/DESIGN-REVIEW.md`): WCAG 2.2 AA fixes,
  self-hosted brand typeface, "Match device" mode, shared empty states, mobile
  layout fixes, friendlier bilingual copy, fictional demo organisation
  (`npm run db:seed:demo-org`).
- Innovation & business performance committee (`docs/PRODUCT-STRATEGY.md`):
  ESCO taxonomy import, bilingual survey templates, Slack / Teams webhook
  formats, works-council register, "What is recorded about me", EU AI Act
  copilot guardrails, employee growth panels (target-role gap, closest roles,
  suggested learning), manager team roster and team approval, scoped
  recognition.
- UX round 2: getting-started progress, card tables on phones, one filter-bar
  pattern, readiness legends, UK English, localised numbers and manifest.
- Appearance menu in the top bar: light/dark mode and four colour themes (Iris,
  Meadow, Sunrise, Ocean), remembered per browser, all measured WCAG AA.

- New product identity "Open Horizon": logo mark, horizontal logos (dark and
  light), favicons, PWA and Apple icons, social card (`public/brand/`,
  `public/icons/`), Iris / Coral colour system for both themes, Plus Jakarta Sans
  and JetBrains Mono typography, graphic chart in `docs/BRAND.md`.
- "Horizon" data-visualisation palette with measured contrast and
  colour-vision-deficiency separation (`src/utils/branding.js`).
- `src/config/product.js` — the single declaration of the product identity.
- Generic, CC0-licensed starter capability framework (6 pillars, 12 sub-domains,
  34 bilingual skills, 5 role families, 6 sample roles) and
  `npm run db:seed:starter`.
- Skills library (`/framework/library`): four CC0 sector packs (mining & heavy
  industry, public sector, healthcare & care, office & digital services) and an
  in-browser ESCO import (CSV files or one zip, group selection with a
  per-import cap), both with a dry run before confirming, idempotent loading
  through `FrameworkPackService` and an audit row per import.
- Language-neutral contracts in `docs/contracts/` (OpenAPI, chart identity,
  product identity) with `npm run contracts:export` and a drift test.
- Documentation for external contributors: `README.md`,
  `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull-request templates.
- Repository-wide guard test that rejects legacy names and leaked personal data
  using hashed tokens.
- CI on PostgreSQL 16 and 17 using the product's own migrator and a
  deterministic seed.
- AI companion for every signed-in user: an "Assistant" tab (first, default) in
  the help panel answers "how do I…", "what should I do next", "explain this
  page" and "what is…" from a bilingual built-in knowledge base
  (`src/config/companionKnowledge.js`) filtered by role and permissions, with no
  language model required. Employees get only their own readiness and to-dos;
  managers' and admins' data questions go through the RBAC-scoped copilot with
  its EU AI Act guardrails. An allowed copilot model may rephrase product-guide
  answers but never receives personal data. `POST /api/companion/ask`,
  `GET /api/companion/suggestions`, admin switch `companion.enabled` (default
  on), audited as `COMPANION_QUERY`.

### Changed

- Licence text: full GNU AGPL v3.0 (`LICENSE`) plus `NOTICE` with trademark and
  third-party attributions.
- Docker image on Node 22 with OCI labels; Compose refuses to start without real
  secrets instead of falling back to insecure defaults.
- Windows packaging no longer bundles a database snapshot unless explicitly
  requested (`-IncludeData`), and its name guard reads an operator-supplied,
  git-ignored denylist.
- Base schema runs on PostgreSQL 16 as well as 17.
- Commit scopes are functional areas instead of internal project phases.

### Security

- SQL console disabled unless `SQL_CONSOLE_ENABLED=1` is set by the operator.
- Copilot: non-EU providers blocked by default; no named-person ranking unless
  enabled.

- Imported administrator accounts no longer receive a shared, publicly known
  default password; they get an unknowable secret and a forced change.
- No credential ships in `installer/config.psd1`.

### Fixed

- Client-side sortable table headers rendered as unstyled browser buttons.
- Pre-existing lint errors and unformatted files that kept CI red.
