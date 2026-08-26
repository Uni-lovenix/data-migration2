# Session Handoff -- 数据迁移工具

## Current Objective

- Goal: 1. 支持postgresql的数据导出和导入
2. 支持elasticsearch的数据导出和导入
3. 支持elasticsearch 7.10.2版本及以上
4. 支持大数据量大导出和导入
5. 支持多个数据库的配置
6. 桌面版应用，支持mac/windows平台
- Current status: 大数据量任务与可靠性迭代已完成，等待评估者验收；下一步桌面端打包与交付。
- Branch: `feature/large-data-migration`

## Completed This Session

- [x] 迭代协议 004：大数据量任务与可靠性。
- [x] SQLite 任务存储（`sql.js` WASM）与 JSON Lines 结构化日志。
- [x] 后台任务队列、进度广播、取消与断点续传。
- [x] PostgreSQL / Elasticsearch 迁移服务支持续传游标。
- [x] 任务中心 UI，迁移工作台改为创建后台任务。
- [x] 36 个单元测试用例、生产构建和真实 PostgreSQL / Elasticsearch 集成测试。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node 与 web 两套 tsconfig 均无错误 |
| 单元测试 | `npm test` | 通过 | 7 个文件、36 个用例，另有 2 个集成用例默认跳过 |
| 生产构建 | `npm run build` | 通过 | 产出 main/preload/renderer |
| ES 集成测试 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 npx vitest run tests/elasticsearch.integration.test.ts` | 通过 | Docker Elasticsearch 7.10.2，100 文档 scroll/search_after 导出与 bulk 导入闭环 |
| PostgreSQL 集成测试 | `POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 npx vitest run tests/postgres.integration.test.ts` | 通过 | Docker PostgreSQL 16，100 行导出/导入闭环 |
| 开发启动 | `npm run dev` | 通过 | Electron 窗口与 Vite 渲染服务 |

## Files Changed

- `src/shared/ipc.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/main/elasticsearch-service.ts`
- `src/main/task-manager.ts`
- `src/main/task-store.ts`
- `src/main/task-errors.ts`
- `src/main/logger.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/pages/TasksPage.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `src/renderer/src/pages/ElasticsearchMigrationPanel.tsx`
- `src/renderer/src/styles.css`
- `tests/elasticsearch-service.test.ts`
- `tests/elasticsearch.integration.test.ts`
- `tests/postgres-service.test.ts`
- `tests/task-manager.test.ts`
- `tests/task-store.test.ts`
- `tests/logger.test.ts`
- `tests/validation.test.ts`
- `package.json` / `package-lock.json`
- `docs/iterations/iteration-004-large-data-migration.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/PROCESS.md`
- `docs/iterations/iteration-003-elasticsearch-migration.md`
- `AGENTS.team.md`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`

## Decisions Made

- SQLite 使用 `sql.js` WASM，任务库保存在 `userData/tasks.db`。
- 任务队列在 Electron 主进程顺序执行，进度通过 `tasks:changed` 广播。
- 取消使用任务级取消标记；导入按物理行续传，PostgreSQL 导出按行偏移续传，Elasticsearch search_after 按排序游标续传。
- 结构化日志写入 `userData/logs/migration.log`。
- 迁移工作台现在创建后台任务，不再直接阻塞调用迁移服务。

## Blockers / Risks

- 当前无已知 blocker。
- 任务队列当前为单并发顺序执行；后续若需要并行迁移，可扩展 worker 池。
- 断点续传的游标粒度为批量边界，单个批量写入过程中取消可能出现重复或缺失，发布前可进一步做幂等写入。

## Next Session Startup

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read `feature_list.json` and `progress.md`.
3. Review this handoff.
4. Run `bash init.sh` before editing.
5. 在 `feature/large-data-migration` 基础上开始 `desktop-packaging`。

## Recommended Next Step

选择 `desktop-packaging`，按 RUP 迭代协议实现 macOS dmg/zip、Windows NSIS 打包验证、运行说明和最终移交。
