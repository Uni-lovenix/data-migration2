# Iteration 026 设计方案 -- 直连迁移与事务级回退

状态：**已实现并通过真实实例验证**（见第 0 节实施记录；第 1~12 节保留为设计依据与后续规划）

阶段：construction（构建阶段追加迭代）

范围负责人建议：Golang 后端开发（直传引擎 + 撤销日志）、桌面端开发（任务/IPC/UI）、评估者（回滚正确性校验）

---

## 0. 实施记录（2026-09-28）

### 0.1 与设计稿的偏差

- **实现落在 Electron 主进程（TypeScript），没有走 `golang/pgmigrator`。** 基线实测发现 Go 版 PG 引擎本来就是坏的：`pgmigrator export` 对 100 行只产出 1 行——`pool.Query(ctx, "COPY ... TO STDOUT WITH BINARY")` 之后 `Values()` 拿到的是整段 COPY 负载而不是源表行。该引擎在应用内**没有任何引用**，属于历史遗留 CLI。应用内 PG 导出/导入一直走 Node（`pg-query-stream` + 参数化批量写入），主进程实现可以复用同一条已上线路径，并且让"写入 + 撤销记录"处在同一个事务里，冲突检测也更精确。已把 `golang/pgmigrator direct/export` 登记为已知问题。
- **撤销日志只落在本地** `userData/tasks/<taskId>.undo.jsonl`（写前 fsync + 提交标记），设计里的"目标端日志表"（§4.1 阶段 3）未实现。
- **本期只做 PostgreSQL**。Elasticsearch 直连与回滚、严格单事务模式、模板/编排中的直连步骤都留到后续迭代；ES 侧已用真实实例（9.5.0 容器）跑通既有文件路径回归。
- **直连任务不支持断点续传**：`resume` 对已写入数据的直连任务直接拒绝，避免半截数据被追加。失败后按策略自动回滚，或由用户手动回滚后新建任务。

### 0.2 已交付

- 新任务类型 `postgres-direct` / `postgres-rollback`，复用既有 `tasks.create` IPC；`riskAck` 是 payload 必填字段，主进程用文案版本号再次校验。
- `PostgresService.directMigrateTable`：源表流式读取 -> 目标端按批次事务写入（skip：`INSERT ... ON CONFLICT DO NOTHING RETURNING md5(ROW(pk)::text), md5(x::text)`；overwrite：先 `SELECT ... FOR UPDATE` 取前映像，再 `INSERT ... ON CONFLICT (pk) DO UPDATE RETURNING`），批次提交前 fsync 撤销记录，提交后补 commit 标记。
- `PostgresService.rollbackDirectMigration`：逆序重放日志。`abort` 策略先做**只读预检**，只要存在第三方修改就整体中止、目标端不动；`skip` 策略跳过冲突行继续并计数。删除与恢复都用 `md5(ROW(主键)::text)` + `md5(行::text)` 双重匹配，幂等可重复执行。
- `TaskManager`：失败/取消按 `rollbackOn` 自动入队回滚任务；任务持久化 `rollback.state` / `journalPath` / `writtenRows` / 回滚统计；`TaskStore` 新增 `rollback` 列并自动迁移旧库。
- UI：迁移工作台新增「直连迁移」模式（目标连接/库/表、冲突策略、回滚策略、回滚冲突策略、两端预检），执行前弹出 `RiskConfirmDialog`；任务中心展示回滚状态徽标与「回滚」入口，手动回滚需要逐字输入目标表名。
- 风险文案集中在 `src/shared/risk-notices.ts`（带 `RISK_NOTICE_VERSION`），UI / REST / Agent 共享；过期版本的确认一律拒绝。

### 0.3 验证证据

