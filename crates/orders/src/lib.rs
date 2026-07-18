use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Cursor,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use calamine::{Data, DataType, Reader, Xlsx};
use chrono::{Duration, Local, NaiveDate, NaiveDateTime};
use fs2::FileExt;
use hmac::{Hmac, Mac};
use luopan_runtime::{RuntimePaths, read_json_file};
use rand_core::{OsRng, RngCore};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const PREVIEW_TTL_ERROR: &str = "导入预览已过期，请重新选择文件";
const MAX_FILES_PER_UPLOAD: usize = 10;
const PREVIEW_TTL_MINUTES: i64 = 15;
const CLOSED_STATUS_WORDS: [&str; 4] = ["关闭", "取消", "作废", "退款"];

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct UploadedWorkbook {
    pub filename: String,
    pub content: Vec<u8>,
}

struct SourceConfig {
    filename_match: &'static str,
    key: &'static str,
    label: &'static str,
    status_columns: &'static [&'static str],
    shop_columns: &'static [&'static str],
    quantity_columns: &'static [&'static str],
    order_id_columns: &'static [&'static str],
}

const SOURCE_CONFIGS: [SourceConfig; 3] = [
    SourceConfig {
        filename_match: "喵速达",
        key: "miaosuda",
        label: "订单明细 · 喵速达",
        status_columns: &["订单状态", "状态"],
        shop_columns: &["店铺名称"],
        quantity_columns: &["商品数量", "订货数量", "实发数量"],
        order_id_columns: &["外部订单号", "交易订单号", "系统单号"],
    },
    SourceConfig {
        filename_match: "天猫国际",
        key: "tmall_global",
        label: "订单明细 · 天猫国际",
        status_columns: &["订单状态", "状态"],
        shop_columns: &["店铺名称"],
        quantity_columns: &["商品数量", "订货数量", "实发数量"],
        order_id_columns: &["外部订单号", "交易订单号", "系统单号"],
    },
    SourceConfig {
        filename_match: "天猫优品",
        key: "tmall_youpin",
        label: "订单明细 · 天猫优品",
        status_columns: &["状态", "订单状态"],
        shop_columns: &["分销商店铺名称", "店铺名称"],
        quantity_columns: &["订货数量", "商品数量", "实发数量"],
        order_id_columns: &["外部订单号", "交易订单号", "系统单号"],
    },
];

