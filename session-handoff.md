# Session Handoff -- 数据迁移工具

## Current Objective

- Source of truth: `feature_list.json`
- Completed this session: `llm-keystore-prefix` is now `pass`.
- Current phase: construction.
- Current iteration: `iteration-022-llm-keystore-prefix`.
- Branch: `feature/llm-keystore-prefix`.

## Completed This Session

- [x] Elasticsearch Go 导入支持 MySQL / SQLite / Access / Hive 批次信封。
- [x] Elasticsearch 导入读取目标 mapping，并对字符串字段执行默认 JSON 兜底。
- [x] PostgreSQL / MySQL / Hive 目标类型检查和转换错误补齐行号、字段、源类型、目标类型。
- [x] `import_validate` 对 Elasticsearch 读取 mapping 并校验目标字段。
- [x] 模板引擎覆盖 PostgreSQL、Elasticsearch、MySQL、SQLite、Hive、Neo4j、Access。
- [x] 新增跨源 PostgreSQL Sink 矩阵和 Go Elasticsearch 批次导入验证。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node + web |
| JS 全量测试 | `npm test` | 通过 | 21 个测试文件，241 passed / 15 skipped |
| Go 测试 | `npm run test:go` | 通过 | esmigrator + accessmigrator |
| Go 静态检查 | `npm run vet:go` | 通过 | 两个模块 |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| 开发启动 | `npm run dev` | 通过 | `http://localhost:5173/` 与 REST health |
| 跨源矩阵 | `npx vitest run tests/cross-source-target.test.ts --no-cache` | 通过 | 五种源格式到 PostgreSQL |
| ES Go 导入 | `go test ./...`（golang/esmigrator） | 通过 | 批次、投影、转换、mapping |

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

## Decisions Made

- JSONL 行边界是导入批次和续传游标的统一边界；一个批次信封必须整体提交后才推进续传行号。
- Elasticsearch 目标类型来自目标 mapping；显式 `fieldTransforms` 优先，复杂值落到字符串字段时默认 JSON 字符串化。
- 模板模型扩展到所有连接引擎，跨源迁移通过 Source 导出步骤和 Sink 导入步骤串联。

## Blockers / Risks

- 当前无阻塞项。
- Elasticsearch 动态 mapping 字段在首次导入前不可预知，`import_validate` 只能校验已存在字段。
- Hive 导入保持追加语义，不支持 upsert。
- Access 导出仍依赖运行环境安装 `mdbtools`。

## Next Session Startup

1. Read `AGENTS.md`, `AGENTS.team.md`, `feature_list.json`, and `progress.md`.
2. Review `docs/iterations/iteration-021-cross-source-target-migration.md`.
3. Run `npm run check` and `npm run build`.
4. Enter transition acceptance and complete final delivery evidence.

## Recommended Next Step

执行移交阶段最终验收：复跑关键真实集成与打包，汇总 README、发布说明和已知问题清单。
