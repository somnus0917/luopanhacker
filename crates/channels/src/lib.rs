use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result};
use luopan_runtime::{RuntimePaths, read_json_file};
use serde_json::{Map, Value, json};

const FLOW_OVERVIEW: &str = "/compass_api/shop/common/flow/overview";
const FLOW_DISTRIBUTION: &str = "/compass_api/shop/common/flow/distribution";
const FLOW_CHANNEL_LIST: &str = "/compass_api/shop/common/flow/channel_list";
const HOMEPAGE_PRODUCT_LIST: &str = "/compass_api/shop/common/homepage/product_list";
const PRODUCT_LIST: &str =
    "/compass_api/shop/product_card/channel_product/channel_product_card_list";
const SEARCH_SOURCE: &str = "/compass_api/shop/common/homepage/search/source";
const SEARCH_SHOP_RANK: &str = "/compass_api/shop/common/homepage/search_shop_rank";
const SEARCH_INDUSTRY_RANK: &str = "/compass_api/shop/common/homepage/search_industry_rank";
const SEARCH_WEEKLY_SUMMARY: &str =
    "/compass_api/shop/mall/dd_search/search_analysis/weekly_report_summary";

pub fn load_channel_dashboard(paths: &RuntimePaths) -> Result<Value> {
    let root = paths.output_dir.join("channel");
    let mut payload_paths = Vec::new();
    if root.exists() {
        collect_payload_paths(&root, &mut payload_paths)?;
    }
    payload_paths.sort();

    let mut records: BTreeMap<(String, String), Value> = BTreeMap::new();
    for path in payload_paths {
        let Some(payload) = read_json_file(&path)? else {
            continue;
        };
        let captured_at = string_at(&payload, &["captured_at"]).unwrap_or_default();
        for result in payload
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(record) = parse_record(result, &captured_at) else {
                continue;
            };
            let shop_name = string_at(&record, &["shop_name"]).unwrap_or_default();
            let date = string_at(&record, &["date"]).unwrap_or_default();
            let key = (shop_name, date);
            let replace = records
                .get(&key)
                .and_then(|previous| string_at(previous, &["captured_at"]))
                .is_none_or(|previous| previous <= captured_at);
            if replace {
                records.insert(key, record);
            }
        }
    }

    let records = records.into_values().collect::<Vec<_>>();
    let shops = records
        .iter()
        .filter_map(|record| string_at(record, &["shop_name"]))
        .collect::<std::collections::BTreeSet<_>>();
    let dates = records
        .iter()
        .filter_map(|record| string_at(record, &["date"]))
        .collect::<std::collections::BTreeSet<_>>();
    Ok(json!({
        "generated_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "records": records,
        "summary": {
            "record_count": records.len(),
            "shops": shops,
            "dates": dates,
        }
    }))
}

/// Load the latest sanitized Compass snapshots for the live, video and
/// product-card panels. Response bodies deliberately remain on disk; the API
/// exposes only panel metadata until each metric has an explicit data contract.
pub fn load_douyin_dashboard(paths: &RuntimePaths) -> Result<Value> {
    let root = paths.output_dir.join("douyin");
    let mut payload_paths = Vec::new();
    if root.exists() {
        collect_named_payload_paths(&root, "compass_douyin_", &mut payload_paths)?;
    }
    payload_paths.sort();

    let mut records: BTreeMap<(String, String), Value> = BTreeMap::new();
    for path in payload_paths {
        let Some(payload) = read_json_file(&path)? else {
            continue;
        };
        let captured_at = string_at(&payload, &["captured_at"]).unwrap_or_default();
        for result in payload
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(shop_name) = string_at(result, &["shop_name"]) else {
                continue;
            };
            let Some(date) = result
                .get("panels")
                .and_then(Value::as_array)
                .and_then(|panels| {
                    panels
                        .iter()
                        .filter_map(|panel| string_at(panel, &["data_end"]))
                        .max()
                })
                .map(|value| normalize_date(&value))
            else {
                continue;
            };
            let panels = result
                .get("panels")
                .and_then(Value::as_array)
                .map(|panels| panels.iter().map(douyin_panel_summary).collect::<Vec<_>>())
                .unwrap_or_default();
            let record = json!({
                "shop_id": shop_name,
                "shop_name": shop_name,
                "date": date,
                "captured_at": captured_at,
                "panels": panels,
                "errors": result.get("errors").cloned().unwrap_or_else(|| json!([])),
            });
            let key = (shop_name, date);
            let replace = records
                .get(&key)
                .and_then(|previous| string_at(previous, &["captured_at"]))
                .is_none_or(|previous| previous <= captured_at);
            if replace {
                records.insert(key, record);
            }
        }
    }
    let records = records.into_values().collect::<Vec<_>>();
    let shops = records
        .iter()
        .filter_map(|record| string_at(record, &["shop_name"]))
        .collect::<std::collections::BTreeSet<_>>();
    let dates = records
        .iter()
        .filter_map(|record| string_at(record, &["date"]))
        .collect::<std::collections::BTreeSet<_>>();
    Ok(json!({
        "generated_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "records": records,
        "summary": { "record_count": records.len(), "shops": shops, "dates": dates }
    }))
}

