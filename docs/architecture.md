# 架构基线

## 当前范围

第一迭代交付桌面应用骨架、安全 IPC 边界和多数据库连接管理：

- Electron 主进程负责窗口生命周期、本地持久化和原生能力。
- Preload 通过 `contextBridge` 暴露最小化、类型安全的 API。
- React + TypeScript 渲染层负责工作台 UI，不直接访问 Node.js。
- `src/shared` 保存 IPC 通道、类型和校验规则，主进程与渲染层共用。

## 进程边界

```text
React 渲染层
  -> window.api
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 ConnectionStore / TaskManager
  -> userData/connections.json / userData/tasks.db
```

渲染层无法访问 Node.js API；连接数据只能通过主进程 IPC 读写。后续迁移引擎、文件系统和原生对话框都放在主进程或独立 Go 服务中。

## 本地存储

连接配置使用 `userData/connections.json` 原子落盘；任务状态使用 `userData/tasks.db`（`sql.js` WASM SQLite）持久化，避免 Electron 原生模块 ABI 重建负担。

## PostgreSQL 迁移

迁移引擎放在 Electron 主进程，由 `PostgresService` 统一管理 PostgreSQL 客户端生命周期：

```text
React 迁移工作台
  -> window.api.postgres
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 PostgresService
  -> pg / pg-query-stream
```

- 连接测试和表浏览通过 `pg.Client` 查询 `pg_class` 与 `information_schema`。
- 表列表加载后通过后台并发执行 `count(1)` 刷新精确行数；统计期间显示 `...`，空表显示 `0`。
- 迁移工作台可通过 `pg_database` 列出全部数据库（模板库也会列出，非模板库优先），并在表浏览、测试连接、导出和导入请求中携带所选数据库覆盖连接默认数据库。
- 导出使用 `pg-query-stream` 流式读取 `SELECT * FROM schema.table`，逐行写入 JSONL 临时文件，完成后原子替换目标文件。
- 导出支持单表输出到 JSONL 文件，也支持多表选择后输出到同一目录，每张表生成独立的 `schema.table.jsonl` 文件。
- 导入逐行解析 JSONL，按批量生成参数化 `INSERT`，默认 `ON CONFLICT DO NOTHING`，并将对象/数组值序列化为 JSON 字符串。
- 文件路径由主进程原生对话框产生，PostgreSQL 操作只接受已保存的连接 ID，避免渲染层直接接触连接凭据。

## Elasticsearch 迁移

连接测试和索引浏览由 `ElasticsearchService` 完成；导出和导入由独立 Go 引擎 `golang/esmigrator` 完成，Electron 主进程通过 `GoElasticsearchService` 启动子进程：

```text
React Elasticsearch 工作台
  -> window.api.elasticsearch
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 GoElasticsearchService
  -> esmigrator 子进程
  -> Elasticsearch REST API
```

- 连接测试读取根接口的服务端版本，低于 7.10.2 的版本在 UI 中标记为不支持 search_after。
- 索引浏览读取 `_cat/indices`、`_cat/aliases` 与 `_mapping`，扁平化映射字段。
- Go 引擎导出支持 scroll 与 search_after 两种方式，逐批写入 JSONL 临时文件后原子替换目标文件。
- search_after 使用 PIT + `_doc` 排序；HTTP 请求显式设置 `Content-Length`，已在 Elasticsearch 7.10.2 与 9.5.0 上通过集成测试。
- Go 引擎导入逐行解析 JSONL 信封（`_id` / `_routing` / `_source`），通过 `_bulk` 分批写入；`create` 跳过已存在文档，`index` 覆盖写入。
- 大文件场景使用流式读写和批量边界进度文件，子进程按进度文件恢复游标，取消时写入取消标记文件并终止进程。
- `npm run build:go` 编译本机二进制，`npm run build:go:win` 交叉编译 Windows x64 二进制；打包时通过 `extraResources` 放入 `go-bin`。
- 文件路径由主进程原生对话框产生，Elasticsearch 操作只接受已保存的连接 ID。

