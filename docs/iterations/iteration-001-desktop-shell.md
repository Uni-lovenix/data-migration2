# 迭代协议 001：桌面壳与连接管理

## 迭代目标

建立可运行的跨平台桌面应用骨架，并交付多数据库连接配置的本地管理能力。

## 迭代范围

- Electron + React + TypeScript + Vite 工程骨架。
- 主进程/Preload/渲染层安全边界。
- PostgreSQL/Elasticsearch 连接配置 CRUD。
- 连接配置本地原子持久化。
- 单元测试、类型检查和构建脚本。

## 实施计划

1. 初始化 Electron/Vite/TypeScript 工程。
2. 定义共享类型、IPC 通道与连接校验。
3. 实现主进程连接存储与 IPC handler。
4. 实现 React 工作台、总览页和连接管理页。
5. 补充测试、架构文档与状态文件。

## 交付物

- 可启动的桌面应用骨架。
- 连接配置 CRUD 与持久化。
- `npm run check`、`npm run build` 通过。
- 迭代协议、架构基线和路线图。

## 退出标准

- 类型检查无错误。
- 单元测试通过并覆盖校验与连接存储。
- 生产构建通过。
- `feature_list.json`、`progress.md`、`session-handoff.md` 已更新。
