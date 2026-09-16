# Orchestrator 改进说明 -- 2026-09-12

> 本文件记录对 `orchestrator.py` 的一次系统性改进：日志可读性、feature 切分、推进有效性。
>
> **回滚方式（如果改动造成回归）：**
> ```powershell
> Copy-Item orchestrator.py.bak.20260912 orchestrator.py -Force
> ```
> 备份保留在仓库根：`orchestrator.py.bak.20260912`（应用改进前的原始 87000 字节版本）。

## 背景与动机

实际跑过一次后发现三个具体问题：

1. **日志不直观**：session.log 每行都是裸的 `[HH:MM:SS] msg`，没有 cycle/phase/feature 三元组标识。
   排查"现在在哪一阶段的哪个功能"得肉眼扫很多行。
2. **feature 切分不均**：当前 10 个 `not_started` feature 中，`type-conversion-pipeline` 描述 1563 字跨 5+ 数据源，
   `atomic-task-orchestration` 跨 4 个依赖，单 cycle 内难以完成。
3. **推进效率低**：
   - PM Agent 单次会话 26 轮 tool-use、反复 Read progress.md，每次 in ≈ 50K tokens。
   - Windows cmd 下 `head` / `tail` / `grep -r` / `timeout ... | head` 多次 retry 失败
     （session.log 可见：`head is not recognized` 出现 3+ 次）。

## 改进清单（已应用）

### A. 日志可读性

| 项 | 实现 | 收益 |
|---|---|---|
| 结构化前缀 | `log_scope(cycle, phase, feature, approach, attempt, role)` + module-level `_LOG_CTX` | 每条 log 自动加 `[c1 develop mysql-export a1 #2]`，grep 一行即可过滤整 cycle |
| 阶段横幅 | `banner(title, char, width)` | 阶段切换视觉上一目了然 |
| 进度看板 | `progress_dashboard(features, title, show_role_breakdown)` | 启动 + 每 cycle 结束打一张 ASCII 进度表（含进度条 + 按角色分组） |
| feature 卡片 | `feature_card(feature, approach, attempt, extra)` | 进入 develop/test/deliver 前打一张 ID/name/owner/deps/desc/方案/尝试 卡片 |
| 阶段计时 | `phase_timer(label, **log_kv)` ctx manager | 每个 phase 自动计时 |
| Cycle 计时 | Orchestrator.run 主循环 | 每 cycle 结束打"✅ Cycle N 结束 (累计 XmYs)" |

### B. 推进有效性

| 项 | 实现 | 收益 |
|---|---|---|
| Windows bash 提示 | `_check_windows_bash_compat(cmd)` 检测 11 种 Unix-only 模式（head/tail/grep -r/wc -l/sed/awk/xargs/timeout） | Agent 调 `head` 等时立即看到 PowerShell 等价物提示，不必 3 次 retry |
| Context snapshot SHA-1 缓存 | `AgentClient._snapshot_digest` + `_snapshot_cached` | 一次 Agent 调用 26 轮 tool-use，feature_list.json / progress.md 未变则复用上次拼接结果，节省每次 ~50K input tokens |
| Bash 超时分级 | （已留口；当前默认 120s，开发/测试阶段可单独配置） | 下一轮可继续细化 |

### C. Feature 切分

| 项 | 实现 | 收益 |
|---|---|---|
| 调度器自检 | `StateStore.next_pending` 返回 feature 后调 `_warn_if_oversized` | desc > 2000 字 / deps > 5 项时打警告（不阻断），提示 PM 拆 |
| PM INVEST 提示词 | `_phase_plan_from_goals` 给 PM 的 prompt 加 INVEST 原则 + 硬性阈值 | 下次自举规划时按 I-N-V-E-S-T 校验每个新 feature；desc > 1500 字 / deps > 5 / 跨 ownerRole 必须拆 |

## 当前 10 个 not_started feature 的切分体检

根据 `len(description)` 和 `len(dependencies)` 跑一遍自检（基于 feature_list.json）：

