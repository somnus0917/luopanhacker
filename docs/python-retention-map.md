# Python Retention Map

The migration is intentionally hybrid: Rust owns the control plane and data
aggregation over time, while Python remains the Playwright scraper runtime.

## Keep In Python

These files drive official Python Playwright browser automation or marketplace
page capture. They should stay Python unless the scraper strategy changes.

- `daily_compass.py`
- `scraper.py`
- `scheduler_run.py`
- `douyin_orders.py`
- `tmall_msd_orders.py`
- `order_scheduler_run.py`
- `discover_page.py`
- `inspect_switch.py`

## Port To Rust

These files contain API, state, storage, dashboard aggregation, or import logic.
They are good Rust migration candidates.

- `web_app.py`: keep only login/static/proxy shell until the shell itself moves
  to Rust or a standalone frontend host.
- `task_status.py`: thin Python shim that writes through `crates/jobs`.
- `inventory_data.py`: being replaced by `crates/inventory`.
- `inventory_sync.py`: keep Python page/session dependency for now; move pure
  validation and snapshot writing later.
- `external_order_store.py`
- `import_external_orders.py`
- `dashboard.py`
- `db.py`
- `auth.py`

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
- `apps/api-rs`: Rust API sidecar for operations, orders, inventory, status,
  raw files, diagnostics, and health.
- `apps/worker-rs`: Rust CLI for inventory/status commands and Python scraper
  subprocess orchestration.
- `crates/orders`: Rust order import read, confirm, delete, and snapshot update
  logic.
- `apps/web`: TypeScript/Vite source for the static dashboard runtime.
