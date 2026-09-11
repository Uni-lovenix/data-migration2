@echo off
setlocal
cd /d "%~dp0\.."

where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not found
    exit /b 1
)
echo [OK] Node.js

where npm >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm not found
    exit /b 1
)
echo [OK] npm

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
            echo [OK] Go (recovered from %%G)
            goto :go_found
        )
    )
    echo [FAIL] Go not found in PATH or common install dirs
    exit /b 1
)
echo [OK] Go (PATH)
:go_found

go version
echo [OK] Go version printed above

if exist node_modules (
    echo [OK] node_modules already installed
) else (
    echo [INFO] node_modules missing - start.cmd would install it
)

echo.
echo All checks passed - start.cmd would proceed to npm run dev.
endlocal
