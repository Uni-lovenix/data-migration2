# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export`, `mysql-import`, `sqlite-export`, `hive-export`, and `hive-import` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-015-hive-import`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 Hive JSONL 导入、DESCRIBE 列类型映射和多值 INSERT。
- [x] 单行转换失败记录行号/列名并跳过，不阻塞同批有效行。
- [x] 完成 resumeLines 行游标、取消边界和追加语义。
- [x] Hive 工作台补齐导出/导入模式切换。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 18 个测试文件，200 passed / 15 skipped；Go pass |
| Hive 单测 | `npx vitest run tests/hive-service.test.ts --no-cache` | 通过 | 8/8；mock HiveServer2 HTTP 会话 |
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
- `docs/iterations/iteration-015-hive-import.md`

## Decisions Made

- Hive Source 运行在 Electron 主进程，默认通过 `hive-driver` 连接 HiveServer2 binary/HTTP。
- Hive 导出使用 `LIMIT/OFFSET` 分页，复杂对象序列化为 JSON 字符串。
- Hive 导入使用 `DESCRIBE` 推导列类型，批次生成多值 INSERT，错误行按行号跳过。
- `thrift@0.23.0` 的 uuid 依赖固定为 11.0.5，以满足 Electron CommonJS 加载。

## Blockers / Risks

- 当前无阻塞项。
- Hive 无内置主键，OFFSET 续传在并发写入或查询结果不稳定时可能跳行/重复。
- 未连接真实 HiveServer2；协议测试使用 mock 会话，生产接入前应做一次真实 Hive 集群验证。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-015-hive-import.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `neo4j-export`.

## Recommended Next Step

实施 `neo4j-export`：复用 `neo4j-driver` 服务与批次 JSONL，补齐 Connect/Neo4j UI 和真机/模拟验证。
