@echo off
chcp 65001 >nul
title 语雀导出
rem Run from this script's own folder so the file works wherever it is copied.
cd /d "%~dp0"
node scripts\open-ui.mjs
if errorlevel 1 pause
