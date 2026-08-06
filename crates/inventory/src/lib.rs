use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use calamine::{Data, DataType, Reader, Xlsx};
use chrono::{Local, NaiveDate, NaiveDateTime};
use luopan_jd::inventory_snapshot as jd_inventory_snapshot;
use luopan_runtime::{RuntimePaths, read_json_file};
use serde_json::{Map, Value, json};

const ACTUAL_TURNOVER_WINDOW_DAYS: usize = 30;
const TARGET_COVER_DAYS: f64 = 30.0;
const SAFETY_STOCK_DAYS: f64 = 7.0;
const BUSINESS_OUTBOUND_FILE: &str = "business_outbound.json";
const BUSINESS_OUTBOUND_DETAIL_LIMIT: usize = 120;
const BUSINESS_OUTBOUND_GROUP_LIMIT: usize = 20;
const HEALTH_ORDER: [&str; 8] = [
    "out_of_stock",
    "urgent",
    "replenish",
    "healthy",
    "high",
    "overstock",
    "no_movement",
    "unavailable",
];

pub fn load_inventory_dashboard(paths: &RuntimePaths) -> Result<Option<Value>> {
    let snapshot_path = paths.inventory_snapshot_path();
    let snapshot = merge_jd_snapshot(
        read_json_file(&snapshot_path)?,
        jd_inventory_snapshot(paths)?,
    );
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let history_dir = snapshot_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| paths.output_dir.join("inventory"))
        .join("history");
    Ok(Some(build_dashboard(&snapshot, &history_dir)?))
}

/// 商智批发单无法通过现有库存 API 同步，管理员上传 Excel 后会被规范化为
/// 只供看板使用的 JSON；原始工作簿不写入服务器。
pub fn load_business_outbound_dashboard(paths: &RuntimePaths) -> Result<Value> {
    let path = business_outbound_path(paths);
    Ok(read_json_file(&path)?.unwrap_or_else(empty_business_outbound_dashboard))
}

pub fn save_business_outbound_upload(
    paths: &RuntimePaths,
    original_file_name: &str,
    bytes: &[u8],
) -> Result<Value> {
    let filename = Path::new(original_file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if filename.is_empty() || !filename.to_ascii_lowercase().ends_with(".xlsx") {
        bail!("仅支持上传 .xlsx 格式的商智出库明细");
    }
    if bytes.is_empty() {
        bail!("上传文件为空");
    }

    let dashboard = parse_business_outbound_workbook(filename, bytes)?;
    let path = business_outbound_path(paths);
    let directory = path.parent().ok_or_else(|| anyhow!("商智出库目录无效"))?;
    fs::create_dir_all(directory).with_context(|| format!("create {}", directory.display()))?;
    fs::write(&path, serde_json::to_vec_pretty(&dashboard)?)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(dashboard)
}

fn business_outbound_path(paths: &RuntimePaths) -> PathBuf {
    paths
        .output_dir
        .join("inventory")
        .join(BUSINESS_OUTBOUND_FILE)
}

fn empty_business_outbound_dashboard() -> Value {
    json!({
        "available": false,
        "summary": {},
        "trend": [],
        "warehouses": [],
        "products": [],
        "rows": [],
    })
}

fn parse_business_outbound_workbook(filename: &str, bytes: &[u8]) -> Result<Value> {
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).context("读取商智出库 Excel")?;
    let sheet_count = workbook.sheet_names().len();
    if sheet_count == 0 {
        bail!("工作簿没有可读取的工作表");
    }

    let mut outbound_rows = Vec::new();
    let mut input_rows = 0usize;
    let mut sheets = Vec::new();
    for index in 0..sheet_count {
        let range = workbook
            .worksheet_range_at(index)
            .ok_or_else(|| anyhow!("读取工作表失败"))??;
        let mut rows = range.rows();
        let headers: Vec<String> = rows.next().unwrap_or(&[]).iter().map(cell_text).collect();
        if headers.is_empty() {
            continue;
        }
        let columns = BusinessOutboundColumns::from_headers(&headers)
            .with_context(|| format!("第 {} 张工作表", index + 1))?;
        let mut accepted = 0usize;
        for row in rows {
            input_rows += 1;
            let value = |column: usize| row.get(column).unwrap_or(&Data::Empty);
            let document_type = cell_text(value(columns.document_type)).trim().to_string();
            if !matches!(document_type.as_str(), "批发" | "批退") {
                continue;
            }
            let Some(date) = parse_business_outbound_date(value(columns.audit_time)) else {
                continue;
            };
            let document_no = cell_text(value(columns.document_no)).trim().to_string();
            let sku = cell_text(value(columns.sku)).trim().to_string();
            if document_no.is_empty() || sku.is_empty() {
                continue;
            }
            let direction = if document_type == "批退" { -1.0 } else { 1.0 };
            outbound_rows.push(json!({
                "date": date.format("%Y-%m-%d").to_string(),
                "document_no": document_no,
                "document_type": document_type,
                "sku": sku,
                "product_name": cell_text(value(columns.product_name)).trim(),
                "brand": cell_text(value(columns.brand)).trim(),
                "warehouse": cell_text(value(columns.warehouse)).trim(),
                "customer": cell_text(value(columns.customer)).trim(),
                "quantity": rounded(cell_number(value(columns.quantity)) * direction),
                "sales_amount": rounded(cell_number(value(columns.sales_amount)) * direction),
                "cost_amount": rounded(cell_number(value(columns.cost_amount)) * direction),
                "gross_profit": rounded(cell_number(value(columns.gross_profit)) * direction),
            }));
            accepted += 1;
        }
        sheets.push(json!({"index": index + 1, "input_rows": range.height().saturating_sub(1), "accepted_rows": accepted}));
    }
    if outbound_rows.is_empty() {
        bail!("没有读到有效商智出库明细；请确认包含批发/批退、SKU、审核时间、商品数量等列");
    }
    Ok(build_business_outbound_dashboard(
        filename,
        input_rows,
        sheets,
        outbound_rows,
    ))
}

