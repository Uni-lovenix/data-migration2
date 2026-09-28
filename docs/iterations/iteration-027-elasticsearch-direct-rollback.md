# Iteration 027 -- Elasticsearch 直连迁移与事务级回退

状态：**已实现并通过真实实例验证**

阶段：construction（承接 iteration-026 的 PostgreSQL 直连与回滚）

---

## 1. 目标

把 iteration-026 的直连迁移与事务级回退补齐到 Elasticsearch：

- 源索引与目标索引同时在线时，文档不经本地文件中转，直接 bulk 写入目标索引。
- 一次直连任务作为逻辑事务，失败/取消可按策略整体回滚，或由用户手动回滚。
- 继续沿用 iteration-026 的强制风险确认（同一份文案与版本号）。

## 2. 与 PostgreSQL 的关键差异

Elasticsearch 没有事务：`_bulk` 一旦返回，写入即提交。因此无法做到 PostgreSQL 那样"先落盘撤销记录再提交"，改为**两段式撤销日志**：

```text
批次 N:
  1. 读源批次（scroll / search_after）
  2. 覆盖写模式下先 _mget 取前映像（含 _seq_no / _primary_term）
  3. 追加 pending 计划（含文档 _id、routing、前映像）  <- 写前落盘
  4. POST /_bulk 写入目标（create = 跳过已存在 / index = 覆盖）
  5. 追加 batch-result（每条文档的 state/rowHash/_seq_no/_primary_term）
```

- 崩溃时"有 pending、无 batch-result"的批次视为**状态未知**：`abort` 策略整体中止回滚，`skip` 策略跳过并计数。绝不删除无法确认来源的文档。
- 回滚用 `_seq_no` / `_primary_term` 条件写（`if_seq_no` / `if_primary_term`）：文档被第三方改动过，bulk 会返回 409，计入冲突。
- 回滚前先 `_refresh` 目标索引，避免刚写入但尚未可见的文档被误判成"被第三方修改"。
- 文档已不存在（上次回滚已删或第三方删除）视为"已完成"，不算冲突——保证重复回滚幂等。

## 3. 实现

- `src/shared/types.ts`：新增任务类型 `elasticsearch-direct` / `elasticsearch-rollback`，payload `ElasticsearchDirectRequest`（源/目标连接、索引、批量大小、冲突策略、回滚策略、读取方式、查询、riskAck）与 `ElasticsearchRollbackRequest`。
- `src/shared/validation.ts`：`validateElasticsearchDirectRequest` / `validateElasticsearchRollbackRequest`，与 PostgreSQL 共用同一套 `riskAck` 校验（版本号不匹配即拒绝）。
- `src/main/undo-journal.ts`：批次记录新增 `engine` 与 `docs`（文档级计划），新增 `batch-result` 记录；`readUndoJournal` 一并返回结果映射。
- `src/main/elasticsearch-service.ts`：
  - `directMigrateIndex`：目标索引存在性预检 -> scroll / search_after 读源 -> 覆盖模式取前映像 -> 写前 pending -> `_bulk` -> 结果落盘；`skip` 模式统计被跳过的冲突文档。
  - `rollbackDirectMigration`：逆序重放；`abort` 先只读预检（含状态未知批次），`skip` 跳过冲突继续；批量删除/恢复均带 seq 守卫。
- `src/main/task-manager.ts`：`elasticsearch-direct` / `elasticsearch-rollback` 分支；失败/取消按策略自动入队回滚任务；`TaskManagerOptions.elasticsearchDirect` 注入 Node 版 ES 服务（文件中转路径仍由 Go 引擎负责）。
- UI：Elasticsearch 迁移面板新增「直连迁移」模式（目标连接/索引、冲突策略、回滚策略、回滚冲突策略、读取方式、查询、两端预检），执行前弹出风险确认；任务中心复活徽标与「回滚」入口对 ES 任务同样生效（强确认需输入目标索引名）。

## 4. 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | skip 直连写入后可整体回滚 | PASS（45 篇 -> 回滚删除 45 -> 0） |
| 2 | 只回滚本次写入 | PASS（目标原有 10 篇保留，只删本次写入的 20 篇） |
| 3 | 覆盖模式恢复前映像 | PASS（恢复 12 篇原值 + 删除新增 18 篇） |
| 4 | 第三方修改检测 | PASS（abort 整体中止；skip 跳过 1 篇、删除 19 篇） |
| 5 | 状态未知批次保护 | PASS（pending 无结果 -> abort 中止、skip 跳过，不误删） |
| 6 | 重复回滚幂等 | PASS（第二次删除 0、无报错） |
| 7 | `rollbackOn=none` 不写日志 | PASS |
| 8 | 目标索引不存在时快速失败 | PASS（`目标索引不存在`） |
| 9 | 风险确认不可绕过 | PASS（缺 riskAck、旧版本 riskAck 均被主进程拒绝） |
| 10 | 应用内端到端 | PASS（Electron + CDP：写 40 篇 -> 回滚 -> 0 篇；风险对话框含真实索引名） |

## 5. 验证命令与结果

```bash
npm run typecheck                      # PASS（node + web）
npm test                               # PASS：26 文件，307 passed / 27 skipped
npm run test:go && npm run vet:go      # PASS
npm run build                          # PASS

# 真实实例（Docker）
POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 \
ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9202 \
npx vitest run tests/postgres.integration.test.ts tests/postgres-direct.integration.test.ts \
  tests/elasticsearch.integration.test.ts tests/elasticsearch-direct.integration.test.ts
# PASS：4 文件 / 14 用例
```

新增 `tests/elasticsearch-direct.integration.test.ts`（7 个用例，对 Elasticsearch 9.5.0 容器连跑 3 次稳定），并在 `tests/validation.test.ts`、`tests/task-manager.test.ts` 覆盖 ES 直连的风险门、策略枚举与自动回滚编排。

## 6. 已知限制

- 目标索引必须已存在（直连不自动建索引）；源文档必须有 `_id`，否则拒绝迁移。
- 直连任务不支持断点续传（与 PostgreSQL 直连一致）。
- 撤销日志为本地文件 `userData/tasks/<taskId>.undo.jsonl`，删除后无法回滚。
- `search_after` 模式使用 PIT，需要 Elasticsearch 7.10.2 及以上（与导出路径一致）。
- 回滚采用逐批次 bulk，冲突批次按策略中止或跳过；`rolling-back` 中途崩溃需要重新触发回滚（幂等）。
