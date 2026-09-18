@echo off
setlocal

REM ----------------------------------------------------------------------
REM DataMigrator - Windows release build script
REM
REM Wraps the full Windows packaging pipeline:
REM   1. Verify Node.js / npm / Go prerequisites (with common-dir fallback)
REM   2. Install npm dependencies when missing
REM   3. (optional) wipe previous build artifacts
REM   4. Run `npm run package:win`
REM        -> typecheck + electron-vite build
REM        -> cross-compile Go engine for windows/amd64
REM        -> electron-builder NSIS installer
REM   5. Print a summary of the produced artifacts
REM
REM Usage:
REM   build.cmd                 Full Windows release build
REM   build.cmd --clean         Wipe release/, out/, golang/esmigrator/bin/ first
REM   build.cmd --skip-install  Assume node_modules is already populated
REM   build.cmd --clean --skip-install   Combine flags
REM ----------------------------------------------------------------------

cd /d "%~dp0"

REM --- Parse flags --------------------------------------------------------
set "CLEAN=0"
set "SKIP_INSTALL=0"
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--clean"        set "CLEAN=1"
if /i "%~1"=="--skip-install" set "SKIP_INSTALL=1"
shift
goto :parse_args
:args_done

REM --- Verify Node.js -----------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js is required but was not found on PATH.
    exit /b 1
)
for /f "tokens=1" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo [OK]   Node.js %NODE_VER%

REM --- Verify npm ---------------------------------------------------------
where npm >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm is required but was not found on PATH.
    exit /b 1
)
for /f "tokens=1" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
echo [OK]   npm %NPM_VER%

REM --- Verify Go (1.22+); fall back to common install directories --------
where go >nul 2>&1
echo [DEBUG] about to run where go
where go
echo [DEBUG] where returned errorlevel %errorlevel%
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
            echo [OK]   Go (recovered from %%G)
            goto :go_found
        )
    )
    echo [FAIL] Go 1.22+ is required for the Elasticsearch Go engine but was not found.
    echo        Tried PATH and common install directories.
    exit /b 1
)
:go_found
for /f "tokens=3" %%v in ('go version') do set "GO_VER=%%v"
echo [OK]   Go %GO_VER%

REM --- Install npm dependencies when missing -----------------------------
if /i "%SKIP_INSTALL%"=="1" goto :skip_install
if not exist node_modules (
    echo [INFO] Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [FAIL] npm install failed.
        exit /b 1
    )
)
goto :deps_ready
:skip_install
if not exist node_modules (
    echo [FAIL] node_modules not found. Re-run without --skip-install.
    exit /b 1
)
:deps_ready
echo [OK]   node_modules present

REM --- Optional clean of previous build artifacts ------------------------
if /i "%CLEAN%"=="1" (
    echo [INFO] Cleaning previous build artifacts...
    if exist release                     rmdir /s /q release
    if exist out                         rmdir /s /q out
    if exist golang\esmigrator\bin       rmdir /s /q golang\esmigrator\bin
    if exist tsconfig.node.tsbuildinfo   del   /q   tsconfig.node.tsbuildinfo
    if exist tsconfig.web.tsbuildinfo    del   /q   tsconfig.web.tsbuildinfo
    echo [OK]   Clean complete.
)

REM --- Run Windows release build -----------------------------------------
echo.
echo ============================================================
echo  DataMigrator Windows release build
echo  target: NSIS installer  release\DataMigrator-*-win-x64.exe
echo ============================================================
echo.

call npm run package:win
if errorlevel 1 (
    echo.
    echo [FAIL] Windows package build failed. See output above.
    exit /b 1
)

REM --- Summarize artifacts ------------------------------------------------
echo.
echo ============================================================
echo  Build complete. Artifacts:
echo ============================================================
if exist release (
    for %%F in (release\DataMigrator-*-win-x64.exe) do (
        if not "%%~nxF"=="" (
            for %%A in ("%%F") do echo   installer    : %%~nxF  [%%~zA bytes]
        )
    )
    if exist release\DataMigrator-*-win-x64.exe.blockmap (
        for %%F in (release\DataMigrator-*-win-x64.exe.blockmap) do (
            for %%A in ("%%F") do echo   blockmap     : %%~nxF  [%%~zA bytes]
        )
    )
    if exist release\latest.yml (
        echo   update meta  : release\latest.yml
    )
    if exist release\win-unpacked\resources\go-bin\esmigrator.exe (
        for %%A in (release\win-unpacked\resources\go-bin\esmigrator.exe) do (
            echo   go engine    : release\win-unpacked\resources\go-bin\esmigrator.exe  [%%~zA bytes]
        )
    )
) else (
    echo   (release directory missing - check logs)
)
echo ============================================================

endlocal
exit /b 0