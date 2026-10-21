# Security incidents and personal-data breaches

This procedure is for the organisation that runs IDevelop: the incident lead,
the data protection lead, the SuperAdmins and the IT operator. It says who
decides what, how to keep the evidence IDevelop holds, and how to meet the
72-hour deadline for notifying a personal-data breach. Adapt it to your own
incident policy and fill in the contacts before go-live
([GO-LIVE.md](GO-LIVE.md), section 5). French version:
[INCIDENT-RESPONSE.fr.md](INCIDENT-RESPONSE.fr.md).

IDevelop holds HR data: assessments, development and improvement plans,
disputes, 9-box placements, certificates, and, where the local content module
is on, nationality. A leak of it can harm the people concerned. Treat every
doubt as an incident until it is ruled out.

A vulnerability in the IDevelop software itself is reported to the project as
described in [SECURITY.md](../SECURITY.md), in addition to this procedure.

## Who does what

| Role                         | Who in your organisation | Decides or does                                                                                                                                                  |
| ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incident lead                |                          | Opens and closes the incident, keeps the log, calls the others, decides on containment.                                                                          |
| Data controller (management) |                          | **Decides whether to notify** the supervisory authority and the people concerned, on the advice of the data protection lead. The organisation is the controller. |
| Data protection lead (DPO)   |                          | Assesses the risk to people, drafts the notifications, records the breach in the breach register, whether or not it is notified.                                 |
| SuperAdmin (two, never one)  |                          | Acts in IDevelop: sessions, accounts, API keys, webhooks, settings, exports of the audit trail.                                                                  |
| IT operator                  |                          | Acts on the server: isolation, copies of logs and databases, secrets rotation, restores.                                                                         |
| HR lead and communication    |                          | Words the message to employees and workers' representatives once the controller has decided.                                                                     |
| Hosting provider (if any)    |                          | As a processor, tells the controller of a breach without undue delay and helps with the evidence.                                                                |

Write the names and two ways to reach each person (telephone and an address
outside the affected system) in the empty column, and keep a printed copy.

## The clock

- **Hour 0** is the moment someone in the organisation is reasonably certain
  that a security incident has touched personal data. Write it down in UTC.
- **Within 72 hours** of hour 0, the controller notifies the breach to the
  supervisory authority designated by your national law, unless the breach is
  unlikely to result in a risk to the people concerned. If everything is not
  known yet, notify what is known and complete it later; give the reasons for
  any delay past 72 hours.
- **Without undue delay**, when the risk to the people is high, the controller
  tells them directly, in clear language: what happened, the likely
  consequences, what was done, what they can do, and whom to contact.
- **Always**, notified or not, the data protection lead records the breach,
  its effects and the measures taken in the breach register.

The GDPR (Articles 33 and 34) sets these rules in the European Union; other
laws have similar ones. Your data protection lead says which apply to you.

## 1. Detect and report

Signals IDevelop gives (every SuperAdmin receives them at once):

- security notifications: an emergency-access sign-in, a SuperAdmin's second
  factor or password changed, an administrator account locked, single sign-on
  refused on a SuperAdmin account;
- `ops.job_failed`: a job failed or a daily job has not run for 36 hours (the
  backup, the audit anchor, the audit seals);
- the audit-chain check in System Logs reports a break (`brokenAt`);
- the external watchdog mails that the application stopped answering.

Signals from outside: a person who sees data they should not, a file of HR data
found where it should not be, an unknown API key or webhook, a lost laptop with
an open session, an alert from your monitoring.

Whoever notices it tells the incident lead at once, with the time, what they
saw and what they already did. They change nothing else.

## 2. Contain

Pick the smallest action that stops the harm. Each is audited in IDevelop.

| Situation                                     | Action in IDevelop                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One account is compromised                    | Administration › Sessions (`/admin/sessions`): end its sessions. Then deactivate the person (sessions, linked administrator accounts and API keys are switched off together), or reset the password and the second factor. |
| An administrator account is compromised       | Revoke its administration access (`/admins/:id/revoke-access`) or deactivate it; check what it changed in System Logs.                                                                                                     |
| An API key leaked (a Power BI file, a script) | Administration › API Keys / Power BI: revoke the key, issue a new one to the owner.                                                                                                                                        |
| Data leaves through a webhook                 | The webhooks page (`/v2/cap/webhooks`): switch the subscription off.                                                                                                                                                       |
| Data leaves to the AI assistant               | App Settings: switch the copilot off and revoke the transfer basis.                                                                                                                                                        |
| The SQL console is involved                   | Unset `SQL_CONSOLE_ENABLED` and restart.                                                                                                                                                                                   |
| The server itself is compromised              | Take it off the network at the reverse proxy or the firewall. Do not switch it off before the IT operator has copied memory and disks if your forensic policy asks for it.                                                 |

Shorten the session timeout or switch on shared-computer mode only if they help
with this incident; write down the old values to put them back.

## 3. Keep the evidence

Do this **before** anything is restored, rotated or cleaned, and write in the
incident log who copied what, when, and the SHA-256 of each copy.

