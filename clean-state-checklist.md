# 干净状态检查清单 -- 数据迁移工具

> 本文件由 Agent Team Studio 生成。提交前和每轮重要会话结束时检查，并把结果作为质量文档的证据。

## 当前快照

- 当前 RUP 阶段：construction
- 当前迭代：核心功能开发迭代（PostgreSQL 迁移）

## Build & Verification

- [x] `npm run check` 通过且没有类型错误
- [x] `npm run test` 通过
- [x] `npm run build` 通过
- [x] `bash init.sh` 通过（如存在）

## Harness Integrity

- [x] `AGENTS.team.md`、`agents.json`、`agents/` 存在且路由一致
- [x] `feature_list.json` 反映真实功能状态
- [x] `progress.md` 和 `session-handoff.md` 已更新
- [ ] `quality-document.md`、`evaluator-rubric.md` 已填写或明确标注待评估
- [ ] `bash scripts/cleanup-scanner.sh` 报告 clean（如存在）

## Architecture Boundaries

- [x] 渲染层没有直接导入 Node.js 模块（仅当项目是 Electron）
- [x] IPC channel 只定义在共享类型源中（仅当项目是 Electron）
- [x] 文件系统和对话框只存在于主进程（仅当项目是 Electron）

## Runtime & Clean State

- [x] 应用可以启动并进入核心工作流
- [x] 本地草稿和设置可以重置，且不修改目标项目文件
- [ ] 导出后的 harness 通过落盘校验

## Observability

- [ ] 日志是结构化 JSON 且包含 timestamp、level、service、message
- [ ] 关键操作留下了可复核的日志和证据

## Data & State

- [x] 没有未记录的半成品状态
- [x] 当前进度与 `feature_list.json` 和 `progress.md` 一致
- [x] 下一轮会话无需人工修复即可继续

## Performance

- [ ] `bash scripts/benchmark.sh` 完成全部任务（如存在）
- [ ] 本地分析、导出和验证耗时符合当前项目目标

## Repository

- [ ] git status 没有意外文件
- [ ] 没有敏感数据或密钥被提交
- [ ] 构建产物没有被提交（如 `dist/`）

- [ ] 当前 `master` 已包含本次会话所有已验证通过的 `feature/*` 合并；下一次会话能从 `master` 干净地拉出新的 `feature/*` 分支。
