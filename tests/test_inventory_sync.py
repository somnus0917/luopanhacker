"""Regression tests for the local, read-only inventory pipeline."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from apps.inventory_py import inventory_sync
from apps.legacy_metrics_py import inventory_data


SHANGHAI = ZoneInfo("Asia/Shanghai")


def stock(warehouse: str, spec: str, available: float) -> dict[str, object]:
    return {
        "warehouse_no": warehouse,
        "warehouse_name": warehouse,
        "brand_name": "测试品牌",
        "goods_name": spec,
        "spec_no": spec,
        "stock_num": available,
        "available_num": available,
        "lock_num": 0,
        "today_num": 0,
        "cost_price": 0,
        "last_inout_time": "2026-07-01 00:00:00",
        "modified": "2026-07-01 00:00:00",
    }


class InventorySyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name) / "inventory"
        self.original_paths = {
            "INVENTORY_DIR": inventory_sync.INVENTORY_DIR,
            "SNAPSHOT_PATH": inventory_sync.SNAPSHOT_PATH,
            "HISTORY_DIR": inventory_sync.HISTORY_DIR,
            "STATE_PATH": inventory_sync.STATE_PATH,
            "LOCK_PATH": inventory_sync.LOCK_PATH,
            "data_snapshot": inventory_data.SNAPSHOT_PATH,
            "data_history": inventory_data.HISTORY_DIR,
        }
        inventory_sync.INVENTORY_DIR = root
        inventory_sync.SNAPSHOT_PATH = root / "inventory_snapshot.json"
        inventory_sync.HISTORY_DIR = root / "history"
        inventory_sync.STATE_PATH = root / "sync_state.json"
        inventory_sync.LOCK_PATH = root / ".sync.lock"
        inventory_data.SNAPSHOT_PATH = inventory_sync.SNAPSHOT_PATH
        inventory_data.HISTORY_DIR = inventory_sync.HISTORY_DIR
        self.original_fetchers = (
            inventory_sync.inventory_rows,
            inventory_sync.sales_rows,
            inventory_sync.inbound_rows,
        )

    def tearDown(self) -> None:
        inventory_sync.INVENTORY_DIR = self.original_paths["INVENTORY_DIR"]
        inventory_sync.SNAPSHOT_PATH = self.original_paths["SNAPSHOT_PATH"]
        inventory_sync.HISTORY_DIR = self.original_paths["HISTORY_DIR"]
        inventory_sync.STATE_PATH = self.original_paths["STATE_PATH"]
        inventory_sync.LOCK_PATH = self.original_paths["LOCK_PATH"]
        inventory_data.SNAPSHOT_PATH = self.original_paths["data_snapshot"]
        inventory_data.HISTORY_DIR = self.original_paths["data_history"]
        (
            inventory_sync.inventory_rows,
            inventory_sync.sales_rows,
            inventory_sync.inbound_rows,
        ) = self.original_fetchers
        self.temp.cleanup()

    def set_fetchers(self, inventory: list[dict[str, object]]) -> None:
        inventory_sync.inventory_rows = lambda now: inventory
        inventory_sync.sales_rows = lambda now: [
            {
                "warehouse_no": "001",
                "spec_no": "A",
                "date": now.date().isoformat(),
                "quantity": 7,
            }
        ]
        inventory_sync.inbound_rows = lambda now: []

    def test_incremental_sync_preserves_unchanged_rows_and_daily_history_is_immutable(
        self,
    ) -> None:
        day_one = datetime(2026, 7, 1, 3, 0, tzinfo=SHANGHAI)
        self.set_fetchers([stock("001", "A", 10), stock("001", "B", 20)])
        first = inventory_sync.run_sync(day_one)
        self.assertTrue(first["history_written"])

        self.set_fetchers([stock("001", "A", 8)])
        repeat = inventory_sync.run_sync(day_one.replace(hour=15))
        self.assertFalse(repeat["history_written"])
        current = json.loads(inventory_sync.SNAPSHOT_PATH.read_text(encoding="utf-8"))
        self.assertEqual({row["spec_no"] for row in current["inventory"]}, {"A", "B"})
        self.assertEqual(
            next(row for row in current["inventory"] if row["spec_no"] == "A")[
                "available_num"
            ],
            8,
        )
        history = json.loads(
            (inventory_sync.HISTORY_DIR / "2026-07-01.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            next(row for row in history["inventory"] if row["spec_no"] == "A")[
                "available_num"
            ],
            10,
        )

    def test_inventory_rows_preserves_wdt_cost_price(self) -> None:
        now = datetime(2026, 7, 1, 3, 0, tzinfo=SHANGHAI)
        with patch.object(
            inventory_sync,
            "fetch_all",
            return_value=[
                {
                    "warehouse_no": "001",
                    "warehouse_name": "主仓",
                    "spec_no": "A",
                    "stock_num": "10",
                    "avaliable_num": "8",
                    "cost_price": "12.34",
                }
            ],
        ):
            rows = inventory_sync.inventory_rows(now)

        self.assertEqual(rows[0]["cost_price"], 12.34)

    def test_failed_sync_keeps_last_known_good_snapshot(self) -> None:
        now = datetime(2026, 7, 2, 3, 0, tzinfo=SHANGHAI)
        self.set_fetchers([stock("001", "A", 10)])
        inventory_sync.run_sync(now)
        before = inventory_sync.SNAPSHOT_PATH.read_bytes()

        inventory_sync.sales_rows = lambda now: (_ for _ in ()).throw(
            RuntimeError("模拟销售接口异常")
        )
        with self.assertRaisesRegex(RuntimeError, "模拟销售接口异常"):
            inventory_sync.run_sync(now.replace(day=3))

        self.assertEqual(inventory_sync.SNAPSHOT_PATH.read_bytes(), before)
        state = json.loads(inventory_sync.STATE_PATH.read_text(encoding="utf-8"))
        self.assertIn("模拟销售接口异常", state["last_failure"]["message"])

    def test_actual_turnover_requires_30_consecutive_close_samples(self) -> None:
        start = datetime(2026, 6, 1, 3, 0, tzinfo=SHANGHAI)
        for offset in range(30):
            captured = start + timedelta(days=offset)
            snapshot = {
                "captured_at": captured.isoformat(timespec="seconds"),
                "inventory": [stock("001", "A", 30)],
                "sales_7d": [
                    {
                        "warehouse_no": "001",
                        "spec_no": "A",
                        "date": captured.date().isoformat(),
                        "quantity": 1,
                    }
                ],
            }
            inventory_sync.atomic_write_json(
                inventory_sync.HISTORY_DIR / f"{captured.date().isoformat()}.json",
                snapshot,
            )

        history = inventory_data.historical_turnover()
        self.assertTrue(history["ready"])
        self.assertEqual(history["available_days"], 30)
        self.assertEqual(history["actual_turnover_days"], 30)


if __name__ == "__main__":
    unittest.main()