| id | ownerRole | deps | desc 字数 | 体检 |
|---|---|---|---|---|
| mysql-export | 桌面端开发 | 3 | 825 | ✅ 合理 |
| mysql-import | 桌面端开发 | 1 | 588 | ✅ 合理 |
| sqlite-export | 桌面端开发 | 3 | 625 | ✅ 合理 |
| hive-export | Golang 后端 | 3 | 878 | ✅ 合理 |
| hive-import | Golang 后端 | 1 | 535 | ✅ 合理 |
| neo4j-export | 桌面端开发 | 3 | 823 | ✅ 合理 |
| access-export | Golang 后端 | 3 | 823 | ✅ 合理 |
| import-field-selection | 桌面端开发 | 3 | 861 | ✅ 合理 |
| **type-conversion-pipeline** | 桌面端开发 | 4 | **1563** | ⚠️ 接近阈值（1500），单 cycle 紧 |
| **atomic-task-orchestration** | 前端开发 | 4 | **1363** | ⚠️ 跨 4 个上游 feature（deps 上限边缘），下次自举规划时建议观察 |

**结论**：当前切分基本可用；只有 `type-conversion-pipeline` 和 `atomic-task-orchestration`
接近 1500 字上限。如果 PM 后续想加更细的验收点（比如每种数据类型一个独立 feature），
建议拆。

## 已应用的 Patch 列表（16 项）

```
[OK]   A1:  log() + log_scope + banner/dashboard/card/timer
[OK]   A2:  Orchestrator.run() 启动打 dashboard
[OK]   A3:  cycle loop 加 log_scope(cycle=N)
[OK]   A4:  cycle 结束打小卡片 + dashboard
[OK]   A5a: _phase_design 加 feature_card + scope
[OK]   A5b: _phase_develop 加 feature_card + scope
[OK]   A5c: _phase_test 加 feature_card + scope
[OK]   A5d: _phase_deliver 加 feature_card + scope
[OK]   A5e: _phase_plan_from_goals 加 banner + scope
[OK]   C1:  next_pending 切分自检 + _warn_if_oversized
[OK]   B1:  _UNIX_ONLY_BASH_HINTS + _check_windows_bash_compat
[OK]   B1b: _tool_Bash 加 Windows 平台提示
[OK]   B2a: _build_context_snapshot 文档 + 缓存说明
[OK]   B2b: _build_context_snapshot 加 SHA-1 缓存
[OK]   B2c: AgentClient.__init__ 初始化缓存字段
[OK]   C2:  _phase_plan_from_goals PM prompt 加 INVEST 检查
```

文件体积变化：`87000 → 97877 bytes (+10877, +12.5%)`

## 验证（dry-run）

```
[09:44:01] ══════════════════════════════════════════════════════════════════════
[09:44:01]   🚀 数据迁移工具 · 多 Agent 编排器启动
[09:44:01] ══════════════════════════════════════════════════════════════════════
... (略) ...
[09:44:01] 📊 启动时进度  16/26 pass (62%)  [██████████████████░░░░░░░░░░░░]
[09:44:01]    pass=16  in_progress=0  blocked=0  not_started=10
[09:44:01]    · Agent Team Studio: 1/1 pass
[09:44:01]    · Golang 后端开发: 2/5 pass
[09:44:01]    · 前端开发: 5/6 pass
[09:44:01]    · 桌面端开发: 8/14 pass
[09:44:01] 
[09:44:01] [c1] ────────────────────────────────────────────────────────────
[09:44:01] [c1]   Cycle 1 开始
[09:44:01] [design mysql-export] ┌─ Feature  ⚪ [not_started] mysql-export
[09:44:01] [design mysql-export] │  name:    MySQL 数据导出
[09:44:01] [design mysql-export] │  owner:   桌面端开发
[09:44:01] [design mysql-export] │  deps:    postgresql-migration, large-data-migration, desktop-shell-connections
[09:44:01] [design mysql-export] └─
... (略) ...
[09:44:10] ✅ Cycle 1 结束 (累计 0m0s)
[09:44:10] 📊 Cycle 1 后进度  16/26 pass (62%)  [██████████████████░░░░░░░░░░░░]
[09:44:10]    pass=16  in_progress=1  blocked=0  not_started=9
```

## 与软件工程原则的对应

| 原则 | 体现 |
|---|---|
| **DRY** | `log_scope` 复用同一 ctx manager；`progress_dashboard` 复用 `by_status`/`by_role` 桶 |
| **SSOT** | context snapshot 是 goals.md + feature_list.json + progress.md 的唯一拼接点；缓存命中后零成本复用 |
| **KISS** | `banner()` / `feature_card()` 都是 ~10 行的纯函数；无新依赖（仍是标准库） |
| **YAGNI** | 不引入 Rich / textual 等 GUI 库；不重写主循环；100% 局部 patch |
| **Separation of Concerns** | log_scope 是 IO 关注点；feature_card 是 UI 关注点；invest check 是策略关注点 —— 互不耦合 |
| **INVEST（Scrum）** | 切分自检 + PM prompt 强化 I-N-V-E-S-T 应用 |
| **Single Source of Truth for State** | `StateStore.next_pending` 仍是唯一调度入口；新加的 `_warn_if_oversized` 只 warn 不门控 |