## MySQL 与 SQLite 迁移

MySQL Source/Sink 使用 `mysql2`，SQLite Source 使用 `better-sqlite3`，两者都在 Electron 主进程中运行：

```text
React 迁移工作台
  -> window.api.mysql / window.api.sqlite
  -> Preload contextBridge
  -> IPC
  -> MySQLService / SQLiteService
  -> mysql2 / better-sqlite3
```

- MySQL 导出使用显式流式游标和 `LIMIT/OFFSET` 续传；导入使用多值 `INSERT`，支持 `error` / `skip` / `update` 冲突策略。
- SQLite 连接以绝对 `filePath` 表示；主进程以只读模式打开数据库，通过 `pragma_table_xinfo` 读取列，并使用 `iterate()` 分批导出。
- 两者沿用统一 JSONL 信封 `{table, columns, rows}`；SQLite 无主键时使用 `rowid` 顺序，有主键时按主键排序。
- 取消由 `TaskManager` 在已提交批次边界触发，调试式 `.part` 文件保留到最后成功批次，续传按行偏移继续。
- electron-builder 将 `better-sqlite3` 平台 prebuild `.node` 作为 asar unpack 资源打包，Node/Electron 使用同一 N-API 二进制。

## Hive 迁移

Hive 连接由 `HiveService` 封装，默认通过 `hive-driver` 连接 HiveServer2：

```text
React Hive 工作台
  -> window.api.hive
  -> Preload contextBridge
  -> IPC
  -> HiveService
  -> hive-driver / thrift
  -> HiveServer2 binary or HTTP transport
```

- 连接支持 `NONE`、`LDAP`、`KERBEROS`、`CUSTOM` 认证配置，以及 `binary` / `http` transport；HTTP 默认路径为 `/cliservice`。
- 数据库、表和 `COUNT(1)` 通过 HiveServer2 会话执行；导出按 `LIMIT batchSize OFFSET resumeRows` 分页。
- 导入先通过 `DESCRIBE` 推导目标列类型，再生成多值 `INSERT INTO ... VALUES`；单行转换错误按行号跳过。
- 输出沿用 `{table, columns, rows}` JSONL，ARRAY/MAP/STRUCT/UNION 等对象值序列化为 JSON 字符串。
- Hive 不支持 upsert，导入为追加语义；行游标只在成功提交批次后推进。
- Hive 无内置主键，OFFSET 续传在源表并发写入时可能跳行或重复，作为已知限制记录。
- `thrift@0.23.0` 所需的 `uuid` 依赖通过 npm override 固定到 11.0.5，避免 Electron CommonJS 主进程加载 ESM 失败。

## Neo4j 迁移

Neo4j Source 使用官方 `neo4j-driver` 在 Electron 主进程中执行：

```text
React Neo4j 工作台
  -> window.api.neo4j
  -> Preload contextBridge
  -> IPC
  -> Neo4jService
  -> neo4j-driver / Bolt
```

- `listLabels` / `listRelationshipTypes` 分别读取图目录；计数通过 `count(n)` / `count(r)`。
- 节点导出逐行写 `{_id,_labels,properties}`，关系导出逐行写 `{_id,_type,_src,_dst,properties}`。
- Cypher 使用 `ORDER BY _id SKIP $offset LIMIT $batch` 分页，避免 MATCH 顺序不稳定导致续传漏行/重行。
- `.part` 续传按完整 JSON 行计数，并截断中断造成的尾部残行。
- Temporal/Point/Integer 等驱动原生值在 Source 层归一化为 JSON 兼容值。

## Access 迁移

Access 由独立 Go 引擎处理，避免在 Electron 主进程中引入 ODBC 原生模块：

```text
React Access 工作台
  -> window.api.access
  -> Preload contextBridge
  -> IPC
  -> GoAccessService
  -> accessmigrator 子进程
  -> mdbtools (mdb-tables / mdb-export)
```

