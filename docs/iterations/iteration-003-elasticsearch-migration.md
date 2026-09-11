# 迭代协议 003：Elasticsearch 导出与导入

## 迭代目标

交付可用的 Elasticsearch 数据迁移能力：连接测试、索引浏览、scroll / search_after 流式导出和 bulk 分批导入，兼容 Elasticsearch 7.10.2 及以上版本。

## 迭代范围

- Elasticsearch 连接测试并返回服务端版本，识别低于 7.10.2 的版本。
- 索引浏览：文档数、存储大小、健康状态、别名和映射字段。
- 导出：scroll 与 search_after（PIT + `_shard_doc`）两种流式读取方式，输出 JSONL。
- 导入：JSONL 批量 bulk 写入，支持 `index` 覆盖与 `create` 跳过冲突。
- 迁移工作台 UI、安全 IPC 边界和共享校验。
- 单元测试、HTTP 请求层测试、类型检查和构建。

## 实施计划

1. 定义共享类型、IPC 通道和 Elasticsearch 请求校验。
2. 实现 `ElasticsearchService`：HTTP 客户端、连接测试、索引/映射浏览、scroll 导出、PIT search_after 导出、bulk 导入。
3. 接入主进程 IPC 与 Preload API。
4. 实现迁移工作台 Elasticsearch 面板，支持导出/导入模式、读取方式和冲突处理。
5. 补充单元测试，覆盖服务、HTTP 客户端和请求校验。
6. 更新架构、路线图、状态文件和质量证据。

## 交付物

- Elasticsearch 连接测试与索引/字段浏览。
- JSONL 流式导出（scroll / search_after）与 bulk 分批导入。
- 迁移工作台 Elasticsearch UI。
- `npm run check`、`npm run build` 通过。
- 单元测试覆盖 Elasticsearch 服务主路径和错误路径。

## 退出标准

- 类型检查无错误。
- 单元测试通过并覆盖服务与请求校验。
- 生产构建通过。
- scroll 与 search_after 导出路径均有测试证据。
- bulk 导入的覆盖/跳过冲突路径均有测试证据。
- `feature_list.json`、`progress.md`、`session-handoff.md` 和架构文档已更新。

## 结果

- `npm run check` 通过：4 个测试文件、27 个用例，另有 2 个集成用例默认跳过。
- `npm run build` 通过：产出 main/preload/renderer。
- Docker Elasticsearch 7.10.2 与 9.5.0 集成测试通过：100 文档完成 scroll 导出、search_after 导出、bulk 导入与 `create` 跳过冲突。
- 已更新 `feature_list.json`、`progress.md`、`session-handoff.md`、`AGENTS.team.md`、`docs/PROCESS.md`、`docs/architecture.md` 与 `docs/roadmap.md`。
