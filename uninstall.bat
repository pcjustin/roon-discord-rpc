@echo off
cd /d "%~dp0"

set "VBS_FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RoonDiscordPresence.vbs"

if not exist "%VBS_FILE%" goto :notfound

del "%VBS_FILE%"
echo Removed startup launcher: %VBS_FILE%
goto :done

:notfound
echo Startup launcher was not found - nothing to remove.

:done
echo.
echo node_modules and this project folder were left untouched.
echo If the app is currently running, it will stop the next time you log out,
echo or you can end it manually via Task Manager (look for node.exe).
pause
