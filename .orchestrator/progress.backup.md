# Session Progress Log -- 数据迁移工具

## Current State

**Last Updated:** 2026-08-28T15:42:00.000Z
**Active Feature:** Go 引擎 Elasticsearch 导出/导入
**Current RUP Phase:** construction
**Current Iteration:** iteration-006-golang-elasticsearch

## Status

### What's Done

- [x] RUP harness 和团队配置已初始化。
- [x] `quality-document.md`、`evaluator-rubric.md` 和 `clean-state-checklist.md` 已初始化。
- [x] `AGENTS.team.md`、`agents.json`、`agents/` 已生成。
- [x] `AGENTS.md` / `CLAUDE.md` 默认规则入口已初始化。
- [x] 迭代 001：Electron + React + TypeScript 桌面壳与连接管理已交付。
- [x] 迭代 002：PostgreSQL 连接测试、表浏览、JSONL 流式导出和分批导入已交付。
- [x] 迭代 003：Elasticsearch 连接测试、索引/映射浏览、scroll / search_after 流式导出和 bulk 分批导入已交付。
- [x] 迭代 004：后台任务队列、进度上报、取消、断点续传、SQLite 状态存储和结构化日志已交付。
- [x] 迭代 005：macOS dmg/zip、Windows NSIS 打包配置、CI 工作流、运行说明和发布文档已交付。
- [x] 迭代 006：新增 `golang/esmigrator` 独立 Go 引擎，Elasticsearch 导出/导入改为子进程执行。
- [x] PostgreSQL 与 Elasticsearch 迁移工作台 UI 与安全 IPC 已接入。
- [x] PostgreSQL 迁移工作台支持连接后自动同步表列表、多选表导出到目录。
- [x] PostgreSQL 迁移工作台支持数据库下拉选择，切换后同步表列表并带入导出/导入任务。
- [x] PostgreSQL 数据库列表支持拉取服务器全部数据库，模板库也会显示，非模板库默认优先。
- [x] 新增 `start.sh`，缺少依赖时自动安装并启动本地 Electron 应用。
- [x] 表列表加载后后台执行 `count(1)` 刷新精确行数，统计中显示 `...`，空表显示 `0`。
- [x] 渲染层增加错误边界，数据库加载异常时回退默认库；表列表支持搜索并限制单次渲染数量，避免大库选择导致白屏或卡死。
- [x] 任务中心 UI 与迁移操作入队已接入。
- [x] 类型检查、44 个单元测试、生产构建已通过。
- [x] Go 单元测试覆盖 scroll 导出、search_after 续传、bulk 冲突跳过和取消。
- [x] `npm run build:go` 与 `npm run build:go:win` 交叉编译通过。
- [x] 真实 Elasticsearch 7.10.2 集成验证通过：Go 引擎 scroll 导出 5 行，bulk 导入后重复导入 5 行全部 409 跳过。
- [x] Docker Elasticsearch 7.10.2 与 9.5.0 集成测试已通过（100 文档，scroll / search_after 导出，bulk 导入与跳过冲突）。
- [x] Docker PostgreSQL 16 集成测试已通过（导出 100 行并导入到目标表）。
- [x] `npm run dev` 已成功启动桌面应用。
- [x] `npm run package:mac` 已产出 dmg/zip，打包后的 `.app` 实际启动成功。

### What's Next

1. 在 Elasticsearch 9.5.0 上补充 Go 引擎集成验证。
2. 评估者复核 Go 引擎改动与最终验收清单。
3. 如需正式发布，在 GitHub Actions 上运行双平台打包并上传产物。

## Blockers / Risks

- 尚未识别阻塞项。
- search_after 使用 PIT + `_doc` 排序；已在 Elasticsearch 7.10.2 与 9.5.0 上实测通过。
- 当前宿主环境设置了 `ELECTRON_RUN_AS_NODE=1`，已通过 `scripts/electron-vite.mjs` 在开发启动时移除该变量。

## Decisions Made

