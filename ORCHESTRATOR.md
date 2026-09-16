# 多 Agent 编排器使用说明

> 编排脚本：[orchestrator.py](./orchestrator.py)
> 待办文件：[feature_list.json](./feature_list.json)
> 规则地图：[AGENTS.md](./AGENTS.md) / [feature_list.json](./feature_list.json) / [progress.md](./progress.md)

## 它做什么

直接读取 `feature_list.json` 的待办状态，按下列流程推进一个功能：

```
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
              功能通过测试并完成交付后停止
```

## 启动方式

```bash
# 1. 默认串行启动（推荐，冲突最少）
python3 orchestrator.py

# 2. dry-run：只打印计划，不实际调用 Claude
python3 orchestrator.py --dry-run --max-cycles 1

# 3. 串行阶段仍按固定角色顺序执行：产品 → 后端/架构 → 前端

# 4. 用更强的模型（更慢但更准）
python3 orchestrator.py --model opus

# 5. 禁止 Agent 使用 Docker（默认允许）
python3 orchestrator.py --no-docker

# 6. 需要 PM + 架构双评审 / 产品 deliver 时
python3 orchestrator.py --full-design --full-deliver

# 7. 临时关闭 test 前确定性预检（默认开启）
python3 orchestrator.py --no-preflight
```

按 **Ctrl+C** 任何时刻都可优雅停止。

## 关键约束

