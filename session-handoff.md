# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `type-conversion-pipeline` is now `pass`; only `atomic-task-orchestration` remains.
- Current phase: construction.
- Current iteration: `iteration-019-type-conversion-pipeline`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成共享 fieldTransforms 类型、校验和转换引擎。
- [x] 完成 PG/MySQL/Hive/ES 四类 Sink 的转换接入。
- [x] 完成字段转换 UI、模板示例和往返测试。
- [x] 真实 Elasticsearch 验证 int→boolean cast。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 19 个测试文件，225 passed / 15 skipped；Go 两个模块通过 |
| 类型转换单测 | `npx vitest run tests/type-conversion.test.ts --no-cache` | 通过 | 8/8 |
| ES 真机转换 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 npx vitest run tests/elasticsearch.integration.test.ts --no-cache` | 通过 | int→boolean + selectedColumns |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| macOS 打包 | `npm run package:mac` | 通过 | 打包应用 health ok |
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
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-019-type-conversion-pipeline.md`

## Decisions Made

- fieldTransforms 与 selectedColumns 可组合，先投影源字段再转换。
- PG/MySQL/Hive 使用目标列类型做默认 JSON 兜底；ES 使用显式规则。
- 转换发生在批次写入前，续传游标仍按物理 JSONL 行推进。

## Blockers / Risks

- 当前无阻塞项。
- 转换当前按顶层字段匹配，嵌套字段路径未实现。
- ES Go 路径默认 JSON 规则依赖显式字段 transform，不查询远端 mapping 推导类型。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-019-type-conversion-pipeline.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the final feature from `feature_list.json`: `atomic-task-orchestration`.

## Recommended Next Step

实施 `atomic-task-orchestration`：补 export preview、import validate、cast dry-run、REST orchestrate、Agent tools 和线性编排 UI。
