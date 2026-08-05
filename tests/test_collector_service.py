"""Regression tests for the independent collection service queue."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from apps.collector_py import channel, compass, douyin, scheduler, service, status
from apps.scraper_py import douyin_panel_probe


class CollectorServiceTest(unittest.TestCase):
    def test_service_entrypoint_resolves_project_package_from_any_directory(
        self,
    ) -> None:
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

    def test_local_cargo_status_update_allows_initial_build(self) -> None:
        self.assertEqual(status.default_status_update_timeout(["cargo", "run"]), 120.0)
        self.assertEqual(
            status.default_status_update_timeout(["luopan-worker-rs", "status-update"]),
            5.0,
        )

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

    def test_stale_chromium_singletons_are_removed_without_touching_session_data(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory)
            (session / "Cookies").write_text("preserve me", encoding="utf-8")
            (session / "SingletonLock").symlink_to("previous-container-1549")
            (session / "SingletonSocket").symlink_to("/tmp/missing-chromium-socket")
            (session / "SingletonCookie").symlink_to("123456789")

            self.assertTrue(compass.clear_stale_chromium_singletons(session))
            self.assertEqual(
                (session / "Cookies").read_text(encoding="utf-8"), "preserve me"
            )
            for name in compass.CHROMIUM_SINGLETON_NAMES:
                self.assertFalse((session / name).is_symlink())

    def test_custom_date_request_range_does_not_require_near_day_type(self) -> None:
        self.assertEqual(
            compass.date_range_from_fields(
                {
                    "date_type": ["custom"],
                    "begin_date": ["2026-07-25 00:00:00"],
                    "end_date": ["2026/07/25 23:59:59"],
                }
            ),
            ("2026/07/25", "2026/07/25"),
        )

    def test_near_day_date_range_still_requires_type_20(self) -> None:
        fields = {
            "date_type": ["custom"],
            "begin_date": ["2026-07-25"],
            "end_date": ["2026-07-25"],
        }
        self.assertIsNone(
            compass.date_range_from_fields(fields, required_date_type="20")
        )

    def test_custom_date_range_requires_type_999_when_filtering(self) -> None:
        fields = {
            "date_type": ["1"],
            "begin_date": ["2026-07-27"],
            "end_date": ["2026-07-27"],
        }
        self.assertIsNone(
            compass.date_range_from_fields(fields, required_date_type="999")
        )

    def test_custom_date_can_be_read_from_nested_post_data(self) -> None:
        self.assertEqual(
            compass.date_range_from_request(
                "https://compass.jinritemai.com/core_index_v3",
                '{"filters":{"date_type":"custom","begin_date":"2026-07-25","end_date":"2026-07-25"}}',
            ),
            ("2026/07/25", "2026/07/25"),
        )

    def test_missing_url_date_fields_fall_back_without_index_error(self) -> None:
        self.assertIsNone(compass.date_range_from_fields({}))

    def test_parse_args_accepts_historical_date(self) -> None:
        args = compass.parse_args(
            ["--module", "operations", "--date", "2026-07-25"],
            today=date(2026, 7, 27),
        )
        self.assertEqual(args.date.isoformat(), "2026-07-25")
        self.assertEqual(
            compass.expected_data_range(args.date), ("2026/07/25", "2026/07/25")
        )

    def test_parse_data_day_rejects_date_outside_current_month(self) -> None:
        with self.assertRaisesRegex(Exception, "仅支持本月"):
            compass.parse_data_day("2026-06-30", today=date(2026, 7, 27))

    def test_parse_args_rejects_non_historical_date(self) -> None:
        with self.assertRaises(SystemExit):
            compass.parse_args(["--module", "operations", "--date", "9999-12-31"])

    def test_custom_date_prototype_rejects_channel_before_browser_launch(self) -> None:
        args = compass.parse_args(["--date", "2026-07-25"], today=date(2026, 7, 27))
        with self.assertRaisesRegex(ValueError, "暂仅支持 --module operations"):
            asyncio.run(compass.run(args))

    def test_channel_request_metadata_removes_credentials(self) -> None:
        value = channel.sanitized_post_data(
            '{"query":"laptop","token":"secret","nested":{"verify_code":"hidden","page":2}}'
        )
        self.assertEqual(value, '{"query":"laptop","nested":{"page":2}}')

    def test_douyin_probe_requires_exactly_yesterday(self) -> None:
        expected = ("2026/08/04", "2026/08/04")
        self.assertEqual(
            douyin_panel_probe.assert_yesterday({expected}, today=date(2026, 8, 5)),
            expected,
        )
        with self.assertRaisesRegex(RuntimeError, "与昨天不一致"):
            douyin_panel_probe.assert_yesterday(
                {("2026/08/03", "2026/08/03")}, today=date(2026, 8, 5)
            )

    def test_douyin_probe_accepts_selected_panel_arguments(self) -> None:
        args = douyin_panel_probe.parse_args(["--panel", "live", "--panel", "video"])
        self.assertEqual(args.panel, ["live", "video"])

    def test_douyin_probe_uses_bounded_network_settle_window(self) -> None:
        self.assertEqual(douyin_panel_probe.PAGE_SETTLE_TIMEOUT_MS, 15000)

    def test_douyin_collector_requires_yesterday(self) -> None:
        self.assertEqual(
            douyin.expected_yesterday(date(2026, 8, 5)), ("2026/08/04", "2026/08/04")
        )
        self.assertEqual(set(douyin.PANEL_SPECS), {"live", "video", "product_card"})

    def test_worker_command_forwards_selected_modules(self) -> None:
        with (
            patch.dict(
                os.environ,
                {"COLLECTION_WORKER_COMMAND": "luopan-worker-rs compass-collect"},
            ),
            patch.object(
                service.shutil, "which", return_value="/usr/local/bin/luopan-worker-rs"
            ),
        ):
            command = service.worker_command(
                ["operations", "channel", "douyin"],
                "2026-07-25",
                ["店铺 A"],
            )

        self.assertEqual(command[:2], ["luopan-worker-rs", "compass-collect"])
        self.assertEqual(command.count("--module"), 3)
        self.assertIn("operations", command)
        self.assertIn("channel", command)
        self.assertIn("douyin", command)
        self.assertIn("--random-delay-seconds", command)
        self.assertEqual(command[command.index("--date") + 1], "2026-07-25")
        self.assertEqual(
            command[command.index("--shop") + 1],
            "店铺 A",
        )

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
