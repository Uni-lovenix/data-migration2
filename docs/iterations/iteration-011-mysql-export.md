# 迭代协议 011：MySQL 数据导出

## 迭代目标

让用户从连接管理到迁移工作台完成 MySQL 表数据导出，输出与 PostgreSQL 导入路径兼容的流式 JSONL，并支持大数据量下的进度、取消和断点续传。

## 迭代范围

- ConnectionConfig / ConnectionInput 支持 MySQL 连接字段与可选 CA、客户端证书。
- MySQLService 提供 `testConnection` / `listDatabases` / `listTables` / `countRows` / `exportTable` / `exportTables`。
- 单表和多表导出使用 mysql2 流式游标，按 `batchSize` 写 JSONL 批次信封。
- 使用 `.part` 临时文件，实现取消后保留进度和按已写行数续传。
- IPC、TaskManager 和 MigrationPage 接入 MySQL 导出任务。
- 单元测试覆盖连接、元数据、流式导出、续传、取消和批量导出。
- 使用真实 MySQL 8 完成集成验证。

## 实施计划

1. 扩展共享连接与 MySQL DTO，并补充校验器。
2. 实现 MySQLService 与 mysql2 驱动抽象，保证测试可注入 fake client。
3. 接入 IPC、preload、TaskManager 任务类型和迁移 UI。
4. 补齐单元测试与可选 Docker 集成测试。
5. 运行类型检查、完整测试、生产构建和桌面启动冒烟。

## 交付物

- `src/main/mysql-service.ts`
- `src/shared/types.ts` / `src/shared/validation.ts`
- `src/shared/ipc.ts` / `src/preload/index.ts`
- `src/main/task-manager.ts` / `src/main/index.ts`
- `src/renderer/src/pages/MySQLMigrationPanel.tsx` / `MigrationPage.tsx`
- `tests/mysql-service.test.ts` / `tests/mysql.integration.test.ts`

## 退出标准与验证

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 连接配置与测试错误可读 | PASS | MySQL 连接表单支持 host/port/user/password/database/ssl/ca/cert；错误保留 errno，并区分 ECONNREFUSED、Unknown database、Access denied |
| 数据库、表、行数预览 | PASS | MySQLService 单元测试与真实 MySQL 8 集成测试覆盖 |
| 流式 JSONL 与 PG 格式兼容 | PASS | `{table, columns, rows}` 批次信封；真实导出 100 行得到 40/40/20 三批 |
| 断点续传 | PASS | `ORDER BY` 主键 + `LIMIT/OFFSET`；取消后从 80 行续传到 100 行 |
| 取消 | PASS | TaskCancelledError 停止游标并保留 `.part`，不产出半成品正式文件 |
| 多表与 UI 接入 | PASS | 多表每表一个 JSONL；MigrationPage 提供连接、数据库、表多选、batch-size 和导出目标选择 |
| 自动化验证 | PASS | `npm run check` 与 `npm run build` 通过；真实 MySQL 集成测试 2/2 通过 |
| 桌面运行 | PASS | `npm run dev` 启动 Electron，`http://localhost:5173/` 返回 DataMigrator 页面 |

## 验证命令

```bash
npm run check
npm run build
MYSQL_INTEGRATION_DSN='mysql://root:root@127.0.0.1:24506/dm_test' \
  npx vitest run tests/mysql.integration.test.ts --no-cache
npm run dev
```

## 已知缺口

- Elasticsearch 导入目前识别 ES 专用 `_id` / `_source` 信封；MySQL JSONL 直接导入 PostgreSQL，导入 Elasticsearch 仍需后续信封适配。
- 未配置主键的表通过 OFFSET 续传时，源表并发写入可能造成跳行或重复；这是 MySQL 无稳定排序键时的已知限制。
