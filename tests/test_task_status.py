"""Regression tests for Rust-backed task status writes."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from apps.collector_py import status as task_status


class TaskStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_status_update_command = task_status.STATUS_UPDATE_COMMAND

    def tearDown(self) -> None:
        task_status.STATUS_UPDATE_COMMAND = self.original_status_update_command

    def test_write_status_uses_rust_with_json_fields(self) -> None:
        task_status.STATUS_UPDATE_COMMAND = ["luopan-worker-rs", "status-update"]
        completed = Mock(returncode=0, stderr="")

        with patch.object(task_status.subprocess, "run", return_value=completed) as run:
            task_status.write_status(
                state="success",
                message="done",
                last_json="/tmp/data.json",
                shops=["a", "b"],
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["luopan-worker-rs", "status-update"])
        self.assertIn("--state", command)
        self.assertIn("success", command)
        self.assertIn("--message", command)
        self.assertIn("done", command)
        self.assertIn("--field", command)
        self.assertIn('last_json="/tmp/data.json"', command)
        self.assertIn('shops=["a", "b"]', command)

    def test_write_status_failure_raises(self) -> None:
        task_status.STATUS_UPDATE_COMMAND = ["luopan-worker-rs", "status-update"]
        completed = Mock(returncode=1, stderr="failed")

        with patch.object(task_status.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                task_status.write_status(state="failed", message="bad")


if __name__ == "__main__":
    unittest.main()