| 检查 | 命令 / 方式 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（node + web） | 通过 |
| JS 全量测试 | `npm test` | 26 文件，304 passed / 20 skipped |
| PG 集成（含直连回滚） | `POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 npx vitest run tests/postgres.integration.test.ts tests/postgres-direct.integration.test.ts`（Docker `postgres:16`） | 6 passed |
| ES 集成回归 | `ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9202 npx vitest run tests/elasticsearch.integration.test.ts`（Docker ES 9.5.0） | 1 passed |
| Go 测试 / 静态检查 | `npm run test:go`、`npm run vet:go` | 通过 |
| 生产构建 | `npm run build` | 通过（out/main、out/preload、out/renderer） |
| 应用内端到端 | Electron + CDP：创建连接 -> `tasks.create(postgres-direct)` -> 目标表 60 行 -> `tasks.create(postgres-rollback)` -> 目标表 0 行 | 通过 |
| 风险门（应用内） | 不带 `riskAck` / 带过期版本调用 `tasks.create` | 均被拒绝：`riskAck 缺失…`、`风险提示内容已更新…` |
| 风险对话框 UI | Electron CDP 截图 + DOM 断言 | 对话框渲染风险条目、勾选项与文案版本号 |

### 0.4 回滚语义（实测行为）

| 场景 | 期望 | 实测 |
|---|---|---|
| skip 策略迁移后回滚 | 只删除本次写入的行 | 写入 60、跳过 40（目标原有）-> 回滚删除 60，目标保留原有 40 |
| overwrite 策略迁移后回滚 | 恢复被覆盖原值并删除新增行 | 覆盖 50、新增 50 -> 回滚恢复 50、删除 50，目标回到迁移前内容 |
| 第三方修改后回滚（abort） | 整体中止，目标端不动 | 抛出 `RollbackConflictError`，目标 100 行保持不变 |
| 第三方修改后回滚（skip） | 跳过冲突行继续 | 删除 99、冲突 1，被第三方修改的那一行保留 |
| 重复回滚 | 幂等 | 第二次回滚删除 0，无报错 |
| `rollbackOn=none` | 不写撤销日志 | 无日志文件，任务标记为不可回滚 |


## 1. 背景与现状

### 1.1 现有迁移模型

当前所有迁移都是**文件中转**两步式：

```text
源库 --export--> 本地 JSONL(.part -> 原子替换) --import--> 目标库
```

- 导出/导入各自是独立任务，通过模板步骤的 `dependsOn` 串成 export -> import。
- 写入按批次提交：ES 是每批一次 `_bulk`，PG 是每批一条多值 `INSERT`（`src/main/postgres-service.ts:insertBatch`），批次之间没有事务关联。
- 失败/取消只影响单任务状态；**目标端已写入的批次会保留**，续传靠批次边界的行游标（`resumeRows` / JSONL 物理行号 / `search_after`）。
- 证据：`docs/architecture.md`「任务与可靠性」「跨源、目标迁移矩阵」。

### 1.2 已有的 direct 能力与差距

Go 引擎里已经存在直传子命令，但只到 CLI 层：

| 位置 | 现状 |
|---|---|
| `golang/esmigrator/direct.go` | `direct` 子命令：scroll / search_after 流 -> 目标 `_bulk`，不过磁盘 |
| `golang/pgmigrator/direct.go` | `direct` 子命令：源端 COPY 流 -> 目标分批 INSERT |
| `golang/dispatcher/dispatch.go` | 透传 `direct` task 的 src/dst flag |
| `feature_list.json:direct-environment-migration` | 状态 `pass`，但证据只有 `go vet` / `go test` / `build` / `--help`，**没有真实实例端到端证据** |

四个必须先补的缺口：

