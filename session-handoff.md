# Session Handoff -- 数据迁移工具

## Current Objective

- Goal: 1. 支持postgresql的数据导出和导入
2. 支持elasticsearch的数据导出和导入
3. 支持elasticsearch 7.10.2版本及以上
4. 支持大数据量大导出和导入
5. 支持多个数据库的配置
6. 桌面版应用，支持mac/windows平台
- Current status: Go 引擎 Elasticsearch 导出/导入已实现，等待真实 ES 集成验证与最终验收。
- Branch: `feature/desktop-packaging`

## Completed This Session

- [x] 迭代协议 005：桌面端打包与交付。
- [x] electron-builder 配置：asar、sql.js WASM 解包、macOS dmg/zip、Windows NSIS。
- [x] README 与发布文档。
- [x] GitHub Actions macOS/Windows 双平台打包工作流。
- [x] 本机 macOS dmg/zip 打包与打包后应用启动验证。
- [x] PostgreSQL 导出支持连接后自动同步表列表、多选表导出到目录，并接入多表导出任务与断点续传。
- [x] PostgreSQL 迁移支持数据库下拉选择，切换数据库后同步表列表并带入导出/导入任务。
- [x] PostgreSQL 数据库下拉支持拉取服务器全部数据库，包含模板库。
- [x] 新增 `start.sh` 本地启动脚本，自动安装依赖并运行 `npm run dev`。
- [x] 表列表支持后台 `count(1)` 精确行数刷新，统计中显示 `...`，空表显示 `0`。
- [x] 修复选择数据库后白屏风险：增加渲染层错误边界、数据库加载兜底，以及大表列表搜索与渲染上限。
- [x] 新增 `golang/esmigrator` 独立 Go 引擎，实现 scroll / search_after 流式导出与 bulk 分批导入。
- [x] Electron 主进程新增 `GoElasticsearchService`，通过子进程、进度文件和取消标记接入任务队列。
- [x] 新增 Go 构建/交叉编译脚本，Go 二进制通过 `extraResources` 打入 `go-bin`。
- [x] Go 单元测试覆盖 scroll 导出、search_after 续传、bulk 冲突跳过和取消。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node 与 web 两套 tsconfig 均无错误 |
| 单元测试 | `npm test` | 通过 | 7 个文件、44 个用例，另有 2 个集成用例默认跳过 |
| 生产构建 | `npm run build` | 通过 | 产出 main/preload/renderer |
| ES 集成测试 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 npx vitest run tests/elasticsearch.integration.test.ts` | 通过 | Docker Elasticsearch 7.10.2，100 文档 scroll/search_after 导出与 bulk 导入闭环 |
| PostgreSQL 集成测试 | `POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 npx vitest run tests/postgres.integration.test.ts` | 通过 | Docker PostgreSQL 16，100 行导出/导入闭环 |
| PostgreSQL 多表导出集成测试 | `POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 npx vitest run tests/postgres.integration.test.ts` | 通过 | 两张表导出到目录，分别生成 JSONL |
| 开发启动 | `npm run dev` | 通过 | Electron 窗口与 Vite 渲染服务 |
| Go 单元测试 | `npm run test:go` | 通过 | scroll、search_after 续传、bulk 冲突跳过、取消 |
| Go 静态检查 | `npm run vet:go` | 通过 | go vet 无错误 |
| Go 交叉编译 | `npm run build:go:win` | 通过 | 产出 Windows x64 esmigrator.exe |
| Go 真实 ES 集成 | Go 引擎直连 Elasticsearch 7.10.2 | 通过 | scroll 导出 5 行，bulk 导入后重复导入 5 行全部 409 跳过 |
| macOS 打包 | `npm run package:mac` | 通过 | 产出 dmg/zip，打包后 .app 启动成功 |
| Windows 打包 | `.github/workflows/build.yml` | 可复跑 | 在 windows-latest 上执行 npm run package；本机无 wine 未直接执行 |

## Files Changed

- `src/shared/ipc.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/main/elasticsearch-service.ts`
- `src/main/go-elasticsearch-service.ts`
- `src/main/task-manager.ts`
- `src/main/task-store.ts`
- `src/main/task-errors.ts`
- `src/main/logger.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/pages/TasksPage.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `src/renderer/src/pages/ElasticsearchMigrationPanel.tsx`
- `src/renderer/src/styles.css`
- `tests/elasticsearch-service.test.ts`
- `tests/elasticsearch.integration.test.ts`
- `tests/postgres-service.test.ts`
- `tests/task-manager.test.ts`
- `tests/task-store.test.ts`
- `tests/logger.test.ts`
- `tests/validation.test.ts`
- `package.json` / `package-lock.json`
- `scripts/build-go.mjs`
- `golang/esmigrator/`
- `.github/workflows/build.yml`
- `docs/iterations/iteration-004-large-data-migration.md`
- `README.md`
- `docs/release.md`
- `.github/workflows/build.yml`
- `docs/iterations/iteration-005-desktop-packaging.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/PROCESS.md`
- `docs/iterations/iteration-003-elasticsearch-migration.md`
- `AGENTS.team.md`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`

## Decisions Made

- macOS 与 Windows 使用同一套 electron-builder 配置，产物命名包含版本、平台和架构。
- `sql.js` WASM 通过 `asarUnpack` 保留为独立文件，避免 asar 内读取异常。
- Windows NSIS 打包交由 CI 执行；本机 macOS 只验证 dmg/zip。
- Elasticsearch 导出/导入由 Go 子进程执行；PostgreSQL 仍使用主进程 Node 驱动。

## Blockers / Risks

- 当前无已知 blocker。
- Windows NSIS 安装流程尚未在本机执行，依赖 CI 验证。
- 应用未配置代码签名，正式分发前需要 Apple Developer ID 与 Windows 代码签名证书。

## Next Session Startup

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read `feature_list.json` and `progress.md`.
3. Review this handoff.
4. Run `bash init.sh` before editing.
5. 先运行 `npm run check` 和 `npm run test:go` 验证 Go 引擎基线。
6. Go 引擎已在 Elasticsearch 7.10.2 上完成集成验证，待补充 9.5.0 验证。

## Recommended Next Step

对 Go 引擎执行真实 Elasticsearch 集成验证，再由评估者按 `evaluator-rubric.md` 和 `clean-state-checklist.md` 完成最终验收；正式发布前在 GitHub Actions 跑通双平台打包并登记签名/发布事项。