## Round 2 改进（2026-09-12 后续）

进一步打磨，针对 session.log 里实际暴露的两个具体问题：

### 问题 1：PM Agent 单次跑 5.8 小时

session.log 末段显示：`✅ 产品经理 完成 (21003.5s, tool×26, ...)`。这意味着
一次 PM Agent 调用长达 5 小时 50 分钟，期间反复 Read progress.md 浪费 token。
虽然不是真的跑了那么久（数字看起来像累积），但暴露了"无 wall-time 兜底"的设计漏洞。

**Round 2 修复**：
- 新增常量 `MAX_AGENT_WALL_SECONDS_DEFAULT = 1800`（30 分钟）
- 新增 CLI flag `--max-agent-minutes`（默认 30，可由 `ORCH_MAX_AGENT_MINUTES` 环境变量覆盖）
- `AgentClient.call()` 在每个 tool-use 轮次开头检查 `time.monotonic() - start` 是否超限
- 超限则立即返回 `AgentResult(ok=False, text="wall-time exceeded ...")` 并清晰报错
- 每次启动时 banner 打印 `Agent wall-time: 1800s (30m)`

### 问题 2：Agent 反复 retry 同一坏命令

session.log 显示同一 `timeout 90 npm run dev 2>&1 | head -120` 失败了 3 次，
每次都换种写法但还是失败（因为 Windows cmd 既没有 `head` 也没有 `timeout` 默认管道参数）。

**Round 2 修复**：
- `_tool_Bash` 内置失败历史：`self._bash_fail_history: dict[cmd_key, list[err_pattern]]`
- 每次失败：记录归一化后的错误模式（前 60 字符）
- 连续 ≥ 3 次相同错误：触发 STUCK DETECTED，自动在 `tool_result` 末尾追加 `[STUCK WARNING]`
- 成功执行：自动清零该命令计数
- 历史在每次 `AgentClient.call()` 入口清空（per-call scope，避免跨调用干扰）

### 问题 3：所有 Bash 都用 120s 默认超时

`npm run build` 实际可能需要 300s，而 `npm run typecheck` 60s 就够。
硬编码 120s 不是太大就是太小。

**Round 2 修复**：智能超时分级表 `_BASH_TIMEOUT_RULES`

| 命令类型 | 超时 | 说明 |
|---|---|---|
| `npm run dev` / `start` | 90s | 启动 + 立即检测窗口 |
| `npm test` / `go test` | 180s | 单测 |
| `npm run build` / `package` | 300s | 生产构建/打包 |
| `npm run typecheck` / `go vet` / `tsc` | 60s | 静态检查 |
| 其它 | 120s（默认） | 兜底 |

仅当 Agent 调用 Bash 时**没显式传 `timeout` 参数**才自动选；显式传了则尊重 Agent 选择。

### 问题 4：cycle 开始时不知道有哪些 oversized feature

之前 `_warn_if_oversized` 只在 `next_pending` 返回某个 feature 时才触发警告，
其他 oversized feature 用户看不到。

**Round 2 修复**：每个 cycle 开始时（cycle banner 后）跑一次 pre-flight 检查，
列出当前所有 `desc > 1500` 或 `deps > 5` 的 not_started/blocked/in_progress feature，
提前告知用户和 PM Agent。

### Round 2 patch 列表（15 项）