1. **应用内完全不可达**：`MIGRATION_TASK_TYPES`（`src/shared/types.ts:670`）没有 direct 类型，`TaskManager`（`src/main/task-manager.ts:352` 的 switch）没有分支，没有 IPC、没有 UI。用户要跑直传只能手工敲 CLI。
2. **PG 直传路径实现存疑**：`golang/pgmigrator/direct.go:104` 用 `pool.Query(ctx, "COPY ... TO STDOUT WITH BINARY")` 再逐行 `Values()`，把 COPY 输出当成源表行流；这与 pgx 的 COPY 接口语义不匹配，实施前必须用真实实例实测，大概率要改为 `pgx` 的 `CopyTo` / `CopyFrom` 管道。同样的写法也在 `golang/pgmigrator/export.go:123`。
3. **PG 直传批次不是参数化写入**：`flushDirectBatch`（`golang/pgmigrator/direct.go:160`）用 `escapeString` 拼接 SQL 字面量，存在转义/类型正确性风险（数组、`bytea`、时间戳、含反斜杠文本）。
4. **没有任何回滚能力**：写入即提交，失败后目标端留下"迁移了一半"的数据；ES `onConflict=skip` 的跳过文档也不落账，无法区分"我写进去的"和"本来就在的"。

### 1.3 术语：迁移事务

本方案引入**迁移事务（migration transaction）**：一次直连迁移任务（一个 `taskId` / `runId`，含中途续传的所有批次）构成一个逻辑事务单元。

- 批次提交（physical commit）：保证吞吐、进度、取消与断点续传沿用现有批次边界。
- 迁移事务回滚（logical rollback）：把该任务对目标端产生的**全部**变更撤销，使目标端回到任务开始前的状态。

---

## 2. 需求与范围

### 2.1 需求解读

> 源库与目标库都在线时，数据直接从源库流转到目标库；支持事务级回退。

拆成两条可验收需求：

1. **直连迁移**：应用内可选直连模式，源库流式读取后立刻写入目标库，本地不产生中间数据文件（进度/撤销日志等控制文件除外）。
2. **事务级回退**：迁移任务失败、取消或用户主动触发时，可将该任务写入目标端的数据整体回滚，恢复迁移前状态。

### 2.2 回滚语义契约（必须显式约定）

**做**：

- 撤销本次迁移任务写入目标端的全部新增行/文档（含续传后的批次）。
- 对覆盖写（upsert / ES `index`）的行/文档，恢复其**迁移前的原值**。
- 目标表/索引是本次任务自动创建时，回滚默认连同目标对象一起删除（可配置为保留）。
- 回滚本身可重试、幂等；回滚结果给出「已回退 / 冲突跳过 / 失败」计数。

**不做**（写进已知限制，UI 明示）：

- 不回滚第三方并发写入：迁移结束后被其他程序修改过的行，回滚只做**冲突检测**，不盲目覆盖。
- 不回滚迁移窗口内的 DDL（除"本次自动创建"的对象外）。
- 不回滚源端任何内容；不做两端数据比对式修复。
- 回滚窗口期以外（日志已清理/保留期过期）无法回滚，需要预先声明保留策略。

### 2.3 本次范围

- 阶段一目标端：**PostgreSQL + Elasticsearch**（与现有 Go direct 子命令对齐，且引擎已有流式基础）。
- MySQL / SQLite / Hive / Neo4j / Access：本期只保留接口位与设计约束，不做实现。

---

## 3. 方案总览

```text
React 迁移工作台（直连模式开关 / 目标连接 / 回滚策略）
  -> window.api.postgres.directMigrate | elasticsearch.directMigrate
  -> IPC -> Electron 主进程
  -> TaskManager（新任务类型 postgres-direct / elasticsearch-direct）
  -> DirectMigrationService
       |-- 源连接 + 目标连接预检（两侧都要通）
       |-- 启动 Go 引擎子进程（pgmigrator direct / esmigrator direct）
       |-- 进度：*.go-progress.json（mode=direct，行/文档实时计数）
       `-- 取消：*.go-cancel
  -> 源库（COPY TO / scroll / search_after）
  -> 批次写入目标库（每批一个物理事务）
  -> 预写撤销日志 <taskDir>/<taskId>.undo.jsonl（写前 fsync）
  -> 回滚：RollbackService 逆序重放撤销日志（自动 / 手动）
