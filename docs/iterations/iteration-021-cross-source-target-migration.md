# Iteration 021 -- 多源导出与多目标指定字段导入

## 目标

把已经分别实现的数据源、Sink、字段投影和类型转换能力贯通为可验证的跨源/目标迁移闭环。

## 范围

- MySQL / SQLite / Access / Hive 批次信封与 Neo4j 逐行格式进入四类 Sink。
- Elasticsearch Go 导入补齐批次展开、字段投影和目标 mapping 感知。
- 目标类型默认转换与行级错误诊断。
- 模板引擎覆盖全部源端和目标端。
- Elasticsearch import validate 读取 target mapping。
- 跨源矩阵、Go 导入和构建验证。

## 实现

- `golang/esmigrator` 导入解析支持 `{table, columns, rows}`，并保持同一物理 JSONL 行在取消边界统一提交，避免续传跳行。
- Go 导入读取目标索引 mapping；对象或数组落到字符串字段时默认 JSON 字符串化。
- `transformRecord` 统一识别 PostgreSQL `character varying` 等目标类型，并在显式 cast 或目标类型校验失败时返回行号、字段、源类型和目标类型。
- `OrchestrationService.importValidate` 对 Elasticsearch 查询目标 mapping 并校验列。
- 模板引擎扩展到 PostgreSQL、Elasticsearch、MySQL、SQLite、Hive、Neo4j、Access；Task 页面生成模板不再拒绝新源/目标。
- `selectedColumns`、`fieldTransforms` 和 cross-source target table 继续随 payload 持久化，模板与原子任务均复用相同字段。

## 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | 五种源格式可被 Sink 识别 | PASS |
| 2 | 四类目标支持目标表/索引和 selectedColumns | PASS |
| 3 | 读取目标类型并执行默认/显式转换 | PASS |
| 4 | 转换错误包含行号、字段、源/目标类型 | PASS |
| 5 | 每种源格式到 PostgreSQL 闭环，ES/Hive 关键路径 | PASS |
| 6 | 工作台、模板、原子 API 配置贯通 | PASS |

## 验证

```bash
npm run typecheck
npm test
npm run test:go
npm run vet:go
npm run build
```

- TypeScript：21 个测试文件通过，241 passed / 15 skipped。
- Go：`esmigrator` 与 `accessmigrator` 测试通过，`go vet` 通过。
- 新增 `tests/cross-source-target.test.ts`：MySQL、SQLite、Access、Hive 批次信封及 Neo4j 节点记录到 PostgreSQL 的闭环通过。
- Go 新增批次信封投影/mapping 测试：复杂对象按 text 字段 JSON 字符串化，数组 cast 到带分隔符文本，投影列生效。

## 已知限制

- Elasticsearch `import:validate` 以 mapping 字段路径为准；动态 mapping 字段在首次导入前不可预知。
- Hive 仍为追加语义，没有 upsert。
- Access 导出依赖运行环境安装 `mdbtools`。
