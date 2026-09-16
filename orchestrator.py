#!/usr/bin/env python3
"""
数据迁移工具 -- 多 Agent 编排脚本
====================================

按 feature_list.json 中的待办功能，自动调用角色 Agent 协作开发：

  产品经理 ─┐
           ├─> 设计 + 迭代协议
           │   （产品经理额外产出 UI demo：React 组件 / HTML+CSS 原型，
           │     直接交给前端开发）
           │
  Golang 资深工程师 ─┐
       （已合并原架构师职责）       ─┐
  前端资深工程师     ─┼─> 单功能开发（前端基于 PM 的 UI demo 实现；
           ─┘        Golang 同时承担：技术方案设计、任务拆解、
                    第一性原理重设计；基于统一数据转换引擎
                    Source→Normalize→Transform→Sink）
           │
  测试工程师 ─> 验证功能是否可用（已合并用户视角，独立判定 pass/blocked）
           │
  产品经理 ─> 交付反馈（仅写入 progress.md，不门控）

约束：
  * 默认串行执行 Agent；同一时间只运行一个角色
  * Token 每 5 小时重置一次；不足时阻塞等待
  * 单一 Agent 每次只接受一个功能点
  * 完成一个功能后立即停止

协作方式：
  所有 Agent 通过规则地图（feature_list.json / progress.md /
  session-handoff.md）同步状态。跨会话的工作交接、决策、验证证据、
  未完成事项和下一步统一以 session-handoff.md 为事实依据；每次调用只
  注入预算内的核心交接段，Agent 完成后必须更新对应段落。

依赖：
  Python 3.10+ 与 `anthropic` SDK。Agent 调用直接走 Anthropic Messages API，
  不经过 `claude` CLI。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import anthropic

# ============================================================================
# 常量与配置
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parent
FEATURE_LIST_FILE = PROJECT_ROOT / "feature_list.json"
PROGRESS_FILE = PROJECT_ROOT / "progress.md"
SESSION_LOG_DIR = PROJECT_ROOT / ".orchestrator"
SESSION_LOG_FILE = SESSION_LOG_DIR / "session.log"
APP_LOGS_ROOT = Path(".orchestrator/app-logs")
CHECKPOINTS_ROOT = Path(".orchestrator/checkpoints")
RETRY_CONTEXT_ROOT = Path(".orchestrator/retry-context")
SESSION_LOG_MAX_LINES = max(
    1000, int(os.environ.get("ORCH_SESSION_LOG_MAX_LINES", "50000"))
)
SESSION_LOG_TRIM_EVERY_WRITES = max(
    100, int(os.environ.get("ORCH_SESSION_LOG_TRIM_EVERY", "1000"))
)

# 约束
MAX_CONCURRENT_AGENTS = 1              # 默认串行；一次只运行一个 Agent，减少文件冲突
TOKEN_RESET_INTERVAL_HOURS = 5          # Token 重置周期

# Round 7: MiniMax-M3 支持 1M 上下文（input + output 合计）
MAX_INPUT_TOKENS = 1_000_000             # 单次调用 input 上下文上限（MiniMax-M3 模型）
MAX_OUTPUT_TOKENS = 524_288             # 单次 API 调用的 max_tokens 参数上限（保守值，避免单次输出过大）
PER_CALL_TOKEN_LIMIT = 1_000_000        # 单次调用 input + output 软监控阈值（≈ 1M；超限仅告警）
SOFT_TOKEN_LIMIT = 5_000_000            # 5h 周期内 token 上限（≈ 250 calls × 20K；保守值，留余量给突发）
CALLS_PER_5H_SOFT_LIMIT = 2_250         # Claude 调用 rate 监控（2250/5h；不强制阻塞）

# Round 8: per-minute 细粒度限制（滑动 60s 窗口）
# minimaxi 后台对单账号有限速，超出会被服务端 429 拒绝
# 主动 sleep 等到能容纳新请求再发，避免被服务端拒绝
RPM_LIMIT = 200                          # 每分钟最多 200 次请求
TPM_LIMIT = 10_000_000                   # 每分钟最多 10M tokens（input + output 合计）
RATE_LIMIT_WINDOW_SEC = 60               # 滑动窗口长度
AGENT_TIMEOUT_SECONDS = 1800            # 单次 Messages API 请求的服务端 timeout
# Round 5: per-request 硬性超时（防 minimax.cn 代理关闭连接但 aiohttp 不超时）
# 上次事故：单次 API 调用 hang 28 分钟无响应（CLOSE_WAIT 残留），
# 因为 anthropic SDK 的 timeout= 没传到 httpx 的 ClientTimeout.total
# 解决：对每次 messages.create 用 asyncio.wait_for 强制 cancel。
AGENT_REQUEST_TIMEOUT_SEC = 120

# MiniMax Token Plan 配额耗尽不是普通瞬时错误；命中后统一暂停并定期探测。
TOKEN_PLAN_RETRY_INTERVAL_SEC = 15 * 60
_TOKEN_PLAN_LIMIT_MARKERS: tuple[str, ...] = (
    "已达到 Token Plan 用量上限",
    "Token Plan usage limit",
    "Token Plan limit reached",
)


def _is_token_plan_usage_limit(text: str | None) -> bool:
    """判断 AgentResult 是否来自 Token Plan 配额耗尽（MiniMax 2056）。"""
    if not text:
        return False
    if any(marker.lower() in text.lower() for marker in _TOKEN_PLAN_LIMIT_MARKERS):
        return True
    return "2056" in text and "token plan" in text.lower()

# 开发-测试 重试策略
MAX_DEV_TEST_ATTEMPTS = 3               # 同一方案最多尝试 3 次
MAX_RETHINK = 2                         # 最多重设计 2 次（即 1+2=3 个方案）

# Harness 预算：限制每次 Agent 看到/回灌的上下文，避免单次 tool-use
# 把整份 progress.md / 大段命令输出重复送入模型。
MAX_CONTEXT_SNAPSHOT_CHARS = max(
    8_000, int(os.environ.get("ORCH_CONTEXT_SNAPSHOT_CHARS", "24000"))
)
MAX_RELEVANT_PROGRESS_CHARS = max(
    4_000, int(os.environ.get("ORCH_RELEVANT_PROGRESS_CHARS", "12000"))
)
MAX_HANDOFF_CHARS = max(
    4_000, int(os.environ.get("ORCH_HANDOFF_CHARS", "12000"))
)
MAX_TOOL_RESULT_CHARS = max(
    4_000, int(os.environ.get("ORCH_TOOL_RESULT_CHARS", "16000"))
)
MAX_TEST_FEEDBACK_CHARS = max(
    4_000, int(os.environ.get("ORCH_TEST_FEEDBACK_CHARS", "10000"))
)
MAX_DUPLICATE_TOOL_CALLS = max(
    2, int(os.environ.get("ORCH_MAX_DUPLICATE_TOOL_CALLS", "3"))
)

_ROLE_TOOL_ITERATION_LIMITS: dict[str, int] = {
    "product_manager": 24,
    "golang_senior": 48,
    "frontend_senior": 48,
    "test_engineer": 56,
}

# Round 2: 单 Agent 调用的 wall-time 上限（硬性兜底，防 PM Agent 跑 5h+）
# 默认 30 分钟；可由 CLI --max-agent-minutes 覆盖
MAX_AGENT_WALL_SECONDS_DEFAULT = 1800

# Round 2: Bash 命令智能超时（按子命令类型）
# 顺序敏感：更具体的 pattern 排前面
_BASH_TIMEOUT_RULES: tuple[tuple[re.Pattern[str], int], ...] = (
    (re.compile(r"\bnpm\s+run\s+(dev|start)\b"), 90),     # dev server：启动 + 立即检测窗口出现
    (re.compile(r"\bgo\s+test\b"), 180),                  # Go test
    (re.compile(r"\bnpm\s+test\b"), 180),                 # vitest
    (re.compile(r"\bnpm\s+run\s+build\b"), 300),           # 生产构建
    (re.compile(r"\bnpm\s+run\s+(package|dist)\b"), 300), # 打包
    (re.compile(r"\bnpm\s+run\s+(typecheck|check|lint|vet:go|vet)\b"), 60),
    (re.compile(r"\b(tsc|go\s+vet|golangci-lint|eslint|vitest)\b"), 60),
    (re.compile(r"\bdocker\s+(pull|compose\s+up|run)\b"), 600),
    (re.compile(r"\bdocker\s+(exec|start|restart|inspect|logs)\b"), 180),
    (re.compile(r"\b(?:pip|pip3)\s+install\b"), 300),
    (re.compile(r"\bpython3?\s+-m\s+venv\b"), 180),
)
_BASH_DEFAULT_TIMEOUT = 120  # 其它命令的默认超时
_DIRECT_DEV_COMMAND_PATTERN = re.compile(
    r"\bnpm\s+run\s+(?:dev|start)\b"
)

# Round 2: 同命令连续失败阈值（连续 N 次同样错误，提示 Agent 换方案）
_STUCK_FAILURE_THRESHOLD = 3

# Round 3: 「探索循环」检测 —— 连续 N 轮 tool-use 没有实际写动作。
# 12 轮先注入纠偏提示，16 轮仍无写动作则直接终止本次 Agent 调用，
# 避免一路打满 MAX_TOOL_ITERATIONS。
READ_ONLY_STUCK_THRESHOLD = 12
READ_ONLY_HARD_STOP = 16

_BASH_WRITE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(^|[^>])>>?\s*[^&]"),
    re.compile(r"<<\s*['\"]?\w+"),
    re.compile(r"\b(tee|touch|mkdir|cp|mv|rm|truncate|apply_patch)\b"),
    re.compile(r"\bsed\s+-i\b"),
    re.compile(r"\bgit\s+apply\b"),
    re.compile(r"\b(?:npm|pnpm|yarn)\s+(?:install|add|remove)\b"),
    re.compile(r"\bgo\s+mod\s+(?:tidy|edit)\b"),
)


def _bash_command_may_write(cmd: str) -> bool:
    """Bash 写文件/依赖的常见模式；用于避免把实际写动作误判成探索循环。"""
    sanitized = re.sub(
        r"(?<!\S)\d?>\s*/dev/null\b", " ", cmd
    )
    sanitized = re.sub(r"\b\d?>&\d+\b", " ", sanitized)
    return any(pattern.search(sanitized) for pattern in _BASH_WRITE_PATTERNS)

# Round 3: MAX_TOOL_ITERATIONS 轮跑满且仍 stop_reason=tool_use，
# 说明 Agent 没写完；这种情况必须显式标 ok=False（任务中断）
# 而非当前实现里的"自然退出" ok=True。

# Git worktree 与开发者约束（Phase-1）
# developer 角色禁止自提交（必须由 test_engineer 验证后再由编排器合并）
_FORBIDDEN_BASH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgit\s+commit\b"),
    re.compile(r"\bgit\s+push\b"),
    re.compile(r"\bgit\s+merge\b"),
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    re.compile(r"\bgit\s+rebase\s+-i\b"),
    re.compile(r"\bgit\s+branch\s+-D\b"),
)

# Unix-only bash 模式（Windows cmd 下大概率失败；PowerShell 才是默认 shell）。
# 给 Agent 友好提示而非硬拦截 —— Agent 可能已经知道用 Start-Process 等替代方案。
_UNIX_ONLY_BASH_HINTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bhead\s+-[nc]?\s*\d"),
     "Windows cmd 没有 head。用 PowerShell: Get-Content <file> | Select-Object -First N"),
    (re.compile(r"\btail\s+-[nc]?\s*\d"),
     "Windows cmd 没有 tail。用 PowerShell: Get-Content <file> -Tail N"),
    (re.compile(r"\bgrep\s+-r?\b"),
     "Windows cmd 没有 grep -r。用 PowerShell: Select-String -Path <path> -Pattern <pat>"),
    (re.compile(r"\|\s*head\b"),
     "管道 head 在 Windows cmd 不可用。请去掉 head 或改用 PowerShell 等价物"),
    (re.compile(r"\|\s*tail\b"),
     "管道 tail 在 Windows cmd 不可用"),
    (re.compile(r"\btimeout\s+\d+\s"),
     "Windows cmd 的 timeout 与管道 default option 不兼容。用 PowerShell: Start-Process -PassThru | Stop-Process"),
    (re.compile(r"\bwc\s+-l\b"),
     "Windows cmd 没有 wc -l。用 PowerShell: (Get-Content <file>).Count"),
    (re.compile(r"\bsed\s+-i\b"),
     "Windows cmd 没有 sed -i"),
    (re.compile(r"\bawk\s+"),
     "Windows cmd 没有 awk"),
    (re.compile(r"\bxargs\b"),
     "Windows cmd 没有 xargs"),
    (re.compile(r"\bcurl\s+-X\s+POST\b.*-d\s+@"),
     "Windows cmd 的 curl POST -d @file 在双引号转义上有坑；考虑用 PowerShell Invoke-RestMethod"),
)


def _check_windows_bash_compat(cmd: str) -> str | None:
    """Windows cmd 下检测 Unix-only 命令；返回第一条匹配的提示文本，否则 None。"""
    if sys.platform != "win32":
        return None
    for pat, hint in _UNIX_ONLY_BASH_HINTS:
        if pat.search(cmd):
            return hint
    return None
# developer 角色禁止直接编辑 feature_list.json（防止自评通过）
_PROTECTED_PATHS_FOR_DEVELOPER: tuple[str, ...] = ("feature_list.json",)

WORKTREES_ROOT = ".orchestrator/worktrees"   # git worktree 输出根
LOCKS_ROOT = ".orchestrator/locks"           # per-feature 文件锁根
DEFAULT_BASE_BRANCH = "HEAD"                 # feature/* 分支从当前所在分支拉
                                             # （项目无 master；用 HEAD 让
                                             # 编排器在哪个分支跑就从哪个分支拉）
ORCHESTRATOR_STATE_FILES: tuple[str, ...] = (
    "feature_list.json",
    "progress.md",
    "goals.md",
    "session-handoff.md",
)

HANDOFF_RULES = (
    "\n\n【session-handoff.md 交接规则】\n"
    " 1. 在说明上一会话完成了什么、为什么这样做、验证结果是什么、"
    "还有哪些阻塞和下一步做什么时，**必须以 `session-handoff.md` 为唯一事实依据**；"
    "不要只依赖记忆、聊天记录、progress.md 摘要或其他 Agent 的口头描述。\n"
    " 2. `session-handoff.md` 是工作交接事实源；`feature_list.json` 仍是机器可读的"
    "功能状态与依赖调度源。两者冲突时，先核对代码、测试和命令证据，再修正"
    "`session-handoff.md` 并同步必要的状态文件。\n"
    " 3. 开始本角色工作前，先确认快照中的 `## Current Objective`、"
    "`## Completed This Session`、`## Verification Evidence`、"
    "`## Decisions Made`、`## Blockers / Risks`、`## Next Session Startup`；"
    "若信息缺失或与本轮任务冲突，先 Read 并核实该文件。\n"
    " 4. 完成本角色工作后，必须更新 `session-handoff.md` 中与本角色相关的段落："
    "完成项、验证证据、文件变更、决策、阻塞和下一步。只写可追溯事实，"
    "命令需保留结果，禁止把未验证的推测写成已完成。\n"
    " 5. 保留历史事实并做精确增量更新；不要删除仍有效的决策、证据或阻塞，"
    "也不要整文件重写导致其他角色的交接丢失。\n"
    " 6. `session-handoff.md` 属于编排状态文件，始终读写主工作区，"
    "不得写进 feature worktree，也不得混入 feature 代码提交。\n"
)

# 纵向交付顺序：一个数据源完成后再进入下一个，避免规划时把所有目标一次性展开。
DATASOURCE_DELIVERY_ORDER: tuple[str, ...] = (
    "mysql",
    "sqlite",
    "access",
    "neo4j",
    "hive",
)
DATASOURCE_REQUIRED_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "mysql": ("export", "import"),
    "sqlite": ("export",),
    "access": ("export",),
    "neo4j": ("export",),
    "hive": ("export", "import"),
}


def _is_orchestrator_state_path(path: str) -> bool:
    """状态文件留在主工作区，不进入 per-feature 代码提交。"""
    normalized = path.replace("\\", "/")
    return normalized in ORCHESTRATOR_STATE_FILES


def _datasource_of_feature_id(feature_id: str) -> str | None:
    """从 feature id 识别它属于哪个数据源。"""
    for datasource in DATASOURCE_DELIVERY_ORDER:
        if feature_id == datasource or feature_id.startswith(f"{datasource}-"):
            return datasource
    return None


def _feature_requires_real_docker(feature_id: str) -> bool:
    """数据库/网络连接器类 feature 必须使用真实 Docker 环境验证。"""
    normalized = feature_id.lower()
    markers = (
        "mysql", "postgres", "elasticsearch", "neo4j",
        "hive", "access", "oracle", "database", "connector",
    )
    return any(marker in normalized for marker in markers)


def _current_datasource_from_statuses(statuses: dict[str, str]) -> str | None:
    """按固定纵向顺序计算第一个尚未完成的 required 数据源。"""
    for datasource in DATASOURCE_DELIVERY_ORDER:
        for capability in DATASOURCE_REQUIRED_CAPABILITIES[datasource]:
            feature_id = f"{datasource}-{capability}"
            if statuses.get(feature_id) != "pass":
                return datasource
    return None


def _filter_feature_payload(raw: dict[str, Any]) -> dict[str, Any]:
    """裁剪 feature_list：只暴露已完成项和当前数据源，隐藏未来源。"""
    all_feats = list(raw.get("features", []))
    active_datasource = _current_datasource_from_statuses({
        str(f.get("id", "")): str(f.get("status", ""))
        for f in all_feats
    })
    if active_datasource is None:
        visible = all_feats
    else:
        active_index = DATASOURCE_DELIVERY_ORDER.index(active_datasource)

        def keep(feature: dict[str, Any]) -> bool:
            source = _datasource_of_feature_id(str(feature.get("id", "")))
            if source is None:
                return feature.get("status") == "pass"
            return DATASOURCE_DELIVERY_ORDER.index(source) <= active_index

        visible = [f for f in all_feats if keep(f)]
    filtered = dict(raw)
    filtered["features"] = visible
    return filtered

# 角色定义（按 AGENTS.md 规则地图中的角色映射）
ROLES: dict[str, dict[str, str]] = {
    "product_manager": {
        "label": "产品经理",
        "kind": "planner",
        "system_prompt": (
            "你是「数据迁移工具」项目的【产品经理】。\n"
            "\n"
            "【桌面产品自主设计约束】（每次设计新功能 / 产出 UI demo 时必读）\n"
            "\n"
            "你负责自主设计桌面产品。好设计不是移动端放大，也不是功能堆叠；"
            "而是在大屏、键鼠、多窗口、长时间、专业任务环境中，让用户以更低认知与操作成本，"
            "可靠、高效、可控地完成核心任务，并愿意长期使用。\n"
            "\n"
            "【总目标】效率 + 掌控感 + 可靠性 + 一致性 + 可访问性 + 愉悦感。  \n"
            "把复杂留给自己，把掌控交给用户。\n"
            "\n"
            "【决策优先级】用户目标 > 可靠与安全 > 效率 > 一致性 > 可扩展 > 美观。  \n"
            "可访问、隐私、安全、性能是底线，不可为美观或速度牺牲。\n"
            "\n"
            "【硬约束】（必须严格遵守）\n"
            "- **目标导向**：先问用户要完成什么，再决定功能与界面；"
            "围绕工作流组织，不围绕功能模块堆砌。\n"
            "- **效率优先**：少点击、少跳转、少等待；"
            "支持快捷键、命令面板、批量、多选、拖拽、右键菜单。\n"
            "- **信息密度合理**：大屏可承载高密度，但必须有层级、分组、对齐、留白；"
            "密集不等于混乱。\n"
            "- **一致可预期**：术语、图标、按钮位置、交互方式一致；"
            "遵循平台惯例，如 Windows Fluent、macOS HIG。\n"
            "- **可控可逆**：支持撤销/重做、取消、历史、自动保存、版本恢复；"
            "危险操作要确认，但不滥用弹窗。\n"
            "- **状态可见**：保存、同步、加载、错误、离线、权限、长任务进度必须清晰；"
            "长任务可取消、可后台。\n"
            "- **多任务顺畅**：支持多窗口、标签页、分屏、工作区、拖放、剪贴板、最近文件。\n"
            "- **性能可靠**：启动快、响应快、不卡顿、不崩溃；"
            "长任务不阻塞界面；崩溃后可恢复。\n"
            "- **可访问**：全键盘操作、焦点清晰、屏幕阅读器可用、对比度足够、"
            "支持缩放、高对比、减少动画。\n"
            "- **可定制可扩展**：布局、主题、快捷键、工作区可调；"
            "支持插件、API、脚本、系统集成。\n"
            "- **美学服务功能**：美观不牺牲效率；视觉应诚实、克制、细致，"
            "服务于信息层级与品牌气质。\n"
            "\n"
            "【设计理念】目标导向、工作流中心、新手可发现、专家可高效、"
            "直接操作、渐进披露、识别优于回忆、用户控制、预防错误优于错误提示、"
            "灵活性与效率、信息层级、性能与隐私安全、可扩展生态、美学服务功能。\n"
            "\n"
            "【设计流程】\n"
            " 1. 明确用户、目标、场景、核心任务与成功指标。\n"
            " 2. 定义核心工作流与主路径，先主路径后边界情况。\n"
            " 3. 先结构后视觉，先默认后配置，先平台惯例后品牌表达。\n"
            " 4. 设计完整状态：空、加载、错误、离线、同步、权限、长任务、完成。\n"
            " 5. 检查键盘、可访问、性能、隐私、安全、恢复与冲突解决。\n"
            " 6. 自检并迭代，明确权衡与取舍。\n"
            "\n"
            "【禁止】移动端直接放大；功能堆砌；隐藏关键操作；不可逆且无恢复；"
            "操作无反馈；滥用弹窗；为极简牺牲效率；忽略平台惯例；"
            "忽略离线、同步、大数据、可访问性与隐私安全。\n"
            "\n"
            "【自检清单】（产出 UI demo 后必须过一遍）\n"
            "  - 新用户能否几分钟内完成核心任务？\n"
            "  - 专家能否全键盘高效操作？\n"
            "  - 误操作能否撤销或恢复？\n"
            "  - 关闭再打开，状态是否保留？\n"
            "  - 多窗口、多任务、拖拽是否顺畅？\n"
            "  - 大列表、大数据量是否不卡？\n"
            "  - 空状态、加载、错误、离线是否有清晰反馈？\n"
            "  - 是否遵循平台惯例与可访问性？\n"
            "  - 是否可定制、可扩展，但不增加理解负担？\n"
            "\n"
            "【项目背景】\n"
            "本项目是「数据迁移工具」桌面应用（Electron + React + TypeScript + Golang）：\n"
            "  - **形态**：桌面端（非 web 非 mobile），用户是数据工程师/分析师，"
            "需要长时间在键鼠+多窗口环境下做异构数据迁移；\n"
            "  - **核心任务**：连接多种数据源（MySQL/Postgres/ES/SQLite/Hive/Neo4j/Access）→ "
            "通过统一数据转换引擎 → 导入到目标库；\n"
            "  - **用户画像**：专业用户，要效率、要可控、要可观察；"
            "不能给消费级 App 那种引导式 UI。\n"
            "\n"
            "——\n"
            "\n"
            "**核心职责**：\n"
            "  A. 读取 feature_list.json 中的当前待办功能；定义用户故事、"
            "验收标准与优先级；协调产品节奏。\n"
            "  B. **产出 UI demo（关键职责！已合并原 UI 工程师工作）**：\n"
            "     对每个需要 UI 落地的功能，必须在 progress.md 的 \\n"
            "`## Design :: {feature_id}` 段中，"
            "**附上一段可直接复用/改造的 UI demo 代码**（React + TSX + CSS 片段，"
            "或最小可运行的 HTML+CSS 原型），"
            "前端工程师会**基于这个 demo 直接实现**，不再单独跑 UI 工程师。\n"
            "     UI demo 要求：\n"
            "       - 关键交互路径必须可见（按钮、输入、列表、状态切换）；\n"
            "       - 视觉风格与现有项目保持一致（看现有 src/renderer/src/pages/ 找参考）；\n"
            "       - 给出组件拆分建议（哪个是容器、哪个是展示组件）；\n"
            "       - 给出关键状态字段（loading / error / data 等）；\n"
            "       - demo 代码可直接复制到 src/renderer 下编译运行。\n"
            "约束：\n"
            " 1. 只允许选择一个当前最高优先级、尚未开发的功能作为下一交付单元；\n"
            " 2. 必须把决策结果写入 feature_list.json 中对应功能的 status、notes 字段；\n"
            " 3. 与架构师通过 progress.md 同步你的产品决策；\n"
            " 4. 在交付/验收阶段，必须**通过 RunApp 启动真实应用**验证用户体验：\n"
            "    `RunApp(action='start')` 启动 Electron，"
            "`RunApp(action='status')` 查看启动/运行日志，"
            "从用户视角描述在 UI 中看到的内容、"
            "    操作流程是否顺畅、错误信息是否可读，再给出 accept/reject。\n"
            "工作流：读取 feature_list.json / progress.md，"
            "围绕下一个待办功能给出交付设计（含 UI demo）。"
        ),
    },
    "golang_senior": {
        "label": "Golang 资深工程师 / 架构设计",
        "kind": "developer",
        "system_prompt": (
            "你是「数据迁移工具」项目的【Golang 资深工程师 / 架构设计】（已合并原『架构师』角色）。\n"
            "\n"
            "【双重职责】\n"
            "  A. 实现并演进统一的【数据转换引擎】架构，"
            "所有数据迁移功能都必须基于这套引擎实现，而非各写各的。\n"
            "  B. **承担架构设计工作**（已合并原架构师职责）：\n"
            "     - **技术方案设计**（design 阶段）：在 PM 之后串行执行，"
            "为每个 feature 定义技术方案、模块边界、接口契约；\n"
            "     - **任务拆解**（3 次失败后）：把大 feature 拆成 2-4 个独立可验证的子任务；\n"
            "     - **第一性原理重设计**（rethink 阶段）：用最简化原则重做方案；\n"
            "     - **架构风险识别**：每个 feature 必须明确 ownerRole、依赖、技术风险。\n"
            "\n"
            "\n"
            "【数据转换引擎架构】ETL 三段式：\n"
            "\n"
            "    Source ──> Normalize ──> Transform ──> Sink\n"
            "      │            │            │          │\n"
            "      ▼            ▼            ▼          ▼\n"
            "   数据源连接器   归一化中间     类型/格式   目标连接器\n"
            "   （mysql/       Record       转换规则   （ES/\n"
            "    postgres/    统一格式                   postgres/\n"
            "    es/sqlite/                              hive/\n"
            "    hive/                                   mysql）\n"
            "    neo4j/\n"
            "    access）\n"
            "\n"
            "【设计原则】\n"
            " 1. **统一中间格式（Normalize）**：所有 Source 读出的数据归一化为同一 Record\n"
            "    （如 `Record{Schema, Values map[string]any, Meta}`），\n"
            "    Sink 不直接接 Source —— 永远走 Normalize + Transform 中转。\n"
            " 2. **类型转换规则（Transform）**：\n"
            "    - 类型兼容的字段直接透传（如 int32 ↔ int64）；\n"
            "    - 类型不兼容的字段**默认转 JSON 字符串**（目标库需要时再反序列化）；\n"
            "    - 支持用户通过 type-mapping 配置**显式指定转换规则**\n"
            "      （如 `date:timestamp`、`varchar(20):varchar(50)`、`bytes:base64`）。\n"
            " 3. **可组合 / 原子化**：\n"
            "    - Source / Transform / Sink 都是独立接口；\n"
            "    - 每个接口可独立单测（mock 出 Record 流）；\n"
            "    - dispatcher 负责把它们按 pipeline 串起来。\n"
            " 4. **agent-friendly**：\n"
            "    - 所有操作暴露 CLI / IPC / JSON 配置三种入口；\n"
            "    - 一个 pipeline 可由 JSON 描述（source → transforms → sink），\n"
            "      agent 可在不重新编译的情况下组合新流程。\n"
            "\n"
            "【现有模块复用指引】\n"
            "  - `golang/esmigrator`：Elasticsearch Source/Sink（scroll/search_after、bulk）；\n"
            "  - `golang/pgmigrator`：Postgres/MySQL Source/Sink（COPY、流式 cursor）；\n"
            "  - `golang/dispatcher`：pipeline 编排器，串接 Source→Transform→Sink；\n"
            "  - 新增数据源时（如 sqlite/hive/neo4j/access）必须：\n"
            "    a) 实现对应的 Source 和/或 Sink 接口；\n"
            "    b) 输出归一化后的 Record；\n"
            "    c) 复用统一的 Transform 层处理类型转换。\n"
            "\n"
            "【硬性约束】\n"
            " 1. 每次会话【只接受一个功能】；不要并行多个；\n"
            " 2. **每次实现前先思考**：这个功能是不是已经在引擎里有原子化操作可以直接组合？\n"
            "    如果是，优先复用 + 编排；如果不是，新增 Connector/Transform 后纳入引擎；\n"
            " 3. 实现必须 `go vet ./...` + `go test ./...` 通过；\n"
            " 4. 新增 Connector/Transform 必须有单测：构造 mock Source，断言 Record 流正确；\n"
            " 5. 自测：除了 Go 测试，**还必须启动真实 Electron 应用验证集成层**——\n"
            "    `npm run build` 后跑 `RunApp(action='start')`，"
            "确认 Go 引擎通过 IPC 被调用，\n"
            "    端到端跑一遍当前新增的 Source/Sink；\n"
            " 6. feature_list.json 由编排器维护；不要写入 status（尤其是 pass）；\n"
            " 7. 进度写入 progress.md 的 `## Develop :: {feature.id}` 段，\n"
            "    **必须说明**：本次在引擎中复用了哪些原子操作、新增了哪些 Connector/Transform、"
            "类型转换规则如何处理；\n"
            " 8. 【不要自我评估】完成后用一行 `DONE` 表示代码写完即可。"
        ),
    },
    "frontend_senior": {
        "label": "前端应用资深开发工程师",
        "kind": "developer",
        "system_prompt": (
            "你是「数据迁移工具」项目的【前端资深开发工程师】。\n"
            "职责：负责 React + TypeScript 前端架构、状态管理、IPC 接入，"
            "以及 UI 视觉与交互的实现（UI 工程师已合并到产品经理，"
            "产品经理在 design 阶段会产出 UI demo，**你基于 demo 直接落地**）。\n"
            "硬性约束：\n"
            " 1. 每次会话【只接受一个前端功能】；\n"
            " 2. **基于设计契约实现**：先 Read progress.md 的 "
            "`## Design :: {feature_id}` 段；若包含 UI demo/组件契约则直接落地，"
            "若只有关键状态与交互契约，则按现有页面模式实现可编译组件 + IPC；\n"
            " 3. 必须保持 `npm run typecheck` 与 `npm test` 通过；\n"
            " 4. 跨进程边界（preload ↔ renderer ↔ main）使用既有安全 IPC 模式；\n"
            " 5. 自测必须启动真实应用：`RunApp(action='start')` 启动 Electron，"
            "    在运行窗口中确认 IPC 通道、React 状态、UI 联动都实际工作（必要时截图），"
            "    然后关闭应用；\n"
            " 6. feature_list.json 由编排器维护；不要写入 status；\n"
            "    pass/blocked 由 test_engineer 独立验证后由编排器收敛；\n"
            " 7. 修改完成后更新 progress.md 的 `## Develop :: {feature.id}` 段，"
            "    写明如何基于 PM 的 UI demo 实现；\n"
            " 8. 【不要自我评估】完成后用一行 `DONE` 表示代码写完即可。"
        ),
    },
    "test_engineer": {
        "label": "测试工程师",
        "kind": "evaluator",
        "system_prompt": (
            "你是「数据迁移工具」项目的【测试工程师 / 验收人】。\n"
            "**核心职责：验证功能是否可用** —— 独立判断 developer 交付的功能\n"
            "在真实场景下能否真的跑起来、达到设计阶段定义的验收标准。\n"
            "你同时承担【双重身份】（已合并原『用户』角色）：\n"
            "  - 测试工程师视角：typecheck + 单测 + 集成 + build 验证；\n"
            "  - 最终用户视角：在运行的 Electron 中实际操作，验证真实场景可用性、\n"
            "    界面清晰度、错误信息可读性；\n"
            "判定时**两个视角都要走一遍**，任一不过都不能 pass。\n"
            "\n"
            "硬性约束：\n"
            " 1. 每次会话【只验证一个功能】；\n"
            " 2. **【唯一判定权】你是唯一的 pass/blocked 判定者** —— developer 禁止自评，"
            "他们的 self-claim 会被审计回滚；\n"
            " 3. **禁止 mock-as-pass**：mock/单测通过只能作为辅助，不能作为功能可用证据。"
            "数据库/网络能力必须使用真实 Docker 环境；可编写 Python 脚本写入真实测试数据；"
            "没有真实数据流验证时不得 pass；\n"
            " 4. 验证步骤：\n"
            "    - typecheck / unit tests / build；\n"
            "    - `docker pull` 获取镜像；`docker run -d` 启动真实依赖，"
            "等待 health/端口 ready；\n"
            "    - 唯一容器名、ephemeral label、20000-29999 端口；\n"
            "    - 创建 venv 并安装 Python DB 驱动，用种子脚本写入可识别数据；"
            "种子脚本放在 `.orchestrator/test-data/<feature-id>/seed.py`；\n"
            "    - 跑真实端到端 roundtrip，核对记录数、字段值和错误路径；\n"
            "    - `RunApp(action='start')` 启动真实 Electron，"
            "`RunApp(action='status')` 必须确认 state=running；\n"
            "    - `RunApp(action='eval', expression=...)` 在运行中的 renderer 里"
            "读取页面状态并实际操作 feature；仅看启动日志不算完成；\n"
            "    - 清理自己创建的容器并执行 `RunApp(action='stop')`；\n"
            " 5. 验证后必须更新 feature_list.json 中对应功能的 status 与 evidence；\n"
            " 6. 必须输出结构化结论：\n"
            "    RESULT: pass\n"
            "    VERIFICATION:\n"
            "      typecheck: pass\n"
            "      unit_tests: pass\n"
            "      build: pass\n"
            "      docker: pass 或 n/a（说明原因）\n"
            "      seed_data: pass 或 n/a（说明原因）\n"
            "      roundtrip: pass 或 n/a（说明原因）\n"
            "      electron: pass（必须由真实 start/status/eval 工具轨迹支撑）\n"
            "      mock: none\n"
            "    或：\n"
            "    RESULT: blocked\n"
            "    FAILURE:\n"
            "      step: ...\n"
            "      command: ...\n"
            "      exit_code: ...\n"
            "      expected: ...\n"
            "      actual: ...\n"
            "      log: ...\n"
            "      owner: frontend_senior / golang_senior\n"
            " 7. 【应用实测硬门禁】`RESULT: pass` 必须由编排器记录到真实的 "
            "`RunApp(start) → status(running) → eval` 工具调用；只在文本里写 "
            "`electron: pass`、只看日志或声称“应该可用”都会被拒绝并回流。\n"
            "\n"
            "判定心法：\n"
            "  - 单元测试 100% 通过 ≠ 功能可用（必须启动真实应用确认 UI/IPC/数据流真通了）；\n"
            "  - 编译通过 ≠ 功能可用（必须实际跑一遍核心交互路径）；\n"
            "  - 代码写完了 ≠ 功能可用（必须站在用户视角走一遍验收标准）。"
        ),
    },
}

# 状态机阶段顺序
PHASES: list[str] = [
    "design",       # 产品 + Golang 架构设计
    "develop",      # Golang + 前端
    "test",         # 测试工程师
    "deliver",      # 产品经理（架构师已合并）
]


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class Feature:
    """feature_list.json 中的一项功能。"""

    id: str
    name: str
    description: str
    status: str            # not_started / in_progress / blocked / pass
    evidence: str = ""
    dependencies: list[str] = field(default_factory=list)
    rup_phase: str = ""
    iteration: str = ""
    owner_role: str = ""
    notes: str = ""
    tested_at: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Feature":
        return cls(
            id=raw["id"],
            name=raw["name"],
            description=raw.get("description", ""),
            status=raw.get("status", "not_started"),
            evidence=raw.get("evidence", ""),
            dependencies=list(raw.get("dependencies", [])),
            rup_phase=raw.get("rupPhase", ""),
            iteration=raw.get("iteration", ""),
            owner_role=raw.get("ownerRole", ""),
            notes=raw.get("notes", ""),
            tested_at=raw.get("testedAt", ""),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "status": self.status,
            "evidence": self.evidence,
            "dependencies": self.dependencies,
            "rupPhase": self.rup_phase,
            "iteration": self.iteration,
            "ownerRole": self.owner_role,
            "testedAt": (
                self.tested_at
                or datetime.now().isoformat(timespec="seconds")
            ),
        }
        if self.notes:
            out["notes"] = self.notes
        return out


def _touch_feature(feature: Feature) -> None:
    """仅更新被编排器实际修改的 feature 时间戳。"""
    feature.tested_at = datetime.now().isoformat(timespec="seconds")


@dataclass
class AgentCall:
    """单次 Agent 调用的请求描述。"""

    role: str
    prompt: str
    feature_id: str | None = None
    worktree: str | None = None


@dataclass
class AgentResult:
    """单次 Agent 调用的结果。"""

    role: str
    ok: bool
    text: str
    usage: dict[str, int] = field(default_factory=dict)
    duration_sec: float = 0.0
    feature_id: str | None = None
    run_app_started: bool = False
    run_app_status_checked: bool = False
    run_app_ui_checked: bool = False


def _truncate_text(text: str, limit: int, *, label: str = "内容") -> str:
    """保留首尾并在中间标记截断，避免大输出污染后续上下文。"""
    if len(text) <= limit:
        return text
    head_chars = max(1, int(limit * 0.65))
    tail_chars = max(1, limit - head_chars)
    omitted = len(text) - head_chars - tail_chars
    return (
        text[:head_chars]
        + f"\n\n... [{label}已截断 {omitted} 字符；"
        "如确需更多内容，请用 Read 的 offset/limit 精确读取] ...\n\n"
        + text[-tail_chars:]
    )


def _normalize_agent_role(value: str) -> set[str]:
    """把 ownerRole / owner 文本映射到可执行的 Agent 角色。"""
    normalized = (value or "").strip().lower()
    if not normalized:
        return set()
    roles: set[str] = set()
    if any(token in normalized for token in ("golang", "go engine", "backend", "后端")):
        roles.add("golang_senior")
    if any(
        token in normalized
        for token in (
            "desktop", "electron", "frontend", "front-end", "ui",
            "renderer", "ipc", "桌面", "前端",
        )
    ):
        roles.add("frontend_senior")
    return roles


def _roles_for_feature(feature: "Feature") -> set[str]:
    """按 ownerRole 选最小角色集；未知 owner 才退回双角色。"""
    roles = _normalize_agent_role(feature.owner_role)
    if roles:
        return roles

    feature_id = feature.id.lower()
    if feature_id.startswith(("mysql-", "postgres", "access-", "hive-")) and (
        "golang" in feature_id or "engine" in feature_id
    ):
        return {"golang_senior"}
    return {"golang_senior", "frontend_senior"}


def _roles_from_changed_paths(paths: set[str]) -> set[str]:
    """根据实际改动路径补全角色，防止 ownerRole 漂移。"""
    roles: set[str] = set()
    for path in paths:
        normalized = path.replace("\\", "/")
        if normalized.startswith("golang/"):
            roles.add("golang_senior")
        elif normalized.startswith(("src/", "tests/", "scripts/")):
            roles.add("frontend_senior")
    return roles


def _extract_failure_owner(text: str) -> set[str]:
    """从 test_engineer 的结构化 FAILURE.owner 推断责任角色。"""
    roles: set[str] = set()
    for match in re.finditer(
        r"(?im)^\s*owner\s*:\s*(.+?)\s*$", text or ""
    ):
        roles.update(_normalize_agent_role(match.group(1)))
    if roles:
        return roles

    lowered = (text or "").lower()
    golang_markers = (
        "golang/", "go test", "go vet", "dispatcher", "connector",
        "sql 拼接", "数据库驱动", "引擎层",
    )
    frontend_markers = (
        "src/renderer", "src/main", "src/preload", "ipc", "react",
        "renderer", "ui ", "界面", "组件", "字段映射", "jsonl",
    )
    if any(marker in lowered for marker in golang_markers):
        roles.add("golang_senior")
    if any(marker in lowered for marker in frontend_markers):
        roles.add("frontend_senior")
    return roles


def _markdown_sections(text: str) -> list[tuple[str, str]]:
    """按二/三级标题切分 Markdown，返回 (heading, body)。"""
    matches = list(re.finditer(r"(?m)^#{2,3}\s+.+$", text or ""))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append((match.group(0).strip(), text[start:end].strip()))
    return sections


def _relevant_progress_excerpt(text: str, feature_id: str | None, limit: int) -> str:
    """提取当前 feature 的进度段，而不是把整份 progress.md 喂给模型。"""
    if not text:
        return "(无 progress.md)"
    if not feature_id:
        return _truncate_text(text, limit, label="progress.md")

    aliases = {feature_id.lower()}
    if "--step--" in feature_id:
        aliases.add(feature_id.split("--step--", 1)[0].lower())

    selected: list[str] = []
    for heading, body in _markdown_sections(text):
        if any(alias in heading.lower() for alias in aliases):
            selected.append(body)
    if not selected:
        selected = [
            body for heading, body in _markdown_sections(text)
            if heading.lower().startswith("## current state")
        ]
    if not selected:
        selected = [text]
    excerpt = "\n\n".join(selected)
    return _truncate_text(excerpt, limit, label=f"{feature_id} 相关 progress")


def _relevant_handoff_excerpt(text: str, feature_id: str | None, limit: int) -> str:
    """保留交接文件核心段，最多限制到预算内。"""
    if not text:
        return "(无 session-handoff.md)"
    if not feature_id:
        return _truncate_text(text, limit, label="session-handoff.md")

    aliases = {feature_id.lower()}
    if "--step--" in feature_id:
        aliases.add(feature_id.split("--step--", 1)[0].lower())

    wanted = {
        "current objective",
        "completed this session",
        "verification evidence",
        "decisions made",
        "blockers / risks",
        "next session startup",
    }
    selected: list[str] = []
    for heading, body in _markdown_sections(text):
        heading_lower = heading.lower().lstrip("# ").strip()
        if (
            heading_lower in wanted
            or any(alias in heading.lower() for alias in aliases)
        ):
            selected.append(body)
    excerpt = "\n\n".join(selected) if selected else text
    return _truncate_text(excerpt, limit, label="session-handoff.md")


@dataclass
class Worktree:
    """单个 feature 的隔离工作区。

    所有 git 命令走 subprocess.run([...], check=True)，不走 _tool_Bash
    —— 编排器自身需要 merge / discard，不应被 developer 黑名单误伤。
    """

    feature_id: str
    branch: str
    path: Path
    base_branch: str = DEFAULT_BASE_BRANCH
    base_revision: str | None = None

    @classmethod
    def for_feature(
        cls, root: Path, feature_id: str, base: str = DEFAULT_BASE_BRANCH,
    ) -> "Worktree":
        return cls(
            feature_id=feature_id,
            branch=f"feature/{feature_id}",
            path=root / WORKTREES_ROOT / feature_id,
            base_branch=base,
        )

    def create(self) -> None:
        """git worktree add -b <branch> <path> <base>

        注：本类的所有 subprocess.run 调用都显式 encoding="utf-8", errors="replace"，
        避免 Windows cp1252 默认编码在 git 输出含非 ASCII 字符时炸 UnicodeDecodeError。
        """
        root = self.path.parent.parent.parent
        # 如果路径已存在（上一轮重试），worktree 仍可继续使用
        if self.path.exists():
            if self.base_revision is None:
                result = subprocess.run(
                    [
                        "git", "-C", str(root), "merge-base",
                        self.base_branch, self.branch,
                    ],
                    check=False, capture_output=True, text=True,
                    encoding="utf-8", errors="replace",
                )
                if result.returncode == 0:
                    self.base_revision = result.stdout.strip()
            log(f"   ♻️  worktree 已存在: {self.path}")
            return
        if self.base_revision is None:
            result = subprocess.run(
                ["git", "-C", str(root), "rev-parse", self.base_branch],
                check=True, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            self.base_revision = result.stdout.strip()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "git", "worktree", "add", "-b", self.branch,
                str(self.path), self.base_revision,
            ],
            cwd=str(root),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        log(
            f"   🌿 创建 worktree: {self.path} @ {self.branch} "
            f"(base={self.base_branch})"
        )

    def _base_ref(self) -> str:
        """返回固定的 worktree 起点 commit，避免 HEAD 随功能提交移动。"""
        if self.base_revision:
            return self.base_revision
        root = self.path.parent.parent.parent
        result = subprocess.run(
            ["git", "-C", str(root), "merge-base", self.base_branch, self.branch],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        revision = result.stdout.strip() if result.returncode == 0 else ""
        return revision or self.base_branch

    def remove(self) -> None:
        """git worktree remove --force <path> + 删除分支"""
        root = self.path.parent.parent.parent
        if self.path.exists():
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(self.path)],
                cwd=str(root), check=False,
                capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
        subprocess.run(
            ["git", "branch", "-D", self.branch],
            cwd=str(root), check=False,
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )

    def _branch_changed_files(self) -> set[str]:
        root = self.path.parent.parent.parent
        result = subprocess.run(
            [
                "git", "-C", str(root), "diff", "--name-only",
                f"{self._base_ref()}..{self.branch}", "--",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def _main_changed_files(self) -> set[str]:
        root = self.path.parent.parent.parent
        changed: set[str] = set()
        commands = (
            ["git", "-C", str(root), "diff", "--name-only"],
            ["git", "-C", str(root), "diff", "--cached", "--name-only"],
            [
                "git", "-C", str(root),
                "ls-files", "--others", "--exclude-standard",
            ],
        )
        for command in commands:
            result = subprocess.run(
                command, check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            changed.update(
                line.strip()
                for line in result.stdout.splitlines()
                if line.strip()
            )
        return changed

    def changed_paths(self) -> set[str]:
        """返回本 feature 相对 base revision 的全部改动路径。"""
        if not self.path.exists():
            return set()
        root = self.path.parent.parent.parent
        changed: set[str] = set()
        commands = (
            ["git", "-C", str(self.path), "diff", "--name-only", "HEAD"],
            ["git", "-C", str(self.path), "diff", "--cached", "--name-only"],
            [
                "git", "-C", str(self.path),
                "ls-files", "--others", "--exclude-standard",
            ],
            [
                "git", "-C", str(root), "diff", "--name-only",
                f"{self._base_ref()}..{self.branch}", "--",
            ],
        )
        for command in commands:
            result = subprocess.run(
                command, check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            changed.update(
                line.strip()
                for line in result.stdout.splitlines()
                if line.strip() and not _is_orchestrator_state_path(line.strip())
            )
        return changed

    def diff_digest(self) -> str:
        """计算工作树改动摘要，用于检测 retry 是否真的产生进展。"""
        if not self.path.exists():
            return ""
        result = subprocess.run(
            [
                "git", "-C", str(self.path), "diff", "--binary", "HEAD",
            ],
            check=False, capture_output=True,
        )
        untracked = subprocess.run(
            [
                "git", "-C", str(self.path), "ls-files",
                "--others", "--exclude-standard",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        digest = hashlib.sha1(result.stdout)
        for path in sorted(
            p for p in untracked.stdout.splitlines()
            if p.strip() and not _is_orchestrator_state_path(p.strip())
        ):
            digest.update(path.encode("utf-8"))
            file_path = self.path / path
            with contextlib.suppress(OSError):
                digest.update(file_path.read_bytes())
        return digest.hexdigest()

    def _stash_overlapping_main_changes(self) -> str | None:
        """备份主工作区中会被 feature 分支覆盖的本地修改。"""
        overlap = sorted(self._main_changed_files() & self._branch_changed_files())
        if not overlap:
            return None
        root = self.path.parent.parent.parent
        message = (
            f"orchestrator backup before merging {self.branch} "
            f"at {datetime.now().isoformat(timespec='seconds')}"
        )
        result = subprocess.run(
            [
                "git", "-C", str(root), "stash", "push",
                "--include-untracked", "-m", message, "--", *overlap,
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            log(
                f"   ❌ 无法备份重叠的本地修改，merge 中止: "
                f"{result.stderr.strip()[:300]}"
            )
            return "__failed__"
        log(
            f"   📦 已将 {len(overlap)} 个重叠文件备份到 stash；"
            f"merge 将以 feature 最新提交为准"
        )
        for path in overlap[:10]:
            log(f"      · {path}")
        if len(overlap) > 10:
            log(f"      · ... 另有 {len(overlap) - 10} 个")
        ref = subprocess.run(
            [
                "git", "-C", str(root), "stash", "list",
                "-1", "--format=%gd",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        ).stdout.strip()
        return ref or "stash@{0}"

    def merge_back(self) -> bool:
        """优先 fast-forward 合并 feature 分支；返回是否成功。"""
        root = self.path.parent.parent.parent
        stash_ref = self._stash_overlapping_main_changes()
        if stash_ref == "__failed__":
            return False
        result = subprocess.run(
            ["git", "-C", str(root), "merge", "--ff-only", self.branch],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if result.returncode == 0:
            log(f"   ✅ merge --ff-only {self.branch} -> {self.base_branch}")
            if stash_ref:
                log(
                    f"   🗃️  旧主工作区修改保留在 {stash_ref}，"
                    f"如需查看: git stash show -p {stash_ref}"
                )
            return True

        # 集成分支在 feature 开发期间前进时无法 fast-forward；
        # 保留 --no-ff 兜底，但正常路径只产生 feature 自己的一个提交。
        log(
            "   ↪️  fast-forward 不可用，回退 merge --no-ff："
            f"{result.stderr.strip()[:200]}"
        )
        result = subprocess.run(
            [
                "git", "-C", str(root), "merge", "--no-ff", self.branch,
                "-m", f"merge: feature {self.feature_id} verified by test_engineer",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            log(
                f"   ❌ merge 失败: {result.stderr[:300]}"
            )
            if stash_ref:
                restore = subprocess.run(
                    ["git", "-C", str(root), "stash", "pop"],
                    check=False, capture_output=True, text=True,
                    encoding="utf-8", errors="replace",
                )
                if restore.returncode == 0:
                    log("   ↩️  merge 未完成，已恢复主工作区本地修改")
                else:
                    log(
                        f"   ⚠️ merge 失败且 stash 恢复冲突: "
                        f"{restore.stderr.strip()[:300]}"
                    )
            return False
        log(f"   ✅ merge --no-ff {self.branch} -> {self.base_branch}")
        if stash_ref:
            log(
                f"   🗃️  旧主工作区修改保留在 {stash_ref}，"
                f"如需查看: git stash show -p {stash_ref}"
            )
        return True

    def commit(self, feature_name: str = "", evidence: str = "") -> str | None:
        """提交当前 feature 的代码/测试/文档；返回短 commit hash，失败返回 None。

        每个 feature 只在 test_engineer 判定 pass 后调用一次。状态文件
        （feature_list.json / progress.md / goals.md / session-handoff.md）
        留在主工作区，避免把编排状态混入功能提交，也避免 fast-forward 时
        产生状态冲突。
        """
        if not self.path.exists():
            log(f"   ❌ 提交失败：worktree 不存在 {self.path}")
            return None

        status = subprocess.run(
            [
                "git", "-C", str(self.path), "status", "--porcelain",
                "--untracked-files=all",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if status.returncode != 0:
            log(f"   ❌ git status 失败: {status.stderr.strip()[:300]}")
            return None

        # 先排除状态文件；其它修改、未知文件都归入本次功能提交。
        add = subprocess.run(
            [
                "git", "-C", str(self.path), "add", "-A", "--", ".",
                ":(exclude)feature_list.json",
                ":(exclude)progress.md",
                ":(exclude)goals.md",
                ":(exclude)session-handoff.md",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if add.returncode != 0:
            log(f"   ❌ git add 失败: {add.stderr.strip()[:300]}")
            return None

        staged = subprocess.run(
            ["git", "-C", str(self.path), "diff", "--cached", "--name-only"],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        staged_files = [
            line for line in staged.stdout.splitlines()
            if line.strip() and not _is_orchestrator_state_path(line.strip())
        ]
        if staged.returncode != 0:
            log(f"   ❌ 检查 staged 文件失败: {staged.stderr.strip()[:300]}")
            return None
        if not staged_files:
            # worktree 可能已经在本轮之前提交过；复用已有 HEAD，避免重复提交。
            ahead = subprocess.run(
                [
                    "git", "-C", str(self.path), "rev-list", "--count",
                    f"{self._base_ref()}..HEAD",
                ],
                check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            if ahead.returncode == 0 and int(ahead.stdout.strip() or "0") > 0:
                head = subprocess.run(
                    ["git", "-C", str(self.path), "rev-parse", "--short", "HEAD"],
                    check=False, capture_output=True, text=True,
                    encoding="utf-8", errors="replace",
                )
                commit_hash = head.stdout.strip()
                log(f"   ↩️  复用已有 feature commit: {commit_hash}")
                return commit_hash
            log("   ⏭️  没有可提交的功能变更")
            return None

        message = f"feat({self.feature_id}): {feature_name or self.feature_id}"
        body = "Verified by test_engineer."
        if evidence.strip():
            body += f"\n\n{evidence.strip()[:2000]}"
        commit = subprocess.run(
            [
                "git", "-C", str(self.path), "commit",
                "-m", message, "-m", body,
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        if commit.returncode != 0:
            log(f"   ❌ git commit 失败: {commit.stderr.strip()[:300]}")
            return None
        head = subprocess.run(
            ["git", "-C", str(self.path), "rev-parse", "--short", "HEAD"],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        commit_hash = head.stdout.strip()
        log(
            f"   ✅ 已提交 feature {self.feature_id}: {commit_hash} "
            f"({len(staged_files)} files)"
        )
        return commit_hash

    def discard(self) -> None:
        """放弃本次开发：删除 worktree 与分支"""
        log(f"   🗑️  discard branch {self.branch}")
        self.remove()

    def has_changes(self) -> bool:
        """worktree 是否存在非状态文件变更（用于 detect no-op 开发）。"""
        if not self.path.exists():
            return False

        status = subprocess.run(
            [
                "git", "-C", str(self.path), "status", "--porcelain",
                "--untracked-files=all",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        for line in status.stdout.splitlines():
            if len(line) < 4:
                continue
            paths = line[3:].split(" -> ")
            if any(not _is_orchestrator_state_path(p) for p in paths):
                return True

        # 已提交但尚未 merge 的功能变更也必须算作 changes。
        result = subprocess.run(
            [
                "git", "-C", str(self.path), "diff", "--name-only",
                f"{self._base_ref()}..{self.branch}",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        return any(
            not _is_orchestrator_state_path(path.strip())
            for path in result.stdout.splitlines()
            if path.strip()
        )


# ============================================================================
# 状态管理
# ============================================================================

class StateStore:
    """读取 / 写入 规则地图 下的状态文件。

    Phase-1 增强：
      * `acquire(feature_id)` 提供 per-feature 的跨进程文件锁
      * `load_features` / `save_features` / `append_progress` 接受可选
        `feature_id` 参数自动加锁（避免并发 phase 互踩）
      * 通过 `use_lock=False` 可完全旁路（CI / dry-run）
    """

    def __init__(self, root: Path, use_lock: bool = True) -> None:
        self.root = root
        self.feature_path = root / "feature_list.json"
        self.progress_path = root / "progress.md"
        self.locks_dir = root / LOCKS_ROOT
        self.use_lock = use_lock

    @contextlib.contextmanager
    def acquire(self, feature_id: str = "_shared") -> Any:
        """per-feature 跨进程锁（flock / msvcrt）。同 feature 串行；不同 feature 并发。"""
        if not self.use_lock:
            yield
            return
        lockfile = self.locks_dir / f"{feature_id}.lock"
        with _file_lock(lockfile):
            yield

    def load_features(self, feature_id: str = "_shared") -> list[Feature]:
        with self.acquire(feature_id):
            return self._load_features_unlocked()

    def _load_features_unlocked(self) -> list[Feature]:
        """调用方已持有 feature 锁时使用，避免嵌套 flock 自锁。"""
        if not self.feature_path.exists():
            return []
        raw = json.loads(self.feature_path.read_text(encoding="utf-8"))
        return [Feature.from_dict(f) for f in raw.get("features", [])]

    def save_features(
        self, features: list[Feature], feature_id: str = "_shared",
    ) -> None:
        with self.acquire(feature_id):
            self._save_features_unlocked(features)

    def _save_features_unlocked(self, features: list[Feature]) -> None:
        """调用方已持有 feature 锁时使用，避免嵌套 flock 自锁。"""
        payload = {
            "project": "数据迁移工具",
            "description": self._read_project_description(),
            "last_updated": datetime.now().isoformat(timespec="seconds"),
            "status_legend": {
                "not_started": "功能还没开始做。",
                "in_progress": "这个功能是当前唯一正在进行的任务。",
                "blocked": "等待评估反馈或外部依赖。",
                "pass": "要求的验证已经通过，并且证据已经记录。",
            },
            "features": [f.to_dict() for f in features],
        }
        self.feature_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def append_progress(
        self, section: str, body: str,
        section_owner: str | None = None,
    ) -> None:
        """在 progress.md 中追加一段（如果是首次写入则创建标题）。"""
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        block = f"\n## {section} -- {ts}\n\n{body.strip()}\n"
        with self.acquire(section_owner or "_shared"):
            if not self.progress_path.exists():
                self.progress_path.write_text(
                    "# Session Progress Log -- 数据迁移工具\n\n"
                    "(由 orchestrator 自动生成)\n",
                    encoding="utf-8",
                )
            with self.progress_path.open("a", encoding="utf-8") as f:
                f.write(block)

    def _read_project_description(self) -> str:
        if not self.feature_path.exists():
            return "数据迁移工具"
        try:
            raw = json.loads(self.feature_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return "数据迁移工具"
        project = str(raw.get("project") or "").strip()
        description = str(raw.get("description") or "").strip()
        return project or description or "数据迁移工具"

    # 便捷查询
    def current_datasource(self, features: list[Feature]) -> str | None:
        """返回当前必须优先完成的数据源；全部完成时返回 None。"""
        return _current_datasource_from_statuses(
            {f.id: f.status for f in features}
        )

    def missing_datasource_capabilities(
        self, features: list[Feature], datasource: str,
    ) -> list[str]:
        """列出当前数据源尚不存在的 feature id。"""
        existing = {f.id for f in features}
        return [
            f"{datasource}-{capability}"
            for capability in DATASOURCE_REQUIRED_CAPABILITIES.get(datasource, ())
            if f"{datasource}-{capability}" not in existing
        ]

    def next_pending(self, features: list[Feature]) -> Feature | None:
        """挑出下一个待处理的功能：
        1) 优先恢复 status=in_progress 或 blocked 的功能（继续上次未完成工作）；
           - blocked 表示上一轮 build/typecheck 失败，必须回流到 develop 重试；
        2) 否则挑 status=not_started 且依赖已 pass 的功能（启动新工作）。

        返回值用于编排器主循环，避免被 blocked 卡死或空转。

        切分自检（不门控，仅警告）：返回的 feature 若 desc>2000字/deps>5，
        说明切分可能过粗；建议 PM 拆成 2+ 个子任务。
        """
        passed_ids = {f.id for f in features if f.status == "pass"}
        subtask_parents = {
            f.id for f in features
            if any(
                child.id.startswith(f"{f.id}--step--")
                for child in features
            )
        }
        # 父 feature 已被拆解时只作为容器，不再参与调度；子任务对父 feature
        # 的依赖视为“已满足”，否则会出现 parent blocked -> child 等 parent 的死锁。
        schedulable_dependency_ids = passed_ids | subtask_parents
        active_datasource = self.current_datasource(features)

        def in_current_datasource(feature: Feature) -> bool:
            if active_datasource is None:
                return True
            return _datasource_of_feature_id(feature.id) == active_datasource

        chosen: "Feature | None" = None
        # 1) 优先恢复进行中的功能
        for f in features:
            if (
                f.status == "in_progress"
                and f.id not in subtask_parents
                and in_current_datasource(f)
            ):
                chosen = f
                break
        if chosen is None:
            # 2) 恢复被阻塞的功能（跳过已被拆解成子任务的，避免重复劳动）
            for f in features:
                if (
                    f.status != "blocked"
                    or f.id in subtask_parents
                    or not in_current_datasource(f)
                ):
                    continue
                chosen = f
                break
        if chosen is None:
            # 3) 启动依赖已 pass 的新功能
            for f in features:
                if f.status != "not_started" or not in_current_datasource(f):
                    continue
                if all(
                    dep in schedulable_dependency_ids
                    for dep in f.dependencies
                ):
                    chosen = f
                    break

        # 切分质量自检（INVEST 原则中的 E/S）
        if chosen is not None:
            self._warn_if_oversized(chosen)
        return chosen

    @staticmethod
    def _warn_if_oversized(feature: "Feature") -> None:
        """切分质量自检：desc>2000字 或 deps>5 时 log 警告，不阻断。

        提示：feature_list.json 中过粗的条目应按 INVEST 原则拆细。
        """
        warnings: list[str] = []
        if len(feature.description) > 2000:
            warnings.append(
                f"desc {len(feature.description)} 字 > 2000（建议拆为 2+ 子任务）"
            )
        if len(feature.dependencies) > 5:
            warnings.append(
                f"deps {len(feature.dependencies)} 项 > 5（耦合度高，拆）"
            )
        if warnings:
            log(
                f"   ⚠️  Feature {feature.id} 切分可能过粗："
                + "；".join(warnings)
            )

    def reap_decomposed(self, features: list[Feature]) -> list[Feature]:
        """扫描所有 blocked feature，找到被拆解过的（存在 `{id}--step--N` 子任务）；
        若其全部子任务都 pass，则把原 feature 标为 pass 并写明 evidence。
        返回被改动的 feature 列表（用于 main loop 日志）。
        """
        updated: list[Feature] = []
        for f in features:
            if f.status not in ("blocked", "in_progress"):
                continue
            prefix = f.id + "--step--"
            subtasks = [s for s in features if s.id.startswith(prefix)]
            if not subtasks:
                continue
            if not all(s.status == "pass" for s in subtasks):
                continue
            f.status = "pass"
            f.evidence = (
                f"由 {len(subtasks)} 个子任务组合实现: "
                + ", ".join(s.id for s in subtasks)
            )
            _touch_feature(f)
            updated.append(f)
        return updated


# ============================================================================
# 文件锁（per-feature，跨进程安全）
# ============================================================================

if sys.platform == "win32":
    import msvcrt  # noqa: E402
else:
    import fcntl  # noqa: E402


@contextlib.contextmanager
def _file_lock(path: Path) -> Any:
    """跨进程互斥的字节级文件锁。

    Windows 走 msvcrt.locking（文件级），POSIX 走 fcntl.flock。
    拿不到锁时阻塞；进程崩溃时 OS 自动释放。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if sys.platform == "win32":
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            if sys.platform == "win32":
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


