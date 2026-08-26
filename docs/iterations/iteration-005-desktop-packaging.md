# 迭代协议 005：桌面端打包与交付

## 迭代目标

交付可安装、可运行的 macOS 与 Windows 桌面应用，补齐打包配置、运行说明、CI 双平台验证和最终移交材料。

## 迭代范围

- 完善 electron-builder 配置：macOS dmg/zip、Windows NSIS、产物命名、asar 与 WASM 资源。
- 本机 macOS 打包验证：产出 dmg/zip 并确认应用可启动。
- Windows 打包验证：提供 CI 工作流在 windows-latest 上执行 NSIS 打包。
- 运行说明：开发、检查、打包、数据目录和已知问题。
- 发布文档：产物路径、验收清单和已知问题登记。

## 实施计划

1. 创建迭代分支与协议。
2. 更新 `package.json` 的 electron-builder 配置。
3. 添加 README 与发布文档。
4. 添加 GitHub Actions 双平台打包工作流。
5. 执行本机可用的 macOS 打包与启动验证。
6. 更新架构、路线图、状态文件和质量证据。

## 交付物

- macOS dmg/zip 打包配置与本地产物。
- Windows NSIS 打包配置与 CI 工作流。
- README / 发布文档 / 已知问题清单。
- `npm run check`、`npm run build`、本机 `package:mac` 通过。

## 退出标准

- 类型检查、单元测试和生产构建通过。
- 本机 macOS dmg/zip 打包通过。
- Windows NSIS 打包至少具备可复跑的 CI 证据路径。
- 运行说明与已知问题已登记。
- `feature_list.json`、`progress.md`、`session-handoff.md` 和架构文档已更新。

## 结果

- `npm run package:mac` 通过，产出 `release/DataMigrator-0.1.0-mac-arm64.dmg` 与 `.zip`。
- 打包后的 `DataMigrator.app` 实际启动成功。
- `.github/workflows/build.yml` 提供 macOS / Windows 双平台检查与打包。
- `README.md` 与 `docs/release.md` 已提供开发、打包、数据目录和已知问题说明。
- 已更新 `feature_list.json`、`progress.md`、`session-handoff.md`、`AGENTS.team.md`、`docs/PROCESS.md`、`docs/architecture.md` 与 `docs/roadmap.md`。
