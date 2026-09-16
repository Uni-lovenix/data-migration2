# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export`, `mysql-import`, `sqlite-export`, `hive-export`, `hive-import`, and `neo4j-export` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-016-neo4j-export`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 Neo4j 连接、标签/关系类型浏览和计数。
- [x] 节点/关系逐行 JSONL 输出，兼容 ES bulk source / PostgreSQL JSONL 记录。
- [x] 完成 SKIP/LIMIT 分页、`.part` 续传、取消和错误清理。
- [x] 接入 IPC、TaskManager、连接管理与 Neo4j 迁移工作台。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 18 个测试文件，202 passed / 15 skipped；Go pass |
| Neo4j mock 单测 | `npx vitest run tests/neo4j-service.test.ts tests/neo4j-service-streaming.test.ts --no-cache` | 通过 | 节点/关系、分页、续传、取消 |
| Neo4j 真机集成 | `NEO4J_INTEGRATION=1 NEO4J_INTEGRATION_PORT=27687 npx vitest run tests/neo4j.integration.test.ts --no-cache` | 通过 | 8/8；Neo4j 5.26 Bolt |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| 开发启动 | `npm run dev` | 通过 | Electron 与 `http://localhost:5173/` 正常 |
| macOS 打包 | `npm run package:mac` | 通过 | dmg/zip；打包应用启动，health ok |

## Files Changed

- `src/main/mysql-service.ts`
- `tests/mysql-service.test.ts`
- `src/main/sqlite-service.ts`
- `src/renderer/src/pages/SQLiteMigrationPanel.tsx`
- `src/renderer/src/components/ConnectionModal.tsx`
- `src/renderer/src/pages/ConnectionsPage.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `src/main/index.ts`
- `src/main/task-manager.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/shared/ipc.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `tests/sqlite-service.test.ts`
- `tests/task-manager.test.ts`
- `tests/validation.test.ts`
- `tests/connection-store.test.ts`
- `src/main/hive-service.ts`
- `src/renderer/src/pages/HiveMigrationPanel.tsx`
- `tests/hive-service.test.ts`
- `src/main/neo4j-service.ts`
- `src/renderer/src/pages/Neo4jMigrationPanel.tsx`
- `tests/neo4j-service.test.ts`
- `tests/neo4j-service-streaming.test.ts`
- `tests/neo4j.integration.test.ts`
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-016-neo4j-export.md`

## Decisions Made

- Neo4j Source 运行在 Electron 主进程，使用官方 `neo4j-driver`。
- 节点/关系按 `ORDER BY _id SKIP $offset LIMIT $batch` 稳定分页，逐行写 JSON 记录。
- 驱动取消保留 `.part`，下次从完整 JSONL 行续传。

## Blockers / Risks

- 当前无阻塞项。
- Neo4j 关系导出依赖端节点 id 作为引用，目标端仍需要自行建立映射。
- Neo4j 内部 id 在数据库重建后可能变化，长期增量迁移需要业务键稳定策略。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-016-neo4j-export.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `access-export`.

## Recommended Next Step

实施 `access-export`：确认 Access 文件读取链路（mdbtools / ODBC）、Go 子进程命令和跨平台打包策略。
