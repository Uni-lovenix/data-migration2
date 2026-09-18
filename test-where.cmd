@echo off
echo Step 1: testing where go
where go >nul 2>&1
echo ERRORLEVEL_AFTER_WHERE=%errorlevel%
if errorlevel 1 (
    echo WHERE_FAILED
) else (
    echo WHERE_OK
)
