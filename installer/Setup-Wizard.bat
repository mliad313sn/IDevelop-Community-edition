@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------
rem  IDevelop Setup - the modern wizard entry point.
rem
rem  This is what the Setup .exe launches. It self-elevates, works out whether
rem  this machine needs a first install or an update, and hands over to
rem  Install-IDevelop.ps1 -Wizard, which shows the Welcome / Licence /
rem  Progress / Finish pages. Nothing is changed until the person presses the
rem  action button on the Welcome page.
rem
rem  Setup.bat (the text menu) is still shipped for the advanced operations:
rem  backup, restore, restore points, database checks, password resets.
rem ---------------------------------------------------------------------------

rem --- elevate ---------------------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

set "PS=powershell -ExecutionPolicy Bypass -NoProfile -File"
set "INSTALL=%~dp0Install-IDevelop.ps1"
set "CFG=%~dp0config.psd1"

if not exist "%INSTALL%" (
    echo ERROR: Install-IDevelop.ps1 not found next to this launcher.
    pause
    exit /b 1
)

set "WIZ=%~dp0Setup-Wizard.ps1"
if not exist "%WIZ%" (
    echo ERROR: Setup-Wizard.ps1 not found next to this launcher.
    pause
    exit /b 1
)

%PS% "%WIZ%"
set "RC=%ERRORLEVEL%"

rem  1602 is the Windows convention for "cancelled by the user" - say so plainly
rem  and do not present it as a failure.
if "%RC%"=="1602" (
    echo.
    echo   Setup was cancelled. Nothing on this computer was changed.
    echo.
    timeout /t 4 >nul
)

exit /b %RC%

