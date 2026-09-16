# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export`, `mysql-import`, and `sqlite-export` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-013-sqlite-export`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 SQLite 连接、文件选择、表/列/行数浏览和单表/多表 JSONL 导出。
- [x] 使用 better-sqlite3 `iterate()` + `OFFSET` 实现批次导出、续传和取消边界。
- [x] 将 SQLite 原生 prebuild 纳入 electron-builder 并解包。
- [x] macOS dmg/zip 打包应用启动成功，REST health 返回 ok。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 17 个测试文件，187 passed / 15 skipped；Go pass |
| SQLite 单测 | `npx vitest run tests/sqlite-service.test.ts --no-cache` | 通过 | 4/4；真实临时 SQLite 文件 |
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
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-013-sqlite-export.md`

## Decisions Made

- SQLite Source 运行在 Electron 主进程，使用 `better-sqlite3` 只读连接。
- 导出使用 `iterate()`、主键或 rowid 排序和 `OFFSET` 续传，数据格式与 PG/MySQL 共用。
- `better-sqlite3` 使用 N-API 平台 prebuild，打包时保留并解包 `.node`。

## Blockers / Risks

- 当前无阻塞项。
- SQLite 无主键表依赖 rowid 排序；没有 rowid 的特殊虚拟表暂不支持续传。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-013-sqlite-export.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `hive-export`.

## Recommended Next Step

实施 `hive-export`：先确定 HiveServer2 HTTP 契约，再实现 list/count/export、批次 JSONL、续传、取消和 UI/IPC 接线。