/// Parse uploaded `.xlsx` files and persist a preview in the exact JSON shape
/// consumed by `commit_preview` and the existing dashboard.
pub fn preview_upload(paths: &RuntimePaths, files: Vec<UploadedWorkbook>) -> Result<Value> {
    if files.is_empty() {
        bail!("请选择至少一个订单明细文件");
    }
    if files.len() > MAX_FILES_PER_UPLOAD {
        bail!("单次最多上传 {MAX_FILES_PER_UPLOAD} 个文件");
    }

    let _guard = LedgerGuard::lock(paths)?;
    let ledger = load_ledger(paths)?;
    let known_file_hashes = known_file_hashes(&ledger);
    let known_order_hashes = known_order_hashes(&ledger);
    drop(_guard);

    let mut preview_orders = Vec::new();
    let mut file_rows = Vec::new();
    let mut candidate_hashes = BTreeSet::new();
    for file in files {
        let filename = safe_filename(&file.filename)?;
        if file.content.is_empty() {
            bail!("{filename} 是空文件");
        }
        let file_hash = format!("{:x}", Sha256::digest(&file.content));
        let (orders, metadata) = parse_workbook_orders(&filename, &file.content)
            .map_err(|error| anyhow!("{filename} 解析失败：{error}"))?;
        let source_key = metadata["source_key"].as_str().unwrap_or_default();
        let source_label = metadata["source_label"].as_str().unwrap_or_default();
        let known_file = known_file_hashes.contains(&file_hash);
        let mut row = json!({
            "file_name": filename,
            "file_hash": file_hash,
            "source_key": source_key,
            "source_label": source_label,
            "input_rows": metadata["input_rows"],
            "accepted_order_rows": metadata["accepted_order_rows"],
            "accepted_orders": metadata["accepted_orders"],
            "added_orders": 0,
            "duplicate_orders": 0,
            "known_file": known_file,
        });
        if known_file {
            row["duplicate_orders"] = json!(orders.len());
            file_rows.push(row);
            continue;
        }
        for order in orders {
            let digest = order_digest(paths, order["order_id"].as_str().unwrap_or_default())?;
            if known_order_hashes.contains(&digest) || !candidate_hashes.insert(digest.clone()) {
                row["duplicate_orders"] = json!(row["duplicate_orders"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            preview_orders.push(json!({
                "order_key": digest,
                "date": order["date"],
                "shop_name": order["shop_name"],
                "amount_cent": order["amount_cent"],
                "quantity": order["quantity"],
                "source": "external_orders",
                "source_key": order["source_key"],
                "source_label": order["source_label"],
            }));
            row["added_orders"] = json!(row["added_orders"].as_i64().unwrap_or(0) + 1);
        }
        file_rows.push(row);
    }

    let token = preview_token();
    let created_at = Local::now();
    let preview = json!({
        "token": token,
        "created_at": created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        "expires_at": (created_at + Duration::minutes(PREVIEW_TTL_MINUTES)).format("%Y-%m-%dT%H:%M:%S").to_string(),
        "files": file_rows,
        "orders": preview_orders,
    });
    atomic_write(
        &preview_path(paths, preview["token"].as_str().expect("token")),
        &preview,
    )?;
    Ok(preview_public(&preview))
}

fn parse_workbook_orders(filename: &str, content: &[u8]) -> Result<(Vec<Value>, Value)> {
    let config = source_config(filename)?;
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(content)).context("读取 Excel 工作簿")?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| anyhow!("工作簿没有工作表"))??;
    let mut rows = range.rows();
    let headers: Vec<String> = rows.next().unwrap_or(&[]).iter().map(cell_text).collect();
    let status_col = first_available(&headers, config.status_columns, "订单状态")?;
    let shop_col = first_available(&headers, config.shop_columns, "店铺")?;
    let quantity_col = first_available(&headers, config.quantity_columns, "商品数量")?;
    let order_id_col = first_available(&headers, config.order_id_columns, "订单号")?;
    let paid_at_col = required_column(&headers, "支付时间", filename)?;
    let amount_col = required_column(&headers, "订单金额", filename)?;

    let input_rows = rows.len();
    let mut accepted_rows = Vec::new();
    for (index, row) in rows.enumerate() {
        let value = |column: usize| row.get(column).unwrap_or(&Data::Empty);
        let Some(date) = parse_date(value(paid_at_col)) else {
            continue;
        };
        let status = cell_text(value(status_col));
        let shop = cell_text(value(shop_col)).trim().to_string();
        if shop.is_empty() || CLOSED_STATUS_WORDS.iter().any(|word| status.contains(word)) {
            continue;
        }
        let mut order_id = cell_text(value(order_id_col)).trim().to_string();
        if order_id.is_empty() {
            // pandas assigns the original frame index, not the accepted-row index.
            order_id = format!("row-{index}");
        }
        accepted_rows.push((
            date,
            shop,
            order_id,
            number(value(amount_col)),
            number(value(quantity_col)),
        ));
    }
    let accepted_order_rows = accepted_rows.len();
    // pandas sorts by paid_at and keeps the first amount while summing quantities.
    accepted_rows.sort_by_key(|row| row.0);
    let mut deduplicated: BTreeMap<(String, String, String), (f64, f64)> = BTreeMap::new();
    for (date, shop, order_id, amount, quantity) in accepted_rows {
        let key = (date.format("%Y-%m-%d").to_string(), shop, order_id);
        let entry = deduplicated.entry(key).or_insert((amount, 0.0));
        entry.1 += quantity;
    }
    let orders: Vec<Value> = deduplicated
        .into_iter()
        .map(|((date, shop_name, order_id), (amount_yuan, quantity))| {
            json!({
                "date": date,
                "shop_name": shop_name,
                "order_id": order_id,
                "amount_cent": (amount_yuan * 100.0 * 100.0).round() / 100.0,
                "quantity": quantity as i64,
                "source_key": config.key,
                "source_label": config.label,
                "source_file": filename,
            })
        })
        .collect();
    let daily_records = orders
        .iter()
        .filter_map(|order| Some((order["date"].as_str()?, order["shop_name"].as_str()?)))
        .collect::<BTreeSet<_>>()
        .len();
    Ok((
        orders.clone(),
        json!({
            "source_key": config.key,
            "source_label": config.label,
            "source_file": filename,
            "input_rows": input_rows,
            "accepted_order_rows": accepted_order_rows,
            "accepted_orders": orders.len(),
            "daily_records": daily_records,
        }),
    ))
}

fn safe_filename(filename: &str) -> Result<String> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".xlsx") {
        bail!("仅支持 .xlsx 格式的订单明细文件");
    }
    Ok(name.to_string())
}

