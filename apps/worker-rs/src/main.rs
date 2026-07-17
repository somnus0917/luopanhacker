use std::{
    process::{Command, Stdio},
    time::Instant,
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::{status_payload, try_status_patch, write_task_status};
use luopan_operations::load_operations_records;
use luopan_orders::{commit_preview, delete_batch, public_imports};
use luopan_runtime::RuntimePaths;
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
    /// Run the existing Python scheduler for Playwright compass scraping.
    CompassScrape {
        /// Random delay in seconds before scraping starts.
        #[arg(long, default_value_t = 0)]
        random_delay_seconds: u64,
        /// Login timeout in minutes.
        #[arg(long, default_value_t = 30)]
        login_timeout_minutes: u64,
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
        Commands::CompassScrape {
            random_delay_seconds,
            login_timeout_minutes,
        } => {
            run_python(
                &paths,
                vec![
                    "apps/scraper_py/scheduler_run.py".to_string(),
                    "--random-delay-seconds".to_string(),
                    random_delay_seconds.to_string(),
                    "--login-timeout-minutes".to_string(),
                    login_timeout_minutes.to_string(),
                ],
            )?;
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
    let operations_count = load_operations_records(paths)
        .map(|records| records.len())
        .unwrap_or_default();
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
        }
    })
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
