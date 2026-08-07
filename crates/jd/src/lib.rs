use anyhow::{Context, Result, bail};
use calamine::{Data, DataType, Reader, Xlsx};
use chrono::Local;
use luopan_runtime::{RuntimePaths, read_json_file};
use rand_core::{OsRng, RngCore};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::PathBuf};

pub const SHOP_ID: &str = "jd:1000077433";
pub const SHOP_NAME: &str = "GNC 京东自营";

pub struct UploadedWorkbook {
    pub filename: String,
    pub content: Vec<u8>,
}
fn root(paths: &RuntimePaths) -> PathBuf {
    paths.output_dir.join("jd")
}
fn ledger_path(paths: &RuntimePaths) -> PathBuf {
    root(paths).join("imports.json")
}
fn preview_path(paths: &RuntimePaths, token: &str) -> PathBuf {
    root(paths).join("previews").join(format!("{token}.json"))
}
fn write(path: PathBuf, v: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(&path, serde_json::to_vec(v)?)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}
fn text(v: &Data) -> String {
    v.to_string().trim().to_string()
}
fn num(v: &Data) -> f64 {
    text(v).replace([',', '%'], "").parse().unwrap_or(0.)
}
fn date(v: &Data) -> String {
    v.as_datetime()
        .map(|d| d.date().format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| text(v).replace('/', "-"))
}
fn token() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn preview_upload(paths: &RuntimePaths, files: Vec<UploadedWorkbook>) -> Result<Value> {
    if files.is_empty() {
        bail!("请选择至少一个京东 Excel 文件")
    }
    if files.len() > 2 {
        bail!("一次最多上传 RDC 库存与商品经营各一份")
    }
    let ledger = read_json_file(&ledger_path(paths))?.unwrap_or_else(|| json!({"batches":[]}));
    let known: Vec<String> = ledger["batches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|batch| batch["hash"].as_str().map(str::to_string))
        .collect();
    let mut parsed = Vec::new();
    let mut summaries = Vec::new();
    for file in files {
        if !file.filename.to_lowercase().ends_with(".xlsx") {
            bail!("仅支持 .xlsx 文件")
        };
        let hash = format!("{:x}", Sha256::digest(&file.content));
        let (kind, date, rows) = parse(&file.content)?;
        let known_file = known.contains(&hash);
        summaries.push(json!({"file_name":file.filename,"kind":kind,"date":date,"rows":rows.len(),"known_file":known_file}));
        if !known_file {
            parsed.push(
                json!({"file_name":file.filename,"hash":hash,"kind":kind,"date":date,"rows":rows}),
            );
        }
    }
    let t = token();
    let preview = json!({"token":t,"created_at":Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),"files":summaries,"imports":parsed});
    write(preview_path(paths, &t), &preview)?;
    Ok(public_preview(&preview))
}
fn parse(bytes: &[u8]) -> Result<(String, String, Vec<Value>)> {
    let mut wb: Xlsx<_> = Xlsx::new(Cursor::new(bytes))?;
    let range = wb
        .worksheet_range_at(0)
        .ok_or_else(|| anyhow::anyhow!("工作簿没有工作表"))??;
    let mut it = range.rows();
    let headers: Vec<String> = it
        .next()
        .ok_or_else(|| anyhow::anyhow!("缺少表头"))?
        .iter()
        .map(text)
        .collect();
    let id = headers
        .iter()
        .position(|v| v == "商品ID" || v == "SKU")
        .ok_or_else(|| anyhow::anyhow!("未识别模板：缺少 商品ID 或 SKU"))?;
    let is_ops = headers.iter().any(|v| v == "成交金额");
    let kind = if is_ops {
        "product_performance"
    } else {
        "inventory"
    };
    let date_i = headers
        .iter()
        .position(|v| v == "时间")
        .ok_or_else(|| anyhow::anyhow!("缺少时间列"))?;
    let mut rows = Vec::new();
    let mut d = String::new();
    for row in it {
        let key = text(row.get(id).unwrap_or(&Data::Empty));
        if key.is_empty() || key == "合计" || key == "-" {
            continue;
        };
        let row_date = date(row.get(date_i).unwrap_or(&Data::Empty));
        if d.is_empty() {
            d = row_date.clone()
        }
        let mut payload = Map::new();
        for (i, h) in headers.iter().enumerate() {
            let cell = row.get(i).unwrap_or(&Data::Empty);
            let value = if h.contains("率") || h.contains("环比") {
                json!(text(cell))
            } else if matches!(cell, Data::Int(_) | Data::Float(_)) {
                json!(num(cell))
            } else {
                json!(text(cell))
            };
            payload.insert(h.clone(), value);
        }
        payload.insert("product_id".to_string(), json!(key));
        payload.insert("date".to_string(), json!(row_date));
        rows.push(Value::Object(payload));
    }
    if d.is_empty() || rows.is_empty() {
        bail!("文件没有可导入的数据行")
    };
    Ok((kind.to_string(), d, rows))
}
fn public_preview(v: &Value) -> Value {
    json!({"preview_token":v["token"],"files":v["files"],"summary":{"new_files":v["imports"].as_array().map_or(0,Vec::len),"rows":v["imports"].as_array().into_iter().flatten().map(|x|x["rows"].as_array().map_or(0,Vec::len)).sum::<usize>()}})
}