fn source_config(filename: &str) -> Result<&'static SourceConfig> {
    SOURCE_CONFIGS
        .iter()
        .find(|config| filename.contains(config.filename_match))
        .ok_or_else(|| anyhow!("无法识别订单来源文件：{filename}"))
}

fn first_available(headers: &[String], candidates: &[&str], label: &str) -> Result<usize> {
    candidates
        .iter()
        .find_map(|candidate| headers.iter().position(|header| header == candidate))
        .ok_or_else(|| anyhow!("缺少{label}列，可用列：{}", headers.join(", ")))
}

fn required_column(headers: &[String], name: &str, filename: &str) -> Result<usize> {
    headers
        .iter()
        .position(|header| header == name)
        .ok_or_else(|| anyhow!("{filename} 缺少{name}列"))
}

fn cell_text(cell: &Data) -> String {
    cell.to_string()
}

fn number(cell: &Data) -> f64 {
    cell_text(cell).trim().parse::<f64>().unwrap_or(0.0)
}

fn parse_date(cell: &Data) -> Option<NaiveDate> {
    cell.as_datetime().map(|date| date.date()).or_else(|| {
        let value = cell_text(cell);
        [
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d",
            "%Y/%m/%d %H:%M:%S",
            "%Y/%m/%d",
        ]
        .iter()
        .find_map(|format| {
            NaiveDateTime::parse_from_str(&value, format)
                .ok()
                .map(|date| date.date())
                .or_else(|| NaiveDate::parse_from_str(&value, format).ok())
        })
    })
}

