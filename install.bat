@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    where winget >nul 2>nul
    if errorlevel 1 (
        echo Node.js was not found on your PATH, and winget is not available to install it automatically.
        echo Please install Node.js LTS from https://nodejs.org/ and re-run this script.
        pause
        exit /b 1
    )
    echo Node.js was not found. Installing it now via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo Automatic Node.js install failed. Please install it manually from https://nodejs.org/ and re-run this script.
        pause
        exit /b 1
    )
    echo Node.js installed. Please close this window and re-run install.bat so the updated PATH takes effect.
    echo If this message keeps repeating, winget may have opened the Microsoft Store instead of installing -
    echo install "App Installer" from the Store first, then try again.
    pause
    exit /b 0
)

where git >nul 2>nul
if errorlevel 1 (
    where winget >nul 2>nul
    if errorlevel 1 (
        echo Git was not found on your PATH, and winget is not available to install it automatically.
        echo The Roon SDK packages are installed straight from GitHub, so npm needs git to fetch them.
        echo Please install Git from https://git-scm.com/download/win and re-run this script.
        pause
        exit /b 1
    )
    echo Git was not found. Installing it now via winget...
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo Automatic Git install failed. Please install it manually from https://git-scm.com/download/win and re-run this script.
        pause
        exit /b 1
    )
    echo Git installed. Please close this window and re-run install.bat so the updated PATH takes effect.
    echo If this message keeps repeating, winget may have opened the Microsoft Store instead of installing -
    echo install "App Installer" from the Store first, then try again.
    pause
    exit /b 0
)

echo Installing npm dependencies, this may take a minute...
call npm install
if errorlevel 1 (
    echo npm install failed - see the errors above.
    pause
    exit /b 1
)

if not exist "%~dp0cloudflared.exe" (
    where curl >nul 2>nul
    if errorlevel 1 (
        echo WARNING: curl was not found, so cloudflared.exe could not be downloaded.
        echo Track title/artist will still work, but cover art needs cloudflared.exe next to this script.
        echo Download it yourself from https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
        echo and save it as "%~dp0cloudflared.exe", then re-run this script.
    ) else (
        echo Downloading cloudflared for cover art support...
        curl.exe -L -o "%~dp0cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        if errorlevel 1 (
            echo WARNING: cloudflared download failed. Track title/artist will still work, but cover art will not.
        )
    )
)

findstr /c:"YOUR_DISCORD_APPLICATION_ID" config.json >nul 2>nul
if not errorlevel 1 (
    echo WARNING: config.json still contains the placeholder Discord client ID.
    echo Edit config.json and paste your real Discord Application ID before using the app.
    echo See README.md for instructions.
)

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_FILE=%STARTUP_DIR%\RoonDiscordPresence.vbs"

if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%"

echo Creating startup launcher...
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo WshShell.Run "cmd /c cd /d ""%INSTALL_DIR%"" && node index.js >> ""roon-discord.log"" 2>&1", 0, False >> "%VBS_FILE%"

echo Starting Roon Discord Presence now...
wscript.exe "%VBS_FILE%"

echo.
echo Setup complete. Roon Discord Presence will now start automatically every time you log into Windows.
echo Log file: %INSTALL_DIR%\roon-discord.log
echo See README.md for the one-time Roon pairing step (Settings ^> Extensions).
pause
