@echo off
setlocal EnableExtensions EnableDelayedExpansion
title IDevelop Installer

rem ============================================================================
rem  IDevelop - menu-driven installer & maintenance launcher.
rem  Self-elevates, then drives Install-IDevelop.ps1 (install/patch/upgrade/
rem  reinstall) and Manage-IDevelop.ps1 (full backup + restore). Every action
rem  that changes the app or database takes a FULL backup (code + DB) first.
rem  Progress is shown live in this console AND written to timestamped log files
rem  under %ProgramData%\IDevelop\logs for troubleshooting.
rem ============================================================================

rem ============================================================================
rem  CE MENU TEXTE N'EST PLUS LA VOIE D'INSTALLATION.
rem
rem  Decision du proprietaire : tout passe par l'interface moderne. Si cette
rem  machine a un bureau, on passe la main a l'assistant (Setup-Wizard.bat) au
rem  lieu d'afficher le menu console. Le menu ne reste accessible que la ou
rem  l'assistant ne PEUT PAS s'ouvrir - machine sans bureau, session RDP sans
rem  WPF, Server Core - parce que le supprimer rendrait ces machines-la non
rem  installables.
rem
rem  SETUP_VIA_WIZARD est pose par l'assistant avant d'appeler ce fichier :
rem  c'est ce qui empeche les deux de se renvoyer la main indefiniment.
rem ============================================================================
if not defined SETUP_VIA_WIZARD (
    if exist "%~dp0Setup-Wizard.bat" (
        for /f "usebackq delims=" %%G in (`powershell -NoProfile -Command "try{Add-Type -AssemblyName PresentationFramework -ErrorAction Stop; if([Environment]::UserInteractive){'oui'}else{'non'}}catch{'non'}"`) do set "HASGUI=%%G"
        if /i "!HASGUI!"=="oui" (
            echo.
            echo   Ouverture de l'assistant d'installation...
            echo.
            call "%~dp0Setup-Wizard.bat" %*
            exit /b !ERRORLEVEL!
        )
    )
)

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges ^(a UAC prompt will appear^)...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
set "PS=powershell -ExecutionPolicy Bypass -NoProfile -File"
set "INSTALL=%~dp0Install-IDevelop.ps1"
set "UNINSTALL=%~dp0Uninstall-IDevelop.ps1"
set "MANAGE=%~dp0Manage-IDevelop.ps1"
set "LOGDIR=%ProgramData%\IDevelop\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "SESSIONLOG=%LOGDIR%\setup-session.log"

if not exist "%INSTALL%" (
    echo ERROR: Install-IDevelop.ps1 not found next to this launcher.
    echo Unzip the WHOLE package and run Setup.bat from inside it.
    pause & exit /b 1
)
rem Read the version out of the packaged application so the menu banner and the
rem health check always match what is actually in this package. Hardcoding it
rem here went stale for many releases (the banner still read 3.22.5 at 3.22.38).
set "PKGVER=unknown"
if exist "%~dp0app\package.json" (
    for /f "tokens=2 delims=:" %%V in ('findstr /c:"\"version\"" "%~dp0app\package.json"') do (
        if "!PKGVER!"=="unknown" (
            set "PKGVER=%%V"
            set "PKGVER=!PKGVER:"=!"
            set "PKGVER=!PKGVER:,=!"
            set "PKGVER=!PKGVER: =!"
        )
    )
)
call :slog "Setup launched (package version !PKGVER!)"

:menu
cls
echo ==================================================================
echo    IDevelop - Install ^& Maintenance   (v!PKGVER!)
echo ==================================================================
echo    Install / Update
echo      1.  Patch  (APP ONLY)     Update code only - refused if the package carries
echo                                a database change not yet applied here.
echo      2.  Upgrade (APP + DB)    Update code AND apply migrations.
echo      M.  Migrate (version)     Bring an OLDER version up to this one: pre-flight
echo                                report, downgrade guard, migrations, post-flight proof.
echo      3.  Full reinstall        Brand-new instance + fresh database.
echo      4.  Fresh install         First-time install on a new machine.
echo.
echo    Maintenance
echo      5.  Backup now            Full restore point (code + database).
echo      6.  Restore               Roll back to a previous restore point.
echo      7.  List restore points
echo      8.  Verify health         Check the service ^& API on port 3000.
echo      9.  Diagnostics / logs    Show logs, locations, service ^& health.
echo      C.  Check DB connection   Test PostgreSQL reachability (pre-flight).
echo      P.  Set postgres password Change 'postgres' to the standard value.
echo      A.  Reset admin password  Set the application 'admin' login back to the
echo                                standard value (use if 'admin' cannot sign in).
echo.
echo    Production
echo      R.  Production readiness  Reset assessment data for go-live - starts from a
echo                                clean slate but KEEPS org, skill framework, employees
echo                                and admins. .env is NOT changed.
echo.
echo    Other
echo      U.  Uninstall             Remove app/service (database is KEPT).
echo      0.  Exit
echo ==================================================================
set "choice="
set /p "choice=Choose an action: "