```

关键原则：

- **不新增第二套调度**：进度、取消、依赖、并发、模板分组全部复用 `TaskManager`。
- **回滚能力下沉到写入路径**：只有写入方知道"哪些行是我写的、写之前是什么值"，日志由引擎生成，回滚执行器只做重放。
- **本地文件只保留控制数据**：JSONL 数据文件不再产生；只产生进度、取消、撤销日志。

---

## 4. 回滚策略设计

### 4.1 策略 A：严格单事务（目标端原子提交）

目标端全程持有一个事务，结束时一次 `COMMIT`：

```sql
BEGIN;
COPY target(a,b,c) FROM STDIN;   -- 或分批 INSERT，同一事务内
COMMIT;
```

- 优点：回滚 = `ROLLBACK`，语义最干净，无需日志。
- 缺点：长事务持有锁与快照、WAL 膨胀、崩溃恢复变慢；进度在提交前"不可见"；不适合大数据量。
- 仅 PG 可用，ES 无事务。

### 4.2 策略 B：分块事务 + 预写撤销日志（推荐，默认）

保持现在的批次提交节奏，每个批次是一个物理事务；批次提交**之前**先把撤销信息落盘（Write-Ahead Undo，类比 WAL）。

```text
批次 N:
  1. 读源批次
  2. 采集回滚信息（插入键 / 覆盖前映像）        <- 需要时对目标做一次受限查询
  3. 追加撤销日志记录 + fsync                    <- 必须先于提交
  4. 提交目标批次（PG: 一个事务一次 COMMIT；ES: 一次 _bulk）
  5. 追加 commit marker（记录实际写入/跳过条数）  <- 失败或崩溃时缺失
```

崩溃一致性：恢复时若某批次**有 undo 记录但没有 commit marker**，说明该批次可能已写入也可能未写入；回滚执行器按幂等语义处理（删除不存在的键是 no-op，恢复前映像前先校验当前值），因此两种结果都收敛到迁移前状态。

选 B 的理由：保持大吞吐、进度可见、取消/续传语义不变，并且 ES 只能走这条路。

### 4.3 撤销日志协议

文件：`userData/tasks/<taskId>/undo.jsonl`（append-only，逐行 fsync）。

```jsonc
// 批次预写记录（写前落盘）
{"v":1,"taskId":"...","batch":17,"target":"public.orders","mode":"insert",
 "keys":[["1001"],["1002"]],"keyFields":["id"],"capturedAt":"..."}

// 覆盖写模式额外带前映像（仅记录会被覆盖的键）
{"v":1,"taskId":"...","batch":18,"target":"public.orders","mode":"upsert",
 "keyFields":["id"],
 "preImages":[{"id":1003,"amount":10,"updated_at":"..."}],
 "fingerprint":"sha256:..."}

