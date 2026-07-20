# Python Retention Map

The migration is intentionally hybrid: Rust owns the control plane and data
aggregation over time, while Python remains the Playwright scraper runtime.

## Keep In Python

These files drive official Python Playwright browser automation or marketplace
page capture. They should stay Python unless the scraper strategy changes.

- `apps/collector_py/compass.py`
- `apps/collector_py/operations.py`
- `apps/collector_py/channel.py`
- `apps/collector_py/scheduler.py`
- `apps/collector_py/service.py`
- `apps/scraper_py/scraper.py`
- `apps/scraper_py/douyin_orders.py`
- `apps/scraper_py/tmall_msd_orders.py`
- `apps/scraper_py/order_scheduler_run.py`
- `apps/scraper_py/discover_page.py`
- `apps/scraper_py/inspect_switch.py`

## Port To Rust

These files contain API, state, storage, dashboard aggregation, or import logic.
They are good Rust migration candidates.


- `apps/scraper_py/daily_compass.py`, `scheduler_run.py`, and `task_status.py`:
  compatibility shims for older commands; new code uses `apps/collector_py`.
- `apps/legacy_metrics_py/inventory_data.py`: being replaced by
  `crates/inventory`.
- `apps/inventory_py/inventory_sync.py`: keep Python WDT sync for now; move pure
  validation and snapshot writing later.
- `apps/orders_py/external_order_store.py`
- `apps/orders_py/import_external_orders.py`
- `apps/legacy_metrics_py/dashboard.py`
- `apps/legacy_metrics_py/db.py`
- `apps/legacy_metrics_py/auth.py`

## Legacy UI Entrypoints

These are older or alternative UI/utility entrypoints archived outside the
production root. They are retained for reference only and are not part of the
Docker startup path.

- `legacy/streamlit_app.py`
- `legacy/order_dashboard.py`
- `legacy/main.py`

## Current Rust Coverage

- `crates/inventory`: Rust inventory dashboard aggregation.
- `crates/jobs`: Rust task status payload, status-file update, and progress log
  tail.
- `crates/channels`: traffic, product, and search aggregation from allowlisted captures.
- `apps/api-rs`: production Rust dashboard API for authentication, static files,
  operations, orders, inventory, status, raw files, diagnostics, and health.
- `apps/worker-rs`: Rust CLI for inventory/status commands and Python scraper
  subprocess orchestration.
- `crates/orders`: Rust order import read, confirm, delete, and snapshot update
  logic.
- `apps/web`: TypeScript/Vite source for the static dashboard runtime.