if "%choice%"=="1" goto patch
if "%choice%"=="2" goto upgrade
if /I "%choice%"=="M" goto migrate
if "%choice%"=="3" goto reinstall
if "%choice%"=="4" goto fresh
if "%choice%"=="5" goto backup
if "%choice%"=="6" goto restore
if "%choice%"=="7" goto listrp
if "%choice%"=="8" goto verify
if "%choice%"=="9" goto diag
if /I "%choice%"=="C" goto checkdb
if /I "%choice%"=="P" goto setpgpw
if /I "%choice%"=="A" goto setadminpw
if /I "%choice%"=="R" goto prodready
if /I "%choice%"=="U" goto uninstall
if "%choice%"=="0" goto end
echo.
echo   Invalid choice "%choice%".
timeout /t 2 >nul
goto menu

rem --------------------------------------------------------------------------
rem  Append a timestamped line to the session log.
:slog
powershell -NoProfile -Command "Add-Content -Path '%SESSIONLOG%' -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + '%~1')" >nul 2>&1
goto :eof

rem  Ask for the postgres superuser password (blank = the standard appliance one).
rem
rem  THE SECRET NEVER APPEARS ON A LINE OF THIS FILE. It is read with `set /p`
rem  straight into the environment variable SETUP_PG_SUPER_PASSWORD, which every
rem  PowerShell child inherits and reads itself (Install / Manage / Uninstall).
rem  Two measured reasons:
rem    - this file runs with EnableDelayedExpansion, and any line that expands a
rem      value containing '!' eats the '!' (the standard password has one):
rem      "Abc!2026" became "Abc2026" on the installer's command line, which then
rem      could not authenticate and, PostgreSQL being local, auto-RESET the real
rem      password;
rem    - a -PgSuperPassword argument is copied verbatim into the header of every
rem      PowerShell transcript under %ProgramData% (readable by all local users).
rem  `set /p` stores the raw bytes; the variable is only ever inherited, never
rem  expanded, so both hazards are gone.
:askpg
set "SETUP_PG_SUPER_PASSWORD="
echo.
echo   PostgreSQL 'postgres' superuser password.
echo   Leave BLANK to use the standard appliance password (set by the installer).
rem  Masked entry: PowerShell reads it as a SecureString (nothing echoes to screen),
rem  writes it to a short-lived temp file that we read silently and delete at once.
set "_pgf=%TEMP%\idevelop-pg-%RANDOM%%RANDOM%.tmp"
powershell -NoProfile -Command "$s=Read-Host -AsSecureString '  postgres password (hidden)'; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[IO.File]::WriteAllText('%_pgf%',[Runtime.InteropServices.Marshal]::PtrToStringAuto($b),[Text.Encoding]::ASCII)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}"
if exist "%_pgf%" (set /p "SETUP_PG_SUPER_PASSWORD=" < "%_pgf%" & del /f /q "%_pgf%" >nul 2>&1)
set "_pgf="
goto :eof

rem  Pre-flight: report PostgreSQL reachability before an install action.
:precheck
echo.
echo   ^>^> Pre-flight: checking the database connection...
%PS% "%MANAGE%" -CheckDb
if errorlevel 1 (
    echo.
    echo   NOTE: postgres was not reachable with the standard/supplied password.
    echo   That's OK - the installer will prompt you for the CURRENT postgres
    echo   password during the run.
)
goto :eof

rem  Take a full backup first; sets BK_OK=1 on success. Used before 1/2/3.
:dobackup
set "BK_OK="
echo.
echo   ^>^> Taking a FULL backup (code + database) first...
%PS% "%MANAGE%" -Backup -Note "%~1"
if errorlevel 1 (
    echo.
    echo   WARNING: the backup did not complete cleanly.
    set "goahead="
    set /p "goahead=  Continue WITHOUT a fresh backup anyway? [y/N]: "
    if /I not "!goahead!"=="y" ( echo   Aborted. & goto :eof )
) else ( set "BK_OK=1" & echo   Backup done. )
goto :eof

