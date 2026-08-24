@echo off
cd /d "%~dp0"
start "DJ Booth server" cmd /k node server.js
timeout /t 1 /nobreak >nul
start "" "http://localhost:8787/dj-booth.html"
