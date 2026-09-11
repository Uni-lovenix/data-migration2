# 迭代协议 004：大数据量任务与可靠性

## 迭代目标

交付可运行的后台任务体系：迁移操作从阻塞式 IPC 改为任务队列，支持进度上报、取消、断点续传、SQLite 状态存储和结构化日志。

## 迭代范围

- 后台任务队列：PostgreSQL 与 Elasticsearch 的导出/导入统一入队、顺序执行。
- 进度上报：主进程向渲染层广播任务状态与进度。
- 取消：运行中的任务可取消，并保留可续传的游标。
- 断点续传：导入按已处理行继续，PostgreSQL 导出按行偏移继续，Elasticsearch search_after 按排序游标继续。
- SQLite 状态存储：任务记录持久化到 `userData/tasks.db`。
- 结构化日志：关键任务事件写入 JSON Lines 日志。
- 任务中心 UI：任务列表、状态、进度、取消与继续操作。
- 迁移工作台改为创建后台任务。

## 实施计划

1. 创建迭代分支与协议，接入 SQLite 依赖并重建 Electron 原生模块。
2. 定义共享任务类型、校验规则与 IPC 通道。
3. 实现 SQLite `TaskStore`、`StructuredLogger` 与 `TaskManager`。
4. 扩展 PostgreSQL / Elasticsearch 服务，支持取消和断点续传。
5. 接入主进程 IPC、Preload API 与任务中心 UI。
6. 补充单元测试，验证任务队列、游标、取消和恢复。
7. 更新架构、路线图、状态文件和质量证据。

## 交付物

- SQLite 任务表与原子更新。
- JSON Lines 结构化日志。
- 后台任务队列与进度广播。
- 取消与断点续传能力。
- 任务中心 UI 与迁移工作台入队改造。
- `npm run check`、`npm run build` 通过。

## 退出标准

- 类型检查无错误。
- 单元测试覆盖任务存储、队列、取消和续传。
- 生产构建通过。
- PostgreSQL / Elasticsearch 集成用例仍通过。
- `feature_list.json`、`progress.md`、`session-handoff.md` 和架构文档已更新。

## 结果

- `npm run check` 通过：7 个测试文件、36 个用例，另有 2 个集成用例默认跳过。
- `npm run build` 通过：产出 main/preload/renderer。
- Docker PostgreSQL 16 与 Elasticsearch 7.10.2 集成测试通过。
- `TaskStore` 使用 `sql.js` WASM，任务库持久化、取消、续传和日志均有单元测试证据。
- 已更新 `feature_list.json`、`progress.md`、`session-handoff.md`、`AGENTS.team.md`、`docs/PROCESS.md`、`docs/architecture.md` 与 `docs/roadmap.md`。
