# DataMigrator 离线开发工具包

本目录用于在 Windows 11 上离线继续开发 DataMigrator。把整个项目目录拷贝到目标机器后，不需要访问外网即可安装依赖、运行检查、启动开发环境和生成 Windows 安装包。

当前工具包按 Windows 11 x64 准备。项目关闭了 `npmRebuild`，运行时依赖均为纯 JS/WASM，因此离线开发不要求安装 Visual Studio Build Tools。

## 目录说明

```text
dev_tools/
  installers/windows/
    nodejs/       Node.js 24 LTS Windows x64 安装包
    git/          Git for Windows x64 安装包
    golang/       Go Windows amd64 安装包（Elasticsearch Go 引擎需要）
  cache/electron/
    Electron 33.4.11 win32-x64 离线缓存
  cache/electron-builder/
    NSIS、7zip、winCodeSign 等 Windows 打包工具缓存
  cache/npm/
    npm 离线依赖缓存，配合 package-lock.json 使用
  scripts/
    setup-offline-dev.ps1
  checksums.sha256
```

## 离线环境配置步骤

1. 把整个项目目录（包含 `dev_tools/`）完整拷贝到 Windows 11，建议保持目录结构不变。
2. 双击安装 `dev_tools/installers/windows/nodejs/node-v24.20.0-x64.msi`。
3. 双击安装 `dev_tools/installers/windows/git/Git-2.55.0.5-64-bit.exe`。
4. 安装 `dev_tools/installers/windows/golang/go1.26.7.windows-amd64.msi`，Go 引擎负责 Elasticsearch 导出/导入。
5. 关闭并重新打开 PowerShell，进入项目根目录。
6. 运行一键配置脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\dev_tools\scripts\setup-offline-dev.ps1
```

脚本会完成以下操作：

- 设置 Electron 缓存：`dev_tools\cache\electron`
- 设置 electron-builder 缓存：`dev_tools\cache\electron-builder`
- 设置 npm 缓存：`dev_tools\cache\npm`
- 执行 `npm ci --offline`
- 执行 `npm run check`

## 手动配置方式

如果不使用脚本，可以在 PowerShell 中手动执行：

```powershell
$env:electron_config_cache = "$PWD\dev_tools\cache\electron"
$env:ELECTRON_BUILDER_CACHE = "$PWD\dev_tools\cache\electron-builder"
$env:npm_config_cache = "$PWD\dev_tools\cache\npm"

npm ci --offline
npm run check
```

## 常用离线命令

启动开发环境：

```powershell
powershell -ExecutionPolicy Bypass -File .\dev_tools\scripts\setup-offline-dev.ps1 -Dev
```

生成 Windows 安装包：

```powershell
powershell -ExecutionPolicy Bypass -File .\dev_tools\scripts\setup-offline-dev.ps1 -PackageWin
```

只安装依赖、不跑检查：

```powershell
powershell -ExecutionPolicy Bypass -File .\dev_tools\scripts\setup-offline-dev.ps1 -SkipChecks
```

## 完整性校验

安装前可在 Windows 上运行：

```powershell
Get-ChildItem -Path .\dev_tools -Recurse -File -Include *.msi,*.exe,*.zip,*.7z,*.tar.gz |
  ForEach-Object { Get-FileHash -Algorithm SHA256 -Path $_.FullName }
```

并将结果与 `dev_tools/checksums.sha256` 核对。

## 常见问题

- `npm ci --offline` 报缺少包：确认 `dev_tools\cache\npm` 完整存在，且 `package-lock.json` 与缓存来自同一版本依赖树。
- Electron 安装阶段报下载错误：确认 `dev_tools\cache\electron` 下存在 `4b092cc...\electron-v33.4.11-win32-x64.zip`，并设置 `electron_config_cache`。
- 打包阶段报下载 NSIS/winCodeSign 错误：确认 `dev_tools\cache\electron-builder` 下目录完整，并设置 `ELECTRON_BUILDER_CACHE`。
- 找不到 Node/npm：先安装 `node-v24.20.0-x64.msi`，关闭并重新打开 PowerShell 后再运行脚本。
- 集成测试默认关闭：只有显式设置 `POSTGRES_INTEGRATION=1` 或 `ELASTICSEARCH_INTEGRATION=1` 时才会连接外部数据库。