struct BusinessOutboundColumns {
    document_no: usize,
    customer: usize,
    document_type: usize,
    sku: usize,
    product_name: usize,
    brand: usize,
    warehouse: usize,
    quantity: usize,
    sales_amount: usize,
    cost_amount: usize,
    gross_profit: usize,
    audit_time: usize,
}

impl BusinessOutboundColumns {
    fn from_headers(headers: &[String]) -> Result<Self> {
        let required = |name: &str| {
            headers
                .iter()
                .position(|header| header.trim() == name)
                .ok_or_else(|| anyhow!("缺少{name}列，可用列：{}", headers.join("、")))
        };
        Ok(Self {
            document_no: required("单据编号")?,
            customer: required("客户名称")?,
            document_type: required("批发单类型")?,
            sku: required("sku")?,
            product_name: required("商品名称")?,
            brand: required("品牌")?,
            warehouse: required("仓库")?,
            quantity: required("商品数量")?,
            sales_amount: required("销售总金额")?,
            cost_amount: required("成本总金额")?,
            gross_profit: required("毛利额")?,
            audit_time: required("审核时间")?,
        })
    }
}

fn build_business_outbound_dashboard(
    filename: &str,
    input_rows: usize,
    sheets: Vec<Value>,
    mut rows: Vec<Value>,
) -> Value {
    rows.sort_by_key(|row| std::cmp::Reverse(text(row.get("date"))));
    let mut documents = HashSet::new();
    let mut skus = HashSet::new();
    let mut warehouses = HashSet::new();
    let mut wholesale_quantity = 0.0;
    let mut return_quantity = 0.0;
    let mut wholesale_sales = 0.0;
    let mut return_sales = 0.0;
    let mut net_cost = 0.0;
    let mut net_profit = 0.0;
    let mut daily: BTreeMap<String, OutboundAggregate> = BTreeMap::new();
    let mut warehouse_groups: BTreeMap<String, OutboundAggregate> = BTreeMap::new();
    let mut product_groups: BTreeMap<(String, String), OutboundAggregate> = BTreeMap::new();
    for row in &rows {
        let document_type = text(row.get("document_type"));
        let quantity = number(row.get("quantity"));
        let sales = number(row.get("sales_amount"));
        if document_type == "批退" {
            return_quantity += quantity.abs();
            return_sales += sales.abs();
        } else {
            wholesale_quantity += quantity;
            wholesale_sales += sales;
        }
        net_cost += number(row.get("cost_amount"));
        net_profit += number(row.get("gross_profit"));
        documents.insert(text(row.get("document_no")));
        skus.insert(text(row.get("sku")));
        warehouses.insert(text(row.get("warehouse")));
        aggregate_outbound(daily.entry(text(row.get("date"))).or_default(), row);
        aggregate_outbound(
            warehouse_groups
                .entry(non_empty(row.get("warehouse"), "未标注仓库"))
                .or_default(),
            row,
        );
        aggregate_outbound(
            product_groups
                .entry((
                    text(row.get("sku")),
                    non_empty(row.get("product_name"), "未命名商品"),
                ))
                .or_default(),
            row,
        );
    }
    let net_sales = wholesale_sales - return_sales;
    let latest_date = rows
        .first()
        .map(|row| text(row.get("date")))
        .unwrap_or_default();
    let earliest_date = rows
        .last()
        .map(|row| text(row.get("date")))
        .unwrap_or_default();
    let group_json = |groups: Vec<(String, OutboundAggregate)>| {
        groups
            .into_iter()
            .map(|(name, value)| {
                json!({
                    "name": name,
                    "quantity": rounded(value.quantity),
                    "sales_amount": rounded(value.sales_amount),
                    "gross_profit": rounded(value.gross_profit),
                })
            })
            .collect::<Vec<_>>()
    };
    let mut warehouse_values: Vec<_> = warehouse_groups.into_iter().collect();
    warehouse_values.sort_by(|left, right| {
        right
            .1
            .sales_amount
            .partial_cmp(&left.1.sales_amount)
            .unwrap_or(Ordering::Equal)
    });
    let mut product_values: Vec<_> = product_groups
        .into_iter()
        .map(|((sku, product_name), value)| (format!("{sku}\u{0000}{product_name}"), value))
        .collect();
    product_values.sort_by(|left, right| {
        right
            .1
            .quantity
            .partial_cmp(&left.1.quantity)
            .unwrap_or(Ordering::Equal)
    });
    let products = product_values.into_iter().take(BUSINESS_OUTBOUND_GROUP_LIMIT).map(|(name, value)| {
        let (sku, product_name) = name.split_once('\u{0000}').unwrap_or((&name, ""));
        json!({"sku": sku, "product_name": product_name, "quantity": rounded(value.quantity), "sales_amount": rounded(value.sales_amount), "gross_profit": rounded(value.gross_profit)})
    }).collect::<Vec<_>>();

    json!({
        "available": true,
        "source": {"file_name": filename, "updated_at": Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(), "sheets": sheets, "input_rows": input_rows},
        "summary": {
            "row_count": rows.len(), "document_count": documents.len(), "sku_count": skus.len(), "warehouse_count": warehouses.len(),
            "wholesale_quantity": rounded(wholesale_quantity), "return_quantity": rounded(return_quantity), "net_outbound_quantity": rounded(wholesale_quantity - return_quantity),
            "wholesale_sales_amount": rounded(wholesale_sales), "return_sales_amount": rounded(return_sales), "net_sales_amount": rounded(net_sales),
            "net_cost_amount": rounded(net_cost), "gross_profit": rounded(net_profit),
            "gross_margin": if net_sales == 0.0 { Value::Null } else { json!(rounded(net_profit / net_sales)) },
            "earliest_date": earliest_date, "latest_date": latest_date,
        },
        "trend": daily.into_iter().map(|(date, value)| json!({"date": date, "quantity": rounded(value.quantity), "sales_amount": rounded(value.sales_amount)})).collect::<Vec<_>>(),
        "warehouses": group_json(warehouse_values.into_iter().take(BUSINESS_OUTBOUND_GROUP_LIMIT).collect()),
        "products": products,
        "rows": rows.into_iter().take(BUSINESS_OUTBOUND_DETAIL_LIMIT).collect::<Vec<_>>(),
    })
}