// 批次提交后追加
{"taskId":"...","batch":17,"committed":true,"written":1000,"skipped":0}
```

字段约定：

- `keys`：真正写入目标端的主键元组。PG 用 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 拿真实插入集；ES 取 `_bulk` 响应中 `status in (200,201)` 的 `_id`（跳过冲突/失败的条目不入账）。
- `preImages`：覆盖写时被覆盖行的原值，`keyFields` 是回滚定位键。
- `fingerprint`：对回滚键所在行的全部列（或 ES `_source`）做稳定哈希，回滚前校验，用于识别第三方修改。
- ES 额外记录 `_seq_no` / `_primary_term`，回滚写回时带 `if_seq_no` / `if_primary_term`，避免覆盖并发更新。

保留策略：成功任务默认保留日志到 `retentionDays`（默认 7 天，可配置）后清理；失败并回滚成功后立即清理；`rollbackState=none` 的任务不写日志。

### 4.4 目标端实现要点

PostgreSQL（`golang/pgmigrator`）：

- 源端改为真正的流式 COPY（`pgx` 的 `CopyTo` 或等价流式接口），目标端 `CopyFrom`；先修掉 `direct.go:104` 的 `Query + Values()` 用法。
- 插入模式：批内一个事务，`INSERT ... ON CONFLICT DO NOTHING RETURNING <pk>` 拿插入键。
- 覆盖模式：同一事务内先 `SELECT <pk>, <cols> FROM target WHERE <pk> IN (...) FOR UPDATE` 取前映像，再写入，再写日志。
- 回滚：逆序重放；插入批次 -> `DELETE ... WHERE <pk> IN (...)`；覆盖批次 -> `INSERT ... ON CONFLICT (<pk>) DO UPDATE SET ...` 恢复。
- 类型安全：批次写入改成参数化/`CopyFrom`，替换 `escapeString` 拼接路径。

Elasticsearch（`golang/esmigrator`）：

- 保持 scroll / search_after -> `_bulk` 流式直传。
- `create`（skip）模式：日志只需记录成功写入的 `_id`；回滚按 `_id` 删除。
- `index`（overwrite）模式：写入前对批内 `_id` 做 `_mget` 取前映像，写入时记录每条的 `_seq_no` / `_primary_term`。
- 回滚：逐条带 `if_seq_no` / `if_primary_term` 恢复前映像；已不存在的前映像按"跳过并报告"处理；`create` 写入的文档直接 `delete`。
- 目标索引本次自动创建时，回滚可选 `DELETE /<index>`（默认启用，配置可关）。

### 4.5 回滚执行器

- 触发方式：任务失败自动入队（`rollbackOn=failure`）、取消自动入队（`failure-or-cancel`）、用户在工作台/任务中心手动触发（新任务类型 `postgres-rollback` / `elasticsearch-rollback`）。
- 执行方式：独立任务，复用 worker pool、进度上报和取消；原任务记录 `rollbackTaskId`。
- 冲突策略：默认 `abort-on-conflict`（检测到第三方修改就停止并报告剩余批次）；可选 `skip-conflicts`（跳过被修改的行并计数）。
- 回滚完成后写入任务结论：`revertedRows` / `skippedConflicts` / `failedBatches`，并同步任务中心。

---

## 5. 接口与数据模型变更

`src/shared/types.ts`：

```ts
// 新增任务类型
'postgres-direct' | 'elasticsearch-direct' | 'postgres-rollback' | 'elasticsearch-rollback'

interface RiskAck {
  version: string          // 风险文案版本号，文案变更后旧的确认自动失效
  acknowledgedAt: string   // ISO 时间戳
  acknowledgedBy: 'ui' | 'api' | 'agent' | 'template'  // 确认来源，用于审计
}

interface DirectMigrationPayloadBase {
  dstConnectionId: string          // 源连接仍是 task.connectionId
  conflictPolicy: 'skip' | 'overwrite'
  batchSize: number
  rollbackOn: 'none' | 'manual' | 'failure' | 'failure-or-cancel'   // 默认 failure-or-cancel
  dropCreatedTarget?: boolean      // 目标由本次任务创建时，回滚是否连带删除
  riskAck: RiskAck                 // 必填：见第 8 节，缺失直接拒绝
}

interface RollbackRequest {
  taskId: string
  conflictPolicy?: 'abort-on-conflict' | 'skip-conflicts'
  riskAck: RiskAck                 // 必填；回滚属破坏性操作
}

interface PostgresDirectRequest extends DirectMigrationPayloadBase {
  srcTable: string; dstTable: string
  selectedColumns?: string[]; fieldTransforms?: FieldTransform[]
}

