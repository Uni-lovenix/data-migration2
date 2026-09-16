import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import orchestrator as orch


class OrchestratorHarnessTest(unittest.TestCase):
    def test_owner_routing_uses_minimal_role(self):
        feature = orch.Feature(
            id="sqlite-export",
            name="SQLite export",
            description="",
            status="in_progress",
            owner_role="desktop",
        )
        self.assertEqual(orch._roles_for_feature(feature), {"frontend_senior"})

        backend = orch.Feature(
            id="hive-export",
            name="Hive export",
            description="",
            status="not_started",
            owner_role="Golang backend",
        )
        self.assertEqual(orch._roles_for_feature(backend), {"golang_senior"})

    def test_package_changes_do_not_add_golang_role(self):
        self.assertEqual(
            orch._roles_from_changed_paths(
                {"package.json", "package-lock.json", "src/main/app.ts"}
            ),
            {"frontend_senior"},
        )

    def test_failure_owner_can_select_both_roles(self):
        text = """
RESULT: blocked
FAILURE:
  expected: roundtrip succeeds
  actual: jsonl envelope mismatch
  owner: desktop / golang_senior
"""
        self.assertEqual(
            orch._extract_failure_owner(text),
            {"frontend_senior", "golang_senior"},
        )

    def test_blocked_feedback_requires_actionable_evidence(self):
        valid, _ = orch.Orchestrator._blocked_feedback_is_actionable(
            """
RESULT: blocked
FAILURE:
  step: roundtrip
  command: npm test
  exit_code: 1
  expected: 3 rows
  actual: 0 rows
  owner: desktop
"""
        )
        self.assertTrue(valid)
        invalid, _ = orch.Orchestrator._blocked_feedback_is_actionable(
            "RESULT: blocked"
        )
        self.assertFalse(invalid)

    def test_progress_excerpt_only_returns_current_feature(self):
        text = (
            "## Current State\n"
            "global\n"
            "## Develop :: sqlite-export -- t\n"
            "target detail\n"
            "## Develop :: other -- t\n"
            "unrelated detail\n"
        )
        excerpt = orch._relevant_progress_excerpt(
            text, "sqlite-export", limit=1000
        )
        self.assertIn("target detail", excerpt)
        self.assertNotIn("unrelated detail", excerpt)

    def test_subtask_progress_uses_parent_alias(self):
        text = (
            "## Develop :: sqlite-export -- t\n"
            "parent detail\n"
            "## Develop :: other -- t\n"
            "unrelated detail\n"
        )
        excerpt = orch._relevant_progress_excerpt(
            text, "sqlite-export--step--1", limit=1000
        )
        self.assertIn("parent detail", excerpt)
        self.assertNotIn("unrelated detail", excerpt)

    def test_progress_excerpt_includes_level_three_design_sections(self):
        text = (
            "## Current State\n"
            "global\n"
            "### Design -- mysql-export\n"
            "mysql design detail\n"
            "### Design -- other\n"
            "unrelated\n"
        )
        excerpt = orch._relevant_progress_excerpt(
            text, "mysql-export", limit=1000
        )
        self.assertIn("mysql design detail", excerpt)
        self.assertNotIn("unrelated", excerpt)

    def test_context_snapshot_injects_and_refreshes_live_worktree_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._init_git_repo(root)
            source = root / "src" / "app.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export const value = 1\n", encoding="utf-8")
            self._git(root, "add", "-A")
            self._git(root, "commit", "-q", "-m", "baseline")

            (root / "feature_list.json").write_text(
                json.dumps(
                    {
                        "features": [
                            {
                                "id": "sqlite-export",
                                "name": "SQLite export",
                                "description": "",
                                "status": "in_progress",
                                "dependencies": [],
                                "ownerRole": "desktop",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (root / "progress.md").write_text(
                "## Current State\n- baseline\n",
                encoding="utf-8",
            )
            (root / "session-handoff.md").write_text(
                self._valid_handoff(),
                encoding="utf-8",
            )

            source.write_text("export const value = 2\n", encoding="utf-8")
            untracked = root / "src" / "new.ts"
            untracked.write_text("export const added = true\n", encoding="utf-8")

            client = orch.AgentClient.__new__(orch.AgentClient)
            client._project_root = root
            client._worktree_root = root
            client._snapshot_cache = {}
            before = client._build_context_snapshot(
                root,
                role="frontend_senior",
                feature_id="sqlite-export",
            )

            self.assertIn("编排器实时工作区状态（调用前采集）", before)
            self.assertIn("src/app.ts", before)
            self.assertIn("+export const value = 2", before)
            self.assertIn("src/new.ts", before)

            source.write_text("export const value = 3\n", encoding="utf-8")
            after = client._build_context_snapshot(
                root,
                role="frontend_senior",
                feature_id="sqlite-export",
            )

            self.assertNotIn("+export const value = 3", before)
            self.assertIn("+export const value = 3", after)

    def test_retry_context_uses_injected_worktree_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            orchestrator = orch.Orchestrator.__new__(orch.Orchestrator)
            orchestrator.root = Path(tmp)
            feature = orch.Feature(
                id="sqlite-export",
                name="SQLite export",
                description="",
                status="in_progress",
                owner_role="desktop",
            )
            with mock.patch.object(orch, "log"):
                orchestrator._write_retry_context(
                    feature,
                    approach=1,
                    attempt=1,
                    reason="test",
                    completed_roles=[],
                    failed_roles=["frontend_senior"],
                    evidence="read-only loop",
                    solution="make a minimal fix",
                )

            text = orchestrator._retry_context_path(feature.id).read_text(
                encoding="utf-8"
            )
            self.assertIn("直接注入上下文", text)
            self.assertIn("不要仅为重新确认状态而重复", text)

    def test_dev_null_redirect_is_not_a_write_action(self):
        self.assertFalse(
            orch._bash_command_may_write("grep sqlite src/ 2>/dev/null")
        )
        self.assertTrue(
            orch._bash_command_may_write("cat > out.txt")
        )

    def test_read_only_stop_only_applies_to_developers(self):
        self.assertEqual(
            orch.AgentClient._read_only_limits("frontend_senior", "normal"),
            (12, 16),
        )
        self.assertEqual(
            orch.AgentClient._read_only_limits(
                "frontend_senior", "Retry Context execution"
            ),
            (20, 28),
        )
        self.assertIsNone(
            orch.AgentClient._read_only_limits("test_engineer", "normal")
        )

    def test_parent_container_does_not_block_child_scheduling(self):
        features = [
            orch.Feature(
                id="mysql-export",
                name="mysql export",
                description="",
                status="pass",
            ),
            orch.Feature(
                id="mysql-import",
                name="mysql import",
                description="",
                status="pass",
            ),
            orch.Feature(
                id="sqlite-export",
                name="sqlite export",
                description="",
                status="in_progress",
                owner_role="desktop",
            ),
            orch.Feature(
                id="sqlite-export--step--1",
                name="sqlite step",
                description="",
                status="not_started",
                dependencies=["sqlite-export"],
                owner_role="desktop",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            store = orch.StateStore(Path(tmp), use_lock=False)
            chosen = store.next_pending(features)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen.id, "sqlite-export--step--1")

    def test_feature_timestamp_is_preserved(self):
        feature = orch.Feature.from_dict(
            {
                "id": "x",
                "name": "x",
                "description": "",
                "status": "pass",
                "testedAt": "2026-01-01T00:00:00",
            }
        )
        self.assertEqual(
            feature.to_dict()["testedAt"],
            "2026-01-01T00:00:00",
        )

    def test_relevant_dirty_files_are_synced_to_new_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "main"
            worktree = Path(tmp) / "worktree"
            (root / "src" / "main").mkdir(parents=True)
            (root / "src" / "main" / "sqlite-service.ts").write_text(
                "export const sqlite = true\n", encoding="utf-8"
            )
            (root / "package.json").write_text("{}\n", encoding="utf-8")
            (root / "src" / "main" / "unrelated.ts").write_text(
                "export const unrelated = true\n", encoding="utf-8"
            )
            worktree.mkdir()

            orchestrator = orch.Orchestrator.__new__(orch.Orchestrator)
            orchestrator.root = root
            orchestrator._dirty_main_worktree_files = lambda: [
                "src/main/sqlite-service.ts",
                "src/main/unrelated.ts",
                "package.json",
            ]
            feature = orch.Feature(
                id="sqlite-export--step--1",
                name="sqlite",
                description="",
                status="not_started",
                owner_role="desktop",
            )
            with mock.patch.object(orch, "log"):
                synced = orchestrator._sync_relevant_dirty_files(
                    feature, SimpleNamespace(path=worktree)
                )

            self.assertIn("src/main/sqlite-service.ts", synced)
            self.assertIn("package.json", synced)
            self.assertNotIn("src/main/unrelated.ts", synced)
            self.assertTrue(
                (worktree / "src" / "main" / "sqlite-service.ts").exists()
            )

    def test_empty_worktree_node_modules_is_replaced_with_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            workspace = Path(tmp) / "worktree"
            main_modules = project / "node_modules"
            (main_modules / "electron-vite").mkdir(parents=True)
            empty_modules = workspace / "node_modules"
            empty_modules.mkdir(parents=True)

            async def run_check():
                client = orch.AgentClient()
                client._project_root = project
                with mock.patch.object(orch, "log"):
                    return client._ensure_workspace_node_modules(workspace)

            error = asyncio.run(run_check())
            self.assertIsNone(error)
            self.assertTrue(empty_modules.is_symlink())
            self.assertEqual(empty_modules.resolve(), main_modules.resolve())

    def test_handoff_gate_rejects_unchanged_content(self):
        handoff = self._valid_handoff()
        error = orch._handoff_update_gate_error(handoff, handoff)
        self.assertIn("was not updated", error or "")

    def test_handoff_gate_rejects_whitespace_only_change(self):
        handoff = self._valid_handoff()
        error = orch._handoff_update_gate_error(
            handoff,
            handoff + "\n\n   \n",
        )
        self.assertIn("was not updated", error or "")

    def test_handoff_gate_rejects_missing_core_section(self):
        handoff = self._valid_handoff().replace(
            "## Verification Evidence\n",
            "",
        )
        error = orch._handoff_update_gate_error(None, handoff)
        self.assertIn("## Verification Evidence", error or "")

    def test_handoff_gate_accepts_meaningful_update(self):
        handoff = self._valid_handoff()
        error = orch._handoff_update_gate_error(
            handoff,
            handoff.replace(
                "- completed baseline",
                "- completed baseline\n- [role=golang_senior] implemented export",
            ),
        )
        self.assertIsNone(error)

    def test_agent_call_rejects_result_without_handoff_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "session-handoff.md").write_text(
                self._valid_handoff(),
                encoding="utf-8",
            )
            result = self._run_fake_agent_call(
                root,
                update_handoff=False,
            )

            self.assertFalse(result.ok)
            self.assertIn("hard gate failed", result.text)

    def test_agent_call_accepts_result_with_handoff_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "session-handoff.md").write_text(
                self._valid_handoff(),
                encoding="utf-8",
            )
            result = self._run_fake_agent_call(
                root,
                update_handoff=True,
            )

            self.assertTrue(result.ok)

    def _run_fake_agent_call(self, root: Path, *, update_handoff: bool):
        async def run_call():
            client = orch.AgentClient()
            fake_client = self._fake_anthropic_client(
                root,
                update_handoff=update_handoff,
            )
            with mock.patch.dict(
                os.environ,
                {"ANTHROPIC_API_KEY": "test-key"},
            ), mock.patch.object(
                client,
                "_get_client",
                new=mock.AsyncMock(return_value=fake_client),
            ), mock.patch.object(orch, "log"):
                return await client.call(
                    orch.AgentCall(
                        role="golang_senior",
                        prompt="implement feature",
                        feature_id="sqlite-export",
                    ),
                    root,
                )

        return asyncio.run(run_call())

    @staticmethod
    def _valid_handoff() -> str:
        return "\n\n".join([
            "# Session Handoff",
            "## Current Objective\n- objective",
            "## Completed This Session\n- completed baseline",
            "## Verification Evidence\n- verified baseline",
            "## Decisions Made\n- decision baseline",
            "## Blockers / Risks\n- none",
            "## Next Session Startup\n- continue",
        ]) + "\n"

    @staticmethod
    def _init_git_repo(root: Path) -> None:
        subprocess.run(
            ["git", "init", "-q"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        subprocess.run(
            ["git", "config", "user.email", "harness@example.invalid"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        subprocess.run(
            ["git", "config", "user.name", "Harness Test"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    @staticmethod
    def _git(root: Path, *args: str) -> None:
        subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    @staticmethod
    def _fake_anthropic_client(
        root: Path,
        *,
        update_handoff: bool,
    ):
        response = SimpleNamespace(
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text="DONE")],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )

        class FakeMessages:
            async def create(self, **kwargs):
                if update_handoff:
                    path = root / "session-handoff.md"
                    path.write_text(
                        path.read_text(encoding="utf-8").replace(
                            "- completed baseline",
                            "- completed baseline\n- [role=golang_senior] "
                            "[feature=sqlite-export] implemented export",
                        ),
                        encoding="utf-8",
                    )
                return response

        return SimpleNamespace(messages=FakeMessages())


if __name__ == "__main__":
    unittest.main()
