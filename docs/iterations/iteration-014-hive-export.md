# Iteration 014 -- Hive 数据导出

## 目标

通过 HiveServer2 binary/HTTP transport 浏览 Hive 元数据并导出表数据到统一 JSONL。

## 范围

- Hive connection fields：auth、transport mode、HTTP path。
- HiveServer2 driver adapter、数据库/表/行数查询。
- `LIMIT/OFFSET` 分页、复杂类型 JSON 字符串化、`.part` 续传和取消。
- IPC、preload、TaskManager、连接管理和迁移面板。

## 实现

- `HiveService` 以可注入 session factory 隔离协议层，默认实现使用 `hive-driver`。
- HTTP transport 使用 `/cliservice`，认证支持 NONE/LDAP/KERBEROS/CUSTOM 配置选择。
- 导出每页执行 `SELECT * FROM db.table LIMIT n OFFSET m`，写入 `{table, columns, rows}`。
- ARRAY/MAP/STRUCT/UNION 对象值使用 `JSON.stringify`，标量原样保留。
- 取消在已写入页边界触发；续传按已写行数继续 offset，并追加到 `.part`。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | Hive ConnectionConfig 字段 | PASS |
| 2 | listDatabases/listTables/countRows | PASS |
| 3 | 分页 JSONL 与复杂类型转换 | PASS |
| 4 | 行数续传与并发写入风险记录 | PASS |
| 5 | 批次边界取消 | PASS |
| 6 | HTTP/Thrift 连接诊断与 UI | PASS |
| 7 | mock HiveServer2 HTTP 协议测试 | PASS |

## 验证

```bash
npm run check
npx vitest run tests/hive-service.test.ts tests/task-manager.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 统一检查：18 个测试文件，195 passed / 15 skipped，Go 测试通过。
- Hive 单测：5/5 通过。
- 开发与打包应用启动成功；打包应用 REST health 返回 `{"status":"ok"}`。

## 已知限制

- 未连接真实 HiveServer2 集群；当前验证使用协议 mock，生产接入前需要真实环境复验。
- OFFSET 续传在并发写入时可能跳行或重复。
- Kerberos 需要用户在环境中额外安装 `kerberos` 可选依赖。
