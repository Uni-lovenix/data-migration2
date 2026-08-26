# 评审评分表 -- 数据迁移工具

> 本文件由 Agent Team Studio 生成。评估者在迭代验收前按迭代协议填写，并作为质量文档的评审证据。

## 当前评审上下文

- 当前 RUP 阶段：construction
- 当前迭代：核心功能开发迭代（大数据量任务与可靠性）
- 评估者：评估者

## 评分规则

- **5 分**：满足全部验收证据，无需修订。
- **4 分**：核心满足，仅存在少量非阻塞打磨项。
- **3 分**：核心基本满足，需要计划内修订并复审。
- **2 分**：存在明显缺口，验收前必须修订。
- **1 分**：存在阻塞问题，当前不可验收。

## 评分维度

| 维度 | 问题 | 分数 (1-5) | 备注 |
| --- | --- | --- | --- |
| 正确性 | 实现出来的行为是否符合目标功能和迭代协议？ |  |  |
| 验证 | 要求的检查是否真的跑过，并留下证据？ |  |  |
| 范围纪律 | 这一轮是否基本保持在选定功能范围内？ |  |  |
| 可靠性 | 结果是否能在重启或重跑后继续工作？ |  |  |
| 可维护性 | 代码和文档是否清楚到足以交给下一轮会话？ |  |  |
| 交接准备度 | 新会话是否能只靠仓库内工件继续推进？ |  |  |

## 总体评分

**Overall: 待评估 / 5**

## Harness 文件评估

| 文件 | Present | Quality | Notes |
| --- | --- | --- | --- |
| `AGENTS.team.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `agents.json` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `AGENTS.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `CLAUDE.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `feature_list.json` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `progress.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `session-handoff.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `quality-document.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `evaluator-rubric.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `clean-state-checklist.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `init.sh` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `docs/PROCESS.md` | 是 | 待评估 | 由 Agent Team Studio 初始化 |
| `agents/<角色文件>` | 是 | 待评估 | 由 Agent Team Studio 初始化 |

## 结论

- [ ] Accept
- [ ] Revise
- [ ] Block

## Summary

开发者已提交迭代 004 交付与证据：`npm run check`（36 个用例）、`npm run build`、Docker PostgreSQL / Elasticsearch 集成测试，以及任务队列、取消、续传和日志单测均通过。评估结论待评估者填写。

## 后续动作

- 缺失的证据：
- 必须补的修复：
- 下次复审触发条件：
