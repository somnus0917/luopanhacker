use anyhow::{Context, Result};
use chrono::Local;
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::status_payload;
use luopan_operations::{OperationRecord, load_operations_records};
use luopan_orders::public_imports;
use luopan_runtime::RuntimePaths;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

pub type StoragePool = SqlitePool;

pub async fn connect(paths: &RuntimePaths) -> Result<SqlitePool> {
    if let Some(parent) = paths.storage_db_path().parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let url = format!("sqlite://{}?mode=rwc", paths.storage_db_path().display());
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .with_context(|| format!("connect {}", paths.storage_db_path().display()))
}

pub async fn migrate(pool: &SqlitePool) -> Result<()> {
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(pool)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_kv (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS operation_records (
            shop_id TEXT NOT NULL,
            date TEXT NOT NULL,
            shop_name TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            content_json TEXT NOT NULL,
            trend_json TEXT NOT NULL,
            source TEXT NOT NULL,
            source_key TEXT,
            source_label TEXT,
            source_file TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (shop_id, date)
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_operation_records_date_shop
        ON operation_records(date, shop_name)
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS order_import_batches (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer',
            created_at TEXT NOT NULL,
            password_changed_at TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn sync_all(paths: &RuntimePaths, pool: &SqlitePool) -> Result<StorageSummary> {
    migrate(pool).await?;
    let operations = load_operations_records(paths)?;
    sync_operations(pool, &operations).await?;

    let order_imports = public_imports(paths)?;
    sync_order_imports(pool, &order_imports).await?;

    let status = status_payload(paths, "", false)?;
    upsert_kv(pool, "task_status", &status).await?;

    let inventory = load_inventory_dashboard(paths)?;
    if let Some(inventory) = inventory {
        upsert_kv(pool, "inventory_dashboard", &inventory).await?;
    }

    summary(pool).await
}

pub async fn sync_operations(pool: &SqlitePool, records: &[OperationRecord]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }

    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM operation_records")
        .execute(&mut *transaction)
        .await?;
    let updated_at = now();
    for record in records {
        sqlx::query(
            r#"
            INSERT INTO operation_records (
                shop_id, date, shop_name, captured_at, metrics_json, content_json,
                trend_json, source, source_key, source_label, source_file, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(shop_id, date) DO UPDATE SET
                shop_name = excluded.shop_name,
                captured_at = excluded.captured_at,
                metrics_json = excluded.metrics_json,
                content_json = excluded.content_json,
                trend_json = excluded.trend_json,
                source = excluded.source,
                source_key = excluded.source_key,
                source_label = excluded.source_label,
                source_file = excluded.source_file,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.shop_id)
        .bind(&record.date)
        .bind(&record.shop_name)
        .bind(&record.captured_at)
        .bind(serde_json::to_string(&record.metrics)?)
        .bind(serde_json::to_string(&record.content)?)
        .bind(serde_json::to_string(&record.trend)?)
        .bind(&record.source)
        .bind(&record.source_key)
        .bind(&record.source_label)
        .bind(&record.source_file)
        .bind(&updated_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

pub async fn sync_order_imports(pool: &SqlitePool, payload: &Value) -> Result<()> {
    let batches = payload
        .get("batches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let updated_at = now();
    if batches.is_empty() {
        upsert_kv(pool, "order_imports_public", payload).await?;
        return Ok(());
    }

    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM order_import_batches")
        .execute(&mut *transaction)
        .await?;
    for batch in batches {
        let id = batch
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let created_at = batch
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        sqlx::query(
            r#"
            INSERT INTO order_import_batches (id, created_at, payload_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                created_at = excluded.created_at,
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(created_at)
        .bind(serde_json::to_string(&batch)?)
        .bind(&updated_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    upsert_kv(pool, "order_imports_public", payload).await?;
    Ok(())
}

pub async fn upsert_kv(pool: &SqlitePool, key: &str, value: &Value) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO app_kv (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(serde_json::to_string(value)?)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn summary(pool: &SqlitePool) -> Result<StorageSummary> {
    let operations = scalar_count(pool, "SELECT COUNT(*) FROM operation_records").await?;
    let order_batches = scalar_count(pool, "SELECT COUNT(*) FROM order_import_batches").await?;
    let kv_entries = scalar_count(pool, "SELECT COUNT(*) FROM app_kv").await?;
    Ok(StorageSummary {
        operations,
        order_batches,
        kv_entries,
    })
}

pub async fn load_operations_records_from_db(pool: &SqlitePool) -> Result<Vec<OperationRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT
            shop_id, date, shop_name, captured_at, metrics_json, content_json,
            trend_json, source, source_key, source_label, source_file
        FROM operation_records
        ORDER BY date, shop_name
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        records.push(OperationRecord {
            shop_id: row.get("shop_id"),
            shop_name: row.get("shop_name"),
            date: row.get("date"),
            captured_at: row.get("captured_at"),
            metrics: serde_json::from_str(row.get::<String, _>("metrics_json").as_str())?,
            content: serde_json::from_str(row.get::<String, _>("content_json").as_str())?,
            trend: serde_json::from_str(row.get::<String, _>("trend_json").as_str())?,
            source: row.get("source"),
            source_key: row.get("source_key"),
            source_label: row.get("source_label"),
            source_file: row.get("source_file"),
        });
    }
    Ok(records)
}

pub async fn kv_value(pool: &SqlitePool, key: &str) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT value_json FROM app_kv WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let value_json: String = row.get("value_json");
    Ok(Some(serde_json::from_str(&value_json)?))
}

pub async fn public_imports_from_db(pool: &SqlitePool) -> Result<Option<Value>> {
    kv_value(pool, "order_imports_public").await
}

async fn scalar_count(pool: &SqlitePool, sql: &str) -> Result<i64> {
    let row = sqlx::query(sql).fetch_one(pool).await?;
    Ok(row.get::<i64, _>(0))
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StorageSummary {
    pub operations: i64,
    pub order_batches: i64,
    pub kv_entries: i64,
}

impl StorageSummary {
    pub fn as_json(&self, paths: &RuntimePaths) -> Value {
        json!({
            "db_path": paths.storage_db_path(),
            "operations": self.operations,
            "order_batches": self.order_batches,
            "kv_entries": self.kv_entries,
        })
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    #[tokio::test]
    async fn migrates_empty_database() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate(&pool).await.unwrap();
        let summary = summary(&pool).await.unwrap();
        assert_eq!(summary.operations, 0);
        assert_eq!(summary.order_batches, 0);
        assert_eq!(summary.kv_entries, 0);
    }

    #[tokio::test]
    async fn reads_synced_operations_and_kv_payloads() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate(&pool).await.unwrap();

        let record = OperationRecord {
            shop_id: "shop-1".to_string(),
            shop_name: "测试店铺".to_string(),
            date: "2026-07-18".to_string(),
            captured_at: "2026-07-18T10:00:00".to_string(),
            metrics: serde_json::Map::from_iter([("pay_amt".to_string(), json!(123.0))]),
            content: serde_json::Map::new(),
            trend: serde_json::Map::new(),
            source: "daily_json".to_string(),
            source_key: None,
            source_label: None,
            source_file: "/tmp/source.json".to_string(),
        };
        sync_operations(&pool, &[record]).await.unwrap();
        upsert_kv(
            &pool,
            "order_imports_public",
            &json!({"summary": {"orders": 3}}),
        )
        .await
        .unwrap();

        let records = load_operations_records_from_db(&pool).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].metrics["pay_amt"], json!(123.0));

        let imports = public_imports_from_db(&pool).await.unwrap().unwrap();
        assert_eq!(imports["summary"]["orders"], json!(3));
    }

    #[tokio::test]
    async fn replaces_previous_operation_and_order_sets() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate(&pool).await.unwrap();

        let first = OperationRecord {
            shop_id: "old-shop".to_string(),
            shop_name: "旧店铺".to_string(),
            date: "2026-07-17".to_string(),
            captured_at: "2026-07-17T10:00:00".to_string(),
            metrics: serde_json::Map::from_iter([("pay_amt".to_string(), json!(1.0))]),
            content: serde_json::Map::new(),
            trend: serde_json::Map::new(),
            source: "daily_json".to_string(),
            source_key: None,
            source_label: None,
            source_file: "/tmp/old.json".to_string(),
        };
        let second = OperationRecord {
            shop_id: "new-shop".to_string(),
            shop_name: "新店铺".to_string(),
            date: "2026-07-18".to_string(),
            captured_at: "2026-07-18T10:00:00".to_string(),
            metrics: serde_json::Map::from_iter([("pay_amt".to_string(), json!(2.0))]),
            content: serde_json::Map::new(),
            trend: serde_json::Map::new(),
            source: "daily_json".to_string(),
            source_key: None,
            source_label: None,
            source_file: "/tmp/new.json".to_string(),
        };

        sync_operations(&pool, &[first]).await.unwrap();
        sync_operations(&pool, &[second]).await.unwrap();
        let records = load_operations_records_from_db(&pool).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].shop_id, "new-shop");

        sync_order_imports(
            &pool,
            &json!({"batches": [{"id": "old", "created_at": "2026-07-17"}], "summary": {"batches": 1}}),
        )
        .await
        .unwrap();
        sync_order_imports(
            &pool,
            &json!({"batches": [{"id": "new", "created_at": "2026-07-18"}], "summary": {"batches": 1}}),
        )
        .await
        .unwrap();
        let order_batches = scalar_count(&pool, "SELECT COUNT(*) FROM order_import_batches")
            .await
            .unwrap();
        assert_eq!(order_batches, 1);
    }
}
