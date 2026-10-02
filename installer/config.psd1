@{
    # ---- Application ----
    AppName      = 'IDevelop'
    ServiceName  = 'IDevelop'           # Windows service name AND scheduled-task name (same id)
    InstallDir   = 'C:\Program Files\IDevelop'

    # ---- Product identity (Add/Remove Programs, Start Menu, shortcuts) ----
    # Windows expects an installed per-machine application to declare itself in
    # "Apps & features" (the Uninstall registry key) so a user can see what is
    # installed, how big it is and how to remove it WITHOUT hunting for the
    # original media. These values populate that entry and the Start Menu folder.
    # ArpKeyName is the registry sub-key under
    # HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall - keep it stable
    # for the life of the product, or every upgrade leaves an orphan entry.
    ArpKeyName   = 'IDevelop'
    Publisher    = 'IDevelop'
    StartMenuFolder = 'IDevelop'
    HelpLink     = 'http://localhost:3000/user-guide.html'
    AboutUrl     = 'http://localhost:3000/about'
    # Production HTTP port. The installer writes PORT=<AppPort> into the deployed
    # .env (dev runs V3 on 3100 to avoid clashing with a live install; production
    # is always 3000). On an in-place upgrade the app keeps 3000; the auto-fallback
    # to the next free port only triggers if a FOREIGN process owns 3000.
    AppPort      = 3000
    OpenFirewall = $true
    # Windows Firewall profiles the inbound rule applies to (3.23.17). Default
    # Domain + Private: the app is NOT exposed on networks Windows classifies as
    # Public. If the machine is connected to a Public-classified network at install
    # time, Public is added automatically (with a WARN in the log) so the appliance
    # stays reachable; reclassify that network and re-run a Patch to close it.
    # An existing rule (older versions used 'Any') is narrowed on the next run.
    FirewallProfiles = @('Domain', 'Private')

    # ---- HTTPS (3.23.18, S-05) ----
    # Enabled = $true: the app serves HTTPS on Port and AppPort only REDIRECTS to it
    # (301/308), with HSTS (180 days) and Secure session cookies. The certificate:
    #   CertThumbprint = '<thumbprint>' - a certificate already in LocalMachine\My
    #                    (e.g. issued by the company CA) with an EXPORTABLE private key;
    #   else SelfSigned = $true - a self-signed certificate for this machine's FQDN,
    #                    short name and localhost is created once (5 years) and reused.
    # The PFX goes to %ProgramData%\IDevelop\tls (SYSTEM + Administrators only) with
    # a random passphrase; TLS_PFX_PATH / TLS_PFX_PASSPHRASE / HTTPS_PORT /
    # COOKIE_SECURE=1 and an https APP_BASE_URL are written to .env, and a firewall
    # rule is added for Port. Browsers warn on a self-signed certificate until
    # tls\server.cer is deployed as a trusted root (GPO). SSO: update the IdP
    # reply/ACS URLs to the https address. Turn it on with a Patch; Enabled = $false
    # on a later Patch comments the TLS lines out of .env again.
    Https = @{
        Enabled        = $false
        Port           = 3443
        CertThumbprint = ''
        SelfSigned     = $true
    }

    # ---- Audit-trail ownership (3.23.18, S-06) ----
    # $true: after every install / patch / upgrade / migrate, the append-only audit
    # tables (system_logs, assessment_history, review_signatures,
    # self_assessment_events... - every table with an append-only or hash-chain
    # trigger) and their guard functions are owned by the NOLOGIN role
    # fourmp_audit_owner; the app role keeps SELECT + INSERT only, so it can no
    # longer disable, drop or rewrite the guards. OFF by default in this release:
    # while it is on, four SuperAdmin tools that suspend those triggers as the app
    # role are refused by PostgreSQL (Danger-Zone database cleanup, data reset,
    # snapshot restore, SQL-console revert). A Manage -Restore hands the tables back
    # to the app role until the next Patch.
    AuditOwnerSeparation = $false

    # ---- Service hosting ----
    # How the app is hosted as a background, auto-start, restart-on-failure process:
    #   'Service'       - a real Windows service (appears in services.msc / Get-Service),
    #                     hosted by the WinSW wrapper (Node is not SCM-aware on its own).
    #   'ScheduledTask' - a SYSTEM Scheduled Task at startup (no extra binary; airgap-safe).
    #   'Auto'          - prefer a real Windows service; fall back to a Scheduled Task only
    #                     if the WinSW wrapper can't be obtained (offline + not bundled).
    ServiceMode    = 'Auto'
    # Account the Windows service runs as (3.23.18, S-04):
    #   'LocalSystem' - DEFAULT, unchanged. Full control of the machine.
    #   'Virtual'     - the service's own virtual account NT SERVICE\<ServiceName>
    #                   (no password, least privilege). The installer then grants
    #                   that SID Modify on the install dir and on every restricted
    #                   data folder (%ProgramData%\IDevelop\backups, sql-restore-points,
    #                   logs, audit-anchors, tls..., <InstallDir>\uploads, data, logs)
    #                   and Read on .env, so the daily pg_dump backups, uploads and
    #                   restore points keep working. Applies to ServiceMode 'Service'
    #                   (a Scheduled Task host always runs as SYSTEM).
    # This release ships 'LocalSystem': switching a live appliance is the operator's
    # decision - set 'Virtual' and run a Patch; set it back and Patch to revert
    # (the virtual account's grants are then removed).
    ServiceAccount = 'LocalSystem'
    # WinSW (github.com/winsw/winsw) - a tiny, self-contained service wrapper. The
    # installer uses a copy bundled at <package>\bin\WinSW-x64.exe if present, else
    # downloads this URL at install time (same pattern as the Node/PG/VC++ downloads).
    WinSwUrl       = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

    # ---- Download integrity ----
    # Every artefact the installer downloads and runs is pinned by SHA-256 and,
    # when the vendor signs it, by an Authenticode signature that must be Valid
    # AND issued to the publisher named here. A mismatch ABORTS the install; a file
    # pre-placed in %TEMP% (offline install) is used only when its hash matches.
    # Changing a URL means changing its hash in the same edit.
    # How each pin below was obtained (re-check them before every release):
    #   WinSW      downloaded from the URL and hashed (2026-10-02). Not signed by
    #              its project: the hash is the only check (a copy bundled in
    #              bin\ is held to the same hash).
    #   Node.js    the line for the MSI in nodejs.org/dist/v<version>/SHASUMS256.txt.
    #   VC++       Microsoft's versioned download URL carries the file's SHA-256
    #              in its path; the pin is that value.
    #   PostgreSQL taken from the EDB 17.11-4 release; NOT re-derived on the build
    #              machine that wrote this file (no access to the EDB CDN). Verify
    #              it (Get-FileHash) before shipping: a wrong pin aborts a fresh
    #              install that has to download PostgreSQL, it never runs a file.
    WinSwSha256    = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
    WinSwPublisher = ''

    # ---- Prerequisites ----
    # Visual C++ Redistributable (x64) - required by PostgreSQL and several
    # native node modules. Installed only if not already present. A VERSIONED URL:
    # the aka.ms/vs/17/release/vc_redist.x64.exe link moves with every Microsoft
    # release and would break the pin.
    VcRedistUrl       = 'https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe'
    VcRedistSha256    = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'
    VcRedistPublisher = 'Microsoft Corporation'

    # ---- Node.js (downloaded only if missing or older than the app's engines) ----
    # The required minimum is read from app\package.json "engines.node" (major.minor,
    # e.g. >=20.19.0). Entra SSO (openid-client/jose) is loaded with require(esm),
    # unflagged from 20.19 and 22.12 only - so 21.x and 22.0-22.11 are refused too.
    # NodeMinMajor stays as the floor used when package.json cannot be read.
    NodeMinMajor = 20
    NodeVersion  = '22.23.3'
    NodeMsiUrl   = 'https://nodejs.org/dist/v22.23.3/node-v22.23.3-x64.msi'
    # = the line for node-v22.23.3-x64.msi in nodejs.org/dist/v22.23.3/SHASUMS256.txt
    NodeMsiSha256    = '1c0efc8449987e7da5d184786a0a96da83ffa11d334421201e5c09b93017cb8d'
    NodeMsiPublisher = 'OpenJS Foundation'

    # ---- Redis (OPTIONAL - background jobs only; app runs fine without it) ----
    RedisExpected = $false

    # ---- PostgreSQL ----
    PgMajor        = 17
    # PostgreSQL 17.11 (EDB installer build 4). Used only when NO PostgreSQL is
    # found; an existing server is never upgraded by Setup.
    PgInstallerUrl       = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64.exe'
    PgInstallerSha256    = 'c9828fd3a4daebbeeace19bec2de5f38d73c047fce47278148b525cfbe28a5e4'
    PgInstallerPublisher = 'EnterpriseDB Corporation'
    PgHost         = 'localhost'
    PgPort         = 5432
    # Superuser (postgres) password.
    #   Fresh install : this is the password that WILL BE SET.
    #   Existing PG   : supply the REAL one (or pass -PgSuperPassword).
    #   Empty + fresh : a strong one is auto-generated and recorded in the log.
    PgSuperPassword = ''
    # Standard 'postgres' superuser password for this appliance. When set, the
    # installer SETS the postgres role to this value on every run: a fresh PG is
    # created with it, and an existing PG is changed to it (after authenticating
    # with the current password) so every deployment ends up with a known, common
    # DB admin credential. Blank this to leave the postgres password untouched.
    StandardPgSuperPassword = ''
    # Standard 'admin' (SuperAdmin) password for a FRESH DATABASE only - fresh
    # install or full reinstall, whether the bundled snapshot was imported or the
    # seed ran. Set at install time with a change REQUIRED at first login. NEVER
    # touched by a patch / upgrade / migrate (existing logins are preserved).
    # Blank = a random password shown once on the console.
    StandardAdminPassword = ''
    # Set $true when the target PostgreSQL requires SSL (managed/remote PG).
    # Writes PG_SSL=require into .env so the app connects over TLS.
    PgSsl          = $false

    # ---- Application database (created idempotently) ----
    # The application database carries the V3 capability framework (Pillar ->
    # Sub-Domain -> Skill + Role Families). NOTE: on an in-place upgrade the
    # installer PRESERVES the existing .env, so DbName must match the live .env
    # — otherwise the installer migrates one DB while the service boots against
    # another. A fresh install creates + seeds this DB.
    DbName     = 'idevelop'
    DbUser     = 'idevelop_app'
    DbPassword = ''                      # auto-generated if empty

    # ---- Data import (full database snapshot bundled in the package) ----
    # When $true AND the database is created FRESH by this installer, the bundled
    # snapshot (DataDumpFile, relative to the package root) is loaded so the app
    # comes up fully populated (org, employees, skills, assessments, talent data,
    # AND the existing admin/employee logins). An EXISTING database is never
    # overwritten — its live data is preserved and the import is skipped.
    ImportData   = $false
    DataDumpFile = 'data\idevelop.sql'

    # ---- Feature flags written to .env ----
    V2Features = '1'
}