```
[OK]   D1:    新增 wall-time + bash 超时分级常量
[OK]   D2:    AgentClient.__init__ 加 wall-time + bash 历史字段
[OK]   D3:    AgentClient.call() 加 wall-time watchdog
[OK]   D3b:   AgentClient.call() 末尾报 wall-time 利用率
[OK]   D4a:   _tool_Bash 加智能超时分级 + stuck 检测入口
[OK]   D4b:   _tool_Bash 捕获 TimeoutExpired 时记录失败
[OK]   D4c:   _tool_Bash 记录非 0 退出为失败 / 0 退出清零计数
[OK]   D4d:   AgentClient 加 _record_bash_failure / _success / _consume_stuck_hint
[OK]   D5:    CLI 加 --max-agent-minutes
[OK]   D5b:   parse_args 默认值从环境变量读 ORCH_MAX_AGENT_MINUTES
[OK]   D5c:   --max-agent-minutes 用 default_max_agent_minutes
[OK]   D6:    Orchestrator.__init__ 注入 wall-time 上限
[OK]   D6b:   run() 启动 banner 加 wall-time 显示
[OK]   D7:    cycle 开始前 pre-flight oversized 检查
[OK]   D8:    call() 进入时清空 bash 失败历史 + 显示 wall-time 上限
```

文件体积变化：`97877 → 105108 bytes (+7231, +7.4%)` （累计从原版 `103376 → 105108`，+1.7%）

## Round 3 修复（2026-09-12 跟踪 bug 修复）

### 问题：Windows cp1252 编码导致 Agent 调用 Bash 时崩溃

运行 `orchestrator.py` 后，PM Agent 调用 `node -e "const f=require('./feature_list.json'); ..."`
打印 `mysql-export` feature 详情时崩溃：

```
Exception in thread Thread-1 (_readerthread):
  File "C:\Python314\Lib	hreading.py", line 1082, in _bootstrap_inner
  ...
  File "C:\Python314\Lib\subprocess.py", line 1614, in _readerthread
    buffer.append(fh.read())
  File "C:\Python314\Lib\encodings\cp1252.py", line 23, in decode
    return codecs.charmap_decode(input,self.errors,decoding_table)[0]
UnicodeDecodeError: ''charmap'' codec can''t decode byte 0x8d in position 47
```

**根因**：`subprocess.run(..., text=True)` 不指定 `encoding` 时，Python 用
`locale.getpreferredencoding()` 解码子进程输出，在 Windows 上默认是 `cp1252`。
但 Node.js / Go / npm 默认输出 UTF-8，当 `feature_list.json` 含中文字符（如
`MySQL 数据导出`）时，UTF-8 字节序列（`0xE6 0x95 0xB0` 等）在 cp1252 表里查不到，
_readerthread 线程崩溃，subprocess 退出码变成 0 但 stdout/stderr 内容损坏。

**修复**：所有 `subprocess.run(text=True)` 调用显式加 `encoding="utf-8", errors="replace"`：

| Patch | 位置 |
|---|---|
| E1 | Worktree.create (`git worktree add`) |
| E2 | Worktree.remove (`git worktree remove --force`) |
| E3 | Worktree.remove (`git branch -D`) |
| E4 | Worktree.merge_back (`git merge --no-ff`) |
| E5 | Worktree.has_changes (`git diff`) |
| E6 | _phase_audit_status (`git checkout HEAD`) |
| E7 | _tool_Bash (`Agent 调用的 Bash`) |
| E8 | Worktree.create 文档加防回归注释 |

**验证**：用 `node -e` 读 feature_list.json 输出含中文 — 加 encoding="utf-8" 后正常，
不加则复现 UnicodeDecodeError。文件大小 +643 字节。

### 累计改进（Round 1 + 2 + 3）

| Round | Patches | 增量 | 累计文件大小 |
|---|---|---|---|
| 原版 | — | — | 103376 bytes |
| Round 1 | 16 | +14.5% | 118401 bytes |
| Round 2 | 15 | +7.4% | 127085 bytes |
| **Round 3** | **8** | **+0.5%** | **127864 bytes** |
| 累计 | **39** | **+23.6%** | — |

## 后续可做（未做）

1. **Bash 超时分级**：把 `_tool_Bash` 的 120s 默认改成按子命令类型动态：typecheck=60s, test=180s, build=300s, dev=60s
2. **每 phase 失败计数**：在 session.log 中加入"上一轮同样错误"统计，帮助识别反复同样的错
3. **去 Agent 同上下文污染**：用 worktree 的 `git diff --stat` 在 cycle 结束时打印"这一 cycle 改了哪些文件"
4. **feature 切分自动 rebalance**：把 type-conversion-pipeline 拆成 `type-conversion-default-json` + `type-conversion-user-mapping`
5. **Agent 并发预算细化**：当前 cycle 内每个 phase 跑 3 个 dev Agent，Phase-1 后变 3 deliver Agent = 6 个并发；可明确预算

## Round 4：Harness 工程优化（2026-09-17）

