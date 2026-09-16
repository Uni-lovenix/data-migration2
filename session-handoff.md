# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export`, `mysql-import`, `sqlite-export`, and `hive-export` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-014-hive-export`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 Hive connection fields、HiveServer2 binary/HTTP transport 和协议 adapter。
- [x] 完成数据库/表/行数浏览、LIMIT/OFFSET JSONL 导出、复杂值转换、续传和取消。
- [x] 接入 IPC、TaskManager、connection UI 与 Hive migration panel。
- [x] 修复 thrift/uuid ESM 兼容并完成开发与打包应用启动验证。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 18 个测试文件，195 passed / 15 skipped；Go pass |
| Hive 单测 | `npx vitest run tests/hive-service.test.ts tests/task-manager.test.ts --no-cache` | 通过 | mock HiveServer2 HTTP 会话 |
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
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-014-hive-export.md`

## Decisions Made

- Hive Source 运行在 Electron 主进程，默认通过 `hive-driver` 连接 HiveServer2 binary/HTTP。
- Hive 导出使用 `LIMIT/OFFSET` 分页，复杂对象序列化为 JSON 字符串。
- `thrift@0.23.0` 的 uuid 依赖固定为 11.0.5，以满足 Electron CommonJS 加载。

## Blockers / Risks

- 当前无阻塞项。
- Hive 无内置主键，OFFSET 续传在并发写入或查询结果不稳定时可能跳行/重复。
- 未连接真实 HiveServer2；协议测试使用 mock 会话，生产接入前应做一次真实 Hive 集群验证。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-014-hive-export.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `hive-import`.

## Recommended Next Step

实施 `hive-import`：复用 HiveServer2 session adapter，增加批量 `INSERT INTO ... VALUES`、字段映射、类型转换错误行跳过和行游标续传。
