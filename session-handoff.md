# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `mysql-export`, `mysql-import`, `sqlite-export`, `hive-export`, `hive-import`, `neo4j-export`, and `access-export` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-017-access-export`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 Access 文件连接、表列表、CSV→JSONL 批次和密码参数。
- [x] 完成 `resume-rows`、progress/cancel 控制文件和 TaskManager 接入。
- [x] 完成 GoAccessService 子进程、IPC、preload、连接管理与 Access 工作台。
- [x] 验证 macOS 打包应用中 accessmigrator 可被定位，开发与生产构建通过。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 18 个测试文件，205 passed / 15 skipped；Go 两个模块通过 |
| Access Go 单测 | `cd golang/accessmigrator && go test ./...` | 通过 | list/export/resume/cancel |
| Go vet | `npm run vet:go` | 通过 | esmigrator + accessmigrator |
| Windows Go 交叉编译 | `npm run build:go:win` | 通过 | 两个 `.exe` 产出 |
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
- `golang/accessmigrator/go.mod`
- `golang/accessmigrator/main.go`
- `golang/accessmigrator/service.go`
- `golang/accessmigrator/export.go`
- `golang/accessmigrator/progress.go`
- `golang/accessmigrator/main_test.go`
- `src/main/go-access-service.ts`
- `src/renderer/src/pages/AccessMigrationPanel.tsx`
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-017-access-export.md`

## Decisions Made

- Access Source 使用 Go 子进程调用 mdbtools，Electron 只管理控制文件和进度。
- 导出按 CSV header 建立列，按 batchSize 写批次 JSONL；resume 跳过已处理数据行。
- 取消保留 `.part`，普通错误删除 `.part`。

## Blockers / Risks

- 当前无阻塞项。
- 当前宿主机未安装 `mdbtools`，真实 `.mdb/.accdb` 集成尚未运行；运行环境必须安装并加入 PATH。
- `.accdb` 支持取决于 mdbtools/ODBC 版本，必要时后续补 ODBC adapter。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-017-access-export.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `import-field-selection`.

## Recommended Next Step

实施 `import-field-selection`：先扩展共享 DTO/校验，再逐条接入 PG、MySQL、Elasticsearch、Hive Sink 和 UI。
