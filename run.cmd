@echo off
setlocal
set "SCRIPT=%~dp0trae-checkin.js"
for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE set "NODE=C:\nvm4w\nodejs\node.exe"
"%NODE%" "%SCRIPT%"
