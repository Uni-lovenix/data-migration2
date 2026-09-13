# 多 Agent 编排器使用说明

> 编排脚本：[orchestrator.py](./orchestrator.py)
> 目标文件：[goals.md](./goals.md)
> 规则地图：[AGENTS.md](./AGENTS.md) / [feature_list.json](./feature_list.json) / [progress.md](./progress.md)

## 它做什么

按 `goals.md` 自动驱动 7 个角色 Agent 协作开发数据迁移工具：

```
┌─ 自举规划阶段 ────────────────────────────────────────────┐
│ 没有 pending feature 时触发：                              │
│   产品经理 ─┐                                              │
│   架构师   ─┼─> 重新读 goals.md，找出未覆盖目标点           │
│              追加为新 feature → feature_list.json          │
└────────────────────────────────────────────────────────────┘
                            ↓
┌─ 主循环（每个 cycle 推进 1 个功能） ────────────────────────┐
│                                                            │
│   产品经理 ─┐                                              │
│   架构师   ─┼─> 设计（迭代协议）──> 写 progress.md         │
│              │                                             │
│   Golang 资深 ─┐                                            │
│   UI 工程师   ─┼─> 开发（本次只做一个）──> 改 feature_list │
│   前端资深    ─┘                                            │
│              │                                             │
│   测试工程师 ─> 验收（typecheck + 单测 + 集成）            │
│              │                                             │
│   用户/架构/产品 ─> 交付验收 ──> 写 progress.md           │
│                                                            │
└────────────────────────────────────────────────────────────┘
                            ↓
              下一 cycle（直到所有目标覆盖 + 全 pass）
```

## 启动方式

```bash
# 1. 默认参数启动（推荐；并发 30 + 单 Agent 预算 $10）
python3 orchestrator.py

# 2. dry-run：只打印计划，不实际调用 Claude
python3 orchestrator.py --dry-run --max-cycles 1

# 3. 自定义并发数和单次预算（token ≈ 不限，可大胆拉高）
python3 orchestrator.py --max-concurrent 30 --agent-budget 10.00

# 4. 用更强的模型（更慢但更准）
python3 orchestrator.py --model opus

# 5. 极限并行：拉满 2250 calls/5h 配额（按需）
python3 orchestrator.py --max-concurrent 50 --agent-budget 15.00
```

按 **Ctrl+C** 任何时刻都可优雅停止。

## 关键约束

| 约束 | 实现 |
|---|---|
| 同时运行 Agent ≤ 30（默认） | `asyncio.Semaphore(max_concurrent)`，CLI 传入更大值会被尊重不再截断 |
| Token 5h 重置（≈ 不限） | `TokenBudget` 每 5h 归零；`SOFT_TOKEN_LIMIT=50M` 仅做统计不阻塞；1M 上下文 |
| 单次 token 软上限 204800 | `PER_CALL_TOKEN_LIMIT=204800` 传给 `--max-tokens`；超限仅日志告警不杀进程 |
| Claude 调用 rate 监控 | `CALLS_PER_5H_SOFT_LIMIT=2250` 仅做统计；CLI 实际由 `claude` 自身管控 |
| 每次只做一个功能 | prompt 强制要求 + 每 cycle 只针对一个 `feature_id` |
| **per-feature 分支 + 完成后合并** | Phase-1：每个 feature 在 `.orchestrator/worktrees/<id>` 下开发；test_engineer 给 `RESULT: pass` 后由编排器 `git merge --no-ff feature/<id>` 回到当前分支；放弃时 `discard` 分支。`--no-git-worktree` 旁路 |
| **开发者不自评** | `golang_senior` / `ui_engineer` / `frontend_senior` 只写代码 + `DONE`；`_tool_Write` / `_tool_Edit` 拒绝直接改 `feature_list.json`；`_phase_audit_status` 在 develop 后自动 rollback 任何越权的 `status=pass` |
| **developer 不能自提交** | Phase-1：`_tool_Bash` 黑名单拦截 `git commit / push / merge / reset --hard / rebase -i / branch -D`；test_engineer（evaluator）和 architect（planner）不受限 |
| **per-feature 文件锁** | Phase-1：`StateStore.acquire(feature_id)` 跨进程用 flock / msvcrt 串行化；进程内用 asyncio.Lock 兜底。`--no-file-lock` 旁路 |
| **test_engineer 是唯一判定者** | 唯一可写 `status=pass`；blocked 时写反馈到 progress.md `## Test Feedback` 段 |
| **下游反馈回流** | `test_engineer` blocked 时反馈回流到 `_phase_develop` 重试，最多 3 轮 |
| **续做 in_progress / blocked** | `next_pending()` 优先返回 `in_progress` 或 `blocked` 的功能 |
| **最终冒烟测试** | 所有 feature 都 pass 后跑 `_phase_smoke_test`：typecheck + 单测 + 构建 + 启动验证 |
| 状态同步 | 启动时把 goals.md / feature_list.json（完整 JSON）/ progress.md 注入 prompt；Agent 直接读写 |
| 自动循环 | 直到所有 goals.md 目标覆盖 + 全部 pass + 冒烟测试通过，或 Ctrl+C |