| 约束 | 实现 |
|---|---|
| **默认 Agent 串行** | 每批角色通过 `_run_agent_calls_serial` 逐个 await；`_agent_execution_lock` 再提供硬互斥，保证同一时间只运行一个 Agent |
| **角色级增量重试** | 成功角色写入 `.orchestrator/checkpoints/<feature>.json`；后续 attempt 甚至重启后都只重跑失败角色，例如后端成功、前端失败时只重新协调前端 |
| **失败后生成重试上下文** | 每次 develop/test 失败后写入 `.orchestrator/retry-context/<feature>.md`；下一 attempt 进入 Retry Context 执行模式，以该文件为唯一事实源，禁止重新探索或重复旧方案 |
| **session-handoff.md 是交接事实源** | 每次 Agent 调用注入核心交接段（受上下文预算限制）；跨会话的完成项、决策、验证证据、阻塞和下一步以该文件为准。需要历史细节时用 `Read(offset/limit)` 精确读取；每个 Agent 开始前核对、完成后增量更新，禁止用未经验证的描述覆盖历史事实 |
| **工具轮次上限收尾** | Agent 达到 80 轮 tool-use 后进入一次无工具收尾请求，让已落盘实现返回 `DONE`/`RESULT`，不再直接丢弃整轮成果 |
| Token 5h 重置（≈ 不限） | `TokenBudget` 每 5h 归零；`SOFT_TOKEN_LIMIT=50M` 仅做统计不阻塞；1M 上下文 |
| 单次 token 软上限 204800 | `PER_CALL_TOKEN_LIMIT=204800` 传给 `--max-tokens`；超限仅日志告警不杀进程 |
| 模型调用 rate 监控 | `CALLS_PER_5H_SOFT_LIMIT=2250` 仅做统计；实际请求由内置 `TokenBudget` 和供应商限流共同约束 |
| **Token Plan 配额耗尽（429/2056）** | 全局暂停 Claude 请求；每 15 分钟统一重试，不消耗开发/测试 attempt |
| 每次只做一个功能 | prompt 强制要求 + 每 cycle 只针对一个 `feature_id` |
| **per-feature 分支 + 完成后提交并合并** | 每个 feature 在 `.orchestrator/worktrees/<id>` 下开发；test_engineer 给 `RESULT: pass` 后由编排器自动提交一次功能代码，再优先 `git merge --ff-only feature/<id>` 回当前分支；放弃时 `discard` 分支。`--no-git-worktree` 旁路 |
| **merge 以 feature 最新实现为准** | 主工作区存在与 feature 分支重叠的未提交修改时，先把这些文件备份到 `git stash`，再 fast-forward feature 提交；不会因本地旧版本覆盖而判定开发无用 |
| **开发者不自评** | `golang_senior` / `ui_engineer` / `frontend_senior` 只写代码 + `DONE`；`_tool_Write` / `_tool_Edit` 拒绝直接改 `feature_list.json`；`_phase_audit_status` 在 develop 后自动 rollback 任何越权的 `status=pass` |
| **developer 不能自提交** | Phase-1：`_tool_Bash` 黑名单拦截 `git commit / push / merge / reset --hard / rebase -i / branch -D`；test_engineer（evaluator）和 architect（planner）不受限 |
| **per-feature 文件锁** | Phase-1：`StateStore.acquire(feature_id)` 跨进程用 flock / msvcrt 串行化；进程内用 asyncio.Lock 兜底。`--no-file-lock` 旁路 |
| **audit 不再自锁** | post-develop audit 在单次 feature 文件锁内使用 unlocked 读写辅助方法，避免嵌套 flock 导致 60s 超时 |
| **test_engineer 是唯一判定者** | 唯一可写 `status=pass`；blocked 时写反馈到 progress.md `## Test Feedback` 段 |
| **测试必须使用真实环境** | 禁止 mock-as-pass；数据库/网络功能必须用 Docker、Python 种子数据和真实 roundtrip，并给出结构化 VERIFICATION 字段 |
| **结构化 pass 门禁** | `RESULT: pass` 必须包含 typecheck/unit_tests/build/docker/seed_data/roundtrip/electron/mock=none；数据库类 feature 的 docker/seed_data/roundtrip 不允许 n/a，字段缺失或 mock 非 none 自动降级 blocked |
| **测试工程师必须实机验证** | `test_engineer` 的 `RESULT: pass` 必须由真实 `RunApp(start) → status(state=running) → eval(renderer 实际检查/操作)` 工具轨迹支撑；仅凭文本、启动日志或 `electron: n/a` 不能通过 |
| **下游反馈回流** | `test_engineer` blocked 时反馈回流到 `_phase_develop` 重试，最多 3 轮 |
| **恢复中的功能不做重复设计** | `in_progress` / `blocked` 的 feature 直接恢复 develop-test，只有 `not_started` 才进入 design |
| **拆解子任务直接开发** | `*-step--N` 已由拆解阶段定义清楚，不再重复跑 PM/架构 design，直接进入 develop-test |
| **请求级超时** | 每次 Messages API 请求单独限制 120s；整个 Agent 多轮调用遵循 `--max-agent-minutes`，不再被 120s 整体切断 |
| **数据源纵向门闸** | 固定按 `mysql → sqlite → access → neo4j → hive` 推进；当前源未完成时，后续源 feature 不会被选中 |
| **待办单一来源** | 不读取 `goals.md`，也不自动生成 feature；只从 `feature_list.json` 选择待办 |
| **上下文裁剪** | 注入给 Agent 的 `feature_list.json` 只包含已完成项和当前数据源；未来源 feature 不会出现在快照或 Read 工具结果中 |
| **Harness 上下文预算** | 快照、相关 progress、handoff 与工具输出均有限额；`Read` 支持 `offset/limit`，大文件不再整份回灌模型 |
| **test 前确定性预检** | 编排器先跑 `git diff --check`，再按变更运行 build/typecheck/unit/Go vet/test；机械失败直接回流 developer，不消耗 test_engineer |
| **失败 owner 路由** | 解析测试 `FAILURE.owner` 与错误路径，只重跑对应后端或前端角色；无明确 owner 才按 feature owner 回退 |
| **无进展重试门禁** | retry 前后比较 worktree diff digest；没有实际代码变化时拒绝再次启动同一轮 test_engineer |
| **子任务调度容器化** | 父 feature 存在 `--step--` 子任务时不再参与调度；子任务不得依赖父 feature，全部子任务 pass 后父 feature 自动收敛 |
| **默认轻量设计/交付** | design 默认由 owner 角色一次完成；deliver 默认跳过，因为 test_engineer 已覆盖用户视角。可用 `--full-design` / `--full-deliver` 恢复双阶段 |
| **探索循环硬停止** | 连续 12 轮只读后注入纠偏提示；连续 16 轮仍无 Edit/Write 或 Bash 写动作则终止本次调用 |
| **develop 必须产生真实变更** | Agent 返回 `DONE` 但 feature worktree 无代码变更时按开发失败处理，不进入 test/提交 |
| **同文件编辑串行化** | Write/Edit 使用进程内 per-file lock；`progress.md` / `session-handoff.md` 旧 section 漂移时按唯一二级标题安全替换，减少并发 `old_string not found` |
| **dev 进程自动回收** | 一批串行 Agent 完成后清理本批新启动的 Electron/Vite/esbuild，避免端口占用导致下一轮启动失败 |
| **Docker 测试环境** | 默认允许 Agent 使用 Docker 创建测试库/服务；要求唯一容器名、ephemeral label、20000-29999 端口并在完成后清理，`--no-docker` 可关闭 |
| **应用日志统一采集** | 应用只能通过 `RunApp(start/status/eval/stop)` 启动和实测；日志写入 `.orchestrator/app-logs/<feature>/{app,startup,runtime}.log`，test blocked 时自动附带给 developer |
| **测试阶段断点续跑** | develop + audit 完成后写入 `.orchestrator/checkpoints/<feature>.json`；若 test 阶段被 Ctrl+C，重启后恢复原 worktree，直接续跑 test，不重复 develop |
| **session.log 自动轮转** | 启动时及每 1000 次写入检查一次，超过 5 万行时原子裁剪为最近 5 万行；可用 `ORCH_SESSION_LOG_MAX_LINES` / `ORCH_SESSION_LOG_TRIM_EVERY` 调整 |
| **脏工作区基线同步** | 新 worktree 创建后，自动同步与当前 feature 数据源/名称相关的未提交代码和配置；启动仍会列出其余脏文件，避免 Agent 看不到既有实现而重复探索 |
| **续做 in_progress / blocked** | `next_pending()` 优先返回 `in_progress` 或 `blocked` 的功能 |
| 状态同步 | 注入 feature 摘要 + 当前 feature JSON、当前 feature 相关 progress 段、核心 handoff 段；总快照和 tool result 均有字符预算 |
| 单功能运行 | 成功完成当前待办后立即停止；失败则按既有重试、拆解和重设计流程处理 |

