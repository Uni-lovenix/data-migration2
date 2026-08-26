# DataMigrator

DataMigrator 是面向 PostgreSQL 与 Elasticsearch 的桌面数据迁移工具，支持大数据量 JSONL 导出/导入、后台任务队列、取消与断点续传。

## 功能

- PostgreSQL 连接测试、表浏览、流式导出与分批导入。
- Elasticsearch 连接测试、索引/映射浏览、scroll / search_after 导出与 bulk 导入。
- 兼容 Elasticsearch 7.10.2 及以上版本。
- 后台任务队列、进度上报、取消、断点续传与 SQLite 任务状态存储。
- macOS 与 Windows 桌面打包。

## 开发环境

```bash
npm install
npm run dev
```

常用验证：

```bash
npm run check
npm run build
bash init.sh
```

## 打包

```bash
# 当前平台
npm run package

# 指定平台
npm run package:mac
npm run package:win
```

产物输出到 `release/`。macOS 目标为 dmg 与 zip，Windows 目标为 NSIS 安装包。Windows 打包建议在 Windows 或 CI 上执行；仓库内 `.github/workflows/build.yml` 会在 macOS 与 Windows 上分别执行检查与打包。

## 数据目录

- 连接配置：`userData/connections.json`
- 任务状态：`userData/tasks.db`
- 结构化日志：`userData/logs/migration.log`

`userData` 由 Electron 按平台解析，例如 macOS 为 `~/Library/Application Support/DataMigrator`，Windows 为 `%APPDATA%/DataMigrator`。

## 已知问题

- 任务队列当前为单并发顺序执行。
- 断点续传游标为批量边界，单个批量写入过程中取消可能出现重复或缺失。
- 连接密码当前以明文保存在本地配置中，正式发布前建议接入系统钥匙串或 Electron `safeStorage`。

## 文档

- [架构基线](docs/architecture.md)
- [分步路线](docs/roadmap.md)
- [RUP 过程](docs/PROCESS.md)
- [迭代记录](docs/iterations/)
