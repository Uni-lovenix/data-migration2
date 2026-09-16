# Iteration 012 -- MySQL 数据导入

## 目标

完成 JSONL 到 MySQL 的批次导入闭环，与 PostgreSQL/Elasticsearch Sink 的进度、续传和取消协议对齐。

## 范围

- 批次信封与逐行 JSONL 归一化。
- 多值 `INSERT` 和 60000 参数自动分块。
- `error` / `skip` / `update` 三种冲突策略。
- 目标列校验、生成列排除、续传行游标和取消边界。
- IPC、preload、TaskManager 与 MySQL 导入 UI 接线。

## 实现

- `MySQLService.importJsonl` 复用 `expandJsonlRecord` 展开 `{table, columns, rows}`，也兼容逐行对象。
- 同一批次通过单条多值 `INSERT ... VALUES (...), (...)` 写入，超过参数上限时继续分块。
- `onConflict=skip` 使用 `INSERT IGNORE`；`update` 使用 `ON DUPLICATE KEY UPDATE`；`error` 保留数据库原生冲突错误。
- 缺失列在写库前抛出包含列名和 JSONL 行号的错误。
- 每批写入成功后才推进行数和 `lines` 游标；取消在已提交批次边界停止。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | `MySQLService` 接收完整导入请求 | PASS |
| 2 | 多值批量 INSERT 与三种冲突策略 | PASS |
| 3 | JSONL 列映射及缺列诊断 | PASS |
| 4 | JSONL 行游标续传 | PASS |
| 5 | 已提交批次边界取消 | PASS |
| 6 | 单元测试覆盖基本导入、冲突、缺列、续传 | PASS |

## 验证

```bash
npm run typecheck
npx vitest run tests/mysql-service.test.ts --no-cache
MYSQL_INTEGRATION=1 MYSQL_INTEGRATION_PORT=23406 \
  npx vitest run tests/mysql-import.integration.test.ts --no-cache
```

- 类型检查：0 errors。
- 单元测试：15/15 通过。
- 真实 MySQL 8.0.46 集成测试：4/4 通过。

## 已知限制

- `update` 覆盖冲突行的全部输入列，不提供部分列更新掩码。
- 真机集成测试的端口和密码通过当前 Docker fixture 环境指定。
