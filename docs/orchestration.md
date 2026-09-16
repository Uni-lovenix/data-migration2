# 原子编排 API

## REST

`POST /api/v1/orchestrate`，Bearer Token 鉴权。

```json
{
  "steps": [
    { "atom": "export_preview", "source": "postgresql", "connectionId": "...", "limit": 20, "table": { "schema": "public", "name": "users" } },
    { "atom": "cast_dry_run", "row": { "active": 1 }, "transforms": [] },
    { "atom": "task_create", "input": { "type": "postgres-import", "payload": {} } }
  ]
}
```

响应：

```json
{
  "steps": [
    { "index": 0, "atom": "export_preview", "status": "completed", "result": {} }
  ],
  "summary": { "total": 1, "completed": 1, "failed": 0, "skipped": 0 }
}
```

## 原子

### export_preview

输入：

- `source`: `postgresql | mysql | elasticsearch | hive | sqlite`
- `connectionId`: string
- `limit`: number，1..1000
- `table`: PostgreSQL/MySQL/SQLite `{schema,name}` 或 Hive `{database,name}`
- `index`: Elasticsearch 索引

输出：`{ source, columns, rows }`，无文件写入。

### import_validate

输入：

- `target`: `postgresql | mysql | elasticsearch | hive`
- `connectionId`: string
- `columns`: string[]
- `table` / `index`

输出：`{ target, ok: true, missingColumns, existingColumns? }`。缺列时返回错误。

### cast_dry_run

输入：

- `row`: object
- `transforms`: FieldTransform[]
- `targetTypes`: object，可选

输出：`{ row }`。

### task_create

输入为 `{ input: { type, payload } }`，同步返回新任务对象但不等待任务完成。

### template_execute

输入 `{ id, vars }`，按模板创建任务队列并返回 `{ taskId, taskIds }`。

### task_cancel

输入 `{ id }`，返回取消后的任务状态。

## 执行语义

- v1 只支持线性顺序，不支持 DAG。
- 单步失败后，后续步骤标记 `skipped`。
- 所有原子都可通过 IPC / Agent tools 独立调用。
