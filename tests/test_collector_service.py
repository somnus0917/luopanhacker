"""Regression tests for the independent collection service queue."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.collector_py import channel, scheduler, service


class CollectorServiceTest(unittest.TestCase):
    def test_scheduler_lock_is_exclusive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "job.lock"
            with patch.object(scheduler, "LOCK_PATH", lock):
                self.assertTrue(scheduler.acquire_lock())
                self.assertFalse(scheduler.acquire_lock())

    def test_channel_request_metadata_removes_credentials(self) -> None:
        value = channel.sanitized_post_data(
            '{"query":"laptop","token":"secret","nested":{"verify_code":"hidden","page":2}}'
        )
        self.assertEqual(value, '{"query":"laptop","nested":{"page":2}}')

    def test_worker_command_forwards_selected_modules(self) -> None:
        with (
            patch.dict(os.environ, {"COLLECTION_WORKER_COMMAND": "luopan-worker-rs compass-collect"}),
            patch.object(service.shutil, "which", return_value="/usr/local/bin/luopan-worker-rs"),
        ):
            command = service.worker_command(["operations", "channel"])

        self.assertEqual(command[:2], ["luopan-worker-rs", "compass-collect"])
        self.assertEqual(command.count("--module"), 2)
        self.assertIn("operations", command)
        self.assertIn("channel", command)
        self.assertIn("--random-delay-seconds", command)

    def test_recover_request_requeues_interrupted_work(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request.json"
            running = root / "request.running.json"
            lock = root / "job.lock"
            running.write_text('{"modules":["channel"]}', encoding="utf-8")
            with (
                patch.object(service, "REQUEST_PATH", request),
                patch.object(service, "RUNNING_REQUEST_PATH", running),
                patch.object(service, "LOCK_PATH", lock),
            ):
                service.recover_request()

            self.assertTrue(request.exists())
            self.assertFalse(running.exists())


if __name__ == "__main__":
    unittest.main()
