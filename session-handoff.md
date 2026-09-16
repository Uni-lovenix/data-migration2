# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: through `import-field-selection`, all source connectors and field projection are now `pass`.
- Current phase: construction.
- Current iteration: `iteration-018-import-field-selection`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] 完成 PG/MySQL/ES/Hive 的 selectedColumns DTO 与共享校验。
- [x] 完成四类 Sink 的记录投影和缺失字段拒绝。
- [x] 完成通用 JSONL 字段多选组件和模板示例。
- [x] 真实 Elasticsearch 验证未选字段从 `_source` 剥离。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 统一检查 | `npm run check` | 通过 | 18 个测试文件，216 passed / 15 skipped；Go 两个模块通过 |
| ES 真机投影 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 npx vitest run tests/elasticsearch.integration.test.ts --no-cache` | 通过 | 目标 `_source` 仅保留 name |
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
- `package.json`
- `package-lock.json`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`
- `quality-document.md`
- `docs/architecture.md`
- `docs/iterations/iteration-018-import-field-selection.md`

## Decisions Made

- selectedColumns 是导入侧通用投影契约；缺失/空数组等价于全列。
- PG/MySQL/Hive 在 JSONL 行展开后投影，ES 在 `_source` 层投影。
- 投影发生在批次内，续传游标仍按物理 JSONL 行推进。

## Blockers / Risks

- 当前无阻塞项。
- 当前投影按顶层字段名匹配，嵌套字段路径需要后续类型转换/路径系统支持。
- UI 字段列表读取第一条 JSONL 记录；后续行字段不一致时由 Sink 在运行时拒绝。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review this handoff and `docs/iterations/iteration-018-import-field-selection.md`.
3. Run `bash init.sh`, `npm run check`, and `npm run build`.
4. Start the next feature from `feature_list.json`; the next dependency-ready item is `type-conversion-pipeline`.

## Recommended Next Step

实施 `type-conversion-pipeline`：建立共享 transform 契约与 8 类转换规则，再接入四类 Sink、模板和 UI。
