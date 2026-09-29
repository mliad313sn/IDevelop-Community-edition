@echo off
setlocal enabledelayedexpansion
title IDevelop Installer ^& Launcher
cd /d "%~dp0"

echo ===================================================
echo   IDevelop - Application Installer ^& Launcher
echo ===================================================
echo.

:: ---- Check for Node.js ----
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "package.json" (
    echo [ERROR] package.json not found. Run this from the application root.
    pause
    exit /b 1
)

:: ---- Load .env config (DB scripts need these exported) ----
set "DATABASE_URL="
set "PORT=3000"
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="DATABASE_URL" set "DATABASE_URL=%%B"
        if /i "%%A"=="PORT"         set "PORT=%%B"
    )
)
if not defined DATABASE_URL set "DATABASE_URL=postgres://postgres:postgres@localhost:5432/appdb"

echo [STEP 1/5] Checking dependencies...
if not exist "node_modules" (
    echo Installing dependencies... (this may take a few minutes)
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
) else (
    echo Dependencies already installed.
)

echo.
echo [STEP 2/5] Checking SSL certificates...
if not exist "certs\server.pfx" if not exist "certs\key.pem" (
    if exist "AI_Engine_Docs\Scripts\generate_cert.ps1" (
        echo Generating self-signed certificates for HTTPS...
        powershell -ExecutionPolicy Bypass -File "AI_Engine_Docs\Scripts\generate_cert.ps1"
    ) else (
        echo No cert script found - the app will run in HTTP mode.
    )
)

echo.
echo [STEP 3/5] Checking PostgreSQL connection...

:: ---- PostgreSQL path ----
set "PGSVC="
for /f "delims=" %%S in ('powershell -NoProfile -Command "(Get-Service ^| Where-Object {$_.Name -like 'postgresql*'} ^| Select-Object -First 1 -ExpandProperty Name)" 2^>nul') do set "PGSVC=%%S"
if not defined PGSVC set "PGSVC=postgresql-x64-17"

echo Verifying PostgreSQL is reachable...
node -e "require('dotenv').config();const{Client}=require('pg');const c=new Client(process.env.DATABASE_URL);c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
if %errorlevel% neq 0 (
    echo PostgreSQL not reachable - attempting to start service "%PGSVC%"...
    net start "%PGSVC%" >nul 2>nul
    timeout /t 3 >nul
    node -e "require('dotenv').config();const{Client}=require('pg');const c=new Client(process.env.DATABASE_URL);c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Cannot reach PostgreSQL at %DATABASE_URL%
        echo   - Ensure the PostgreSQL service is running ^(try running this script as Administrator^)
        echo   - Check DATABASE_URL in .env
        pause
        exit /b 1
    )
)
echo PostgreSQL is reachable.

echo.
echo [STEP 4/5] Applying database migrations + seed...
call npm run db:migrate
if %errorlevel% neq 0 ( echo [WARN] Migration step reported an error - continuing. )
call npm run db:seed
if %errorlevel% neq 0 ( echo [WARN] Seed step reported an error - continuing. )

:run
echo.
echo [STEP 5/5] Starting application...
echo.
echo   URL: http://localhost:%PORT%
echo   Press Ctrl+C to stop the server.
echo.
call npm start

pause
endlocal
