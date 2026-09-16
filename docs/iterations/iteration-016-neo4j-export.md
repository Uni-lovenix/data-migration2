# Iteration 016 -- Neo4j 数据导出

## 目标

将 Neo4j 节点和关系按稳定分页导出为逐行 JSON，并完成桌面端接入。

## 范围

- Neo4j ConnectionConfig、Bolt URI、认证和 database。
- label/relationship type 浏览、数量统计。
- 节点/关系逐行 JSONL。
- `SKIP $offset LIMIT $batch` 分页、`.part` 续传和取消。
- IPC、TaskManager、连接管理与 Neo4j 迁移工作台。

## 实现

- `Neo4jService` 使用官方 `neo4j-driver`，测试通过 factory 注入 fake driver。
- 节点记录：`{_id,_labels,properties}`；关系记录：`{_id,_type,_src,_dst,properties}`。
- Cypher 固定 `ORDER BY _id`，续传按完整 JSONL 行数继续 offset。
- `.part` 尾部残行在续传前截断；驱动取消保留 `.part`，其他错误清理临时文件。
- Temporal、Point、Integer 等值在 Source 层归一化为 JSON 兼容类型。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | Neo4j ConnectionConfig / URI | PASS |
| 2 | label/relationship type 浏览与计数 | PASS |
| 3 | 节点逐行 JSONL | PASS |
| 4 | 关系逐行 JSONL | PASS |
| 5 | 行数续传 | PASS |
| 6 | 批次边界取消 | PASS |
| 7 | 官方 neo4j-driver | PASS |
| 8 | mock 与 Docker 集成测试 | PASS |

## 验证

```bash
npm run check
npx vitest run tests/neo4j-service.test.ts tests/neo4j-service-streaming.test.ts --no-cache
NEO4J_INTEGRATION=1 NEO4J_INTEGRATION_PORT=27687 \
  npx vitest run tests/neo4j.integration.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 全量测试：202 passed / 15 skipped。
- 真实 Neo4j 5.26 Bolt 集成：8/8 通过。
- 开发与打包应用启动成功；REST health 返回 `{"status":"ok"}`。

## 已知限制

- 导出的关系使用 Neo4j 内部节点 id 作为端点引用；目标端需要配套的 id 映射。
- Neo4j 内部 id 不保证跨数据库重建稳定，长期增量迁移应使用业务键。