#[derive(Default)]
struct OutboundAggregate {
    quantity: f64,
    sales_amount: f64,
    gross_profit: f64,
}

fn aggregate_outbound(target: &mut OutboundAggregate, row: &Value) {
    target.quantity += number(row.get("quantity"));
    target.sales_amount += number(row.get("sales_amount"));
    target.gross_profit += number(row.get("gross_profit"));
}

fn non_empty(value: Option<&Value>, fallback: &str) -> String {
    let text = text(value);
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

fn cell_text(cell: &Data) -> String {
    cell.to_string()
}

fn cell_number(cell: &Data) -> f64 {
    cell_text(cell).trim().parse::<f64>().unwrap_or(0.0)
}

fn parse_business_outbound_date(cell: &Data) -> Option<NaiveDate> {
    cell.as_datetime().map(|value| value.date()).or_else(|| {
        let value = cell_text(cell);
        ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]
            .iter()
            .find_map(|format| {
                NaiveDateTime::parse_from_str(&value, format)
                    .ok()
                    .map(|date| date.date())
            })
            .or_else(|| NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok())
    })
}

fn merge_jd_snapshot(existing: Option<Value>, jd: Option<Value>) -> Option<Value> {
    match (existing, jd) {
        (None, None) => None,
        (Some(snapshot), None) | (None, Some(snapshot)) => Some(snapshot),
        (Some(mut snapshot), Some(jd)) => {
            for key in ["inventory", "sales_7d", "inbound_30d"] {
                let source = jd[key].as_array().cloned().unwrap_or_default();
                if let Some(target) = snapshot
                    .as_object_mut()
                    .map(|value| value.entry(key.to_string()).or_insert_with(|| json!([])))
                    .and_then(Value::as_array_mut)
                {
                    target.extend(source);
                }
            }
            if let Some(target) = snapshot.as_object_mut() {
                let previous = target
                    .get("captured_at")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if jd["captured_at"].as_str().unwrap_or_default() >= previous {
                    target.insert("captured_at".to_string(), jd["captured_at"].clone());
                }
                target.insert(
                    "source".to_string(),
                    json!({"inventory_sync": true, "jd_rdc": true}),
                );
            }
            Some(snapshot)
        }
    }
}

