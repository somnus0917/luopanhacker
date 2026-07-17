# Rust Migration Plan

This repository is moving toward a Rust control plane while preserving the
existing Python Playwright scrapers and noVNC browser environment.

## Current Boundary

- `apps/api-rs`: Rust sidecar API for health checks and runtime file reads.
- `apps/worker-rs`: Rust task runner that calls the existing Python scripts.
- `crates/jobs`: Rust采集状态 payload, status-file updates, and log tails.
- `crates/inventory`: Rust port of the inventory dashboard aggregation logic.
- `crates/operations`: Rust port of daily JSON and external-order dashboard records.
- `crates/orders`: Rust read-only import history payload for uploaded order aggregates.
- `crates/runtime`: shared runtime path discovery and JSON/log file helpers.
- `crates/storage`: SQLx/SQLite schema and sync commands for Rust-owned state.
- Python Playwright scripts remain the source of truth for browser automation.
- Flask remains the production dashboard until individual endpoints are ported.

## Why This Shape

Playwright has official Python support and this project depends on headed
Chromium plus noVNC for operational access. The migration therefore keeps
browser automation in Python and moves lower-risk orchestration, state, API,
and storage responsibilities into Rust first.

## Local Commands

```bash
cargo check --workspace
cargo run -p luopan-api-rs
cargo run -p luopan-worker-rs -- inventory-json
cargo run -p luopan-worker-rs -- operations-json
cargo run -p luopan-worker-rs -- order-imports-json
cargo run -p luopan-worker-rs -- order-import-commit --preview-token <token>
cargo run -p luopan-worker-rs -- order-import-delete --batch-id <batch-id>
cargo run -p luopan-worker-rs -- status-json --no-terminal-output
cargo run -p luopan-worker-rs -- status-update --state running --message "manual check"
cargo run -p luopan-worker-rs -- storage-migrate
cargo run -p luopan-worker-rs -- storage-sync
cargo run -p luopan-worker-rs -- storage-summary
cargo run -p luopan-worker-rs -- doctor
cargo run -p luopan-worker-rs -- inventory-sync --refresh-only
cargo run -p luopan-worker-rs -- compass-scrape --random-delay-seconds 0
```

The Rust API listens on `127.0.0.1:8601` by default. Override with:

```bash
LUOPAN_API_RS_HOST=0.0.0.0 LUOPAN_API_RS_PORT=8601 cargo run -p luopan-api-rs
```

## Initial Endpoints

- `GET /healthz`
- `GET /api/runtime/paths`
- `GET /api/compass`
- `GET /api/inventory`
- `GET /api/inventory/raw`
- `GET /api/orders/imports`
- `POST /api/orders/imports`
- `DELETE /api/orders/imports/{batch_id}`
- `GET /api/diagnostics`
- `GET /api/storage/summary`
- `GET /api/status`
- `GET /api/status/raw`
- `GET /api/status/log-tail`

These are intentionally sidecar endpoints, not drop-in replacements for the
existing Flask API yet.

## Frontend

The dashboard frontend runtime is served from `web/static`. Its TypeScript
source lives in `apps/web/src/main.ts`; `web/static/app.js` is committed as the
runtime artifact so Docker does not need Node.js for production builds.

```bash
cd apps/web
pnpm install
pnpm build
pnpm dev
```

Vite serves `apps/web/index.html` and proxies `/api` plus `/assets` to Flask on
`127.0.0.1:8501`.

## Rust Runtime Model

The Docker image builds `luopan-worker-rs` and `luopan-api-rs` in a Rust builder
stage and copies the release binaries into `/usr/local/bin`. In local
development, command defaults use `cargo run -q -p luopan-worker-rs -- ...`
when the release binary is not on `PATH`.

Docker Compose exposes the Rust-owned production defaults through `.env`:

```bash
LUOPAN_API_RS_ENABLED=true
LUOPAN_API_RS_HOST=0.0.0.0
LUOPAN_API_RS_PORT=8601
LUOPAN_API_RS_STORAGE_READS=true
RUST_API_BASE_URL="http://127.0.0.1:8601"
RUST_API_TIMEOUT=2
MANUAL_SCRAPE_COMMAND="luopan-worker-rs compass-scrape"
STATUS_UPDATE_COMMAND="luopan-worker-rs status-update"
SCHEDULED_SCRAPE_RUST_WORKER=true
LUOPAN_STORAGE_DB="/app/state/luopan.db"
STORAGE_SYNC_AFTER_SCRAPE=true
```

`luopan-api-rs` is registered in supervisor but stays dormant unless
`LUOPAN_API_RS_ENABLED=true`. Its logs are written to:

```bash
/app/logs/rust-api-rs.log
/app/logs/rust-api-rs.err
```

## Flask-To-Rust Boundary

Flask owns browser sessions, authentication, static files, and the order Excel
preview upload. Business data APIs are required to come from `api-rs`:

- `/api/compass`
- `/api/orders/imports`
- `/api/orders/imports/<batch_id>`
- `/api/status`
- `/api/inventory`

If `api-rs` is unavailable, Flask returns HTTP 502 instead of reading the legacy
Python JSON sources. Order Excel preview parsing stays in Python until it is
ported to Rust.

Manual and scheduled compass scraping can also enter through `luopan-worker-rs
compass-scrape`. Rust owns the task entrypoint and the shared task-status
writer used by `apps/scraper_py/task_status.py`; Python still owns the
Playwright browser automation.

`luopan-worker-rs storage-sync` creates the Rust SQLite schema and syncs current
JSON-derived operations records, order-import history, task status, and the
inventory dashboard snapshot into `LUOPAN_STORAGE_DB`. The Rust API can read
operations, order imports, and inventory snapshots from SQLite when
`LUOPAN_API_RS_STORAGE_READS=true`. Empty or failed SQLite reads are handled
inside `api-rs`, not by Flask.

When `STORAGE_SYNC_AFTER_SCRAPE=true`, `luopan-worker-rs compass-scrape` syncs
SQLite immediately after a successful Python Playwright scrape. The cron wrapper
only runs a separate sync when it directly executes the Python scheduler.

## Completed Porting Steps

- Flask now requires Rust API reads for status, operations, order imports, and
  inventory; there is no Flask Python data fallback.
- `LUOPAN_API_RS_STORAGE_READS=true` is the default. SQLite reads fall back to
  JSON-derived payloads when the DB is empty or unavailable.
- `STORAGE_SYNC_AFTER_SCRAPE=true` is the default, so Rust worker scrapes sync
  SQLite after successful Python Playwright collection.
- The frontend now has a TypeScript source tree under `apps/web`.
- Vite local development is available under `apps/web`.
- `luopan-worker-rs doctor` and `GET /api/diagnostics` provide deployment
  health checks.
- Order import confirm/delete now have Rust worker/API implementations.
- Legacy generated `dashboard.html` is no longer part of the production path.

## Remaining Optional Work

- Replace the Flask-authenticated static shell with a standalone Vite dev
  server for local frontend iteration.
- Move order Excel preview parsing into Rust.
- Keep Python Playwright/noVNC as the browser automation boundary.

See `docs/python-retention-map.md` for the file-by-file Python retention and
porting map.
