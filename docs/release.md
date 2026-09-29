# 发布说明

当前版本：**v1.2.1**

## 产物

`npm run package:mac` 与 `npm run package:win` 会先执行类型检查、单元测试和生产构建，再调用 electron-builder 产出安装包。

Elasticsearch 导出/导入使用 Go 引擎 `golang/esmigrator`；打包脚本会先编译当前平台或 Windows x64 二进制，并通过 `extraResources` 放入 `go-bin`。

- macOS：`release/DataMigrator-<version>-mac-<arch>.dmg` 与 `.zip`
- Windows：`release/DataMigrator-<version>-win-<arch>.exe`（NSIS）

## 验收清单

- [x] `npm run check` 通过。
- [x] `npm run build` 通过。
- [x] 当前平台安装包生成成功（macOS dmg/zip）。
- [x] 安装后应用可启动并进入总览页。
- [x] 新建连接、创建迁移任务和任务中心可正常使用（Electron + CDP 端到端验证）。
- [x] 已知问题已登记到本文件与 `feature_list.json`。

> 启动打包产物时需确保环境变量 `ELECTRON_RUN_AS_NODE` 未被设置，否则 Electron 会以 Node 模式运行并静默退出。

## 数据与卸载

卸载应用不会自动删除 `userData` 下的连接配置、任务库和日志。需要保留现场时，可先备份整个 `userData` 目录。

## 已知问题

- 后台任务默认并发度为 4；Elasticsearch 单任务内部并发度会与任务并发度叠加，需要根据集群和连接池容量调整。
- 断点续传以批量边界为粒度，批量写入中途取消可能产生重复或缺失。
- 连接密码尚未加密存储，建议发布前接入系统钥匙串或 Electron `safeStorage`。
- Windows NSIS 安装包需要 Windows 环境或 CI 构建；本地 macOS 无法直接验证 NSIS 安装流程。
- 直连/镜像/存档/恢复任务不支持断点续传；失败后按策略回滚或重跑。
- `golang/pgmigrator` 的 CLI `export`/`direct` 路径损坏（COPY 流用法错误），应用内未引用该引擎。
- HDFS 镜像存档为 App 自定义 JSONL 分片格式（非 Elasticsearch snapshot），且仅支持 WebHDFS simple 认证。
- 镜像/存档/恢复尚未接入模板与编排（保存为模板时会跳过并提示）。
- macOS 未配置代码签名/公证，Windows 未配置代码签名，首次运行会有系统安全提示。
