# IDevelop — Manual Deployment Guide (step by step)

Use this when you **cannot run `Install-IDevelop.ps1`** (locked-down host, non-standard
setup, Linux target, or you simply want to do each step by hand). It performs exactly what
the automated installer does.

Two things to know up front:

- **Internet is required** for the downloads below and for `npm ci` (the package does **not**
  bundle `node_modules`). For a true offline/air-gapped install, see the last section.
- Primary target is **Windows** (Server 2019/2022, Win10/11). Linux equivalents are noted in
  **§8**. The app itself is just **Node.js + PostgreSQL**.

Defaults used throughout (change to taste, keep them consistent):

| Setting     | Value                       |
| ----------- | --------------------------- |
| Install dir | `C:\Program Files\IDevelop` |
| App port    | `3000`                      |
| Database    | `idevelop`                  |
| DB role     | `idevelop_app`              |

---

## PHASE A — Download the requirements

| #   | Component                          | Where to get it                                                           | Needed                         |
| --- | ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| A1  | **Node.js 22.x LTS (x64 MSI)**     | https://nodejs.org/dist/v22.23.3/node-v22.23.3-x64.msi                    | Required (20.19+ minimum)      |
| A2  | **PostgreSQL 17 (x64)**            | https://get.enterprisedb.com/postgresql/postgresql-17.2-1-windows-x64.exe | Required                       |
| A3  | **Visual C++ Redistributable x64** | https://aka.ms/vs/17/release/vc_redist.x64.exe                            | Required (PostgreSQL needs it) |
| A4  | **The IDevelop package**           | `IDevelop-Installer-<version>.zip` (this package)                         | Required                       |
| A5  | _(Optional)_ **Redis / Memurai**   | https://www.memurai.com/ (Windows)                                        | Background jobs only           |
| A6  | _(Optional)_ **ClamAV**            | https://www.clamav.net/downloads                                          | Upload virus-scan only         |

---

## PHASE B — Install the prerequisites

1. **VC++ Redistributable** — run `vc_redist.x64.exe` → accept → install. (Skip if already present.)
2. **Node.js** — run the MSI, accept defaults (keep "Add to PATH"). Verify in a **new** terminal:
    ```
    node -v      (expect v20.x)
    npm -v
    ```
3. **PostgreSQL** — run the installer:
    - Set & **record the `postgres` superuser password**.
    - Keep port **5432**. Components: at least **Server** + **Command Line Tools**.
    - Add `...\PostgreSQL\17\bin` to PATH (so `psql` works), or use its full path.
      Verify:
    ```
    psql --version
    ```

---

## PHASE C — Provision the database

Run **as the `postgres` superuser** (the extensions require it). Open a shell:

```
psql -U postgres
```

Then run:

```sql
CREATE ROLE idevelop_app LOGIN PASSWORD 'choose-a-strong-db-password';
CREATE DATABASE idevelop OWNER idevelop_app;
\connect idevelop
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO idevelop_app;
-- Migrations run as idevelop_app and use ALTER TABLE/SEQUENCE/VIEW, which require the app
-- role to OWN the objects (GRANT is not enough). Make idevelop_app own the schema so future
-- ALTER migrations don't fail with "must be owner of table".
ALTER SCHEMA public OWNER TO idevelop_app;
\q
```

> If you provisioned the DB as `postgres` (or restored a dump owned by another role),
> reassign ownership to `idevelop_app` before running migrations:
> `ALTER TABLE/SEQUENCE/VIEW ... OWNER TO idevelop_app` for every object in `public` (the
> automated installer does this on every install/patch).

---

## PHASE D — Deploy the application files

1. Unzip the package. Copy its **`app\`** folder contents to the install dir, e.g.
   `C:\Program Files\IDevelop`.
2. Open a terminal **in that folder** (all later commands run from here).
3. Install production dependencies (needs internet):
    ```
    npm ci --omit=dev
    ```
    (If there is no `package-lock.json`: `npm install --omit=dev`.)
4. _(Optional, recommended)_ Refresh the self-hosted browser libraries served from
   `public\vendor\` (Chart.js) so they match the installed dependency versions:
    ```
    npm run vendor:sync
    ```
    The package already ships a known-good copy under `public\vendor\`, so this is
    only strictly needed after changing the `chart.js` version in `package.json`.

---

## PHASE E — Configure (`.env`)

1. Generate two secrets:
    ```
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   // SESSION_SECRET
    node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   // APP_KEY
    ```
2. Create a file named **`.env`** in the install dir:
    ```ini
    NODE_ENV=production
    PORT=3000
    SESSION_SECRET=<paste 64-hex from above>
    APP_KEY=<paste 48-hex from above>
    DATABASE_URL=postgres://idevelop_app:choose-a-strong-db-password@localhost:5432/idevelop
    V2_FEATURES=1
    # Optional — only if you installed them:
    # REDIS_URL=redis://localhost:6379
    # CLAMD_SOCKET=\\.\pipe\clamd      (or set a ClamAV host/port)
    # Optional — outgoing email (notifications). Normally configured in the app
    # (Settings → Email (SMTP)); these are only a fallback used when the matching
    # in-app Setting is blank. Email stays OFF until enabled in Settings.
    # SMTP_HOST=smtp.example.com
    # SMTP_PORT=587
    # SMTP_USER=noreply@example.com
    # SMTP_PASS=your_smtp_password
    # SMTP_FROM=IDevelop <noreply@example.com>
    ```
    `DATABASE_URL` must match the role/password/db from Phase C.

---

## PHASE F — Initialise the database schema & admin

```
npm run db:migrate:all
```

Applies the base schema + all migrations (idempotent, safe to re-run).

```
npm run db:seed
```

Creates the super-admin **`admin`** with a **randomly generated password that is
printed once** in the seed output, like this:

```
  ============================================================
   FIRST-RUN SUPERADMIN — copy this now, it is shown ONCE
     username : admin
     password : d5ekGa8-Usi4I_OHIdr_qElS
   A password change is required at first sign-in.
  ============================================================