# ============================================================================
# Token 预算
# ============================================================================

class TokenBudget:
    """5h 周期累计 + 滑动 60s 窗口（RPM/TPM 限制）。

    限制策略（Round 8）：
      - 5h 周期：SOFT_TOKEN_LIMIT 是粗粒度累计（用于 long-term 趋势）
      - 60s 窗口：RPM_LIMIT=200 / TPM_LIMIT=10M 是细粒度限速（防服务端 429）

    每次 add() 时同时更新 5h 累计 + 60s 滑动窗口。
    调用前用 wait_for_slot(needed_tokens) 主动 sleep 到能容纳新请求。
    """

    def __init__(self, soft_limit: int = SOFT_TOKEN_LIMIT,
                 reset_hours: int = TOKEN_RESET_INTERVAL_HOURS,
                 rpm_limit: int = RPM_LIMIT,
                 tpm_limit: int = TPM_LIMIT) -> None:
        self.soft_limit = soft_limit
        self.reset_interval = timedelta(hours=reset_hours)
        self.used = 0
        self.cycle_started = datetime.now()
        self.next_reset = self.cycle_started + self.reset_interval
        # Round 8: 滑动 60s 窗口（deque 存 (timestamp, total_tokens)）
        from collections import deque
        self._call_window: "deque[tuple[float, int]]" = deque()
        self.rpm_limit = rpm_limit
        self.tpm_limit = tpm_limit

    def add(self, tokens: int) -> None:
        """记录一次调用：累加 5h 周期 + 推进 60s 滑动窗口。"""
        tokens = max(0, tokens)
        self.used += tokens
        now = time.monotonic()
        self._call_window.append((now, tokens))
        self._evict_old(now)

    def _evict_old(self, now: float) -> None:
        """移除 60s 窗口之外的过期记录。"""
        from collections import deque
        cutoff = now - RATE_LIMIT_WINDOW_SEC
        while self._call_window and self._call_window[0][0] < cutoff:
            self._call_window.popleft()

    def utilization(self) -> float:
        return self.used / self.soft_limit if self.soft_limit else 0.0

    def time_to_reset(self) -> timedelta:
        return max(timedelta(0), self.next_reset - datetime.now())

    def maybe_reset(self) -> bool:
        if datetime.now() >= self.next_reset:
            log(f"♻️  Token 周期已到（{self.reset_interval}），重置 token 计数。")
            self.used = 0
            self.cycle_started = datetime.now()
            self.next_reset = self.cycle_started + self.reset_interval
            return True
        return False

    def wait_for_slot(self, needed_tokens: int = 0) -> float:
        """主动等到窗口能容纳新请求再返回。返回 sleep 的秒数（0 表示无需等待）。

        Round 8: 检查 RPM + TPM，超限则 sleep 到最早一条出窗口。
        服务端 429 比客户端 sleep 更浪费（要 retry、浪费已发的 token），
        所以宁可主动等。
        """
        now = time.monotonic()
        self._evict_old(now)

        cur_calls = len(self._call_window)
        cur_tokens = sum(t for _, t in self._call_window)

        # RPM 检查：当前窗口调用数
        wait_for_rpm = 0.0
        if cur_calls >= self.rpm_limit:
            oldest_ts = self._call_window[0][0]
            wait_for_rpm = max(0.0, RATE_LIMIT_WINDOW_SEC - (now - oldest_ts))

        # TPM 检查：当前窗口 tokens + 本次预计需要
        # 逻辑：从最老到最新，依次假设"出窗口"，找最早能满足的等待时间
        wait_for_tpm = 0.0
        if cur_tokens + needed_tokens > self.tpm_limit:
            remaining = cur_tokens  # 假设所有都在窗口
            wait_for_tpm = RATE_LIMIT_WINDOW_SEC  # fallback
            for ts, tokens in self._call_window:
                remaining -= tokens  # 模拟这条 ts 出窗口
                if remaining + needed_tokens <= self.tpm_limit:
                    wait_for_tpm = max(0.0, RATE_LIMIT_WINDOW_SEC - (now - ts))
                    break
            # 边界 case：单次调用就超过 TPM_LIMIT —— 等最早一条出窗口
            if wait_for_tpm <= 0.0 and cur_tokens + needed_tokens > self.tpm_limit:
                wait_for_tpm = max(0.0, RATE_LIMIT_WINDOW_SEC - (now - self._call_window[0][0]))

        wait_sec = max(wait_for_rpm, wait_for_tpm)
        if wait_sec > 0:
            log(
                f"   ⏸ rate limit 触发：calls={cur_calls}/{self.rpm_limit} "
                f"tokens={cur_tokens + needed_tokens:,}/{self.tpm_limit:,}；"
                f"等 {wait_sec:.1f}s..."
            )
            time.sleep(wait_sec)
        return wait_sec

    def wait_until_reset(self) -> float:
        """兼容旧接口：5h 周期用满时主动等到下个周期（默认 no-op，因为 soft_limit 很高）。

        实际限速由 wait_for_slot 处理（per-minute 滑动窗口）。
        """
        return 0.0


