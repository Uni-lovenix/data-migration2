# Iteration 023 -- 后台任务并行执行

## 目标

把 Electron 主进程任务队列从单任务串行升级为有界 worker pool，在提高大批量任务吞吐的同时保持模板步骤顺序、取消和断点续传语义。

## 范围

- `TaskManager` 默认并发运行 4 个任务，并允许通过构造参数调整并发度。
- 就绪任务按 FIFO 顺序启动；并发上限满时保持 `queued`。
- 单个任务失败或取消不阻塞其他独立任务。
- `CreateMigrationTaskInput.dependsOn` 和 `MigrationTask.dependsOn` 提供持久化依赖。
- 多步骤模板按步骤建立依赖链，确保 export 完成后才启动 import。
- `TaskStore` 为已有 `tasks.db` 自动补齐 `depends_on` 列。

## 实现

- `src/main/task-manager.ts`：
  - 用 `activeCount` 和 `pumpQueue()` 实现有界 worker pool。
  - `dequeueReadyTask()` 跳过依赖未完成的任务，允许后续独立任务先运行。
  - 依赖失败或不存在时，依赖任务标记为 `failed`，不会调用迁移服务。
  - 任务完成、失败、取消后释放槽位并继续调度。
- `src/main/task-store.ts`：
  - `tasks` 表新增 `depends_on TEXT`，启动时用 `PRAGMA table_info` 检测并迁移旧库。
  - 插入、更新、恢复都读写 `dependsOn`。
- `src/main/index.ts`：模板执行时为每一步引用前一步任务 ID。
- `src/shared/types.ts` / `src/shared/validation.ts`：
  - 增加 `dependsOn?: string[]`。
  - 校验依赖数组、空 ID 和重复 ID。

## 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | 默认最多同时运行 4 个任务 | PASS |
| 2 | 并发上限满时任务保持排队，空出槽位后按 FIFO 启动 | PASS |
| 3 | 并发度为 1 时保持原有串行行为 | PASS |
| 4 | 一个任务失败后其他独立任务继续执行 | PASS |
| 5 | 依赖任务完成后才启动，依赖失败时不执行 | PASS |
| 6 | 模板 export -> import 依赖关系跨任务持久化 | PASS |
| 7 | 旧版 tasks.db 可自动增加依赖列 | PASS |

## 验证

```bash
npx vitest run tests/task-manager.test.ts tests/task-store.test.ts tests/validation.test.ts --no-cache
npm run typecheck
npm test
npm run build
```

- 定向测试：3 个文件，62 passed。
- 全量 vitest：24 个测试文件，269 passed / 15 skipped。
- typecheck：node + web 均为 0 errors。
- electron-vite build：产出 out/main、out/preload、out/renderer。

## 已知限制

- 任务并发度目前由 `TaskManager` 构造参数配置，UI 暂不提供运行时修改。
- 运行中的多个 ES 任务会叠加各自 `concurrency` 的请求数；需要同时约束任务并发度和单任务并发度。
- 应用重启时，原 `queued` / `running` 任务仍统一恢复为 `paused`，需要用户手动继续；依赖关系会保留。