fn douyin_panel_summary(panel: &Value) -> Value {
    let responses = panel.get("responses").and_then(Value::as_array);
    let endpoints = responses
        .into_iter()
        .flatten()
        .filter_map(|response| string_at(response, &["endpoint"]))
        .collect::<std::collections::BTreeSet<_>>();
    json!({
        "panel": string_at(panel, &["panel"]),
        "label": string_at(panel, &["label"]),
        "data_start": string_at(panel, &["data_start"]),
        "data_end": string_at(panel, &["data_end"]),
        "response_count": responses.map_or(0, Vec::len),
        "endpoints": endpoints,
    })
}

fn collect_payload_paths(root: &Path, paths: &mut Vec<std::path::PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_payload_paths(&path, paths)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("compass_channel_") && name.ends_with(".json"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn collect_named_payload_paths(
    root: &Path,
    prefix: &str,
    paths: &mut Vec<std::path::PathBuf>,
) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_named_payload_paths(&path, prefix, paths)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".json"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn parse_record(result: &Value, captured_at: &str) -> Option<Value> {
    let shop_name = string_at(result, &["shop_name"])?;
    let date = normalize_date(
        string_at(result, &["data_end"])
            .or_else(|| string_at(result, &["data_start"]))?
            .as_str(),
    );
    let responses = result.get("responses")?.as_array()?;

    let flow_overview =
        response_body(responses, FLOW_OVERVIEW, Some("date_type=20")).map(parse_flow_overview);
    let distribution = response_body(responses, FLOW_DISTRIBUTION, Some("date_type=20"))
        .map(parse_flow_distribution);
    let channel_list = response_body(responses, FLOW_CHANNEL_LIST, Some("date_type=20"))
        .map(parse_channel_list)
        .unwrap_or_default();
    let mut products = response_body(responses, PRODUCT_LIST, Some("date_type=20"))
        .map(parse_products)
        .unwrap_or_default();
    if products.is_empty() {
        products = response_body(responses, HOMEPAGE_PRODUCT_LIST, Some("date_type=20"))
            .map(parse_homepage_products)
            .unwrap_or_default();
    }

    let search_source_response = response_for(responses, SEARCH_SOURCE, None);
    let search_sources = search_source_response
        .and_then(|response| response.get("body"))
        .map(parse_search_sources)
        .unwrap_or_default();
    let shop_terms = response_body(responses, SEARCH_SHOP_RANK, None)
        .map(|body| parse_search_terms(body, false))
        .unwrap_or_default();
    let industry_terms = response_body(responses, SEARCH_INDUSTRY_RANK, None)
        .map(|body| parse_search_terms(body, true))
        .unwrap_or_default();
    let weekly_summary = response_body(responses, SEARCH_WEEKLY_SUMMARY, None)
        .and_then(|body| body.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    let search_period = search_source_response
        .and_then(|response| response.get("url"))
        .and_then(Value::as_str)
        .map(parse_request_period)
        .unwrap_or_default();

    if flow_overview.is_none()
        && distribution.is_none()
        && products.is_empty()
        && search_sources.is_empty()
        && shop_terms.is_empty()
    {
        return None;
    }

    let mut traffic = Map::new();
    if let Some(Value::Object(values)) = flow_overview {
        traffic.extend(values);
    }
    if let Some(Value::Object(values)) = distribution {
        traffic.extend(values);
    }
    traffic.insert("available_channels".to_string(), Value::Array(channel_list));

    Some(json!({
        "shop_id": shop_name,
        "shop_name": shop_name,
        "date": date,
        "captured_at": captured_at,
        "traffic": traffic,
        "products": products,
        "search": {
            "period": search_period,
            "sources": search_sources,
            "shop_terms": shop_terms,
            "industry_terms": industry_terms,
            "weekly_summary": weekly_summary,
        },
    }))
}

fn response_for<'a>(
    responses: &'a [Value],
    endpoint: &str,
    url_contains: Option<&str>,
) -> Option<&'a Value> {
    responses.iter().rev().find(|response| {
        response.get("endpoint").and_then(Value::as_str) == Some(endpoint)
            && url_contains.is_none_or(|part| {
                response
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| url.contains(part))
            })
    })
}