| Evidence                             | How to keep it                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The audit trail                      | System Logs (`/system-logs`): filter on the period and the accounts concerned, then export. A request's detail (`/system-logs/request/:id`) shows everything one request did.                                                                                                                   |
| Proof that the audit trail is intact | In System Logs, run the chain check (`GET /v2/cap/audit/verify`, SuperAdmin) and save its answer. Copy `%ProgramData%\IDevelop\audit-anchors\chain-head.log` (Linux and Docker: `data/audit-anchors`): it was written outside the database each day, so a rewritten chain no longer matches it. |
| The application output               | Copy `<InstallDir>\service\logs` (Windows) or the container's logs for the period.                                                                                                                                                                                                              |
| The database as it is now            | Instance health › « Back up now », or the IT operator's own `pg_dump`, encrypted ([BACKUPS.md](BACKUPS.md)). Keep it apart from the daily rotation.                                                                                                                                             |
| The reverse proxy and firewall logs  | Your infrastructure team.                                                                                                                                                                                                                                                                       |

The audit trail never holds passwords, tokens or keys, and its free texts about
an erased person are redacted with a chained entry that the check accepts.
Exported evidence is itself personal data: keep it with restricted access, and
only for the duration your policy sets.

## 4. Assess

Answer, and write the answers in the incident log:

- Which data: which pages, exports, reports, feeds or tables; for which period.
- Whose data: how many people, which sites. A person's own access export
  (`/v2/cap/dsr/:employeeId/export`, SuperAdmin) lists what IDevelop holds about
  them, including the board texts that name them.
- How sensitive: performance and improvement plans, disputes, 9-box placements,
  retention risk, nationality figures and health-and-safety clearances weigh
  more than a name and a job title.
- Confidentiality, integrity or availability: was data seen, changed, or lost?
  For a change, the audit trail and the chain check say what and by whom.
- Is it still going on?

The data protection lead turns this into a risk level for the people concerned:
none likely, a risk, or a high risk.

## 5. Decide and notify

The controller decides, on the data protection lead's advice, and the decision
is written down with its reasons:

| Risk to people | Supervisory authority                      | People concerned              |
| -------------- | ------------------------------------------ | ----------------------------- |
| Unlikely       | No notification; record it in the register | No message required           |
| A risk         | Within 72 hours of hour 0                  | As your policy says           |
| A high risk    | Within 72 hours of hour 0                  | Directly, without undue delay |

A notification to the authority states: the nature of the breach, the
categories and approximate number of people and records, the contact of the
data protection lead, the likely consequences, and the measures taken or
proposed. Use the authority's own form where it has one.

Workers' representatives are informed as your national law and your agreements
require.

## 6. Recover

- **Secrets.** Rotate what may have been exposed: the database password,
  `APP_KEY` with `scripts/rotate-app-key.js` (it re-encrypts the stored
  secrets; run it without `--commit` first, then with it, then restart),
  `SESSION_SECRET` (every session ends; the fingerprints of failed sign-ins
  change, see [SECURITY-AUDIT.md](SECURITY-AUDIT.md), recommendation 10), the
  SMTP password, the single sign-on client secret at the identity provider, and
  the API keys and webhook secrets.
- **Backups.** Backups made before the incident are readable with the backup
  key they were written with. If that key may have been copied, treat those
  backups as exposed too, and move or destroy the copies your policy allows.
- **Data.** If data was changed, restore the database from the last backup
  before the change ([BACKUPS.md](BACKUPS.md), "Restore by hand", or
  [ROLLBACK.md](ROLLBACK.md) for the full steps), then re-apply the erasures
  made since that backup (`node scripts/reapply-erasures.js`). The data entered
  after the backup must be entered again: list it from the audit trail.
- **Server.** A compromised server is rebuilt, not cleaned:
  [ROLLBACK.md](ROLLBACK.md), "Recovering on a new server".
- Put back the settings changed during containment.

## 7. Close and learn

- The data protection lead completes the breach register entry.
- Within two weeks, the incident lead holds a short review: what happened, what
  worked, what to change (a setting, a permission, a procedure, this page). An
  IDevelop defect goes to the project through [SECURITY.md](../SECURITY.md).
- The incident log, the evidence and the decisions are kept as your policy says,
  then destroyed.

## An example, from start to finish

All the times and facts below are invented.

- **Day 1, 17:40 UTC.** A team manager reports that the laptop they use for
  IDevelop was stolen from a car; the browser was signed in. Hour 0 is
  17:40.
- **17:55.** A SuperAdmin ends the manager's sessions in Administration ›
  Sessions and resets their password. The second SuperAdmin checks System
  Logs: nothing since 16:10, when the manager last worked.
- **18:30.** The audit trail for the day is exported and the chain check
  answers intact; both are filed with their SHA-256.
- **Day 2, 09:00.** The data protection lead assesses: the session was ended
  within 15 minutes, no request came from the session after 16:10, the disk
  was encrypted. Risk unlikely. The controller decides not to notify; the
  breach register records the event, the reasons and the measures.
- **Day 9.** The review adds a rule: managers lock their screen and sign out
  of IDevelop on shared or mobile devices; the security team checks that disk
  encryption is on for every laptop.

## Contacts outside the organisation

| Who                                                                                | How to reach them |
| ---------------------------------------------------------------------------------- | ----------------- |
| The supervisory authority designated by your national law                          |                   |
| Your hosting provider's security desk (if any)                                     |                   |
| Your insurer or legal counsel (if your policy names them)                          |                   |
| The IDevelop project, for a defect in the software ([SECURITY.md](../SECURITY.md)) |                   |