rem --------------------------------------------------------------------------
:patch
call :slog "Patch (app only) - start"
call :askpg
call :precheck
call :dobackup "before app-only patch"
echo. & echo   ^>^> PATCH (APP ONLY) - refreshing code, no DB changes... & echo.
%PS% "%INSTALL%" -Patch -SkipMigrations -UseExistingPostgres
call :slog "Patch (app only) - finished (exit %errorlevel%)"
goto done

:migrate
call :slog "Migrate (version upgrade) - start"
call :askpg
call :precheck
call :dobackup "before migration (app + database)"
echo. & echo   ^>^> MIGRATE - pre-flight report, downgrade guard, migrations, post-flight proof... & echo.
%PS% "%INSTALL%" -Migrate -UseExistingPostgres
call :slog "Migrate - finished (exit %errorlevel%)"
goto done

:upgrade
call :slog "Upgrade (app + DB) - start"
call :askpg
call :precheck
call :dobackup "before upgrade (app + database)"
echo. & echo   ^>^> UPGRADE (APP + DATABASE) - refreshing code and applying migrations... & echo.
%PS% "%INSTALL%" -Patch -UseExistingPostgres
call :slog "Upgrade - finished (exit %errorlevel%)"
goto done

:reinstall
echo.
echo   *** FULL REINSTALL ***
echo   Replaces the instance AND its database with a brand-new one from the
echo   bundled snapshot. Live data is removed (a full backup is taken first).
set "sure="
set /p "sure=  Type REINSTALL to confirm: "
if /I not "%sure%"=="REINSTALL" ( echo   Cancelled. & timeout /t 2 >nul & goto menu )
call :slog "Full reinstall - start"
call :askpg
call :precheck
call :dobackup "before full reinstall"
echo. & echo   ^>^> FULL REINSTALL - fresh instance + fresh database... & echo.
%PS% "%INSTALL%" -Reinstall -UseExistingPostgres
call :slog "Full reinstall - finished (exit %errorlevel%)"
goto done

:fresh
call :slog "Fresh install - start"
call :askpg
echo. & echo   ^>^> FRESH INSTALL - installing prerequisites, app and framework data... & echo.
%PS% "%INSTALL%"
call :slog "Fresh install - finished (exit %errorlevel%)"
goto done

