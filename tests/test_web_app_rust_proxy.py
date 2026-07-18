"""Regression tests for Flask's Rust-only API proxy boundary."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from apps.dashboard_py import web_app


class WebAppRustProxyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_status_update_command = web_app.STATUS_UPDATE_COMMAND
        self.original_manual_scrape_command = web_app.MANUAL_SCRAPE_COMMAND

    def tearDown(self) -> None:
        web_app.STATUS_UPDATE_COMMAND = self.original_status_update_command
        web_app.MANUAL_SCRAPE_COMMAND = self.original_manual_scrape_command

    def test_status_payload_requires_rust_api(self) -> None:
        with patch.object(web_app, "rust_api_json", return_value=({"state": "rust"}, 200)) as fetch:
            payload = web_app.status_payload(include_terminal_output=False)

        self.assertEqual(payload, {"state": "rust"})
        fetch.assert_called_once_with("/api/status", {"terminal_output": "false"})

    def test_inventory_endpoint_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context("/api/inventory"):
            with patch.object(web_app, "rust_api_json", return_value=({"summary": {"sku_records": 1}}, 200)):
                response, status = web_app.inventory_data.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"summary": {"sku_records": 1}})

    def test_settlement_endpoint_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context("/api/settlement?shop=惠普办公设备旗舰店"):
            with patch.object(web_app, "rust_api_json", return_value=({"summary": {"row_count": 1}}, 200)) as fetch:
                response, status = web_app.settlement_data.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"summary": {"row_count": 1}})
        fetch.assert_called_once_with(
            "/api/settlement",
            query={"shop": "惠普办公设备旗舰店"},
            method="GET",
            payload=None,
        )

    def test_compass_endpoint_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context("/api/compass"):
            with patch.object(web_app, "rust_api_json", return_value=({"records": [{"date": "2026-07-16"}]}, 200)):
                response, status = web_app.compass_data.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"records": [{"date": "2026-07-16"}]})

    def test_order_imports_endpoint_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context("/api/orders/imports"):
            with patch.object(web_app, "rust_api_json", return_value=({"batches": [], "summary": {"orders": 1}}, 200)):
                response, status = web_app.order_imports.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"batches": [], "summary": {"orders": 1}})

    def test_order_import_commit_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context(
            "/api/orders/imports",
            method="POST",
            json={"preview_token": "preview-1"},
        ):
            with patch.object(web_app, "rust_api_json", return_value=({"batch": {"id": "rust"}}, 201)) as fetch:
                response, status = web_app.commit_order_import.__wrapped__()

        self.assertEqual(status, 201)
        self.assertEqual(response.get_json(), {"batch": {"id": "rust"}})
        fetch.assert_called_once_with(
            "/api/orders/imports",
            query=None,
            method="POST",
            payload={"preview_token": "preview-1"},
        )

    def test_order_import_delete_uses_rust_api_only(self) -> None:
        with web_app.app.test_request_context("/api/orders/imports/batch-1", method="DELETE"):
            with patch.object(web_app, "rust_api_json", return_value=({"deleted": {"id": "batch-1"}}, 200)) as fetch:
                response, status = web_app.remove_order_import.__wrapped__("batch-1")

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"deleted": {"id": "batch-1"}})
        fetch.assert_called_once_with(
            "/api/orders/imports/batch-1",
            query=None,
            method="DELETE",
            payload=None,
        )

    def test_rust_api_unavailable_returns_502(self) -> None:
        with web_app.app.test_request_context("/api/inventory"):
            with patch.object(web_app, "rust_api_json", side_effect=web_app.RustApiUnavailable("down")):
                response, status = web_app.inventory_data.__wrapped__()

        self.assertEqual(status, 502)
        self.assertEqual(response.get_json()["error"], "Rust API 不可用")

    def test_manual_status_update_requires_rust_worker(self) -> None:
        web_app.STATUS_UPDATE_COMMAND = ["luopan-worker-rs", "status-update"]
        completed = Mock(returncode=0, stderr="")

        with patch.object(web_app.subprocess, "run", return_value=completed) as run:
            web_app.write_manual_scrape_requested_status()

        self.assertEqual(run.call_args.args[0][:2], ["luopan-worker-rs", "status-update"])
        self.assertIn("--state", run.call_args.args[0])
        self.assertIn("manual_requested", run.call_args.args[0])

    def test_manual_status_update_failure_raises(self) -> None:
        web_app.STATUS_UPDATE_COMMAND = ["luopan-worker-rs", "status-update"]
        completed = Mock(returncode=1, stderr="failed")

        with patch.object(web_app.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                web_app.write_manual_scrape_requested_status()

    def test_start_manual_scrape_uses_configured_worker_command(self) -> None:
        web_app.MANUAL_SCRAPE_COMMAND = ["luopan-worker-rs", "compass-scrape"]

        with TemporaryDirectory() as temp:
            progress_log = Path(temp) / "progress.log"
            with patch.object(web_app, "PROGRESS_LOG", progress_log):
                with patch.object(web_app, "write_manual_scrape_requested_status") as status_update:
                    with patch.object(web_app.subprocess, "Popen") as popen:
                        web_app.start_manual_scrape()

        status_update.assert_called_once()
        command = popen.call_args.args[0]
        self.assertEqual(command[:2], ["luopan-worker-rs", "compass-scrape"])
        self.assertIn("--random-delay-seconds", command)
        self.assertIn("--login-timeout-minutes", command)


if __name__ == "__main__":
    unittest.main()
