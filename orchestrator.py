#!/usr/bin/env python3
"""
数据迁移工具 -- 多 Agent 编排脚本
====================================

按 goals.md 目标，自动调用 7 个角色 Agent 协作开发：

  产品经理 ─┐
  架构师   ─┼─> 设计与迭代协议
           │
  Golang 资深工程师 ─┐
  UI 工程师         ─┼─> 单功能开发（每次只做一个）
  前端资深工程师     ─┘
           │
  测试工程师 ─> 验收
           │
  用户/架构师/产品经理 ─> 交付验收

约束：
  * 同时运行 Agent 数 ≤ 5
  * Token 每 5 小时重置一次；不足时阻塞等待
  * 单一 Agent 每次只接受一个功能点
  * 自动循环直到目标达成或手动停止

协作方式：
  所有 Agent 通过 规则地图（AGENTS.md / feature_list.json / progress.md）同步状态，
  启动时一次性注入给所有 Agent，无需在进程间传递额外协议。

依赖：
  仅使用 Python 3.10+ 标准库。Agent 调用通过 subprocess 调用 `claude` CLI。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import anthropic

# ============================================================================
# 常量与配置
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parent
GOALS_FILE = PROJECT_ROOT / "goals.md"
FEATURE_LIST_FILE = PROJECT_ROOT / "feature_list.json"
PROGRESS_FILE = PROJECT_ROOT / "progress.md"
SESSION_LOG_DIR = PROJECT_ROOT / ".orchestrator"
SESSION_LOG_FILE = SESSION_LOG_DIR / "session.log"

# 约束
MAX_CONCURRENT_AGENTS = 30              # 同时运行 Agent 数上限（2250 calls/5h 配额，可拉到 30+ 并发）
TOKEN_RESET_INTERVAL_HOURS = 5          # Token 重置周期
SOFT_TOKEN_LIMIT = 50_000_000           # 5h 周期内 token 上限 ≈ 不限（仅做统计）；1M 上下文支持
CALLS_PER_5H_SOFT_LIMIT = 2_250         # Claude 调用 rate 监控（2250/5h；不强制阻塞）
PER_CALL_TOKEN_LIMIT = 616_600          # 单次调用 input + output token 软监控阈值（≈ 600K；超限仅告警）
MAX_OUTPUT_TOKENS = 524_288             # 单次 API 调用的 max_tokens 参数上限（受 minimaxi/MiniMax-M3 模型限制）
AGENT_TIMEOUT_SECONDS = 1800            # 单个 Agent 调用最长 30 分钟

# 开发-测试 重试策略
MAX_DEV_TEST_ATTEMPTS = 3               # 同一方案最多尝试 3 次
MAX_RETHINK = 2                         # 最多重设计 2 次（即 1+2=3 个方案）

# 角色定义（按 AGENTS.md 规则地图中的角色映射）
ROLES: dict[str, dict[str, str]] = {
    "product_manager": {
        "label": "产品经理",
        "kind": "planner",
        "system_prompt": (
            "你是「数据迁移工具」项目的【产品经理】。\n"
            "职责：把 goals.md 中的目标拆解为可执行功能点；定义每个功能的用户故事、"
            "验收标准与优先级；协调产品节奏。\n"
            "约束：\n"
            " 1. 只允许选择一个当前最高优先级、尚未开发的功能作为下一交付单元；\n"
            " 2. 必须把决策结果写入 feature_list.json 中对应功能的 status、notes 字段；\n"
            " 3. 与架构师通过 progress.md 同步你的产品决策；\n"
            " 4. 在交付/验收阶段，必须**启动真实应用**来验证用户体验：\n"
            "    `npm run dev` 启动 Electron，从用户视角描述在 UI 中看到的内容、"
            "    操作流程是否顺畅、错误信息是否可读，再给出 accept/reject。\n"
            "工作流：读取 goals.md / feature_list.json / progress.md，给出下一交付单元。"
        ),
    },
    "architect": {
        "label": "架构师",
        "kind": "planner",
        "system_prompt": (
            "你是「数据迁移工具」项目的【架构师】。\n"
            "职责：基于目标设计技术架构、模块边界、接口契约和迭代协议；识别关键技术风险。\n"
            "约束：\n"
            " 1. 不得直接修改业务代码，只能在 docs/architecture.md 或 progress.md 中"
            "  记录架构决策；\n"
            " 2. 必须为每个新功能指派 ownerRole（golang / ui / frontend / desktop）；\n"
            " 3. 与产品经理对齐迭代协议后再交给开发 Agent；\n"
            " 4. 在交付/验收阶段，必须**启动真实应用**来验证架构假设：\n"
            "    `npm run dev` 启动 Electron，确认模块边界、IPC 契约、技术栈组合"
            "    在运行的应用中真的成立，再给出 accept/reject。\n"
            "技术栈：React + TypeScript + Electron + Golang + SQLite。"
        ),
    },
    "golang_senior": {
        "label": "Golang 资深工程师",
        "kind": "developer",
        "system_prompt": (
            "你是「数据迁移工具」项目的【Golang 资深工程师】。\n"
            "职责：实现 Golang 引擎（位于 golang/esmigrator）；支持 ES scroll/search_after "
            "流式导出、bulk 分批导入、并发 worker、断点续传、进度上报与取消。\n"
            "硬性约束：\n"
            " 1. 每次会话【只接受一个功能】作为交付单元；不要尝试并行开发多个；\n"
            " 2. 实现必须经过 `go vet ./...` 与 `go test ./...`；\n"
            " 3. 自测：除了 Go 测试，**还必须启动真实 Electron 应用验证集成层**——\n"
            "    `npm run build` 后跑 `npm run dev`，确认 Go 引擎通过 IPC 被正确调用；\n"
            " 4. 把 feature_list.json 中对应功能的 status 设为 `in_progress`；\n"
            "    【禁止】设为 `pass` —— pass 由 test_engineer 独立验证后写入；\n"
            " 5. 进度与决策写入 progress.md 的 What's Next / Decisions Made 段。\n"
            " 6. 【不要自我评估】完成后用一行 `DONE` 表示代码写完即可；"
            "pass/blocked 由 test_engineer 独立运行 typecheck + 单测 + 集成 + 构建后给出。"
        ),
    },
    "ui_engineer": {
        "label": "UI 工程师",
        "kind": "developer",
        "system_prompt": (
            "你是「数据迁移工具」项目的【UI 工程师】。\n"
            "职责：负责桌面端 UI 视觉、组件库、交互细节、可访问性，与前端工程师协作。\n"
            "硬性约束：\n"
            " 1. 每次会话【只接受一个 UI 功能】；\n"
            " 2. 必须在 src/renderer 内完成；\n"
            " 3. 自测必须启动真实应用：`npm run dev` 启动 Electron，"
            "    在运行窗口中目视确认你改的 UI 实际生效（截图为证更好），然后关闭应用；\n"
            " 4. 把 feature_list.json 中对应功能的 status 设为 `in_progress`；\n"
            "    【禁止】设为 `pass` —— pass 由 test_engineer 独立验证后写入；\n"
            " 5. 修改完成后更新 progress.md；\n"
            " 6. 【不要自我评估】完成后用一行 `DONE` 表示代码写完即可。"
        ),
    },
    "frontend_senior": {
        "label": "前端应用资深开发工程师",
        "kind": "developer",
        "system_prompt": (
            "你是「数据迁移工具」项目的【前端资深开发工程师】。\n"
            "职责：负责 React + TypeScript 前端架构、状态管理、IPC 接入、与 UI 工程师协作。\n"
            "硬性约束：\n"
            " 1. 每次会话【只接受一个前端功能】；\n"
            " 2. 必须保持 `npm run typecheck` 与 `npm test` 通过；\n"
            " 3. 跨进程边界（preload ↔ renderer ↔ main）使用既有安全 IPC 模式；\n"
            " 4. 自测必须启动真实应用：`npm run dev` 启动 Electron，"
            "    在运行窗口中确认 IPC 通道、React 状态、UI 联动都实际工作（必要时截图），"
            "    然后关闭应用；\n"
            " 5. 把 feature_list.json 中对应功能的 status 设为 `in_progress`；\n"
            "    【禁止】设为 `pass` —— pass 由 test_engineer 独立验证后写入；\n"
            " 6. 修改完成后更新 progress.md；\n"
            " 7. 【不要自我评估】完成后用一行 `DONE` 表示代码写完即可。"
        ),
    },
    "test_engineer": {
        "label": "测试工程师",
        "kind": "evaluator",
        "system_prompt": (
            "你是「数据迁移工具」项目的【测试工程师】。\n"
            "职责：按迭代协议与退出标准对开发 Agent 的交付做独立验证；"
            "**你是唯一的 pass/blocked 判定者**，开发者禁止自评。\n"
            "硬性约束：\n"
            " 1. 每次会话【只验证一个功能】；\n"
            " 2. 验证流程必须包含**启动真实应用**这一环（不只是单元测试）：\n"
            "    - 跑 `npm run build` 确保编译通过；\n"
            "    - 跑 `npm run dev` 启动 Electron 主进程 + 渲染窗口；\n"
            "    - 在运行的窗口中实际验证 feature（如触发按钮、看到 UI 变化、调用 IPC）；\n"
            "    - 必要时截图（写到 progress.md）；\n"
            "    - 验证完成后关闭 Electron 进程；\n"
            " 3. 验证后必须更新 feature_list.json 中对应功能的 status 与 evidence 字段：\n"
            "    - 通过：status=pass，evidence 写明跑了哪些命令、应用启动后看到什么；\n"
            "    - 失败：status 保持 `in_progress`（不要设为 blocked），\n"
            "      并在 progress.md 追加 `## Test Feedback :: {feature_id}` 段，\n"
            "      写明失败原因（含应用启动日志/截图）、相关命令输出与修复建议；\n"
            " 4. 【不要让 developer 自评】pass/blocked 的判定权只在你手里；\n"
            " 5. 完成后用一行 `RESULT: pass` 或 `RESULT: blocked` 表态。"
        ),
    },
    "user": {
        "label": "用户",
        "kind": "user",
        "system_prompt": (
            "你是「数据迁移工具」项目的【最终用户/验收人】。\n"
            "职责：从使用视角验收交付；关注真实场景下 PostgreSQL/ES 导出导入流程是否可用、"
            "界面是否清晰、错误信息是否可读。\n"
            "约束：\n"
            " 1. 不得修改代码，只产出验收意见；\n"
            " 2. **必须启动真实应用**：`npm run dev` 启动 Electron，"
            "    在运行的窗口中实际操作（连接数据库、跑导入导出、切换 tab 等），"
            "    再给出 accept/reject；\n"
            " 3. 把验收意见写到 progress.md 的 Notes for Next Session；\n"
            " 4. 完成后用一行 `RESULT: accept` 或 `RESULT: reject` 表态。"
        ),
    },
}

# 状态机阶段顺序
PHASES: list[str] = [
    "design",       # 产品 + 架构
    "develop",      # 3 个开发工程师
    "test",         # 测试工程师
    "deliver",      # 用户 + 架构师 + 产品经理
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
            "testedAt": datetime.now().isoformat(timespec="seconds"),
        }
        if self.notes:
            out["notes"] = self.notes
        return out


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


# ============================================================================
# 状态管理
# ============================================================================

class StateStore:
    """读取 / 写入 规则地图 下的状态文件。"""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.goals_path = root / "goals.md"
        self.feature_path = root / "feature_list.json"
        self.progress_path = root / "progress.md"

    def load_goals(self) -> str:
        if not self.goals_path.exists():
            return ""
        return self.goals_path.read_text(encoding="utf-8")

    def load_features(self) -> list[Feature]:
        if not self.feature_path.exists():
            return []
        raw = json.loads(self.feature_path.read_text(encoding="utf-8"))
        return [Feature.from_dict(f) for f in raw.get("features", [])]

    def save_features(self, features: list[Feature]) -> None:
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

    def append_progress(self, section: str, body: str) -> None:
        """在 progress.md 中追加一段（如果是首次写入则创建标题）。"""
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        block = f"\n## {section} -- {ts}\n\n{body.strip()}\n"
        if not self.progress_path.exists():
            self.progress_path.write_text(
                "# Session Progress Log -- 数据迁移工具\n\n(由 orchestrator 自动生成)\n",
                encoding="utf-8",
            )
        with self.progress_path.open("a", encoding="utf-8") as f:
            f.write(block)

    def _read_project_description(self) -> str:
        goals = self.load_goals()
        for line in goals.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line
        return "数据迁移工具"

    # 便捷查询
    def next_pending(self, features: list[Feature]) -> Feature | None:
        """挑出下一个待处理的功能：
        1) 优先恢复 status=in_progress 或 blocked 的功能（继续上次未完成工作）；
           - blocked 表示上一轮 build/typecheck 失败，必须回流到 develop 重试；
        2) 否则挑 status=not_started 且依赖已 pass 的功能（启动新工作）。

        返回值用于编排器主循环，避免被 blocked 卡死、避免空转并误判 goals.md 已 complete。
        """
        passed_ids = {f.id for f in features if f.status == "pass"}
        # 1) 优先恢复进行中的功能
        for f in features:
            if f.status == "in_progress":
                return f
        # 2) 恢复被阻塞的功能（跳过已被拆解成子任务的，避免重复劳动）
        for f in features:
            if f.status != "blocked":
                continue
            prefix = f.id + "--step--"
            has_subtasks = any(s.id.startswith(prefix) for s in features)
            if has_subtasks:
                continue  # 已拆解，子任务会处理
            return f
        # 3) 启动依赖已 pass 的新功能
        for f in features:
            if f.status != "not_started":
                continue
            if all(dep in passed_ids for dep in f.dependencies):
                return f
        return None

    def is_goal_complete(self, features: list[Feature]) -> bool:
        """目标完成：所有功能都已 pass。"""
        if not features:
            return False
        return all(f.status == "pass" for f in features)

    def reap_decomposed(self, features: list[Feature]) -> list[Feature]:
        """扫描所有 blocked feature，找到被拆解过的（存在 `{id}--step--N` 子任务）；
        若其全部子任务都 pass，则把原 feature 标为 pass 并写明 evidence。
        返回被改动的 feature 列表（用于 main loop 日志）。
        """
        updated: list[Feature] = []
        for f in features:
            if f.status != "blocked":
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
            updated.append(f)
        return updated


# ============================================================================
# Token 预算
# ============================================================================

class TokenBudget:
    """估算当前周期内的 token 用量；用满或接近上限时阻塞。"""

    def __init__(self, soft_limit: int = SOFT_TOKEN_LIMIT,
                 reset_hours: int = TOKEN_RESET_INTERVAL_HOURS) -> None:
        self.soft_limit = soft_limit
        self.reset_interval = timedelta(hours=reset_hours)
        self.used = 0
        self.cycle_started = datetime.now()
        self.next_reset = self.cycle_started + self.reset_interval

    def add(self, tokens: int) -> None:
        self.used += max(0, tokens)

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

    def wait_until_reset(self) -> float:
        """仅记录统计；token 上限不再阻塞（实际配额 ≈ 不限量）。"""
        # 保留方法签名以便未来切换为严格模式；当前 no-op
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

    MAX_TOOL_ITERATIONS = 80  # 单次调用最大 tool 轮次

    def __init__(
        self,
        api_url: str = "https://api.minimax.cn/anthropic",
        api_key_env: str = "ANTHROPIC_API_KEY",
        model: str = "MiniMax-M3",
        max_concurrent: int = MAX_CONCURRENT_AGENTS,
        max_output_tokens: int = MAX_OUTPUT_TOKENS,
        per_call_token_limit: int = PER_CALL_TOKEN_LIMIT,
    ) -> None:
        self.api_url = api_url
        self.api_key_env = api_key_env
        self.model = model
        self.max_concurrent = max_concurrent
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.max_output_tokens = max_output_tokens
        self.per_call_token_limit = per_call_token_limit
        self._project_root: Path | None = None

    async def call(self, call: AgentCall, project_root: Path) -> AgentResult:
        self._project_root = project_root
        role_meta = ROLES[call.role]
        system_prompt = role_meta["system_prompt"]

        ctx = self._build_context_snapshot(project_root)
        user_prompt = (
            f"{ctx}\n\n---\n\n【本次任务】\n\n{call.prompt}\n\n"
            f"---\n\n【本角色硬性约束】\n{system_prompt}\n"
        )

        api_key = os.environ.get(self.api_key_env, "")
        if not api_key:
            log(
                f"   ❌ 缺少环境变量 {self.api_key_env}（API key）。"
                f"请 `export {self.api_key_env}=<key>` 后再启动。"
            )
            return AgentResult(
                role=call.role, ok=False,
                text=f"missing env var {self.api_key_env}",
                feature_id=call.feature_id,
            )

        client = anthropic.Anthropic(
            api_key=api_key,
            base_url=self.api_url,
        )

        async with self.semaphore:
            log(
                f"🤖 启动 Agent: {role_meta['label']} "
                f"(model={self.model}, API={self.api_url}, "
                f"并发 {self.max_concurrent} 上限)"
            )
            start = time.time()
            messages: list[dict[str, Any]] = [
                {"role": "user", "content": user_prompt}
            ]
            total_in = 0
            total_out = 0

            try:
                response = client.messages.create(
                    model=self.model,
                    max_tokens=self.max_output_tokens,
                    system=system_prompt,
                    tools=TOOL_DEFS,
                    messages=messages,
                    timeout=AGENT_TIMEOUT_SECONDS,
                )
                total_in += response.usage.input_tokens
                total_out += response.usage.output_tokens
            except anthropic.APIError as e:
                log(f"   ❌ API 错误: {e}")
                return AgentResult(
                    role=call.role, ok=False, text=f"API error: {e}",
                    duration_sec=time.time() - start,
                    feature_id=call.feature_id,
                )

            # Multi-turn tool-use loop
            iteration = 0
            while (
                response.stop_reason == "tool_use"
                and iteration < self.MAX_TOOL_ITERATIONS
            ):
                iteration += 1
                tool_results: list[dict[str, Any]] = []
                for block in response.content:
                    if getattr(block, "type", None) != "tool_use":
                        continue
                    tool_name = block.name
                    tool_input = block.input or {}
                    try:
                        executor = self._TOOL_EXECUTORS[tool_name]
                        result = executor(self, tool_input)
                        content = result if isinstance(result, str) else str(result)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": content,
                        })
                    except Exception as e:
                        log(
                            f"   ⚠️  tool {tool_name} 执行失败: {e}"
                        )
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"Error: {e}",
                            "is_error": True,
                        })

                # 把 assistant content + tool results 一起送回去
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})

                try:
                    response = client.messages.create(
                        model=self.model,
                        max_tokens=self.max_output_tokens,
                        system=system_prompt,
                        tools=TOOL_DEFS,
                        messages=messages,
                        timeout=AGENT_TIMEOUT_SECONDS,
                    )
                    total_in += response.usage.input_tokens
                    total_out += response.usage.output_tokens
                except anthropic.APIError as e:
                    log(f"   ❌ API 错误: {e}")
                    return AgentResult(
                        role=call.role, ok=False, text=f"API error: {e}",
                        duration_sec=time.time() - start,
                        feature_id=call.feature_id,
                    )

            # 收尾：抽取最终文本
            text = "".join(
                block.text for block in response.content
                if getattr(block, "type", None) == "text"
            )
            duration = time.time() - start

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
            )

    # ---------------- 工具执行器 ----------------

    def _resolve_path(self, file_path: str) -> Path:
        """解析路径并校验在 project root 内（防越权）。"""
        assert self._project_root is not None
        p = Path(file_path)
        if not p.is_absolute():
            p = self._project_root / p
        p = p.resolve()
        root = self._project_root.resolve()
        try:
            p.relative_to(root)
        except ValueError:
            raise ValueError(f"path outside project root: {file_path}")
        return p

    def _tool_Read(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])
        return path.read_text(encoding="utf-8")

    def _tool_Write(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(input["content"], encoding="utf-8")
        return f"Wrote {len(input['content'])} bytes to {input['file_path']}"

    def _tool_Edit(self, input: dict) -> str:
        path = self._resolve_path(input["file_path"])
        content = path.read_text(encoding="utf-8")
        old = input["old_string"]
        new = input["new_string"]
        if old not in content:
            return f"Error: old_string not found in {input['file_path']}"
        occurrences = content.count(old)
        if occurrences > 1:
            return (
                f"Error: old_string matches {occurrences} times in "
                f"{input['file_path']}; please make it unique"
            )
        path.write_text(content.replace(old, new, 1), encoding="utf-8")
        return f"Edited {input['file_path']}"

    def _tool_Bash(self, input: dict) -> str:
        cmd = input["command"]
        timeout_ms = int(input.get("timeout") or 120000)
        timeout_s = timeout_ms / 1000
        assert self._project_root is not None
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                cwd=str(self._project_root),
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
            out = f"exit_code: {result.returncode}\n"
            if result.stdout:
                out += f"stdout:\n{result.stdout}\n"
            if result.stderr:
                out += f"stderr:\n{result.stderr}\n"
            return out
        except subprocess.TimeoutExpired:
            return f"Error: command timed out after {timeout_s}s"

    def _tool_Glob(self, input: dict) -> str:
        assert self._project_root is not None
        pattern = input["pattern"]
        root = self._project_root.resolve()
        matches = sorted(root.glob(pattern))
        return "\n".join(
            str(m.relative_to(root)) for m in matches[:200]
        ) or "(no matches)"

    def _tool_Grep(self, input: dict) -> str:
        assert self._project_root is not None
        pattern = input["pattern"]
        path = input.get("path", ".")
        try:
            regex = re.compile(pattern)
        except re.error as e:
            return f"Error: bad regex: {e}"

        target = Path(path)
        if not target.is_absolute():
            target = self._project_root / target
        if not target.exists():
            return f"Error: {path} does not exist"

        files = (
            [target] if target.is_file()
            else [f for f in target.rglob("*") if f.is_file()]
        )

        root = self._project_root
        matches: list[str] = []
        for f in files:
            try:
                lines = f.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for i, line in enumerate(lines, 1):
                if regex.search(line):
                    rel = f.relative_to(root)
                    matches.append(f"{rel}:{i}: {line}")
                    if len(matches) >= 200:
                        return "\n".join(matches)
        return "\n".join(matches) or "(no matches)"

    _TOOL_EXECUTORS = {
        "Read": _tool_Read,
        "Write": _tool_Write,
        "Edit": _tool_Edit,
        "Bash": _tool_Bash,
        "Glob": _tool_Glob,
        "Grep": _tool_Grep,
    }

    def _build_context_snapshot(self, root: Path) -> str:
        """注入规则地图的关键快照：目标、当前状态、进度（注入完整内容，让 Agent 用足 1M 上下文）。"""
        goals_path = root / "goals.md"
        features_path = root / "feature_list.json"
        progress_path = root / "progress.md"

        goals = goals_path.read_text(encoding="utf-8") if goals_path.exists() else "(无 goals.md)"
        progress_tail = (
            progress_path.read_text(encoding="utf-8")[-2000:]
            if progress_path.exists()
            else "(无 progress.md)"
        )

        feature_summary_lines = ["(无 feature_list.json)"]
        feature_full_text = "(无 feature_list.json)"
        if features_path.exists():
            try:
                feature_full_text = features_path.read_text(encoding="utf-8")
                raw = json.loads(feature_full_text)
                feats = raw.get("features", [])
                lines = []
                for f in feats:
                    lines.append(
                        f"- [{f.get('status','?')}] {f.get('id')} :: {f.get('name')} "
                        f":: owner={f.get('ownerRole','?')} :: deps={f.get('dependencies',[])}"
                    )
                feature_summary_lines = lines
            except Exception as e:  # pragma: no cover
                feature_summary_lines = [f"(解析失败: {e})"]
                feature_full_text = feature_summary_lines[0]

        return (
            "【规则地图 / 上下文快照】\n\n"
            "### goals.md (项目目标)\n"
            "```\n" + goals.strip() + "\n```\n\n"
            "### feature_list.json (摘要)\n"
            "\n".join(feature_summary_lines) + "\n\n"
            "### feature_list.json (完整 JSON)\n"
            "```json\n" + feature_full_text.strip() + "\n```\n\n"
            "### progress.md (最近 2KB)\n"
            "```\n" + progress_tail + "\n```\n"
        )


# ============================================================================
# 编排主循环
# ============================================================================

class Orchestrator:
    """状态机驱动的工作流编排器。"""

    def __init__(self, args: argparse.Namespace) -> None:
        self.root = PROJECT_ROOT
        self.state = StateStore(self.root)
        self.client = AgentClient(
            api_url=args.api_url,
            api_key_env=args.api_key_env,
            model=args.model,
            max_concurrent=args.max_concurrent,
            max_output_tokens=args.max_output_tokens,
            per_call_token_limit=args.token_warn_threshold,
        )
        self.budget = TokenBudget()
        self.dry_run = args.dry_run
        self.max_cycles = args.max_cycles
        self._stop = asyncio.Event()

    # ----- 工作流阶段 ----------------------------------------------------

    async def _phase_design(self, features: list[Feature]) -> Feature | None:
        """Phase 1: 产品经理 + 架构师共同决定下一个交付单元。"""
        next_feature = self.state.next_pending(features)
        if not next_feature:
            log("🎯 没有待开发的功能，跳过设计阶段。")
            return None

        log(f"📐 设计阶段：下一交付单元 = [{next_feature.status}] "
            f"{next_feature.id} :: {next_feature.name}")

        prompt = (
            f"当前 next pending 功能：\n"
            f"  - id: {next_feature.id}\n"
            f"  - name: {next_feature.name}\n"
            f"  - description: {next_feature.description}\n"
            f"  - dependencies: {next_feature.dependencies}\n"
            f"  - owner_role (建议): {next_feature.owner_role or '待指派'}\n\n"
            f"请：\n"
            f"  1) 由【产品经理】用 3-5 句定义用户故事 + 验收标准；\n"
            f"  2) 由【架构师】用 3-5 句定义技术方案、模块边界、接口契约；\n"
            f"  3) 在 progress.md 追加 `## Design -- {next_feature.id}` 段落记录协议；\n"
            f"  4) 不要修改 feature_list.json，留给开发/测试 Agent 推进。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return next_feature

        # 并行调用：产品经理 + 架构师（2 个 Agent 同时跑）
        arch_prompt = (
            f"请为功能 `{next_feature.id}` 做技术方案设计：\n"
            f"  - 名称: {next_feature.name}\n"
            f"  - 描述: {next_feature.description}\n"
            f"  - 依赖: {next_feature.dependencies}\n\n"
            f"请在 progress.md 追加 `## Arch :: {next_feature.id}` 段，"
            f"末尾用 `RESULT: pass` 表态。"
        )
        results = await asyncio.gather(
            self.client.call(
                AgentCall(role="product_manager", prompt=prompt,
                          feature_id=next_feature.id),
                self.root,
            ),
            self.client.call(
                AgentCall(role="architect", prompt=arch_prompt,
                          feature_id=next_feature.id),
                self.root,
            ),
            return_exceptions=False,
        )

        any_ok = False
        for r in results:
            if r.ok:
                self.budget.add(
                    r.usage.get("input_tokens", 0)
                    + r.usage.get("output_tokens", 0)
                )
                any_ok = True
            else:
                log(f"   ⚠️  Agent {r.role} 失败：{r.text[:200]}")

        if any_ok:
            best_text = "\n---\n".join(
                r.text[:1500] for r in results if r.ok
            )
            self.state.append_progress(
                f"Design :: {next_feature.id}",
                f"产品经理 + 架构师并行设计：\n\n{best_text}",
            )
        return next_feature if any_ok else None

    async def _phase_plan_from_goals(
        self, features: list[Feature]
    ) -> Feature | None:
        """自举规划阶段：当没有待开发功能时，让产品经理+架构师重新读 goals.md。

        找出尚未在 feature_list.json 中覆盖的目标点，并把它们作为新 feature 追加
        （status=not_started，dependencies 指向已 pass 的 feature）。
        返回下一轮可用的 pending feature；若判定目标已全部覆盖则返回 None。
        """
        log(
            "🔍 触发自举规划：当前没有待开发功能，"
            "让产品经理+架构师重新读 goals.md 找出未覆盖目标点..."
        )

        prompt_lines = [
            "feature_list.json 当前没有 status=not_started 的功能。",
            "",
            "你的任务：",
            "  1) 重新阅读【规则地图 / 上下文快照】中的 goals.md；",
            "  2) 找出尚未被 feature_list.json 现有功能覆盖的目标点；",
            "  3) 把缺失的目标点作为新 feature 追加到 feature_list.json 中：",
            '     - status: "not_started"',
            "     - ownerRole: 恰当的（golang / ui / frontend / desktop）",
            "     - dependencies: 当前 status=pass 的 feature ids（按依赖关系）",
            "     - description: 用户故事 + 验收标准",
            "  4) 在 progress.md 追加 `## Plan :: new-iteration` 段说明规划理由；",
            "  5) 末尾用一行 `RESULT: planned` 或 `RESULT: complete` 表态：",
            "     - planned: 已追加 ≥1 个新 feature；",
            "     - complete: 你认为 goals.md 已全部被现有 feature 覆盖，",
            "                 不需要再加新 feature。",
            "",
            "注意：不要修改已存在的 feature；只能 append。",
        ]
        prompt = "\n".join(prompt_lines)

        if self.dry_run:
            log(
                "   [dry-run] 规划阶段不会真调 Claude CLI。"
                "生产模式下这里会调用 product_manager + architect 两位 Agent"
                "去读 goals.md 并追加缺失目标点。"
            )
            return None

        # 先让产品经理规划，再让架构师复核（串行）
        pm_result = await self.client.call(
            AgentCall(role="product_manager", prompt=prompt),
            self.root,
        )
        if pm_result.ok:
            self.budget.add(
                pm_result.usage.get("input_tokens", 0)
                + pm_result.usage.get("output_tokens", 0)
            )

        arch_prompt_lines = [
            "产品经理已根据 goals.md 完成一轮规划，请在 feature_list.json 中确认：",
            "  - 新追加的 feature 字段是否完整（id/name/description/status/ownerRole/dependencies）；",
            "  - dependencies 是否指向已 pass 的 feature；",
            "  - ownerRole 是否合理。",
            "末尾用一行 `RESULT: planned` 或 `RESULT: complete` 表态。",
        ]
        arch_result = await self.client.call(
            AgentCall(
                role="architect",
                prompt="\n".join(arch_prompt_lines),
            ),
            self.root,
        )
        if arch_result.ok:
            self.budget.add(
                arch_result.usage.get("input_tokens", 0)
                + arch_result.usage.get("output_tokens", 0)
            )

        combined_text = (
            (pm_result.text if pm_result.ok else "")
            + "\n---\n"
            + (arch_result.text if arch_result.ok else "")
        )

        if "RESULT: planned" in combined_text:
            features = self.state.load_features()
            nxt = self.state.next_pending(features)
            if nxt is not None:
                log(f"   ✅ 自举规划产出新 feature: {nxt.id} :: {nxt.name}")
                return nxt
            log(
                "   ⚠️  自举规划标记 planned 但 feature_list.json 无 not_started 项，"
                "可能 Agent 未写入。"
            )
            return None

        if "RESULT: complete" in combined_text:
            log("   ✅ 产品经理+架构师判定 goals.md 已被现有 feature 全部覆盖。")
            return None

        log("   ⚠️  自举规划阶段未明确表态，跳过。")
        return None

    async def _phase_develop(
        self, feature: Feature, test_feedback: str = "", approach: int = 1
    ) -> bool:
        """Phase 2: 单个开发 Agent 负责一个功能（一次只做一个，不做自评）。

        test_feedback: 来自上一轮 test_engineer 的反馈（仅在重试时传入）。
        approach: 当前是第几套方案（1=初次；>1=已重设计）。
        """
        log(f"🛠️  开发阶段 (方案 {approach})：{feature.id} :: {feature.name}")

        feedback_section = ""
        if test_feedback:
            feedback_section = (
                f"\n【上一轮 test_engineer 反馈（你必须针对性修复）】\n"
                f"{test_feedback[:1500]}\n"
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
            f"现在开发【单一功能】（方案 {approach}）：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n"
            f"  - 依赖: {feature.dependencies}\n"
            f"{feedback_section}{approach_hint}\n"
            f"硬性要求：\n"
            f"  1) 本次只交付这一个功能，不要顺手做其它功能；\n"
            f"  2) 把 feature_list.json 中 `{feature.id}` 的 status 设为 `in_progress`；\n"
            f"    【禁止】设为 `pass` —— pass 由 test_engineer 独立验证后写入；\n"
            f"  3) 自测必须**启动真实应用**：\n"
            f"     - `npm run typecheck` / `go vet ./...` / 单测先过；\n"
            f"     - `npm run build` 通过；\n"
            f"     - `npm run dev` 启动 Electron，在运行的窗口中目视/操作确认你改的代码"
            f"实际生效（IPC 通了、UI 渲染对了、Go 引擎被调起来了等）；\n"
            f"     - 验证完关闭 Electron 进程；\n"
            f"  4) 在 progress.md 追加 `## Develop :: {feature.id}` 段记录实现要点"
            f"（含自测时应用启动看到什么）；\n"
            f"  5) 【重要】不要自我评估 pass/blocked！完成后用一行 `DONE` 表示代码写完即可；\n"
            f"    pass/blocked 由 test_engineer 独立验证后给出。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        # 并行调用 3 个开发角色（同一 feature 不同视角）：
        #   - golang_senior：后端/引擎（golang/esmigrator）
        #   - ui_engineer：UI 视觉与交互
        #   - frontend_senior：前端架构、状态、IPC
        # 每个角色都限定只动自己的文件范围，互不冲突；只写代码 + DONE，不做自评
        prompt_with_angle = lambda angle: (
            prompt_base
            + f"\n\n【本角色职责角度】\n{angle}\n"
        )

        angles = {
            "golang_senior": (
                "你的视角：后端 / Go 引擎（golang/esmigrator）。\n"
                "负责：并发 worker、流式 IO、bulk 导入、scroll/search_after、断点续传。"
                "如果本功能不涉及 Go 代码，请简要说明 N/A 并返回 `DONE`。"
            ),
            "ui_engineer": (
                "你的视角：UI 视觉与交互细节（src/renderer）。\n"
                "负责：组件、动效、可访问性、文案。如果不涉及 UI，请返回 `DONE`。"
            ),
            "frontend_senior": (
                "你的视角：前端架构、状态管理、IPC 接入（src/renderer + src/main + src/preload）。\n"
                "负责：React 组件、状态、preload 桥接、安全 IPC 模式。"
                "如果不涉及前端，请返回 `DONE`。"
            ),
        }

        calls = [
            self.client.call(
                AgentCall(role=role, prompt=prompt_with_angle(angle),
                          feature_id=feature.id),
                self.root,
            )
            for role, angle in angles.items()
        ]
        results = await asyncio.gather(*calls, return_exceptions=False)

        any_ok = False
        for r in results:
            if r.ok:
                any_ok = True
                self.budget.add(
                    r.usage.get("input_tokens", 0)
                    + r.usage.get("output_tokens", 0)
                )
                # 注意：开发者禁止自评；不解析 RESULT: pass/in_progress
                if "DONE" in r.text:
                    log(f"   📝 {r.role} 完成代码（等待 test_engineer 验证）")
        return any_ok

    async def _phase_test(self, feature: Feature) -> tuple[bool, str]:
        """Phase 3: 测试工程师是唯一的判定者。

        返回 (passed, feedback)：
          - passed=True：test_engineer 给出 `RESULT: pass`，feature 标 pass，可进入交付。
          - passed=False：test_engineer 给出 `RESULT: blocked` 或未明确表态，
            feedback 用于回流到 develop 重试。
        """
        log(f"🧪 测试阶段：{feature.id} :: {feature.name}")
        prompt = (
            f"请独立验证【单一功能】：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n\n"
            f"步骤（必须含启动真实应用这一环）：\n"
            f"  1) 运行 `npm run typecheck` / `go vet ./...` 等基础检查；\n"
            f"  2) 跑单元/集成测试；\n"
            f"  3) **【关键】启动真实应用**：`npm run build` 后 `npm run dev` "
            f"启动 Electron，在运行的窗口中实际操作验证 feature "
            f"（触发按钮、调用 IPC、看到 UI 变化、查进度等），必要时截图写到 progress.md；\n"
            f"  4) 验证完关闭 Electron 进程；\n"
            f"  5) 【唯一判定权】在 feature_list.json 中更新 `{feature.id}` 的 status 与 evidence：\n"
            f"     - 通过：status=pass；evidence 写明跑了哪些命令、应用启动后实际看到什么；\n"
            f"     - 失败：status 保持 `in_progress`，并在 progress.md 追加 "
            f"`## Test Feedback :: {feature.id}` 段（失败原因 + 应用启动日志 + 修复建议）；\n"
            f"  6) 末尾用一行 `RESULT: pass` 或 `RESULT: blocked` 表态。"
        )
        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True, ""

        result = await self.client.call(
            AgentCall(role="test_engineer", prompt=prompt, feature_id=feature.id),
            self.root,
        )
        self.budget.add(
            result.usage.get("input_tokens", 0)
            + result.usage.get("output_tokens", 0)
        )
        text = result.text or ""
        if "RESULT: pass" in text:
            log("   ✅ test_engineer 判定: pass（独立验证后写入 status=pass）")
            return True, ""
        if "RESULT: blocked" in text:
            log("   ❌ test_engineer 判定: blocked（回流到开发重试）")
            return False, text[:3000]
        log("   ⚠️  test_engineer 未明确表态，按 blocked 处理")
        return False, text[:3000] or "test_engineer 无输出"

    async def _phase_deliver(self, feature: Feature) -> bool:
        """Phase 4: 用户 + 架构师 + 产品经理联合反馈（不修改 feature_list.json，不门控）。

        该阶段只产出验收意见写到 progress.md，不做 status 决策。
        pass/blocked 的判定权在 test_engineer；本阶段不阻塞主循环。
        """
        log(f"📦 交付反馈阶段：{feature.id} :: {feature.name}")

        prompts = {
            "user": (
                f"从最终用户视角验收 `{feature.id} :: {feature.name}`。\n"
                f"描述：{feature.description}\n\n"
                f"**【必须】启动真实应用**：`npm run dev` 启动 Electron，"
                f"在运行的窗口中实际操作（连接数据库、跑导入导出、切换 tab 等），"
                f"评估真实场景可用性、界面清晰度、错误信息可读性。\n"
                f"【仅反馈】把验收意见（含应用启动后看到什么）写到 progress.md 的 "
                f"`## Deliver :: {feature.id}` 段；不要修改 feature_list.json 的 status。\n"
                f"末尾用 `RESULT: accept` 或 `RESULT: reject` 表态。"
            ),
            "architect": (
                f"从架构师视角验收 `{feature.id} :: {feature.name}`。\n"
                f"描述：{feature.description}\n\n"
                f"**【必须】启动真实应用**：`npm run dev` 启动 Electron，"
                f"在运行的应用中验证模块边界、IPC 契约、技术栈组合是否真的成立。\n"
                f"【仅反馈】把意见（含应用启动后的架构观察）写到 progress.md；不要改 status。\n"
                f"末尾用 `RESULT: accept` 或 `RESULT: reject` 表态。"
            ),
            "product_manager": (
                f"从产品经理视角验收 `{feature.id} :: {feature.name}`。\n"
                f"描述：{feature.description}\n\n"
                f"**【必须】启动真实应用**：`npm run dev` 启动 Electron，"
                f"从用户视角描述在 UI 中看到的内容、操作流程是否顺畅。\n"
                f"评估：用户故事覆盖度、验收标准匹配度。\n"
                f"【仅反馈】把意见（含 UI 实际操作感受）写到 progress.md；不要改 status。\n"
                f"末尾用 `RESULT: accept` 或 `RESULT: reject` 表态。"
            ),
        }

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        calls = [
            self.client.call(
                AgentCall(role=role, prompt=p, feature_id=feature.id),
                self.root,
            )
            for role, p in prompts.items()
        ]
        results = await asyncio.gather(*calls, return_exceptions=False)

        any_ok = False
        accepted = 0
        for r in results:
            if r.ok:
                any_ok = True
                self.budget.add(
                    r.usage.get("input_tokens", 0)
                    + r.usage.get("output_tokens", 0)
                )
                if "RESULT: accept" in r.text:
                    accepted += 1
        log(f"   📝 反馈收集 {accepted}/3 accept (仅写入 progress.md，不阻塞)")
        return any_ok

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
            f"  4) 把子任务作为新 feature 追加到 feature_list.json "
            f"（status=not_started，字段齐全：id, name, description, status, "
            f"ownerRole, dependencies, rupPhase, iteration）；\n"
            f"  5) 把**原 feature `{feature.id}`** 的 status 改为 `blocked`，"
            f"并在 progress.md 追加 `## Decompose :: {feature.id}` 段写明拆解理由；\n"
            f"  6) 末尾用 `RESULT: decomposed` 表态（必须 ≥ 2 个子任务才算成功）；\n"
            f"     如果认为此任务无法拆解，用 `RESULT: no_decomposition`。"
        )

        result = await self.client.call(
            AgentCall(role="architect", prompt=arch_prompt, feature_id=feature.id),
            self.root,
        )
        if result.ok:
            self.budget.add(
                result.usage.get("input_tokens", 0)
                + result.usage.get("output_tokens", 0)
            )

        # 通过 ID 前缀确认本次新增的子任务
        features = self.state.load_features()
        prefix = f"{feature.id}--step--"
        new_subtask_ids = [
            f.id for f in features
            if f.id.startswith(prefix) and f.status == "not_started"
        ]

        if "RESULT: decomposed" in (result.text or "") and len(new_subtask_ids) >= 2:
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

        # 架构师 + 产品经理 并行做 first-principles 设计
        prompts = {
            "architect": (
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
            self.client.call(
                AgentCall(role=role, prompt=p, feature_id=feature.id),
                self.root,
            )
            for role, p in prompts.items()
        ]
        results = await asyncio.gather(*calls, return_exceptions=False)

        any_ok = False
        for r in results:
            if r.ok:
                any_ok = True
                self.budget.add(
                    r.usage.get("input_tokens", 0)
                    + r.usage.get("output_tokens", 0)
                )
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
        """最终冒烟测试：所有 feature 都 pass 后，端到端验证 app 真的能用。

        test_engineer 是唯一判定者；本方法让 test_engineer 跑 `npm run check` +
        `npm run build` + 必要时 `npm run dev`，确保应用可启动。
        """
        log("🔥 冒烟测试：最终端到端验证（typecheck + 单测 + 构建 + 启动）")

        prompt = (
            "所有 feature 都已经过 test_engineer 逐个独立验证为 pass。\n"
            "现在做**最终端到端冒烟测试**，确保整个应用真的可用：\n"
            "  1) 运行 `npm run check` / `npm run test` 确保 typecheck + 单元测试全过；\n"
            "  2) 运行 `npm run build` 确保能编译出产物；\n"
            "  3) **【关键】启动真实应用**：`npm run dev` 启动 Electron 主进程 + "
            "渲染窗口，确认窗口能打开、UI 加载、核心交互可用（如创建连接、触发任务）；\n"
            "  4) 必要时截图，把结果（含命令输出关键片段、启动日志）写到 progress.md 的 "
            "`## Smoke Test -- final` 段；\n"
            "  5) 验证完关闭 Electron 进程；\n"
            "  6) 末尾用 `RESULT: pass` 或 `RESULT: blocked` 表态。\n\n"
            "这是最后一道防线；任何构建/启动失败必须如实报告，不要粉饰。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        result = await self.client.call(
            AgentCall(role="test_engineer", prompt=prompt),
            self.root,
        )
        self.budget.add(
            result.usage.get("input_tokens", 0)
            + result.usage.get("output_tokens", 0)
        )
        text = result.text or ""
        if "RESULT: pass" in text:
            log("   ✅ 冒烟测试 pass")
            return True
        log(f"   ❌ 冒烟测试 blocked：{text[:300]}")
        return False

    # ----- 主循环 --------------------------------------------------------

    async def run(self) -> int:
        log("=" * 70)
        log("🚀 数据迁移工具 · 多 Agent 编排器启动")
        log("=" * 70)
        log(f"   项目根:    {self.root}")
        log(f"   目标文件:  {GOALS_FILE.name}")
        log(f"   状态文件:  {FEATURE_LIST_FILE.name}, {PROGRESS_FILE.name}")
        log(f"   并发上限:  {self.client.max_concurrent} (默认 {MAX_CONCURRENT_AGENTS})")
        log(f"   API:       {self.client.api_url}")
        log(f"   模型:      {self.client.model}（key 取自环境变量 {self.client.api_key_env}）")
        log(f"   API max_tokens: {self.client.max_output_tokens}")
        log(f"   Token 监控阈值: {self.client.per_call_token_limit} (input+output)")
        log(f"   Token 重置: {TOKEN_RESET_INTERVAL_HOURS}h, 软上限 {SOFT_TOKEN_LIMIT} (≈不限)；rate {CALLS_PER_5H_SOFT_LIMIT}/5h；1M 上下文")
        if self.dry_run:
            log("   🧪 DRY-RUN 模式（不实际调用 claude CLI）")
        log("")

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:  # pragma: no cover
                pass

        cycle = 0
        while not self._stop.is_set():
            cycle += 1
            if self.max_cycles and cycle > self.max_cycles:
                log(f"⏹  达到 max_cycles={self.max_cycles}，正常退出。")
                break

            log(f"\n──── Cycle {cycle} ────────────────────────────────────────")

            self.budget.maybe_reset()
            # 注：token 上限已设为极大值（≈ 不限），不阻塞。

            features = self.state.load_features()

            target = self.state.next_pending(features)

            if target is None:
                # 没有 pending feature —— 检查是否真的全部 pass
                if self.state.is_goal_complete(features):
                    log(
                        "🎯 所有 feature 已 pass；触发最终冒烟测试"
                        "（验证 app 真的能跑）..."
                    )
                    if await self._phase_smoke_test():
                        log("🎉 冒烟测试通过；编排器停止。")
                    else:
                        log(
                            "⚠️  冒烟测试失败：app 不能启动/编译，"
                            "请人工修复后重跑编排器。"
                        )
                    break
                # 还有非 pass 的 feature 但没 pending —— 自举规划
                log("📋 没有 pending feature 但有未完成的，触发自举规划阶段...")
                target = await self._phase_plan_from_goals(features)
                if target is None:
                    log(
                        "🎉 goals.md 已被现有 feature 全部覆盖"
                        "（或规划阶段未产出），编排器停止。"
                    )
                    break
                # 规划本身就是一次设计 —— 直接进入开发
                log(f"   ➡️  进入开发/测试/交付阶段（{target.id}）")
            else:
                # 走标准设计阶段
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

            for approach in range(1, MAX_RETHINK + 2):  # 方案 1..MAX_RETHINK+1
                log(f"   📐 进入方案 {approach}/{MAX_RETHINK + 1}")
                approach_passed = False
                for attempt in range(1, MAX_DEV_TEST_ATTEMPTS + 1):
                    log(
                        f"      🔁 方案 {approach} - 尝试 {attempt}/"
                        f"{MAX_DEV_TEST_ATTEMPTS}"
                    )
                    if not await self._phase_develop(target, test_feedback, approach):
                        log(f"      ⚠️  开发失败（方案 {approach} 第 {attempt} 次）")
                        test_feedback = ""
                        await asyncio.sleep(5)
                        continue
                    approach_passed, test_feedback = await self._phase_test(target)
                    if approach_passed:
                        break
                    log(
                        f"      🔄 test blocked（方案 {approach} "
                        f"第 {attempt}/{MAX_DEV_TEST_ATTEMPTS} 次）"
                    )
                    await asyncio.sleep(3)

                if approach_passed:
                    test_passed = True
                    break

                # 当前方案所有尝试都失败 —— 优先尝试任务拆解
                if approach >= MAX_RETHINK + 1:
                    log(
                        f"   ❌ 已重设计 {MAX_RETHINK} 次（方案 1..{MAX_RETHINK + 1}）"
                        f"仍失败，feature {target.id} 放弃本轮 cycle"
                    )
                    break

                log(
                    f"   🧩 方案 {approach} 失败 {MAX_DEV_TEST_ATTEMPTS} 次，"
                    f"先尝试任务拆解"
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

            # 交付阶段只产出反馈（写入 progress.md），不门控、不改 status
            await self._phase_deliver(target)
            # 收割：若有被拆解的 feature 的全部子任务都已 pass，把原 feature 标为 pass
            features_after = self.state.load_features()
            reaped = self.state.reap_decomposed(features_after)
            if reaped:
                self.state.save_features(features_after)
                for r in reaped:
                    log(f"   🎯 拆解后的 feature {r.id} 全部子任务 pass，标为 pass")
            await asyncio.sleep(2)

        log("\n🛑 编排器已停止。")
        return 0


# ============================================================================
# 日志
# ============================================================================

def _ensure_log_dir() -> None:
    SESSION_LOG_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        _ensure_log_dir()
        with SESSION_LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:  # pragma: no cover
        pass


# ============================================================================
# CLI
# ============================================================================

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    # 默认值优先从环境变量读取（无需每次都传 CLI 参数），CLI 参数仍可覆盖
    default_api_url = os.environ.get(
        "ANTHROPIC_BASE_URL", "https://api.minimax.cn/anthropic"
    )
    default_model = os.environ.get("ANTHROPIC_MODEL", "MiniMax-M3")
    default_api_key_env = os.environ.get("ORCH_API_KEY_ENV", "ANTHROPIC_API_KEY")
    default_max_output_tokens = int(
        os.environ.get("ANTHROPIC_MAX_TOKENS", str(MAX_OUTPUT_TOKENS))
    )
    default_token_warn_threshold = int(
        os.environ.get("ORCH_TOKEN_WARN", str(PER_CALL_TOKEN_LIMIT))
    )
    default_max_concurrent = int(
        os.environ.get("ORCH_MAX_CONCURRENT", str(MAX_CONCURRENT_AGENTS))
    )

    p = argparse.ArgumentParser(
        description="数据迁移工具 多 Agent 编排器",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--max-concurrent", type=int, default=default_max_concurrent,
        help="同时运行的 Agent 数上限（默认 30；可用 ORCH_MAX_CONCURRENT 覆盖）",
    )
    p.add_argument(
        "--api-url", default=default_api_url,
        help="Anthropic Messages API base URL（默认 minimax.cn；"
             "可用 ANTHROPIC_BASE_URL 覆盖）",
    )
    p.add_argument(
        "--api-key-env", default=default_api_key_env,
        help="从中读取 API key 的环境变量名（默认 ANTHROPIC_API_KEY；"
             "可用 ORCH_API_KEY_ENV 覆盖）",
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
        help="最多执行多少个 cycle（0=无限，直到目标达成或 Ctrl+C）",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="只打印计划，不实际调用 claude CLI",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
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


if __name__ == "__main__":
    sys.exit(main())