## 角色 → Claude CLI 调用

每个角色是**一次独立的 `claude` CLI 调用**，带：

* `--system-prompt`：角色系统提示
* `--allowed-tools Read,Edit,Write,Bash,Glob,Grep`：限定工具范围
* `--add-dir`：项目根目录
* `--permission-mode acceptEdits`：自动批准文件编辑
* `--max-budget-usd`：单次调用 USD 上限（默认 **$10**，token 视为不限量可拉高）
* `--no-session-persistence`：不保留会话

并发上限由 `asyncio.Semaphore(max_concurrent)` 在 `AgentClient.call` 内统一控制；
`max_concurrent` 来自 `--max-concurrent` CLI 参数（默认 30，按配额 2250 calls/5h 可拉到更高）。

## 协作协议（如何避免互相覆盖）

| 文件 | 谁写 | 谁读 |
|---|---|---|
| `feature_list.json` | 开发 / 测试 / **自举规划阶段（PM+架构）** | 所有 Agent（启动时注入） |
| `progress.md` | 产品 / 架构 / 开发 / 用户 | 所有 Agent（最近 2KB 注入） |
| `goals.md` | 仅人工 | 所有 Agent（启动时注入） |
| `docs/architecture.md` | 架构师 | 所有 Agent |

每个 Agent 在 prompt 里被明确告知**只动自己负责的文件段落**。

## 状态机

```
Cycle N
  │
  ├─ TokenBudget.maybe_reset()           # 5h 周期到点则归零
  ├─ if utilization ≥ 100% → sleep until next_reset
  ├─ load feature_list.json
  ├─ target = next_pending(features)    # 找 status=not_started 且依赖已 pass
  │
  ├─ if target is None:
  │     # 自举规划阶段 —— 让产品经理+架构师重新读 goals.md
  │     target = plan_from_goals(features)
  │     if target is None:
  │         log("🎉 goals.md 已全覆盖，停止")
  │         break
  │     # 规划本身就是设计 —— 直接进入开发
  │
  ├─ else (target 存在):
  │     # 标准设计阶段 —— 由产品+架构共同制定本功能迭代协议
  │     target = design(features)
  │     if target is None:
  │         sleep 30; continue
  │
  ├─ Phase 2: 开发 (1 个 dev agent，单功能)
  │    └─ golang_senior / ui_engineer / frontend_senior
  │       prompt: 实现单个 feature → 更新 feature_list.json + progress.md
  │
  ├─ Phase 3: 测试
  │    └─ test_engineer
  │       prompt: 跑 typecheck + 单测 → 改 status/evidence
  │
  ├─ Phase 4: 交付
  │    └─ user (代表 用户+架构+产品)
  │       prompt: 验收意见 → progress.md
  │
  └─ sleep 2s → next cycle
```

## 停止条件

1. 所有 `feature.status == pass` **且** 自举规划阶段判定 `RESULT: complete` → 自动退出
2. 用户按 **Ctrl+C** → 优雅停止
3. `--max-cycles N` 达到 → 正常退出
4. 单个 Agent 调用超过 30 分钟 → kill 该子进程

## Git 工作流（Phase-1）

每个 feature 默认在一个**独立的 git worktree** 中开发，避免污染当前分支：

```
┌─ 工作流 ─────────────────────────────────────────────┐
│  1. 启动编排器前确认当前所在分支（默认集成分支）       │
│  2. _phase_develop：                                  │
│     - git worktree add -b feature/<id>                │
│       .orchestrator/worktrees/<id> HEAD               │
│     - 三个 dev Agent（golang_senior / ui_engineer /   │
│       frontend_senior）在 worktree 内跑；              │
│       bash 工具的 cwd 自动切到 worktree               │
│     - developer 角色**禁止** git commit / push /      │
│       merge / reset --hard / rebase -i / branch -D    │
│       （黑名单由 _tool_Bash 拦截）                    │
│  3. _phase_audit_status：                             │
│     - 强制 rollback develop Agent 对                  │
│       feature_list.json 的越权修改（防止自评 pass）   │
│  4. _phase_test（test_engineer）：                    │
│     - 若 worktree 无任何变更（has_changes=False）      │
│       → 跳过 test，feature 保留 in_progress           │
│     - RESULT: pass → git merge --no-ff feature/<id>   │
│       当前分支 → 删除 worktree 与分支                 │
│     - RESULT: blocked → worktree 保留，下轮续用       │
│  5. 方案全部失败 + 重设计用尽 + 拆解未产出            │
│     → wt.discard() 删除分支（不留垃圾）               │
└───────────────────────────────────────────────────────┘
```

