use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local};
use clap::{Parser, Subcommand};
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::{status_payload, try_status_patch, write_task_status};
use luopan_operations::load_operations_records;
use luopan_orders::{commit_preview, delete_batch, public_imports};
use luopan_runtime::RuntimePaths;
use luopan_settlement::load_settlement_dashboard_for_shop;
use luopan_storage::{connect, migrate, summary, sync_all};

#[derive(Parser)]
#[command(name = "luopan-worker-rs")]
#[command(about = "Rust task runner for the Luopan data center migration")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Print the Rust inventory dashboard payload as JSON.
    InventoryJson,
    /// Print the Rust operations dashboard records as JSON.
    OperationsJson,
    /// Print the Rust order import history payload as JSON.
    OrderImportsJson,
    /// Print the settlement dashboard payload as JSON.
    SettlementJson {
        #[arg(long)]
        shop: Option<String>,
    },
    /// Commit an existing order import preview JSON into the private ledger.
    OrderImportCommit {
        #[arg(long)]
        preview_token: String,
    },
    /// Delete an imported order batch from the private ledger.
    OrderImportDelete {
        #[arg(long)]
        batch_id: String,
    },
    /// Run deployment diagnostics and print a JSON report.
    Doctor,
    /// Create or update the Rust SQLite storage schema.
    StorageMigrate,
    /// Sync JSON-derived dashboard state into Rust SQLite storage.
    StorageSync,
    /// Print Rust SQLite storage row counts as JSON.
    StorageSummary,
    /// Run the existing Python inventory sync script.
    InventorySync {
        /// Only update the latest snapshot; do not write daily history.
        #[arg(long)]
        refresh_only: bool,
    },
    /// Run the independent Playwright Compass collection service.
    #[command(name = "compass-collect", alias = "compass-scrape")]
    CompassCollect {
        /// Random delay in seconds before scraping starts.
        #[arg(long, default_value_t = 0)]
        random_delay_seconds: u64,
        /// Login timeout in minutes.
        #[arg(long, default_value_t = 30)]
        login_timeout_minutes: u64,
        /// Collection module to run. Repeat for multiple modules; default is all.
        #[arg(long = "module", value_parser = ["operations", "channel"])]
        modules: Vec<String>,
        /// Historical business date to backfill (YYYY-MM-DD).
        #[arg(long)]
        date: Option<String>,
        /// Shop to collect. Repeat for multiple shops; default is all configured shops.
        #[arg(long = "shop")]
        shops: Vec<String>,
    },
    /// Print the Rust采集状态 payload as JSON.
    StatusJson {
        /// Include the progress terminal output tail.
        #[arg(long = "no-terminal-output", action = clap::ArgAction::SetFalse, default_value_t = true)]
        terminal_output: bool,
    },
    /// Update the shared task status JSON file.
    StatusUpdate {
        #[arg(long)]
        state: Option<String>,
        #[arg(long)]
        message: Option<String>,
        #[arg(long)]
        last_error: Option<String>,
        /// Additional status field as key=json_value. Repeatable.
        #[arg(long = "field")]
        fields: Vec<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = RuntimePaths::from_env()?;

    match cli.command {
        Commands::InventoryJson => {
            let Some(payload) = load_inventory_dashboard(&paths)? else {
                bail!(
                    "missing inventory snapshot: {}",
                    paths.inventory_snapshot_path().display()
                );
            };
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::OperationsJson => {
            let records = load_operations_records(&paths)?;
            println!("{}", serde_json::to_string(&records)?);
            Ok(())
        }
        Commands::OrderImportsJson => {
            let payload = public_imports(&paths)?;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::SettlementJson { shop } => {
            let payload = load_settlement_dashboard_for_shop(&paths, shop.as_deref())?;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::OrderImportCommit { preview_token } => {
            let payload = commit_preview(&paths, &preview_token)?;
            sync_storage_best_effort(&paths).await;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::OrderImportDelete { batch_id } => {
            let deleted = delete_batch(&paths, &batch_id)?;
            sync_storage_best_effort(&paths).await;
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({ "deleted": deleted }))?
            );
            Ok(())
        }
        Commands::Doctor => {
            let payload = doctor(&paths).await;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::StorageMigrate => {
            let pool = connect(&paths).await?;
            migrate(&pool).await?;
            let payload = summary(&pool).await?.as_json(&paths);
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::StorageSync => {
            let pool = connect(&paths).await?;
            let payload = sync_all(&paths, &pool).await?.as_json(&paths);
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::StorageSummary => {
            let pool = connect(&paths).await?;
            migrate(&pool).await?;
            let payload = summary(&pool).await?.as_json(&paths);
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::InventorySync { refresh_only } => {
            let mut args = vec!["apps/inventory_py/inventory_sync.py".to_string()];
            if refresh_only {
                args.push("--refresh-only".to_string());
            }
            run_python(&paths, args)
        }
        Commands::CompassCollect {
            random_delay_seconds,
            login_timeout_minutes,
            modules,
            date,
            shops,
        } => {
            let mut args = vec![
                "apps/collector_py/scheduler.py".to_string(),
                "--random-delay-seconds".to_string(),
                random_delay_seconds.to_string(),
                "--login-timeout-minutes".to_string(),
                login_timeout_minutes.to_string(),
            ];
            for module in modules {
                args.extend(["--module".to_string(), module]);
            }
            if let Some(date) = date {
                args.extend(["--date".to_string(), date]);
            }
            for shop in shops {
                args.extend(["--shop".to_string(), shop]);
            }
            run_python(&paths, args)?;
            sync_storage_after_scrape(&paths).await
        }
        Commands::StatusJson { terminal_output } => {
            let novnc_url =
                std::env::var("NOVNC_URL").unwrap_or_else(|_| "http://127.0.0.1:6080".to_string());
            let payload = status_payload(&paths, &novnc_url, terminal_output)?;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Commands::StatusUpdate {
            state,
            message,
            last_error,
            fields,
        } => {
            let patch = try_status_patch(state, message, last_error, fields)?;
            if patch.is_empty() {
                bail!("nothing to update; pass --state, --message, --last-error, or --field");
            }
            let payload = write_task_status(&paths, patch)?;
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
    }
}

fn run_python(paths: &RuntimePaths, args: Vec<String>) -> Result<()> {
    let python = std::env::var("LUOPAN_PYTHON").unwrap_or_else(|_| "python3".to_string());
    let started = Instant::now();
    eprintln!("running: {python} {}", args.join(" "));

    let status = Command::new(&python)
        .args(&args)
        .current_dir(&paths.app_dir)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("spawn {python} {}", args.join(" ")))?;

    if !status.success() {
        bail!(
            "command failed with status {status}: {python} {}",
            args.join(" ")
        );
    }

    eprintln!("completed in {:.1}s", started.elapsed().as_secs_f32());
    Ok(())
}

async fn sync_storage_after_scrape(paths: &RuntimePaths) -> Result<()> {
    if !env_bool("STORAGE_SYNC_AFTER_SCRAPE", false) {
        return Ok(());
    }

    eprintln!("syncing SQLite storage after successful scrape");
    sync_storage_best_effort(paths).await;
    Ok(())
}

async fn sync_storage_best_effort(paths: &RuntimePaths) {
    match connect(paths).await {
        Ok(pool) => match sync_all(paths, &pool).await {
            Ok(summary) => match serde_json::to_string(&summary.as_json(paths)) {
                Ok(payload) => eprintln!("{payload}"),
                Err(error) => eprintln!("SQLite storage summary serialization failed: {error:#}"),
            },
            Err(error) => eprintln!("SQLite storage sync failed: {error:#}"),
        },
        Err(error) => eprintln!("SQLite storage connection failed: {error:#}"),
    }
}

async fn doctor(paths: &RuntimePaths) -> serde_json::Value {
    let inventory_exists = paths.inventory_snapshot_path().exists();
    let task_status_exists = paths.task_status_path().exists();
    let progress_log_exists = paths.progress_log_path().exists();
    let operations = load_operations_records(paths).unwrap_or_default();
    let operations_count = operations.len();
    let max_data_age =
        Duration::from_secs(env_u64("LUOPAN_DOCTOR_MAX_DATA_AGE_HOURS", 36) * 60 * 60);
    let operations_freshness = operations_freshness(paths, &operations, max_data_age);
    let storage_freshness = path_freshness(&paths.storage_db_path(), max_data_age);
    let order_imports = public_imports(paths).unwrap_or_else(|error| {
        serde_json::json!({"error": error.to_string(), "summary": {"batches": 0, "orders": 0}})
    });
    let storage = match connect(paths).await {
        Ok(pool) => {
            if let Err(error) = migrate(&pool).await {
                serde_json::json!({"ok": false, "error": error.to_string()})
            } else {
                match summary(&pool).await {
                    Ok(summary) => {
                        serde_json::json!({"ok": true, "summary": summary.as_json(paths)})
                    }
                    Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
                }
            }
        }
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    };
    let status = status_payload(
        paths,
        &std::env::var("NOVNC_URL").unwrap_or_default(),
        false,
    )
    .unwrap_or_else(|error| serde_json::json!({"state": "unknown", "error": error.to_string()}));
    let ok = inventory_exists
        && task_status_exists
        && operations_count > 0
        && operations_freshness
            .get("fresh")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        && storage_freshness
            .get("fresh")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        && storage
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
    serde_json::json!({
        "ok": ok,
        "paths": paths,
        "checks": {
            "inventory_snapshot": inventory_exists,
            "task_status": task_status_exists,
            "progress_log": progress_log_exists,
            "operations_records": operations_count,
            "order_imports": order_imports.get("summary").cloned().unwrap_or_default(),
            "storage": storage,
            "status": status,
        },
        "freshness": {
            "max_data_age_hours": max_data_age.as_secs() / 3600,
            "operations": operations_freshness,
            "storage": storage_freshness,
        }
    })
}

fn operations_freshness(
    paths: &RuntimePaths,
    operations: &[luopan_operations::OperationRecord],
    max_age: Duration,
) -> serde_json::Value {
    let latest_captured_at = operations
        .iter()
        .map(|record| record.captured_at.as_str())
        .filter(|timestamp| !timestamp.is_empty())
        .max()
        .unwrap_or_default();
    let latest_business_date = operations
        .iter()
        .map(|record| record.date.as_str())
        .max()
        .unwrap_or_default();
    let newest_source = operations
        .iter()
        .filter(|record| !record.source_file.is_empty())
        .filter_map(|record| {
            let source_path = PathBuf::from(&record.source_file);
            let source_path = if source_path.is_absolute() {
                source_path
            } else {
                paths.app_dir.join(source_path)
            };
            fs::metadata(&source_path)
                .ok()?
                .modified()
                .ok()
                .map(|modified| (source_path, modified))
        })
        .max_by_key(|(_, modified)| *modified);

    let Some((source_path, modified)) = newest_source else {
        return serde_json::json!({
            "exists": false,
            "fresh": false,
            "records": operations.len(),
            "latest_captured_at": latest_captured_at,
            "latest_business_date": latest_business_date,
        });
    };
    let age = modified.elapsed().unwrap_or_default();
    let modified_at: DateTime<Local> = modified.into();
    serde_json::json!({
        "exists": true,
        "fresh": age <= max_age,
        "source_file": source_path,
        "last_modified": modified_at.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
        "age_seconds": age.as_secs(),
        "records": operations.len(),
        "latest_captured_at": latest_captured_at,
        "latest_business_date": latest_business_date,
    })
}

fn path_freshness(path: &Path, max_age: Duration) -> serde_json::Value {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return serde_json::json!({
                "exists": false,
                "fresh": false,
                "path": path,
                "error": error.to_string(),
            });
        }
    };
    let modified = match metadata.modified() {
        Ok(modified) => modified,
        Err(error) => {
            return serde_json::json!({
                "exists": true,
                "fresh": false,
                "path": path,
                "error": error.to_string(),
            });
        }
    };
    let age = modified.elapsed().unwrap_or_default();
    let modified_at: DateTime<Local> = modified.into();
    serde_json::json!({
        "exists": true,
        "fresh": age <= max_age,
        "path": path,
        "last_modified": modified_at.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
        "age_seconds": age.as_secs(),
    })
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}
