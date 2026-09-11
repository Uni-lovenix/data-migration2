param(
    [switch]$SkipInstall,
    [switch]$SkipChecks,
    [switch]$Dev,
    [switch]$PackageWin
)

$ErrorActionPreference = "Stop"

if ($Dev -and $PackageWin) {
    throw "不能同时使用 -Dev 和 -PackageWin。"
}

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DevToolsRoot = Split-Path -Parent $ScriptRoot
$ProjectRoot = Split-Path -Parent $DevToolsRoot

$ElectronCache = Join-Path $DevToolsRoot "cache\electron"
$ElectronBuilderCache = Join-Path $DevToolsRoot "cache\electron-builder"
$NpmCache = Join-Path $DevToolsRoot "cache\npm"
$ElectronZip = Join-Path $ElectronCache "4b092cc678b6ff8448c5ab35fabca1710dccc91cfbff065280601a184126b0fe\electron-v33.4.11-win32-x64.zip"
$Nsis7z = Join-Path $ElectronBuilderCache (Join-Path "nsis-3.0.4.1" "nsis-3.0.4.1.7z")
$NsisResources7z = Join-Path $ElectronBuilderCache (Join-Path "nsis-resources-3.4.1" "nsis-resources-3.4.1.7z")
$SevenZipArchive = Join-Path $ElectronBuilderCache (Join-Path "7zip@1.0.0" "7zip-win-x64.tar.gz")
$WinCodeSign7z = Join-Path $ElectronBuilderCache (Join-Path "winCodeSign-2.6.0" "winCodeSign-2.6.0.7z")

$env:electron_config_cache = $ElectronCache
$env:ELECTRON_BUILDER_CACHE = $ElectronBuilderCache
$env:npm_config_cache = $NpmCache

function Assert-OfflineFile {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "缺少离线文件：$Label ($Path)"
    }
}

Assert-OfflineFile -Path $ElectronZip -Label "Electron win32-x64 缓存"
Assert-OfflineFile -Path $Nsis7z -Label "NSIS"
Assert-OfflineFile -Path $NsisResources7z -Label "NSIS resources"
Assert-OfflineFile -Path $SevenZipArchive -Label "7zip"
Assert-OfflineFile -Path $WinCodeSign7z -Label "winCodeSign"
Assert-OfflineFile -Path (Join-Path $NpmCache "_cacache") -Label "npm 离线缓存"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "未找到 Node.js。请先安装 dev_tools\installers\windows\nodejs 下的 MSI，然后重新打开 PowerShell。"
}

Write-Host "Node.js: $(node -v)"
Write-Host "npm: $(npm -v)"

Push-Location $ProjectRoot
try {
    if (-not $SkipInstall) {
        Write-Host "正在使用离线缓存安装 npm 依赖..."
        npm ci --offline --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci 失败。"
        }
    }

    if (-not $SkipChecks) {
        Write-Host "正在运行类型检查与单元测试..."
        npm run check
        if ($LASTEXITCODE -ne 0) {
            throw "npm run check 失败。"
        }
    }

    if ($Dev) {
        Write-Host "正在启动离线开发环境..."
        npm run dev
        if ($LASTEXITCODE -ne 0) {
            throw "npm run dev 退出异常。"
        }
    }

    if ($PackageWin) {
        Write-Host "正在生成 Windows 安装包..."
        npm run package:win
        if ($LASTEXITCODE -ne 0) {
            throw "npm run package:win 失败。"
        }
    }
}
finally {
    Pop-Location
}

if (-not $Dev -and -not $PackageWin) {
    Write-Host ""
    Write-Host "离线开发环境已就绪。"
    Write-Host "启动开发：npm run dev"
    Write-Host "Windows 打包：npm run package:win"
}
