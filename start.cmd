@echo off
setlocal

REM Switch to the directory where this script lives
cd /d "%~dp0"

REM --- Verify required tools ------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is required but was not found.
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo npm is required but was not found.
    exit /b 1
)

REM --- Locate Go: prefer PATH; fall back to common install dirs so this
REM     script works even when launched from a shell that predates the
REM     winget install (which doesn't always refresh PATH mid-session).
where go >nul 2>&1
if errorlevel 1 (
    for %%G in (
        "C:\Program Files\Go\bin\go.exe"
        "C:\Program Files (x86)\Go\bin\go.exe"
        "%LOCALAPPDATA%\Programs\Go\bin\go.exe"
        "%USERPROFILE%\scoop\apps\go\current\bin\go.exe"
        "D:\Go\bin\go.exe"
    ) do (
        if exist %%G (
            set "PATH=%%~dG%%~pG;%PATH%"
            goto :go_found
        )
    )
    echo Go 1.22+ is required for the Elasticsearch Go engine but was not found.
    echo Tried PATH and common install directories; install Go or add it to PATH.
    exit /b 1
)
:go_found

REM --- Install dependencies when missing ----------------------------------
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 exit /b 1
)

echo Starting DataMigrator...
call npm run dev

endlocal