fn response_body<'a>(
    responses: &'a [Value],
    endpoint: &str,
    url_contains: Option<&str>,
) -> Option<&'a Value> {
    response_for(responses, endpoint, url_contains)?.get("body")
}

fn parse_flow_overview(body: &Value) -> Value {
    let modules = value_at(body, &["data", "module_data"])
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut carriers = Map::new();
    for (source, code) in [
        ("shop_all", "all"),
        ("self_employed_live_room", "live"),
        ("self_employed_video", "short_video"),
        ("self_employed_product_card", "product_card"),
        ("cooperate_talent", "talent"),
        ("self_employed_artc_video", "article"),
        ("self_employed_other", "other"),
    ] {
        let Some(module) = modules.get(source) else {
            continue;
        };
        let Some(row) = value_at(
            module,
            &["compass_general_multi_index_card_value", "data", "0"],
        )
        .and_then(Value::as_object) else {
            continue;
        };
        let mut metrics = Map::new();
        for (name, cell) in row {
            if let Some(value) = value_at(cell, &["index_value", "value", "value"]).cloned() {
                metrics.insert(name.clone(), value);
            }
            if let Some(value) =
                value_at(cell, &["index_value", "out_period_ratio", "value"]).cloned()
            {
                metrics.insert(format!("{name}_change"), value);
            }
            if let Some(value) = value_at(cell, &["index_value", "benchmark", "value"]).cloned() {
                metrics.insert(format!("{name}_benchmark"), value);
            }
        }
        carriers.insert(code.to_string(), Value::Object(metrics));
    }
    json!({"carriers": carriers})
}

fn parse_flow_distribution(body: &Value) -> Value {
    let card = value_at(
        body,
        &[
            "data",
            "module_data",
            "flow_source_distribution",
            "compass_general_multi_index_card_value",
        ],
    );
    let Some(card) = card else {
        return json!({"sources": [], "groups": {}});
    };
    let meta = card
        .get("basic_meta")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let row = card
        .get("data")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut sources = Vec::new();
    let mut total = 0.0;
    for item in meta {
        let code = string_at(&item, &["index_name"]).unwrap_or_default();
        let name = string_at(&item, &["index_display"]).unwrap_or_else(|| code.clone());
        let Some(index_value) = row.get(&code).and_then(|value| value.get("index_value")) else {
            continue;
        };
        let value = number_at(index_value, &["value", "value"]).unwrap_or(0.0);
        let parent = string_at(index_value, &["extra_value", "group_name", "value_str"]);
        if parent.is_none() {
            total += value;
        }
        sources.push(json!({
            "code": code,
            "name": name,
            "group": channel_group(&name),
            "parent": parent,
            "value": value,
            "source_ratio": number_at(index_value, &["value_ratio", "value"]),
        }));
    }

    let mut group_values = BTreeMap::<String, (f64, f64)>::new();
    for source in &sources {
        let group = string_at(source, &["group"]).unwrap_or_else(|| "other".to_string());
        if group == "other" {
            continue;
        }
        let value = number_at(source, &["value"]).unwrap_or(0.0);
        let ratio = number_at(source, &["source_ratio"]).unwrap_or(0.0);
        let entry = group_values.entry(group).or_default();
        entry.0 += value;
        entry.1 += ratio;
    }
    for group in ["organic_search", "recommendation", "paid", "short_video"] {
        group_values.entry(group.to_string()).or_default();
    }
    let groups = group_values
        .into_iter()
        .map(|(group, (value, ratio))| (group, json!({"value": value, "ratio": ratio})))
        .collect::<Map<_, _>>();
    json!({"source_metric": "product_show_ucnt", "source_total": total, "sources": sources, "groups": groups})
}

fn parse_channel_list(body: &Value) -> Vec<Value> {
    body.get("channel_list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            let name = string_at(item, &["channel_name"]).unwrap_or_default();
            json!({
                "name": name,
                "channel_type": item.get("channel_type"),
                "sub_channel_code": item.get("sub_channel_code"),
                "group": channel_group(&name),
            })
        })
        .collect()
}

