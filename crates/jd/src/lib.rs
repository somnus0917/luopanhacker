use anyhow::{Context, Result, bail};
use calamine::{Data, DataType, Reader, Xlsx};
use chrono::Local;
use luopan_runtime::{RuntimePaths, read_json_file};
use rand_core::{OsRng, RngCore};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::PathBuf};

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
pub fn commit_preview(paths: &RuntimePaths, t: &str) -> Result<Value> {
    let path = preview_path(paths, t);
    let p = read_json_file(&path)?.ok_or_else(|| anyhow::anyhow!("导入预览已失效"))?;
    let mut ledger = read_json_file(&ledger_path(paths))?.unwrap_or_else(|| json!({"batches":[]}));
    let batches = ledger["batches"].as_array_mut().unwrap();
    for item in p["imports"].as_array().into_iter().flatten() {
        batches.retain(|b| !(b["kind"] == item["kind"] && b["date"] == item["date"]));
        batches.push(item.clone());
    }
    write(ledger_path(paths), &ledger)?;
    let _ = fs::remove_file(path);
    dashboard(paths)
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