## 角色 → 模型 API 调用

每个角色是**一次独立的 Anthropic SDK Messages API 调用**，由脚本自行执行
Read / Write / Edit / Bash / Glob / Grep 工具循环。模型与 API 地址来自：

* `--model` / `ANTHROPIC_MODEL`
* `--api-url` / `ANTHROPIC_BASE_URL`
* `ANTHROPIC_API_KEY`

脚本不会读取 `~/.claude/settings.json`，也不会经过 `claude` CLI；因此
cc-switch 只改 Claude Code 配置时不会影响这里。

Agent 按阶段内的固定顺序串行执行。`--max-concurrent` 仅保留为 semaphore
配置项，当前调度不会再并发启动角色任务。

## 协作协议（如何避免互相覆盖）

| 文件 | 谁写 | 谁读 |
|---|---|---|
| `feature_list.json` | 开发 / 测试 | 所有 Agent（启动时注入） |
| `progress.md` | 产品 / 架构 / 开发 / 用户 | 所有 Agent（注入当前 feature 相关段，按预算截断） |
| `session-handoff.md` | 所有 Agent 增量更新相关段落 | 所有 Agent（注入核心交接段；跨会话交接的唯一事实依据） |
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
  │     log("没有可执行待办，停止")
  │     break
  │
  ├─ # 标准设计阶段 —— 由产品+架构共同制定本功能迭代协议
  ├─ target = design(features)
  │  └─ if target is None:
  │        sleep 30; continue
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
  └─ 停止