fn parse_products(body: &Value) -> Vec<Value> {
    body.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let cells = row.get("cell_info")?;
            let product = cells.get("product")?;
            let product_id = nested_value_str(product, "product_id_value")?;
            Some(json!({
                "product_id": product_id,
                "product_name": nested_value_str(product, "product_name_value"),
                "product_image": nested_value_str(product, "product_img_value"),
                "product_price": nested_value_number(product, "product_price_value"),
                "pay_amt": table_metric(cells, "pay_amt", "value"),
                "pay_amt_change": table_metric(cells, "pay_amt", "out_period_ratio"),
                "pay_cnt": table_metric(cells, "pay_cnt", "value"),
                "pay_ucnt": table_metric(cells, "pay_ucnt", "value"),
                "show_ucnt": table_metric(cells, "product_show_ucnt", "value"),
                "show_ucnt_change": table_metric(cells, "product_show_ucnt", "out_period_ratio"),
                "click_ucnt": table_metric(cells, "product_click_ucnt", "value"),
                "click_rate": table_metric(cells, "product_click_ucnt_rate", "value"),
                "click_pay_rate": table_metric(cells, "pay_converse_rate_ucnt", "value"),
                "first_onshelf_date": table_metric_str(cells, "first_onshelf_date", "value"),
            }))
        })
        .collect()
}

fn parse_homepage_products(body: &Value) -> Vec<Value> {
    body.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let cells = row.get("cell_info")?;
            let product = value_at(
                cells,
                &["product_info", "product_info_children", "children", "0", "cell_info"],
            )?;
            let product_id = string_at(product, &["id", "id_value", "value", "value_str"])?;
            Some(json!({
                "product_id": product_id,
                "product_name": string_at(product, &["name", "name_value", "value", "value_str"]),
                "product_image": string_at(product, &["image", "image_value", "value", "value_str"]),
                "product_price": table_metric(cells, "per_customer_transaction", "value"),
                "pay_amt": table_metric(cells, "pay_amt", "value"),
                "pay_amt_change": table_metric(cells, "pay_amt", "out_period_ratio"),
                "pay_cnt": Value::Null,
                "pay_ucnt": table_metric(cells, "pay_ucnt", "value"),
                "show_ucnt": table_metric(cells, "product_show_ucnt", "value"),
                "show_ucnt_change": table_metric(cells, "product_show_ucnt", "out_period_ratio"),
                "click_ucnt": Value::Null,
                "click_rate": Value::Null,
                "click_pay_rate": Value::Null,
                "first_onshelf_date": Value::Null,
            }))
        })
        .collect()
}

fn parse_search_sources(body: &Value) -> Vec<Value> {
    value_at(
        body,
        &[
            "data",
            "module_data",
            "search_source_table",
            "compass_general_table_value",
            "data",
        ],
    )
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(|row| {
        let cells = row.get("cell_info")?;
        Some(json!({
            "name": string_at(cells, &["search_source", "value", "value_str"]),
            "show_ucnt": number_at(cells, &["search_show_ucnt", "index_values", "value", "value"]),
            "show_ucnt_change": number_at(cells, &["search_show_ucnt", "index_values", "out_period_ratio", "value"]),
            "show_ucnt_benchmark": number_at(cells, &["search_show_ucnt", "index_values", "benchmark", "value"]),
            "pay_amt": number_at(cells, &["pay_amt", "index_values", "value", "value"]),
            "pay_amt_change": number_at(cells, &["pay_amt", "index_values", "out_period_ratio", "value"]),
            "pay_amt_benchmark": number_at(cells, &["pay_amt", "index_values", "benchmark", "value"]),
        }))
    })
    .collect()
}

fn parse_search_terms(body: &Value, industry: bool) -> Vec<Value> {
    body.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let word = string_at(row, &["base_info", "query_word_info", "word"])?;
            let metrics = row.get("metrics")?;
            Some(json!({
                "word": word,
                "rank": number_at(metrics, &["rank", "value", "value"]),
                "show_ucnt": number_at(metrics, &["search_show_ucnt", "value", "value"]),
                "show_ucnt_change": number_at(metrics, &["search_show_ucnt", "out_period_ratio", "value"]),
                "show_ucnt_lower": industry.then(|| number_at(metrics, &["search_show_ucnt", "extra_value", "lower", "value"])).flatten(),
                "show_ucnt_upper": industry.then(|| number_at(metrics, &["search_show_ucnt", "extra_value", "upper", "value"])).flatten(),
                "pay_amt": number_at(metrics, &["pay_amt", "value", "value"]),
                "pay_amt_change": number_at(metrics, &["pay_amt", "out_period_ratio", "value"]),
                "pay_amt_lower": industry.then(|| number_at(metrics, &["pay_amt", "extra_value", "lower", "value"])).flatten(),
                "pay_amt_upper": industry.then(|| number_at(metrics, &["pay_amt", "extra_value", "upper", "value"])).flatten(),
            }))
        })
        .collect()
}

