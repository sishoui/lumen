@echo off
setlocal
REM Host unit tests for bt-light firmware skeleton (issue #12).
REM No ESP-IDF toolchain, no hardware. Output goes to %TEMP% so the repo stays clean.
REM ASCII-only: cmd.exe reads .cmd in the OEM code page.

set "MAIN=%~dp0..\main"
set "OUT=%TEMP%\bt-light-host-tests"
set "VECTORS=%~dp0..\..\docs\protocol-testvectors.json"
if not exist "%OUT%" mkdir "%OUT%"

REM Pure C sources only (no FreeRTOS / NVS / NimBLE / led_strip headers).
REM Hardware-bound modules (app_main / ble_link / led_engine / state_store / led_strip_owner)
REM are excluded: they delegate to these pure modules, which IS the test surface.
gcc -std=c11 -Wall -Wextra -Werror -I"%MAIN%" ^
    "%~dp0test_protocol.c" ^
    "%MAIN%\protocol.c" ^
    "%MAIN%\chunk_reasm.c" ^
    "%MAIN%\command.c" ^
    "%MAIN%\effects.c" ^
    "%MAIN%\gamma.c" ^
    "%MAIN%\layout_store.c" ^
    "%MAIN%\scene_store.c" ^
    "%MAIN%\scene_compose.c" ^
    "%MAIN%\strip_planar.c" ^
    "%MAIN%\strip_power.c" ^
    "%MAIN%\led_count_job.c" ^
    "%MAIN%\save_scheduler.c" ^
    "%MAIN%\selftest.c" ^
    "%MAIN%\state.c" ^
    "%MAIN%\state_blob.c" ^
    -lm -o "%OUT%\bt_light_host_tests.exe"
if errorlevel 1 exit /b 1

REM The vectors file is shared by both ends; fail loudly if it is missing.
if not exist "%VECTORS%" (
  echo [run-tests] vectors file not found: %VECTORS%
  exit /b 2
)

"%OUT%\bt_light_host_tests.exe" "%VECTORS%"
if errorlevel 1 exit /b %errorlevel%

REM Vector self-check via node (independent of generator).
REM No node means the self-check did NOT run. Print SKIPPED: tag instead of silent.
REM Exit code stays 0: not a failure, but must be visible.
where node >nul 2>nul
if errorlevel 1 (
  echo SKIPPED: vector self-check ^(node not found^)
  exit /b 0
)
node "%~dp0..\..\scripts\check-protocol-testvectors.mjs"
if errorlevel 1 exit /b 1
exit /b 0