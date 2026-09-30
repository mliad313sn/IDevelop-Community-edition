# Security policy

## Supported versions

Security fixes are made on the latest minor release of the current major
version and published as a patch release.

| Version                       | Supported                  |
| ----------------------------- | -------------------------- |
| 1.x, latest minor             | ✅ security fixes          |
| 1.x, older minors             | ⚠️ upgrade to latest minor |
| pre-1.0 / unreleased branches | ❌ not supported           |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion.** Report it
privately through GitHub Security Advisories:
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's _Security_ tab). The report is
visible only to the maintainers, and the fix is prepared in a private fork
linked to the advisory.

Include the affected version or commit, a description, reproduction steps or a
proof of concept, and the impact you believe it has.

## Coordinated disclosure

- We acknowledge a report within **5 working days** and give a first assessment
  (accepted, needs information, or out of scope) within **10 working days**.
- We aim to release a fix and publish the advisory (with a CVE when warranted)
  within **90 days** of the report. If a fix needs longer, we agree a new date
  with you before the 90 days are up.
- Please keep the details confidential until the advisory is published or the
  90 days have passed, whichever comes first. We credit reporters who wish to
  be named.

## Scope

In scope:

- this repository: the server (`server.js`, `src/`), views, public assets,
  database migrations (`db/`), operator scripts (`scripts/`), the Windows
  installer (`installer/`), the `Dockerfile` and `docker-compose.yml`;
- the CI workflows and release artefacts (`.github/`), including the SBOM and
  build provenance;
- dependencies **as used by this product** (report upstream issues to the
  upstream project as well).

Out of scope:

- deployments you do not own or are not authorised to test;
- findings that need a compromised operator host, a privileged database
  account or physical access;
- missing hardening that an operator setting already controls (see below),
  denial of service by volume, social engineering, and automated scanner
  output without a demonstrated impact.

Supply-chain controls (dependency, CI and container security) are documented in
[docs/SECURITY-SUPPLY-CHAIN.md](docs/SECURITY-SUPPLY-CHAIN.md), and the
application's security measures in [docs/SECURITY-MEASURES.md](docs/SECURITY-MEASURES.md).

## Hardening checklist for operators

- Run with `NODE_ENV=production`; the app refuses to start with missing or weak
  `SESSION_SECRET` / credentials.
- Set a strong `APP_KEY` before storing any secret; rotate it only with
  `scripts/rotate-app-key.js`.
- Serve over HTTPS behind a reverse proxy (`TRUST_PROXY=1`) and set
  `APP_BASE_URL` and `TRUSTED_HOSTS`.
- Change the one-time `admin` password at first sign-in and enrol MFA (enforced
  for super-administrators).
- Keep PostgreSQL private to the application network; use a dedicated database
  role owned by the application.
- Restrict `/metrics` (see `requireMetricsAccess`).
- The SQL console (_Data → SQL console_) gives super-administrators raw database
  access. It is **off by default** (separation of duties): its routes answer 404
  and its menu entry is hidden until the server operator sets
  `SQL_CONSOLE_ENABLED=1` in the environment. Enable it only for a supervised
  maintenance window, then remove the variable and restart. Its state is shown on
  _Admin → Instance health_. Keep the number of super-administrators small.
- Review _Settings → Security_ (lockout, session lifetime, MFA policy) and enable
  daily backups plus the restore drill.
- With Docker, use the provided `docker-compose.yml` unchanged in its hardening
  (read-only filesystems, no capabilities, database not published) and keep the
  `appdata` and `pgdata` volumes in your backups.
