# Software supply-chain security

How IDevelop Community Edition protects what goes into the product (dependencies,
build tooling, the container image) and what comes out of it (release artefacts).
Each control names the standard it meets and how to verify it yourself.

Standards referenced:

- **Scorecard**: [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md) check names.
- **SSDF**: [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) Secure Software Development Framework practice ids.
- **SLSA**: [SLSA v1.0](https://slsa.dev/spec/v1.0/levels) build track level.
- **CIS**: [CIS Docker Benchmark v1.6.0](https://www.cisecurity.org/benchmark/docker) recommendation numbers.

Run every local check at once with `npm run security:check` (policy, lockfile,
`npm audit`, gitleaks when installed). The same controls are pinned by
`tests/unit/supplyChainHardening.test.js`, so a later edit cannot silently drop one.

## 1. CI pipeline

| Control                                                                                                                                                                                                           | Where                                                                                | Standard                                                                                                     | Verify                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only default token; write scopes granted per job only (`security-events: write` for SARIF upload, `id-token`/`attestations: write` for provenance, `pull-requests: write` for the dependency-review summary) | every file in `.github/workflows/` (`permissions: contents: read` at workflow level) | Scorecard Token-Permissions; SSDF PO.5.1, PS.1.1                                                             | `grep -n -A3 '^permissions' .github/workflows/*.yml`; the Scorecard run reports Token-Permissions 10/10                                                                  |
| Third-party actions pinned to a full commit SHA with a version comment; `persist-credentials: false` on every checkout                                                                                            | all workflows                                                                        | Scorecard Pinned-Dependencies, Dangerous-Workflow; SSDF PO.3.2, PS.1.1                                       | `node scripts/security-check.js --offline` (policy check); `git ls-remote --tags https://github.com/<owner>/<action>` resolves each `# vX.Y.Z` comment to the pinned SHA |
| Dependabot for `npm`, `github-actions`, `docker` and `docker-compose`, weekly, minor + patch grouped per ecosystem, majors one PR each                                                                            | `.github/dependabot.yml`                                                             | Scorecard Dependency-Update-Tool; SSDF PW.4.4, RV.1.1                                                        | Insights → Dependency graph → Dependabot on GitHub                                                                                                                       |
| SAST: CodeQL `javascript-typescript`, `security-extended` queries, on push, pull request and weekly                                                                                                               | `.github/workflows/codeql.yml`                                                       | Scorecard SAST; SSDF PW.7.2, PW.8.2                                                                          | Security → Code scanning, tool "CodeQL"                                                                                                                                  |
| Dependency review on pull requests: fails on a new dependency with a **high** or critical advisory, or whose licence is not on the AGPL-3.0-or-later-compatible allow-list                                        | `.github/workflows/dependency-review.yml`                                            | Scorecard Vulnerabilities, License; SSDF PW.4.1, RV.1.1                                                      | Open a PR that adds a package with a known advisory: the "dependency review" check fails                                                                                 |
| Production dependency audit gate: `npm audit --omit=dev --audit-level=high`                                                                                                                                       | `ci.yml` job `audit`; `npm run security:audit`                                       | Scorecard Vulnerabilities; SSDF RV.1.1, PW.4.4                                                               | `npm run security:audit` exits 0                                                                                                                                         |
| npm registry signatures and provenance of every installed package                                                                                                                                                 | `ci.yml` job `audit` (`npm audit signatures`)                                        | SSDF PS.2, PW.4.1; SLSA (consumer-side provenance check)                                                     | `npm audit signatures`                                                                                                                                                   |
| Lockfile integrity: every package resolved from `registry.npmjs.org` over HTTPS with a SHA-2 integrity hash; CI installs with `npm ci` only                                                                       | `package-lock.json`, `scripts/security-check.js`                                     | Scorecard Pinned-Dependencies; SSDF PO.3.2, PW.4.1                                                           | `npm run security:check` → `[PASS] lockfile`                                                                                                                             |
| Secret scanning of the **full git history** with gitleaks (checksum-verified binary v8.30.1); allow-list limited to named test fixtures and illustrative doc values                                               | `.github/workflows/secret-scan.yml`, `.gitleaks.toml`                                | SSDF PS.1.1, PW.1.1; Scorecard (no dedicated check; supports Dangerous-Workflow hygiene)                     | `npm run security:secrets` (needs gitleaks installed) or `gitleaks git --config .gitleaks.toml --redact .`                                                               |
| OpenSSF Scorecard weekly and on push to `main`, results as SARIF (publication off until the repository is public)                                                                                                 | `.github/workflows/scorecard.yml`                                                    | Scorecard (all checks); SSDF PO.4.1                                                                          | Security → Code scanning, category "scorecard"                                                                                                                           |
| Trivy on the repository (vulnerabilities, secrets, Dockerfile/compose misconfiguration) and on the built image; fails on **CRITICAL/HIGH with a fix available**; SARIF uploaded                                   | `.github/workflows/supply-chain.yml` jobs `trivy-fs`, `trivy-image`                  | Scorecard Vulnerabilities; SSDF RV.1.1, PW.8.2; CIS 4.4                                                      | `trivy fs --severity CRITICAL,HIGH --ignore-unfixed .`; `trivy image --severity CRITICAL,HIGH --ignore-unfixed <image>`                                                  |
| CycloneDX 1.6 SBOM of the production dependency tree, reproducible, uploaded as the `sbom-cyclonedx` build artifact (90 days)                                                                                     | `supply-chain.yml` job `sbom`; `npm run security:sbom`                               | SSDF PS.3.2; SLSA provenance companion; Executive Order 14028 SBOM                                           | `npm run security:sbom` writes `sbom.cdx.json`                                                                                                                           |
| Signed build provenance (Sigstore, GitHub artefact attestations) for the SBOM and the source archive on every push to `main`                                                                                      | `supply-chain.yml` step "build provenance"                                           | **SLSA Build L2** (hosted build platform, signed provenance); SSDF PS.2.1, PS.3.1; Scorecard Signed-Releases | `gh attestation verify idevelop-ce-src.tar.gz -R mliad313sn/IDevelop-Community-edition`                                                                                  |
| Code owners review for security-sensitive paths (CI, dependencies, container, auth, RBAC, key tooling, installer)                                                                                                 | `.github/CODEOWNERS`                                                                 | Scorecard Code-Review, Branch-Protection; SSDF PO.2.1, PW.7.1                                                | Enable "Require review from Code Owners" on the `main` branch protection rule                                                                                            |
| Coordinated disclosure policy                                                                                                                                                                                     | `SECURITY.md`                                                                        | Scorecard Security-Policy; SSDF RV.1.3                                                                       | Security → Policy on GitHub                                                                                                                                              |

## 2. Container image (`Dockerfile`)

| Control                                                                                                                                        | Standard                                            | Verify                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Base image `node:22-alpine` pinned by multi-arch index digest (resolved 2026-09-29), Dependabot `docker` proposes digest bumps                 | CIS 4.2; Scorecard Pinned-Dependencies; SSDF PW.4.1 | `docker buildx imagetools inspect node:22-alpine` shows the digest in the `ARG NODE_IMAGE` line |
| Multi-stage build; production dependencies only, from the lockfile (`npm ci --omit=dev`); `NODE_ENV=production`                                | CIS 4.3; SSDF PW.6.2                                | `docker run --rm --entrypoint ls <image> node_modules/jest` fails                               |
| Non-root runtime user `app` (UID/GID 10001); code and `node_modules` root-owned and read-only to it                                            | CIS 4.1                                             | `docker image inspect -f '{{.Config.User}}' <image>` → `app:app`                                |
| npm, npx, corepack and yarn removed from the runtime stage (not needed at run time; were the source of the image's only non-app HIGH findings) | CIS 4.3                                             | `docker run --rm --entrypoint which <image> npm` prints nothing                                 |
| setuid/setgid bits stripped                                                                                                                    | CIS 4.8                                             | `find / -xdev -perm /6000 -type f` in the container prints nothing                              |
| `HEALTHCHECK` on `/readyz` (database reachable)                                                                                                | CIS 4.6                                             | `docker image inspect -f '{{json .Config.Healthcheck}}' <image>`                                |
| No secrets in any layer: `.dockerignore` excludes `.env*`, keys, certificates, `.git`, backups, uploads, logs; no secret-like `ENV`/`ARG`      | CIS 4.10; SSDF PS.1.1                               | `npm run security:check` → policy; Trivy image secret scanner                                   |
| `COPY` only, no `ADD` of remote URLs                                                                                                           | CIS 4.9                                             | `grep -n '^ADD' Dockerfile` prints nothing                                                      |
| tini as PID 1 for signal handling (graceful shutdown)                                                                                          | operational                                         | `docker top <container>`                                                                        |

## 3. Runtime (`docker-compose.yml`)

The app writes only to these paths (inspected in `src/`): `UPLOADS_DIR` and
`QUARANTINE_DIR` (certificates and evidence), `BACKUP_DIR` (JSON backups and
erasure tombstones), `data/backups` (database cleanup snapshots),
`AUDIT_ANCHOR_DIR`, `SQL_CONSOLE_BACKUP_DIR`, `logs/` (winston), `tmp/` (multer
staging, then `rename()` into uploads, and Excel exports), `AI_Engine_Docs/tmp`
(data-import staging) and the OS temp dir. The image places all persistent ones
under `/app/data` (one `appdata` volume; `/app/tmp` and `/app/logs` are symlinks
into it so `rename()` never crosses a mount), and the ephemeral ones on tmpfs.

| Control                                                                                                                                    | Standard             | Verify                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `read_only: true` root filesystem on every service; tmpfs for `/tmp`, PostgreSQL's socket dir, Redis `/data` and the import staging folder | CIS 5.12             | `docker exec <app> touch /app/server.js` → read-only file system                   |
| `security_opt: [no-new-privileges:true]` on every service                                                                                  | CIS 5.25             | `grep NoNewPrivs /proc/1/status` in the container → 1                              |
| `cap_drop: [ALL]`; PostgreSQL and Redis run directly as their image users (70, 999) so no CHOWN/SETUID capability is needed                | CIS 5.3, 5.4         | `grep CapEff /proc/1/status` → `0000000000000000`                                  |
| Memory, CPU and PID limits on every service                                                                                                | CIS 5.10, 5.11, 5.28 | `docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' <container>` |
| PostgreSQL and Redis **not published** to the host; only the app port is                                                                   | CIS 5.8; SSDF PW.9.1 | `docker compose port db 5432` prints nothing                                       |
| Healthcheck on the database gates app start; the app image carries its own                                                                 | CIS 5.26             | `docker compose ps` shows `(healthy)`                                              |

Verified on 2026-09-30: the stack started with these settings (read-only, no
capabilities), `/readyz` answered `ready`, and uploads, logs, backups and the
import staging folder were writable while the code tree was not.

## Known gaps and items "to pin"

- **Compose images** `postgres:17-alpine` and `redis:8-alpine` are pinned by tag,
  not digest (Dependabot `docker-compose` tracks them). For production, pin them
  by digest as the Dockerfile does.
- **Redis licence**: Redis 8 is distributed under RSALv2, SSPLv1 or AGPLv3 at
  the user's option (Redis 7.4, which `redis:7-alpine` resolved to, offered only
  RSALv2/SSPLv1). The compose stack uses it under AGPLv3, the project's own
  licence; the app only connects to it over the network. Operators who want a
  permissive licence can swap in Valkey (BSD-3-Clause), which speaks the same
  protocol.
- **tini** is installed with `apk add` at the version current in the pinned
  Alpine release (not version-locked separately).
- **Restart policy** is `unless-stopped` rather than CIS 5.14's `on-failure:5`,
  so the service survives a host reboot; review for your environment.
- **App port** `3000` is published on all host interfaces (CIS 5.13). Behind a
  reverse proxy on the same host, bind it to `127.0.0.1:3000:3000` in a
  `docker-compose.override.yml`.
- **CODEOWNERS** uses the placeholder team `@mliad313sn/security-reviewers`,
  which must be created before the rules take effect.
- **Scorecard publication** (`publish_results`) is off until the repository is
  public; Branch-Protection, Code-Review and Signed-Releases also depend on
  repository settings, not on files.
- No third-party action is left on a version tag: every SHA was resolved against
  the upstream repository on 2026-09-30.

| Action                                             | Version | Commit SHA                                                                |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| actions/checkout                                   | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1`                                |
| actions/setup-node                                 | v7.0.0  | `820762786026740c76f36085b0efc47a31fe5020`                                |
| actions/upload-artifact                            | v7.0.1  | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`                                |
| github/codeql-action (init, analyze, upload-sarif) | v4.38.2 | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2`                                |
| actions/dependency-review-action                   | v5.0.0  | `a1d282b36b6f3519aa1f3fc636f609c47dddb294`                                |
| ossf/scorecard-action                              | v2.4.4  | `2d1146689b8cda280b9bc96326124645441f03bc`                                |
| aquasecurity/trivy-action                          | v0.36.0 | `ed142fd0673e97e23eac54620cfb913e5ce36c25`                                |
| actions/attest-build-provenance                    | v4.2.2  | `4d101475d8b20a2381f78447822ac1eab6504dd8`                                |
| gitleaks binary (linux x64)                        | v8.30.1 | sha256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` |
| node:22-alpine (index)                             | 22.23.x | `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` |
