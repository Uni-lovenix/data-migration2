# 分步开发路线

## 已完成

### 迭代 001：桌面壳与连接管理

- Electron + React + TypeScript + Vite 应用骨架。
- 安全主进程/Preload/渲染层边界。
- 多 PostgreSQL/Elasticsearch 连接配置 CRUD。
- 连接配置本地原子持久化。
- 共享类型、校验、单元测试和类型检查。

### 迭代 002：PostgreSQL 导出与导入

- 主进程驱动层：连接测试、表/字段浏览。
- 导出：使用 `pg-query-stream` 流式读取 PostgreSQL，写入 JSONL 文件。
- 导入：读取 JSONL 文件并分批参数化写入 PostgreSQL，支持冲突跳过或报错。
- 迁移工作台 UI、安全 IPC、单元测试和真实 PostgreSQL 集成测试。

### 迭代 003：Elasticsearch 导出与导入

- 连接测试、索引/映射浏览。
- 基于 scroll 与 search_after（PIT）的流式导出。
- 基于 bulk 的分批导入，支持跳过冲突或覆盖，兼容 7.10.2+。
- 双引擎迁移工作台 UI、安全 IPC、单元测试和真实 Elasticsearch 7.10.2 集成测试。

### 迭代 004：大数据量任务与可靠性

- 后台任务队列、进度上报、取消与断点续传。
- SQLite 存储任务状态。
- 结构化 JSON 日志与可观测性。
- 任务中心 UI 与迁移工作台入队改造。

### 迭代 005：打包与交付

- macOS dmg/zip、Windows NSIS 构建验证。
- README、发布说明和已知问题清单。
- GitHub Actions 双平台打包工作流。

## 待开始

### 最终移交验收

- 评估者按 `evaluator-rubric.md` 与 `clean-state-checklist.md` 完成最终验收。
- 正式发布前运行 CI 双平台打包并登记签名事项。
