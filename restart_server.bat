@echo off
setlocal enabledelayedexpansion
title IDevelop - Restart Server
cd /d "%~dp0"

:: Read PORT from .env (default 3000)
set "PORT=3000"
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="PORT" set "PORT=%%B"
    )
)

echo Stopping app on port %PORT% (only this app, not other Node processes)...
set "killed="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
    taskkill /F /PID %%P >nul 2>nul && set "killed=1"
)
if defined killed (echo   Stopped.) else (echo   Nothing was running on port %PORT%.)

echo Starting server...
call npm start

endlocal
pause
