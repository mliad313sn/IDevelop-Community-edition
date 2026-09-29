# Security policy

## Supported versions

| Version            | Supported         |
| ------------------ | ----------------- |
| 1.x (latest minor) | ✅ security fixes |
| older              | ❌ please upgrade |

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's _Security_ tab).

Include the affected version, a description, reproduction steps or a proof of
concept, and the impact you believe it has. We aim to acknowledge within
5 working days and to agree a disclosure date with you; we credit reporters who
wish to be named.

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
- Restrict `/metrics` (see `requireMetricsAccess`). Remember that the SQL console
  (_Data → SQL console_) gives super-administrators raw database access: keep the
  number of super-administrators small.
- Review _Settings → Security_ (lockout, session lifetime, MFA policy) and enable
  daily backups plus the restore drill.
