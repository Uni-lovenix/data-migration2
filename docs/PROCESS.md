# RUP 过程管理 -- 数据迁移工具

> 本文件由 Agent Team Studio 生成，用于管理长时间、多会话的智能体开发项目。

## 阶段

| 阶段 | 目的 | 里程碑 | 当前状态 | 迭代 |
|---|---|---|---|---|
| 启动 | 确认项目价值、范围、关键目标和主要风险。 | 生命周期目标 | 当前 | 启动范围确认 |
| 细化 | 降低关键技术风险，形成可执行的架构基线和迭代计划。 | 生命周期架构 | 待进入 | 架构与风险细化 |
| 构建 | 通过多个迭代完成责任区块的开发、测试和评估闭环。 | 初始可用能力 | 已完成 | 核心功能开发迭代（26/26 feature pass） |
| 移交 | 完成最终验收、交付说明整理和已知问题移交。 | 产品发布 | 待进入 | 移交验收 |

## 迭代协议

每个迭代开始前，规划者必须制定迭代协议，包含：

- 迭代目标
- 迭代范围
- 实施计划
- 交付物
- 退出标准

开发者按迭代协议开发；评估者按迭代协议和退出标准校验，发现问题反馈给对应开发者修改，通过后进入下一迭代或阶段验收。

## 当前迭代

当前阶段：construction

当前迭代：构建阶段已完成，准备进入移交验收

## 迭代列表

| 迭代 | 阶段 | 负责人 | 目标 | 退出标准 |
|---|---|---|---|---|
| 启动范围确认 | inception | 规划者 | 确认项目边界、核心目标、约束和初始风险。 | 范围、目标和约束已确认；初始风险已列出；启动阶段可交付物已形成 |
| 架构与风险细化 | elaboration | 规划者 | 降低关键技术风险，形成可执行的架构基线和迭代计划。 | 架构基线已记录；风险与依赖已排序；构建迭代计划已确定 |
| 核心功能开发迭代 | construction | 桌面端开发 | 迭代 001 桌面壳与连接管理；迭代 002 PostgreSQL 导出/导入；迭代 003 Elasticsearch 导出/导入；迭代 004 大数据量可靠性；迭代 005 桌面端打包。 | 核心交付物已产出；评估者校验通过；遗留问题已记录 |
| 移交验收 | transition | 评估者 | 完成最终验收、交付说明整理和已知问题移交。 | 验收通过；交付与运行说明完整；已知问题已登记并移交 |

## 迭代 001 结果

- 桌面应用骨架与安全 IPC：完成。
- PostgreSQL/Elasticsearch 连接配置 CRUD：完成。
- 单元测试、类型检查与生产构建：通过。
- 开发模式启动：通过。
- 协议与证据：见 `docs/iterations/iteration-001-desktop-shell.md`、`feature_list.json`。

## 迭代 002 结果

- PostgreSQL 连接测试、表浏览、JSONL 流式导出和分批导入：完成。
- 迁移工作台 UI 与安全 IPC：完成。
- 单元测试 17 个用例通过；Docker PostgreSQL 集成测试通过。
- 类型检查与生产构建：通过。
- 协议与证据：见 `docs/iterations/iteration-002-postgresql-migration.md`、`feature_list.json`。

## 迭代 003 结果

- Elasticsearch 连接测试、索引/映射浏览：完成。
- scroll 与 search_after（PIT）流式导出：完成。
- bulk 分批导入与 `create` / `index` 冲突处理：完成。
- PostgreSQL/Elasticsearch 双引擎迁移工作台与安全 IPC：完成。
- 单元测试 27 个用例通过；Docker Elasticsearch 7.10.2 与 9.5.0 集成测试通过。
- 类型检查与生产构建：通过。
- 协议与证据：见 `docs/iterations/iteration-003-elasticsearch-migration.md`、`feature_list.json`。

## 迭代 004 结果

- 后台任务队列、进度广播、取消与断点续传：完成。
- SQLite 任务存储与 JSON Lines 结构化日志：完成。
- 任务中心 UI 与迁移工作台入队改造：完成。
- 单元测试 36 个用例通过；Docker PostgreSQL 16 与 Elasticsearch 7.10.2 集成测试通过。
- 类型检查与生产构建：通过。
- 协议与证据：见 `docs/iterations/iteration-004-large-data-migration.md`、`feature_list.json`。

## 迭代 005 结果

- electron-builder 配置与 asar / WASM 资源：完成。
- macOS dmg/zip 打包：通过，打包后应用启动成功。
- Windows NSIS 与双平台 CI 工作流：完成。
- README 与发布文档：完成。
- 协议与证据：见 `docs/iterations/iteration-005-desktop-packaging.md`、`feature_list.json`。

## 不引入的部分

不新增业务分析师、架构师、测试工程师、部署工程师或项目经理等独立 RUP 角色；保留阶段与里程碑、迭代协议、风险驱动、评估反馈、阶段验收、文档交接和已知问题移交。
