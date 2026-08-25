# Session Handoff -- 数据迁移工具

## Current Objective

- Goal: 1. 支持postgresql的数据导出和导入
2. 支持elasticsearch的数据导出和导入
3. 支持elasticsearch 7.10.2版本及以上
4. 支持大数据量大导出和导入
5. 支持多个数据库的配置
6. 桌面版应用，支持mac/windows平台
- Current status: PostgreSQL 导出/导入迭代已完成，等待评估者验收；下一步 Elasticsearch 迁移。
- Branch: `feature/postgresql-migration`（仓库尚无提交，所有文件均为未跟踪状态）

## Completed This Session

- [x] 迭代 002：PostgreSQL 连接测试、表/字段浏览。
- [x] 使用 `pg-query-stream` 流式导出 JSONL，使用批量参数化 `INSERT` 导入。
- [x] PostgreSQL 迁移工作台 UI 与安全 IPC。
- [x] 原生文件选择对话框与共享请求校验。
- [x] 17 个单元测试用例、生产构建和开发启动验证。
- [x] Docker PostgreSQL 16 集成测试：导出 100 行并导入目标表。

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node 与 web 两套 tsconfig 均无错误 |
| 单元测试 | `npm test` | 通过 | 3 个文件、17 个用例，另有 1 个集成用例默认跳过 |
| 生产构建 | `npm run build` | 通过 | 产出 main/preload/renderer |
| 集成测试 | `POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 npx vitest run tests/postgres.integration.test.ts` | 通过 | Docker PostgreSQL 16，100 行导出/导入闭环 |
| 开发启动 | `npm run dev` | 通过 | Electron 窗口与 Vite 渲染服务启动成功 |

## Files Changed

- `package.json` / `package-lock.json`
- `src/shared/ipc.ts`
- `src/shared/types.ts`
- `src/shared/validation.ts`
- `src/main/connection-store.ts`
- `src/main/postgres-service.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/pages/MigrationPage.tsx`
- `src/renderer/src/styles.css`
- `tests/postgres-service.test.ts`
- `tests/postgres.integration.test.ts`
- `tests/validation.test.ts`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/PROCESS.md`
- `docs/iterations/iteration-002-postgresql-migration.md`
- `AGENTS.team.md`
- `feature_list.json`
- `progress.md`
- `session-handoff.md`

## Decisions Made

- PostgreSQL 迁移引擎先放在 Electron 主进程，使用 `pg` 与 `pg-query-stream`；大数据量场景需要时再评估 Go 服务。
- 导出文件格式为 JSONL，每行一个 JSON 对象。
- 导入使用批量参数化 `INSERT`，默认 `ON CONFLICT DO NOTHING`，对象/数组列序列化为 JSON 字符串。
- 迁移操作只接收已保存连接 ID，文件路径由主进程原生对话框产生。

## Blockers / Risks

- 当前无已知 blocker。
- 当前没有任务队列和进度事件，长任务在 UI 上会阻塞到完成；大数据量可靠性由后续迭代处理。

## Next Session Startup

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read `feature_list.json` and `progress.md`.
3. Review this handoff.
4. Run `bash init.sh` before editing.
5. 在 `feature/postgresql-migration` 基础上开始 `elasticsearch-migration`。

## Recommended Next Step

选择 `elasticsearch-migration`，按 RUP 迭代协议实现 Elasticsearch 7.10.2+ 的索引浏览、scroll/search_after 导出与 bulk 导入。