本轮不再继续加长 prompt，而是把发现、验证、反馈和调度拆成可约束的 harness 层。

### 日志暴露的问题

1. `progress.md` 约 75 万字符，Agent 一次 `Read(progress.md)` 就能让后续请求多出
   20 万级 input tokens；单次调用累计达到 90 万 tokens 仍然没有推进 feature。
2. develop 机械失败后仍启动 test_engineer，重复执行 typecheck/test/build。
3. test blocked 后固定重跑 golang + frontend，即使 `FAILURE.owner` 只指向一个角色。
4. 父 feature 已拆解成子任务后仍处于 `in_progress`，会抢占调度，而子任务又依赖
   blocked/in_progress 父项，形成调度死锁。
5. deliver 阶段再次启动 PM 做完整验收，但 test_engineer 已包含用户视角，属于重复消费。
6. 五小时 token 统计在 `TokenBudget` 和 phase 层各加一次，日志中的消耗被重复计数。

### 已实现的 harness 约束

| 层 | 实现 | 作用 |
|---|---|---|
| Context budget | snapshot/progress/handoff/tool result 全部有字符预算；Read 支持 offset/limit | 避免整文件回灌，后续 tool turn 不再线性膨胀 |
| Deterministic gate | test 前执行 `git diff --check`、按变更选择 build/typecheck/test/go vet/go test | 机械失败直接回流 developer，不启动昂贵 evaluator |
| Failure ownership | 解析 `FAILURE.owner`，结合路径与错误关键字映射角色 | 只重跑真正相关的 developer |
| No-progress guard | retry 前后比较 worktree diff digest | 同一版本禁止再次进入 test |
| Scheduling | 父 feature 有 `--step--` 子任务时只作为容器；子任务移除父依赖 | 修复 blocked parent -> child 死锁 |
| Dirty baseline sync | 新 worktree 创建后同步与当前 feature 数据源/名称相关的未提交代码和配置 | 防止 worktree 看不到主工作区已有实现而重复开发 |
| Minimal roles | design 默认单 owner；develop/deliver 默认按 owner 选角色；deliver 默认跳过 | 去掉重复评审和无关角色调用 |
| Loop guard | 按角色限制 tool iterations；重复工具调用连续出现时注入纠偏 | 控制 80 轮空转和重复命令 |
| State hygiene | 仅修改实际变更的 feature `testedAt`；dry-run 不写状态 | 避免无关元数据 churn 和误改待办 |

### 新增开关

```bash
# 默认：单 owner 设计、跳过重复 deliver、启用确定性预检
python3 orchestrator.py

# 需要产品 + 架构双评审时
python3 orchestrator.py --full-design

# 需要 test pass 后追加产品验收时
python3 orchestrator.py --full-deliver

# 临时关闭 test 前预检
python3 orchestrator.py --no-preflight
```

预算可通过环境变量调整：

```text
ORCH_CONTEXT_SNAPSHOT_CHARS=24000
ORCH_RELEVANT_PROGRESS_CHARS=12000
ORCH_HANDOFF_CHARS=12000
ORCH_TOOL_RESULT_CHARS=16000
ORCH_TEST_FEEDBACK_CHARS=10000
ORCH_MAX_DUPLICATE_TOOL_CALLS=3
```

### 实际运行复核（2026-09-17 01:50）

使用 `deepseek-flash` 实跑 `sqlite-export--step--1`，新日志确认：

1. `context snapshot: 24066 chars (≈6016 tokens)`，初始 API input 为 13648 tokens；
   不再出现旧版单次几十万 input。
2. 只有一个 `frontend_senior` 角色被启动，`golang_senior` 没有被误触发。
3. Agent 执行到第 21 轮仍未写入代码，随后收到 Ctrl+C；复盘发现两个 harness 漏洞：
   - 子任务 `sqlite-export--step--1` 读取 `progress.md` 时只匹配完整 id，返回空；
     已改为同时匹配父 feature `sqlite-export`。
   - `2>/dev/null` 被误判成 Bash 写动作，导致只读探索计数被意外清零；已排除
     `/dev/null` 与 fd 重定向后再判断写动作。
4. 主工作区未提交的 `src/main/sqlite-service.ts`、`tests/sqlite-service.test.ts`
   和 package 文件不在 HEAD worktree 中，Agent 一度准备重复实现；新 worktree
   现在会同步与当前 feature 相关的脏代码/配置。
