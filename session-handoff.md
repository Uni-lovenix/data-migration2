# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export` and `mysql-import` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-012-mysql-import`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 MySQL JSONL 导入、三种冲突策略、列缺失诊断、续传和取消。
- [x] 将同一批次展开为单条多值 `INSERT`，超过 60000 个参数时自动分块。
- [x] 验证 `error` / `skip` / `update` SQL 语义和已提交行边界上的取消行为。
- [x] 完成真实 MySQL 8.0.46 冲突、缺列和闭环集成验证。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | 0 errors |
| MySQL 单测 | `npx vitest run tests/mysql-service.test.ts --no-cache` | 通过 | 15/15 |
| MySQL 真机集成 | `MYSQL_INTEGRATION=1 MYSQL_INTEGRATION_PORT=23406 npx vitest run tests/mysql-import.integration.test.ts --no-cache` | 通过 | 4/4；真实 MySQL 8.0.46 |

## Files Changed

- `src/main/mysql-service.ts`
- `tests/mysql-service.test.ts`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/iterations/iteration-012-mysql-import.md`

## Decisions Made

- MySQL Sink 运行在 Electron 主进程，使用 `mysql2`，与 PostgreSQL Node Connector 对齐。
- 批次信封展开后使用多值 `INSERT`，并按 60000 参数上限分块。
- 只有写入成功后才推进导入行数和 JSONL 行游标。

## Blockers / Risks

- 当前无阻塞项。
- `update` 策略会覆盖冲突行的全部输入列，当前不提供部分列更新掩码。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-012-mysql-import.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `sqlite-export`.

## Recommended Next Step

实施 `sqlite-export`：使用 `better-sqlite3` 迭代读取、批次 JSONL、`.part` 续传、取消，并接入连接管理和迁移工作台。
