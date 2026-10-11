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

REM --- Clear ELECTRON_RUN_AS_NODE if it leaks from the user environment --------
REM When ELECTRON_RUN_AS_NODE=1 is set globally (some shells / IDEs do this
REM to embed Electron as a Node runtime), electron-vite's spawned Electron
REM process inherits the flag and runs as plain Node, so electron.app is
REM undefined and the GUI window never opens. Wipe it for this process so
REM npm run dev and the spawned Electron both start in GUI mode.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "ELECTRON_DISABLE_SANDBOX="

REM --- Install dependencies when missing ----------------------------------
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 exit /b 1
)

echo Starting DataMigrator...
call npm run dev

endlocal