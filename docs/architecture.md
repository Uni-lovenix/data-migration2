# 架构基线

## 当前范围

第一迭代交付桌面应用骨架、安全 IPC 边界和多数据库连接管理：

- Electron 主进程负责窗口生命周期、本地持久化和原生能力。
- Preload 通过 `contextBridge` 暴露最小化、类型安全的 API。
- React + TypeScript 渲染层负责工作台 UI，不直接访问 Node.js。
- `src/shared` 保存 IPC 通道、类型和校验规则，主进程与渲染层共用。

## 进程边界

```text
React 渲染层
  -> window.api
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 ConnectionStore
  -> userData/connections.json
```

渲染层无法访问 Node.js API；连接数据只能通过主进程 IPC 读写。后续迁移引擎、文件系统和原生对话框都放在主进程或独立 Go 服务中。

## 本地存储

当前连接配置使用 `userData/connections.json` 原子落盘，避免第一迭代引入原生模块编译负担。后续需要事务、索引和任务断点时切换到 SQLite；存储层接口会保持可替换。

## PostgreSQL 迁移

迁移引擎放在 Electron 主进程，由 `PostgresService` 统一管理 PostgreSQL 客户端生命周期：

```text
React 迁移工作台
  -> window.api.postgres
  -> Preload contextBridge
  -> IPC
  -> Electron 主进程 PostgresService
  -> pg / pg-query-stream
```

- 连接测试和表浏览通过 `pg.Client` 查询 `pg_class` 与 `information_schema`。
- 导出使用 `pg-query-stream` 流式读取 `SELECT * FROM schema.table`，逐行写入 JSONL 临时文件，完成后原子替换目标文件。
- 导入逐行解析 JSONL，按批量生成参数化 `INSERT`，默认 `ON CONFLICT DO NOTHING`，并将对象/数组值序列化为 JSON 字符串。
- 文件路径由主进程原生对话框产生，PostgreSQL 操作只接受已保存的连接 ID，避免渲染层直接接触连接凭据。

## 后续模块

1. Elasticsearch 导出/导入：索引浏览、scroll/search_after 分页、bulk 写入。
2. 大数据量任务：后台任务队列、进度、暂停/恢复、断点续传。
3. 打包发布：macOS dmg/zip、Windows NSIS。

## 安全约定

- `contextIsolation: true`、`nodeIntegration: false`。
- 窗口只加载应用本地内容，外部链接交给系统浏览器。
- IPC 入参在主进程重新校验，不信任渲染层输入。
- 密码字段目前保存在本地配置中；正式发布前改用 Electron `safeStorage` 或系统钥匙串加密。