- 使用 RUP 四阶段和迭代协议管理长生成项目。
- 使用 `feature_list.json` 作为功能状态单一事实源。
- 使用 `session-handoff.md` 和 `progress.md` 支持跨会话恢复。
- 连接配置先使用 JSON 原子落盘，后续切 SQLite 时保持存储接口可替换。
- PostgreSQL 迁移引擎放在 Electron 主进程，使用 `pg` 与 `pg-query-stream`；Elasticsearch 导出/导入由 `golang/esmigrator` Go 子进程执行。
- ES 导出 JSONL 每行保存 `_id` / `_routing` / `_source` 信封；导入支持 `index` 覆盖与 `create` 跳过冲突。
- Elasticsearch HTTP 请求显式设置 `Content-Length`，规避 7.10.2 PIT 搜索对 chunked 请求体解析异常的问题。
- SQLite 使用 `sql.js` WASM 实现，避免 Electron 原生模块 ABI 重建；任务库保存在 `userData/tasks.db`。
- 迁移任务通过后台 `TaskManager` 顺序执行；导出续写 `.part` 临时文件，导入按物理行游标继续。
- 结构化日志写入 `userData/logs/migration.log`，每条为 JSON Lines。
- electron-builder 配置包含 asar、sql.js WASM 解包、macOS dmg/zip 与 Windows NSIS；Windows 打包通过 CI 工作流执行。
- Go 二进制通过 `extraResources` 打入 `go-bin`，Electron 主进程按开发/打包环境自动定位。

## Plan :: new-iteration

### 缺口分析

对比 goals.md 与现有 feature_list.json，发现以下目标尚未被完整覆盖：

| Goal | 覆盖情况 |
|------|---------|
| 1. 多 ES 索引串行/并行导出导入 | 部分覆盖（UI 有并行选项，Go 引擎层面并行调度未实现） |
| 2. 多 PostgreSQL 表串行/并行导出导入 | 部分覆盖（UI 有选项，未用 Go 引擎） |
| 3. **全部使用 Go 引擎，支持高并发** | **未完成**：PostgreSQL 仍用 Electron 主进程 `pg` / `pg-query-stream` |
| 4. 导出到文件 / 从文件导入 | 已覆盖 |
| 5. 直接环境到环境迁移（不经文件） | **未覆盖** |
| 6. 导出记录 + 批量配置化迁移 | **未覆盖** |

### 下一交付单元

**`golang-postgresql-migration`（Go 引擎 PostgreSQL 迁移）**

理由：Goal 3 明确要求"导出和导入都使用 golang 实现的导出导入引擎"，PostgreSQL 是当前唯一仍未迁移到 Go 引擎的数据源。完成此项后，两条数据迁移路径（ES / PG）才真正技术对齐，并可为后续 Goal 1/2 的并行调度打好基础。

### 依赖关系

- `postgresql-migration`（pass）→ 提供现有 pg 实现作为参考和对比基准
- `large-data-migration`（pass）→ 提供任务队列与 SQLite 状态存储
- `desktop-packaging`（pass）→ 确保 Go 二进制打入打包产物
- `golang-elasticsearch-migration`（pass）→ 提供 Go 引擎子进程调用模式与接口范式

### 后续可跟进

- `golang-postgresql-migration` 完成后，回填 Goal 1/2 的并行调度支持。
- 直接环境到环境迁移（Goal 5）和批量配置化迁移（Goal 6）可作为后续迭代独立推进。

## Design -- golang-postgresql-migration

### 技术方案

在 `golang/pgmigrator/` 下实现独立的 `pgmigrator` 二进制，命令接口与 `esmigrator` 完全对齐：

```
pgmigrator export --dsn DSN --table TABLE --output FILE [--batch-size N] [--resume-rows N] [--progress-file FILE] [--cancel-file FILE]
pgmigrator import --dsn DSN --table TABLE --input FILE [--batch-size N] [--on-conflict skip|overwrite] [--resume-lines N] [--progress-file FILE] [--cancel-file FILE]
pgmigrator version
```

**导出**：使用 PostgreSQL `COPY ... TO STDOUT WITH BINARY` 或 `pg_query_stream`（`pg-query-stream`）实现流式导出，直接写 JSONL 文件，写入 `.part` 临时文件支持断点续传。`resume-rows` 从已写入的 `.part` 文件行数恢复。

**导入**：读取 JSONL，按 `batch-size` 分批执行 `COPY ... FROM STDIN WITH BINARY` 或 `INSERT ... ON CONFLICT` 批量插入。`on-conflict=skip` 时用 `ON CONFLICT DO NOTHING`，`overwrite` 时先 `DELETE` 再插入。

**进度文件**：与 ES 引擎相同 JSON 格式 `{rowsExported, rowsImported, bytesWritten, durationMs, canceled}`。

