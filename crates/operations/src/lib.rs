use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result};
use luopan_runtime::{RuntimePaths, read_json_file};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OperationRecord {
    pub shop_id: String,
    pub shop_name: String,
    pub date: String,
    pub captured_at: String,
    pub metrics: Map<String, Value>,
    pub content: Map<String, Value>,
    pub trend: Map<String, Value>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    pub source_file: String,
}

pub fn load_operations_records(paths: &RuntimePaths) -> Result<Vec<OperationRecord>> {
    let aliases = load_shop_aliases(paths)?;
    Ok(merge_records(vec![
        load_daily_records(paths, &aliases)?,
        load_external_order_records(paths, &aliases)?,
    ]))
}

pub fn load_shop_aliases(paths: &RuntimePaths) -> Result<BTreeMap<String, String>> {
    let path = paths.config_dir.join("shops.local.json");
    let Some(payload) = read_json_file(&path)? else {
        return Ok(BTreeMap::new());
    };
    Ok(payload
        .get("aliases")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(raw, display)| {
            let display = display.as_str()?.trim();
            (!raw.trim().is_empty() && !display.is_empty())
                .then(|| (raw.trim().to_string(), display.to_string()))
        })
        .collect())
}

pub fn apply_shop_aliases(records: &mut [OperationRecord], aliases: &BTreeMap<String, String>) {
    for record in records {
        if let Some(display) = aliases.get(&record.shop_name) {
            record.shop_name = display.clone();
        }
    }
}

fn load_daily_records(
    paths: &RuntimePaths,
    aliases: &BTreeMap<String, String>,
) -> Result<Vec<OperationRecord>> {
    let daily_root = paths.output_dir.join("daily");
    if !daily_root.exists() {
        return Ok(Vec::new());
    }

    let mut payload_paths = Vec::new();
    collect_daily_payload_paths(&daily_root, &mut payload_paths)?;
    payload_paths.sort();

    let mut records_by_key: BTreeMap<(String, String), OperationRecord> = BTreeMap::new();
    for path in payload_paths {
        let Some(payload) = read_json_file(&path)? else {
            continue;
        };
        let captured_at = string_value(payload.get("captured_at")).unwrap_or_default();
        let source_file = path.to_string_lossy().to_string();
        let Some(results) = payload.get("results").and_then(Value::as_array) else {
            continue;
        };

        for item in results {
            let raw_shop_name =
                string_value(item.get("shop_name")).unwrap_or_else(|| "当前店铺".to_string());
            let shop_name = aliases
                .get(&raw_shop_name)
                .cloned()
                .unwrap_or(raw_shop_name);
            let Some(date) = parse_daily_date(
                string_value(item.get("data_end"))
                    .or_else(|| string_value(item.get("data_start")))
                    .as_deref(),
            ) else {
                continue;
            };
            let metrics = daily_metrics(item.get("metrics"));
            if metrics.is_empty() {
                continue;
            }

            let key = (shop_name.clone(), date.clone());
            if let Some(previous) = records_by_key.get(&key)
                && previous.captured_at >= captured_at
            {
                continue;
            }

            records_by_key.insert(
                key,
                OperationRecord {
                    shop_id: shop_name.clone(),
                    shop_name,
                    date,
                    captured_at: captured_at.clone(),
                    metrics,
                    content: extract_daily_content(string_value(item.get("raw_text")).as_deref()),
                    trend: Map::new(),
                    source: "daily_json".to_string(),
                    source_key: None,
                    source_label: None,
                    source_file: source_file.clone(),
                },
            );
        }
    }

    Ok(records_by_key.into_values().collect())
}

