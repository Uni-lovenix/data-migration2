# Session Handoff -- 数据迁移工具

## Latest Work (2026-09-23)

- Fixed Agent hallucinations for read-only current-state questions: task/connection/template/LLM queries are now executed by the main process first, recorded as real tool calls/results, and rendered from authoritative data instead of trusting a small model to decide whether to query.
- Task queries now include local-timezone today-created/today-started counts, template/error context, and a deterministic response path; correction phrases re-query the most recent relevant domain.
- Reproduced the report from persisted sessions: three assistant answers had no tool messages while the task database contained nine tasks created that day; the nonexistent task ID `2521` was model-generated.
- Task center now groups template-created tasks by a persisted per-run `runId`, shows the template name/time, orders rows by step number, and supports per-group plus collapse-all/expand-all controls; legacy dependency chains are matched to template step signatures for their display name.
- Template execution now navigates to the task center, making queued/running/failed task state immediately visible.
- Confirmed the reported 3-step template did create three MySQL export tasks; the first failed with `ECONNREFUSED 127.0.0.1:24506`, and dependent steps then failed as designed.
- Added a bounded task worker pool with default concurrency 4 and FIFO scheduling for ready tasks.
- Added persisted `dependsOn` task metadata; template steps form a dependency chain so export/import order is preserved.
- Verified parallel limit, serial mode, failure isolation, dependency success/failure, old task-store migration, typecheck, tests, and production build.

## Previous Fix (2026-09-21)

- Added `scripts/create-es-indices.mjs` and `npm run es:create-test-indices` for creating 100 repeat-safe Elasticsearch test indices.
- Executed the script against Elasticsearch 9.5.0 at `127.0.0.1:9202`: 100 indices created and verified `open green`; a second run skipped existing indices.
- Elasticsearch migration now shows all matching indices in an aligned, scrollable list instead of a single-value select.
- Verified that `products_copy` and `products` are visible together for `prod`, and selecting either row updates the index details.
- Verified with `npm run typecheck`, `npm test` (252 passed / 15 skipped), `npm run build`, and an Electron CDP screenshot/interaction check against Elasticsearch 9.5.0.
- New-connection type selection now uses a dropdown.
- Creating a connection from a filtered connection type prefills that type and its default port in the modal.
- Verified with `npm run typecheck`, `npm test`, `npm run build`, and Playwright UI checks.

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `task-parallel-execution` is now `pass`.
- Current phase: construction.
- Current iteration: `iteration-023-task-parallel-execution`.
- Branch: `feature/postgresql-migration`.

## Completed This Session

- [x] Elasticsearch Go 导入支持 MySQL / SQLite / Access / Hive 批次信封。
- [x] Elasticsearch 导入读取目标 mapping，并对字符串字段执行默认 JSON 兜底。
- [x] PostgreSQL / MySQL / Hive 目标类型检查和转换错误补齐行号、字段、源类型、目标类型。
- [x] `import_validate` 对 Elasticsearch 读取 mapping 并校验目标字段。
- [x] 模板引擎覆盖 PostgreSQL、Elasticsearch、MySQL、SQLite、Hive、Neo4j、Access。
- [x] 新增跨源 PostgreSQL Sink 矩阵和 Go Elasticsearch 批次导入验证。
- [x] Elasticsearch 加载索引后支持按索引名称实时搜索筛选。
- [x] 后台任务默认并行执行，独立任务不再受单并发队列限制。
- [x] 多步骤模板通过持久化依赖保持 export -> import 顺序。
- [x] 模板执行任务按 runId 分组，任务中心可识别同一批次和步骤顺序。
- [x] 模板任务组可折叠，历史依赖链优先显示匹配到的模板名称。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node + web |
| JS 全量测试 | `npm test` | 通过 | 25 个测试文件，271 passed / 15 skipped |
| Go 测试 | `npm run test:go` | 通过 | esmigrator + accessmigrator |
| Go 静态检查 | `npm run vet:go` | 通过 | 两个模块 |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| 开发启动 | `npm run dev` | 通过 | `http://localhost:5173/` 与 REST health |
| 跨源矩阵 | `npx vitest run tests/cross-source-target.test.ts --no-cache` | 通过 | 五种源格式到 PostgreSQL |
| ES Go 导入 | `go test ./...`（golang/esmigrator） | 通过 | 批次、投影、转换、mapping |
| ES 索引搜索 | Electron CDP 实际交互 | 通过 | 输入 `prod` 后 2 个匹配索引同时显示并可切换 |

