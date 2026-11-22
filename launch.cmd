@echo off
setlocal
cd /d "%~dp0"

rem Electron degrades to plain Node if this is set in the environment
set "ELECTRON_RUN_AS_NODE="

set "NODE_EXE=node"
where node >nul 2>nul || set "NODE_EXE=C:\work\node\node.exe"

rem always rebuild so the shortcut runs the current source
"%NODE_EXE%" scripts\build.mjs >nul 2>&1

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0apps\desktop"
