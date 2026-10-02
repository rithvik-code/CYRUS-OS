@echo off
REM Registered CYRUS script (Windows). Sorts loose files on the Desktop
REM into a dated subfolder by extension. Simple and reversible on purpose.

set DESKTOP=%USERPROFILE%\Desktop
for /f "tokens=1-3 delims=/" %%a in ('date /t') do set DATE=%%c-%%a-%%b
set SORTDIR=%DESKTOP%\_sorted_%DATE%

if not exist "%SORTDIR%" mkdir "%SORTDIR%"

cd /d "%DESKTOP%"
for %%f in (*.*) do (
    if not "%%f"=="%~nx0" (
        for %%e in ("%%~xf") do (
            set EXT=%%~xe
            set EXT=!EXT:~1!
            if not exist "%SORTDIR%\!EXT!" mkdir "%SORTDIR%\!EXT!"
            move "%%f" "%SORTDIR%\!EXT!\" >nul
        )
    )
)

echo [CYRUS] Desktop sorted into %SORTDIR%
