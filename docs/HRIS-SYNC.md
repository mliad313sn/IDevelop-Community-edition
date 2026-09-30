# HRIS synchronisation

IDevelop CE can keep its employee records in step with your HR information
system (HRIS). Joiners are created, movers are moved and leavers are
deprovisioned, using the same rules as the employee form and the joiner / mover
/ leaver (JML) lifecycle.

Three connectors ship today:

| Connector         | How it reads                                                                   | Status                                                                                 |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| CSV / TSV file    | a file dropped in a server folder (for example by your own SFTP), or an upload | tested                                                                                 |
| Personio (API v1) | client credentials, `GET /v1/company/employees`, paginated                     | **implemented from public API documentation, not yet validated against a live tenant** |
| Lucca (API v3)    | API key, `GET /api/v3/users`, with departments and legal entities              | **implemented from public API documentation, not yet validated against a live tenant** |

Workday and SAP SuccessFactors connectors are on the roadmap. Until then, export
from them to CSV and use the drop folder.

Everything is configured by a SuperAdmin on **Administration → App settings →
Integrations → HRIS synchronisation** (`/admin/integrations/hris`). The setup
checklist (`/setup`) links to it as an optional step.

## How a sync works

1. **Fetch.** The connector reads the people and normalises each one to the same
   shape: `externalId, employeeNumber, firstName, lastName, email, jobTitle,
department, site, service, managerExternalId, startDate, endDate, status`.
2. **Map.** Site, department, service and job title are turned into local
   units and roles through the **value mappings** (below). A value that maps to
   nothing is **reported, never invented**.
3. **Plan (dry run).** The plan lists:
    - **joiners**: people who are new and active, with a start date that has
      come. A joiner whose values do not all map is **blocked** and listed with
      the reason;
    - **matches**: people who already exist here are linked by employee number,
      or by an e-mail that only one account carries. The first sync of an
      existing workforce creates **no duplicates**;
    - **movers**: a changed site, department, service, role or manager
      (supervisor). Name and e-mail changes are **profile updates**;
    - **leavers**: an end date in the past, or an inactive status. In a **full**
      export, a linked person who is absent from the file is also a leaver;
    - **unmapped values**, with how many people carry each one, and **errors**
      (a duplicate identifier, a missing name, and so on).
4. **Review.** Nothing has been written yet. Map the unmapped values from the
   plan, run the dry run again, then **Apply**.
5. **Apply.** The plan is recomputed from the stored export against the
   database as it is now, and the safety guard is checked again. Then:
    - joiners are created with the employee-form rules: site, department and
      service must nest, the licence seat limit is respected, the employee number
      and the username are unique, and the supervisor must be active. A `joiner`
      lifecycle event follows. The account has no password: the person signs in
      through SSO or is sent an invitation;
    - movers go through `LifecycleService` (a `mover` event, a handover plan when
      the lifecycle opens one);
    - leavers are **deprovisioned** through `LifecycleService.deprovision`, the
      same path as SCIM and the JML screen. The employee and their account are
      switched off, sessions are ended, and linked admin accounts and API keys
      are revoked.
6. **Idempotent.** Every person is linked to their external identifier
   (`hris_links`). Applying the same export again changes nothing.

Each run is recorded in the sync history (`hris_sync_runs`), with its counts,
its errors and what triggered it (a person, an upload or the schedule). Every
action is written to the audit log (`HRIS_*` actions). A dry run can be applied
only once, only while it is the latest plan, and only for 7 days.

## The safety guard

A broken export must never switch off half the company. A plan is **stopped**
(status "Stopped (safety)") when either of these is true:

- it would deactivate **more than 10%** of the active employees in one run. The
  threshold is set per connector, between 1 and 100;
- a **full** export holds no one at all while people are linked.

A stopped plan cannot be applied. A scheduled run that stops raises an alert to
every SuperAdmin (the "HRIS sync stopped" notification). Check the export. If
the departures are real, apply them in smaller batches: raise the threshold for
one run, or use the JML screen.

## Value mappings

The mapping rules are shared by every connector **and by SCIM placement**:

