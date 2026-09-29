@echo off
setlocal enabledelayedexpansion
title IDevelop - Management Console
cd /d "%~dp0"

:: ============================================================
::  Load configuration from .env (scripts here do NOT auto-load
::  dotenv, so we export the vars the npm db: scripts need).
:: ============================================================
set "DATABASE_URL="
set "V2_FEATURES="
set "PORT="
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="DATABASE_URL" set "DATABASE_URL=%%B"
        if /i "%%A"=="V2_FEATURES"  set "V2_FEATURES=%%B"
        if /i "%%A"=="PORT"         set "PORT=%%B"
    )
)
if not defined PORT set "PORT=3000"
if not defined DATABASE_URL set "DATABASE_URL=postgres://postgres:postgres@localhost:5432/appdb"

:: Detect the installed PostgreSQL Windows service (fallback to v17).
set "PGSVC="
for /f "delims=" %%S in ('powershell -NoProfile -Command "(Get-Service ^| Where-Object {$_.Name -like 'postgresql*'} ^| Select-Object -First 1 -ExpandProperty Name)" 2^>nul') do set "PGSVC=%%S"
if not defined PGSVC set "PGSVC=postgresql-x64-17"

:menu
cls
echo ===================================================
echo            IDevelop - Management Console
echo ===================================================
call :status
echo ---------------------------------------------------
echo   APPLICATION
echo      1) Start application (new window)
echo      2) Stop application
echo      3) Restart application
echo      4) Open in browser   ( http://localhost:%PORT% )
echo.
echo   POSTGRESQL   (service: %PGSVC%)
echo      5) Start PostgreSQL service
echo      6) Stop PostgreSQL service
echo.
echo   DATABASE
echo      7) Run migrations         (db:migrate)
echo      8) Seed default data      (db:seed)
echo.
echo   SETUP
echo      9) Install / update dependencies
echo     10) Refresh status
echo      0) Exit
echo ===================================================
set /p "choice=Select an option: "

if "%choice%"=="1"  goto start_app
if "%choice%"=="2"  goto stop_app
if "%choice%"=="3"  goto restart_app
if "%choice%"=="4"  goto open_browser
if "%choice%"=="5"  goto start_pg
if "%choice%"=="6"  goto stop_pg
if "%choice%"=="7"  goto migrate
if "%choice%"=="8"  goto seed
if "%choice%"=="9"  goto deps
if "%choice%"=="10" goto menu
if "%choice%"=="0"  goto end
goto menu

:: ----------------------------------------------------------
:status
set "PGSTATUS=Stopped/NotFound"
sc query "%PGSVC%" 2>nul | findstr /i "RUNNING" >nul && set "PGSTATUS=Running"
node -e "require('dotenv').config();const{Client}=require('pg');const c=new Client(process.env.DATABASE_URL);c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul && (set "PGCONN=reachable") || (set "PGCONN=UNREACHABLE")
set "APPSTATUS=stopped"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do set "APPSTATUS=RUNNING (pid %%P)"
echo   PostgreSQL : service=%PGSTATUS%   connection=%PGCONN%
echo   Database   : PostgreSQL   V2_FEATURES=%V2_FEATURES%
echo   Application: %APPSTATUS%   port=%PORT%
exit /b

:start_app
echo Starting application in a new window...
start "IDevelop App (port %PORT%)" cmd /k "npm start"
timeout /t 3 >nul
goto menu

:stop_app
echo Stopping application on port %PORT%...
set "killed="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
    taskkill /F /PID %%P >nul 2>nul && set "killed=1"
)
if defined killed (echo   Stopped.) else (echo   Nothing was running on port %PORT%.)
timeout /t 2 >nul
goto menu

:restart_app
echo Restarting application...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>nul
timeout /t 1 >nul
start "IDevelop App (port %PORT%)" cmd /k "npm start"
timeout /t 3 >nul
goto menu

:open_browser
start "" "http://localhost:%PORT%"
goto menu

:start_pg
echo Starting PostgreSQL service "%PGSVC%" (may require Administrator)...
net start "%PGSVC%"
pause
goto menu

:stop_pg
echo Stopping PostgreSQL service "%PGSVC%" (may require Administrator)...
net stop "%PGSVC%"
pause
goto menu

:migrate
echo Running migrations against %DATABASE_URL% ...
call npm run db:migrate
pause
goto menu

:seed
echo Seeding default data...
call npm run db:seed
pause
goto menu

:deps
echo Installing/updating dependencies...
call npm install
pause
goto menu

:end
endlocal
exit /b 0