pub fn build_dashboard(snapshot: &Value, history_dir: &Path) -> Result<Value> {
    let sales_rows: Vec<Value> = value_array(snapshot, "sales_7d")
        .iter()
        .filter(|row| !is_rollup(row))
        .cloned()
        .collect();
    let inbound_rows: Vec<Value> = value_array(snapshot, "inbound_30d")
        .iter()
        .filter(|row| !is_rollup(row))
        .cloned()
        .collect();
    let mut sales: HashMap<(String, String), f64> = HashMap::new();
    let mut inbound: HashMap<(String, String), f64> = HashMap::new();

    for row in &sales_rows {
        *sales.entry(inventory_key(row)).or_default() += number(row.get("quantity"));
    }
    for row in &inbound_rows {
        *inbound.entry(inventory_key(row)).or_default() += number(row.get("quantity"));
    }

    let mut rows = Vec::new();
    for source in value_array(snapshot, "inventory") {
        let mut item = source.as_object().cloned().unwrap_or_default();
        let key = inventory_key(source);
        let sales_7d = rounded(*sales.get(&key).unwrap_or(&0.0));
        let inbound_30d = rounded(*inbound.get(&key).unwrap_or(&0.0));
        let (health_key, health_name, coverage_days, replenish_qty) =
            health_for(number(item.get("available_num")), sales_7d);

        item.insert("sales_7d".to_string(), json!(sales_7d));
        item.insert("inbound_30d".to_string(), json!(inbound_30d));
        item.insert("health_key".to_string(), json!(health_key));
        item.insert("health_name".to_string(), json!(health_name));
        item.insert(
            "coverage_days".to_string(),
            coverage_days.map_or(Value::Null, |value| json!(value)),
        );
        item.insert("replenish_qty".to_string(), json!(replenish_qty));
        let cost_price = number(item.get("cost_price"));
        let cost_covered = cost_price > 0.0;
        item.insert("cost_covered".to_string(), json!(cost_covered));
        item.insert(
            "stock_cost_amount".to_string(),
            if cost_covered {
                json!(rounded(number(item.get("stock_num")) * cost_price))
            } else {
                Value::Null
            },
        );
        item.insert(
            "available_cost_amount".to_string(),
            if cost_covered {
                json!(rounded(number(item.get("available_num")) * cost_price))
            } else {
                Value::Null
            },
        );
        rows.push(Value::Object(item));
    }

    let warehouse_names: HashMap<String, String> = rows
        .iter()
        .map(|row| {
            let warehouse_no = text(row.get("warehouse_no"));
            let warehouse_name = first_text(row, &["warehouse_name", "warehouse_no"])
                .unwrap_or_else(|| "未命名仓库".to_string());
            (warehouse_no, warehouse_name)
        })
        .collect();
    let brand_names: HashMap<(String, String), String> = rows
        .iter()
        .map(|row| {
            (
                inventory_key(row),
                first_text(row, &["brand_name", "brand_no"])
                    .unwrap_or_else(|| "未归类品牌".to_string()),
            )
        })
        .collect();

    let analysis_rows: Vec<Value> = rows.iter().filter(|row| !is_rollup(row)).cloned().collect();
    let total_available: f64 = analysis_rows
        .iter()
        .map(|row| number(row.get("available_num")))
        .sum();
    let total_sales_7d: f64 = sales_rows
        .iter()
        .map(|row| number(row.get("quantity")))
        .sum();
    let coverage_rows: Vec<f64> = analysis_rows
        .iter()
        .filter_map(|row| {
            let coverage = row.get("coverage_days").and_then(Value::as_f64);
            if coverage.is_some() && number(row.get("sales_7d")) > 0.0 {
                coverage
            } else {
                None
            }
        })
        .collect();
    let cost_covered_records = analysis_rows
        .iter()
        .filter(|row| {
            row.get("cost_covered")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .count();
    let stock_cost_amount: f64 = analysis_rows
        .iter()
        .filter(|row| {
            row.get("cost_covered")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|row| number(row.get("stock_cost_amount")))
        .sum();
    let available_cost_amount: f64 = analysis_rows
        .iter()
        .filter(|row| {
            row.get("cost_covered")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|row| number(row.get("available_cost_amount")))
        .sum();

    let history = historical_turnover(history_dir)?;
    let mut summary = json!({
        "sku_records": analysis_rows.len(),
        "distinct_skus": distinct_count(&analysis_rows, "spec_no", |_| true),
        "salable_skus": distinct_count(&analysis_rows, "spec_no", |row| number(row.get("available_num")) > 0.0),
        "stock_num": rounded(sum_rows(&analysis_rows, "stock_num")),
        "available_num": rounded(total_available),
        "sales_7d": rounded(total_sales_7d),
        "inbound_30d": rounded(inbound_rows.iter().map(|row| number(row.get("quantity"))).sum()),
        "negative_available": analysis_rows.iter().filter(|row| number(row.get("available_num")) < 0.0).count(),
        "turnover_days": if total_sales_7d > 0.0 { json!(rounded(total_available / (total_sales_7d / 7.0))) } else { Value::Null },
        "average_coverage_days": if coverage_rows.is_empty() { Value::Null } else { json!(rounded(coverage_rows.iter().sum::<f64>() / coverage_rows.len() as f64)) },
        "replenishment_records": analysis_rows.iter().filter(|row| matches!(text(row.get("health_key")).as_str(), "out_of_stock" | "urgent" | "replenish")).count(),
        "no_movement_records": analysis_rows.iter().filter(|row| text(row.get("health_key")) == "no_movement").count(),
        "overstock_records": analysis_rows.iter().filter(|row| matches!(text(row.get("health_key")).as_str(), "overstock" | "high")).count(),
        "cost_covered_records": cost_covered_records,
        "cost_coverage_rate": if analysis_rows.is_empty() { Value::Null } else { json!(rounded(cost_covered_records as f64 / analysis_rows.len() as f64)) },
        "stock_cost_amount": if cost_covered_records == 0 { Value::Null } else { json!(rounded(stock_cost_amount)) },
        "available_cost_amount": if cost_covered_records == 0 { Value::Null } else { json!(rounded(available_cost_amount)) },
    });
    if let Some(object) = summary.as_object_mut() {
        object.insert(
            "actual_turnover_30d".to_string(),
            history
                .get("actual_turnover_days")
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.insert(
            "history_days".to_string(),
            history.get("available_days").cloned().unwrap_or(json!(0)),
        );
    }

    rows.sort_by(compare_inventory_rows);
    let sales_trends = build_sales_trend(&sales_rows, &warehouse_names, &brand_names);

    Ok(json!({
        "captured_at": snapshot.get("captured_at").cloned().unwrap_or(Value::Null),
        "analytics_captured_at": snapshot.get("analytics_captured_at").cloned().unwrap_or_else(|| snapshot.get("captured_at").cloned().unwrap_or(Value::Null)),
        "source": snapshot.get("source").cloned().unwrap_or_else(|| json!({})),
        "summary": summary,
        "warehouses": build_group(&rows, "warehouse_name"),
        "brands": build_group(&rows, "brand_name"),
        "health": build_health(&analysis_rows),
        "sales_trend_7d": sales_trends.total,
        "sales_trend_7d_by_warehouse": sales_trends.by_warehouse,
        "sales_trend_7d_by_brand": sales_trends.by_brand,
        "sales_trend_7d_by_warehouse_brand": sales_trends.by_warehouse_brand,
        "settings": {"target_cover_days": TARGET_COVER_DAYS as i64, "safety_stock_days": SAFETY_STOCK_DAYS as i64},
        "history": history,
        "rows": rows,
    }))
}

fn value_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn is_rollup(row: &Value) -> bool {
    row.get("is_rollup")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn inventory_key(row: &Value) -> (String, String) {
    (text(row.get("warehouse_no")), text(row.get("spec_no")))
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn first_text(row: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .map(|key| text(row.get(*key)))
        .find(|value| !value.is_empty())
}

fn rounded(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn ceil_i64(value: f64) -> i64 {
    value.ceil() as i64
}

fn health_for(available_num: f64, sales_7d: f64) -> (&'static str, &'static str, Option<i64>, i64) {
    let daily_sales = sales_7d / 7.0;
    let coverage_days = if daily_sales > 0.0 {
        Some(ceil_i64(available_num.max(0.0) / daily_sales))
    } else {
        None
    };
    let replenish_qty = if daily_sales > 0.0 {
        ceil_i64(
            ((TARGET_COVER_DAYS + SAFETY_STOCK_DAYS) * daily_sales - available_num.max(0.0))
                .max(0.0),
        )
    } else {
        0
    };

    if available_num <= 0.0 && sales_7d > 0.0 {
        return ("out_of_stock", "已缺货", coverage_days, replenish_qty);
    }
    if sales_7d == 0.0 && available_num > 0.0 {
        return ("no_movement", "近 7 日未动销", None, 0);
    }
    if let Some(days) = coverage_days {
        if sales_7d > 0.0 && days < 7 {
            return ("urgent", "紧急补货", coverage_days, replenish_qty);
        }
        if sales_7d > 0.0 && days < 14 {
            return ("replenish", "需安排补货", coverage_days, replenish_qty);
        }
        if sales_7d > 0.0 && days <= 45 {
            return ("healthy", "库存健康", coverage_days, 0);
        }
        if sales_7d > 0.0 && days <= 90 {
            return ("high", "库存偏高", coverage_days, 0);
        }
    }
    if sales_7d > 0.0 {
        return ("overstock", "库存积压", coverage_days, 0);
    }
    ("unavailable", "暂无可售", None, 0)
}

fn build_group(rows: &[Value], key_name: &str) -> Vec<Value> {
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for row in rows {
        let name = first_text(row, &[key_name]).unwrap_or_else(|| "未归类".to_string());
        let group = groups.entry(name.clone()).or_insert_with(|| Group {
            name,
            ..Group::default()
        });
        group.sku_records += 1;
        group.stock_num += number(row.get("stock_num"));
        group.available_num += number(row.get("available_num"));
        group.sales_7d += number(row.get("sales_7d"));
        group.inbound_30d += number(row.get("inbound_30d"));
        group.negative_available += usize::from(number(row.get("available_num")) < 0.0);
        if row
            .get("cost_covered")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            group.cost_covered_records += 1;
            group.stock_cost_amount += number(row.get("stock_cost_amount"));
            group.available_cost_amount += number(row.get("available_cost_amount"));
        }
    }

    let mut values: Vec<Value> = groups
        .into_values()
        .map(|group| {
            json!({
                "name": group.name,
                "sku_records": group.sku_records,
                "stock_num": rounded(group.stock_num),
                "available_num": rounded(group.available_num),
                "sales_7d": rounded(group.sales_7d),
                "inbound_30d": rounded(group.inbound_30d),
                "negative_available": group.negative_available,
                "turnover_days": if group.sales_7d > 0.0 { json!(rounded(group.available_num / (group.sales_7d / 7.0))) } else { Value::Null },
                "cost_covered_records": group.cost_covered_records,
                "cost_coverage_rate": if group.sku_records == 0 { Value::Null } else { json!(rounded(group.cost_covered_records as f64 / group.sku_records as f64)) },
                "stock_cost_amount": if group.cost_covered_records == 0 { Value::Null } else { json!(rounded(group.stock_cost_amount)) },
                "available_cost_amount": if group.cost_covered_records == 0 { Value::Null } else { json!(rounded(group.available_cost_amount)) },
            })
        })
        .collect();
    values.sort_by(|left, right| {
        number(right.get("available_num"))
            .partial_cmp(&number(left.get("available_num")))
            .unwrap_or(Ordering::Equal)
    });
    values
}

#[derive(Default)]
struct Group {
    name: String,
    sku_records: usize,
    stock_num: f64,
    available_num: f64,
    sales_7d: f64,
    inbound_30d: f64,
    negative_available: usize,
    cost_covered_records: usize,
    stock_cost_amount: f64,
    available_cost_amount: f64,
}

fn build_health(rows: &[Value]) -> Vec<Value> {
    let names = health_names();
    HEALTH_ORDER
        .iter()
        .map(|key| {
            let members: Vec<&Value> = rows
                .iter()
                .filter(|row| text(row.get("health_key")) == *key)
                .collect();
            json!({
                "key": key,
                "name": names.get(key).copied().unwrap_or("未知状态"),
                "sku_records": members.len(),
                "available_num": rounded(members.iter().map(|row| number(row.get("available_num"))).sum()),
            })
        })
        .collect()
}

fn health_names() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("out_of_stock", "已缺货"),
        ("urgent", "紧急补货"),
        ("replenish", "需安排补货"),
        ("healthy", "库存健康"),
        ("high", "库存偏高"),
        ("overstock", "库存积压"),
        ("no_movement", "近 7 日未动销"),
        ("unavailable", "暂无可售"),
    ])
}

struct SalesTrends {
    total: Vec<Value>,
    by_warehouse: BTreeMap<String, Vec<Value>>,
    by_brand: BTreeMap<String, Vec<Value>>,
    by_warehouse_brand: BTreeMap<String, BTreeMap<String, Vec<Value>>>,
}

fn build_sales_trend(
    sales_rows: &[Value],
    warehouse_names: &HashMap<String, String>,
    brand_names: &HashMap<(String, String), String>,
) -> SalesTrends {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    let mut by_warehouse: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let mut by_brand: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let mut by_warehouse_brand: BTreeMap<String, BTreeMap<String, BTreeMap<String, f64>>> =
        BTreeMap::new();

    for row in sales_rows {
        let date = text(row.get("date"));
        if date.is_empty() {
            continue;
        }
        let quantity = number(row.get("quantity"));
        *totals.entry(date.clone()).or_default() += quantity;
        let key = inventory_key(row);
        let warehouse_name = warehouse_names
            .get(&key.0)
            .cloned()
            .unwrap_or_else(|| "未命名仓库".to_string());
        let brand_name = brand_names
            .get(&key)
            .cloned()
            .unwrap_or_else(|| "未归类品牌".to_string());
        *by_warehouse
            .entry(warehouse_name.clone())
            .or_default()
            .entry(date.clone())
            .or_default() += quantity;
        *by_brand
            .entry(brand_name.clone())
            .or_default()
            .entry(date.clone())
            .or_default() += quantity;
        *by_warehouse_brand
            .entry(warehouse_name)
            .or_default()
            .entry(brand_name)
            .or_default()
            .entry(date)
            .or_default() += quantity;
    }

    let total_rows = totals
        .into_iter()
        .map(|(date, quantity)| json!({"date": date, "quantity": rounded(quantity)}))
        .collect();
    SalesTrends {
        total: total_rows,
        by_warehouse: daily_series_by_group(by_warehouse),
        by_brand: daily_series_by_group(by_brand),
        by_warehouse_brand: by_warehouse_brand
            .into_iter()
            .map(|(warehouse, brands)| (warehouse, daily_series_by_group(brands)))
            .collect(),
    }
}

fn daily_series_by_group(
    groups: BTreeMap<String, BTreeMap<String, f64>>,
) -> BTreeMap<String, Vec<Value>> {
    groups
        .into_iter()
        .map(|(name, values)| {
            let rows = values
                .into_iter()
                .map(|(date, quantity)| json!({"date": date, "quantity": rounded(quantity)}))
                .collect();
            (name, rows)
        })
        .collect()
}

fn sum_rows(rows: &[Value], key: &str) -> f64 {
    rows.iter().map(|row| number(row.get(key))).sum()
}

fn distinct_count<F>(rows: &[Value], key: &str, predicate: F) -> usize
where
    F: Fn(&Map<String, Value>) -> bool,
{
    rows.iter()
        .filter_map(Value::as_object)
        .filter(|row| predicate(row))
        .map(|row| text(row.get(key)))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>()
        .len()
}

fn compare_inventory_rows(left: &Value, right: &Value) -> Ordering {
    let left_priority = health_priority(&text(left.get("health_key")));
    let right_priority = health_priority(&text(right.get("health_key")));
    left_priority
        .cmp(&right_priority)
        .then_with(|| {
            coverage_sort_value(left)
                .partial_cmp(&coverage_sort_value(right))
                .unwrap_or(Ordering::Equal)
        })
        .then_with(|| {
            number(right.get("sales_7d"))
                .partial_cmp(&number(left.get("sales_7d")))
                .unwrap_or(Ordering::Equal)
        })
}

fn health_priority(key: &str) -> usize {
    HEALTH_ORDER
        .iter()
        .position(|candidate| *candidate == key)
        .unwrap_or(usize::MAX)
}

fn coverage_sort_value(row: &Value) -> f64 {
    row.get("coverage_days")
        .and_then(Value::as_f64)
        .unwrap_or(1_000_000_000.0)
}

fn historical_turnover(history_dir: &Path) -> Result<Value> {
    let mut snapshots: Vec<(String, Value)> = Vec::new();
    if history_dir.exists() {
        let mut paths: Vec<PathBuf> = fs::read_dir(history_dir)
            .with_context(|| format!("read {}", history_dir.display()))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
                    && path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .is_some_and(|stem| stem.len() == 10)
            })
            .collect();
        paths.sort();
        for path in paths {
            let Some(snapshot) = read_json_file(&path)? else {
                continue;
            };
            if snapshot
                .get("inventory")
                .and_then(Value::as_array)
                .is_some()
            {
                let date = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
                    .to_string();
                snapshots.push((date, snapshot));
            }
        }
    }

    let start = snapshots.len().saturating_sub(ACTUAL_TURNOVER_WINDOW_DAYS);
    let snapshots = snapshots.split_off(start);
    let dates: Vec<String> = snapshots.iter().map(|(date, _)| date.clone()).collect();
    let mut result = json!({
        "required_days": ACTUAL_TURNOVER_WINDOW_DAYS,
        "available_days": dates.len(),
        "dates": dates,
        "ready": false,
        "average_available_num": Value::Null,
        "sales_quantity": Value::Null,
        "actual_turnover_days": Value::Null,
    });
    if snapshots.len() != ACTUAL_TURNOVER_WINDOW_DAYS {
        return Ok(result);
    }

    let first = NaiveDate::parse_from_str(&snapshots[0].0, "%Y-%m-%d");
    let last = NaiveDate::parse_from_str(&snapshots[snapshots.len() - 1].0, "%Y-%m-%d");
    let (Ok(first), Ok(last)) = (first, last) else {
        return Ok(result);
    };
    if last.signed_duration_since(first).num_days() != (ACTUAL_TURNOVER_WINDOW_DAYS - 1) as i64 {
        return Ok(result);
    }

    let average_available = snapshots
        .iter()
        .map(|(_, snapshot)| {
            value_array(snapshot, "inventory")
                .iter()
                .map(|row| number(row.get("available_num")))
                .sum::<f64>()
        })
        .sum::<f64>()
        / snapshots.len() as f64;

    let mut sales_by_detail_date: HashMap<(String, String, String), f64> = HashMap::new();
    for (_, snapshot) in &snapshots {
        for row in value_array(snapshot, "sales_7d") {
            let key = (
                text(row.get("date")),
                text(row.get("warehouse_no")),
                text(row.get("spec_no")),
            );
            if !key.0.is_empty() && !key.1.is_empty() && !key.2.is_empty() {
                sales_by_detail_date.insert(key, number(row.get("quantity")));
            }
        }
    }
    let sales_quantity: f64 = sales_by_detail_date.values().sum();
    if let Some(object) = result.as_object_mut() {
        object.insert("ready".to_string(), json!(sales_quantity > 0.0));
        object.insert(
            "average_available_num".to_string(),
            json!(rounded(average_available)),
        );
        object.insert("sales_quantity".to_string(), json!(rounded(sales_quantity)));
        object.insert(
            "actual_turnover_days".to_string(),
            if sales_quantity > 0.0 {
                json!(rounded(
                    average_available / (sales_quantity / ACTUAL_TURNOVER_WINDOW_DAYS as f64)
                ))
            } else {
                Value::Null
            },
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_summary_excludes_unmaintained_costs() {
        let snapshot = json!({
            "inventory": [
                {"warehouse_no": "001", "spec_no": "A", "stock_num": 10, "available_num": 8, "cost_price": 12.5},
                {"warehouse_no": "001", "spec_no": "B", "stock_num": 6, "available_num": 6, "cost_price": 0}
            ],
            "sales_7d": [],
            "inbound_30d": []
        });

        let dashboard = build_dashboard(&snapshot, Path::new("/tmp/luopan-inventory-no-history"))
            .expect("dashboard should build");
        let rows = dashboard["rows"]
            .as_array()
            .expect("rows should be an array");
        let costed_row = rows
            .iter()
            .find(|row| row["spec_no"] == "A")
            .expect("costed row");
        let unmaintained_row = rows
            .iter()
            .find(|row| row["spec_no"] == "B")
            .expect("unmaintained row");

        assert_eq!(costed_row["cost_covered"], true);
        assert_eq!(costed_row["stock_cost_amount"], 125.0);
        assert_eq!(costed_row["available_cost_amount"], 100.0);
        assert_eq!(unmaintained_row["cost_covered"], false);
        assert!(unmaintained_row["stock_cost_amount"].is_null());
        assert_eq!(dashboard["summary"]["cost_covered_records"], 1);
        assert_eq!(dashboard["summary"]["cost_coverage_rate"], 0.5);
        assert_eq!(dashboard["summary"]["stock_cost_amount"], 125.0);
    }

    #[test]
    fn business_outbound_treats_returns_as_negative() {
        let dashboard = build_business_outbound_dashboard(
            "商智出库.xlsx",
            2,
            vec![json!({"index": 1, "input_rows": 2, "accepted_rows": 2})],
            vec![
                json!({"date": "2026-08-02", "document_no": "P-1", "document_type": "批发", "sku": "A", "product_name": "商品 A", "warehouse": "上海仓", "quantity": 10.0, "sales_amount": 100.0, "cost_amount": 70.0, "gross_profit": 30.0}),
                json!({"date": "2026-08-03", "document_no": "R-1", "document_type": "批退", "sku": "A", "product_name": "商品 A", "warehouse": "上海仓", "quantity": -2.0, "sales_amount": -20.0, "cost_amount": -14.0, "gross_profit": -6.0}),
            ],
        );

        assert_eq!(dashboard["summary"]["wholesale_quantity"], 10.0);
        assert_eq!(dashboard["summary"]["return_quantity"], 2.0);
        assert_eq!(dashboard["summary"]["net_outbound_quantity"], 8.0);
        assert_eq!(dashboard["summary"]["net_sales_amount"], 80.0);
        assert_eq!(dashboard["summary"]["gross_profit"], 24.0);
    }
}