fn collect_daily_payload_paths(root: &Path, paths: &mut Vec<std::path::PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_daily_payload_paths(&path, paths)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("compass_daily_") && name.ends_with(".json"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn load_external_order_records(
    paths: &RuntimePaths,
    aliases: &BTreeMap<String, String>,
) -> Result<Vec<OperationRecord>> {
    let path = paths
        .output_dir
        .join("external_orders")
        .join("orders_daily.json");
    let Some(payload) = read_json_file(&path)? else {
        return Ok(Vec::new());
    };
    let captured_at = string_value(payload.get("generated_at")).unwrap_or_default();
    let Some(rows) = payload.get("records").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    let mut records = Vec::new();
    for item in rows {
        let source_key =
            string_value(item.get("source_key")).unwrap_or_else(|| "external_orders".to_string());
        let raw_shop_name = string_value(item.get("shop_name")).unwrap_or_default();
        let shop_name = canonical_external_shop_name(aliases, &raw_shop_name);
        let shop_id = string_value(item.get("shop_id"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("external:{source_key}:{shop_name}"));
        let Some(date) = parse_daily_date(string_value(item.get("date")).as_deref()) else {
            continue;
        };
        let metrics = item
            .get("metrics")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if shop_id.is_empty() || shop_name.is_empty() || metrics.is_empty() {
            continue;
        }
        records.push(OperationRecord {
            shop_id,
            shop_name,
            date,
            captured_at: captured_at.clone(),
            metrics,
            content: Map::new(),
            trend: Map::new(),
            source: "external_orders".to_string(),
            source_key: Some(source_key),
            source_label: Some(
                string_value(item.get("source_label")).unwrap_or_else(|| "订单明细".to_string()),
            ),
            source_file: string_value(item.get("source_file")).unwrap_or_default(),
        });
    }
    Ok(records)
}

fn canonical_external_shop_name(aliases: &BTreeMap<String, String>, shop_name: &str) -> String {
    aliases
        .get(shop_name)
        .cloned()
        .unwrap_or_else(|| shop_name.to_string())
}

fn merge_records(record_groups: Vec<Vec<OperationRecord>>) -> Vec<OperationRecord> {
    let mut merged: BTreeMap<(String, String), OperationRecord> = BTreeMap::new();
    for records in record_groups {
        for record in records {
            let key = (record.shop_id.clone(), record.date.clone());
            let Some(existing) = merged.get(&key) else {
                merged.insert(key, record);
                continue;
            };
            let prefer_record = (record.source == "daily_json" && existing.source != "daily_json")
                || record.captured_at >= existing.captured_at;
            if prefer_record {
                let mut next = record;
                if next.content.is_empty() {
                    next.content = existing.content.clone();
                }
                if next.trend.is_empty() {
                    next.trend = existing.trend.clone();
                }
                merged.insert(key, next);
            }
        }
    }

    let daily_dates: std::collections::BTreeSet<String> = merged
        .values()
        .filter(|record| record.source == "daily_json")
        .map(|record| record.date.clone())
        .collect();

    let mut records: Vec<OperationRecord> = merged
        .into_values()
        .filter(|record| {
            !(record.source != "daily_json"
                && daily_dates.contains(&record.date)
                && matches!(record.shop_id.as_str(), "unknown" | ""))
        })
        .collect();
    records.sort_by(|a, b| {
        (a.date.as_str(), a.shop_name.as_str()).cmp(&(b.date.as_str(), b.shop_name.as_str()))
    });
    records
}

fn daily_metrics(value: Option<&Value>) -> Map<String, Value> {
    let mut metrics = Map::new();
    let Some(raw_metrics) = value.and_then(Value::as_object) else {
        return metrics;
    };

    for (label, raw_value) in raw_metrics {
        let Some((code, kind)) = daily_metric_mapping(label) else {
            continue;
        };
        let Some(parsed) =
            parse_daily_metric(raw_value.as_str().unwrap_or(&raw_value.to_string()), kind)
        else {
            continue;
        };
        metrics.insert(code.to_string(), json_number(parsed));
    }
    metrics
}

fn daily_metric_mapping(label: &str) -> Option<(&'static str, &'static str)> {
    Some(match label {
        "成交金额" => ("income_amt", "money"),
        "用户支付金额" => ("pay_amt", "money"),
        "平台补贴金额" => ("platform_subsidy_amt", "money"),
        "达人补贴金额" => ("talent_subsidy_amt", "money"),
        "结算金额" => ("settlement_amt_pay_time", "money"),
        "7日结算金额" => ("settlement_amt_7d", "money"),
        "14日结算金额" => ("settlement_amt_14d", "money"),
        "成交订单数" => ("pay_cnt", "count"),
        "成交件数" => ("pay_item_cnt", "count"),
        "件单价" => ("per_item_pay_amt", "money"),
        "商品曝光人数" => ("product_show_ucnt", "count"),
        "商品点击人数" => ("product_click_ucnt", "count"),
        "商品曝光次数" => ("product_show_cnt", "count"),
        "商品点击次数" => ("product_click_cnt", "count"),
        "客单价" => ("per_usr_pay_amt", "money"),
        "成交人数" => ("pay_ucnt", "count"),
        "退款金额（退款时间）" => ("refund_amt", "money"),
        "退款金额（支付时间）" => ("refund_amt_pay_time", "money"),
        "退款率（支付时间）" => ("refund_amt_rate", "ratio"),
        "成交退款金额（支付时间）" => ("deal_refund_amt_pay_time", "money"),
        "成交退款金额（退款时间）" => ("rfndsuc_amt", "money"),
        "退款订单数（退款时间）" => ("refund_order_cnt", "count"),
        "退款订单数（支付时间）" => ("refund_order_cnt_pay_time", "count"),
        "商品曝光-点击转化率（人数）" => ("product_show_click_ucnt_ratio", "ratio"),
        "商品点击-成交转化率（人数）" => ("product_click_pay_ucnt_ratio", "ratio"),
        "商品曝光-成交转化率（人数）" => ("product_show_pay_ucnt_ratio", "ratio"),
        "商品曝光-点击转化率（次数）" => ("product_show_click_cnt_ratio", "ratio"),
        "商品点击-成交转化率（次数）" => ("product_click_pay_cnt_ratio", "ratio"),
        "商品曝光-成交转化率（次数）" => ("product_show_pay_cnt_ratio", "ratio"),
        "千次曝光用户支付金额" => ("pay_amt_per_k_show", "money"),
        "支出金额" => ("expense_amt", "money"),
        "投放消耗（店铺被投）" => ("ad_cost_amt", "money"),
        "达人佣金（财务已结算）" => ("talent_commission_amt", "money"),
        "平台佣金（财务已结算）" => ("platform_commission_amt", "money"),
        "商家体验分" => ("service_score", "score"),
        _ => return None,
    })
}

fn parse_daily_metric(value: &str, kind: &str) -> Option<f64> {
    let number = parse_number(value)?;
    Some(match kind {
        "money" => number * 100.0,
        "ratio" => number / 100.0,
        _ => number,
    })
}

fn parse_number(value: &str) -> Option<f64> {
    let text = value.trim();
    if text.is_empty() || text == "-" {
        return None;
    }
    let multiplier = if text.contains('万') { 10000.0 } else { 1.0 };
    let cleaned: String = text
        .replace(',', "")
        .chars()
        .filter(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-'))
        .collect();
    if cleaned.is_empty() || matches!(cleaned.as_str(), "-" | ".") {
        return None;
    }
    cleaned.parse::<f64>().ok().map(|value| value * multiplier)
}

fn extract_daily_content(raw_text: Option<&str>) -> Map<String, Value> {
    let mut content = Map::new();
    let Some(raw_text) = raw_text else {
        return content;
    };
    let lines = section(&compact_lines(raw_text), "载体分布", "收支概况");
    for (label, code) in [
        ("直播", "live"),
        ("商品卡", "product_card"),
        ("短视频", "video"),
        ("图文", "artc_video"),
    ] {
        if let Some(value) = money_after(&lines, label) {
            content.insert(code.to_string(), json_number(value));
        }
    }
    if let Some(value) = other_content_amount(raw_text) {
        content.insert("other_content".to_string(), json_number(value));
    }
    content
}

fn compact_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

fn section(lines: &[String], start_label: &str, end_label: &str) -> Vec<String> {
    let Some(start) = lines
        .iter()
        .position(|line| line == start_label)
        .map(|index| index + 1)
    else {
        return Vec::new();
    };
    let end = lines[start..]
        .iter()
        .position(|line| line == end_label)
        .map(|offset| start + offset)
        .unwrap_or(lines.len());
    lines[start..end].to_vec()
}

fn money_after(lines: &[String], label: &str) -> Option<f64> {
    lines
        .windows(2)
        .find(|window| window[0] == label)
        .and_then(|window| parse_daily_metric(&window[1], "money"))
}

fn other_content_amount(raw_text: &str) -> Option<f64> {
    let marker = "其他成交金额";
    let start = raw_text.find(marker)? + marker.len();
    let rest = &raw_text[start..];
    let amount: String = rest
        .chars()
        .skip_while(|ch| ch.is_whitespace())
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '¥' | ',' | '.' | '万'))
        .collect();
    parse_daily_metric(&amount, "money")
}

fn parse_daily_date(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    Some(value.replace('/', "-"))
}

fn string_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn json_number(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_money_ratio_count_and_wan_values() {
        assert_eq!(parse_daily_metric("¥1,741.24", "money"), Some(174124.0));
        assert!((parse_daily_metric("5.95%", "ratio").unwrap() - 0.0595).abs() < 0.000001);
        assert_eq!(parse_daily_metric("1.16万", "count"), Some(11600.0));
        assert_eq!(parse_daily_metric("-", "money"), None);
    }

    #[test]
    fn canonicalizes_shop_name_from_configured_alias() {
        let aliases = BTreeMap::from([("原始店铺名".to_string(), "统一展示名".to_string())]);
        assert_eq!(
            canonical_external_shop_name(&aliases, "原始店铺名"),
            "统一展示名"
        );
        assert_eq!(
            canonical_external_shop_name(&aliases, "未配置店铺"),
            "未配置店铺"
        );
    }
}