pub fn imported_batches(paths: &RuntimePaths) -> Result<Vec<Value>> {
    Ok(read_json_file(&ledger_path(paths))?
        .and_then(|ledger| ledger["batches"].as_array().cloned())
        .unwrap_or_default())
}

pub fn inventory_snapshot(paths: &RuntimePaths) -> Result<Option<Value>> {
    let mut inventory = Vec::new();
    let mut sales_7d = Vec::new();
    let mut inbound_30d = Vec::new();
    let mut captured_at = String::new();

    for batch in imported_batches(paths)? {
        if batch["kind"] != "inventory" {
            continue;
        }
        let snapshot_date = text_value(batch.get("date"));
        captured_at = captured_at.max(text_value(batch.get("imported_at")));
        let source_rows = batch["rows"].as_array().cloned().unwrap_or_default();
        let has_physical_warehouse_data = source_rows.iter().any(|source| {
            rdc_warehouses(source).into_iter().any(|warehouse| {
                warehouse != "全国"
                    && [
                        "库存件数",
                        "可用库存",
                        "近7日出库商品件数",
                        "近30日采购入库件数",
                    ]
                    .iter()
                    .any(|suffix| number(source.get(format!("{warehouse}{suffix}"))) != 0.0)
            })
        });
        for source in &source_rows {
            for warehouse in rdc_warehouses(source) {
                let is_rollup = warehouse == "全国" && has_physical_warehouse_data;
                let stock_num = number(source.get(format!("{warehouse}库存件数")));
                let available_num = number(source.get(format!("{warehouse}可用库存")));
                let sold = number(source.get(format!("{warehouse}近7日出库商品件数")));
                let inbound = number(source.get(format!("{warehouse}近30日采购入库件数")));
                if warehouse != "全国"
                    && stock_num == 0.0
                    && available_num == 0.0
                    && sold == 0.0
                    && inbound == 0.0
                {
                    continue;
                }
                let warehouse_name = if is_rollup {
                    "全国汇总".to_string()
                } else {
                    warehouse.clone()
                };
                let sku = text_value(source.get("SKU"));
                let item = json!({
                    "warehouse_no": format!("jd:{warehouse}"),
                    "warehouse_name": warehouse_name,
                    "brand_no": text_value(source.get("品牌")),
                    "brand_name": text_value(source.get("品牌")),
                    "goods_name": text_value(source.get("商品名称")),
                    "spec_no": sku,
                    "stock_num": stock_num,
                    "available_num": available_num,
                    "cost_price": number(source.get("全国采购价")),
                    "last_inout_time": snapshot_date,
                    "is_rollup": is_rollup,
                    "source": "jd_rdc",
                });
                inventory.push(item);
                sales_7d.push(json!({
                    "warehouse_no": format!("jd:{warehouse}"),
                    "spec_no": text_value(source.get("SKU")),
                    "date": snapshot_date,
                    "quantity": sold,
                    "is_rollup": is_rollup,
                    "source": "jd_rdc",
                }));
                inbound_30d.push(json!({
                    "warehouse_no": format!("jd:{warehouse}"),
                    "spec_no": text_value(source.get("SKU")),
                    "date": snapshot_date,
                    "quantity": inbound,
                    "is_rollup": is_rollup,
                    "source": "jd_rdc",
                }));
            }
        }
    }
    if inventory.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({
        "captured_at": if captured_at.is_empty() { Local::now().format("%Y-%m-%dT%H:%M:%S").to_string() } else { captured_at },
        "source": {"jd_rdc": true, "shop_name": SHOP_NAME},
        "inventory": inventory,
        "sales_7d": sales_7d,
        "inbound_30d": inbound_30d,
    })))
}