- `accessmigrator list-tables` 扫描表；`export` 将 CSV header 作为 columns，按 batchSize 写 JSONL。
- 控制文件与 Go Elasticsearch 引擎一致：progress JSON 上报批次进度，cancel marker 触发子进程停止。
- `resume-rows` 跳过已写入数据行，取消保留 `.part`，普通错误清理 `.part`。
- macOS/Windows 打包均包含 `accessmigrator` 二进制，但系统 PATH 仍必须提供 mdbtools 命令行工具。

## 导入字段投影

`selectedColumns` 是 PG/MySQL/ES/Hive 统一的导入投影契约：

- 缺失或空数组表示导入全部源字段。
- 非空时校验标识符、去重；每条 JSONL 记录展开后检查字段存在性，缺列直接拒绝任务。
- PG/MySQL/Hive 选取 records 子集后再生成 INSERT，列顺序保持 JSONL 源顺序。
- ES Node Sink 与 Go bulk 路径在写入前投影 `_source`。
- UI 通过 `fs:jsonl-columns` 读取首行字段；ES 自动读取 `_source` 子字段。

## 类型转换

`fieldTransforms` 在字段投影之后、批次写入之前执行：

- `json`：默认复杂值兜底或显式 JSON 序列化。
- `cast`：array→text、map→text、int→bool、ISO→timestamp。
- `stringify`：标量转字符串。
- `skip`：从目标记录中删除字段。

PG/MySQL/Hive 读取目标列类型并在不兼容时默认 JSON 化到字符串列；ES Node 与 Go bulk 在 `_source` 写入前应用显式规则。规则随任务 payload 可持久化到模板。

## 任务与可靠性

迁移操作统一通过 `TaskManager` 在 Electron 主进程后台执行：

```text
React 任务中心 / 迁移工作台
  -> window.api.tasks
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 TaskManager
  -> PostgresService / GoElasticsearchService / MySQLService / SQLiteService
  -> userData/tasks.db
```

- 任务按 `queued -> running -> completed / failed / canceled` 状态流转，SQLite 原子落盘。
- 进度通过 `tasks:changed` 事件广播给渲染层。
- 取消使用任务级标记；进度回调在下一个批次边界抛出 `TaskCancelledError`。
- 断点续传：导入按物理行游标继续，PostgreSQL 导出按行偏移继续，Elasticsearch search_after 按排序游标继续。
- 导出任务写入稳定的 `.part` 临时文件，续传时追加写入，完成后原子替换目标文件。
- Go 引擎通过 `*.go-progress.json` 上报进度、通过 `*.go-cancel` 接收取消信号。
- 结构化日志写入 `userData/logs/migration.log`，每条为 JSON Lines。

## 打包与交付

- electron-builder 使用 `package.json` 的 `build` 字段统一配置。
- macOS 目标为 dmg 与 zip，Windows 目标为 NSIS。
- 产物命名格式：`DataMigrator-<version>-<os>-<arch>.<ext>`。
- `sql.js` 的 WASM 文件通过 `asarUnpack` 保留为独立资源。
- `.github/workflows/build.yml` 在 macOS 与 Windows 上分别执行检查与打包。
- 本机 macOS 已验证 dmg/zip 产物并成功启动；Windows NSIS 由 CI 提供可复跑路径。
- 当前未配置代码签名，正式分发前需要 Apple Developer ID 与 Windows 代码签名证书。

## 后续模块

1. Go 引擎支持 PostgreSQL 导出/导入，逐步统一大文件传输实现。
2. 最终移交验收：评估者按验收清单复核全部 feature、运行说明与已知问题。

## 安全约定

- `contextIsolation: true`、`nodeIntegration: false`。
- 窗口只加载应用本地内容，外部链接交给系统浏览器。
- IPC 入参在主进程重新校验，不信任渲染层输入。
- 密码字段目前保存在本地配置中；正式发布前改用 Electron `safeStorage` 或系统钥匙串加密。

---

