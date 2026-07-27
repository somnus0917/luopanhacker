"""Regression tests for the independent collection service queue."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.collector_py import channel, compass, scheduler, service


class CollectorServiceTest(unittest.TestCase):
    def test_service_entrypoint_resolves_project_package_from_any_directory(self) -> None:
        service_path = Path(service.__file__).resolve()
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    f"import runpy; runpy.run_path({str(service_path)!r}, run_name='collector_import_check')",
                ],
                cwd=directory,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_scheduler_lock_is_exclusive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "job.lock"
            with patch.object(scheduler, "LOCK_PATH", lock):
                self.assertTrue(scheduler.acquire_lock())
                self.assertFalse(scheduler.acquire_lock())

    def test_scheduler_does_not_expire_a_live_old_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "job.lock"
            lock.write_text(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "hostname": socket.gethostname(),
                        "started_at": "2020-01-01T00:00:00",
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(scheduler, "LOCK_PATH", lock):
                self.assertFalse(scheduler.stale_lock())

    def test_service_removes_lock_from_previous_container(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "job.lock"
            lock.write_text(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "hostname": "previous-container",
                        "started_at": "2020-01-01T00:00:00",
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(service, "LOCK_PATH", lock):
                self.assertFalse(service.lock_active())
            self.assertFalse(lock.exists())

    def test_stale_chromium_singletons_are_removed_without_touching_session_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory)
            (session / "Cookies").write_text("preserve me", encoding="utf-8")
            (session / "SingletonLock").symlink_to("previous-container-1549")
            (session / "SingletonSocket").symlink_to("/tmp/missing-chromium-socket")
            (session / "SingletonCookie").symlink_to("123456789")

            self.assertTrue(compass.clear_stale_chromium_singletons(session))
            self.assertEqual((session / "Cookies").read_text(encoding="utf-8"), "preserve me")
            for name in compass.CHROMIUM_SINGLETON_NAMES:
                self.assertFalse((session / name).is_symlink())

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