fn table_metric(cells: &Value, name: &str, value_name: &str) -> Option<f64> {
    cells
        .get(name)?
        .as_object()?
        .values()
        .next()
        .and_then(|wrapper| number_at(wrapper, &["index_values", value_name, "value"]))
}

fn table_metric_str(cells: &Value, name: &str, value_name: &str) -> Option<String> {
    cells
        .get(name)?
        .as_object()?
        .values()
        .next()
        .and_then(|wrapper| string_at(wrapper, &["index_values", value_name, "value_str"]))
}

fn nested_value_str(value: &Value, name: &str) -> Option<String> {
    string_at(value, &[name, "value", "value_str"])
}

fn nested_value_number(value: &Value, name: &str) -> Option<f64> {
    number_at(value, &[name, "value", "value"])
}

fn channel_group(name: &str) -> &'static str {
    if name.contains("全域投广") || name.contains("标准+品牌") {
        "paid"
    } else if name.contains("搜索") {
        "organic_search"
    } else if name.contains("猜你喜欢") || name.contains("推荐") {
        "recommendation"
    } else if name.contains("短视频") {
        "short_video"
    } else {
        "other"
    }
}

fn parse_request_period(url: &str) -> Value {
    json!({
        "date_type": query_value(url, "date_type"),
        "begin_date": query_value(url, "begin_date").map(|value| normalize_date(&value)),
        "end_date": query_value(url, "end_date").map(|value| normalize_date(&value)),
    })
}

fn query_value(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| {
            value
                .replace("%2F", "/")
                .replace("%2f", "/")
                .replace("%3A", ":")
                .replace("%3a", ":")
                .replace('+', " ")
        })
    })
}

fn normalize_date(value: &str) -> String {
    value
        .split_whitespace()
        .next()
        .unwrap_or(value)
        .replace('/', "-")
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = if let Ok(index) = key.parse::<usize>() {
            current.as_array()?.get(index)?
        } else {
            current.get(*key)?
        };
    }
    Some(current)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    value_at(value, path)?.as_str().map(ToString::to_string)
}

fn number_at(value: &Value, path: &[&str]) -> Option<f64> {
    value_at(value, path)?.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_known_channel_names() {
        assert_eq!(channel_group("非投放时段-搜索"), "organic_search");
        assert_eq!(channel_group("非投放时段-猜你喜欢"), "recommendation");
        assert_eq!(channel_group("全域投广时段"), "paid");
        assert_eq!(channel_group("非投放时段-短视频溢出"), "short_video");
    }

    #[test]
    fn parses_sanitized_request_period() {
        let period = parse_request_period(
            "https://example.test/path?date_type=20&begin_date=2026%2F07%2F19+00%3A00%3A00&end_date=2026%2F07%2F19+00%3A00%3A00",
        );
        assert_eq!(period["date_type"], json!("20"));
        assert_eq!(period["begin_date"], json!("2026-07-19"));
        assert_eq!(period["end_date"], json!("2026-07-19"));
    }

    #[test]
    fn parses_homepage_product_fallback() {
        let body = json!({"data": [{"cell_info": {
            "product_info": {"product_info_children": {"children": [{"cell_info": {
                "id": {"id_value": {"value": {"value_str": "p-1"}}},
                "name": {"name_value": {"value": {"value_str": "测试商品"}}}
            }}]}},
            "pay_amt": {"pay_amt_index_values": {"index_values": {"value": {"value": 648770}}}},
            "pay_ucnt": {"pay_ucnt_index_values": {"index_values": {"value": {"value": 1}}}},
            "product_show_ucnt": {"product_show_ucnt_index_values": {"index_values": {
                "value": {"value": 205}, "out_period_ratio": {"value": -0.2}
            }}}
        }}]});
        let products = parse_homepage_products(&body);
        assert_eq!(products.len(), 1);
        assert_eq!(products[0]["product_id"], json!("p-1"));
        assert_eq!(products[0]["pay_amt"], json!(648770.0));
        assert_eq!(products[0]["show_ucnt"], json!(205.0));
        assert!(products[0]["click_ucnt"].is_null());
    }
}
