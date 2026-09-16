# DataMigrator

DataMigrator 是面向 PostgreSQL、Elasticsearch、MySQL、SQLite、Hive、Neo4j 与 Microsoft Access 的桌面数据迁移工具，支持大数据量 JSONL 导出/导入、后台任务队列、取消与断点续传。

## 功能

- PostgreSQL 连接测试、全部数据库选择、表浏览（后台 `count(1)` 精确行数）、单表/多表流式导出与分批导入。
- Elasticsearch 连接测试、索引/映射浏览，以及由 Go 引擎执行的 scroll / search_after 流式导出与 bulk 导入。
- MySQL 连接、库/表浏览、流式 JSONL 导出与多值批量导入（`error` / `skip` / `update` 冲突策略）。
- SQLite 文件连接、表/列/行数浏览与迭代式 JSONL 导出。
- Hive HiveServer2 binary/HTTP 连接、库/表/行数浏览、分页 JSONL 导出与多值批量追加导入。
- Neo4j Bolt 连接、节点标签/关系类型浏览、计数与逐行 JSONL 导出。
- Access `.mdb/.accdb` 文件表的流式 CSV → JSONL 导出；运行时需要系统安装 `mdbtools`。
- PostgreSQL / MySQL / Elasticsearch / Hive 导入支持 `selectedColumns` 字段投影。
- 导入支持 `fieldTransforms`：默认 JSON 兜底、cast、stringify 和 skip 策略。
- 兼容 Elasticsearch 7.10.2 及以上版本。
- 后台任务队列、进度上报、取消、断点续传与 SQLite 任务状态存储。
- macOS 与 Windows 桌面打包。

## 开发环境

本地启动应用：

```bash
./start.sh
```

Elasticsearch 导出/导入使用 `golang/esmigrator` 子进程引擎，需要 Go 1.22 或更高版本；`npm run dev` 会先自动构建本机 Go 二进制。

也可以直接使用 npm 脚本：

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

Go 引擎也可以单独验证：

```bash
npm run test:go
npm run vet:go
```

## 打包

```bash
# 当前平台
npm run package

# 指定平台
npm run package:mac
npm run package:win
```

产物输出到 `release/`。macOS 目标为 dmg 与 zip，Windows 目标为 NSIS 安装包。Go 二进制会通过 `extraResources` 打进 `go-bin`，桌面端启动时自动定位。Windows 打包建议在 Windows 或 CI 上执行；仓库内 `.github/workflows/build.yml` 会在 macOS 与 Windows 上分别执行检查与打包。

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
