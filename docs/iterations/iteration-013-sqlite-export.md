# Iteration 013 -- SQLite 数据导出

## 目标

从本地 SQLite 数据库文件流式导出表数据到统一 JSONL，并接入桌面端连接管理、任务队列和打包交付。

## 范围

- `sqlite` ConnectionConfig、绝对文件路径校验和系统文件选择器。
- 表、列和精确行数浏览。
- `better-sqlite3` 只读迭代导出、单表/多表 JSONL、`.part` 续传和取消。
- IPC、preload、TaskManager、MigrationPage 和原生模块打包。

## 实现

- SQLite 连接在存储层使用 `filePath`，并同步保存到 `host` 以复用现有连接列表与搜索。
- `SQLiteService` 使用 `pragma_table_xinfo` 获取列，主键优先排序，无主键回退 `rowid`。
- 每批写入 `{table, columns, rows}` 信封；续传使用 `LIMIT -1 OFFSET n` 并追加 `.part`。
- TaskManager 在批次提交后推进行游标；取消信号在批次边界停止并保留 `.part`。
- 连接管理页支持 SQLite 文件选择，迁移页支持单表和批量导出。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | SQLite ConnectionConfig 与绝对路径 | PASS |
| 2 | 表、列、行数浏览 | PASS |
| 3 | better-sqlite3 `iterate()` 批量 JSONL 导出 | PASS |
| 4 | 基于已写行数的续传 | PASS |
| 5 | 取消后停止并保留已提交批次 | PASS |
| 6 | 连接管理和迁移 UI | PASS |
| 7 | 导出、续传、取消测试 | PASS |

## 验证

```bash
npm run check
npx vitest run tests/sqlite-service.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 统一检查：17 个测试文件，187 passed / 15 skipped，Go 测试通过。
- SQLite 单测：4/4 通过。
- 开发模式与打包应用启动成功；打包应用 REST health 返回 `{"status":"ok"}`。

## 已知限制

- 无 rowid 的特殊虚拟表不支持基于 OFFSET 的稳定续传。
- SQLite 整数超出 JavaScript 安全范围时当前不做特殊字符串化。