1. an explicit mapping (`HRIS value → local unit or role`) always wins;
2. otherwise, when "Match by exact name" is on (the default), a value equal to
   the name or code of **one** active local unit matches it. Case, accents and
   extra spaces are ignored. When the site is known, departments are only
   searched in that site. An ambiguous name matches nothing;
3. the service can also be found from the department value (map the HRIS
   department to a local service), and a department with exactly **one**
   active service takes it;
4. anything else is **unmapped**. It is listed in the plan and mapped from
   there in two clicks.

A mapping to a unit that has since been deactivated resolves to nothing, so it
is reported again.

## Connectors

### CSV / TSV file (drop folder or upload)

- **Drop folder**: set the folder path. The scheduled job reads the **newest**
  `.csv`, `.tsv` or `.txt` file in it. Point your HRIS export, or your own SFTP
  server, at that folder. Set the `HRIS_DROP_ROOT` environment variable to
  confine the folder to one directory tree.
- **Upload**: on the same page, upload a file (25 MB at most). The upload only
  prepares a dry run; nothing is applied until you confirm.
- **Delimiter**: detected (tab, `;` or `,`), or forced.
- **Type**: **full** (the default: someone absent from the file has left) or
  **delta** (the file only carries changes, so only an end date or an inactive
  status makes a leaver).

Default headers (download them from **CSV template**). Every column is
optional except an identifier. Any header name can be changed under
**Column names**, and matching ignores case, accents and separators:

| Header                | Field           | Notes                                                                                                      |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `external_id`         | HRIS identifier | the stable key. When absent, `employee_number` is used                                                     |
| `employee_number`     | employee number | also used to match existing employees on the first sync                                                    |
| `first_name`          | first name      | required for a joiner                                                                                      |
| `last_name`           | last name       | required for a joiner                                                                                      |
| `email`               | e-mail          | an invalid address is ignored, not stored                                                                  |
| `job_title`           | role            | mapped to a local role; required for a joiner                                                              |
| `department`          | department      | mapped to a local department                                                                               |
| `site`                | site            | optional when the department already fixes it                                                              |
| `service`             | service         | optional when the department has one service, or is mapped to one                                          |
| `manager_external_id` | manager         | the manager's `external_id`; becomes the supervisor                                                        |
| `start_date`          | start date      | `YYYY-MM-DD` or `DD/MM/YYYY`; a future date makes an "upcoming" joiner                                     |
| `end_date`            | end date        | a past date makes a leaver                                                                                 |
| `status`              | status          | `inactive`, `terminated`, `left`, `inactif`, `sorti`, `false`, `0`… make a leaver; anything else is active |

Example:

```csv
external_id,employee_number,first_name,last_name,email,job_title,department,site,service,manager_external_id,start_date,end_date,status
HR-0001,E0001,Awa,Diallo,awa.diallo@example.com,Welder,Mining,Stonebridge,Open Pit,HR-0002,2024-03-01,,active
HR-0002,E0002,Moussa,Koné,moussa.kone@example.com,Foreman,Mining,Stonebridge,Open Pit,,2019-06-15,,active
```

### Personio

> Implemented from the public API documentation, not yet validated against a
> live tenant. Start with **Test the connection** and a dry run.

1. In Personio, create API credentials (Settings → Integrations → API
   credentials). Allow at least these attributes: first name, last name, e-mail,
   status, position, department, office, team, supervisor, hire date and
   termination date, plus the attribute that holds your employee number.
2. On the HRIS page, choose **Personio**, enter the client ID and the secret.
   Leave the API address blank for `https://api.personio.de`.
3. Under **Personio attributes**, set the employee number attribute (usually a
   custom one, such as `dynamic_123456`). Change the others only if your tenant
   uses different ones. By default the site comes from the office and the
   service from the team.
4. The connector authenticates (`POST /v1/auth`), then reads
   `GET /v1/company/employees` 200 at a time (`limit` / `offset`). It uses a
   rotated token when Personio returns one. Status `inactive` or a past
   termination date makes a leaver; `onboarding` and `leave` are still employed.

### Lucca

> Implemented from the public API documentation, not yet validated against a
> live tenant. Start with **Test the connection** and a dry run.

1. In Lucca, create an API key with read access to users, departments and legal
   entities.
2. On the HRIS page, choose **Lucca**, enter your tenant address (for example
   `https://acme.ilucca.net`) and the API key. The key is sent as
   `Authorization: lucca application=<key>`.