fn known_order_hashes(ledger: &Value) -> BTreeSet<String> {
    ledger
        .get("orders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|order| order.get("order_key").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn known_file_hashes(ledger: &Value) -> BTreeSet<String> {
    ledger
        .get("batches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|batch| {
            batch
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|file| file.get("file_hash").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn order_digest(paths: &RuntimePaths, order_id: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(&dedupe_secret(paths)?)
        .expect("HMAC accepts arbitrary key length");
    mac.update(order_id.trim().to_uppercase().as_bytes());
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn dedupe_secret(paths: &RuntimePaths) -> Result<Vec<u8>> {
    let path = paths.config_dir.join("import_dedupe_secret.txt");
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.as_bytes().to_vec());
        }
    }
    fs::create_dir_all(&paths.config_dir)?;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fs::write(path, &secret)?;
    Ok(secret.into_bytes())
}

fn preview_token() -> String {
    let mut bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn preview_public(preview: &Value) -> Value {
    let orders = preview
        .get("orders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let dates = orders
        .iter()
        .filter_map(|order| order.get("date").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let source_labels = orders
        .iter()
        .filter_map(|order| order.get("source_label").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let files = preview.get("files").cloned().unwrap_or_else(|| json!([]));
    let duplicates = files
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file.get("duplicate_orders").and_then(Value::as_i64))
        .sum::<i64>();
    Ok::<Value, anyhow::Error>(json!({
        "preview_token": preview["token"],
        "expires_at": preview["expires_at"],
        "files": files,
        "summary": {
            "added_orders": orders.len(),
            "duplicate_orders": duplicates,
            "pay_amt": orders.iter().filter_map(|order| order.get("amount_cent").and_then(Value::as_f64)).sum::<f64>(),
            "pay_item_cnt": orders.iter().filter_map(|order| order.get("quantity").and_then(Value::as_i64)).sum::<i64>(),
            "date_range": if dates.is_empty() { json!([]) } else { json!([dates.first(), dates.last()]) },
            "source_labels": source_labels,
        }
    })).expect("JSON construction")
}

pub fn public_imports(paths: &RuntimePaths) -> Result<Value> {
    let path = ledger_path(paths);
    let Some(ledger) = read_json_file(&path)? else {
        return Ok(empty_imports());
    };
    let Some(ledger) = ledger.as_object() else {
        return Ok(empty_imports());
    };
    let Some(batches) = ledger.get("batches").and_then(Value::as_array) else {
        return Ok(empty_imports());
    };
    let Some(orders) = ledger.get("orders").and_then(Value::as_array) else {
        return Ok(empty_imports());
    };

    let public_batches: Vec<Value> = batches.iter().rev().map(batch_public).collect();
    let pay_amt = orders
        .iter()
        .filter_map(|order| order.get("amount_cent").and_then(Value::as_f64))
        .sum::<f64>();
    let pay_item_cnt = orders
        .iter()
        .filter_map(|order| order.get("quantity").and_then(Value::as_i64))
        .sum::<i64>();

    Ok(json!({
        "batches": public_batches,
        "summary": {
            "batches": batches.len(),
            "orders": orders.len(),
            "pay_amt": pay_amt,
            "pay_item_cnt": pay_item_cnt,
        }
    }))
}

pub fn commit_preview(paths: &RuntimePaths, token: &str) -> Result<Value> {
    let token = safe_token(token)?;
    let preview_path = preview_path(paths, token);
    let _guard = LedgerGuard::lock(paths)?;

    let preview = read_json_file(&preview_path)?
        .ok_or_else(|| anyhow!("导入预览不存在或已失效，请重新选择文件"))?;
    if preview.get("token").and_then(Value::as_str) != Some(token) {
        bail!("导入预览不存在或已失效，请重新选择文件");
    }
    let expires_at = preview
        .get("expires_at")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!(PREVIEW_TTL_ERROR))?;
    if expires_at < now_iso().as_str() {
        let _ = fs::remove_file(&preview_path);
        bail!(PREVIEW_TTL_ERROR);
    }

    let mut ledger = load_ledger(paths)?;
    let known_hashes: BTreeSet<String> = ledger
        .get("orders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|order| order.get("order_key").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let known_files: BTreeSet<String> = ledger
        .get("batches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|batch| {
            batch
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|file| file.get("file_hash").and_then(Value::as_str))
        .map(str::to_string)
        .collect();

    let preview_orders = preview
        .get("orders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut new_orders: Vec<Value> = preview_orders
        .iter()
        .filter(|order| {
            order
                .get("order_key")
                .and_then(Value::as_str)
                .is_some_and(|key| !known_hashes.contains(key))
        })
        .cloned()
        .collect();
    let files: Vec<Value> = preview
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let mut current = item.as_object().cloned().unwrap_or_default();
            let known_file = current
                .get("file_hash")
                .and_then(Value::as_str)
                .is_some_and(|hash| known_files.contains(hash));
            if known_file {
                current.insert("added_orders".to_string(), json!(0));
                current.insert("known_file".to_string(), json!(true));
            }
            Value::Object(current)
        })
        .collect();
    if new_orders.is_empty() {
        bail!("没有可新增的数据：文件或订单已导入");
    }

    let batch_id = format!(
        "imp_{}_{}",
        Local::now().format("%Y%m%d_%H%M%S"),
        token.chars().rev().take(8).collect::<String>()
    );
    for order in &mut new_orders {
        if let Some(object) = order.as_object_mut() {
            object.insert("batch_id".to_string(), json!(batch_id));
        }
    }
    let dates: Vec<String> = new_orders
        .iter()
        .filter_map(|order| order.get("date").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let source_labels: Vec<String> = new_orders
        .iter()
        .filter_map(|order| order.get("source_label").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let duplicate_orders = files
        .iter()
        .filter_map(|file| file.get("duplicate_orders").and_then(Value::as_i64))
        .sum::<i64>()
        + (preview_orders.len().saturating_sub(new_orders.len())) as i64;
    let batch = json!({
        "id": batch_id,
        "created_at": now_iso(),
        "files": files,
        "source_labels": source_labels,
        "added_orders": new_orders.len(),
        "duplicate_orders": duplicate_orders,
        "date_range": [dates.first().cloned().unwrap_or_default(), dates.last().cloned().unwrap_or_default()],
        "pay_amt": new_orders.iter().filter_map(|order| order.get("amount_cent").and_then(Value::as_f64)).sum::<f64>(),
        "pay_item_cnt": new_orders.iter().filter_map(|order| order.get("quantity").and_then(Value::as_i64)).sum::<i64>(),
    });

    ledger
        .get_mut("batches")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("invalid ledger batches"))?
        .push(batch.clone());
    ledger
        .get_mut("orders")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("invalid ledger orders"))?
        .extend(new_orders.clone());

    atomic_write(&ledger_path(paths), &ledger)?;
    write_snapshot(paths, &ledger)?;
    let _ = fs::remove_file(preview_path);
    Ok(json!({
        "batch": batch_public(&batch),
        "records": daily_records_from_orders(&new_orders).len(),
    }))
}

pub fn delete_batch(paths: &RuntimePaths, batch_id: &str) -> Result<Value> {
    let _guard = LedgerGuard::lock(paths)?;
    let mut ledger = load_ledger(paths)?;
    let batches = ledger
        .get("batches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(batch) = batches
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(batch_id))
        .cloned()
    else {
        bail!("未找到该导入批次");
    };
    let next_batches: Vec<Value> = batches
        .into_iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(batch_id))
        .collect();
    let next_orders: Vec<Value> = ledger
        .get("orders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("batch_id").and_then(Value::as_str) != Some(batch_id))
        .collect();
    ledger["batches"] = Value::Array(next_batches);
    ledger["orders"] = Value::Array(next_orders);
    atomic_write(&ledger_path(paths), &ledger)?;
    write_snapshot(paths, &ledger)?;
    Ok(batch_public(&batch))
}

pub fn daily_records_from_orders(orders: &[Value]) -> Vec<Value> {
    let mut summary: BTreeMap<(String, String, String), Value> = BTreeMap::new();
    for order in orders {
        let date = string_field(order, "date");
        let shop_name = string_field(order, "shop_name");
        let source_key = string_field(order, "source_key");
        if date.is_empty() || shop_name.is_empty() || source_key.is_empty() {
            continue;
        }
        let key = (date.clone(), shop_name.clone(), source_key.clone());
        let item = summary.entry(key).or_insert_with(|| {
            json!({
                "shop_id": format!("external:{source_key}:{shop_name}"),
                "shop_name": shop_name,
                "date": date,
                "metrics": {"income_amt": 0.0, "pay_amt": 0.0, "pay_cnt": 0, "pay_item_cnt": 0},
                "content": {},
                "trend": {},
                "source": "external_orders",
                "source_key": source_key,
                "source_label": string_field(order, "source_label"),
                "source_file": string_field(order, "source_file"),
            })
        });
        let metrics = item
            .get_mut("metrics")
            .and_then(Value::as_object_mut)
            .expect("metrics object");
        add_number(
            metrics,
            "income_amt",
            order
                .get("amount_cent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
        add_number(
            metrics,
            "pay_amt",
            order
                .get("amount_cent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
        add_number(metrics, "pay_cnt", 1.0);
        add_number(
            metrics,
            "pay_item_cnt",
            order.get("quantity").and_then(Value::as_f64).unwrap_or(0.0),
        );
    }
    summary.into_values().collect()
}

fn empty_imports() -> Value {
    json!({
        "batches": [],
        "summary": {
            "batches": 0,
            "orders": 0,
            "pay_amt": 0.0,
            "pay_item_cnt": 0,
        }
    })
}

fn batch_public(batch: &Value) -> Value {
    let object = batch.as_object();
    json!({
        "id": clone_field(object, "id"),
        "created_at": clone_field(object, "created_at"),
        "files": clone_field(object, "files"),
        "source_labels": clone_field(object, "source_labels"),
        "added_orders": clone_field(object, "added_orders"),
        "duplicate_orders": clone_field(object, "duplicate_orders"),
        "date_range": clone_field(object, "date_range"),
        "pay_amt": clone_field(object, "pay_amt"),
        "pay_item_cnt": clone_field(object, "pay_item_cnt"),
    })
}

fn clone_field(object: Option<&Map<String, Value>>, key: &str) -> Value {
    object
        .and_then(|object| object.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

fn load_ledger(paths: &RuntimePaths) -> Result<Value> {
    let Some(value) = read_json_file(&ledger_path(paths))? else {
        return Ok(default_ledger());
    };
    if value.get("batches").and_then(Value::as_array).is_some()
        && value.get("orders").and_then(Value::as_array).is_some()
    {
        Ok(value)
    } else {
        Ok(default_ledger())
    }
}

fn default_ledger() -> Value {
    json!({"schema_version": 1, "batches": [], "orders": []})
}

fn write_snapshot(paths: &RuntimePaths, ledger: &Value) -> Result<Vec<Value>> {
    let records = daily_records_from_orders(
        ledger
            .get("orders")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let imports = ledger
        .get("batches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(batch_public)
        .collect::<Vec<_>>();
    atomic_write(
        &snapshot_path(paths),
        &json!({
            "schema_version": 2,
            "generated_at": now_iso(),
            "imports": imports,
            "records": records,
        }),
    )?;
    Ok(records)
}

fn add_number(object: &mut Map<String, Value>, key: &str, amount: f64) {
    let current = object.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    object.insert(key.to_string(), json!(current + amount));
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn now_iso() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn atomic_write(path: &Path, payload: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("json")
    ));
    fs::write(&temporary, serde_json::to_vec_pretty(payload)?)
        .with_context(|| format!("write {}", temporary.display()))?;
    fs::rename(&temporary, path)
        .with_context(|| format!("replace {} with {}", path.display(), temporary.display()))?;
    Ok(())
}

fn safe_token(token: &str) -> Result<&str> {
    let token = token.trim();
    if token.is_empty()
        || !token
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_'))
    {
        bail!("导入预览不存在或已失效，请重新选择文件");
    }
    Ok(token)
}

fn external_orders_dir(paths: &RuntimePaths) -> PathBuf {
    paths.output_dir.join("external_orders")
}

fn ledger_path(paths: &RuntimePaths) -> PathBuf {
    external_orders_dir(paths).join("import_ledger.json")
}

fn snapshot_path(paths: &RuntimePaths) -> PathBuf {
    external_orders_dir(paths).join("orders_daily.json")
}

fn preview_path(paths: &RuntimePaths, token: &str) -> PathBuf {
    external_orders_dir(paths)
        .join("previews")
        .join(format!("{token}.json"))
}

fn lock_path(paths: &RuntimePaths) -> PathBuf {
    external_orders_dir(paths).join(".import.lock")
}

struct LedgerGuard {
    file: fs::File,
}

impl LedgerGuard {
    fn lock(paths: &RuntimePaths) -> Result<Self> {
        let path = lock_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        file.lock_exclusive()
            .with_context(|| format!("lock {}", path.display()))?;
        Ok(Self { file })
    }
}

impl Drop for LedgerGuard {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn returns_empty_payload_for_missing_ledger() {
        let paths = RuntimePaths {
            app_dir: "/tmp/missing".into(),
            output_dir: "/tmp/missing-output".into(),
            state_dir: "/tmp/missing-state".into(),
            config_dir: "/tmp/missing-config".into(),
            logs_dir: "/tmp/missing-logs".into(),
            session_dir: "/tmp/missing-session".into(),
        };
        let payload = public_imports(&paths).unwrap();
        assert_eq!(payload["summary"]["batches"], json!(0));
        assert_eq!(payload["batches"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn aggregates_daily_records_from_orders() {
        let records = daily_records_from_orders(&[
            json!({"date":"2026-07-18","shop_name":"A","source_key":"x","source_label":"X","amount_cent":100.0,"quantity":2}),
            json!({"date":"2026-07-18","shop_name":"A","source_key":"x","source_label":"X","amount_cent":50.0,"quantity":1}),
        ]);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["metrics"]["pay_amt"], json!(150.0));
        assert_eq!(records[0]["metrics"]["pay_cnt"], json!(2.0));
        assert_eq!(records[0]["metrics"]["pay_item_cnt"], json!(3.0));
    }

    #[test]
    fn commits_and_deletes_preview_with_snapshot_updates() {
        let root = std::env::temp_dir().join(format!(
            "luopan-orders-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        };
        let token = "preview_test_token";
        let preview = json!({
            "token": token,
            "created_at": now_iso(),
            "expires_at": "2999-01-01T00:00:00",
            "files": [{
                "file_name": "orders.xlsx",
                "file_hash": "file-1",
                "source_key": "tmall",
                "source_label": "订单明细 · 天猫",
                "input_rows": 1,
                "accepted_order_rows": 1,
                "accepted_orders": 1,
                "added_orders": 1,
                "duplicate_orders": 0,
                "known_file": false
            }],
            "orders": [{
                "order_key": "order-1",
                "date": "2026-07-18",
                "shop_name": "测试店铺",
                "amount_cent": 12300.0,
                "quantity": 2,
                "source": "external_orders",
                "source_key": "tmall",
                "source_label": "订单明细 · 天猫"
            }]
        });
        atomic_write(&preview_path(&paths, token), &preview).unwrap();

        let committed = commit_preview(&paths, token).unwrap();
        let batch_id = committed["batch"]["id"].as_str().unwrap().to_string();
        assert_eq!(committed["batch"]["added_orders"], json!(1));
        let imports = public_imports(&paths).unwrap();
        assert_eq!(imports["summary"]["orders"], json!(1));
        let snapshot = read_json_file(&snapshot_path(&paths)).unwrap().unwrap();
        assert_eq!(snapshot["records"].as_array().unwrap().len(), 1);

        let deleted = delete_batch(&paths, &batch_id).unwrap();
        assert_eq!(deleted["id"], json!(batch_id));
        let imports = public_imports(&paths).unwrap();
        assert_eq!(imports["summary"]["orders"], json!(0));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_workbook_like_the_python_importer() {
        let content = include_bytes!("../tests/fixtures/喵速达订单明细.xlsx");
        let (orders, metadata) = parse_workbook_orders("喵速达订单明细.xlsx", content).unwrap();

        assert_eq!(metadata["input_rows"], json!(4));
        assert_eq!(metadata["accepted_order_rows"], json!(3));
        assert_eq!(metadata["accepted_orders"], json!(2));
        assert_eq!(orders.len(), 2);
        assert_eq!(orders[0]["order_id"], json!("A-1"));
        assert_eq!(orders[0]["amount_cent"], json!(1025.0));
        assert_eq!(orders[0]["quantity"], json!(3));
        assert_eq!(orders[1]["order_id"], json!("row-3"));
        assert_eq!(orders[1]["quantity"], json!(3));
    }

    #[test]
    fn preview_writes_a_commit_compatible_token_file() {
        let root = std::env::temp_dir().join(format!(
            "luopan-orders-preview-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        };
        let preview = preview_upload(
            &paths,
            vec![UploadedWorkbook {
                filename: "喵速达订单明细.xlsx".to_string(),
                content: include_bytes!("../tests/fixtures/喵速达订单明细.xlsx").to_vec(),
            }],
        )
        .unwrap();
        let token = preview["preview_token"].as_str().unwrap();
        assert_eq!(preview["summary"]["added_orders"], json!(2));
        assert_eq!(preview["files"][0]["source_key"], json!("miaosuda"));
        let stored = read_json_file(&preview_path(&paths, token))
            .unwrap()
            .unwrap();
        assert_eq!(stored["token"], json!(token));
        assert_eq!(stored["orders"].as_array().unwrap().len(), 2);
        assert_eq!(
            commit_preview(&paths, token).unwrap()["batch"]["added_orders"],
            json!(2)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uses_the_python_dedupe_secret_format() {
        let root = std::env::temp_dir().join(format!(
            "luopan-orders-secret-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        };
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            paths.config_dir.join("import_dedupe_secret.txt"),
            "  compat-secret\n",
        )
        .unwrap();
        assert_eq!(
            order_digest(&paths, " order-42 ").unwrap(),
            "8ff105866905964c0e7eb14c03aa18df4d91ae80a93f216ddaa006ecb4b4d5a4"
        );
        let _ = fs::remove_dir_all(root);
    }
}