## Files Changed

- `golang/esmigrator/import.go`
- `golang/esmigrator/main_test.go`
- `src/shared/types.ts`
- `src/shared/type-conversion.ts`
- `src/shared/template-examples.ts`
- `src/shared/template-from-tasks.ts`
- `src/main/template-utils.ts`
- `src/main/orchestration-service.ts`
- `src/renderer/src/pages/TemplatesPage.tsx`
- `tests/cross-source-target.test.ts`
- `tests/type-conversion.test.ts`
- `tests/orchestration.test.ts`
- `tests/template-utils.test.ts`
- `tests/template-from-tasks.test.ts`
- `docs/architecture.md`
- `docs/iterations/iteration-021-cross-source-target-migration.md`
- `feature_list.json`
- `progress.md`
- `quality-document.md`
- `evaluator-rubric.md`
- `AGENTS.team.md`
- `docs/PROCESS.md`
- `src/main/llm-store.ts`
- `tests/llm-store-encryption.test.ts`
- `docs/iterations/iteration-022-llm-keystore-prefix.md`
- `src/renderer/src/pages/ElasticsearchMigrationPanel.tsx`
- `scripts/create-es-indices.mjs`
- `README.md`
- `package.json`
- `src/main/task-manager.ts`
- `src/main/task-store.ts`
- `src/main/agent-service.ts`
- `tests/agent-service-grounding.test.ts`
- `src/main/index.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `tests/task-manager.test.ts`
- `tests/task-store.test.ts`
- `tests/validation.test.ts`
- `docs/iterations/iteration-023-task-parallel-execution.md`
- `docs/architecture.md`
- `docs/release.md`
- `golang/esmigrator/README.md`
- `src/renderer/src/pages/TemplatesPage.tsx`
- `src/renderer/src/App.tsx`
- `src/shared/task-groups.ts`
- `src/renderer/src/pages/TasksPage.tsx`
- `src/renderer/src/styles.css`
- `src/main/template-utils.ts`

## Decisions Made

- JSONL 行边界是导入批次和续传游标的统一边界；一个批次信封必须整体提交后才推进续传行号。
- Elasticsearch 目标类型来自目标 mapping；显式 `fieldTransforms` 优先，复杂值落到字符串字段时默认 JSON 字符串化。
- 模板模型扩展到所有连接引擎，跨源迁移通过 Source 导出步骤和 Sink 导入步骤串联。

## Blockers / Risks

- 当前无阻塞项。
- Elasticsearch 动态 mapping 字段在首次导入前不可预知，`import_validate` 只能校验已存在字段。
- Hive 导入保持追加语义，不支持 upsert。
- Access 导出仍依赖运行环境安装 `mdbtools`。
- 任务并发度目前由 `TaskManager` 构造参数配置，UI 尚未提供运行时修改。
- 多个 ES 任务的内部并发度会叠加，需要按集群容量约束任务并发度和单任务 `concurrency`。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review `docs/iterations/iteration-023-task-parallel-execution.md`.
3. Run `npm run check` and `npm run build`.
4. Enter transition acceptance and complete final delivery evidence.

## Recommended Next Step

执行移交阶段最终验收：复跑关键真实集成与打包，汇总 README、发布说明和已知问题清单。
