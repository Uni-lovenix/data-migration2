# 迭代协议 002：PostgreSQL 导出与导入

## 迭代目标

交付可用的 PostgreSQL 数据迁移能力：连接测试、表浏览、流式导出和分批导入。

## 迭代范围

- PostgreSQL 连接测试并返回服务端版本。
- 表/字段浏览，包含列类型、主键、生成列和预估行数。
- 使用 `pg-query-stream` 将表数据流式导出为 JSONL 文件。
- 从 JSONL 文件按批量参数化导入，支持冲突跳过或报错。
- 迁移工作台 UI、安全 IPC 边界和共享校验。
- 单元测试、真实 PostgreSQL 集成测试、类型检查和构建。

## 实施计划

1. 定义共享类型、IPC 通道和 PostgreSQL 请求校验。
2. 实现 `PostgresService`：连接测试、表浏览、流式导出、分批导入。
3. 接入主进程 IPC 与 Preload API，添加原生文件选择对话框。
4. 实现迁移工作台页面，支持导出/导入模式和结果展示。
5. 补充单元测试与 Docker PostgreSQL 集成测试。
6. 更新架构、路线图、状态文件和质量证据。

## 交付物

- PostgreSQL 连接测试与表浏览。
- JSONL 流式导出与分批导入。
- 迁移工作台 UI。
- `npm run check`、`npm run build` 通过。
- 真实 PostgreSQL 导出/导入集成验证通过。

## 退出标准

- 类型检查无错误。
- 单元测试通过并覆盖服务与请求校验。
- 生产构建通过。
- Docker PostgreSQL 集成测试验证导出与导入闭环。
- `feature_list.json`、`progress.md`、`session-handoff.md` 和架构文档已更新。
