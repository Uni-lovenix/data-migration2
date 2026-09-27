# Iteration 025 -- 按导入数据类型生成 schema / mapping

## 目标

导入时根据导入数据的实际类型自动推断列与类型，生成目标端定义（SQL 的 CREATE TABLE DDL、Elasticsearch 的 mappings），目标不存在时据此建表/建索引再写入；定义可在 UI 中人工重定义。

## 范围

- 新增共享推断核心：扫描 JSONL 样本（含批次信封），推断列名、逻辑类型、可空性。
- 生成目标端定义：PostgreSQL / MySQL / Hive 的 CREATE TABLE，Elasticsearch 的 mappings。
- 新增 `schema:infer` IPC 与 `window.api.schema.infer`，供各导入面板调用。
- 导入请求新增可选 `createTable` / `tableDefinition`；结果新增 `tableCreated`。
- UI：PostgreSQL / Hive 导入目标表改为可自定义名称（含不存在的表）+ 已有表 datalist；MySQL 补齐建表能力；四个导入面板新增自动创建开关、生成按钮与可编辑定义框；Elasticsearch 自定义 JSON 模式新增「根据导入数据生成 Mapping」。

## 实现

- `src/shared/schema-inference.ts`：
  - `inferValueType` / `mergeLogicalTypes`：布尔、整数、bigint、浮点、日期时间、字符串、JSON 的保守推断与提升；不兼容混排回退字符串。
  - `inferSchemaFromRecords`：按首次出现排序、可空性（缺失或 null 记为可空）。
  - `generateTargetDefinition`：PostgreSQL/MySQL/Hive DDL 与 Elasticsearch mapping 生成；标识符按引擎转义。
  - Elasticsearch 记录先取 `_source` 再推断。
- `src/shared/types.ts`：`SchemaInferenceEngine`、`InferredColumn`、`SchemaInferenceRequest/Result`；`Postgres/MySQL/HiveImportRequest` 增加 `createTable` / `tableDefinition`，结果增加 `tableCreated`。
- `src/shared/validation.ts`：`validateSchemaInferenceRequest`；`validateTableCreation` 统一校验三个 SQL 导入的建表字段。
- `src/main/index.ts`：`schema:infer` 处理器流式读取样本（不超过 64MB / 40000 行）后调用推断。
- 服务层：PostgreSQL `tableExists` + `CREATE SCHEMA IF NOT EXISTS` + DDL；MySQL `mysqlTableExists` + DDL；Hive `DESCRIBE` 失败时按 DDL 建表。仅当 `createTable=true` 且目标不存在时执行，未启用时保持既有行为。

## 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | 按导入数据类型推断列与逻辑类型 | PASS |
| 2 | 生成 PostgreSQL/MySQL/Hive DDL 与 ES mapping | PASS |
| 3 | 目标不存在时按定义创建再导入 | PASS |
| 4 | 定义可人工重定义（生成后编辑） | PASS |
| 5 | 未启用 createTable 时保持原语义 | PASS |

## 验证证据

| 检查 | 命令 / 方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node + web |
| JS 测试 | `npm test` | 通过 | 26 文件，294 passed / 15 skipped |
| Go 测试 | `npm run test:go` | 通过 | esmigrator + accessmigrator |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| PG 端到端 | 应用 IPC：schema.infer + postgres-import（createTable） | 通过 | 真实 PG 18.3：按类型建表并写入 2 行，jsonb 值保留 |
| ES 端到端 | 应用 IPC：schema.infer + elasticsearch-import（inline mapping） | 通过 | 真实 ES 9.5.0：按生成 mapping 建索引并写入 2 行 |
| 界面 | Electron CDP | 通过 | PG 目标表自定义输入、生成按钮、DDL 编辑框；MySQL 建表开关渲染正常 |

## 风险 / 备注

- 类型推断基于样本（默认 1000 条），与全量数据不一致时以样本为准；定义可人工重定义规避。
- 字符串列默认 text（ES 为 text + keyword 子字段），如需精确匹配或全文可人工调整定义。
- MySQL / Hive 本次未做真实数据库端到端验证（环境无可用实例），以单元测试（注入 fake client/session）覆盖建表分支。
- 建表 DDL 由用户可编辑并直接执行，等价于执行用户提供的 SQL；使用前需确认定义安全。
