# CLAUDE.md -- 数据迁移工具

> 本文件由 Agent Team Studio 生成，是规则和智能体地图；角色详情按地图读取对应文件。

## 规则地图

- `AGENTS.team.md`：团队级规则、RUP 过程、智能体路由、协作流程与工程约定。
- `agents.json`：schema v3 机器可读团队配置。
- `feature_list.json`：功能状态追踪。
- `progress.md`：会话进度和当前已验证状态。
- `session-handoff.md`：跨会话交接记录。
- `quality-document.md`：质量快照、评级标准和待补证据。
- `evaluator-rubric.md`：迭代验收前的评分表和结论。
- `clean-state-checklist.md`：会话结束前和提交前要完成的干净状态检查。
- `docs/PROCESS.md`：RUP 阶段、迭代协议和退出标准。

## 智能体地图

- 规划者：`agents/01-规划者.md`
- 评估者：`agents/02-评估者.md`
- React 前端开发：`agents/03-React-前端开发.md`
- TypeScript 前端开发：`agents/04-TypeScript-前端开发.md`
- Golang 后端开发：`agents/05-Golang-后端开发.md`
- 桌面端开发：`agents/06-桌面端开发.md`

## 使用规则

- 每个智能体只读取 `智能体地图` 中分配给自己的角色文件，不一次性加载所有角色文件。
- 先读取 `AGENTS.team.md` 了解当前阶段、迭代、路由和协作流程，再读取当前职责对应的 `agents/<角色文件>`。
