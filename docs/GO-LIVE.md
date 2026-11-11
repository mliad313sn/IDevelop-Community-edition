# Go-live checklist

This page is for the people who open an IDevelop instance to the whole
organisation: the HR project lead, the SuperAdmin and the IT operator. It lists
what must be true before the first real campaign, in the order it is usually
done, and ends with the go-live reset that empties the trial data. French
version: [GO-LIVE.fr.md](GO-LIVE.fr.md).

Related pages: [OPERATIONS.md](OPERATIONS.md) (running the server),
[BACKUPS.md](BACKUPS.md) (keys and restores), [ROLLBACK.md](ROLLBACK.md) (going
back after an upgrade), [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md) (security
incidents and personal-data breaches), [SIZING.md](SIZING.md) and
[POWERBI.md](POWERBI.md).

Copy the checklist into your project plan. The timings in brackets (T-20 means
twenty working days before the opening day) are a suggestion, not a rule.

## 1. The platform (IT operator, T-20)

- [ ] The server is installed from the release package (Windows: `Setup.bat`;
      Linux or Docker: [README.md](../README.md#quick-start)). On Windows, the
      release was rehearsed on a VM ([installer/README.md](../installer/README.md),
      "Release rehearsal on a Windows VM").
- [ ] The public address is HTTPS with a trusted certificate, and `appBaseUrl`
      (App Settings) or `APP_BASE_URL` names it: the set-password links in
      invitation mails use it. Behind a reverse proxy, `TRUST_PROXY` names the
      proxy and `COOKIE_SECURE=1` is set.
- [ ] `SESSION_SECRET` and `APP_KEY` are long random values, stored in your
      secrets manager. The production start refuses weak ones.
- [ ] The backup key has an offline recovery copy, kept apart from the
      backups (Windows: `node scripts/backup-key.js export --out <file>`;
      Linux and Docker: the `APP_KEY` line). See [BACKUPS.md](BACKUPS.md).
- [ ] `BACKUP_OFFHOST_DIR` points to storage on another machine, and a restore
      drill has been done on a scratch database
      ([OPERATIONS.md](OPERATIONS.md#restore-drill)).
- [ ] The outgoing mail server uses TLS, a test mail arrived, and
      `mailDefaultLanguage` is the language most of your people read.
- [ ] Administration → Instance health (`/admin/health`) shows no pending
      migration and no failed job.

## 2. The content (HR project lead, T-15)

The « Getting started » block of `/setup` walks through these; each line links
to the page that completes it.

- [ ] Modules: only the modules you will use are on (`/admin/modules`).
- [ ] Organisation: sites, departments and services.
- [ ] Skill framework, roles and their requirements, with the critical skills
      flagged.
- [ ] People, each with a role, a site and someone who reviews them.
- [ ] A trial campaign has run end to end on a small pilot group: rating,
      review, a dispute, a development plan.

## 3. « Ready for go-live » on `/setup` (SuperAdmin, T-10)

The second block of `/setup` measures the instance when the page opens. Each
line is either a measurement or a decision you have taken:

| State                  | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Done                   | Measured now, and nothing is left to do.                                                |
| To do                  | Measured now; the count says how much is left.                                          |
| Nothing to measure yet | There is no population to measure (for example no people in the reader's clearance).    |
| Not measured           | The source could not be read. It is never counted as done: find out why before opening. |
| Decision               | A choice you made. Reported, never scored.                                              |

| Line                                       | What it counts                                                              | Where it is fixed      |
| ------------------------------------------ | --------------------------------------------------------------------------- | ---------------------- |
| Safety clearance rules for the roles       | active roles with requirements and no active safety clearance rule          | `/safety-gate/config`  |
| Critical roles and their successors        | critical roles, then those without an active successor (talent module only) | `/v2/continuity`       |
| Critical skills flagged                    | role requirements marked critical                                           | `/roles`               |
| Everyone measurable                        | people whose role has no requirement                                        | `/roles`               |
| Indicator targets decided                  | indicators with a target                                                    | `/kpi/targets`         |
| Second factor for every administrator      | active administrator accounts without a confirmed second factor             | `/admin/access-review` |
| Administrator access reviewed this quarter | administrators (not SuperAdmins) whose access is not attested this quarter  | `/admin/access-review` |
| Privacy notice published                   | published versions of the privacy notice                                    | `/compliance/register` |
| Last backup verified                       | the date of the last nightly backup whose verification succeeded            | `/admin/health`        |
| Single sign-on                             | decision: on or off                                                         | `/app-settings/sso`    |
| Shared-computer mode                       | decision: on or off                                                         | `/app-settings`        |
| Local content (nationality figures)        | decision: on or off                                                         | `/admin/modules`       |

Local administrators can open the page read-only: their people counts are those
of their clearance, a line links only to a page they may open, and only a
SuperAdmin hides the banner. Ask each site's local administrator to read it
before the opening day.

- [ ] Every scored line reads « Done », or the project lead has written down
      why a line stays « To do » and who will close it.
- [ ] No line reads « Not measured ».

## 4. Decisions to record (project lead and SuperAdmin, T-10)

Write each choice in the project file with the date and who took it. All are in
App Settings unless stated; the governance ones are SuperAdmin-only.

| Setting                                                       | Default on a new install | Question to answer                                                                         |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| Authority — who may act on a person (`authority.ladder`)      | `strict`                 | Should the line above the direct manager, and local administrators, act and not only read? |
| 9-box — four eyes (`nineBoxFourEyes`)                         | on                       | Does every team have a second approver for 9-box placements?                               |
| Dispute — auto-finalise at the deadline                       | off                      | Who holds `arbitrate_disputes` and decides level-2 disputes in time?                       |
| Improvement plans — HR visa before activation                 | off                      | Must HR see every improvement plan before it starts?                                       |
| « What changed » summaries (`personaDigestsEnabled`)          | off                      | Will people receive the weekly point by e-mail?                                            |
| « New in the role » (`newInRoleMonths`)                       | 6                        | For how many months is a person shown as new in their role?                                |
| Retention purge (`retentionPurgeMode`)                        | `report`                 | When does the purge move from report-only to `apply`?                                      |
| Single sign-on, shared-computer mode, local content (modules) | off                      | As reported on `/setup`.                                                                   |

- [ ] The people who decide indicator targets hold `manage_kpi_targets`, and
      those who may read nationality figures hold `view_local_content`. No
      access profile grants either by default.

## 5. Privacy and governance (data protection lead, T-10)

- [ ] The privacy notice is published (FR and EN where both are read); people
      acknowledge it at their next sign-in.
- [ ] The data protection impact assessment covers assessments, the 9-box,
      improvement plans and any use of the assistant. Workers' representatives
      were consulted where your national law asks for it.
- [ ] The record of processing activities names IDevelop; the compliance
      register (`/compliance/register`) is a starting point, not the record
      itself.
- [ ] The incident and breach procedure is known to the people it names
      ([INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md)), with their contact details
      filled in.

## 6. The go-live reset (SuperAdmin with the IT operator, T-2)

The reset empties the data of the trial so that the first real campaign starts
clean. It **keeps** the organisation, the skill framework (roles, requirements,
policies, coverage rules), the list of people, the administrator accounts and
their sign-in factors and API keys, the settings, the audit trail and the
register of privacy requests. It **empties** assessments, campaigns, reviews,
disputes, development plans and proposals, improvement plans and their
checkpoints, 9-box placements, end-of-campaign records, board decisions and
recorded packs, notifications and the other operational data. `.env` is never
touched.

1. Tell the pilot group that their trial data will disappear.
2. Read the plan first. It is a dry run and changes nothing:
   `node scripts/reset-for-golive.js` (or `npm run db:reset:golive`). It lists
   every table it keeps and every table it empties, with row counts. A table
   in neither list stops the run: report it as a defect, do not work around it.
3. Run it. On Windows, `Setup.bat` option **R** shows the same plan, asks you
   to type `PRODUCTION`, takes a restore point and runs the reset. Elsewhere:

    ```bash
    node scripts/reset-for-golive.js --confirm --confirm-word=PRODUCTION
    ```

    Without the typed word, or with another one, the script stops before it
    reads anything. It takes a `pg_dump` into `backups/` before it empties
    anything; `--skip-backup` is for a scratch copy only.

4. Check: `/setup` still shows the organisation, the framework and the people;
   the dashboard reads « not yet assessed » rather than figures; a test
   account signs in.
5. Keep the restore point or the dump until the first campaign has opened
   without trouble, then delete it like any other copy of HR data.

« Reset to defaults » on the settings page is a different action: it puts the
settings back, not the data, and asks for the word `RESET` (or
`RÉINITIALISER`). Neither reset is ever needed for an upgrade.

## 7. Opening day and the first week (everyone)

- [ ] The first campaign is opened and announced (the invitations go out with
      the set-password links if people do not use single sign-on).
- [ ] Each morning of the first week the SuperAdmin reads Instance health and
      the notifications about failed jobs, and the HR project lead reads « Data
      quality » (`/admin/data-quality`) and « Usage by site » (`/admin/usage`).
- [ ] At the end of the first week, the project lead and the SuperAdmin agree
      that the instance is in normal operation; from then on
      [OPERATIONS.md](OPERATIONS.md) applies.

## Sign-off

| Role                 | Name | Date | Signature |
| -------------------- | ---- | ---- | --------- |
| HR project lead      |      |      |           |
| SuperAdmin           |      |      |           |
| IT operator          |      |      |           |
| Data protection lead |      |      |           |
