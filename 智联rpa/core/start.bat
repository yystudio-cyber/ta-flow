@echo off
chcp 65001 >nul
title ZhilianRPA

echo.
echo ============================================
echo   Zhilian RPA - Screening First Trial
echo ============================================
echo.
echo 1 - Test run
echo 2 - Full run
echo 3 - Probe selectors
echo 4 - Schedule mode
echo.
set /p mode=Select [1/2/3/4]:

set PYTHON=python

if "%mode%"=="1" goto test
if "%mode%"=="2" goto full
if "%mode%"=="3" goto probe
if "%mode%"=="4" goto schedule
goto end

:test
echo.
echo [Test mode] starting...
"%PYTHON%" "%~dp0zhilian_rpa_enhanced.py" --config "%~dp0config.yaml" --test
goto end

:full
echo.
echo [Full mode] starting...
"%PYTHON%" "%~dp0zhilian_rpa_enhanced.py" --config "%~dp0config.yaml"
goto end

:probe
echo.
echo [Probe mode] inspecting selectors...
"%PYTHON%" "%~dp0zhilian_rpa_enhanced.py" --config "%~dp0config.yaml" --probe
goto end

:schedule
echo.
echo [Schedule mode] starting...
"%PYTHON%" "%~dp0zhilian_rpa_enhanced.py" --config "%~dp0config.yaml" --schedule
goto end

:end
echo.
pause