### 旁路

```bash
# 默认启用 worktree；显式关闭：
python orchestrator.py --no-git-worktree

# 默认启用 per-feature 文件锁；显式关闭：
python orchestrator.py --no-file-lock

# CI / dry-run 同时关闭两个旁路：
python orchestrator.py --dry-run --no-git-worktree --no-file-lock --max-cycles 1
```

### 为什么不强制要求 master 分支存在

项目实际主集成分支是 `feature/postgresql-migration`（不是 `master`）。
`DEFAULT_BASE_BRANCH = "HEAD"` 让 worktree 总是从编排器当前所在分支拉，
无需假设项目有 `master`。

## 进度可见性（自 2026-09-12 起）

编排器日志自带结构化前缀，每个 phase 自动加上下列字段的方括号标签：

`
[HH:MM:SS] [c1 develop mysql-export a1 #2] 开发中…
`

| 字段 | 含义 | 来源 |
|---|---|---|
| cN | 第 N 个 cycle | log_scope(cycle=N) |
| phase | 当前阶段（design/develop/test/deliver/plan-from-goals） | log_scope(phase=...) |
| feature | 正在处理的 feature id | log_scope(feature=...) |
| aN | 第 N 套方案（第 1 次重设计后变 2） | log_scope(approach=N) |
| #M | 第 M 次尝试（每个方案最多 3 次） | log_scope(attempt=M) |
| role | Agent 角色（test_engineer / product_manager ...） | log_scope(role=...) |

启动时和每个 cycle 结束会自动打一张 ASCII 进度看板：

`
📊 启动时进度  16/26 pass (62%)  [██████████████████░░░░░░░░░░░░]
   pass=16  in_progress=0  blocked=0  not_started=10
   · Agent Team Studio: 1/1 pass
   · Golang 后端开发: 2/5 pass
   · 前端开发: 5/6 pass
   · 桌面端开发: 8/14 pass
`

进入 develop/test/deliver 前会打一张 feature 卡片（name / owner / deps / 当前方案 / 当前尝试）。

## Feature 切分原则

调度器在 StateStore.next_pending 返回 feature 后调用 _warn_if_oversized：
desc > 2000 字 或 deps > 5 项时打警告（不阻断）。

下次自举规划时，PM Agent 必须按 **INVEST** 原则校验新 feature：
- **I**ndependent：只依赖 status=pass 的 feature
- **N**egotiable：description 写用户故事 + 验收标准
- **V**aluable：对应 goals.md 至少 1 条目标点
- **E**stimable：单 feature 工作量 ≤ 1 个 develop-test cycle（desc ≤ 1500 字、deps ≤ 5 项）
- **S**mall：> 1 cycle 必须拆成 2+ 子任务（id 命名 {parent}--step--N）
- **T**estable：能用 typecheck + 单测 + 必要时 build/dev 启动验证

完整改进说明与回滚方式见 [docs/orchestrator-improvements.md](docs/orchestrator-improvements.md)。

## 日志

* 实时输出到 stdout（带时间戳）
* 同步追加到 `.orchestrator/session.log`（已加入 .gitignore）

## 第一次跑会怎样？

当前 `feature_list.json` 中 7 个 feature 已全部 `pass`，但 `goals.md` 仍有未覆盖点：

| goals.md 目标 | 现有 feature 覆盖？ |
|---|---|
| 1. ES 多索引串行/并行 | ❌ 未显式覆盖 |
| 2. PG 多表串行/并行 | ❌ 未显式覆盖 |
| 3. ES/PG 用 Go 引擎（高并发） | △ ES 已有，PG 缺 |
| 4. 文件导入导出 | ✅ |
| 5. 环境→环境直连 | ❌ 未显式覆盖 |
| 6. 导出记录 + 配置批量重跑 | ❌ 未显式覆盖 |

直接 `python3 orchestrator.py` 启动后，会自动进入**自举规划阶段**，让产品经理+架构师把这些点追加为新 feature，然后逐个开发 → 测试 → 交付。