```

**Copy that password before you clear the terminal** — it is not stored anywhere
in recoverable form. A password change is still required at first sign-in.

To pin a known value instead (for automated deploys), set
`BOOTSTRAP_ADMIN_PASSWORD` before seeding; it must satisfy the normal password
policy or the seed refuses it. Nothing is echoed when you pin it.

If you would rather set the password explicitly after seeding:

```
node scripts/set-admin-password.js "A-Strong-Admin-Password!"
```

---

## PHASE G — First run (foreground test)

```
node server.js
```

Open **http://localhost:3000/** → log in as `admin`. Confirm the dashboard loads, then
press `Ctrl+C` to stop. (Migrations and seed also run automatically on every boot, so this
self-heals a missed Phase F — except the admin-password hardening.)

---

## PHASE H — Run as a service (survives reboot)

**Windows — SYSTEM scheduled task** (what the installer registers). In an **admin** PowerShell:

```powershell
$node = (Get-Command node.exe).Source
$dir  = 'C:\Program Files\IDevelop'
$action    = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'IDevelop' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Start-ScheduledTask -TaskName 'IDevelop'
```

_(Alternatives: [NSSM](https://nssm.cc/) or `pm2` + `pm2-windows-startup`.)_

---

## PHASE I — Firewall & TLS

- **Firewall** (admin PowerShell):
    ```powershell
    New-NetFirewallRule -DisplayName "IDevelop (3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Any
    ```
- **TLS** — the app serves **HTTP** by default. For production, front it with a reverse proxy
  that terminates HTTPS (IIS + ARR, nginx, or Caddy) pointing at `http://localhost:3000`.

---

## PHASE J — Verify

- [ ] `http://<host>:3000/` shows the login page.
- [ ] Login as `admin` works; dashboard renders.
- [ ] After a reboot, the service restarts and the site is reachable.
- [ ] (If used) Redis up → background jobs run; otherwise they are no-ops (expected).

---

## §8 — Linux equivalents (if deploying on Linux instead)

- **Node 20:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`
- **PostgreSQL:** `sudo apt install -y postgresql` then the same `CREATE ROLE/DATABASE/EXTENSION` SQL via `sudo -u postgres psql`.
- **App:** same `npm ci --omit=dev`, `.env`, `npm run db:migrate:all`, `npm run db:seed`, `node scripts/set-admin-password.js`.
- **Service:** systemd unit:
    ```ini
    [Unit]
    After=network.target postgresql.service
    [Service]
    WorkingDirectory=/opt/idevelop
    ExecStart=/usr/bin/node server.js
    EnvironmentFile=/opt/idevelop/.env
    Restart=on-failure
    User=idevelop
    [Install]
    WantedBy=multi-user.target
    ```
    `sudo systemctl daemon-reload && sudo systemctl enable --now idevelop`

---

## §9 — Offline / air-gapped install

The only steps needing internet are the **Phase A downloads** and **`npm ci`**. To go fully offline:

1. On an internet-connected machine with the **same OS/arch and Node 20**, run `npm ci --omit=dev`
   inside the app folder, then copy the produced **`node_modules\`** into the offline install dir.
   Skip the `npm ci` step (Phase D-3) on the target.
2. Pre-download the Phase A installers and carry them on media.
   Everything else (DB setup, `.env`, migrations, seed, service) is fully offline-capable.

---

## §10 — Troubleshooting

| Symptom                            | Cause / fix                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm ci` fails                     | No internet, or wrong Node version. Use Node 20; for offline see §9.                      |
| App won't start, DB error          | `DATABASE_URL` wrong, or PostgreSQL not running, or role/password mismatch (Phase C/E).   |
| Migration error about an extension | Extensions weren't created as superuser — re-run the `CREATE EXTENSION` lines in Phase C. |
| Login fails on fresh DB            | Seed didn't run, or you set a new admin password — use the one from Phase F.              |
| Port 3000 in use                   | Change `PORT` in `.env` (and the firewall rule / service).                                |
| Evidence upload shows "scan_error" | ClamAV not installed/reachable — optional; set `CLAMD_SOCKET` or ignore.                  |

A clean run leaves the app at `http://localhost:3000/`, an auto-start service, and admin
secured. To remove later, stop/unregister the service, delete the install dir, and
(optionally) `DROP DATABASE idevelop; DROP ROLE idevelop_app;`.
