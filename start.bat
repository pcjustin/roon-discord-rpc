@echo off
rem Supervisor loop: node is restarted if it ever exits. Booting before the network
rem is up can kill the Roon SDK outright (its discovery sockets throw when an
rem interface appears mid-bind), and nothing else would bring the app back.
cd /d "%~dp0"

:loop
node index.js >> roon-discord.log 2>&1
echo Exited with code %ERRORLEVEL% - restarting in 15s...>> roon-discord.log
rem ping, not timeout: timeout.exe aborts when it has no usable console, which is
rem exactly the hidden window the startup launcher runs this in.
ping -n 16 127.0.0.1 >nul
goto loop