:prodready
call :slog "Production readiness - start"
echo.
echo   ============== PRODUCTION READINESS ^(GO-LIVE RESET^) ==============
echo   Wipes ALL assessment / talent / performance data so production starts
echo   from a clean slate. KEEPS the organization, the skill framework, the
echo   employee list and admin accounts. The .env file is NOT changed.
echo   A full backup ^(code + DB^) and a pg_dump are taken before anything is wiped.
echo   =================================================================
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "try{(Import-PowerShellDataFile '%~dp0config.psd1').InstallDir}catch{'C:\Program Files\IDevelop'}"`) do set "APPDIR=%%D"
if not defined APPDIR set "APPDIR=C:\Program Files\IDevelop"
set "NODEEXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%APPDIR%\scripts\reset-for-golive.js" (
    echo.
    echo   ERROR: IDevelop is not installed at "%APPDIR%"
    echo   ^(reset script not found^). Install or upgrade first, then retry.
    call :slog "Production readiness - aborted (not installed)"
    pause
    goto menu
)
echo.
echo   ^>^> Exact keep/wipe plan ^(dry run - nothing is changed yet^):
echo.
pushd "%APPDIR%"
"%NODEEXE%" scripts\reset-for-golive.js
popd
echo.
set "sure="
set /p "sure=  Type PRODUCTION to confirm the reset (anything else cancels): "
if /I not "%sure%"=="PRODUCTION" ( echo   Cancelled. & call :slog "Production readiness - cancelled" & timeout /t 2 >nul & goto menu )
call :dobackup "before production readiness reset"
echo.
echo   ^>^> Running the go-live reset ^(a pg_dump backup is taken first^)...
echo.
pushd "%APPDIR%"
"%NODEEXE%" scripts\reset-for-golive.js --confirm
set "RC=!errorlevel!"
popd
call :slog "Production readiness - finished (exit !RC!)"
goto done

:backup
call :slog "Manual backup"
%PS% "%MANAGE%" -Backup -Note "manual backup"
goto done

:restore
call :slog "Restore - start"
call :askpg
echo. & echo   ^>^> RESTORE - roll back to a previous restore point (code + database)... & echo.
%PS% "%MANAGE%" -Restore
call :slog "Restore - finished (exit %errorlevel%)"
goto done

:listrp
%PS% "%MANAGE%" -List
goto done

:checkdb
call :askpg
%PS% "%MANAGE%" -CheckDb
goto done

:setpgpw
echo.
echo   Change the PostgreSQL 'postgres' superuser password to the standard
echo   appliance value. You will be asked for the CURRENT password if the
echo   standard one does not already work.
call :slog "Set postgres password (standardize)"
%PS% "%MANAGE%" -SetPgPassword
goto done

:setadminpw
echo.
echo   Reset the application 'admin' account password to the standard
echo   appliance value. A change is required at the next sign-in. Use this
echo   after a fresh install / reinstall if 'admin' cannot sign in.
call :slog "Reset admin password (standard)"
%PS% "%MANAGE%" -SetAdminPassword
goto done

:verify
echo.
echo   Checking the running instance on http://localhost:3000 ...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/readyz' -TimeoutSec 5; Write-Host ('  /readyz  -> ' + $r.StatusCode) -ForegroundColor Green } catch { Write-Host '  /readyz  -> NOT responding' -ForegroundColor Red }; try { $s = Get-Service 'IDevelop' -ErrorAction Stop; Write-Host ('  service  -> ' + $s.Status) } catch { Write-Host '  service  -> IDevelop not found' -ForegroundColor Yellow }; $want = '!PKGVER!'; $pj = 'C:\Program Files\IDevelop\package.json'; if (Test-Path $pj) { $have = (Get-Content $pj -Raw ^| ConvertFrom-Json).version; if ($have -eq $want) { Write-Host ('  version  -> ' + $have + '  (matches this package)') -ForegroundColor Green } else { Write-Host ('  version  -> ' + $have + '  (this package is ' + $want + ')') -ForegroundColor Yellow } } else { Write-Host '  version  -> not installed at C:\Program Files\IDevelop' -ForegroundColor Yellow }"
goto done

:diag
echo.
echo   === Diagnostics ===
echo   Locations:
echo     Logs           : %ProgramData%\IDevelop\logs
echo     Restore points : %ProgramData%\IDevelop\restore-points
echo     Code backups   : %ProgramData%\IDevelop\app-backups
echo     Install dir    : C:\Program Files\IDevelop
echo.
echo   Recent log files:
powershell -NoProfile -Command "Get-ChildItem @('%ProgramData%\IDevelop\logs','%ProgramData%\IDevelop') -Filter *.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 12 | Format-Table @{n='Modified';e={$_.LastWriteTime}},@{n='KB';e={[math]::Round($_.Length/1KB,1)}},Name -AutoSize"
echo   Service ^& health:
powershell -NoProfile -Command "try{$s=Get-Service 'IDevelop' -ErrorAction Stop;Write-Host ('    service : '+$s.Status)}catch{Write-Host '    service : not installed'}; try{$r=Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/readyz' -TimeoutSec 4;Write-Host ('    /readyz : '+$r.StatusCode)}catch{Write-Host '    /readyz : not responding'}"
echo.
set "openit="
set /p "openit=  Open the logs folder in Explorer? [y/N]: "
if /I "%openit%"=="y" start "" "%ProgramData%\IDevelop\logs"
goto done

:uninstall
echo.
echo   This removes the IDevelop application and Windows service.
echo   The PostgreSQL database is NOT dropped (your data is preserved).
set "confirm="
set /p "confirm=  Type YES to proceed: "
if /I not "%confirm%"=="YES" ( echo   Cancelled. & timeout /t 2 >nul & goto menu )
if not exist "%UNINSTALL%" ( echo   ERROR: Uninstall-IDevelop.ps1 not found. & goto done )
call :slog "Uninstall"
%PS% "%UNINSTALL%"
goto done

:done
echo.
echo ------------------------------------------------------------------
echo   Action finished - review the messages above.
echo   Logs: %ProgramData%\IDevelop\logs
pause
goto menu

:end
call :slog "Setup exited"
endlocal
exit /b 0
