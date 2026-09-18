@echo off
echo Step 1: for /f with npm
for /f "tokens=1" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
echo NPM_VER=%NPM_VER%
echo ERRORLEVEL_AFTER_FOR=%errorlevel%

echo Step 2: where go
where go >nul 2>&1
echo ERRORLEVEL_AFTER_WHERE=%errorlevel%

echo Step 3: separate where go call
where go
