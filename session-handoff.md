# Session Handoff -- 数据迁移工具

## Current Objective

- Goal: 1. 支持postgresql的数据导出和导入
2. 支持elasticsearch的数据导出和导入
3. 支持elasticsearch 7.10.2版本及以上
4. 支持大数据量大导出和导入
5. 支持多个数据库的配置
6. 桌面版应用，支持mac/windows平台
- Current status: Elasticsearch 导出/导入迭代已完成，等待评估者验收；下一步大数据量任务与可靠性。
- Branch: `feature/elasticsearch-migration`

## Completed This Session

- [x] 迭代协议 003：Elasticsearch 迁移。
- [x] Elasticsearch 连接测试、索引/映射浏览。
- [x] scroll 与 search_after（PIT）两种 JSONL 流式导出。
- [x] bulk 分批导入，支持 `index` 覆盖与 `create` 跳过冲突。
- [x] PostgreSQL/Elasticsearch 双引擎迁移工作台 UI 与安全 IPC。
- [x] 27 个单元测试用例、生产构建和真实 Elasticsearch 7.10.2 集成测试。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node 与 web 两套 tsconfig 均无错误 |
| 单元测试 | `npm test` | 通过 | 4 个文件、27 个用例，另有 2 个集成用例默认跳过 |
| 生产构建 | `npm run build` | 通过 | 产出 main/preload/renderer |
| ES 集成测试 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 npx vitest run tests/elasticsearch.integration.test.ts` | 通过 | Docker Elasticsearch 7.10.2，100 文档 scroll/search_after 导出与 bulk 导入闭环 |
| ES 9 集成测试 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=19200 npx vitest run tests/elasticsearch.integration.test.ts` | 通过 | Docker Elasticsearch 9.5.0，同一套集成用例通过 |
| 开发启动 | `npm run dev` | 通过 | Electron 窗口与 Vite 渲染服务 |

## Files Changed

- `src/shared/ipc.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/main/elasticsearch-service.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `src/renderer/src/pages/ElasticsearchMigrationPanel.tsx`
- `tests/elasticsearch-service.test.ts`
- `tests/elasticsearch.integration.test.ts`
- `tests/validation.test.ts`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/PROCESS.md`
- `docs/iterations/iteration-003-elasticsearch-migration.md`
- `AGENTS.team.md`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`

## Decisions Made

- Elasticsearch 迁移引擎放在 Electron 主进程，使用 Node HTTP 客户端直接调用 REST API。
- ES 导出 JSONL 每行保存 `_id` / `_routing` / `_source` 信封。
- ES 导入默认使用 `create` 跳过已存在文档，用户可切换 `index` 覆盖。
- search_after 使用 PIT + `_doc` 排序；HTTP 请求显式设置 `Content-Length`，兼容 7.10.2。
- 迁移操作只接收已保存连接 ID，文件路径由主进程原生对话框产生。

## Blockers / Risks

- 当前无已知 blocker。
- search_after 已在 Elasticsearch 7.10.2 与 9.5.0 上完成真实集群验证；如需可再补 8.x 一版。
- 当前没有任务队列和进度事件，长任务在 UI 上会阻塞到完成；大数据量可靠性由后续迭代处理。

## Next Session Startup

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read `feature_list.json` and `progress.md`.
3. Review this handoff.
4. Run `bash init.sh` before editing.
5. 在 `feature/elasticsearch-migration` 基础上开始 `large-data-migration`。

## Recommended Next Step

选择 `large-data-migration`，按 RUP 迭代协议实现后台任务队列、进度上报、取消、断点续传、SQLite 状态存储和结构化日志。