**取消**：检测 `--cancel-file` 文件存在性，检测周期 ≤1s，检测到后优雅退出（写 `canceled=true` 到进度文件，exit code 3）。

**日志**：每批操作写一行 JSON Lines 到 `userData/logs/migration.log`，格式 `{ts, level, msg, rowsAffected, durationMs, error}`。

### 模块边界

```
golang/pgmigrator/
  main.go          # 入口，flag 解析，子命令路由（export/import/version）
  export.go       # COPY 流式导出逻辑，断点续传写 .part
  import.go       # 批量插入逻辑，冲突处理
  progress.go     # 进度文件读写
  client.go       # pgx 连接池封装
  main_test.go    # 单元测试（mock pgx）
  integration_test.go  # Docker PostgreSQL 16 集成测试
```

### 接口契约

- **子进程调用**：Electron 主进程通过 `child_process.spawn` 调用 `pgmigrator`，通过 `--progress-file` 和 `--cancel-file` 传递进度/取消信号，与 `esmigrator` 完全一致。
- **进度文件**：每批刷新，写入 `userData/progress/<taskId>.json`，主进程轮询读取。
- **Exit codes**：0 成功，1 错误，3 canceled。
- **JSONL 输出**（导出）：每行 `{table, columns: string[], rows: any[][]}`，与 ES 的 `_id`/`_source` 信封不同，PG 直接以列数组形式存储行数据。
- **JSONL 输入**（导入）：读取同格式，解析后映射到目标表列。

### 与 esmigrator 的对齐

- 命令结构（`pgmigrator export/import/version`）与 `esmigrator` 完全一致。
- Flag 命名（`--batch-size`, `--resume-rows/--resume-lines`, `--progress-file`, `--cancel-file`, `--on-conflict`）与 `esmigrator` 一致。
- 进度文件 JSON 结构相同。
- Exit code 3 表示 canceled。
- Electron IPC 调用模式相同，仅 dsName 从 `esmigrator` 改为 `pgmigrator`。
- `pkg/migrator/engine.go` 抽象接口保持不变，具体实现由 `ESEngine` / `PGEngine` 注入。

## Plan :: new-iteration

### 缺口分析（最终确认）

逐一核对 goals.md 全部 8 个目标，确认均已被 feature_list.json 覆盖：

| Goal | 覆盖的 Feature | 状态 |
|------|--------------|------|
| 1. 多 ES 索引串行/并行导出导入 | `golang-parallel-scheduling` | not_started |
| 2. 多 PostgreSQL 表串行/并行导出导入 | `golang-parallel-scheduling` | not_started |
| 3. 全部使用 Go 引擎，支持高并发 | `golang-postgresql-migration` + `golang-elasticsearch-migration` | in_progress + pass |
| 4. 导出到文件 / 从文件导入 | `golang-elasticsearch-migration` | pass |
| 5. 直接环境到环境迁移（不经文件） | `direct-environment-migration` | not_started |
| 6. 导出记录 + 批量配置化迁移 | `migration-templates` | not_started |
| 7. agentic / LLM 配置 | `agentic-llm-integration` | not_started |
| 8. token 方式调用引擎 | `agentic-llm-integration` | not_started |

**结论：goals.md 无遗漏目标，无需追加新 feature。**

### 下一交付单元

**`golang-parallel-scheduling`（多数据源并行/串行调度）**

当前阻塞：`golang-postgresql-migration`（status=in_progress）尚未完成。
一旦 `golang-postgresql-migration` 达到 pass 状态，立即启动此功能。

### 依赖路径

- `golang-elasticsearch-migration`（pass）→ 提供并行调度基础
- `golang-postgresql-migration`（in_progress）→ PG Go 引擎就绪后并行调度覆盖 PG 表
- `large-data-migration`（pass）→ 任务队列与 SQLite 状态

### 后续可跟进

- `golang-parallel-scheduling` 完成后，`direct-environment-migration` 和 `migration-templates` 可并行推进
- `agentic-llm-integration` 可作为远期特性独立迭代

## Notes for Next Session

先运行 `bash init.sh` 确认基线健康。Go 引擎已接入 Elasticsearch 导出/导入，7.10.2 集成验证已通过；下一步为 9.5.0 补充验证与评估者复核；如需复跑可执行 `npm run check`、`npm run build`、`npm run test:go`。
