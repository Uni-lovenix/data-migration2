# 迭代协议 010：PostgreSQL 导出 SQL WHERE 过滤

## 迭代目标

让用户在不离开迁移工作台的前提下，仅导出满足特定条件的 PostgreSQL 行（最近 N 天、某种状态、某个租户等），而不用在源库新建临时表或视图。对齐 Elasticsearch 工作台已有的"查询条件"交互模式。

## 迭代范围

- `PostgresExportRequest` / `PostgresBatchExportRequest` 增加 `where?: string`（谓词片段，无 `WHERE` 关键字）。
- 新增 `validateWhereClause`：空 → 丢弃；包含 `;` / `--` → 拒绝；trim 后长度 > 4000 → 拒绝；其余原样通过。
- `PostgresService.exportTable` 在初始与续传两条路径上都把 WHERE 拼接在 FROM 之后（续传在 ORDER BY 之前）；schema/table 标识符继续走 `escapeIdentifier`。
- `exportTables` 把 batch 的 where 透传给每个 `exportTable` 调用。
- 迁移工作台（MigrationPage.tsx）导出模式下显示 SQL 条件 textarea，连接/数据库切换时清空；提交时 trim 后条件性包含。
- `exampleConfigJson('pgmigrator', 'export')` 在模板示例中加 `where` 行，模板往返测试覆盖。
- 单元测试：8 个 validator 用例 + 2 个 service 用例 + 1 个 template-utils 用例。

## 实施计划

1. 在 `src/shared/types.ts` 为两个导出 DTO 加 `where?: string` 字段。
2. 在 `src/shared/validation.ts` 新增 `validateWhereClause` 辅助函数，接到 `validatePostgresExportRequest` 与 `validatePostgresBatchExportRequest`。
3. 修改 `src/main/postgres-service.ts`：新增 `selectAllFromQualified` 辅助函数；让 `exportTable` 在初始与续传两条路径上都拼 WHERE；让 `buildResumeExportQuery` 接收 `where` 参数并把它放在 FROM 之后、ORDER BY 之前；让 `exportTables` 把 `where` 透传给每个 `exportTable` 调用。
4. 修改 `src/renderer/src/pages/MigrationPage.tsx`：新增 `whereClause` 状态、`handleStart` 拼到两个 payload、新增 textarea（在导出模式渲染，复用 `code-textarea`）。
5. 修改 `src/shared/template-examples.ts`：在 pgmigrator 导出示例中加 `where` 行。
6. 补充单元测试：`tests/validation.test.ts`（8 个用例）、`tests/postgres-service.test.ts`（2 个用例）、`tests/template-utils.test.ts`（1 个用例）。
7. 更新 `feature_list.json`、`progress.md` 和本迭代文档。

## 交付物

- DTO 字段 + 校验器。
- SQL 拼接在初始与续传两条路径上都生效。
- 迁移工作台 UI 增加 SQL 条件 textarea。
- 模板示例包含 `where`。
- `npm run typecheck` 与 `npm test` 通过。
- `feature_list.json`、`progress.md`、本迭代文档已更新。

## 退出标准

- 类型检查无错误。
- 单元测试通过（新增 11 个用例）。
- 模板往返测试覆盖 `where`。
- 在真实 PostgreSQL 上做一次手动冒烟：单表带 WHERE、单表不带、批量带 WHERE、连接/数据库切换清空、模板运行。

## 已知缺口（后续迭代）

- `countRows` 不接受 WHERE：UI 上表列表的行数徽章仍显示未过滤的全表行数。后续迭代可补：把 `where` 透传到 `PostgresCountRowsRequest`。
- Resume + WHERE 修改语义：若用户在初始与续传之间修改 WHERE，OFFSET 游标可能对应不同的行集。后续迭代可考虑把 WHERE 写入 cursor 并在 resume 时校验一致性。
- Go `pgmigrator` 引擎同步：当前 PG 导出走 Node `PostgresService`，Go 引擎未被主进程调用。当 `golang-postgresql-migration` 切换为生产路径时，需在 Go 引擎也加 `--where` flag 与 COPY/SELECT 拼接逻辑。