interface ElasticsearchDirectRequest extends DirectMigrationPayloadBase {
  srcIndex: string; dstIndex: string
  strategy?: 'scroll' | 'search_after'; concurrency?: number
  selectedColumns?: string[]; fieldTransforms?: FieldTransform[]
}
```

其他变更：

- IPC：`postgres.directMigrate` / `postgres.rollback` / `elasticsearch.directMigrate` / `elasticsearch.rollback`，配套 `IPC_CHANNELS`、preload 暴露、主进程 handler 与入参校验（`src/shared/validation.ts`）。
- `TaskManager.runTask` 增加四个 case；新增 `DirectMigrationService` 负责两侧连接预检、拼装 Go 引擎参数（复用 dispatcher `buildArgs` 的 direct 分支）。
- `TaskStore`：`tasks` 表新增 `rollback_state`、`rollback_task_id`、`undo_journal_path`、`risk_ack`（启动时按 `PRAGMA table_info` 迁移旧库，沿用 023 迭代的做法）。
- 入参校验：`src/shared/validation.ts` 校验 `riskAck` 存在、非空且 `version` 等于当前风险文案版本；缺失或过期一律拒绝创建任务。
- 模板：`TemplateAction` 增加 `'direct'`，`TemplateEngine` 沿用现有枚举；模板步骤可编排"直连迁移 + 回滚"。
- 编排 API：`/api/v1/orchestrate` 支持 direct step；Agent 工具 schema 同步新增直连工具。
- 文档：`docs/architecture.md` 新增"直连迁移与回滚"章节；`README.md` 功能列表与已知限制同步。

---

## 6. 任务状态机

```text
created -> queued -> running -> completed
                            \-> failed  --(rollbackOn 含 failure)--> rollbackState=pending -> rolling-back -> rolled-back
                            \-> canceled --(含 cancel)--------------> rollbackState=pending -> rolling-back -> rolled-back
                                                                                              \-> rollback-conflict / rollback-failed