fn rdc_warehouses(source: &Value) -> Vec<String> {
    source
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            key.strip_suffix("库存件数")
                .filter(|warehouse| !warehouse.is_empty() && number(Some(value)) >= 0.0)
                .map(str::to_string)
        })
        .collect()
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0),
        Some(Value::String(value)) => value.replace(',', "").parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn commit_preview(paths: &RuntimePaths, t: &str) -> Result<Value> {
    let path = preview_path(paths, t);
    let p = read_json_file(&path)?.ok_or_else(|| anyhow::anyhow!("导入预览已失效"))?;
    let mut ledger = read_json_file(&ledger_path(paths))?.unwrap_or_else(|| json!({"batches":[]}));
    let batches = ledger["batches"].as_array_mut().unwrap();
    for item in p["imports"].as_array().into_iter().flatten() {
        batches.retain(|b| !(b["kind"] == item["kind"] && b["date"] == item["date"]));
        let mut item = item.clone();
        item["imported_at"] = json!(Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        batches.push(item);
    }
    write(ledger_path(paths), &ledger)?;
    let _ = fs::remove_file(path);
    Ok(json!({
        "imported_files": p["imports"].as_array().map_or(0, Vec::len),
        "imported_rows": p["imports"].as_array().into_iter().flatten().map(|item| item["rows"].as_array().map_or(0, Vec::len)).sum::<usize>(),
    }))
}
pub fn dashboard(paths: &RuntimePaths) -> Result<Value> {
    let ledger = read_json_file(&ledger_path(paths))?.unwrap_or_else(|| json!({"batches":[]}));
    let mut perf = Vec::new();
    let mut inv = Vec::new();
    for b in ledger["batches"].as_array().into_iter().flatten() {
        let rows = b["rows"].as_array().cloned().unwrap_or_default();
        if b["kind"] == "product_performance" {
            perf.extend(rows)
        } else {
            inv.extend(rows)
        }
    }
    let mut revenue = 0.;
    let mut visitors = 0.;
    let mut units = 0.;
    for r in &perf {
        revenue += r["成交金额"].as_f64().unwrap_or(0.);
        visitors += r["访客数"].as_f64().unwrap_or(0.);
        units += r["成交商品件数"].as_f64().unwrap_or(0.)
    }
    let performance_by_id = perf
        .iter()
        .filter_map(|row| {
            let id = row.get("product_id")?.as_str()?.to_string();
            Some((
                id,
                json!({"成交金额": row["成交金额"], "访客数": row["访客数"], "成交商品件数": row["成交商品件数"]}),
            ))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut risks: Vec<Value> = inv
        .iter()
        .filter(|r| r["全国预计可售天数"].as_f64().unwrap_or(999.) < 7.)
        .cloned()
        .collect();
    risks.sort_by(|a, b| {
        a["全国预计可售天数"]
            .as_f64()
            .partial_cmp(&b["全国预计可售天数"].as_f64())
            .unwrap()
    });
    for risk in &mut risks {
        if let Some(item) = risk.as_object_mut() {
            let id = item.get("product_id").and_then(Value::as_str).unwrap_or("");
            if let Some(performance) = performance_by_id.get(id) {
                item.insert("经营表现".to_string(), performance.clone());
            }
        }
    }
    Ok(
        json!({"summary":{"product_rows":perf.len(),"inventory_rows":inv.len(),"revenue":revenue,"visitors":visitors,"units":units},"products":perf,"inventory_risks":risks.into_iter().take(100).collect::<Vec<_>>(),"batches":ledger["batches"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn keeps_national_inventory_when_the_file_has_no_city_warehouse_values() {
        let root = std::env::temp_dir().join(format!(
            "luopan-jd-national-inventory-test-{}",
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
        write(
            ledger_path(&paths),
            &json!({"batches":[{"kind":"inventory","date":"2026-08-02","rows":[{
                "SKU":"sku-1", "商品名称":"商品 1", "品牌":"GNC", "全国库存件数":10,
                "全国可用库存":8, "全国近7日出库商品件数":2, "全国近30日采购入库件数":1,
                "上海库存件数":"", "上海可用库存":""
            }]}]}),
        )
        .unwrap();

        let snapshot = inventory_snapshot(&paths).unwrap().unwrap();
        assert_eq!(snapshot["inventory"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["inventory"][0]["warehouse_name"], "全国");
        assert_eq!(snapshot["inventory"][0]["is_rollup"], false);
        assert_eq!(snapshot["sales_7d"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["sales_7d"][0]["source"], "jd_rdc");
        assert_eq!(snapshot["inbound_30d"][0]["source"], "jd_rdc");
        let _ = fs::remove_dir_all(root);
    }
}
