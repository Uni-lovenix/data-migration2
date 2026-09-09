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
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

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
MAX_CONCURRENT_AGENTS = 5               # 同时运行 Agent 数上限
TOKEN_RESET_INTERVAL_HOURS = 5          # Token 重置周期
SOFT_TOKEN_LIMIT = 200_000              # 单次重置周期内的软上限（输入 token 估算）
AGENT_TIMEOUT_SECONDS = 1800            # 单个 Agent 调用最长 30 分钟

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
            " 3. 与架构师通过 progress.md 同步你的产品决策。\n"
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
            " 3. 与产品经理对齐迭代协议后再交给开发 Agent。\n"
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
            "硬性约束（违反即视为未完成）：\n"
            " 1. 每次会话【只接受一个功能】作为交付单元；不要尝试并行开发多个；\n"
            " 2. 实现必须经过 `go vet ./...` 与 `go test ./...`；\n"
            " 3. 修改完成后必须更新 feature_list.json 中对应功能的 status=pass 或 in_progress；\n"
            " 4. 进度与决策写入 progress.md 的 What's Next / Decisions Made 段。\n"
            "完成后请在输出末尾用一行 `RESULT: pass` 或 `RESULT: in_progress` 明确表态。"
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
            " 2. 必须在 src/renderer 内完成，且不破坏现有 typecheck 与单元测试；\n"
            " 3. 修改完成后更新 feature_list.json 与 progress.md；\n"
            " 4. 完成后用一行 `RESULT: pass` 或 `RESULT: in_progress` 表态。"
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
            " 4. 修改完成后更新 feature_list.json 与 progress.md；\n"
            " 5. 完成后用一行 `RESULT: pass` 或 `RESULT: in_progress` 表态。"
        ),
    },
    "test_engineer": {
        "label": "测试工程师",
        "kind": "evaluator",
        "system_prompt": (
            "你是「数据迁移工具」项目的【测试工程师】。\n"
            "职责：按迭代协议与退出标准对开发 Agent 的交付做独立验证；发现问题反馈给"
            "对应开发者修改。\n"
            "硬性约束：\n"
            " 1. 每次会话【只验证一个功能】；\n"
            " 2. 至少跑通类型检查 + 单元测试（必要时跑集成）；\n"
            " 3. 验证后必须更新 feature_list.json 中对应功能的 status（pass / blocked）"
            " 与 evidence 字段；\n"
            " 4. 完成后用一行 `RESULT: pass` 或 `RESULT: blocked` 表态。"
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
            " 2. 把验收意见写到 progress.md 的 Notes for Next Session；\n"
            " 3. 完成后用一行 `RESULT: accept` 或 `RESULT: reject` 表态。"
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
        """挑出下一个待开发（not_started 且依赖已 pass）的功能。"""
        passed_ids = {f.id for f in features if f.status == "pass"}
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
        """当 token 用尽时阻塞直到下个周期开始，返回等待秒数。"""
        wait = self.time_to_reset().total_seconds()
        if wait > 0:
            log(
                f"🛑 Token 已达上限（{self.used}/{self.soft_limit}），"
                f"等待 {wait/60:.1f} 分钟后自动重置。"
            )
            time.sleep(wait + 1)
            self.maybe_reset()
        return wait


# ============================================================================
# Agent 调用层
# ============================================================================

class AgentClient:
    """通过 subprocess 调用 `claude` CLI 执行 Agent 角色。"""

    def __init__(
        self,
        cli: str = "claude",
        max_concurrent: int = MAX_CONCURRENT_AGENTS,
        per_agent_budget_usd: float = 0.50,
        default_model: str = "sonnet",
    ) -> None:
        self.cli = cli
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.per_agent_budget_usd = per_agent_budget_usd
        self.default_model = default_model

    async def call(self, call: AgentCall, project_root: Path) -> AgentResult:
        role_meta = ROLES[call.role]
        system_prompt = role_meta["system_prompt"]

        ctx = self._build_context_snapshot(project_root)
        full_prompt = (
            f"{ctx}\n\n---\n\n【本次任务】\n\n{call.prompt}\n\n"
            f"---\n\n【本角色硬性约束】\n{system_prompt}\n"
        )

        cmd = [
            self.cli,
            "--print",
            "--output-format", "json",
            "--model", self.default_model,
            "--max-budget-usd", str(self.per_agent_budget_usd),
            "--permission-mode", "acceptEdits",
            "--add-dir", str(project_root),
            "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
            "--append-system-prompt", system_prompt,
            "--no-session-persistence",
            full_prompt,
        ]

        async with self.semaphore:
            log(f"🤖 启动 Agent: {role_meta['label']} (并发 {MAX_CONCURRENT_AGENTS} 上限)")
            start = time.time()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=str(project_root),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout_b, stderr_b = await asyncio.wait_for(
                        proc.communicate(), timeout=AGENT_TIMEOUT_SECONDS
                    )
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.communicate()
                    return AgentResult(
                        role=call.role, ok=False, text="timeout",
                        duration_sec=time.time() - start, feature_id=call.feature_id,
                    )

                stdout = stdout_b.decode("utf-8", errors="replace")
                stderr = stderr_b.decode("utf-8", errors="replace")
                duration = time.time() - start
                ok = proc.returncode == 0

                if not ok:
                    log(f"   ⚠️  {role_meta['label']} 退出码 {proc.returncode}; "
                        f"stderr: {stderr[-300:]}")
                    return AgentResult(
                        role=call.role, ok=False, text=stderr or stdout,
                        duration_sec=duration, feature_id=call.feature_id,
                    )

                text, usage = self._parse_json_output(stdout)
                log(
                    f"   ✅ {role_meta['label']} 完成 ({duration:.1f}s, "
                    f"≈{usage.get('input_tokens', 0)}+{usage.get('output_tokens', 0)} tokens)"
                )
                return AgentResult(
                    role=call.role, ok=True, text=text, usage=usage,
                    duration_sec=duration, feature_id=call.feature_id,
                )

            except FileNotFoundError:
                log(
                    f"   ❌ 找不到 `{self.cli}` CLI。请先安装 Claude Code："
                    f" https://docs.claude.com/claude-code"
                )
                return AgentResult(
                    role=call.role, ok=False, text="claude cli not found",
                    feature_id=call.feature_id,
                )

    def _parse_json_output(self, raw: str) -> tuple[str, dict[str, int]]:
        """claude --output-format json 输出形如 {type, role, content, usage}。"""
        try:
            data = json.loads(raw)
            if isinstance(data, list) and data:
                data = data[0]
            content = data.get("content", "")
            if isinstance(content, list):
                text = "".join(
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                )
            else:
                text = str(content)
            usage = data.get("usage", {}) or {}
            return text, {
                "input_tokens": int(usage.get("input_tokens", 0)),
                "output_tokens": int(usage.get("output_tokens", 0)),
            }
        except json.JSONDecodeError:
            return raw, {"input_tokens": 0, "output_tokens": 0}

    def _build_context_snapshot(self, root: Path) -> str:
        """注入规则地图的关键快照：目标、当前状态、进度。"""
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
        if features_path.exists():
            try:
                raw = json.loads(features_path.read_text(encoding="utf-8"))
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

        return (
            "【规则地图 / 上下文快照】\n\n"
            "### goals.md (项目目标)\n"
            "```\n" + goals.strip() + "\n```\n\n"
            "### feature_list.json (当前状态)\n"
            "\n".join(feature_summary_lines) + "\n\n"
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
            max_concurrent=args.max_concurrent,
            per_agent_budget_usd=args.agent_budget,
            default_model=args.model,
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

        result = await self.client.call(
            AgentCall(role="product_manager", prompt=prompt, feature_id=next_feature.id),
            self.root,
        )
        if result.ok:
            self.budget.add(
                result.usage.get("input_tokens", 0)
                + result.usage.get("output_tokens", 0)
            )
            self.state.append_progress(
                f"Design :: {next_feature.id}",
                f"产品经理 + 架构师共同制定的迭代协议：\n\n{result.text[:2000]}",
            )

        return next_feature if result.ok else None

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

    async def _phase_develop(self, feature: Feature) -> bool:
        """Phase 2: 单个开发 Agent 负责一个功能（一次只做一个）。"""
        log(f"🛠️  开发阶段：{feature.id} :: {feature.name}")

        owner = (feature.owner_role or "").lower()
        if "golang" in owner:
            dev_role = "golang_senior"
        elif "ui" in owner:
            dev_role = "ui_engineer"
        elif "桌面" in owner or "desktop" in owner:
            dev_role = "ui_engineer"
        else:
            dev_role = "frontend_senior"

        prompt = (
            f"现在开发【单一功能】：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n"
            f"  - 依赖: {feature.dependencies}\n\n"
            f"硬性要求：\n"
            f"  1) 本次只交付这一个功能，不要顺手做其它功能；\n"
            f"  2) 实现后必须更新 feature_list.json 中 `{feature.id}` 的 status 与 evidence；\n"
            f"  3) 在 progress.md 追加 `## Develop :: {feature.id}` 段；\n"
            f"  4) 末尾用一行 `RESULT: pass` 或 `RESULT: in_progress`。"
        )

        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        result = await self.client.call(
            AgentCall(role=dev_role, prompt=prompt, feature_id=feature.id),
            self.root,
        )
        self.budget.add(
            result.usage.get("input_tokens", 0)
            + result.usage.get("output_tokens", 0)
        )
        if result.ok and "RESULT:" in result.text:
            verdict = result.text.split("RESULT:")[-1].strip().splitlines()[0]
            log(f"   📦 开发自评: {verdict}")
        return result.ok

    async def _phase_test(self, feature: Feature) -> bool:
        """Phase 3: 测试工程师验证单个功能。"""
        log(f"🧪 测试阶段：{feature.id} :: {feature.name}")
        prompt = (
            f"请独立验证【单一功能】：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n"
            f"  - description: {feature.description}\n\n"
            f"步骤：\n"
            f"  1) 运行 `npm run typecheck` / `go vet ./...` 等基础检查；\n"
            f"  2) 如有单元/集成测试，至少跑一遍；\n"
            f"  3) 在 feature_list.json 中更新 `{feature.id}` 的 status（pass / blocked）"
            f" 和 evidence 字段；\n"
            f"  4) 末尾用一行 `RESULT: pass` 或 `RESULT: blocked`。"
        )
        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        result = await self.client.call(
            AgentCall(role="test_engineer", prompt=prompt, feature_id=feature.id),
            self.root,
        )
        self.budget.add(
            result.usage.get("input_tokens", 0)
            + result.usage.get("output_tokens", 0)
        )
        return result.ok

    async def _phase_deliver(self, feature: Feature) -> bool:
        """Phase 4: 用户 + 架构师 + 产品经理联合验收。"""
        log(f"📦 交付阶段：{feature.id} :: {feature.name}")
        prompt = (
            f"请对【单一功能】做最终验收：\n"
            f"  - id: {feature.id}\n"
            f"  - name: {feature.name}\n\n"
            f"从用户视角评估真实可用性；如有阻塞问题，反馈给开发 Agent 修改。"
            f"末尾用一行 `RESULT: accept` 或 `RESULT: reject`。"
        )
        if self.dry_run:
            log("   [dry-run] 跳过实际调用。")
            return True

        result = await self.client.call(
            AgentCall(role="user", prompt=prompt, feature_id=feature.id),
            self.root,
        )
        self.budget.add(
            result.usage.get("input_tokens", 0)
            + result.usage.get("output_tokens", 0)
        )
        return result.ok

    # ----- 主循环 --------------------------------------------------------

    async def run(self) -> int:
        log("=" * 70)
        log("🚀 数据迁移工具 · 多 Agent 编排器启动")
        log("=" * 70)
        log(f"   项目根:    {self.root}")
        log(f"   目标文件:  {GOALS_FILE.name}")
        log(f"   状态文件:  {FEATURE_LIST_FILE.name}, {PROGRESS_FILE.name}")
        log(f"   并发上限:  {MAX_CONCURRENT_AGENTS}")
        log(f"   Token 重置: {TOKEN_RESET_INTERVAL_HOURS}h, 软上限 {SOFT_TOKEN_LIMIT}")
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
            if self.budget.utilization() >= 1.0:
                self.budget.wait_until_reset()

            features = self.state.load_features()

            target = self.state.next_pending(features)

            if target is None:
                # 没有 pending feature —— 触发自举规划：
                # 让产品经理 + 架构师重新读 goals.md，追加缺失目标点
                log("📋 没有 pending feature，触发自举规划阶段...")
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

            if not await self._phase_develop(target):
                log("   ⚠️  开发 Agent 未成功产出，跳到下一 cycle。")
                await asyncio.sleep(5)
                continue

            if not await self._phase_test(target):
                log("   ⚠️  测试 Agent 未成功产出，跳到下一 cycle。")
                await asyncio.sleep(5)
                continue

            await self._phase_deliver(target)
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
    p = argparse.ArgumentParser(
        description="数据迁移工具 多 Agent 编排器",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--max-concurrent", type=int, default=MAX_CONCURRENT_AGENTS,
        help="同时运行的 Agent 数上限（≤5）",
    )
    p.add_argument(
        "--agent-budget", type=float, default=0.50,
        help="单个 Agent 调用的 USD 预算（传给 --max-budget-usd）",
    )
    p.add_argument(
        "--model", default="sonnet",
        help="claude 模型别名（sonnet / opus / haiku）",
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
    if args.max_concurrent > MAX_CONCURRENT_AGENTS:
        log(
            f"⚠️  --max-concurrent={args.max_concurrent} 超过硬上限 "
            f"{MAX_CONCURRENT_AGENTS}，已截断。"
        )
        args.max_concurrent = MAX_CONCURRENT_AGENTS

    orch = Orchestrator(args)
    try:
        return asyncio.run(orch.run())
    except KeyboardInterrupt:
        log("\n⌨️  收到 Ctrl+C，正在停止...")
        return 130


if __name__ == "__main__":
    sys.exit(main())