completed --(manual rollback，二次确认)--> rollbackState=pending -> rolling-back -> rolled-back
```

`rollbackState` 取值：`none`（未启用）/ `available`（可回滚）/ `pending` / `rolling-back` / `rolled-back` / `rollback-conflict` / `rollback-failed`。应用重启后 `pending` / `rolling-back` 恢复为可继续的 `pending`（幂等重放）。

---

## 7. 一致性、续传与取消

- **续传**：直连任务失败后若选择续传，继续沿用同一 `taskId` 与同一撤销日志，回滚仍覆盖全部批次。
- **续传与回滚互斥**：任务已回滚则不允许续传；任务已续传则回滚覆盖续传后的写入。
- **取消**：批次边界取消，当前批次不提交（PG 事务回滚 / ES 批次未发出）；取消后按策略入队回滚。
- **回滚窗口**：目标端是"迁移专属写入"时结果确定；存在并发写入者时按 4.5 的冲突策略处理，UI 明示风险。
- **两端预检**：入队前对源、目标连接各跑一次轻量连通性检查，任一不通直接拒绝创建直连任务（避免"跑到一半才发现目标不可达"）。
- **批次大小**：直连模式默认沿用现有 `batchSize`，网络不稳时按 UI 提示调小；重试依赖冲突策略的幂等性（`skip` / 前映像覆盖）。

---

## 8. 执行前风险提示与确认（强制）

原则：**直连迁移与回滚都是对目标端的破坏性写入，执行前必须先向用户完整披露风险并取得显式确认。**

- 确认是操作契约的一部分，不是 UI 装饰：没有有效 `riskAck` 的请求，主进程与 REST API 一律拒绝（不依赖渲染层自觉）。
- 每一个"执行"入口都要有确认门：直连迁移入队、覆盖模式选择、自动回滚开关、手动回滚执行。
- 批量/模板/Agent 场景不得绕过：批量执行前给出**逐步骤风险汇总**再统一确认；API / Agent 调用必须在请求体里显式携带 `riskAck`。

### 8.1 三类确认门

**门 1：直连迁移入队前（普通确认）**

展示内容：

- 数据将**直接写入目标端**，本地不产生可复核的中转文件（一旦目标端写入，就没有"先看文件再决定"的机会）。
- 源库与目标库必须同时在线；网络中断会中断迁移，只能按批次续传或回滚。
- 迁移期间目标表/索引建议保持只读；第三方并发写入会导致回滚冲突或数据不一致。
- 大批量写入会占用目标库的连接、锁、WAL 与磁盘空间，可能影响目标库在线业务。
- 当前任务的回滚策略是什么（可自动回滚 / 需手动回滚 / 不记录撤销日志）。

形式：勾选「我已了解上述风险」+ 确认按钮；未勾选时确认按钮禁用。

**门 2：破坏性选项（附加确认）**

以下选项被选中时，在门 1 的文案上追加高亮警告：

- `conflictPolicy=overwrite`：「将以源数据覆盖目标端已存在的行/文档，原值只在撤销日志保留期内可恢复。」
- `rollbackOn=failure / failure-or-cancel`：「任务失败或取消时会**自动删除已写入的目标数据**，无需你再次确认。」
- `rollbackOn=none`：「不记录撤销日志，任务失败后目标端的半成品数据**无法回滚**，只能手工清理。」
- `dropCreatedTarget`：「回滚时会连同本任务创建的目标表/索引及其中的全部数据一起删除。」

**门 3：手动回滚执行前（强确认）**

- 文案必须列出：本次将被删除的行/文档数、将被覆盖恢复的行/文档数、目标对象名、该操作不可逆。
- 要求二次确认：输入目标表/索引名称（与删除仓库同级的摩擦强度），而不是只有一个"确定"按钮。
- 提示「回滚后，迁移窗口内第三方的修改不会被恢复，冲突行会被跳过并报告」。
- 若本任务创建了目标对象，单独再提示「该表/索引及其现有数据将被删除」。

### 8.2 实现要点

- 渲染层：新增 `RiskConfirmDialog` 组件，风险文案集中定义在 `src/shared/risk-notices.ts`（带 `version`），UI、API、Agent 共用同一份文案与版本号，避免三处不一致。
- IPC / REST：`riskAck.version` 与当前文案版本不一致时返回明确的"风险文案已更新，请重新确认"错误。
- 审计：确认通过后写入结构化日志（`risk_ack`，含操作类型、目标对象、任务 ID、确认来源、时间戳），任务记录持久化 `risk_ack`，事后可追溯"谁在什么时候确认了什么"。
- 任务中心对已回滚、回滚冲突、`rollbackOn=none` 的失败任务给出显式状态标注，避免用户误以为"失败=没写入任何数据"。
- 回滚完成后给出结果摘要（已回退 / 冲突跳过 / 失败），并可跳转结构化日志。

---

## 9. UI 交互

- PostgreSQL / Elasticsearch 迁移面板新增「直连迁移（不经本地文件）」开关；开启后隐藏导出目录，改为选择**目标连接** + 目标表/索引 + 冲突策略 + 回滚策略。
- 提交前展示预检结果、语义摘要（源->目标、行数估算、是否覆盖、是否自动回滚）与第 8 节的风险清单。
- 任务中心新增「回滚状态」列与「回滚本次迁移」按钮，入口只在 `rollbackState` 为 `available` / `rollback-failed` 时可用。

---

## 10. 分阶段实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| 0（前置） | 实测并修复 PG 直传流式路径（COPY 流 + 参数化写入），补真实实例端到端证据 | `pgmigrator` direct 可用 + 集成测试 |
| 1 | 直连任务接入应用：任务类型、IPC、`DirectMigrationService`、预检、进度/取消、UI 开关与风险确认门（先不带回滚） | 用户可在应用内跑通 PG/ES 直连，无中间数据文件，且执行前看到风险提示 |
| 2 | 预写撤销日志 + 回滚执行器 + 自动/手动回滚 + 任务状态与 UI | `rollbackOn` 全策略可用，插入/覆盖两类回滚正确 |
| 3（可选） | 严格单事务模式（PG，仅小数据量）+ 目标端撤销日志表（跨机器回滚） | 增强项，按需开启 |
| 4（后续） | MySQL / SQLite / Hive / Neo4j 直连与回滚 | 按目标端能力逐个评估 |

---

## 11. 测试与验收标准

功能验收：

1. PG 直连：源表 -> 目标表流式迁移，全过程不产生 JSONL 数据文件（用临时目录快照 + 进度日志证明）。
2. ES 直连：源索引 -> 目标索引 bulk 分批直传，`create` / `index` 两种冲突策略行为正确。
3. 进度实时反映行数/文档数；取消在批次边界生效；断点续传与直连兼容。
4. 回滚正确性：插入模式回滚后目标行集合与迁移前一致；覆盖模式回滚后目标行/文档内容与迁移前一致。
5. 崩溃安全：批次中途 `kill -9` 后重启，任务进入可回滚状态，回滚幂等且结果正确。
6. 冲突保护：回滚前被第三方修改的行被识别，默认不覆盖并如实报告。
7. 自动回滚策略：`failure` / `failure-or-cancel` 触发回滚任务；`manual` / `none` 不自动触发。
8. 风险提示：直连入队与手动回滚都必须先看到风险文案并显式确认；未勾选时无法提交。
9. 不可绕过：不带 `riskAck`、或 `riskAck.version` 过期的 IPC / REST / Agent 请求被拒绝（有单测覆盖）；确认记录写入审计日志与任务记录。
10. 回归：文件中转路径、模板、编排、任务并发与依赖行为不变。

验证方式：

```bash
npm run typecheck && npm test && npm run test:go && npm run vet:go && npm run build
# 真实实例（沿用现有集成测试约定）
# PostgreSQL 18.x / Elasticsearch 9.5.0 + 7.10.2
# 故障注入：kill -9、目标库中途不可达、取消与回滚并发
```

证据要求：每个回滚场景都要有"迁移前 / 迁移后 / 回滚后"三段真实数据快照对比，不接受仅单测证据。

---

## 12. 风险与待决策

| 风险 | 评级 | 缓解 |
|---|---|---|
| 覆盖模式回滚需要目标端前映像查询，吞吐下降 | 中 | 仅 `conflictPolicy=overwrite` 且启用回滚时采集；提供"不采集前映像=放弃回滚"的显式选项 |
| ES 无事务，回滚窗口内并发写入导致状态歧义 | 中 | `_seq_no` / `_primary_term` 条件写 + 冲突报告 + UI 风险提示 |
| 撤销日志本身成为写放大与磁盘占用 | 中 | 插入模式只记主键；保留期清理；日志与任务同生命周期 |
| 长事务模式（策略 A）锁表/膨胀 | 中 | 默认不启用，仅小数据量显式选择 |
| PG 直传流式路径原本未验证（见 1.2） | 高 | 作为阶段 0 前置，先修再接入 UI |
| 第三方并发写入导致回滚不完整 | 中 | 契约明示 + 冲突检测 + 默认中止报告 |
| 用户在未读风险的情况下批量/脚本化执行直连或回滚 | 中 | 后端强制 `riskAck` 校验 + 批量执行前风险汇总 + 审计日志 |

需要用户拍板的决策：

1. 回滚默认策略：默认 `failure-or-cancel` 自动回滚，还是默认 `manual`（日志始终记录，由用户手动回滚）？
2. 撤销日志位置：仅本地 `userData/tasks/<taskId>/undo.jsonl`，还是同时镜像到目标端库内的日志表（阶段 3）？
3. 回滚冲突处理：默认"检测到冲突即中止"，还是"跳过冲突行并继续"？
4. 目标端范围：本期是否只做 PostgreSQL + Elasticsearch（推荐），MySQL 等留到后续？
5. 任务成功后是否保留"撤销本次迁移"入口（保留期默认 7 天）？
