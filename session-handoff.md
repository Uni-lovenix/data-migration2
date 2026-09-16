# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export` is now `pass`.
- Current phase: construction.
- Current iteration: `iteration-011-mysql-export`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 MySQL 连接、数据库/表/行数浏览、单表流式导出和批量多表导出。
- [x] 使用 mysql2 显式游标按 `batchSize` 写 JSONL `{table, columns, rows}` 批次信封。
- [x] 使用 `.part` + 主键 `ORDER BY` + `LIMIT/OFFSET` 实现取消与续传。
- [x] 接入 `ConnectionModal`、`MigrationPage`、IPC、preload 和 TaskManager。
- [x] 补齐 MySQL 导出单元测试与真实 MySQL 8.0.46 集成测试。
- [x] 修复并行工作树遗留的 Neo4j/MySQL 导入共享类型检查噪声，恢复全局 typecheck/build。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | typecheck 0 errors；177 passed / 15 skipped；Go esmigrator pass |
| MySQL 单测 | `npx vitest run tests/mysql-service.test.ts` | 通过 | 14/14 |
| MySQL 真机集成 | `MYSQL_INTEGRATION_DSN='mysql://root:root@127.0.0.1:24506/dm_test' npx vitest run tests/mysql.integration.test.ts --no-cache` | 通过 | MySQL 8.0.46，2/2；100 行导出、取消、续传、批量导出 |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| 桌面启动 | `npm run dev` | 通过 | Electron 启动，`http://localhost:5173/` 可访问 |

## Files Changed

- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/renderer/src/pages/TasksPage.tsx`
- `tests/mysql-import.integration.test.ts`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `docs/iterations/iteration-011-mysql-export.md`

MySQL 导出实现文件还包括：

- `src/main/mysql-service.ts`
- `src/main/task-manager.ts`
- `src/main/index.ts`
- `src/shared/ipc.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/pages/MySQLMigrationPanel.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `tests/mysql-service.test.ts`
- `tests/mysql.integration.test.ts`

## Decisions Made

- MySQL Source Connector 运行在 Electron 主进程，使用 `mysql2`，与 PostgreSQL Node Connector 对齐。
- MySQL 没有独立 schema，JSONL 信封的 `table.schema` 承载 database 名。
- 导出先写 `.part`，成功后再原子 rename；取消保留 `.part`，任务游标按已写入行数续传。
- BIGINT 使用字符串传输，避免 JavaScript Number 精度损失。

## Blockers / Risks

- 当前无阻塞项。
- 无主键表的 OFFSET 续传在源表并发写入时可能跳行或重复，已记录为已知限制。
- MySQL JSONL 可直接导入 PostgreSQL；导入 Elasticsearch 前仍需后续信封适配。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-011-mysql-export.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `mysql-import`.

## Recommended Next Step

对 `mysql-import` 做独立验收：核对 JSONL 列映射、冲突策略、续传游标和真实 MySQL 8 闭环，然后更新 `feature_list.json` 与交接证据。
