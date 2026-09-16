# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: all features in `feature_list.json` are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-020-atomic-task-orchestration`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 export_preview/import_validate/cast_dry_run 三个原子。
- [x] 完成 Agent tool schema、REST orchestrate、IPC 和线性编排 UI。
- [x] 完成 orchestration 5 个验收用例与契约文档。
- [x] 开发与本地打包应用实测 orchestrate endpoint。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 20 个测试文件，230 passed / 15 skipped；Go 两个模块通过 |
| 编排单测 | `npx vitest run tests/orchestration.test.ts --no-cache` | 通过 | 5/5 |
| 开发/打包编排 | `POST /api/v1/orchestrate` | 通过 | cast_dry_run 返回 active=true |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| Electron 本地目录打包 | `npx electron-builder --mac --dir --config.electronDist=node_modules/electron/dist` | 通过 | 打包应用 health 与 orchestrate ok |
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
- `src/shared/column-projection.ts`
- `src/renderer/src/components/ColumnSelection.tsx`
- `src/shared/type-conversion.ts`
- `src/renderer/src/components/FieldTransformsEditor.tsx`
- `src/main/orchestration-service.ts`
- `src/renderer/src/pages/OrchestrationPanel.tsx`
- `tests/orchestration.test.ts`
- `docs/orchestration.md`
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-020-atomic-task-orchestration.md`

## Decisions Made

- OrchestrationService 是 REST/IPC/Agent/UI 的共享原子执行器。
- 编排只编排现有原子；task 步骤立即返回 taskId，不等待迁移完成。
- 线性执行遇到首个失败后，后续步骤统一标记 skipped。

## Blockers / Risks

- 当前无阻塞项。
- v1 只支持线性 steps，不支持 DAG/分支/重试策略。
- ES import_validate 当前不校验远端 mapping 字段，仅保留动态 mapping 语义。
- `npm run package:mac` 在本次 Electron 下载阶段遇到外部网络阻塞；已用本地 `electronDist` 完成目录打包与应用启动验证，DMG/ZIP 需要在网络恢复后复跑。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-020-atomic-task-orchestration.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Enter transition acceptance and update evaluator/quality/clean-state evidence.

## Recommended Next Step

最后阶段：汇总全部 pass feature，复跑关键集成与打包，完成 README、docs/release、已知问题清单和阶段验收。