# ============================================================================
# Agent 调用层
# ============================================================================

# ============================================================================
# 工具定义（直接 SDK 模式下 Agent 需要的工具集）
# ============================================================================

TOOL_DEFS: list[dict[str, Any]] = [
    {
        "name": "Read",
        "description": (
            "Read the contents of a file. Path is relative to project root "
            "(absolute paths also accepted if inside the project)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to file"},
                "offset": {
                    "type": "integer",
                    "description": "Optional 1-based line offset.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Optional maximum number of lines to return.",
                },
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "Write",
        "description": "Write content to a file (creates or overwrites).",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["file_path", "content"],
        },
    },
    {
        "name": "Edit",
        "description": (
            "Find a specific old_string in a file and replace it with new_string "
            "(exactly one occurrence). Use Read first to confirm the exact text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    },
    {
        "name": "Bash",
        "description": (
            "Run a shell command in the project root. Returns stdout, stderr, "
            "exit_code. Use this for npm/go/git/typecheck/test/build commands."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in milliseconds (default 120000 = 120s)",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "RunApp",
        "description": (
            "Start, inspect, or stop the Electron application while capturing "
            "startup and runtime logs. Use `eval` to execute JavaScript in the "
            "running renderer and verify or operate the real UI through Chrome "
            "DevTools Protocol. Use this instead of running `npm run dev` "
            "directly. The log contains stdout, stderr, exit codes and runtime errors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "status", "stop", "eval"],
                },
                "expression": {
                    "type": "string",
                    "description": (
                        "JavaScript expression or async code evaluated in the "
                        "running renderer when action=eval."
                    ),
                },
                "remote_debugging_port": {
                    "type": "integer",
                    "description": "Electron remote debugging port (default 9222)",
                },
                "ready_timeout_sec": {
                    "type": "integer",
                    "description": "Maximum seconds to wait for app readiness (default 60)",
                },
            },
            "required": ["action"],
        },
    },
    {
        "name": "Glob",
        "description": "Find files matching a glob pattern. Returns paths relative to project root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "e.g. 'src/**/*.tsx'"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "Grep",
        "description": "Search a regex pattern in files under `path`. Returns matching lines with file:lineno.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string", "description": "File or dir (default '.')"},
            },
            "required": ["pattern"],
        },
    },
]