3. The connector reads `GET /api/v3/users` (with `formerEmployees=true`, so that
   a departure is seen through its contract end date), paginated with
   `paging=<offset>,<limit>`. When a user carries only a department or legal
   entity id, the name is looked up in `/api/v3/departments` and the legal
   entities endpoint. The site comes from the **legal entity** (or from the
   **establishment**, if you choose it). Lucca has no service, so map each
   department to a service, or let a department with a single service take it.

## Schedule

The `hris-sync.tick` job runs every hour and does nothing until a connector is
**enabled**. Only one connector can be enabled at a time. It then runs once a
day, at or after the connector's hour (02:00 by default):

- always a **dry run** first;
- when **Apply automatically** is ticked, the plan is applied at once, unless
  the guard stops it;
- otherwise the SuperAdmins are told that a plan is waiting for review ("HRIS
  sync: a plan is waiting for your review"). Nothing is applied until someone
  clicks **Apply**.

## SCIM placement

SCIM provisioning (`POST /scim/v2/Users`) queues new users in the onboarding
queue, where an administrator places them. With **Place new SCIM users
directly** switched on (the `hris.scimAutoPlace` setting, off by default),
these values go through the **same value mappings**:

- `title` (the role);
- the enterprise extension `department`, `employeeNumber` and `manager.value`.
  The manager value is an IDevelop user id, as returned by SCIM, or an
  identifier already linked through SCIM.

When **every** value maps and the key is unrestricted (owned by a SuperAdmin),
the person is created and placed at once, and SCIM answers `201` with the
active user. Otherwise the request falls back to the onboarding queue, exactly
as before.

## Security

- Credentials are encrypted at rest with `secretBox` (AES-256-GCM under
  `APP_KEY`) and never sent back to the browser. An empty box keeps the stored
  value. Changing credentials needs a sign-in in the last 15 minutes, or the
  current password (`recentAuth`).
- Every outbound URL goes through the same SSRF guard as webhooks. Only public
  `https` addresses are allowed. Loopback, private, link-local and metadata
  addresses are refused, whatever the notation, and so is a name that resolves
  to one. The connection is pinned to the checked address, redirects are never
  followed, and every call has a timeout (20 s) and a size cap (25 MB).
  `HRIS_ALLOW_PRIVATE=1` lets an operator reach an on-premises HRIS gateway on
  the LAN.
- Every route is SuperAdmin-only, and every action is audit-logged.

## Troubleshooting

| Symptom                                         | What to check                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Address refused: it targets an internal…"      | The API address is private or loopback. For an on-premises gateway, set `HRIS_ALLOW_PRIVATE=1`.                                                                                                  |
| "The drop folder holds no .csv or .tsv file"    | The export did not arrive, or has another extension. Check the transfer and the folder path (and `HRIS_DROP_ROOT`).                                                                              |
| "No identifier column"                          | The file has neither `external_id` nor `employee_number`: rename the header or set it under **Column names**.                                                                                    |
| Every joiner is blocked on "Role not mapped"    | Map the job titles from the plan (**Unmapped values**), then run the dry run again.                                                                                                              |
| "Service not mapped" with the department's name | The department has several services and the HRIS sends none: map the HRIS department to one service.                                                                                             |
| "Stopped (safety)"                              | The run would switch off more people than the threshold allows, or the full export was empty. Check the export; if the departures are real, raise the threshold for one run.                     |
| People are created twice                        | Should not happen. Existing employees are matched on employee number, then e-mail. If e-mails are shared, the person is listed under "Issues to resolve": add the employee number to the export. |
| "Active in the HRIS but deactivated here"       | The person was switched off locally but is still active in the HRIS. Reinstate them from the JML screen, or correct the HRIS. The sync never reactivates anyone on its own.                      |
| Personio 401 / 403                              | Wrong credentials, or an attribute that is not allowed for the credentials. Check the attribute list in Personio.                                                                                |
| Lucca 401                                       | The key is wrong or lacks read access to users.                                                                                                                                                  |
| The nightly run did nothing                     | The connector is not enabled, the hour has not come, or it already ran today. See the sync history and **Instance health**.                                                                      |