```

## 停止条件

1. 当前待办功能通过 test_engineer 验证并完成交付 → 自动退出
2. `feature_list.json` 中没有可执行待办 → 自动退出
3. 用户按 **Ctrl+C** → 优雅停止
4. `--max-cycles N` 达到 → 正常退出
5. 单个 Agent 调用超过 30 分钟 → kill 该子进程

## Git 工作流（Phase-1）

每个 feature 默认在一个**独立的 git worktree** 中开发，避免污染当前分支：

```
┌─ 工作流 ─────────────────────────────────────────────┐
│  1. 启动编排器前确认当前所在分支（默认集成分支）       │
│  2. _phase_develop：                                  │
│     - git worktree add -b feature/<id>                │
│       .orchestrator/worktrees/<id> HEAD               │
│     - 开发 Agent 在 worktree 内跑；Read / Write /     │
│       Edit / Glob / Grep / Bash 的根目录都切到        │
│       worktree；状态文件仍读写主工作区                 │
│     - developer 角色**禁止** git commit / push /      │
│       merge / reset --hard / rebase -i / branch -D    │
│       （黑名单由 _tool_Bash 拦截）                    │
│  3. _phase_audit_status：                             │
│     - 强制 rollback develop Agent 对                  │
│       feature_list.json 的越权修改（防止自评 pass）   │
│  4. _phase_test（test_engineer）：                    │
│     - 若 worktree 无任何变更（has_changes=False）      │
│       → 跳过 test，feature 保留 in_progress           │
│     - RESULT: pass → 自动提交一次功能代码              │
│       （排除 feature_list.json / progress.md /        │
│       goals.md）→ git merge --ff-only feature/<id>    │
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
| phase | 当前阶段（design/develop/test/deliver） | log_scope(phase=...) |
| feature | 正在处理的 feature id | log_scope(feature=...) |
| aN | 第 N 套方案（第 1 次重设计后变 2） | log_scope(approach=N) |
| #M | 第 M 次尝试（每个方案最多 3 次） | log_scope(attempt=M) |
| role | Agent 角色（产品经理 / Golang / 前端 / 测试工程师） | AgentClient 输出时直接加角色前缀 |

工具调用和 API 响应日志会额外直接带角色前缀，例如
`[前端应用资深开发工程师] 🔧 Edit(...)` / `[产品经理] 🔧 Bash(...)`，
工具日志始终显示角色前缀；即使历史日志来自旧版并发模式，也能看出是哪一方发起的动作。

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

维护 `feature_list.json` 时，待办 feature 应按 **INVEST** 原则校验：
- **I**ndependent：只依赖 status=pass 的 feature
- **N**egotiable：description 写用户故事 + 验收标准
- **V**aluable：对应用户价值或明确交付目标
- **E**stimable：单 feature 工作量 ≤ 1 个 develop-test cycle（desc ≤ 1500 字、deps ≤ 5 项）
- **S**mall：> 1 cycle 必须拆成 2+ 子任务（id 命名 {parent}--step--N）
- **T**estable：能用 typecheck + 单测 + 必要时 build/dev 启动验证

完整改进说明与回滚方式见 [docs/orchestrator-improvements.md](docs/orchestrator-improvements.md)。

## 日志

* 实时输出到 stdout（带时间戳）
* 同步追加到 `.orchestrator/session.log`（已加入 .gitignore）

## 第一次跑会怎样？

直接 `python3 orchestrator.py` 启动后，编排器从 `feature_list.json` 选择
`in_progress`、`blocked` 或依赖已满足的 `not_started` 功能作为当前待办，
完成设计、开发、测试和交付后立即停止。需要继续下一个功能时再次运行即可。