## Arch Review :: 2026-09-12 PM 规划轮

**角色：** 架构师

**任务：** 对 PM 在 `progress.md` 中规划的 10 个新 feature 进行架构师审阅（字段完整性、ownerRole 合理性、依赖闭环），并在交付前启动真实应用验证技术栈假设。

### 1. 字段完整性审计（✅ 全部通过）

10 个新增 feature 均包含必需字段 `id / name / description / status / ownerRole / dependencies`，无字段缺失。

### 2. 依赖闭环审计（✅ 全部通过）

| Feature | dependencies | pass 状态 |
|---------|-------------|----------|
| mysql-export | postgresql-migration, large-data-migration, desktop-shell-connections | ✅ 全部 pass |
| mysql-import | mysql-export | ⚠️ 自依赖（export 先于 import，预期内） |
| sqlite-export | postgresql-migration, large-data-migration, desktop-shell-connections | ✅ 全部 pass |
| hive-export | postgresql-migration, large-data-migration, desktop-shell-connections | ✅ 全部 pass |
| hive-import | hive-export | ⚠️ 自依赖 |
| neo4j-export | postgresql-migration, large-data-migration, desktop-shell-connections | ✅ 全部 pass |
| access-export | postgresql-migration, large-data-migration, desktop-packaging | ✅ 全部 pass |
| import-field-selection | postgresql-migration, elasticsearch-migration, large-data-migration | ✅ 全部 pass |
| type-conversion-pipeline | postgresql-migration, elasticsearch-migration, large-data-migration, migration-templates | ✅ 全部 pass |
| atomic-task-orchestration | agentic-chat-ui, migration-templates, type-conversion-pipeline, api-tokens-management | ⚠️ type-conversion-pipeline 自依赖 |

所有"自依赖"属于功能内部的串行依赖（export 先于 import、type-conversion 先于 orchestration），并非架构缺陷。

### 3. ownerRole 合理性审计

| Feature | ownerRole | 理由 |
|---------|-----------|------|
| mysql-export | 桌面端开发 | ✅ Node.js `mysql2` 驱动，与 `pg` 接口对称 |
| mysql-import | 桌面端开发 | ✅ 同上 |
| sqlite-export | 桌面端开发 | ✅ `better-sqlite3` 同步 API，简化实现 |
| hive-export | Golang 后端开发 | ✅ HiveServer2 Thrift/HTTP 协议 Node.js 生态薄弱，Go 标准库更合适 |
| hive-import | Golang 后端开发 | ✅ 同上 |
| neo4j-export | 桌面端开发 | ✅ 官方 `neo4j-driver` Node.js 绑定成熟 |
| access-export | Golang 后端开发 | ✅ Node.js 缺成熟 Access ODBC 驱动；Go 生态 `mattn/go-adodb` + `mdbtools` 可走通 |
| import-field-selection | 桌面端开发 | ✅ 纯 DTO + Service 改造，与 PG/ES 现有 import 路径对齐 |
| type-conversion-pipeline | 桌面端开发 | ✅ cast 规则存进模板 JSON，与 templates（已 pass）协同 |
| atomic-task-orchestration | 前端开发 | ⚠️ 边界模糊：API Server + IPC + Agent tool schema + UI 编排面板均涉及 |

**`atomic-task-orchestration` ownerRole 单独说明**：标注为"前端开发"是合理的延续性选择——
- 该功能的"Agent tool schema 补全 3 个原子"部分完全属于 `agentic-chat-ui` 已交付的 11 个工具的扩展，由前端开发（同 owner）实施保证一致性；
- "UI 编排面板"也属于前端工作；
- API Server endpoint 与 IPC handler 虽触及主进程，但与前端 work 紧密耦合，由前端开发统一实现可避免跨角色交接损耗。
若开发过程中发现后端 IPC 集成工作量过大，可后续重新协商 ownerRole。

### 4. 模块边界与 JSONL 信封设计（架构基线扩展）