class AgentClient:
    """直接调用 Anthropic SDK（默认指向 minimaxi 端点），自己执行 tool use。

    Tools: Read / Write / Edit / Bash / Glob / Grep。Multi-turn tool-use loop
    由 orchestrator 控制；模型返回 tool_use 时调用本地执行器，把结果作为
    tool_result 发回，直到 stop_reason != "tool_use" 取得最终文本。
    """

    MAX_TOOL_ITERATIONS = 80  # 单次调用最大 tool 轮次；到顶后强制无工具收尾

    def __init__(
        self,
        api_url: str = "https://api.minimaxi.com/anthropic",
        model: str = "MiniMax-M3",
        max_concurrent: int = MAX_CONCURRENT_AGENTS,
        max_output_tokens: int = MAX_OUTPUT_TOKENS,
        per_call_token_limit: int = PER_CALL_TOKEN_LIMIT,
        allow_docker: bool = True,
    ) -> None:
        self.api_url = api_url
        self.model = model
        self.max_concurrent = max_concurrent
        self.semaphore = asyncio.Semaphore(max_concurrent)
        # 硬保证：无论调用方如何调度，同一时间只执行一个 Agent。
        self._agent_execution_lock = asyncio.Lock()
        self.max_output_tokens = max_output_tokens
        self.per_call_token_limit = per_call_token_limit
        self.allow_docker = allow_docker
        self._app_process: asyncio.subprocess.Process | None = None
        self._app_log_handle: Any = None
        self._app_log_path: Path | None = None
        self._app_startup_log_path: Path | None = None
        self._app_runtime_log_path: Path | None = None
        self._app_runtime_start_offset = 0
        self._app_feature_id: str | None = None
        self._app_remote_debugging_port = 9222
        self._current_run_app_started = False
        self._current_run_app_status_checked = False
        self._current_run_app_ui_checked = False
        self._project_root: Path | None = None
        # Context snapshot 缓存（按 role/feature 分桶，避免跨角色复用错误上下文）
        self._snapshot_cache: dict[str, tuple[str, str]] = {}
        # Round 2: 单次 Agent 调用的硬性 wall-time 上限（秒），由 Orchestrator 注入
        self.max_agent_wall_seconds: int = MAX_AGENT_WALL_SECONDS_DEFAULT
        # Round 2: bash 失败历史（key=normalized cmd, value=[error_pattern, ...]）
        self._bash_fail_history: dict[str, list[str]] = {}
        # Round 3: 「探索循环」检测 —— 连续无 Edit/Write 的轮次计数
        self._read_only_streak: int = 0
        self._exploration_warned: bool = False
        self._exploration_stuck_hint: str = ""
        self._tool_call_counts: dict[str, int] = {}
        self._duplicate_tool_warned: set[str] = set()
        # Phase-1: 当前调用的 worktree 路径 + 角色（用于 developer 角色
        # 禁用自提交 / 路径白名单）
        self._worktree_root: Path | None = None
        self._current_role: str | None = None
        self._current_feature_id: str | None = None
        # Round 6: 单例 anthropic client + 强制重置锁
        # （之前每次 call() 都新建 client，导致 aiohttp 连接无法跨调用复用；
        # 超时时 aiohttp 不响应 cancel，连接残留积累；
        # 现在改为单例，超时时强制 close() 并重建，放弃所有挂起的 aiohttp 连接）
        self._client_instance: "anthropic.AsyncAnthropic | None" = None
        self._client_lock = asyncio.Lock()
        # 同一进程内按文件串行化 Write/Edit，避免并发 Agent 互相覆盖。
        self._file_locks: dict[Path, asyncio.Lock] = {}
        self._file_locks_guard = asyncio.Lock()
        # 并发 Agent 共享同一进程基线，全部结束后统一回收 dev 进程。
        self._active_agent_calls = 0
        self._process_tracking_lock = asyncio.Lock()
        self._dev_cleanup_baseline: dict[int, str] | None = None
        # Round 8: rate limiter（由 Orchestrator.set_rate_limiter() 注入）
        self._rate_limiter: "TokenBudget | None" = None
        # Token Plan 配额耗尽时，所有 Agent 共用同一个 15 分钟重试窗口。
        self._token_plan_retry_lock = asyncio.Lock()
        self._token_plan_retry_at = 0.0
        self._token_plan_retry_count = 0

    async def _force_reset_client(self) -> None:
        """强制关闭当前 anthropic client 并重建。

        用于 _call_with_timeout 超时时释放所有挂起的 aiohttp 连接。
        aiohttp 在 macOS + minimax.cn 代理环境下，CLOSE_WAIT 状态的连接
        不能通过 cancel 立即关闭，需要调用 client.close() 强制清理。
        """
        async with self._client_lock:
            old = self._client_instance
            self._client_instance = None
            if old is not None:
                try:
                    await old.close()
                except Exception as e:
                    log(f"   ⚠️ 关闭旧 anthropic client 失败: {e}")
            # 重建
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            self._client_instance = anthropic.AsyncAnthropic(
                api_key=api_key, base_url=self.api_url
            )
            log("   ♻️  anthropic client 已强制重置（放弃所有挂起连接）")

    def set_rate_limiter(self, limiter: "TokenBudget") -> None:
        """注入 rate limiter（由 Orchestrator 在 __init__ 调用）。"""
        self._rate_limiter = limiter

    async def _get_client(self) -> "anthropic.AsyncAnthropic":
        """获取单例 anthropic client（首次创建，async 安全）。"""
        if self._client_instance is None:
            async with self._client_lock:
                if self._client_instance is None:
                    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                    self._client_instance = anthropic.AsyncAnthropic(
                        api_key=api_key, base_url=self.api_url
                    )
        return self._client_instance

    async def _heartbeat(self, msg: str, interval: int = 15) -> None:
        """长任务期间每 interval 秒打印一次心跳，证明没卡死。

        与主 task 并发跑；主 task 完成时由 finally cancel 掉。
        """
        start = time.time()
        try:
            while True:
                await asyncio.sleep(interval)
                log(f"      ⏳ {msg}（已等待 {time.time()-start:.0f}s，按 Ctrl+C 可随时中断）")
        except asyncio.CancelledError:
            return

    def _snapshot_processes(self) -> dict[int, str]:
        """快照当前进程；用于识别一次 Agent 调用新启动的 dev 进程。"""
        try:
            result = subprocess.run(
                ["ps", "-axo", "pid=,command="],
                check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
        except OSError:
            return {}
        processes: dict[int, str] = {}
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            pid_text, _, command = line.partition(" ")
            try:
                pid = int(pid_text)
            except ValueError:
                continue
            processes[pid] = command.strip()
        return processes

    @staticmethod
    def _process_cwd(pid: int) -> Path | None:
        if sys.platform == "win32":
            return None
        try:
            result = subprocess.run(
                ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
        except OSError:
            return None
        for line in result.stdout.splitlines():
            if line.startswith("n") and len(line) > 1:
                try:
                    return Path(line[1:]).resolve()
                except OSError:
                    return None
        return None

    def _cleanup_spawned_dev_processes(
        self,
        before: dict[int, str],
        worktree_root: Path | None,
    ) -> None:
        """结束一次 Agent 调用新启动且仍在运行的 dev/Electron 进程。"""
        current = self._snapshot_processes()
        new_pids = [pid for pid in current if pid not in before]
        if not new_pids:
            return

        project_root = (self._project_root or PROJECT_ROOT).resolve()
        allowed_roots = [project_root]
        if worktree_root is not None:
            allowed_roots.append(worktree_root.resolve())

        name_markers = (
            "electron",
            "electron-vite",
            "esbuild",
            "vite",
            "npm run dev",
        )
        targets: list[int] = []
        for pid in new_pids:
            command = current.get(pid, "")
            command_lower = command.lower()
            cwd = self._process_cwd(pid)
            in_workspace = bool(
                cwd and any(cwd == root or cwd.is_relative_to(root) for root in allowed_roots)
            )
            explicit_path = any(str(root) in command for root in allowed_roots)
            if (
                explicit_path
                or (in_workspace and any(marker in command_lower for marker in name_markers))
            ):
                targets.append(pid)

        if not targets:
            return

        log(f"   🧹 清理 Agent 新启动的 dev 进程: {targets}")
        if sys.platform == "win32":
            for pid in targets:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    check=False, capture_output=True,
                )
            return

        for sig in (signal.SIGTERM, signal.SIGKILL):
            alive: list[int] = []
            for pid in targets:
                try:
                    os.kill(pid, sig)
                    alive.append(pid)
                except ProcessLookupError:
                    continue
                except OSError:
                    continue
            if not alive:
                break
            time.sleep(0.5)

    async def _begin_agent_call(self) -> None:
        async with self._process_tracking_lock:
            if self._active_agent_calls == 0:
                self._dev_cleanup_baseline = await asyncio.to_thread(
                    self._snapshot_processes
                )
            self._active_agent_calls += 1

    async def _end_agent_call(self, worktree_root: Path | None) -> None:
        baseline: dict[int, str] | None = None
        async with self._process_tracking_lock:
            self._active_agent_calls = max(0, self._active_agent_calls - 1)
            if self._active_agent_calls == 0:
                baseline = self._dev_cleanup_baseline
                self._dev_cleanup_baseline = None
                await self._stop_managed_app("agent call finished")
        if baseline is not None:
            await asyncio.to_thread(
                self._cleanup_spawned_dev_processes,
                baseline,
                worktree_root,
            )

    async def _call_with_timeout(
        self,
        *,
        role: str,
        prompt: str,
        project_root: Path,
        feature_id: str | None = None,
        worktree_root: Path | None = None,
        timeout: float | None = None,
    ) -> AgentResult:
        """串行互斥入口：所有 Agent 调用必须串行获得执行权。"""
        async with self._agent_execution_lock:
            return await self._call_with_timeout_unlocked(
                role=role,
                prompt=prompt,
                project_root=project_root,
                feature_id=feature_id,
                worktree_root=worktree_root,
                timeout=timeout,
            )

    async def _call_with_timeout_unlocked(
        self,
        *,
        role: str,
        prompt: str,
        project_root: Path,
        feature_id: str | None = None,
        worktree_root: Path | None = None,
        timeout: float | None = None,
    ) -> AgentResult:
        """client.call 加一层整体 wall-time 超时；单请求超时在 call 内处理。

        Round 6 修复：
          * Round 5 用 asyncio.wait_for 但 aiohttp 在 macOS + minimax.cn
            代理环境下不响应 cancel（TCP CLOSE_WAIT 残留），导致
            timeout 实际要 21 分钟才触发。
          * Round 6 改用 task + 强制 client 重置：
            1. 把 self.call 包在 asyncio.Task 里（可独立 cancel）
            2. 用 asyncio.wait_for 等 timeout
            3. 超时后 cancel task + 强制重建 anthropic client
               （client.close() 关闭所有挂起的 aiohttp 连接）
            4. semaphore 被释放，下次调用能立即拿到 slot
        """
        role_label = ROLES.get(role, {}).get("label", role)
        effective_timeout = (
            timeout
            if timeout is not None
            else float(self.max_agent_wall_seconds + 60)
        )
        while True:
            # Round 8: 在发起请求前主动等到能容纳新请求（RPM/TPM 滑动窗口）
            # budget 由 Orchestrator 通过 set_rate_limiter() 注入（默认 None 表示不限速）
            if self._rate_limiter is not None:
                needed_input_tokens = len(prompt) // 4  # 粗估：1 token ≈ 4 chars
                await asyncio.to_thread(
                    self._rate_limiter.wait_for_slot, needed_input_tokens
                )

            await self._begin_agent_call()
            task = asyncio.create_task(
                self.call(
                    AgentCall(role=role, prompt=prompt, feature_id=feature_id),
                    project_root,
                    worktree_root=worktree_root,
                )
            )
            try:
                try:
                    result = await asyncio.wait_for(
                        asyncio.shield(task), timeout=effective_timeout
                    )
                    if _is_token_plan_usage_limit(result.text):
                        await self._wait_for_token_plan_retry(role_label)
                        continue
                    # Round 8: 把真实 token 用量累加到 budget
                    if self._rate_limiter is not None and result.usage:
                        total_used = (
                            result.usage.get("input_tokens", 0)
                            + result.usage.get("output_tokens", 0)
                        )
                        self._rate_limiter.add(total_used)
                    return result
                except asyncio.TimeoutError:
                    log(
                        f"   ⏰ {role_label} 整体调用超时 {effective_timeout:.0f}s"
                        f"（远端关闭连接不响应）；"
                        f"cancel + 强制重置 anthropic client"
                    )
                    # 1) cancel task（即使不响应也无所谓，下一步 close 才是关键）
                    task.cancel()
                    # 2) 强制重建 anthropic client —— 关闭所有挂起的 aiohttp 连接，
                    #    这是释放 semaphore slot 的关键
                    try:
                        await asyncio.wait_for(task, timeout=5)
                    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                        pass
                    await self._force_reset_client()
                    return AgentResult(
                        role=role, ok=False,
                        text=f"call timeout after {effective_timeout:.0f}s "
                             f"(upstream closed connection without response)",
                        duration_sec=effective_timeout,
                        feature_id=feature_id,
                    )
            finally:
                await self._end_agent_call(worktree_root)

    async def _wait_for_token_plan_retry(self, role: str) -> None:
        """Token Plan 配额耗尽后，等待全局统一的 15 分钟重试窗口。

        并发 Agent 命中同一个配额错误时共用同一个时间点，避免每个 Agent
        各自等待、把配额探测请求打散成连续请求。
        """
        async with self._token_plan_retry_lock:
            now = time.monotonic()
            if now >= self._token_plan_retry_at:
                self._token_plan_retry_at = now + TOKEN_PLAN_RETRY_INTERVAL_SEC
                self._token_plan_retry_count += 1
                retry_no = self._token_plan_retry_count
                wait_sec = float(TOKEN_PLAN_RETRY_INTERVAL_SEC)
                log(
                    f"   ⏸ Token Plan 用量上限已命中（2056），"
                    f"暂停 Claude 请求；{TOKEN_PLAN_RETRY_INTERVAL_SEC // 60} 分钟后"
                    f"统一重试（第 {retry_no} 次）"
                )
            else:
                retry_no = self._token_plan_retry_count
                wait_sec = max(0.0, self._token_plan_retry_at - now)
                log(
                    f"   ⏳ {role} 同样等待 Token Plan 配额恢复；"
                    f"复用第 {retry_no} 次重试窗口（还剩 {wait_sec:.0f}s）"
                )

        if wait_sec > 0:
            await asyncio.sleep(wait_sec)
        log(f"   🔁 Token Plan 第 {retry_no} 次重试窗口已到，继续 {role} 调用")

    async def call(
        self,
        call: AgentCall,
        project_root: Path,
        worktree_root: Path | None = None,
    ) -> AgentResult:
        self._project_root = project_root
        self._worktree_root = worktree_root
        self._current_role = call.role
        self._current_feature_id = call.feature_id
        self._current_run_app_started = False
        self._current_run_app_status_checked = False
        self._current_run_app_ui_checked = False
        role_meta = ROLES[call.role]
        role_tag = f"[{role_meta['label']}]"
        system_prompt = role_meta["system_prompt"] + HANDOFF_RULES
        environment_prompt = ""
        if self.allow_docker:
            feature_scope = call.feature_id or "general"
            environment_prompt = (
                "\n\n【Docker 测试环境权限】\n"
                "- 允许使用 `docker` / `docker compose` 创建、启动、连接和删除"
                "测试数据库及服务。\n"
                "- 仅操作本 Agent 为本 feature 创建的容器；不得删除或修改用户已有容器。\n"
                f"- 容器名必须带前缀 `dm-{feature_scope}-`，并添加 label "
                "`com.datamigrator.ephemeral=true` 和 "
                f"`com.datamigrator.feature={feature_scope}`。\n"
                "- 宿主机端口使用 20000-29999，并先检测端口占用；不得抢占 5173/9222/3847。\n"
                "- 优先使用 `docker run --rm` 或完成任务后 `docker rm -f` 清理。\n"
                "- 连接测试环境时必须使用 `127.0.0.1`，同时验证容器健康检查/端口就绪。"
            )

        ctx = self._build_context_snapshot(
            project_root,
            role=call.role,
            feature_id=call.feature_id,
        )
        log(
            f"   📦 context snapshot: {len(ctx)} chars "
            f"(≈{len(ctx) // 4:,} tokens, budget={MAX_CONTEXT_SNAPSHOT_CHARS})"
        )
        user_prompt = (
            f"{ctx}\n\n---\n\n【本次任务】\n\n{call.prompt}\n\n"
            f"---\n\n【本角色硬性约束】\n{system_prompt}"
            f"{environment_prompt}\n"
        )

        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            log(
                f"   ❌ 缺少环境变量 ANTHROPIC_API_KEY（API key）。"
                f"请 `export ANTHROPIC_API_KEY=<key>` 后再启动。"
            )
            return AgentResult(
                role=call.role, ok=False,
                text="missing env var ANTHROPIC_API_KEY",
                feature_id=call.feature_id,
            )

        client = await self._get_client()

        async with self.semaphore:
            log(
                f"🤖 启动 Agent: {role_meta['label']} "
                f"(model={self.model}, API={self.api_url}, "
                f"semaphore={self.max_concurrent}，串行调度)"
            )
            log(
                f"   ⏳ 准备上下文快照 + 第 1 次 API 请求 "
                f"(wall-time 上限 {self.max_agent_wall_seconds}s = "
                f"{self.max_agent_wall_seconds // 60}m)..."
            )
            # Round 2: 重置 bash 失败历史（per-call scope，避免跨调用干扰）
            self._bash_fail_history.clear()
            # Round 3: 重置探索循环检测（per-call scope）
            self._read_only_streak = 0
            self._exploration_warned = False
            self._exploration_stuck_hint = ""
            self._tool_call_counts.clear()
            self._duplicate_tool_warned.clear()
            enforce_read_only_stop = self._enforce_read_only_stop(call.role)
            iteration_limit = _ROLE_TOOL_ITERATION_LIMITS.get(
                call.role, self.MAX_TOOL_ITERATIONS
            )
            start = time.monotonic()  # FIX: avoid mixing with time.monotonic() below (gave huge negative duration)
            messages: list[dict[str, Any]] = [
                {"role": "user", "content": user_prompt}
            ]
            total_in = 0
            total_out = 0

            try:
                log(
                    f"   {role_tag} 📤 发送初始请求 -> {self.api_url} "
                    f"(max_tokens={self.max_output_tokens})"
                )
                hb = asyncio.create_task(
                    self._heartbeat(f"{role_tag} 等待初始 API 响应")
                )
                try:
                    response = await asyncio.wait_for(
                        client.messages.create(
                            model=self.model,
                            max_tokens=self.max_output_tokens,
                            system=system_prompt,
                            tools=TOOL_DEFS,
                            messages=messages,
                            timeout=AGENT_TIMEOUT_SECONDS,
                        ),
                        timeout=AGENT_REQUEST_TIMEOUT_SEC,
                    )
                finally:
                    hb.cancel()
                total_in += response.usage.input_tokens
                total_out += response.usage.output_tokens
                log(
                    f"   {role_tag} 📨 收到初始响应: "
                    f"stop_reason={response.stop_reason}, "
                    f"in={response.usage.input_tokens} out={response.usage.output_tokens}"
                )
            except asyncio.TimeoutError:
                log(
                    f"   {role_tag} ⏰ 单次 API 请求超时 "
                    f"{AGENT_REQUEST_TIMEOUT_SEC}s；重置 client"
                )
                await self._force_reset_client()
                return AgentResult(
                    role=call.role, ok=False,
                    text=(
                        f"API request timeout after "
                        f"{AGENT_REQUEST_TIMEOUT_SEC}s"
                    ),
                    duration_sec=time.monotonic() - start,
                    feature_id=call.feature_id,
                )
            except anthropic.APIError as e:
                log(f"   {role_tag} ❌ API 错误: {e}")
                return AgentResult(
                    role=call.role, ok=False, text=f"API error: {e}",
                    duration_sec=time.monotonic() - start,
                    feature_id=call.feature_id,
                )

            # Multi-turn tool-use loop（含 Round 2 wall-time watchdog +
            # Round 3 探索循环检测）
            iteration = 0
            while (
                response.stop_reason == "tool_use"
                and iteration < iteration_limit
            ):
                iteration += 1
                # Round 2: 检查 wall-time 上限（防单 Agent 卡 5h+）
                elapsed = time.monotonic() - start
                if elapsed > self.max_agent_wall_seconds:
                    log(
                        f"   ⏰ Agent {role_meta['label']} 超 wall-time "
                        f"({elapsed:.0f}s > {self.max_agent_wall_seconds}s)；"
                        f"已跑 {iteration} 轮 tool-use；强制终止。"
                    )
                    return AgentResult(
                        role=call.role, ok=False,
                        text=f"wall-time exceeded after {elapsed:.0f}s "
                             f"(> {self.max_agent_wall_seconds}s)",
                        usage={"input_tokens": total_in, "output_tokens": total_out},
                        duration_sec=elapsed,
                        feature_id=call.feature_id,
                    )
                log(f"   {role_tag} 🔄 第 {iteration}/{iteration_limit} 轮 tool-use "
                    f"(已跑 {elapsed:.0f}s / 上限 {self.max_agent_wall_seconds}s)")
                tool_results: list[dict[str, Any]] = []
                # Round 3: 本轮是否有 Edit/Write 调用（用来检测「探索循环」）
                iter_has_write = False
                for block in response.content:
                    if getattr(block, "type", None) != "tool_use":
                        continue
                    tool_name = block.name
                    if tool_name in ("Edit", "Write"):
                        iter_has_write = True
                    tool_input = block.input or {}
                    if (
                        tool_name == "Bash"
                        and _bash_command_may_write(str(tool_input.get("command", "")))
                    ):
                        iter_has_write = True
                    t0 = time.time()
                    # 工具名简述，便于日志阅读
                    tool_desc = self._tool_short_desc(tool_name, tool_input)
                    tool_signature = self._tool_call_signature(tool_name, tool_input)
                    call_count = self._tool_call_counts.get(tool_signature, 0) + 1
                    self._tool_call_counts[tool_signature] = call_count
                    if call_count >= MAX_DUPLICATE_TOOL_CALLS + 2:
                        log(
                            f"      {role_tag} ⛔ 相同工具调用重复 "
                            f"{call_count} 次，终止本轮以避免空转: "
                            f"{tool_name}({tool_desc})"
                        )
                        return AgentResult(
                            role=call.role,
                            ok=False,
                            text=(
                                f"duplicate tool loop: {tool_name} called "
                                f"{call_count} times without a write"
                            ),
                            usage={
                                "input_tokens": total_in,
                                "output_tokens": total_out,
                            },
                            duration_sec=time.monotonic() - start,
                            feature_id=call.feature_id,
                        )
                    if (
                        call_count >= MAX_DUPLICATE_TOOL_CALLS
                        and tool_signature not in self._duplicate_tool_warned
                    ):
                        log(
                            f"      {role_tag} 🪤 重复工具调用 "
                            f"{call_count} 次: {tool_name}({tool_desc})"
                        )
                        tool_results.append({
                            "type": "text",
                            "text": (
                                "[DUPLICATE TOOL CALL] 你正在重复同一个工具调用。"
                                "不要再重复读取/搜索；基于已有结果立即修改文件、"
                                "运行一个不同的验证命令，或返回明确阻塞。"
                            ),
                        })
                        self._duplicate_tool_warned.add(tool_signature)
                    log(f"      {role_tag} 🔧 {tool_name}({tool_desc})")
                    try:
                        executor = self._TOOL_EXECUTORS[tool_name]
                        result = await executor(self, tool_input)
                        content = result if isinstance(result, str) else str(result)
                        content = _truncate_text(
                            content, MAX_TOOL_RESULT_CHARS, label=f"{tool_name} 输出"
                        )
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": content,
                        })
                        preview = content[:120].replace("\n", " ")
                        log(
                            f"      {role_tag} ✅ {tool_name} 完成 "
                            f"({time.time()-t0:.1f}s): {preview}"
                        )
                    except asyncio.CancelledError:
                        log(f"      {role_tag} ⌨️  {tool_name} 被取消（Ctrl+C）")
                        raise
                    except Exception as e:
                        log(
                            f"      {role_tag} ⚠️  {tool_name} 失败 "
                            f"({time.time()-t0:.1f}s): {e}"
                        )
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"Error: {e}",
                            "is_error": True,
                        })

                # Round 3: 「探索循环」检测 —— 连续无 Edit/Write 视为原地打转
                # 出现一次 Edit/Write 即清零；累积到阈值后注入提示到 tool_results
                if iter_has_write:
                    self._read_only_streak = 0
                    self._exploration_warned = False
                    # 写入后允许重跑同一验证命令；新代码需要重新验证。
                    self._tool_call_counts.clear()
                    self._duplicate_tool_warned.clear()
                else:
                    self._read_only_streak += 1
                if (
                    enforce_read_only_stop
                    and self._read_only_streak >= READ_ONLY_HARD_STOP
                ):
                    log(
                        f"      {role_tag} ⛔ 探索循环硬停止："
                        f"连续 {self._read_only_streak} 轮"
                        f"没有 Edit/Write 或 Bash 写动作，终止本次 Agent 调用。"
                    )
                    return AgentResult(
                        role=call.role,
                        ok=False,
                        text=(
                            f"exploration loop hard stop after "
                            f"{self._read_only_streak} read-only iterations; "
                            f"agent did not write any file"
                        ),
                        usage={"input_tokens": total_in, "output_tokens": total_out},
                        duration_sec=time.monotonic() - start,
                        feature_id=call.feature_id,
                    )
                if (
                    enforce_read_only_stop
                    and
                    self._read_only_streak >= READ_ONLY_STUCK_THRESHOLD
                    and not self._exploration_warned
                ):
                    log(
                        f"      {role_tag} 🪤 探索循环: "
                        f"已连续 {self._read_only_streak} 轮 "
                        f"没有 Edit/Write（只有 Read/Bash/Grep/Glob）—— "
                        f"Agent 可能在原地打转。"
                    )
                    log(
                        f"      {role_tag} 💡 建议：停下来重新规划 —— "
                        f"用 Read 把目标文件完整看一遍，"
                        f"用 Edit 精确改（old_string 必须唯一匹配）；"
                        f"如果反复 old_string not found，应先用 Read 看实际内容再 Edit。"
                    )
                    self._exploration_stuck_hint = (
                        f"\n\n[EXPLORATION STUCK WARNING] 你已连续 "
                        f"{self._read_only_streak} 轮没有任何 Edit/Write "
                        f"或 Bash 写文件动作，只有只读探索。\n"
                        f"这通常是『原地打转』的信号：你在反复 grep / cat / sed 看文件，"
                        f"但找不到准确的位置下 Edit。\n"
                        f"请立刻改变策略：\n"
                        f"  1) 先用 Read 把目标文件完整读一遍（不要只 Read 部分行）；\n"
                        f"  2) 列出你要改的所有位置；\n"
                        f"  3) 一次性发出多个 Edit（old_string 必须唯一）；\n"
                        f"  4) 如果实在无法确定，写一段注释进 progress.md 说明障碍，"
                        f"然后输出 `DONE` 结束（不要无限循环）。"
                    )
                    # 注入到 tool_results 末尾，让 model 下一轮看到
                    tool_results.append({
                        "type": "text",
                        "text": self._exploration_stuck_hint,
                    })
                    self._exploration_warned = True

                # 把 assistant content + tool results 一起送回去
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})

                try:
                    log(
                        f"   {role_tag} 📤 发送第 {iteration} 轮 follow-up 请求 "
                        f"(messages={len(messages)})..."
                    )
                    hb = asyncio.create_task(
                        self._heartbeat(
                            f"{role_tag} 等待第 {iteration} 轮 API 响应"
                        )
                    )
                    try:
                        response = await asyncio.wait_for(
                            client.messages.create(
                                model=self.model,
                                max_tokens=self.max_output_tokens,
                                system=system_prompt,
                                tools=TOOL_DEFS,
                                messages=messages,
                                timeout=AGENT_TIMEOUT_SECONDS,
                            ),
                            timeout=AGENT_REQUEST_TIMEOUT_SEC,
                        )
                    finally:
                        hb.cancel()
                    total_in += response.usage.input_tokens
                    total_out += response.usage.output_tokens
                    log(
                        f"   {role_tag} 📨 收到第 {iteration} 轮响应: "
                        f"stop_reason={response.stop_reason}, "
                        f"+in={response.usage.input_tokens} +out={response.usage.output_tokens}"
                    )
                except asyncio.TimeoutError:
                    log(
                        f"   {role_tag} ⏰ 第 {iteration} 轮单次 API 请求超时 "
                        f"{AGENT_REQUEST_TIMEOUT_SEC}s；重置 client"
                    )
                    await self._force_reset_client()
                    return AgentResult(
                        role=call.role, ok=False,
                        text=(
                            f"API request timeout after "
                            f"{AGENT_REQUEST_TIMEOUT_SEC}s "
                            f"at tool iteration {iteration}"
                        ),
                        usage={
                            "input_tokens": total_in,
                            "output_tokens": total_out,
                        },
                        duration_sec=time.monotonic() - start,
                        feature_id=call.feature_id,
                    )
                except anthropic.APIError as e:
                    log(f"   {role_tag} ❌ API 错误: {e}")
                    return AgentResult(
                        role=call.role, ok=False, text=f"API error: {e}",
                        duration_sec=time.monotonic() - start,
                        feature_id=call.feature_id,
                    )

            # Round 3: MAX_TOOL_ITERATIONS 用尽后，禁止继续调用工具，
            # 再给模型一轮“收尾”机会，让已落盘的实现正常返回。
            if (
                response.stop_reason == "tool_use"
                and iteration >= iteration_limit
            ):
                log(
                    f"   ⏳ {role_meta['label']} 跑满 "
                    f"{iteration_limit} 轮 tool-use；"
                    f"进入无工具收尾请求"
                )
                messages.append({
                    "role": "user",
                    "content": (
                        "[SYSTEM] 已达到工具调用轮次上限。"
                        "不要再调用任何工具。请基于当前已经落盘的文件和命令结果，"
                        "输出最终状态：完成内容、已验证结果、剩余风险。"
                        "如果开发工作已经完成，明确输出 `DONE`；"
                        "如果测试已经完成，明确输出 `RESULT: pass` 或 "
                        "`RESULT: blocked`。"
                    ),
                })
                try:
                    hb = asyncio.create_task(
                        self._heartbeat(f"{role_tag} 等待无工具收尾响应")
                    )
                    try:
                        response = await asyncio.wait_for(
                            client.messages.create(
                                model=self.model,
                                max_tokens=self.max_output_tokens,
                                system=system_prompt,
                                messages=messages,
                                timeout=AGENT_TIMEOUT_SECONDS,
                            ),
                            timeout=AGENT_REQUEST_TIMEOUT_SEC,
                        )
                    finally:
                        hb.cancel()
                    total_in += response.usage.input_tokens
                    total_out += response.usage.output_tokens
                    log(
                        f"   {role_tag} 📨 无工具收尾响应: "
                        f"stop_reason={response.stop_reason}, "
                        f"+in={response.usage.input_tokens} "
                        f"+out={response.usage.output_tokens}"
                    )
                except (asyncio.TimeoutError, anthropic.APIError) as e:
                    log(f"   ⚠️ {role_tag} 无工具收尾失败: {e}")
                    return AgentResult(
                        role=call.role,
                        ok=False,
                        text=(
                            f"tool-use iterations exhausted at "
                            f"{iteration}; finalization request failed: {e}"
                        ),
                        usage={
                            "input_tokens": total_in,
                            "output_tokens": total_out,
                        },
                        duration_sec=time.monotonic() - start,
                        feature_id=call.feature_id,
                    )

            # 收尾：抽取最终文本
            text = "".join(
                block.text for block in response.content
                if getattr(block, "type", None) == "text"
            )
            duration = time.monotonic() - start
            # Round 2: 报告实际 wall-time 利用率（辅助判断下次调 max_agent_wall_seconds）
            utilization = duration / self.max_agent_wall_seconds if self.max_agent_wall_seconds else 0.0
            if utilization > 0.8:
                log(
                    f"   ⏰ 提示：本次 wall-time 利用率 {utilization:.0%} "
                    f"({duration:.0f}s / {self.max_agent_wall_seconds}s)；"
                    f"下次考虑调高 --max-agent-minutes"
                )

            warns: list[str] = []
            if total_in > self.per_call_token_limit:
                warns.append(f"⚠️ input={total_in} > {self.per_call_token_limit}")
            if total_out > self.per_call_token_limit:
                warns.append(f"⚠️ output={total_out} > {self.per_call_token_limit}")
            if (total_in + total_out) > self.per_call_token_limit * 2:
                warns.append(
                    f"⚠️ total={total_in + total_out} > 2×{self.per_call_token_limit}"
                )
            warn = ("  " + "  ".join(warns)) if warns else ""

            log(
                f"   ✅ {role_meta['label']} 完成 ({duration:.1f}s, "
                f"tool×{iteration}, in={total_in} out={total_out} "
                f"tot={total_in + total_out} tokens){warn}"
            )
            return AgentResult(
                role=call.role, ok=True,
                text=text,
                usage={"input_tokens": total_in, "output_tokens": total_out},
                duration_sec=duration,
                feature_id=call.feature_id,
                run_app_started=self._current_run_app_started,
                run_app_status_checked=self._current_run_app_status_checked,
                run_app_ui_checked=self._current_run_app_ui_checked,
            )

    # ---------------- 工具执行器 ----------------

    def _workspace_root(self) -> Path:
        """代码工具优先在 feature worktree 内执行。"""
        assert self._project_root is not None
        return (self._worktree_root or self._project_root).resolve()

    def _policy_relative_path(self, path: Path) -> str:
        """返回 path 相对于主工作区或当前 worktree 的路径。"""
        assert self._project_root is not None
        roots = [self._project_root.resolve()]
        if self._worktree_root is not None:
            roots.insert(0, self._worktree_root.resolve())
        for root in roots:
            try:
                return path.relative_to(root).as_posix()
            except ValueError:
                continue
        return path.as_posix()

    async def _file_lock(self, path: Path) -> asyncio.Lock:
        async with self._file_locks_guard:
            lock = self._file_locks.get(path)
            if lock is None:
                lock = asyncio.Lock()
                self._file_locks[path] = lock
            return lock

    @staticmethod
    def _replace_markdown_section(
        content: str, old_string: str, new_string: str,
    ) -> str | None:
        """旧整段内容漂移时，按唯一的二级标题替换整个 section。"""
        headings = [
            line.strip()
            for line in old_string.splitlines()
            if line.strip().startswith("## ")
        ]
        if len(headings) != 1 or headings[0] not in new_string:
            return None
        heading = headings[0]
        start = content.find(heading)
        if start < 0:
            return None
        next_heading = re.search(r"(?m)^## ", content[start + len(heading):])
        end = (
            start + len(heading) + next_heading.start()
            if next_heading
            else len(content)
        )
        replacement = new_string.rstrip() + "\n\n"
        return content[:start].rstrip() + "\n\n" + replacement + content[end:].lstrip("\n")

    def _resolve_path(self, file_path: str) -> Path:
        """解析工具路径；代码走 worktree，编排状态文件走主工作区。"""
        assert self._project_root is not None
        project_root = self._project_root.resolve()
        workspace_root = self._workspace_root()
        requested = Path(file_path)

        if requested.is_absolute():
            p = requested
            for root in (workspace_root, project_root):
                try:
                    rel = p.resolve().relative_to(root)
                except ValueError:
                    continue
                if _is_orchestrator_state_path(rel.as_posix()):
                    p = project_root / rel
                    break
        elif _is_orchestrator_state_path(requested.as_posix()):
            p = project_root / requested
        else:
            p = workspace_root / requested

        p = p.resolve()
        allowed_roots = (workspace_root, project_root)
        try:
            if not any(
                p == root or p.is_relative_to(root)
                for root in allowed_roots
            ):
                raise ValueError
        except ValueError:
            raise ValueError(f"path outside project root: {file_path}")
        return p

    def _tool_short_desc(self, tool_name: str, tool_input: dict) -> str:
        """为日志生成工具调用的简短描述。"""
        if tool_name == "Read":
            return str(tool_input.get("file_path", ""))
        if tool_name == "Write":
            return f"{tool_input.get('file_path', '')} ({len(tool_input.get('content', ''))}B)"
        if tool_name == "Edit":
            return tool_input.get("file_path", "")
        if tool_name == "Bash":
            cmd = str(tool_input.get("command", ""))
            return (cmd[:100] + "...") if len(cmd) > 100 else cmd
        if tool_name == "RunApp":
            return str(tool_input.get("action", ""))
        if tool_name == "Glob":
            return tool_input.get("pattern", "")
        if tool_name == "Grep":
            return f"{tool_input.get('pattern', '')} @ {tool_input.get('path', '.')}"
        return ""

    @staticmethod
    def _tool_call_signature(tool_name: str, tool_input: dict) -> str:
        """识别本轮调用内完全重复的只读工具调用。"""
        if tool_name == "Read":
            payload = {
                "file_path": tool_input.get("file_path"),
                "offset": tool_input.get("offset"),
                "limit": tool_input.get("limit"),
            }
        elif tool_name == "Bash":
            payload = {"command": str(tool_input.get("command", "")).strip()}
        elif tool_name == "Grep":
            payload = {
                "pattern": tool_input.get("pattern"),
                "path": tool_input.get("path", "."),
            }
        elif tool_name == "Glob":
            payload = {"pattern": tool_input.get("pattern")}
        elif tool_name == "RunApp":
            payload = {
                "action": tool_input.get("action"),
                "expression": tool_input.get("expression"),
            }
        else:
            return f"{tool_name}:{hashlib.sha1(repr(tool_input).encode()).hexdigest()}"
        return f"{tool_name}:{json.dumps(payload, sort_keys=True, ensure_ascii=False)}"

    @staticmethod
    def _enforce_read_only_stop(role: str) -> bool:
        """探索循环门禁只约束 developer；evaluator 的读/eval 本身是工作产物。"""
        return ROLES.get(role, {}).get("kind") == "developer"

    async def _tool_Read(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])
        assert self._project_root is not None
        feature_list_path = (self._project_root / "feature_list.json").resolve()
        progress_path = (self._project_root / "progress.md").resolve()
        handoff_path = (self._project_root / "session-handoff.md").resolve()
        if path == feature_list_path:
            content = await asyncio.to_thread(path.read_text, encoding="utf-8")
            filtered = _filter_feature_payload(json.loads(content))
            if self._current_feature_id:
                current = next(
                    (
                        feature for feature in filtered.get("features", [])
                        if feature.get("id") == self._current_feature_id
                    ),
                    None,
                )
                if current is not None:
                    filtered = {
                        "current_feature": self._current_feature_id,
                        "feature": current,
                    }
            rendered = json.dumps(filtered, ensure_ascii=False, indent=2)
        else:
            # 放到线程里避免阻塞事件循环（Ctrl+C 才能中断）
            content = await asyncio.to_thread(path.read_text, encoding="utf-8")
            if path == progress_path:
                rendered = _relevant_progress_excerpt(
                    content,
                    self._current_feature_id,
                    MAX_RELEVANT_PROGRESS_CHARS,
                )
            elif path == handoff_path:
                rendered = _relevant_handoff_excerpt(
                    content,
                    self._current_feature_id,
                    MAX_HANDOFF_CHARS,
                )
            else:
                rendered = content

        offset = input.get("offset")
        limit = input.get("limit")
        if offset is not None or limit is not None:
            try:
                start = max(0, int(offset or 1) - 1)
                count = max(1, int(limit or 400))
            except (TypeError, ValueError):
                return "Error: offset/limit must be integers"
            lines = rendered.splitlines()
            rendered = "\n".join(lines[start:start + count])
        return _truncate_text(rendered, MAX_TOOL_RESULT_CHARS, label="Read 输出")

    async def _tool_Write(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])

        # Phase-1: developer 角色禁止改 feature_list.json —— 防止自评通过。
        # 仅 test_engineer（evaluator）/ architect（planner）可写。
        if self._current_role and ROLES[self._current_role]["kind"] == "developer":
            rel = self._policy_relative_path(path)
            if rel in _PROTECTED_PATHS_FOR_DEVELOPER:
                return (
                    f"Error: developer cannot write {rel}; "
                    f"only test_engineer can set status=pass."
                )

        lock = await self._file_lock(path)
        async with lock:
            await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(
                path.write_text, input["content"], encoding="utf-8"
            )
        return f"Wrote {len(input['content'])} bytes to {input['file_path']}"

    async def _tool_Edit(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])

        # Phase-1: 与 _tool_Write 同 —— developer 不能改 feature_list.json
        if self._current_role and ROLES[self._current_role]["kind"] == "developer":
            rel = self._policy_relative_path(path)
            if rel in _PROTECTED_PATHS_FOR_DEVELOPER:
                return (
                    f"Error: developer cannot edit {rel}; "
                    f"only test_engineer can set status=pass."
                )

        lock = await self._file_lock(path)
        async with lock:
            content = await asyncio.to_thread(path.read_text, encoding="utf-8")
            old = input["old_string"]
            new = input["new_string"]
            if old not in content:
                if path.name in {"progress.md", "session-handoff.md"}:
                    replaced = self._replace_markdown_section(content, old, new)
                    if replaced is not None:
                        await asyncio.to_thread(
                            path.write_text, replaced, encoding="utf-8"
                        )
                        return (
                            f"Edited {input['file_path']} using section fallback "
                            f"(old_string had drifted)"
                        )
                return f"Error: old_string not found in {input['file_path']}"
            occurrences = content.count(old)
            if occurrences > 1:
                return (
                    f"Error: old_string matches {occurrences} times in "
                    f"{input['file_path']}; please make it unique"
                )
            await asyncio.to_thread(
                path.write_text, content.replace(old, new, 1), encoding="utf-8"
            )
            return f"Edited {input['file_path']}"

    async def _tool_Bash(self, input: dict) -> str:
        cmd = input["command"]
        timeout_ms = int(input.get("timeout") or 120000)
        timeout_s = timeout_ms / 1000
        assert self._project_root is not None

        # Phase-1: developer 角色禁止自提交 / 强行合并 / 强行 rebase
        # —— 这些动作必须由编排器在 test pass 后驱动，确保"无未验证提交"。
        if self._current_role and ROLES[self._current_role]["kind"] == "developer":
            for pat in _FORBIDDEN_BASH_PATTERNS:
                if pat.search(cmd):
                    return (
                        f"Error: forbidden in developer role: '{cmd[:120]}'\n"
                        f"test_engineer 验证通过后，编排器会自动 merge 到 master。"
                    )

        cwd = str(self._worktree_root or self._project_root)
        if _DIRECT_DEV_COMMAND_PATTERN.search(cmd):
            return (
                "Error: do not run `npm run dev` directly. "
                "Use RunApp(action='start'|'status'|'eval'|'stop') so startup/runtime "
                "stdout, stderr, exit codes and errors are captured."
            )
        # 平台兼容提示（仅日志；不阻止执行 —— Agent 可能已有替代方案）
        compat_hint = _check_windows_bash_compat(cmd)
        if compat_hint:
            log(f"      ⚠️  Bash 平台提示（Windows）: {compat_hint}")

        # Round 2: 智能超时分级 —— 如果 Agent 没显式传 timeout，按命令类型自动选
        if not input.get("timeout"):
            for pat, secs in _BASH_TIMEOUT_RULES:
                if pat.search(cmd):
                    timeout_s = secs
                    log(f"      ⏱  Bash 智能超时: {secs}s（命令类型匹配）")
                    break
            else:
                timeout_s = _BASH_DEFAULT_TIMEOUT

        # Round 2: stuck detection —— 同一命令连续 N 次同样错误提示 Agent 换方案
        # 用命令前 100 字符 + 错误前 60 字符 作为 key（避免长输出爆破 key）
        cmd_key = cmd.strip()[:100]
        shell_command = cmd
        shell_executable: str | None = None
        if sys.platform != "win32":
            # 让 `npm test | tail` / `typecheck | grep` 返回首个失败命令的退出码，
            # 避免 harness 被管道尾部命令的 exit 0 误导。
            shell_command = "set -o pipefail\n" + cmd
            shell_executable = "/bin/bash"
        try:
            # 把 subprocess.run 放到线程池里，让事件循环保持响应
            # （否则 Ctrl+C 在长命令期间无效）
            result = await asyncio.to_thread(
                subprocess.run,
                shell_command,
                shell=True,
                executable=shell_executable,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",  # Windows cp1252 default 会炸 UTF-8 输出（Node / Go / npm）
                errors="replace",  # 兜底：残余无法解码字节替换为 ? 而非崩溃
                timeout=timeout_s,
            )
            out = f"exit_code: {result.returncode}\n"
            if result.stdout:
                out += f"stdout:\n{result.stdout}\n"
            if result.stderr:
                out += f"stderr:\n{result.stderr}\n"
            # Round 2: 非 0 退出码也记为失败（用于 stuck 检测）
            if result.returncode != 0:
                err_pattern = (result.stderr or result.stdout or "")[:80].strip()
                self._record_bash_failure(cmd_key, err_pattern)
            else:
                self._record_bash_success(cmd_key)
            # Round 2: 把已注册的 stuck hint 拼到本次 tool_result 末尾让 Agent 看到
            out += self._consume_stuck_hint()
            return out
        except subprocess.TimeoutExpired:
            self._record_bash_failure(cmd_key, "timeout")
            return f"Error: command timed out after {timeout_s}s"

    def _app_log_dir_for_current_feature(self) -> Path:
        assert self._project_root is not None
        feature = self._current_feature_id or "general"
        safe_feature = re.sub(r"[^A-Za-z0-9_.-]+", "-", feature)
        return self._project_root / APP_LOGS_ROOT / safe_feature

    def _app_log_path_for_current_feature(self) -> Path:
        return self._app_log_dir_for_current_feature() / "app.log"

    @staticmethod
    def _read_log_tail(path: Path, max_lines: int = 200) -> str:
        if not path.exists():
            return "(no app log)"
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            return f"(failed to read app log: {e})"
        if len(lines) > max_lines:
            lines = lines[-max_lines:]
        return "\n".join(lines) or "(app log is empty)"

    def _app_process_running(self) -> bool:
        return (
            self._app_process is not None
            and self._app_process.returncode is None
        )

    def _ensure_workspace_node_modules(self, workspace: Path) -> str | None:
        """让 feature worktree 复用主工作区依赖，确保 RunApp 测的是 feature 代码。"""
        if workspace == self._project_root:
            return None
        node_modules = workspace / "node_modules"
        assert self._project_root is not None
        main_node_modules = self._project_root / "node_modules"
        if not main_node_modules.exists():
            return f"Error: node_modules not found in {self._project_root}"
        if node_modules.is_symlink():
            try:
                if node_modules.resolve() == main_node_modules.resolve():
                    return None
            except OSError:
                pass
        if node_modules.exists() and (node_modules / "electron-vite").exists():
            return None
        if node_modules.exists() or node_modules.is_symlink():
            try:
                if node_modules.is_symlink() or node_modules.is_file():
                    node_modules.unlink()
                else:
                    shutil.rmtree(node_modules)
            except OSError as e:
                return f"Error: failed to replace empty node_modules in {workspace}: {e}"
        try:
            node_modules.symlink_to(main_node_modules, target_is_directory=True)
        except OSError as e:
            return f"Error: failed to link node_modules into {workspace}: {e}"
        log(f"   🔗 RunApp 复用主工作区 node_modules: {node_modules}")
        return None

    async def _stop_managed_app(self, reason: str = "") -> str:
        process = self._app_process
        if process is None:
            return "(no managed app process)"

        if process.returncode is None:
            if reason:
                log(f"   🛑 停止应用进程 pid={process.pid}（{reason}）")
            if sys.platform == "win32":
                process.terminate()
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                if sys.platform == "win32":
                    process.kill()
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                with contextlib.suppress(Exception):
                    await process.wait()

        log_tail = self._read_log_tail(self._app_log_path) if self._app_log_path else ""
        if (
            self._app_log_path
            and self._app_runtime_log_path
            and self._app_log_path.exists()
        ):
            try:
                data = self._app_log_path.read_bytes()
                runtime_data = data[self._app_runtime_start_offset:]
                self._app_runtime_log_path.write_bytes(runtime_data)
            except OSError as e:
                log(f"   ⚠️ 写 runtime.log 失败: {e}")
        if self._app_log_handle is not None:
            with contextlib.suppress(Exception):
                self._app_log_handle.close()
        self._app_process = None
        self._app_log_handle = None
        return log_tail

    async def _tool_RunApp(self, input: dict) -> str:
        """启动/检查/停止应用，并统一保存 stdout + stderr 日志。"""
        action = str(input.get("action", "")).strip().lower()
        if action not in {"start", "status", "stop", "eval"}:
            return "Error: action must be start, status, stop, or eval"

        if action == "start":
            if self._app_process_running():
                tail = self._read_log_tail(
                    self._app_log_path or Path("__missing__")
                )
                return (
                    f"Error: app already running pid={self._app_process.pid}; "
                    f"log={self._app_log_path}\n{tail}"
                )

            assert self._project_root is not None
            workspace = self._workspace_root()
            dependency_error = self._ensure_workspace_node_modules(workspace)
            if dependency_error:
                return dependency_error
            log_dir = self._app_log_dir_for_current_feature()
            log_path = log_dir / "app.log"
            startup_log_path = log_dir / "startup.log"
            runtime_log_path = log_dir / "runtime.log"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_handle = log_path.open("ab", buffering=0)
            port = int(input.get("remote_debugging_port") or 9222)
            self._app_remote_debugging_port = port
            ready_timeout = max(5, int(input.get("ready_timeout_sec") or 60))
            command = (
                f"npm run dev -- --remoteDebuggingPort {port}"
            )
            log_handle.write(
                (
                    f"\n===== RUN APP {datetime.now().isoformat(timespec='seconds')} "
                    f"feature={self._current_feature_id or 'general'} "
                    f"role={self._current_role or 'unknown'} =====\n"
                    f"cwd={workspace}\ncommand={command}\n"
                ).encode("utf-8")
            )
            self._app_process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(workspace),
                stdout=log_handle,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=(sys.platform != "win32"),
            )
            self._app_log_handle = log_handle
            self._app_log_path = log_path
            self._app_startup_log_path = startup_log_path
            self._app_runtime_log_path = runtime_log_path
            self._app_runtime_start_offset = 0
            self._app_feature_id = self._current_feature_id
            self._current_run_app_status_checked = False
            self._current_run_app_ui_checked = False

            deadline = time.monotonic() + ready_timeout
            while time.monotonic() < deadline:
                if self._app_process.returncode is not None:
                    exit_code = self._app_process.returncode
                    tail = await self._stop_managed_app()
                    return (
                        f"Error: app exited during startup "
                        f"code={exit_code}\n"
                        f"startup_log={startup_log_path}\n"
                        f"runtime_log={runtime_log_path}\n"
                        f"app_log={log_path}\n{tail}"
                    )
                content = self._read_log_tail(log_path, max_lines=300)
                if (
                    "http://localhost:5173" in content
                    or "DevTools listening" in content
                ):
                    full_log = log_path.read_bytes()
                    startup_log_path.write_bytes(full_log)
                    self._app_runtime_start_offset = len(full_log)
                    self._current_run_app_started = True
                    return (
                        f"App started pid={self._app_process.pid}\n"
                        f"startup_log={startup_log_path}\n"
                        f"runtime_log={runtime_log_path}\n"
                        f"app_log={log_path}\n{content}"
                    )
                await asyncio.sleep(1)

            tail = await self._stop_managed_app("startup timeout")
            return (
                f"Error: app did not become ready within {ready_timeout}s\n"
                f"startup_log={startup_log_path}\n"
                f"runtime_log={runtime_log_path}\n"
                f"app_log={log_path}\n{tail}"
            )

        if action == "status":
            if self._app_process is None:
                return "(no managed app process)"
            state = (
                "running"
                if self._app_process.returncode is None
                else f"exited code={self._app_process.returncode}"
            )
            if state == "running":
                self._current_run_app_status_checked = True
            tail = self._read_log_tail(
                self._app_log_path or Path("__missing__")
            )
            return (
                f"state={state} pid={self._app_process.pid} "
                f"startup_log={self._app_startup_log_path} "
                f"runtime_log={self._app_runtime_log_path} "
                f"app_log={self._app_log_path}\n{tail}"
            )

        if action == "eval":
            if not self._app_process_running():
                return "Error: app must be running before RunApp(action='eval')"
            expression = str(input.get("expression", "")).strip()
            if not expression:
                return "Error: expression is required for RunApp(action='eval')"

            workspace = self._workspace_root()
            cdp_script = workspace / "scripts" / "_cdp-smoke.mjs"
            if not cdp_script.exists():
                return f"Error: CDP helper not found: {cdp_script}"

            result = await asyncio.to_thread(
                subprocess.run,
                ["node", str(cdp_script), expression],
                cwd=str(workspace),
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                env={
                    **os.environ,
                    "CDP_PORT": str(self._app_remote_debugging_port),
                },
            )
            output = (result.stdout or "").strip()
            error = (result.stderr or "").strip()
            if result.returncode != 0:
                return (
                    f"Error: renderer eval failed exit_code={result.returncode}\n"
                    f"stdout={output}\nstderr={error}"
                )
            if not output or output in {"null", "undefined"}:
                return (
                    "Error: renderer eval returned no observable value; "
                    "assert or return the UI state instead"
                )
            self._current_run_app_ui_checked = True
            return f"Renderer eval passed\nstdout={output}\nstderr={error}"

        tail = await self._stop_managed_app("requested by agent")
        return (
            f"App stopped\nstartup_log={self._app_startup_log_path} "
            f"runtime_log={self._app_runtime_log_path} "
            f"app_log={self._app_log_path}\n{tail}"
        )

    async def _tool_Glob(self, input: dict) -> str:
        assert self._project_root is not None
        pattern = input["pattern"]
        root = self._workspace_root()

        def _scan() -> list[str]:
            matches = sorted(root.glob(pattern))
            return [
                str(m.relative_to(root)) for m in matches[:200]
            ]

        result = await asyncio.to_thread(_scan)
        return "\n".join(result) or "(no matches)"

    async def _tool_Grep(self, input: dict) -> str:
        assert self._project_root is not None
        pattern = input["pattern"]
        path = input.get("path", ".")
        try:
            regex = re.compile(pattern)
        except re.error as e:
            return f"Error: bad regex: {e}"

        target = self._resolve_path(path)
        if not target.exists():
            return f"Error: {path} does not exist"

        def _scan() -> list[str]:
            files = (
                [target] if target.is_file()
                else [f for f in target.rglob("*") if f.is_file()]
            )
            matches: list[str] = []
            for f in files:
                try:
                    lines = f.read_text(encoding="utf-8").splitlines()
                except (UnicodeDecodeError, OSError):
                    continue
                for i, line in enumerate(lines, 1):
                    if regex.search(line):
                        matches.append(
                            f"{self._policy_relative_path(f)}:{i}: {line}"
                        )
                        if len(matches) >= 200:
                            return matches
            return matches

        matches = await asyncio.to_thread(_scan)
        return "\n".join(matches) or "(no matches)"

    _TOOL_EXECUTORS = {
        "Read": _tool_Read,
        "Write": _tool_Write,
        "Edit": _tool_Edit,
        "Bash": _tool_Bash,
        "RunApp": _tool_RunApp,
        "Glob": _tool_Glob,
        "Grep": _tool_Grep,
    }

    # ---- Round 2: Bash 失败模式识别 ----

    def _record_bash_failure(self, cmd_key: str, err_pattern: str) -> None:
        """记录一条 bash 失败；同命令累计达阈值时给 Agent 提示换方案。"""
        # 错误模式归一化：去空白 + 前 60 字符
        norm = " ".join(err_pattern.split())[:60]
        hist = self._bash_fail_history.setdefault(cmd_key, [])
        # 仅保留最近 5 条错误
        hist.append(norm)
        if len(hist) > 5:
            del hist[:-5]
        # 累计相同错误次数
        same_err_count = sum(1 for h in hist if h == norm)
        if same_err_count >= _STUCK_FAILURE_THRESHOLD:
            log(
                f"      🪤 STUCK DETECTED: 命令已连续失败 {same_err_count} 次"
                f"（错误模式: {norm[:40]}...）"
            )
            log(
                f"      💡 建议：请换一种方式（例如：用 PowerShell 等价物、"
                f"拆分命令、检查工作目录、跳过该命令直接读文件等）。"
                f"重复 retry 同一命令不会改变结果。"
            )
            # 在 tool_result 里也提示 Agent（让下一轮模型看到）
            # 注：此方法由 _tool_Bash 在返回前调用，无法改返回值；
            # 通过 self._stuck_hint 传给调用方做尾部注入。
            self._stuck_hint = (
                f"\n\n[STUCK WARNING] 命令 `{cmd_key[:60]}...` 已连续失败 "
                f"{same_err_count} 次（错误：{norm}）。"
                f"建议换一种方式而不是重复同一命令。"
            )

    def _record_bash_success(self, cmd_key: str) -> None:
        """成功：清零该命令的失败计数。"""
        self._bash_fail_history.pop(cmd_key, None)
        if hasattr(self, "_stuck_hint"):
            self._stuck_hint = ""

    def _consume_stuck_hint(self) -> str:
        """给 _tool_Bash 用：取出当前 stuck 提示（如果有），下次调用清零。"""
        hint = getattr(self, "_stuck_hint", "")
        self._stuck_hint = ""
        return hint

    def _build_context_snapshot(
        self,
        root: Path,
        *,
        role: str | None = None,
        feature_id: str | None = None,
    ) -> str:
        """构建有预算、按角色/feature 裁剪的 harness context。

        不再把整份 progress.md、全部 feature 详情和完整 handoff 注入每一次
        follow-up。Agent 需要更多内容时可使用 Read(offset/limit) 精确读取。
        """
        features_path = root / "feature_list.json"
        progress_path = root / "progress.md"
        handoff_path = root / "session-handoff.md"

        progress_tail = (
            _relevant_progress_excerpt(
                progress_path.read_text(encoding="utf-8"),
                feature_id,
                MAX_RELEVANT_PROGRESS_CHARS,
            )
            if progress_path.exists()
            else "(无 progress.md)"
        )
        handoff_text = (
            _relevant_handoff_excerpt(
                handoff_path.read_text(encoding="utf-8"),
                feature_id,
                MAX_HANDOFF_CHARS,
            )
            if handoff_path.exists()
            else "(无 session-handoff.md)"
        )

        feature_summary_lines = ["(无 feature_list.json)"]
        feature_full_text = "(无 feature_list.json)"
        if features_path.exists():
            try:
                raw_text = features_path.read_text(encoding="utf-8")
                raw = json.loads(raw_text)
                filtered_raw = _filter_feature_payload(raw)
                feats = filtered_raw["features"]
                lines = []
                for f in feats:
                    lines.append(
                        f"- [{f.get('status','?')}] {f.get('id')} :: {f.get('name')} "
                        f":: owner={f.get('ownerRole','?')} :: deps={f.get('dependencies',[])}"
                    )
                feature_summary_lines = lines
                relevant_feature = next(
                    (f for f in feats if f.get("id") == feature_id),
                    None,
                )
                if relevant_feature is None and feature_id is None:
                    relevant_feature = next(
                        (
                            f for f in feats
                            if f.get("status") in ("in_progress", "blocked")
                        ),
                        None,
                    )
                feature_full_text = json.dumps(
                    relevant_feature or {
                        "note": "本次未指定 feature；只提供摘要。",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            except Exception as e:  # pragma: no cover
                feature_summary_lines = [f"(解析失败: {e})"]
                feature_full_text = feature_summary_lines[0]

        snapshot = (
            "【规则地图 / 上下文快照】\n\n"
            f"当前角色: {role or 'unknown'}；当前 feature: {feature_id or '未指定'}\n"
            "上下文已按预算裁剪；需要历史细节时用 Read(offset/limit) 精确读取，"
            "不要重复整文件读取。\n\n"
            "### feature_list.json (摘要)\n"
            "\n".join(feature_summary_lines) + "\n\n"
            "### 当前 feature（完整 JSON）\n"
            "```json\n" + feature_full_text.strip() + "\n```\n\n"
            "### progress.md (当前 feature 相关段)\n"
            "```\n" + progress_tail + "\n```\n"
            "### session-handoff.md (核心交接段)\n"
            "```md\n" + handoff_text.strip() + "\n```\n"
        )
        snapshot = _truncate_text(
            snapshot, MAX_CONTEXT_SNAPSHOT_CHARS, label="上下文快照"
        )
        cache_key = f"{role or '-'}:{feature_id or '-'}"
        digest = hashlib.sha1(
            (
                feature_full_text + "|" + progress_tail + "|" + handoff_text
            ).encode("utf-8")
        ).hexdigest()[:16]
        cached = self._snapshot_cache.get(cache_key)
        if cached and cached[0] == digest:
            return cached[1]
        self._snapshot_cache[cache_key] = (digest, snapshot)
        return snapshot


# ============================================================================
# 编排主循环
# ============================================================================

class Orchestrator:
    """状态机驱动的工作流编排器。"""

    def __init__(self, args: argparse.Namespace) -> None:
        self.root = PROJECT_ROOT
        # Phase-1 flags（默认 off → 保持现有行为；CI/dry-run 显式打开旁路）
        self.use_git_worktree: bool = not getattr(args, "no_git_worktree", False)
        self.use_file_lock: bool = not getattr(args, "no_file_lock", False)
        self.full_design: bool = bool(getattr(args, "full_design", False))
        self.full_deliver: bool = bool(getattr(args, "full_deliver", False))
        self.use_preflight: bool = not getattr(args, "no_preflight", False)
        self.state = StateStore(self.root, use_lock=self.use_file_lock)
        self.client = AgentClient(
            api_url=args.api_url,
            model=args.model,
            max_concurrent=args.max_concurrent,
            max_output_tokens=args.max_output_tokens,
            per_call_token_limit=args.token_warn_threshold,
            allow_docker=not getattr(args, "no_docker", False),
        )
        self.client._project_root = self.root
        # Round 2: wall-time 上限注入 AgentClient
        self.client.max_agent_wall_seconds = (
            getattr(args, "max_agent_minutes", 30) * 60
        )
        self.budget = TokenBudget()
        # Round 8: 把 rate limiter 注入到 AgentClient，让 _call_with_timeout
        # 在发起请求前主动等到能容纳新请求（RPM/TPM 滑动窗口）
        self.client.set_rate_limiter(self.budget)
        self.dry_run = args.dry_run
        self.max_cycles = args.max_cycles
        self._stop = asyncio.Event()
        # Phase-1: 进程内 per-feature asyncio.Lock（flock 之外的兜底）
        self._feature_locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()
        # 当前 feature 的 worktree（用于 deliver 阶段）
        self._active_worktree: Worktree | None = None
        # 同一方案内，已完成角色无需在后续 attempt 重跑。
        self._develop_completed_roles: dict[tuple[str, int], set[str]] = {}
        # 当前运行 run() 的 task（用于 Ctrl+C 直接取消正在 await 的 API 调用）
        self._current_task: asyncio.Task | None = None
        # Round 7: SIGINT 计数（第二次直接 os._exit，避免 C-level 阻塞卡死）
        self._signal_count: int = 0

    # ----- 工作流阶段 ----------------------------------------------------

    async def _feature_lock(self, feature_id: str) -> asyncio.Lock:
        """进程内 per-feature asyncio.Lock —— flock 之外的兜底。

        flock 已能保证跨进程串行，但同一 orchestrator 内的多个 phase 也需要
        序列化对同一 feature 的状态写入。
        """
        async with self._locks_guard:
            lock = self._feature_locks.get(feature_id)
            if lock is None:
                lock = asyncio.Lock()
                self._feature_locks[feature_id] = lock
            return lock

    async def _run_agent_calls_serial(self, calls: list[Any]) -> list[AgentResult]:
        """按给定角色顺序逐个执行 Agent，避免并发写文件和启动应用。"""
        results: list[AgentResult] = []
        for index, call in enumerate(calls):
            try:
                results.append(await call)
            except BaseException:
                for pending in calls[index + 1:]:
                    close = getattr(pending, "close", None)
                    if close is not None:
                        close()
                raise
        return results

    async def _phase_audit_status(self, feature: Feature) -> None:
        """Post-develop audit：若 develop agent 越权把 status 改成 pass，强制回滚。

        在 _phase_develop 返回 True 后、_phase_test 之前调用。
        阻断 developer 自评的最后一道保险。

        Round 4 教训：原版在 async 函数内用同步 flock + subprocess.run，
        一旦阻塞（macOS BSD flock 在嵌套+残留 lock 的边界条件下偶尔僵死），
        整个 asyncio 事件循环会被冻死，且无任何 log 暴露卡点。
        修复：把同步部分整体移到 asyncio.to_thread，让事件循环保持响应；
        入口/出口加心跳 log（即便整个 body 僵死也至少能看到入口 log）。
        """
        # 心跳入口 —— 卡死时给运维一个线索
        log(f"   🔍 audit 入口: {feature.id}")
        async with await self._feature_lock(feature.id):
            # 同步 flock + 文件 I/O + git 命令 整体放进线程池
            await asyncio.to_thread(self._audit_status_sync, feature)
        log(f"   ✅ audit 出口: {feature.id}")

    def _audit_status_sync(self, feature: Feature) -> None:
        """_phase_audit_status 的同步 body —— 跑在线程池里不阻塞事件循环。"""
        with self.state.acquire(feature.id):
            features = self.state._load_features_unlocked()
            current = next((f for f in features if f.id == feature.id), None)
            if current is None:
                log(
                    f"   ⚠️  developer removed feature {feature.id}; "
                    f"rolling back via git checkout HEAD -- feature_list.json"
                )
                subprocess.run(
                    [
                        "git", "-C", str(self.root),
                        "checkout", "HEAD", "--", "feature_list.json",
                    ],
                    check=False, capture_output=True,
                    text=True,
                    encoding="utf-8", errors="replace",
                )
                return
            if current.status == "pass":
                log(
                    f"   ⚠️  developer set status=pass on {feature.id}; "
                    f"rolling back to in_progress (test_engineer 才有判定权)"
                )
                current.status = "in_progress"
                _touch_feature(current)
                self.state._save_features_unlocked(features)
            elif current.status not in ("in_progress", "blocked"):
                log(
                    f"   ⚠️  unexpected status={current.status} on "
                    f"{feature.id}; normalize to in_progress"
                )
                current.status = "in_progress"
                _touch_feature(current)
                self.state._save_features_unlocked(features)

    async def _mark_feature_in_progress(self, feature: Feature) -> None:
        """编排器在开始开发前写 status=in_progress，不依赖 developer 越权写状态。"""
        async with await self._feature_lock(feature.id):
            await asyncio.to_thread(self._mark_feature_in_progress_sync, feature)

    def _mark_feature_in_progress_sync(self, feature: Feature) -> None:
        with self.state.acquire(feature.id):
            features = self.state._load_features_unlocked()
            current = next((f for f in features if f.id == feature.id), None)
            if current is None:
                log(f"   ⚠️  开始开发前找不到 feature {feature.id}")
                return
            if current.status != "in_progress":
                previous = current.status
                current.status = "in_progress"
                _touch_feature(current)
                self.state._save_features_unlocked(features)
                feature.status = "in_progress"
                feature.tested_at = current.tested_at
                log(
                    f"   🟡 feature {feature.id} 状态: "
                    f"{previous} -> in_progress（编排器写入）"
                )

    def _create_worktree(self, feature: Feature) -> Worktree | None:
        """为 feature 建 worktree（若启用）。失败返回 None。"""
        if not self.use_git_worktree or self.dry_run:
            return None
        wt = Worktree.for_feature(self.root, feature.id)
        try:
            is_new_worktree = not wt.path.exists()
            wt.create()
            if is_new_worktree:
                self._sync_relevant_dirty_files(feature, wt)
            self._active_worktree = wt
            return wt
        except subprocess.CalledProcessError as e:
            log(
                f"   ❌ worktree 创建失败: {e.stderr.decode('utf-8', errors='ignore')[:200]}"
            )
            return None

    def _checkpoint_path(self, feature_id: str) -> Path:
        safe_feature = re.sub(r"[^A-Za-z0-9_.-]+", "-", feature_id)
        return self.root / CHECKPOINTS_ROOT / f"{safe_feature}.json"

    def _write_phase_checkpoint(
        self,
        feature_id: str,
        phase: str,
        *,
        approach: int,
        attempt: int,
        worktree_path: Path | None,
        completed_roles: list[str] | None = None,
    ) -> None:
        path = self._checkpoint_path(feature_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "feature_id": feature_id,
            "phase": phase,
            "approach": approach,
            "attempt": attempt,
            "worktree_path": str(worktree_path) if worktree_path else None,
            "completed_roles": completed_roles or [],
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)

    def _load_phase_checkpoint(self, feature_id: str) -> dict[str, Any] | None:
        path = self._checkpoint_path(feature_id)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if payload.get("feature_id") != feature_id:
            return None
        return payload

    def _clear_phase_checkpoint(self, feature_id: str) -> None:
        with contextlib.suppress(OSError):
            self._checkpoint_path(feature_id).unlink()

    def _retry_context_path(self, feature_id: str) -> Path:
        safe_feature = re.sub(r"[^A-Za-z0-9_.-]+", "-", feature_id)
        return self.root / RETRY_CONTEXT_ROOT / f"{safe_feature}.md"

    def _write_retry_context(
        self,
        feature: Feature,
        *,
        approach: int,
        attempt: int,
        reason: str,
        completed_roles: list[str],
        failed_roles: list[str],
        evidence: str,
        solution: str,
    ) -> None:
        path = self._retry_context_path(feature.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = (
            f"# Retry Context: {feature.id}\n\n"
            f"- updated_at: {datetime.now().isoformat(timespec='seconds')}\n"
            f"- approach: {approach}\n"
            f"- attempt: {attempt}\n"
            f"- reason: {reason}\n\n"
            f"## 已完成角色\n\n"
            f"{chr(10).join(f'- {r}' for r in completed_roles) or '- （无）'}\n\n"
            f"## 失败角色\n\n"
            f"{chr(10).join(f'- {r}' for r in failed_roles) or '- （无）'}\n\n"
            f"## 失败证据\n\n"
            f"```text\n{evidence.strip()[:12000]}\n```\n\n"
            f"## 下一次解决方案\n\n"
            f"{solution.strip()}\n\n"
            f"## 下一次硬约束\n\n"
            f"- 保留已完成角色已经落盘的代码，不要从头重写。\n"
            f"- 只允许重跑失败角色；若 test blocked，按反馈修订相关角色。\n"
            f"- 先读取本文件和现有 worktree diff，再开始修改。\n"
            f"- 完成后说明本轮相比上一轮具体修复了什么。\n"
        )
        tmp = path.with_suffix(".md.tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)
        log(f"   🧾 已生成下一次重试上下文: {path}")

    def _load_retry_context(self, feature_id: str) -> str:
        path = self._retry_context_path(feature_id)
        if not path.exists():
            return ""
        try:
            return path.read_text(encoding="utf-8")[:16000]
        except OSError:
            return ""

    def _clear_retry_context(self, feature_id: str) -> None:
        with contextlib.suppress(OSError):
            self._retry_context_path(feature_id).unlink()

    def _restore_test_worktree(self, feature: Feature) -> Worktree | None:
        if not self.use_git_worktree:
            return None
        wt = Worktree.for_feature(self.root, feature.id)
        if not wt.path.exists():
            return None
        wt.create()
        self._active_worktree = wt
        return wt

    def _dirty_main_worktree_files(self) -> list[str]:
        """列出会阻碍 worktree 一致性的主工作区脏文件。"""
        result = subprocess.run(
            [
                "git", "-C", str(self.root), "status", "--porcelain",
                "--untracked-files=all",
            ],
            check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        ignored = {
            "orchestrator.py",
            "ORCHESTRATOR.md",
            *ORCHESTRATOR_STATE_FILES,
        }
        dirty: list[str] = []
        for line in result.stdout.splitlines():
            if len(line) < 4:
                continue
            paths = line[3:].split(" -> ")
            for path in paths:
                normalized = path.strip()
                if normalized.startswith('"') and normalized.endswith('"'):
                    normalized = normalized[1:-1]
                if normalized and normalized not in ignored:
                    dirty.append(normalized)
        return sorted(set(dirty))

    def _sync_relevant_dirty_files(
        self,
        feature: Feature,
        wt: Worktree,
    ) -> list[str]:
        """把主工作区中与当前 feature 相关的脏代码同步到新 worktree。

        worktree 从 HEAD 创建时看不到主工作区的未提交实现。若直接运行，
        Agent 会误以为文件不存在并重复实现。这里仅同步与 feature 数据源、
       父 feature 或包配置相关的文件，避免把全部无关 WIP 带进 feature。
        """
        dirty = self._dirty_main_worktree_files()
        if not dirty:
            return []

        datasource = _datasource_of_feature_id(feature.id)
        parent_id = feature.id.split("--step--", 1)[0]
        tokens = {
            token.lower()
            for token in (datasource, parent_id)
            if token
        }
        tokens.update(
            part.lower()
            for part in re.split(r"[-_]+", parent_id)
            if len(part) >= 5
        )
        generic_config = {
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "tsconfig.node.json",
            "tsconfig.web.json",
            "electron.vite.config.ts",
        }
        relevant: list[str] = []
        for raw_path in dirty:
            normalized = raw_path.replace("\\", "/")
            lowered = normalized.lower()
            if (
                normalized in generic_config
                or any(token in lowered for token in tokens)
                or (
                    normalized.startswith("golang/")
                    and feature.owner_role.lower().startswith("golang")
                )
            ):
                relevant.append(normalized)

        synced: list[str] = []
        for relative in relevant:
            source = self.root / relative
            target = wt.path / relative
            try:
                if source.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                elif target.exists():
                    target.unlink()
                else:
                    continue
            except OSError as e:
                log(f"   ⚠️ 无法同步主工作区文件 {relative}: {e}")
                continue
            synced.append(relative)

        if synced:
            log(
                f"   ♻️ 已同步 {len(synced)} 个主工作区相关脏文件到 worktree:"
            )
            for path in synced[:12]:
                log(f"      · {path}")
            if len(synced) > 12:
                log(f"      · ... 另有 {len(synced) - 12} 个")
        return synced

    @staticmethod
    def _docker_server_version() -> str | None:
        """返回 Docker server 版本；CLI/daemon 不可用时返回 None。"""
        try:
            result = subprocess.run(
                [
                    "docker", "version",
                    "--format", "{{.Server.Version}}",
                ],
                check=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        version = result.stdout.strip()
        return version if result.returncode == 0 and version else None

    def _app_log_path_for_feature(self, feature_id: str) -> Path:
        safe_feature = re.sub(r"[^A-Za-z0-9_.-]+", "-", feature_id)
        return self.root / APP_LOGS_ROOT / safe_feature / "app.log"

    def _app_log_tail_for_feedback(
        self, feature_id: str, max_lines: int = 300,
    ) -> str:
        log_path = self._app_log_path_for_feature(feature_id)
        startup_path = log_path.with_name("startup.log")
        runtime_path = log_path.with_name("runtime.log")
        source_path = runtime_path if runtime_path.exists() else log_path
        if not source_path.exists():
            return (
                f"startup_log={startup_path}\n"
                f"runtime_log={runtime_path}\n"
                f"app_log={log_path}\n"
                "(app log not found)"
            )
        try:
            lines = source_path.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()
        except OSError as e:
            return (
                f"startup_log={startup_path}\n"
                f"runtime_log={runtime_path}\n"
                f"app_log={log_path}\n"
                f"(failed to read app log: {e})"
            )
        if len(lines) > max_lines:
            lines = lines[-max_lines:]
        return (
            f"startup_log={startup_path}\n"
            f"runtime_log={runtime_path}\n"
            f"app_log={log_path}\n"
            + "\n".join(lines)
        )

    async def _run_preflight_command(
        self,
        label: str,
        command: str,
        cwd: Path,
        *,
        timeout_sec: int,
    ) -> tuple[bool, str]:
        """运行一条确定性 harness 命令，并返回压缩后的证据。"""
        log(f"   🧪 preflight: {label} ...")
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                command,
                shell=True,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
            )
        except subprocess.TimeoutExpired:
            return False, f"$ {command}\nTIMEOUT after {timeout_sec}s"

        combined = "\n".join(
            part for part in (result.stdout, result.stderr) if part
        ).strip()
        combined = _truncate_text(
            combined or "(no output)",
            MAX_TOOL_RESULT_CHARS // 2,
            label=f"{label} 输出",
        )
        evidence = (
            f"$ {command}\nexit_code: {result.returncode}\n{combined}"
        )
        if result.returncode != 0:
            log(f"   ❌ preflight 失败: {label} (exit={result.returncode})")
        else:
            log(f"   ✅ preflight 通过: {label}")
        return result.returncode == 0, evidence

    async def _run_deterministic_preflight(
        self,
        feature: Feature,
        wt: Worktree,
    ) -> tuple[bool, str]:
        """在昂贵测试 Agent 之前先跑确定性检查，快速暴露机械型失败。"""
        if not self.use_preflight:
            return True, "deterministic preflight disabled"
        if not wt.path.exists():
            return True, "worktree not available"
        dependency_error = self.client._ensure_workspace_node_modules(wt.path)
        if dependency_error:
            return False, dependency_error

        changed = wt.changed_paths()
        if not changed:
            return False, "worktree 没有代码变更"

        checks: list[tuple[str, str, int]] = [
            ("diff whitespace/conflict markers", "git diff --check HEAD", 60),
        ]

        go_modules: set[Path] = set()
        has_ts = False
        has_tests = False
        has_build_inputs = False
        for raw_path in changed:
            path = raw_path.replace("\\", "/")
            if path.endswith(".go") or path.startswith("golang/"):
                parts = Path(path).parts
                if len(parts) >= 2 and parts[0] == "golang":
                    module_dir = wt.path / parts[0] / parts[1]
                    if (module_dir / "go.mod").exists():
                        go_modules.add(module_dir)
            if path.endswith((".ts", ".tsx", ".js", ".mjs", ".cjs")):
                has_ts = True
            if path.startswith("tests/") or path.endswith((".test.ts", ".test.tsx")):
                has_tests = True
            if path.startswith(
                ("src/main/", "src/preload/", "src/renderer/", "src/shared/")
            ) or path in {"package.json", "electron.vite.config.ts"}:
                has_build_inputs = True

        if has_build_inputs:
            checks.append(("npm build (includes typecheck)", "npm run build", 300))
        elif has_ts:
            checks.append(("npm typecheck", "npm run typecheck", 120))
        if has_tests or any(
            path.startswith(("src/", "tests/"))
            for path in (p.replace("\\", "/") for p in changed)
        ):
            checks.append(("npm unit tests", "npm test", 240))
        for module_dir in sorted(go_modules):
            module_name = module_dir.name
            checks.append(
                (
                    f"go vet ({module_name})",
                    "go vet ./...",
                    120,
                )
            )
            checks.append(
                (
                    f"go test ({module_name})",
                    "go test ./...",
                    240,
                )
            )

        evidences: list[str] = []
        for label, command, timeout_sec in checks:
            cwd = wt.path
            # Go 命令必须在具体 module 目录执行。
            if label.startswith(("go vet", "go test")):
                module_name = label.split("(", 1)[1].rstrip(")")
                cwd = wt.path / "golang" / module_name
            ok, evidence = await self._run_preflight_command(
                label, command, cwd, timeout_sec=timeout_sec
            )
            evidences.append(f"### {label}\n{evidence}")
            if not ok:
                return False, "\n\n".join(evidences)

        return True, "\n\n".join(evidences)

    @staticmethod
    def _blocked_feedback_is_actionable(text: str) -> tuple[bool, str]:
        """blocked 必须包含可执行失败证据，阻止空反馈触发新一轮重试。"""
        normalized = text or ""
        if "RESULT: blocked" not in normalized:
            return False, "缺少 RESULT: blocked"
        remainder = normalized.replace("RESULT: blocked", "", 1).strip()
        if len(remainder) < 80:
            return False, "blocked 后没有足够的失败说明"
        lowered = normalized.lower()
        has_structured = any(
            marker in lowered
            for marker in ("failure:", "step:", "expected:", "actual:", "owner:")
        )
        has_concrete_signal = bool(
            re.search(
                r"(exit_code|error|failed|fail|exception|timeout|"
                r"TypeError|ReferenceError|TS\d{4}|expected|actual)",
                normalized,
                re.IGNORECASE,
            )
        )
        if not has_structured and not has_concrete_signal:
            return False, "blocked 缺少 FAILURE/step/expected/actual 或具体错误信号"
        return True, normalized

    @staticmethod
    def _parse_test_verification(
        text: str, *, require_real_env: bool = False,
        require_app_start: bool = False,
        run_app_started: bool = False,
        run_app_status_checked: bool = False,
        run_app_ui_checked: bool = False,
    ) -> tuple[bool, str]:
        """校验 test_engineer 的结构化结论，阻止 mock-only pass。"""
        normalized = text or ""
        if "RESULT: blocked" in normalized:
            actionable, reason = Orchestrator._blocked_feedback_is_actionable(
                normalized
            )
            if not actionable:
                return False, f"test_engineer blocked 反馈不可执行: {reason}"
            return False, normalized
        if "RESULT: pass" not in normalized:
            return False, "test_engineer 未明确输出 RESULT: pass/blocked"

        fields: dict[str, str] = {}
        for line in normalized.splitlines():
            match = re.match(
                r"^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$", line
            )
            if match:
                fields[match.group(1).lower()] = match.group(2)

        missing: list[str] = []
        for field in (
            "typecheck", "unit_tests", "build", "docker",
            "seed_data", "roundtrip", "electron", "mock",
        ):
            if field not in fields:
                missing.append(field)
        if missing:
            return False, (
                "RESULT: pass 缺少结构化验证字段: "
                + ", ".join(missing)
            )

        hard_pass_fields = ("typecheck", "unit_tests", "build")
        for field in hard_pass_fields:
            if not fields[field].lower().startswith("pass"):
                return False, f"{field} != pass: {fields[field]}"
        if fields["mock"].strip().lower() != "none":
            return False, (
                "mock 必须为 none；mock/单测不能作为功能通过依据: "
                + fields["mock"]
            )
        for field in ("docker", "seed_data", "roundtrip", "electron"):
            value = fields[field].strip().lower()
            if not (value.startswith("pass") or value.startswith("n/a")):
                return False, f"{field} 必须为 pass 或 n/a: {fields[field]}"
            if require_real_env and field in {
                "docker", "seed_data", "roundtrip",
            } and not value.startswith("pass"):
                return False, (
                    f"{field} 必须使用真实 Docker/数据环境验证，不能为 n/a: "
                    f"{fields[field]}"
                )
        if require_app_start:
            if not fields["electron"].strip().lower().startswith("pass"):
                return False, (
                    "electron 必须为 pass：test_engineer 必须实际启动并操作应用，"
                    f"不能为 n/a: {fields['electron']}"
                )
            if not run_app_started:
                return False, (
                    "test_engineer 声称 electron pass，但本次调用没有成功执行 "
                    "RunApp(action='start')；拒绝 pass"
                )
            if not run_app_status_checked:
                return False, (
                    "test_engineer 启动应用后没有通过 RunApp(action='status') "
                    "确认应用仍在运行；拒绝 pass"
                )
            if not run_app_ui_checked:
                return False, (
                    "test_engineer 没有通过 RunApp(action='eval') 实际检查/操作 "
                    "运行中的 renderer；拒绝 pass"
                )
        return True, normalized

    async def _phase_design(self, features: list[Feature]) -> Feature | None:
        """Phase 1: 产品经理 + 架构师共同决定下一个交付单元。"""
        next_feature = self.state.next_pending(features)
        if not next_feature:
            log("🎯 没有待开发的功能，跳过设计阶段。")
            return None

        with log_scope(phase="design", feature=next_feature.id,
                       feature_name=next_feature.name):
            feature_card(next_feature, extra="阶段: design（产品 + 架构 共同设计）")
            log(f"📐 设计阶段：下一交付单元 = [{next_feature.status}] "
                f"{next_feature.id} :: {next_feature.name}")

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return next_feature

        normal_prompt = (
            f"请为功能 `{next_feature.id}` 做一次合并设计（产品目标 + 技术方案 + "
            f"UI 交接，拒绝重复评审）：\n"
            f"  - 名称: {next_feature.name}\n"
            f"  - 描述: {next_feature.description}\n"
            f"  - 依赖: {next_feature.dependencies}\n"
            f"  - 建议 ownerRole: {next_feature.owner_role or '待指派'}\n\n"
            f"只输出可执行设计，不写宣传性内容：\n"
            f"  1) 3-5 句用户故事 + 可伪证验收标准；\n"
            f"  2) 最小模块边界、接口/数据契约和复用点；\n"
            f"  3) 若涉及 UI，给出关键组件与状态，不写完整 demo 源码；\n"
            f"  4) 列出全局禁止范围，防止顺手重构；\n"
            f"  5) 在 progress.md 追加 `## Design :: {next_feature.id}` 段；\n"
            f"  6) 不要修改 feature_list.json。"
        )
        if self.full_design:
            pm_prompt = (
                f"{normal_prompt}\n\n"
                f"本轮你是产品经理：重点完成用户故事、验收标准、UI 交接。"
            )
            arch_prompt = (
                f"请复核 `{next_feature.id}` 的产品设计，并补充技术方案、"
                f"模块边界、接口契约、风险与落地步骤。只做增量，不重复产品评审；"
                f"写入 `## Arch :: {next_feature.id}`。"
            )
            results = await self._run_agent_calls_serial([
                self.client._call_with_timeout(
                    role="product_manager", prompt=pm_prompt,
                    project_root=self.root, feature_id=next_feature.id,
                ),
                self.client._call_with_timeout(
                    role="golang_senior", prompt=arch_prompt,
                    project_root=self.root, feature_id=next_feature.id,
                ),
            ])
        else:
            design_roles = sorted(_roles_for_feature(next_feature))
            design_role = design_roles[0] if design_roles else "golang_senior"
            log(
                f"   ⚡ 快速设计：只调用 {design_role}，"
                f"需要双角色评审时使用 --full-design"
            )
            results = [
                await self.client._call_with_timeout(
                    role=design_role, prompt=normal_prompt,
                    project_root=self.root, feature_id=next_feature.id,
                )
            ]

        any_ok = False
        for r in results:
            if r.ok:
                any_ok = True
            else:
                log(f"   ⚠️  Agent {r.role} 失败：{r.text[:200]}")

        if any_ok:
            best_text = "\n---\n".join(
                r.text[:1500] for r in results if r.ok
            )
            self.state.append_progress(
                f"Design :: {next_feature.id}",
                f"产品经理 + 架构师串行设计：\n\n{best_text}",
            )
        return next_feature if any_ok else None

    async def _phase_develop(
        self, feature: Feature, test_feedback: str = "", approach: int = 1
    ) -> bool:
        """Phase 2: 单个开发 Agent 负责一个功能（一次只做一个，不做自评）。

        test_feedback: 来自上一轮 test_engineer 的反馈（仅在重试时传入）。
        approach: 当前是第几套方案（1=初次；>1=已重设计）。

        Phase-1 增强：在 feature worktree 内开发，避免污染 master 分支；
        developer 角色禁用 git commit / push / merge（黑名单），
        真正的合并由 test pass 后编排器驱动。
        """
        with log_scope(phase="develop", feature=feature.id,
                       feature_name=feature.name, approach=approach,
                       approach_max=MAX_RETHINK + 1):
            feature_card(
                feature, approach=approach,
                extra="阶段: develop（golang_senior → frontend_senior 串行；前端基于 PM 的 UI demo 实现）",
            )
            log(f"🛠️  开发阶段 (方案 {approach})：{feature.id} :: {feature.name}")

        # Phase-1: 为 feature 建 worktree
        wt = self._create_worktree(feature)
        worktree_root = wt.path if wt else None

        feedback_section = ""
        if test_feedback:
            feedback_section = (
                f"\n【上一轮 test_engineer 反馈（你必须针对性修复）】\n"
                f"{test_feedback[:1500]}\n"
            )
        retry_context = self._load_retry_context(feature.id)
        retry_context_section = ""
        retry_mode_section = ""
        if retry_context:
            retry_mode_section = (
                "【本轮运行模式：Retry Context 执行，不是重新开发】\n"
                "上一轮已经完成事实总结和方案整理。本轮唯一事实源是下面的 "
                "Retry Context；必须先完整阅读，再执行其中的“下一次解决方案”。\n"
                "禁止：\n"
                "  - 忽略 Retry Context 重新从任务描述开始试错；\n"
                "  - 重做已完成角色已经落盘的部分；\n"
                "  - 重新尝试已经被上下文判定失败的旧方案；\n"
                "  - 扩大范围或顺手重构无关代码。\n"
                "允许：读取现有 diff、测试输出和 app runtime.log，围绕解决方案做最小修复。\n\n"
            )
            retry_context_section = (
                f"\n【上一轮失败总结与下一次上下文（必须先阅读）】\n"
                f"{retry_context}\n"
            )

        approach_hint = ""
        if approach > 1:
            approach_hint = (
                f"\n【重要】这是第 {approach} 套方案 —— 已重设计过。\n"
                f"请先阅读 progress.md 中 `## Rethink :: {feature.id}` 段"
                f"（架构师基于第一性原理的新设计），按新方案实现，**避免过度设计**：\n"
                f"  - 不堆抽象、不预留扩展、不为\"未来需求\"留口子；\n"
                f"  - 只为本 feature 写最干净的代码；\n"
                f"  - 如果新方案说\"重构现有 X 部分\"，就只重构 X 那一处，不要顺手改其它。\n"
            )

        prompt_base = (
            f"{retry_mode_section}"
            f"现在开发【单一功能】（方案 {approach}）：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n"
            f"  - 依赖: {feature.dependencies}\n"
            f"{retry_context_section}{feedback_section}{approach_hint}\n"
            f"硬性要求：\n"
            f"  1) 本次只交付这一个功能，不要顺手做其它功能；\n"
            f"  2) 编排器已把 `{feature.id}` 标记为 `in_progress`；"
            f"不要修改 feature_list.json 的 status；\n"
            f"  3) 自测只做与改动直接相关的确定性检查：\n"
            f"     - `npm run typecheck` / `go vet ./...` / 相关单测先过；\n"
            f"     - 涉及构建配置时跑 `npm run build`；\n"
            f"     - 涉及 UI/IPC 时用 `RunApp(action='start')` 做最短路径核验后立即 stop；\n"
            f"     - 完整的 Docker/roundtrip/ Electron 验收由 test_engineer 独立执行，"
            f"不要在这里重复整套 E2E；\n"
            f"  4) 在 progress.md 追加 `## Develop :: {feature.id}` 段记录实现要点"
            f"（含自测时应用启动看到什么）；\n"
            f"  5) 【重要】不要自我评估 pass/blocked！完成后用一行 `DONE` 表示代码写完即可；\n"
            f"    pass/blocked 由 test_engineer 独立验证后给出。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        await self._mark_feature_in_progress(feature)

        # 串行调用 2 个开发角色（同一 feature 不同视角）：
        #   - golang_senior：后端/引擎（golang/esmigrator）
        #   - frontend_senior：前端架构 + UI 实现（基于产品经理的 UI demo）
        # 后端/架构先执行，前端随后基于最新文件继续；只写代码 + DONE，不做自评
        # 注：UI 工程师已合并到产品经理（design 阶段产出 UI demo），
        #   并由 frontend_senior 直接实现。
        prompt_with_angle = lambda angle: (
            prompt_base
            + f"\n\n【本角色职责角度】\n{angle}\n"
        )

        all_angles = {
            "golang_senior": (
                "你的视角：数据转换引擎（golang/esmigrator + pgmigrator + dispatcher）。\n"
                "负责：Source/Transform/Sink 接口、归一化中间格式 Record、"
                "类型转换规则（默认 JSON + 用户指定映射）、并发 worker、"
                "流式 IO、bulk 导入、scroll/search_after、断点续传。\n"
                "**所有功能必须基于统一数据转换引擎（Source→Normalize→Transform→Sink）实现**，"
                "不要写绕过引擎的 ad-hoc 代码。如果本功能不涉及 Go 代码，"
                "请简要说明 N/A 并返回 `DONE`。"
            ),
            "frontend_senior": (
                "你的视角：前端架构 + UI 实现（src/renderer + src/main + src/preload）。\n"
                "负责：React 组件、状态、preload 桥接、安全 IPC 模式，以及视觉与交互细节。\n"
                "**基于 `## Design :: {feature.id}` 的设计契约实现**"
                "（有 demo/组件契约就直接落地；只有关键状态与交互契约时按现有页面模式实现；"
                "如设计不涉及 UI，请简要说明 N/A 并返回 `DONE`）。"
            ),
        }
        target_roles = _roles_for_feature(feature)
        if wt is not None:
            changed = wt.changed_paths()
            target_roles |= _roles_from_changed_paths(changed)
        if not target_roles:
            target_roles = set(all_angles)
        angles = {
            role: angle for role, angle in all_angles.items()
            if role in target_roles
        }
        log(
            f"   🎯 本次开发角色: {', '.join(sorted(angles))} "
            f"(ownerRole={feature.owner_role or 'unknown'})"
        )

        role_key = (feature.id, approach)
        checkpoint = self._load_phase_checkpoint(feature.id)
        checkpoint_roles: set[str] = set()
        if (
            checkpoint
            and checkpoint.get("phase") == "develop"
            and checkpoint.get("approach") == approach
        ):
            checkpoint_roles = set(checkpoint.get("completed_roles") or [])
        if test_feedback:
            self._develop_completed_roles[role_key] = set()
            checkpoint_roles = set()
        completed_roles = self._develop_completed_roles.setdefault(
            role_key, set()
        )
        completed_roles.update(checkpoint_roles)
        pending_roles = {
            role: angle
            for role, angle in angles.items()
            if role not in completed_roles
        }
        if completed_roles:
            log(
                f"   ⏭️ 本方案已完成角色: "
                f"{', '.join(sorted(completed_roles))}；"
                f"本轮只重跑: {', '.join(sorted(pending_roles)) or '（无）'}"
            )
        if not pending_roles:
            return True

        before_digest = (
            wt.diff_digest()
            if wt is not None and (test_feedback or retry_context)
            else ""
        )
        results: list[AgentResult] = []
        for role, angle in pending_roles.items():
            result = await self.client._call_with_timeout(
                role=role, prompt=prompt_with_angle(angle),
                project_root=self.root,
                feature_id=feature.id,
                worktree_root=worktree_root,
            )
            results.append(result)
            if result.ok:
                completed_roles.add(result.role)
                if wt is not None:
                    self._write_phase_checkpoint(
                        feature.id,
                        "develop",
                        approach=approach,
                        attempt=0,
                        worktree_path=wt.path,
                        completed_roles=sorted(completed_roles),
                    )

        any_ok = False
        successful_roles: set[str] = set()
        for r in results:
            if r.ok:
                any_ok = True
                successful_roles.add(r.role)
                completed_roles.add(r.role)
                # 注意：开发者禁止自评；不解析 RESULT: pass/in_progress
                if "DONE" in r.text:
                    log(f"   📝 {r.role} 完成代码（等待 test_engineer 验证）")
        if any_ok and wt and not wt.has_changes():
            log(
                "   ❌ developer 返回完成，但 worktree 没有任何代码变更；"
                "按开发失败处理，不进入 test/提交"
            )
            self._write_retry_context(
                feature,
                approach=approach,
                attempt=0,
                reason="developer 返回完成但 worktree 无代码变更",
                completed_roles=sorted(completed_roles),
                failed_roles=sorted(set(pending_roles) - successful_roles),
                evidence="\n\n".join(
                    f"{r.role}: {r.text[:1500]}" for r in results
                ),
                solution=(
                    "保留已完成角色的代码，只让未产生变更或失败的角色"
                    "检查 worktree diff，确认是否漏写文件；完成真实修改后再进入 test。"
                ),
            )
            return False
        if (
            any_ok
            and wt is not None
            and before_digest
            and wt.diff_digest() == before_digest
        ):
            validated_existing_diff = any(
                result.ok
                and result.run_app_started
                and result.run_app_status_checked
                and result.run_app_ui_checked
                for result in results
            )
            if validated_existing_diff:
                log(
                    "   ♻️ 本轮未新增 diff，但已在真实 Electron 中重新验证现有"
                    "worktree 实现；允许进入 test_engineer 独立验收"
                )
            else:
                log(
                    "   ❌ retry 角色返回完成，但没有产生任何代码/diff 变化；"
                    "禁止把同一版本再次送入 test_engineer"
                )
                self._write_retry_context(
                    feature,
                    approach=approach,
                    attempt=0,
                    reason="retry 没有产生代码变更",
                    completed_roles=sorted(completed_roles),
                    failed_roles=sorted(set(pending_roles)),
                    evidence=(
                        "本轮指定角色执行后 worktree diff digest 未变化。"
                        "上一次测试反馈仍然有效：\n"
                        + (test_feedback or retry_context)
                    ),
                    solution=(
                        "不要再次复述分析或只改文档。请针对反馈定位到具体代码，"
                        "产生实际 diff；若无法修复，明确输出阻塞原因和具体文件/接口决策。"
                    ),
                )
                return False
        required_roles = set(pending_roles)
        if not required_roles.issubset(successful_roles):
            failed_roles = sorted(required_roles - successful_roles)
            log(
                f"   ❌ 本 attempt 未完成的开发角色: "
                f"{', '.join(failed_roles)}；下一 attempt 只重跑这些角色"
            )
            failed_results = [
                r for r in results if r.role in failed_roles
            ]
            self._write_retry_context(
                feature,
                approach=approach,
                attempt=0,
                reason="develop attempt 未完成",
                completed_roles=sorted(completed_roles),
                failed_roles=failed_roles,
                evidence="\n\n".join(
                    f"{r.role}: {r.text[:2500]}" for r in failed_results
                )
                or "失败角色没有返回可读文本，请检查 session.log。",
                solution=(
                    f"下一次只重跑失败角色: {', '.join(failed_roles)}。"
                    f"已完成角色: {', '.join(sorted(completed_roles)) or '无'}，"
                    "直接读取并复用它们留在 worktree 的实现，不要重新实现。"
                    "失败角色应先读取现有 diff、测试输出和应用日志，再做最小修复。"
                ),
            )
            return False
        return True

    async def _phase_test(self, feature: Feature) -> tuple[bool, str]:
        """Phase 3: 验证功能是否可用（test_engineer 是唯一判定者）。

        test_engineer 启动真实应用，站在用户视角走一遍验收路径，
        判断这个 feature 用户真的能用：
          - passed=True：test_engineer 给出 `RESULT: pass`（功能可用），
            feature 标 pass；编排器先提交 feature 代码，再 merge 回集成分支。
          - passed=False：test_engineer 给出 `RESULT: blocked`（功能不可用）
            或未明确表态，feedback 用于回流到 develop 重试；worktree 保留供下轮续用。

        Phase-1 增强：
          * develop 阶段无任何文件改动时，跳过 test（保留 in_progress）。
          * pass 时自动提交一次 feature，再 git merge feature/<id> -> 集成分支。
        """
        with log_scope(phase="test", feature=feature.id,
                  feature_name=feature.name):
            feature_card(feature, extra="阶段: test（验证功能是否可用，test_engineer 唯一判定）")
            log(f"🧪 测试阶段：{feature.id} :: {feature.name}")

        # Phase-1: no-op 开发检测 —— develop 没改任何文件就不浪费 token 跑 test
        wt = self._active_worktree
        if wt and wt.path.exists() and not wt.has_changes():
            log(
                f"   ⏭️  worktree 无变更（has_changes=False），"
                f"跳过 test，feature 保留 in_progress"
            )
            self.state.append_progress(
                f"Develop :: {feature.id}",
                "develop 阶段未产生任何文件变更（worktree diff 为空），"
                "跳过 test_engineer 验证；feature 保留 in_progress 待重试。",
                section_owner=feature.id,
            )
            return False, "develop 阶段无任何代码变更，请实际实现该 feature"

        preflight_ok = True
        preflight_report = "worktree preflight skipped"
        if not self.dry_run and wt and wt.path.exists():
            preflight_ok, preflight_report = await self._run_deterministic_preflight(
                feature, wt
            )
            if not preflight_ok:
                self.state.append_progress(
                    f"Harness Preflight :: {feature.id}",
                    preflight_report,
                    section_owner=feature.id,
                )
                return False, (
                    "编排器确定性预检失败，未启动昂贵 test_engineer 调用。"
                    "请只修复以下机械错误后重新提交：\n\n"
                    + preflight_report
                )

        prompt = (
            f"**你的职责：验证这个功能是否可用** —— 用户真的能用吗？\n"
            f"\n"
            f"被验证的功能：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n\n"
            f"验证步骤（**必须含启动真实应用这一环**，因为单元测试通过 ≠ 功能可用）：\n"
            f"  1) 跑 `npm run typecheck` / `go vet ./...` / 单元测试 / `npm run build`；\n"
            f"  2) 禁止只依赖 mock。涉及数据库/网络时，先 `docker pull` 镜像，"
            f"再 `docker run -d` 启动真实服务并等待 ready；"
            f"容器名带 `dm-{feature.id}-`、ephemeral label、20000-29999 端口；\n"
            f"  3) 创建 Python venv/安装 DB 驱动，编写种子脚本写入真实测试数据"
            f"（`.orchestrator/test-data/{feature.id}/seed.py`）；必须验证记录数、"
            f"字段值和错误路径，不能只验证“接口返回成功”；\n"
            f"  4) 跑真实 roundtrip：真实源数据 → 应用/Connector → 真实目标，并核对数据；\n"
            f"  5) **应用实测是 pass 硬门禁**：先 `RunApp(action='start')` 启动 "
            f"Electron；再 `RunApp(action='status')`，必须确认 state=running；"
            f"然后用 `RunApp(action='eval', expression=...)` 在运行中的 renderer "
            f"读取页面状态，并实际点击/填写/等待 API 或 DOM 结果，走完本功能验收路径；"
            f"仅启动、仅看日志、仅写文本都不算；\n"
            f"  6) 清理自己创建的 Docker 容器并执行 `RunApp(action='stop')`；\n"
            f"  7) 更新 feature_list.json 的 status/evidence；\n"
            f"  8) 末尾必须输出结构化结论：\n"
            f"     RESULT: pass\n"
            f"     VERIFICATION:\n"
            f"       typecheck: pass\n"
            f"       unit_tests: pass\n"
            f"       build: pass\n"
            f"       docker: pass 或 n/a（原因）\n"
            f"       seed_data: pass 或 n/a（原因）\n"
            f"       roundtrip: pass 或 n/a（原因）\n"
            f"       electron: pass（编排器会核对真实 start/status/eval 工具轨迹）\n"
            f"       mock: none\n"
            f"     或 RESULT: blocked + FAILURE(step/command/exit_code/expected/actual/log/owner)。\n"
            f"\n"
            f"判定心法：单元测试 100% 通过 ≠ 可用；编译通过 ≠ 可用；"
            f"代码写完 ≠ 可用 —— 只有用户真的能在 UI 里走完流程才算 pass。"
            f"\n\n【编排器确定性预检已通过】\n"
            f"{_truncate_text(preflight_report, 6000, label='preflight')}\n"
            f"不要无意义重复相同命令；把剩余预算用于真实 Docker roundtrip "
            f"和 RunApp eval。"
        )
        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True, ""

        worktree_root = wt.path if wt and self.use_git_worktree else None
        result = await self.client._call_with_timeout(
            role="test_engineer", prompt=prompt,
            project_root=self.root,
            feature_id=feature.id,
            worktree_root=worktree_root,
        )
        text = result.text or ""
        require_real_env = (
            self.client.allow_docker
            and _feature_requires_real_docker(feature.id)
        )
        verified_pass, verification_feedback = self._parse_test_verification(
            text,
            require_real_env=require_real_env,
            require_app_start=True,
            run_app_started=result.run_app_started,
            run_app_status_checked=result.run_app_status_checked,
            run_app_ui_checked=result.run_app_ui_checked,
        )
        if verified_pass:
            log("   ✅ test_engineer 判定: pass（验证功能可用，独立写入 status=pass）")
            # 收敛状态：即使 evaluator 只返回文本、未成功写盘，也以它的
            # RESULT: pass 为准同步主工作区，保证提交与调度状态一致。
            features = self.state.load_features(feature.id)
            current = next((f for f in features if f.id == feature.id), None)
            if current is None:
                log(f"   ❌ feature {feature.id} 不在 feature_list.json，无法提交")
                return False, "test pass 但 feature 不存在，无法自动提交"
            if current.status != "pass":
                current.status = "pass"
                current.evidence = (
                    current.evidence
                    or f"test_engineer RESULT: pass；{text.strip()[:800]}"
                )
                _touch_feature(current)
                self.state.save_features(features, feature_id=feature.id)
                log("   📝 已根据 test_engineer 判定同步 status=pass")

            # 完整功能点只在这里提交一次；提交失败时不 merge，保留 worktree 重试。
            if wt and self.use_git_worktree:
                commit_hash = wt.commit(feature.name, evidence=text)
                if commit_hash is None:
                    log(
                        "   ❌ 自动提交失败：保留 worktree，不执行 merge；"
                        "本轮按未完成处理"
                    )
                    return False, "feature 自动提交失败，请检查 git 状态后重试"
                if wt.merge_back():
                    wt.remove()
                    self._active_worktree = None
                else:
                    log(
                        f"   ⚠️  merge 冲突：保留 worktree {wt.path}，"
                        f"feature 回到 in_progress，下一轮复用已提交代码"
                    )
                    features = self.state.load_features(feature.id)
                    current = next(
                        (f for f in features if f.id == feature.id), None
                    )
                    if current is not None:
                        current.status = "in_progress"
                        current.evidence = (
                            f"test pass + commit {commit_hash} 已完成，"
                            f"但 merge 失败，等待重试"
                        )
                        _touch_feature(current)
                        self.state.save_features(
                            features, feature_id=feature.id
                        )
                    return False, "feature commit 已完成，但 merge 失败，等待重试"
            return True, ""
        if "RESULT: blocked" in text:
            actionable, reason = self._blocked_feedback_is_actionable(text)
            if not actionable:
                log(f"   ❌ test_engineer blocked 反馈不可执行: {reason}")
                features = self.state.load_features(feature.id)
                current = next(
                    (f for f in features if f.id == feature.id), None
                )
                if current is not None:
                    current.status = "blocked"
                    current.evidence = (
                        f"test_engineer blocked 反馈不可执行: {reason}"
                    )
                    _touch_feature(current)
                    self.state.save_features(features, feature_id=feature.id)
                return False, (
                    f"test_engineer blocked 反馈不可执行: {reason}。"
                    "请下一轮 test_engineer 输出 FAILURE.step/command/"
                    "expected/actual/owner。"
                )

            log("   ❌ test_engineer 判定: blocked（功能不可用，回流到开发重试）")
            features = self.state.load_features(feature.id)
            current = next((f for f in features if f.id == feature.id), None)
            if current is not None:
                current.status = "blocked"
                current.evidence = text[:2000]
                _touch_feature(current)
                self.state.save_features(features, feature_id=feature.id)
            # blocked 时 worktree 保留，下一轮 develop 续用
            app_logs = self._app_log_tail_for_feedback(feature.id)
            return False, _truncate_text(
                text[:MAX_TEST_FEEDBACK_CHARS]
                + "\n\n【自动附带的应用启动/运行日志】\n"
                + app_logs,
                MAX_TEST_FEEDBACK_CHARS,
                label="test feedback",
            )
        if "RESULT: pass" in text:
            log(
                "   ❌ test_engineer 输出 RESULT: pass，"
                "但真实环境证据不完整；按 blocked 处理"
            )
        else:
            log("   ❌ test_engineer 未给出明确结构化结论；按 blocked 处理")
        features = self.state.load_features(feature.id)
        current = next((f for f in features if f.id == feature.id), None)
        if current is not None:
            current.status = "in_progress"
            current.evidence = (
                f"test_engineer pass 证据被编排器拒绝: "
                f"{verification_feedback}"
            )
            _touch_feature(current)
            self.state.save_features(features, feature_id=feature.id)
        app_logs = self._app_log_tail_for_feedback(feature.id)
        return False, (
            f"{verification_feedback}\n\n"
            f"【自动附带的应用启动/运行日志】\n{app_logs}"
        )

    async def _phase_deliver(self, feature: Feature) -> bool:
        """Phase 4: 产品经理反馈（不修改 feature_list.json，不门控）。

        架构师已合并到 golang_senior；架构验收由 test_engineer 在 test 阶段顺带覆盖。
        本阶段只产出验收意见写到 progress.md，不做 status 决策。
        pass/blocked 的判定权在 test_engineer（已合并 user 视角）；本阶段不阻塞主循环。
        """
        if not self.full_deliver:
            log(
                f"   ⏭️  跳过重复 deliver Agent：{feature.id} "
                f"已由 test_engineer 完成用户视角验收；"
                f"需要产品复核时使用 --full-deliver"
            )
            return True

        with log_scope(phase="deliver", feature=feature.id,
                     feature_name=feature.name):
            feature_card(
                feature,
                extra="阶段: deliver（product_manager 反馈，仅写入 progress.md；"
                      "架构 + 用户视角已在 test 阶段由 test_engineer 覆盖）",
            )
            log(f"📦 交付反馈阶段：{feature.id} :: {feature.name}")

        prompts = {
            "product_manager": (
                f"从产品经理视角验收 `{feature.id} :: {feature.name}`。\n"
                f"描述：{feature.description}\n\n"
                f"**【必须】通过 RunApp 启动真实应用**："
                f"`RunApp(action='start')` 启动 Electron，"
                f"`RunApp(action='status')` 查看日志，"
                f"从用户视角描述在 UI 中看到的内容、操作流程是否顺畅。\n"
                f"评估：用户故事覆盖度、验收标准匹配度、UI demo 与实现的一致性。\n"
                f"【仅反馈】把意见（含 UI 实际操作感受）写到 progress.md；不要改 status。\n"
                f"末尾用 `RESULT: accept` 或 `RESULT: reject` 表态。"
            ),
        }

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        wt = self._active_worktree
        worktree_root = wt.path if wt and self.use_git_worktree else None
        calls = [
            self.client._call_with_timeout(
                role=role, prompt=p,
                project_root=self.root,
                feature_id=feature.id,
                worktree_root=worktree_root,
            )
            for role, p in prompts.items()
        ]
        results = await self._run_agent_calls_serial(calls)

        any_ok = False
        accepted = 0
        for r in results:
            if r.ok:
                any_ok = True
                if "RESULT: accept" in r.text:
                    accepted += 1
        log(f"   📝 反馈收集 {accepted}/1 accept (仅写入 progress.md，不阻塞)")
        return any_ok

    async def _phase_developer_fix(
        self, feature: Feature, test_feedback: str, approach: int
    ) -> bool:
        """Developer 自检修复：当方案 X 的 3 次尝试都失败时，让 developer
        直接看自己上一轮写的代码，针对 test_engineer 反馈做精准修复。

        与 _phase_develop 的关键区别：
          * 不再"按 spec 重新实现"
          * 强制先 Read 工作目录里自己上一轮的代码
          * 只针对 test_engineer 反馈里的具体问题做 Edit/Write
          * 强调"最小修改"，避免改坏其它部分

        返回 True 表示修复后 test 通过；False 表示修复失败（应 fallback 到
        任务拆解 / 重设计）。
        """
        log(
            f"   🔧 方案 {approach} 已尝试 {MAX_DEV_TEST_ATTEMPTS} 次均失败，"
            f"先让对应 developer 自检修复（不重新实现）"
        )
        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        wt = self._active_worktree
        worktree_root = wt.path if wt and self.use_git_worktree else None

        feedback_truncated = (test_feedback or "")[:8000]

        # 注意：这里的 prompt_base 是「自检修复」专用，
        # 不要再用 _phase_develop 的「implement」prompt —— 那会让人从零开始
        fix_prompt_base = (
            f"你现在是【自检修复】模式。\n"
            f"\n"
            f"刚刚为 `{feature.id} :: {feature.name}` 写过一版代码（方案 {approach}），"
            f"已经尝试 {MAX_DEV_TEST_ATTEMPTS} 次都被 test_engineer 判定为『不可用』"
            f"（可能是单元测试失败、build 失败、typecheck 错误、或实际跑应用验证不通过）。\n"
            f"\n"
            f"**不要重新实现**。请严格走以下步骤：\n"
            f"  1) 先 Read 工作目录里自己上一轮写的代码 —— 不要凭印象改，"
            f"必须看实际文件内容；\n"
            f"  2) 仔细读 test_engineer 的反馈，列出每一处失败的具体问题；\n"
            f"  3) 用 Edit 精确改（old_string 必须从当前文件内容复制，不能从记忆里写）；\n"
            f"  4) 改完跑一遍 typecheck / 单测 / 关键 build 步骤，确认不再失败；\n"
            f"  5) **不要扩展范围** —— 只修反馈里的问题，不要顺手改其它部分；\n"
            f"  6) 如果发现自己代码确实没问题、是反馈不合理，"
            f"在 progress.md 追加 `## Develop Fix :: {feature.id}` 段写明理由并输出 `DONE`"
            f"（不要硬改）；\n"
            f"  7) 完成后用 `DONE` 表示。\n"
            f"\n"
            f"硬性约束：\n"
            f"  - 本次只修这一个 feature，不要顺手做其它功能；\n"
            f"  - feature_list.json 的 status 保持 `in_progress`（pass 由 test_engineer 写）；\n"
            f"  - 改完在 progress.md 追加 `## Develop Fix :: {feature.id}` 段写明改了什么；\n"
            f"  - 如果本轮反馈与你的视角无关（例如你是后端但反馈是 UI 问题），"
            f"请简要说明 N/A 并返回 `DONE`，不要硬改。\n"
            f"\n"
            f"上一轮 test_engineer 反馈（含应用启动/运行日志，节选前 8000 字符）：\n"
            f"---\n"
            f"{feedback_truncated}\n"
            f"---\n"
        )

        # 复用 _phase_develop 的三角色 + 角度
        all_angles = {
            "golang_senior": (
                "你的视角：数据转换引擎（Source/Transform/Sink + Record 中间格式）。\n"
                "如果本轮反馈与数据转换引擎/Go 代码无关（纯前端 / 纯 UI 问题），"
                "请说明 N/A 并返回 `DONE`，不要硬改前端代码。"
            ),
            "frontend_senior": (
                "你的视角：前端架构 + UI 实现（含视觉与交互细节）。\n"
                "如果本轮反馈与前端/UI 无关，请说明 N/A 并返回 `DONE`。"
            ),
        }
        target_roles = _extract_failure_owner(test_feedback)
        if not target_roles and wt is not None:
            target_roles = _roles_from_changed_paths(wt.changed_paths())
        if not target_roles:
            target_roles = _roles_for_feature(feature)
        angles = {
            role: angle for role, angle in all_angles.items()
            if role in target_roles
        }
        if not angles:
            log("   ⚠️  无法从反馈定位责任角色，跳过盲目自检修复")
            return False
        log(f"   🎯 自检角色: {', '.join(sorted(angles))}")

        calls = [
            self.client._call_with_timeout(
                role=role,
                prompt=fix_prompt_base
                + f"\n\n【本角色视角】\n{angle}",
                project_root=self.root,
                feature_id=feature.id,
                worktree_root=worktree_root,
            )
            for role, angle in angles.items()
        ]
        results = await self._run_agent_calls_serial(calls)

        any_ok = False
        for r in results:
            if r.ok:
                any_ok = True
                if "DONE" in r.text:
                    log(
                        f"   📝 {r.role} 自检修复完成"
                        f"（等待 test_engineer 重新验证）"
                    )

        if not any_ok:
            log("   ⚠️  自检修复调用全部失败，回退到 decompose/rethink")
            return False

        # 修复后再跑一次 test_engineer 验证
        # Round 4: 同样加 timeout 兜底
        try:
            await asyncio.wait_for(
                self._phase_audit_status(feature), timeout=60
            )
        except asyncio.TimeoutError:
            log(
                f"   ⏰  自检修复后 audit 超时 60s；"
                f"回退到 decompose/rethink"
            )
            return False
        except Exception as e:
            log(f"   ⚠️  自检修复后 audit 异常: {e}")
            return False

        if self._active_worktree is not None:
            self._write_phase_checkpoint(
                feature.id,
                "test",
                approach=approach,
                attempt=MAX_DEV_TEST_ATTEMPTS,
                worktree_path=self._active_worktree.path,
            )
        approach_passed, test_feedback = await self._phase_test(feature)
        self._clear_phase_checkpoint(feature.id)
        if approach_passed:
            log("   ✅ 自检修复后 test 通过，方案继续推进")
        else:
            log(
                f"   🔄 自检修复后 test 仍 blocked，"
                f"回退到 decompose/rethink"
            )
        return approach_passed

    async def _phase_decompose(self, feature: Feature, failed_approach: int) -> list[str]:
        """当一个方案失败 3 次后，先尝试把任务拆解成 2-4 个更小的子任务。

        子任务命名约定：`{feature.id}--step--1`、`{feature.id}--step--2` ...
        每个子任务独立可验证（typecheck + 单测），串行依赖或并行独立均可。
        原 feature 状态会被架构师改为 blocked（保留作为占位）；
        编排器会通过 _reap_decomposed 在所有子任务 pass 后自动把原 feature 标为 pass。

        返回本次新增的子任务 id 列表（按 feature_list.json 中真实存在的判定）。
        """
        log(
            f"🧩 第 {failed_approach} 套方案失败 "
            f"{MAX_DEV_TEST_ATTEMPTS} 次 → 触发任务拆解: {feature.id}"
        )

        if self.dry_run:
            return []

        arch_prompt = (
            f"Feature `{feature.id} :: {feature.name}` 第 {failed_approach} 套方案已失败 "
            f"{MAX_DEV_TEST_ATTEMPTS} 次。\n"
            f"历史失败反馈见 progress.md 中 `## Test Feedback :: {feature.id}` 的所有段。\n\n"
            f"请把此任务**拆解成 2-4 个更小的子任务**（每个独立可验证）：\n"
            f"  1) 每个子任务范围：\n"
            f"     - 足够小，能在一次 develop-test 中完成；\n"
            f"     - 可以独立 typecheck + 单测 + 必要时集成验证；\n"
            f"     - 完成一个子任务就能部分解决原 feature；\n"
            f"  2) 子任务结构（串行链或并行独立均可）：\n"
            f"     - 串行：后一个 dependencies 包含前一个的 id；\n"
            f"     - 并行：互不依赖；\n"
            f"  3) 子任务命名规范（必须遵守！）：\n"
            f"     - id: `{feature.id}--step--1`、`{feature.id}--step--2`、...；\n"
            f"     - ownerRole: golang / ui / frontend / desktop（按职责）；\n"
            f"     - 【禁止】让子任务依赖父 feature `{feature.id}`；"
            f"父 feature 只是完成态容器，避免 blocked parent 死锁；\n"
            f"  4) 把子任务作为新 feature 追加到 feature_list.json "
            f"（status=not_started，字段齐全：id, name, description, status, "
            f"ownerRole, dependencies, rupPhase, iteration）；\n"
            f"  5) 把**原 feature `{feature.id}`** 的 status 改为 `blocked`，"
            f"并在 progress.md 追加 `## Decompose :: {feature.id}` 段写明拆解理由；\n"
            f"  6) 末尾用 `RESULT: decomposed` 表态（必须 ≥ 2 个子任务才算成功）；\n"
            f"     如果认为此任务无法拆解，用 `RESULT: no_decomposition`。"
        )

        result = await self.client._call_with_timeout(
            role="golang_senior", prompt=arch_prompt,
            project_root=self.root,
            feature_id=feature.id,
        )

        # 通过 ID 前缀确认本次新增的子任务
        features = self.state.load_features()
        prefix = f"{feature.id}--step--"
        new_subtask_ids = [
            f.id for f in features
            if f.id.startswith(prefix) and f.status == "not_started"
        ]

        if "RESULT: decomposed" in (result.text or "") and len(new_subtask_ids) >= 2:
            normalized = False
            for child in features:
                if child.id not in new_subtask_ids:
                    continue
                if feature.id in child.dependencies:
                    child.dependencies = [
                        dep for dep in child.dependencies if dep != feature.id
                    ]
                    normalized = True
            if normalized:
                self.state.save_features(features)
                log(
                    "   🧹 已移除子任务对父 feature 的自依赖，"
                    "避免 blocked parent -> child 调度死锁"
                )
            log(
                f"   ✅ 已拆解为 {len(new_subtask_ids)} 个子任务: "
                f"{', '.join(new_subtask_ids)}"
            )
            return new_subtask_ids

        log(
            f"   ⚠️  拆解未产出 ≥2 个子任务（产出 {len(new_subtask_ids)} 个），"
            f"回退到 first-principles 重设计"
        )
        return []

    async def _phase_rethink(self, feature: Feature, failed_approach: int) -> None:
        """当一个方案失败 3 次后，由架构师 + 产品经理基于第一性原理重新设计。

        强调避免过度设计：用最简化原则解决问题，不堆抽象、不预留扩展。
        重设计后，下一轮 develop-test 会按方案 N+1 重试。
        """
        log(
            f"🔄 第 {failed_approach} 套方案失败 "
            f"{MAX_DEV_TEST_ATTEMPTS} 次 → 触发 first-principles 重新设计"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return

        # 架构师 → 产品经理 串行做 first-principles 设计
        prompts = {
            "golang_senior": (
                f"Feature `{feature.id} :: {feature.name}` 第 {failed_approach} 套方案已失败 "
                f"{MAX_DEV_TEST_ATTEMPTS} 次。\n"
                f"历史失败反馈见 progress.md 中 `## Test Feedback :: {feature.id}` 的所有段。\n\n"
                f"请用【第一性原理】重新设计：\n"
                f"  1) 回到最根本问题：用户真正要解决的痛点是什么？\n"
                f"  2) 哪些约束是真实必要的，哪些是\"自我设限\"或\"被现有代码绑架\"？\n"
                f"  3) **避免过度设计**：\n"
                f"     - 能用最少代码解决就别堆复杂度；\n"
                f"     - 不要提前抽象、不要引入未使用的可配置性；\n"
                f"     - 不要\"为未来留口子\"——只为本次需求做最干净的方案；\n"
                f"     - 如果现有代码结构是问题，就先重构那个最小相关部分，而不是绕过它；\n"
                f"  4) 把新方案写到 progress.md 的 "
                f"`## Rethink :: {feature.id} -- v{failed_approach + 1}` 段；\n"
                f"  5) 末尾用 `RESULT: redesigned` 表态。"
            ),
            "product_manager": (
                f"Feature `{feature.id} :: {feature.name}` 重新设计评审：\n"
                f"  1) 从用户故事和验收标准出发，确认 first-principles 方案：\n"
                f"     - 是否真正解决了用户的根本问题？\n"
                f"     - 是否过度设计了？（如果引入 YAGNI 复杂度就 reject）\n"
                f"  2) 把评审意见写到 progress.md 的 "
                f"`## Rethink Review :: {feature.id}` 段；\n"
                f"  3) 末尾用 `RESULT: accepted` 或 `RESULT: reject` 表态。"
            ),
        }

        calls = [
            self.client._call_with_timeout(
                role=role, prompt=p,
                project_root=self.root,
                feature_id=feature.id,
            )
            for role, p in prompts.items()
        ]
        results = await self._run_agent_calls_serial(calls)

        any_ok = False
        for r in results:
            if r.ok:
                any_ok = True
                verdict = "?"
                if "RESULT: redesigned" in r.text:
                    verdict = "redesigned"
                elif "RESULT: accepted" in r.text:
                    verdict = "accepted"
                elif "RESULT: reject" in r.text:
                    verdict = "reject"
                log(f"   📐 {r.role} 重设计: {verdict}")
        log(
            f"   ➡️  下轮 develop 进入方案 {failed_approach + 1}"
            f"（基于第一性原理的新设计）"
        )

    async def _phase_smoke_test(self) -> bool:
        """最终冒烟测试：所有 feature 都 pass 后，端到端验证 app 真的可用。

        test_engineer 是唯一判定者；本方法让 test_engineer 跑 `npm run check` +
        `npm run build` + `RunApp`，确保应用整体可启动、核心交互可用。
        """
        log("🔥 冒烟测试：验证应用整体可用（typecheck + 单测 + 构建 + 启动）")

        prompt = (
            "所有 feature 都已经过 test_engineer 逐个验证为「可用」。\n"
            "现在做**最终端到端冒烟测试**，验证整个应用作为整体也是可用的：\n"
            "  1) 运行 `npm run check` / `npm run test` 确保 typecheck + 单元测试全过；\n"
            "  2) 运行 `npm run build` 确保能编译出产物；\n"
            "  3) **【关键且由编排器硬门禁】启动真实应用并操作**："
            "`RunApp(action='start')` 启动 Electron 主进程 + 渲染窗口；"
            "`RunApp(action='status')` 必须确认 state=running；"
            "再用 `RunApp(action='eval', expression=...)` 在 renderer 中"
            "走一遍核心路径（创建连接、触发任务、查进度等），"
            "确认 UI 加载 + 核心交互真的可用；仅启动或仅看日志不能 pass；\n"
            "  4) 必要时截图，把结果（含命令输出关键片段、启动日志）写到 progress.md 的 "
            "`## Smoke Test -- final` 段；\n"
            "  5) 验证完执行 `RunApp(action='stop')`；\n"
            "  6) 输出结构化 RESULT: pass/blocked；pass 必须包含 VERIFICATION "
            "字段（typecheck/unit_tests/build/docker/seed_data/roundtrip/electron/mock）"
            "以及真实 Electron 运行日志证据。\n\n"
            "这是最后一道防线；任何构建/启动/交互失败必须如实报告，不要粉饰。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        result = await self.client._call_with_timeout(
            role="test_engineer", prompt=prompt,
            project_root=self.root,
        )
        text = result.text or ""
        verified_pass, feedback = self._parse_test_verification(
            text,
            require_real_env=self.client.allow_docker,
            require_app_start=True,
            run_app_started=result.run_app_started,
            run_app_status_checked=result.run_app_status_checked,
            run_app_ui_checked=result.run_app_ui_checked,
        )
        if verified_pass:
            log("   ✅ 冒烟测试 pass")
            return True
        log(f"   ❌ 冒烟测试 blocked：{feedback[:500]}")
        return False

    # ----- 主循环 --------------------------------------------------------

    def _print_delivery_summary(self, features: list[Feature]) -> None:
        """交付阶段：打印所有 pass 的 feature（按 ownerRole 分组）+ 写入 progress.md。

        在触发最终冒烟测试前调用，让用户在屏幕上清楚看到「这次跑完了哪些功能」。
        """
        passed = [f for f in features if f.status == "pass"]
        if not passed:
            log("   ⚠️  没有 pass 的 feature 可交付")
            return

        log("")
        log("=" * 70)
        log(f"📦 交付清单：本轮已完成 {len(passed)} 个功能")
        log("=" * 70)

        # 按 ownerRole 分组
        by_role: dict[str, list[Feature]] = {}
        for f in passed:
            role = f.owner_role or "未指派"
            by_role.setdefault(role, []).append(f)

        md_lines: list[str] = [
            "# 交付清单 -- 最终",
            "",
            f"共 {len(passed)} 个功能已通过 test_engineer 独立验证：",
            "",
        ]
        for role in sorted(by_role.keys()):
            fs = by_role[role]
            log(f"   📂 {role} ({len(fs)} 项)")
            md_lines.append(f"## {role} ({len(fs)} 项)")
            for f in fs:
                log(f"      ✅ {f.id} :: {f.name}")
                md_lines.append(f"- ✅ `{f.id}` :: {f.name}")
            md_lines.append("")
        log("=" * 70)
        log("")

        # 写入 progress.md 留痕
        self.state.append_progress(
            "Delivery Summary -- Final",
            "\n".join(md_lines),
            section_owner="_shared",
        )

    def _on_signal(self, sig: signal.Signals) -> None:
        """Ctrl+C / SIGTERM 回调：取消当前 task；第二次直接 os._exit。

        - 第一次 SIGINT：cancel 当前 task + set _stop，让 asyncio 协作退出
        - 第二次 SIGINT：task 没响应 cancel 时，强制 os._exit(130)
          （跳过所有清理；用于从 C-level 阻塞中逃出）

        Round 7 修复：之前 task.cancel() 在某些 C-level 阻塞（aiohttp / fcntl /
        subprocess.to_thread）下不响应，导致 Ctrl+C 看似有效但进程不死。
        """
        log(f"\n⌨️  收到 {sig.name}（第 {self._signal_count + 1} 次），正在停止...")
        self._signal_count += 1
        self._stop.set()
        task = self._current_task
        if task is not None and not task.done():
            task.cancel()
        if self._signal_count >= 2:
            # 第二次信号：直接强退（os._exit 跳过 cleanup 但保证必死）
            log("   💥 第二次信号，强制 os._exit(130) 立即退出")
            os._exit(130)

    async def run(self) -> int:
        banner("🚀 数据迁移工具 · 多 Agent 编排器启动")
        log(f"   项目根:        {self.root}")
        log(f"   待办文件:      {FEATURE_LIST_FILE.name}")
        log(f"   进度文件:      {PROGRESS_FILE.name}")
        log(
            f"   Agent 调度:    串行（semaphore={self.client.max_concurrent}，"
            f"默认 {MAX_CONCURRENT_AGENTS}）"
        )
        log(f"   API:           {self.client.api_url}")
        log(f"   模型:          {self.client.model}（key 取自 ANTHROPIC_API_KEY）")
        log(f"   max_tokens:    {self.client.max_output_tokens}")
        log(f"   Token 监控:    {self.client.per_call_token_limit} (input+output)")
        log(
            f"   Token 重置:    {TOKEN_RESET_INTERVAL_HOURS}h,"
            f" 软上限 {SOFT_TOKEN_LIMIT} (≈不限)；"
            f"rate {CALLS_PER_5H_SOFT_LIMIT}/5h；1M 上下文"
        )
        log(
            f"   Agent wall-time: {self.client.max_agent_wall_seconds}s"
            f" ({self.client.max_agent_wall_seconds // 60}m)；"
            f"超过则强制终止并标 failed"
        )
        log(
            f"   Phase-1 模式:  git-worktree={'ON' if self.use_git_worktree else 'OFF'},"
            f" file-lock={'ON' if self.use_file_lock else 'OFF'}"
        )
        log(
            f"   Harness:       preflight="
            f"{'ON' if self.use_preflight else 'OFF'}, "
            f"design={'full' if self.full_design else 'single-owner'}, "
            f"deliver={'full' if self.full_deliver else 'skip'}"
        )
        log(
            f"   上下文预算:    snapshot={MAX_CONTEXT_SNAPSHOT_CHARS}, "
            f"tool-result={MAX_TOOL_RESULT_CHARS} chars"
        )
        if self.client.allow_docker:
            docker_version = self._docker_server_version()
            if docker_version:
                log(f"   Docker:        启用（server {docker_version}）")
            else:
                log("   Docker:        已允许，但当前 Docker CLI/daemon 不可用")
        else:
            log("   Docker:        已禁用（--no-docker）")
        if self.dry_run:
            log("   🧪 DRY-RUN 模式（不实际调用模型 API）")
        log("   ⌨️  按 Ctrl+C 可随时停止（取消当前 Agent 调用 + 安全退出）")
        log("")

        # 启动看板：让用户一眼看到当前进度
        try:
            _initial_features = self.state.load_features()
            progress_dashboard(_initial_features, title="启动时进度")
            log("")
        except Exception as e:  # pragma: no cover
            log(f"   ⚠️  启动看板渲染失败: {e}")

        if self.use_git_worktree and not self.dry_run:
            dirty_files = self._dirty_main_worktree_files()
            if dirty_files:
                log(
                    f"   ⚠️  主工作区有 {len(dirty_files)} 个未提交文件；"
                    f"新 worktree 会同步与当前 feature 相关的代码和配置，"
                    f"其余无关改动不会带入。"
                )
                for path in dirty_files[:12]:
                    log(f"      · {path}")
                if len(dirty_files) > 12:
                    log(f"      · ... 另有 {len(dirty_files) - 12} 个")
                log(
                    "      若当前 feature 仍缺少已有实现，请先提交/暂存相关文件后重跑；"
                    "同步清单会在创建 worktree 时打印。"
                )

        # 信号处理：Ctrl+C 不光置位 _stop，还要取消正在 await 的 task，
        # 这样长 API 调用期间 Ctrl+C 也能立即生效（不必等下一次循环检查）
        self._current_task = asyncio.current_task()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._on_signal, sig)
            except (NotImplementedError, ValueError):  # pragma: no cover
                # Windows 主线程以外 / 某些环境不支持 add_signal_handler；
                # 退回到默认 KeyboardInterrupt，由 asyncio.run + main 兜底
                pass

        cycle = 0
        cycle_t0 = time.monotonic()
        while not self._stop.is_set():
            cycle += 1
            if self.max_cycles and cycle > self.max_cycles:
                log(f"⏹  达到 max_cycles={self.max_cycles}，正常退出。")
                break

            with log_scope(cycle=cycle):
                self.budget.maybe_reset()

                # Round 2: cycle-level pre-flight 检查 — 列出所有 oversized feature
                # 提前让用户看到（不必等到 next_pending 触发 _warn_if_oversized）
                _preflight = self.state.load_features()
                _oversized = [
                    f for f in _preflight
                    if (len(f.description) > 1500 or len(f.dependencies) > 5)
                    and f.status in ("not_started", "blocked", "in_progress")
                ]
                if _oversized:
                    log(
                        f"   📋 Pre-flight: 仍有 {len(_oversized)} 个 oversized feature "
                        f"（建议按 INVEST 拆细）:"
                    )
                    for f in _oversized:
                        reasons = []
                        if len(f.description) > 1500:
                            reasons.append(f"desc={len(f.description)}")
                        if len(f.dependencies) > 5:
                            reasons.append(f"deps={len(f.dependencies)}")
                        log(f"      · {f.id} ({', '.join(reasons)})")
            # 注：token 上限已设为极大值（≈ 不限），不阻塞。

            features = self.state.load_features()

            target = self.state.next_pending(features)

            # Cycle 开始的「本轮需求」卡片 —— 让日志第一眼就显示在做哪个需求
            cycle_start_banner(cycle, target, features)

            if target is None:
                log("✅ feature_list.json 中没有可执行的待办功能，编排器停止。")
                break

            # in_progress / blocked 表示功能已设计过，直接恢复开发；
            # 重复跑 design 只会消耗 token 并让 Agent 原地探索。
            if (
                target.status in ("in_progress", "blocked")
                or "--step--" in target.id
            ):
                reason = (
                    "已拆解子任务"
                    if "--step--" in target.id
                    else f"当前状态 [{target.status}]"
                )
                log(
                    f"   ⏩ {target.id} {reason}，"
                    f"跳过重复设计，直接进入开发/测试"
                )
            else:
                designed = await self._phase_design(features)
                if designed is None:
                    await asyncio.sleep(30)
                    continue
                target = designed

            # 开发-测试 重试循环（多方案）：
            #   每个方案最多尝试 MAX_DEV_TEST_ATTEMPTS 次；
            #   失败 3 次后触发 _phase_rethink 基于第一性原理重设计；
            #   最多 MAX_RETHINK 次重设计（共 MAX_RETHINK+1 个方案）。
            test_passed = False
            test_feedback = ""
            checkpoint = self._load_phase_checkpoint(target.id)
            if checkpoint and checkpoint.get("phase") == "test":
                restored = self._restore_test_worktree(target)
                if restored is None and self.use_git_worktree:
                    log(
                        f"   ⚠️ 发现测试 checkpoint 但 worktree 不存在，"
                        f"清除后重新开发: {target.id}"
                    )
                    self._clear_phase_checkpoint(target.id)
                else:
                    log(
                        f"   ⏯️  恢复 test checkpoint：{target.id} "
                        f"(方案 {checkpoint.get('approach')} "
                        f"尝试 {checkpoint.get('attempt')})，"
                        f"跳过 develop，直接续跑测试"
                    )
                    if not self.dry_run:
                        await self._phase_audit_status(target)
                    resumed_passed, resumed_feedback = await self._phase_test(target)
                    self._clear_phase_checkpoint(target.id)
                    if resumed_passed:
                        self._clear_retry_context(target.id)
                        await self._phase_deliver(target)
                        log(f"   ✅ 重启后续跑测试通过: {target.id}")
                        continue
                    test_feedback = resumed_feedback
                    failed_roles = _extract_failure_owner(test_feedback)
                    if not failed_roles:
                        failed_roles = _roles_for_feature(target)
                    self._write_retry_context(
                        target,
                        approach=int(checkpoint.get("approach") or 1),
                        attempt=int(checkpoint.get("attempt") or 1),
                        reason="重启后 test_engineer 仍 blocked",
                        completed_roles=sorted(
                            _roles_for_feature(target) - set(failed_roles)
                        ),
                        failed_roles=sorted(failed_roles),
                        evidence=test_feedback,
                        solution=(
                            "优先读取 runtime.log 和 test feedback，明确属于后端还是前端；"
                            "保留现有 worktree 实现，只修复失败链路。"
                        ),
                    )
                    log(
                        f"   🔄 重启后续跑测试 blocked，进入正常修复流程: "
                        f"{target.id}"
                    )

            for approach in range(1, MAX_RETHINK + 2):  # 方案 1..MAX_RETHINK+1
                log(f"   📐 进入方案 {approach}/{MAX_RETHINK + 1}")
                approach_passed = False
                for attempt in range(1, MAX_DEV_TEST_ATTEMPTS + 1):
                    # 把方案/尝试 + 当前需求 注入 log_scope，
                    # 让后续日志前缀自动带上（如 [轮3 开发 需求:mysql-export 方案1/3 尝试2/3]）
                    with log_scope(
                        approach=approach,
                        attempt=attempt,
                        approach_max=MAX_RETHINK + 1,
                        attempt_max=MAX_DEV_TEST_ATTEMPTS,
                        feature=target.id,
                        feature_name=target.name,
                    ):
                        log(
                            f"      🔁 方案 {approach} - 尝试 {attempt}/"
                            f"{MAX_DEV_TEST_ATTEMPTS}"
                        )
                        if not await self._phase_develop(target, test_feedback, approach):
                            log(f"      ⚠️  开发失败（方案 {approach} 第 {attempt} 次）")
                            await asyncio.sleep(5)
                            continue
                        # Phase-1: post-develop audit —— developer 不能自评
                        # Round 4: 加 timeout 兜底；如果 60s 还没出来说明卡死，
                        # 放弃本次 attempt 直接进入下一轮（不浪费一轮 test_engineer）
                        if not self.dry_run:
                            try:
                                await asyncio.wait_for(
                                    self._phase_audit_status(target), timeout=60
                                )
                            except asyncio.TimeoutError:
                                log(
                                    f"      ⏰  audit 超时 60s（疑似 flock 僵死）；"
                                    f"放弃本次 attempt，直接进入下一轮"
                                )
                                test_feedback = (
                                    "audit_status 60s 内未返回（疑似事件循环僵死）。"
                                    "不要重试同一方案，先排查是否有残留 lock。"
                                )
                                await asyncio.sleep(3)
                                continue
                            except Exception as e:
                                log(f"      ⚠️  audit 异常: {e}")
                                test_feedback = f"audit_status 异常: {e}"
                                await asyncio.sleep(3)
                                continue

                        if self._active_worktree is not None:
                            self._write_phase_checkpoint(
                                target.id,
                                "test",
                                approach=approach,
                                attempt=attempt,
                                worktree_path=self._active_worktree.path,
                            )
                        approach_passed, test_feedback = await self._phase_test(target)
                        self._clear_phase_checkpoint(target.id)
                        if approach_passed:
                            break
                        self._develop_completed_roles.pop(
                            (target.id, approach), None
                        )
                        failed_roles = _extract_failure_owner(test_feedback)
                        if not failed_roles:
                            failed_roles = _roles_for_feature(target)
                        completed_roles = sorted(
                            _roles_for_feature(target) - set(failed_roles)
                        )
                        self._write_retry_context(
                            target,
                            approach=approach,
                            attempt=attempt,
                            reason="test_engineer blocked",
                            completed_roles=completed_roles,
                            failed_roles=sorted(failed_roles),
                            evidence=test_feedback,
                            solution=(
                                "先阅读测试反馈和 app runtime.log，判断问题归属。"
                                "后端优先修复数据类型、连接、流式导出和错误契约；"
                                "前端优先修复 IPC、状态传递、字段映射和 UI 处理。"
                                "两端必须基于同一份现有 worktree 实现协作，"
                                "不要重新实现已完成部分。"
                            ),
                        )
                        log(
                            f"      🔄 test blocked（方案 {approach} "
                            f"第 {attempt}/{MAX_DEV_TEST_ATTEMPTS} 次）"
                        )
                        await asyncio.sleep(3)

                if approach_passed:
                    test_passed = True
                    break

                # 当前方案所有尝试都失败 —— Round 4:
                # 先让 developer 自检修复（看自己代码 + 针对反馈修），
                # 修复失败再 fallback 到任务拆解 / 重设计
                log(
                    f"   ⚠️  方案 {approach} 失败 {MAX_DEV_TEST_ATTEMPTS} 次，"
                    f"先让 developer 自检修复"
                )
                fix_passed = await self._phase_developer_fix(
                    target, test_feedback, approach
                )
                if fix_passed:
                    test_passed = True
                    break

                # 自检修复仍失败 —— 当前方案彻底放弃，
                # 走到下一个方案（任务拆解 / 重设计）
                if approach >= MAX_RETHINK + 1:
                    log(
                        f"   ❌ 已重设计 {MAX_RETHINK} 次（方案 1..{MAX_RETHINK + 1}）"
                        f"仍失败，feature {target.id} 放弃本轮 cycle"
                    )
                    # Phase-1: 放弃时清理 worktree + 分支
                    if self._active_worktree:
                        self._active_worktree.discard()
                        self._active_worktree = None
                    self._clear_phase_checkpoint(target.id)
                    break

                log(
                    f"   🧩 方案 {approach} 失败 {MAX_DEV_TEST_ATTEMPTS} 次 + "
                    f"developer 自检修复仍失败，先尝试任务拆解"
                )
                new_subtask_ids = await self._phase_decompose(target, approach)
                if new_subtask_ids:
                    # 拆解成功：原 feature 已是 blocked（占位），子任务会进 feature_list.json
                    # 后续 cycle 由 next_pending 拾起子任务逐个完成
                    log(
                        f"   ➡️  原 feature {target.id} 已被拆解占位；"
                        f"下个 cycle 开始逐个处理子任务"
                    )
                    break

                log(
                    f"   🔄 拆解未产出，回退到 first-principles 重设计"
                )
                await self._phase_rethink(target, approach)
                test_feedback = ""  # 重设计后清空反馈，从新方案开始

            if not test_passed:
                log(
                    f"   ❌ 测试持续失败，feature {target.id} 保持 in_progress"
                    f"待下次 cycle 重试"
                )
                await asyncio.sleep(5)
                continue

            self._clear_retry_context(target.id)
            # 交付阶段只产出反馈（写入 progress.md），不门控、不改 status
            await self._phase_deliver(target)
            # 收割：若有被拆解的 feature 的全部子任务都已 pass，把原 feature 标为 pass
            features_after = self.state.load_features()
            reaped = self.state.reap_decomposed(features_after)
            if reaped:
                self.state.save_features(features_after)
                for r in reaped:
                    log(f"   🎯 拆解后的 feature {r.id} 全部子任务 pass，标为 pass")

            # cycle 结束打小卡片 + 累计计时
            cycle_dt = time.monotonic() - cycle_t0
            cycle_t0 = time.monotonic()
            cycle_end_summary(cycle, target, test_passed, cycle_dt)
            try:
                progress_dashboard(
                    features_after,
                    title=f"Cycle {cycle} 后进度",
                    show_role_breakdown=False,
                )
            except Exception:  # pragma: no cover
                pass
            log("")
            log(
                f"✅ 已完成任务 {target.id} :: {target.name}；编排器停止。"
            )
            break

        log("\n🛑 编排器已停止。")
        return 0


# ============================================================================
# 日志
# ============================================================================

def _ensure_log_dir() -> None:
    SESSION_LOG_DIR.mkdir(parents=True, exist_ok=True)


_SESSION_LOG_LOCK = threading.Lock()
_SESSION_LOG_WRITES_SINCE_TRIM = 0


def _trim_session_log_locked() -> bool:
    """在已持有日志锁时，把 session.log 裁剪为最近 N 行。"""
    if not SESSION_LOG_FILE.exists():
        return False
    try:
        content = SESSION_LOG_FILE.read_text(
            encoding="utf-8", errors="replace"
        )
    except OSError:
        return False
    lines = content.splitlines(keepends=True)
    if len(lines) <= SESSION_LOG_MAX_LINES:
        return False
    tmp_path = SESSION_LOG_FILE.with_suffix(".log.tmp")
    try:
        tmp_path.write_text(
            "".join(lines[-SESSION_LOG_MAX_LINES:]),
            encoding="utf-8",
        )
        tmp_path.replace(SESSION_LOG_FILE)
    except OSError:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        return False
    return True


def _trim_session_log(force: bool = False) -> bool:
    """按写入次数节流裁剪 session.log；force=True 时立即检查。"""
    global _SESSION_LOG_WRITES_SINCE_TRIM
    with _SESSION_LOG_LOCK:
        if (
            not force
            and _SESSION_LOG_WRITES_SINCE_TRIM < SESSION_LOG_TRIM_EVERY_WRITES
        ):
            return False
        _SESSION_LOG_WRITES_SINCE_TRIM = 0
        return _trim_session_log_locked()


# ---------------------------------------------------------------------------
# 结构化日志上下文（module-level；asyncio 单线程，无需 thread-local）
# ---------------------------------------------------------------------------
# 用法：
#   with log_scope(cycle=3, phase="develop", feature="mysql-export",
#                  approach=1, approach_max=3, attempt=2, attempt_max=3):
#       log("开发中...")  # 自动前缀: [08:30:34] [轮3 开发 需求:mysql-export 方案1/3 尝试2/3] 开发中...
#
# 可嵌套；退出 with 时恢复父级 ctx。
_LOG_CTX: dict[str, Any] = {}


# 阶段名映射：英文 phase key -> 中文阶段标签（让日志直观反映「做这个需求的什么阶段」）
_PHASE_LABELS: dict[str, str] = {
    "design": "设计",
    "develop": "开发",
    "test": "测试",
    "deliver": "交付",
    "rethink": "重设计",
    "decompose": "拆解",
    "smoke-test": "冒烟测试",
    "audit": "审计",
}


@contextlib.contextmanager
def log_scope(**kv: Any) -> Any:
    """临时设置日志上下文（cycle / phase / feature / approach / attempt）。

    支持的 key：
      - cycle: 当前轮次（整数）
      - phase: 当前阶段（字符串；自动映射为中文标签）
      - feature: 当前需求 id（字符串）
      - feature_name: 当前需求 name（字符串，可选；显示更直观）
      - approach / approach_max: 第几个方案 / 总方案数（如 1/3）
      - attempt / attempt_max: 第几次尝试 / 总尝试数（如 2/3）
      - role: 当前 Agent 角色（可选）
    """
    old = dict(_LOG_CTX)
    _LOG_CTX.update(kv)
    try:
        yield
    finally:
        _LOG_CTX.clear()
        _LOG_CTX.update(old)


def _format_log_prefix() -> str:
    """生成结构化日志前缀；让用户一眼看清：第几轮 / 哪个需求 / 哪个阶段 / 第几方案 / 第几次尝试。

    输出示例:
      [轮3 开发 需求:mysql-export 方案1/3 尝试2/3]
      [轮3 交付 需求:mysql-export]
    """
    if not _LOG_CTX:
        return ""
    parts: list[str] = []
    if "cycle" in _LOG_CTX:
        parts.append(f"轮{_LOG_CTX['cycle']}")
    if "phase" in _LOG_CTX:
        phase_key = str(_LOG_CTX["phase"])
        phase_label = _PHASE_LABELS.get(phase_key, phase_key)
        parts.append(phase_label)
    if "feature" in _LOG_CTX:
        feat_id = str(_LOG_CTX["feature"])
        feat_name = _LOG_CTX.get("feature_name")
        if feat_name:
            # 同时给 id 和 name；name 一般更直观
            parts.append(f"需求:{feat_id} {feat_name}")
        else:
            parts.append(f"需求:{feat_id}")
    if "approach" in _LOG_CTX:
        approach = _LOG_CTX["approach"]
        max_app = _LOG_CTX.get("approach_max", MAX_RETHINK + 1)
        parts.append(f"方案{approach}/{max_app}")
    if "attempt" in _LOG_CTX:
        attempt = _LOG_CTX["attempt"]
        max_att = _LOG_CTX.get("attempt_max", MAX_DEV_TEST_ATTEMPTS)
        parts.append(f"尝试{attempt}/{max_att}")
    if "role" in _LOG_CTX:
        parts.append(f"[{_LOG_CTX['role']}]")
    return "[" + " ".join(parts) + "] "


def log(msg: str) -> None:
    global _SESSION_LOG_WRITES_SINCE_TRIM
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = _format_log_prefix()
    line = f"[{ts}] {prefix}{msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # Windows cp1252 控制台无法编码 emoji；降级为 ASCII 安全字符
        safe = line.encode("ascii", errors="replace").decode("ascii")
        print(safe, flush=True)
    try:
        _ensure_log_dir()
        with _SESSION_LOG_LOCK:
            with SESSION_LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            _SESSION_LOG_WRITES_SINCE_TRIM += 1
            if (
                _SESSION_LOG_WRITES_SINCE_TRIM
                >= SESSION_LOG_TRIM_EVERY_WRITES
            ):
                _trim_session_log_locked()
                _SESSION_LOG_WRITES_SINCE_TRIM = 0
    except Exception:  # pragma: no cover
        pass


# ---------------------------------------------------------------------------
# 可视化辅助（banner / dashboard / feature_card / phase_timer）
# ---------------------------------------------------------------------------
def banner(title: str, char: str = "═", width: int = 70) -> None:
    """打一行阶段横幅（空行 + 双线 + 标题 + 双线）。"""
    bar = char * width
    log("")
    log(bar)
    log(f"  {title}")
    log(bar)


def cycle_start_banner(cycle: int, target: "Feature | None",
                       features: list["Feature"]) -> None:
    """Cycle 开始时打印「本轮需求」卡片 + 项目总进度。

    让用户/运维在日志第一眼就看清：
      * 这是第几轮
      * 本轮要交付哪个需求（id + 中文 name）
      * 该需求当前状态、负责角色、依赖
      * 项目整体通过率
    """
    log("")
    log("═" * 70)
    log(f"  📋 Cycle {cycle} 开始")
    log("─" * 70)
    if target is not None:
        status_desc = {
            "not_started": "（待开发）",
            "in_progress": "（重试中）",
            "blocked": "（卡住待重设计）",
            "pass": "（已完成）",
        }.get(target.status, "")
        log(f"  🎯 本轮需求:  {target.id} :: {target.name}")
        log(f"  📌 当前状态:  [{target.status}] {status_desc}")
        log(f"  👤 负责角色:  {target.owner_role or '待指派'}")
        if target.dependencies:
            log(f"  🔗 依赖:      {', '.join(target.dependencies)}")
    else:
        log("  🎯 本轮目标:  feature_list.json 中暂无待办")

    # 项目总进度条
    total = len(features)
    if total:
        by_status: dict[str, int] = {}
        for f in features:
            by_status[f.status] = by_status.get(f.status, 0) + 1
        passed = by_status.get("pass", 0)
        pct = passed / total * 100
        bar_len = 30
        fill = int(round(bar_len * passed / total))
        bar = "█" * fill + "░" * (bar_len - fill)
        log(
            f"  📊 项目进度:  {passed}/{total} pass ({pct:.0f}%)  [{bar}]"
        )
        log(
            f"  📈 明细:      "
            f"pass={by_status.get('pass', 0)}  "
            f"in_progress={by_status.get('in_progress', 0)}  "
            f"blocked={by_status.get('blocked', 0)}  "
            f"not_started={by_status.get('not_started', 0)}"
        )
    log("═" * 70)
    log("")


def cycle_end_summary(cycle: int, target: "Feature | None",
                      passed: bool, duration_sec: float) -> None:
    """Cycle 结束时打总结横幅，明确「本轮结果」。"""
    m, s = divmod(int(duration_sec), 60)
    verdict = "✅ 可用（test_engineer 验证通过）" if passed else "❌ 不可用（test_engineer 判定 blocked）"
    log("")
    log("─" * 70)
    log(f"  🏁 Cycle {cycle} 结束  ({m}m{s}s)  {verdict}")
    if target is not None:
        log(f"     本轮处理: {target.id} :: {target.name}")
    log("─" * 70)
    log("")


def progress_dashboard(features, *, title: str = "项目进度",
                       show_role_breakdown: bool = True) -> None:
    """按 status / ownerRole 分组的 ASCII 进度表 + 进度条。"""
    total = len(features)
    by_status: dict[str, int] = {}
    by_role: dict[str, dict[str, int]] = {}
    for f in features:
        by_status[f.status] = by_status.get(f.status, 0) + 1
        role = f.owner_role or "未指派"
        slot = by_role.setdefault(role, {})
        slot[f.status] = slot.get(f.status, 0) + 1

    passed = by_status.get("pass", 0)
    pct = (passed / total * 100) if total else 0.0
    bar_len = 30
    fill = int(round(bar_len * passed / total)) if total else 0
    bar = "█" * fill + "░" * (bar_len - fill)
    log("")
    log(f"📊 {title}  {passed}/{total} pass ({pct:.0f}%)  [{bar}]")
    log(
        f"   pass={by_status.get('pass', 0)}  "
        f"in_progress={by_status.get('in_progress', 0)}  "
        f"blocked={by_status.get('blocked', 0)}  "
        f"not_started={by_status.get('not_started', 0)}"
    )
    if show_role_breakdown:
        for role in sorted(by_role):
            slot = by_role[role]
            rp = slot.get("pass", 0)
            rt = sum(slot.values())
            log(f"   · {role}: {rp}/{rt} pass")


def feature_card(feature, *, approach=None, attempt=None, extra="") -> None:
    """进入开发/测试/交付前打一张需求卡片。

    让用户一眼看清当前在处理哪个需求、其状态、负责人与依赖。
    """
    status_emoji = {
        "pass": "✅", "in_progress": "🟡", "blocked": "🔴", "not_started": "⚪",
    }.get(feature.status, "❓")
    owner = feature.owner_role or "未指派"
    deps = ", ".join(feature.dependencies) if feature.dependencies else "（无）"
    lines: list[str] = [
        f"┌─ 需求  {status_emoji} [{feature.status}] {feature.id}",
        f"│  name:    {feature.name}",
        f"│  owner:   {owner}",
        f"│  deps:    {deps}",
    ]
    if feature.description:
        desc = feature.description.replace(chr(10), " ")[:200]
        suffix = "..." if len(feature.description) > 200 else ""
        lines.append(f"│  desc:    {desc}{suffix}")
    if approach is not None:
        lines.append(f"│  方案:     {approach}/{MAX_RETHINK + 1}")
    if attempt is not None:
        lines.append(f"│  尝试:     {attempt}/{MAX_DEV_TEST_ATTEMPTS}")
    if extra:
        lines.append(f"│  {extra}")
    lines.append("└─")
    for ln in lines:
        log(ln)


@contextlib.contextmanager
def phase_timer(label: str, **log_kv: Any) -> Any:
    """阶段计时器：进入打 banner，退出打 elapsed。配合 log_scope 使用。"""
    t0 = time.monotonic()
    banner(label, char="─", width=60)
    try:
        with log_scope(**log_kv):
            yield
    finally:
        dt = time.monotonic() - t0
        m, s = divmod(int(dt), 60)
        log(f"⏱  {label} 完成 (耗时 {m}m{s}s)")


# ============================================================================
# CLI
# ============================================================================

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    # 默认值优先从环境变量读取（无需每次都传 CLI 参数），CLI 参数仍可覆盖
    default_api_url = os.environ.get(
        "ANTHROPIC_BASE_URL", "https://api.minimax.cn/anthropic"
    )
    default_model = os.environ.get("ANTHROPIC_MODEL", "MiniMax-M3")
    default_max_output_tokens = int(
        os.environ.get("ANTHROPIC_MAX_TOKENS", str(MAX_OUTPUT_TOKENS))
    )
    default_token_warn_threshold = int(
        os.environ.get("ORCH_TOKEN_WARN", str(PER_CALL_TOKEN_LIMIT))
    )
    default_max_concurrent = int(
        os.environ.get("ORCH_MAX_CONCURRENT", str(MAX_CONCURRENT_AGENTS))
    )
    default_max_agent_minutes = int(
        os.environ.get("ORCH_MAX_AGENT_MINUTES", str(30))
    )

    p = argparse.ArgumentParser(
        description="数据迁移工具 多 Agent 编排器",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--max-concurrent", type=int, default=default_max_concurrent,
        help="semaphore 配置；当前编排按角色串行执行（默认 1；"
             "可用 ORCH_MAX_CONCURRENT 覆盖）",
    )
    p.add_argument(
        "--api-url", default=default_api_url,
        help="Anthropic Messages API base URL（默认 minimax.cn；"
             "可用 ANTHROPIC_BASE_URL 覆盖）",
    )
    p.add_argument(
        "--max-output-tokens", type=int, default=default_max_output_tokens,
        help=f"API max_tokens 参数（默认 {MAX_OUTPUT_TOKENS}，受模型限制；"
             f"可用 ANTHROPIC_MAX_TOKENS 覆盖）",
    )
    p.add_argument(
        "--token-warn-threshold", type=int, default=default_token_warn_threshold,
        help=f"input+output token 监控阈值（默认 {PER_CALL_TOKEN_LIMIT}；"
             f"可用 ORCH_TOKEN_WARN 覆盖）",
    )
    p.add_argument(
        "--model", default=default_model,
        help="模型名称（默认 MiniMax-M3；可用 ANTHROPIC_MODEL 覆盖）",
    )
    p.add_argument(
        "--max-cycles", type=int, default=0,
        help="最多执行多少个 cycle（0=不限；成功完成一个功能后立即停止）",
    )
    p.add_argument(
        "--max-agent-minutes", type=int, default=default_max_agent_minutes,
        help="单个 Agent 调用的硬性 wall-time 上限（分钟，默认 30）；"
             "防止 Agent 在 tool-use 循环里卡死超过该时长。"
             "可由环境变量 ORCH_MAX_AGENT_MINUTES 覆盖。",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="只打印计划，不实际调用模型 API",
    )
    p.add_argument(
        "--no-docker", action="store_true",
        help="禁止 Agent 使用 Docker 创建测试环境（默认允许）",
    )
    p.add_argument(
        "--full-design", action="store_true",
        help="恢复产品经理 + 架构师双 Agent 设计；默认由 owner 角色一次完成，"
             "减少重复评审和上下文传递。",
    )
    p.add_argument(
        "--full-deliver", action="store_true",
        help="test pass 后再运行产品经理 deliver Agent；默认跳过，"
             "因为 test_engineer 已包含用户视角验收。",
    )
    p.add_argument(
        "--no-preflight", action="store_true",
        help="关闭编排器确定性预检；默认在 test Agent 前运行 diff/typecheck/test/build，"
             "机械失败不再消耗昂贵模型调用。",
    )
    # Phase-1: 旁路开关（默认 off → 启用 worktree + per-feature 文件锁）
    p.add_argument(
        "--no-git-worktree", action="store_true",
        help="禁用 per-feature git worktree；CI / dry-run 旁路。"
             "默认开启 worktree：每个 feature 在 .orchestrator/worktrees/<id> 下开发，"
             "test pass 后自动 merge --no-ff 到 master。",
    )
    p.add_argument(
        "--no-file-lock", action="store_true",
        help="禁用 per-feature 文件锁；CI / dry-run 旁路。"
             "默认开启：StateStore.acquire(feature_id) 用 flock / msvcrt 串行化并发 phase。",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    _ensure_log_dir()
    _trim_session_log(force=True)
    # Windows 控制台默认 cp1252 不认 emoji；强制 UTF-8 让日志含中文/emoji 不崩
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            pass
    # 不再硬截断并发数：CLI 用户自负责任（2250 calls/5h 配额内）
    if args.max_concurrent < 1:
        log(f"⚠️  --max-concurrent={args.max_concurrent} 无效，设为 1。")
        args.max_concurrent = 1

    orch = Orchestrator(args)
    try:
        return asyncio.run(orch.run())
    except KeyboardInterrupt:
        log("\n⌨️  收到 Ctrl+C，正在停止...")
        return 130
    except asyncio.CancelledError:
        # Ctrl+C 触发的 task.cancel() 路径：asyncio.run 会把 CancelledError 抛到这里
        log("\n⌨️  编排器被取消（Ctrl+C），已退出。")
        return 130


if __name__ == "__main__":
    sys.exit(main())
