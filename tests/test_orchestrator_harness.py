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

    def test_dev_null_redirect_is_not_a_write_action(self):
        self.assertFalse(
            orch._bash_command_may_write("grep sqlite src/ 2>/dev/null")
        )
        self.assertTrue(
            orch._bash_command_may_write("cat > out.txt")
        )

    def test_read_only_stop_only_applies_to_developers(self):
        self.assertTrue(
            orch.AgentClient._enforce_read_only_stop("frontend_senior")
        )
        self.assertFalse(
            orch.AgentClient._enforce_read_only_stop("test_engineer")
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

            client = orch.AgentClient()
            client._project_root = project
            with mock.patch.object(orch, "log"):
                error = client._ensure_workspace_node_modules(workspace)

            self.assertIsNone(error)
            self.assertTrue(empty_modules.is_symlink())
            self.assertEqual(empty_modules.resolve(), main_modules.resolve())


if __name__ == "__main__":
    unittest.main()