10 个新 feature 全部围绕 **统一 JSONL 信封** `{table, columns: string[], rows: any[][]}` 构建（Neo4j 节点/关系采用 ES `_source` 信封 `{_id, _labels, properties}` 作为扩展），与现有 PG/ES 导入引擎完全兼容。

```
┌────────────────────────────────────────────────────────────────┐
│  数据源 (新增)              JSONL 信封        目标端 (已有)     │
├────────────────────────────────────────────────────────────────┤
│  MySQL (mysql2)         ─→ {table, columns, rows} ─→ PG/ES      │
│  SQLite (better-sqlite3)─→ {table, columns, rows} ─→ PG/ES      │
│  Hive (Go HTTP)         ─→ {table, columns, rows} ─→ PG/ES      │
│  Neo4j (neo4j-driver)   ─→ {_id, _labels, properties} ─→ ES     │
│  Access (Go mdbtools)   ─→ {table, columns, rows} ─→ PG/ES      │
└────────────────────────────────────────────────────────────────┘
```

**架构不变性**（DRY/SSOT 保护）：
- 导入引擎 `PostgresService.importTable` / `GoElasticsearchService.import` 不修改，仍以 JSONL/ES 信封为输入。
- 进度上报、取消、断点续传统一通过 `TaskManager`（已 pass）下发，不引入并行调度层。
- Go 引擎（dispatcher / esmigrator / pgmigrator）不感知新数据源——直接写 JSONL 文件即可被现有导入路径消费。

**字段投影（`import-field-selection`）** 在导入引擎的 `insertRows` / bulk 写入前按 `selectedColumns` 切片，DTO 与校验器层独立。

**类型转换（`type-conversion-pipeline`）** 在 `insertRows` 之前按 `fieldTransforms` 重塑每行；ES 路径在写入 `_source` 前重塑。cast 规则 JSON 存于 `templates.configJson`，与 `migration-templates` 复用。

### 5. 关键技术风险（架构师视角）

| 风险 | 评级 | 缓解 |
|------|------|------|
| MySQL/PG/Hive 复杂类型编码（JSONB/TIMESTAMPTZ/UUID/MAP/STRUCT） | 中 | 在导出时统一序列化为字符串，导入端按目标类型 cast；为后续 type-conversion-pipeline 留口子 |
| Hive HTTP mode `OFFSET` 续传可能跳行（无内置主键） | 中 | 文档化已知风险，建议生产环境用 esmigrator 风格 search_after 思路补齐 |
| Access 跨平台 ODBC 依赖（macOS unixodbc + mdbtools） | 中 | 文档化系统依赖；Windows 走 ODBC 注册驱动；macOS Homebrew 安装链路明确 |
| Neo4j SKIP/LIMIT 大偏移性能衰减 | 低 | 文档化大库迁移性能边界；分批策略可在后续迭代补齐 |
| `atomic-task-orchestration` 编排 API 暴露内部 IPC 细节 | 中 | API Server 层做权限隔离（仅 Bearer Token 通过），编排 steps 通过 validate 拦截 |
| HiveServer2 Kerberos/LDAP 认证 | 中 | 首版仅支持 NONE/LDAP，Kerberos 标记为后续扩展（依赖外部运维支持） |

### 6. 真实应用验证（架构假设）

技术栈假设：React + TypeScript + Electron + Golang + SQLite。
- 已通过 `npm run dev` 启动验证（smoke test 2026-09-11 09:40 PID 54093，详见 progress.md）。
- Go 引擎（esmigrator / pgmigrator / dispatcher）三套二进制编译通过；REST API `:3847` 与渲染层 `:5173` 双进程可并行。
- `npm run typecheck` 0 errors；`npm test` 44 passed。

**架构假设在运行的应用中成立**——新 feature 只需在已有边界内填充 Service / UI / Go 子进程，不引入新的进程模型。

### 7. 结论

10 个新 feature 的字段完整性、ownerRole、依赖闭环均通过架构师审阅。

**RESULT: accept**
