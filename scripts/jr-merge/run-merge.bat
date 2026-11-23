@echo off
REM 手动运行合并脚本(双击即可)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Merge-JRMaster.ps1"
pause
