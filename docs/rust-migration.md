# Rust Migration Plan

This repository is moving toward a Rust control plane while preserving the
existing Python Playwright scrapers and noVNC browser environment.

## Current Boundary

- `apps/api-rs`: production Rust dashboard API for authentication, static files,
  health checks, and runtime data.
- `apps/worker-rs`: Rust task runner that calls the existing Python scripts.
- `apps/collector_py`: independent collection service, browser orchestration, and business modules.
- `crates/jobs`: Rust collection status payload, status-file updates, and log tails.
- `crates/channels`: Rust aggregation for traffic, product, and search captures.
- `crates/inventory`: Rust port of the inventory dashboard aggregation logic.
- `crates/operations`: Rust port of daily JSON and external-order dashboard records.
- `crates/orders`: Rust read-only import history payload for uploaded order aggregates.
- `crates/runtime`: shared runtime path discovery and JSON/log file helpers.
- `crates/storage`: SQLx/SQLite schema and sync commands for Rust-owned state.
- Python Playwright scripts remain the source of truth for browser automation.
- `luopan-api-rs` is the production dashboard service and listens on port 8501.

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
cargo run -p luopan-worker-rs -- compass-collect --random-delay-seconds 0
```

The Rust dashboard API listens on `127.0.0.1:8501` in production. Override the
local bind address or port with:

```bash
LUOPAN_API_RS_HOST=0.0.0.0 LUOPAN_API_RS_PORT=8501 cargo run -p luopan-api-rs
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
- `GET /api/collection/status`
- `POST /api/collection/run` (admin only)
- `POST /api/account/password`
- `GET /api/users` (admin only)
- `POST /api/users` (admin only)
- `DELETE /api/users/{username}` (admin only)

These endpoints are served directly by the production Rust dashboard API.
Read endpoints require an authenticated account. Data uploads, order rollback,
manual scraping, and user administration require the `admin` role; `viewer`
accounts are read-only.

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

Vite serves `apps/web/index.html` and proxies `/api` plus `/assets` to the Rust
API on `127.0.0.1:8501`.

## Rust Runtime Model

The Docker image builds `luopan-worker-rs` and `luopan-api-rs` in a Rust builder
stage and copies the release binaries into `/usr/local/bin`. In local
development, command defaults use `cargo run -q -p luopan-worker-rs -- ...`
when the release binary is not on `PATH`.

Docker Compose exposes the Rust-owned production defaults through `.env`:

```bash
LUOPAN_API_RS_HOST=0.0.0.0
LUOPAN_API_RS_PORT=8501
LUOPAN_API_RS_STORAGE_READS=true
COLLECTION_WORKER_COMMAND="luopan-worker-rs compass-collect"
STATUS_UPDATE_COMMAND="luopan-worker-rs status-update"
SCHEDULED_SCRAPE_RUST_WORKER=true
LUOPAN_STORAGE_DB="/app/state/luopan.db"
STORAGE_SYNC_AFTER_SCRAPE=true
```

`luopan-api-rs` is the dashboard supervisor program. Its logs are written to:

```bash
/app/logs/dashboard.log
/app/logs/dashboard.err
```

## Dashboard Boundary

Rust owns browser sessions, authentication, static files, the order Excel preview
upload, and the business data API. Python remains responsible for Playwright
browser automation.

Manual and scheduled Compass collection enters through `luopan-worker-rs
compass-collect`. The dashboard API enqueues module requests, while the separate
`apps/collector_py/service.py` process owns request consumption and heartbeat.
Python still owns Playwright browser automation; Rust owns the API, status,
storage sync, and dashboard aggregation.

`luopan-worker-rs storage-sync` creates the Rust SQLite schema and syncs current
JSON-derived operations records, order-import history, task status, and the
inventory dashboard snapshot into `LUOPAN_STORAGE_DB`. The Rust API can read
operations, order imports, and inventory snapshots from SQLite when
`LUOPAN_API_RS_STORAGE_READS=true`. Empty or failed SQLite reads fall back to
the JSON-derived payloads inside `api-rs`.

When `STORAGE_SYNC_AFTER_SCRAPE=true`, `luopan-worker-rs compass-collect` syncs
SQLite immediately after a successful Python Playwright scrape. The cron wrapper
only runs a separate sync when it directly executes the Python scheduler.

## Completed Porting Steps

- The Rust dashboard API directly serves status, operations, order imports,
  inventory, authentication, and static assets.
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

- Keep Python Playwright/noVNC as the browser automation boundary.

See `docs/python-retention-map.md` for the file-by-file Python retention and
porting map.
