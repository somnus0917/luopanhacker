use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use luopan_runtime::RuntimePaths;
use serde_json::{Value, json};

const DETAIL_LIMIT: usize = 500;
const SHOP_MAP_FILE: &str = "shops.json";

#[derive(Default)]
struct Summary {
    settlement_amount: f64,
    income_total: f64,
    expense_total: f64,
    user_paid: f64,
    platform_subsidy: f64,
    government_merchant: f64,
    government_platform: f64,
    refund_before_settlement: f64,
    service_fee: f64,
    talent_commission: f64,
    order_count: usize,
    row_count: usize,
}

#[derive(Default)]
struct Group {
    summary: Summary,
    order_ids: std::collections::BTreeSet<String>,
}

pub fn load_settlement_dashboard(paths: &RuntimePaths) -> Result<Value> {
    load_settlement_dashboard_for_shop(paths, None)
}

pub fn load_settlement_dashboard_for_shop(
    paths: &RuntimePaths,
    shop_filter: Option<&str>,
) -> Result<Value> {
    load_settlement_dashboard_filtered(paths, shop_filter, None, None)
}

pub fn load_settlement_dashboard_filtered(
    paths: &RuntimePaths,
    shop_filter: Option<&str>,
    start_date_filter: Option<&str>,
    end_date_filter: Option<&str>,
) -> Result<Value> {
    let dir = paths.output_dir.join("settlement");
    let mut files = csv_files(&dir)?;
    files.sort();
    let shop_map = read_shop_map(&dir)?;

    let mut summary = Group::default();
    let mut by_month: BTreeMap<String, Group> = BTreeMap::new();
    let mut by_shop: BTreeMap<String, Group> = BTreeMap::new();
    let mut by_subject: BTreeMap<String, Group> = BTreeMap::new();
    let mut by_business_type: BTreeMap<String, Group> = BTreeMap::new();
    let mut shop_names = BTreeSet::new();
    let mut available_dates = BTreeSet::new();
    let mut rows = Vec::new();
    let mut parsed_files = Vec::new();
    let selected_shop = shop_filter
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let selected_start_date = start_date_filter
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let selected_end_date = end_date_filter
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    for path in files {
        let shop_name = settlement_shop_name(&path, &shop_map);
        shop_names.insert(shop_name.clone());
        if selected_shop.is_some_and(|selected| selected != shop_name) {
            continue;
        }
        let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let records = parse_csv(&strip_bom(&text));
        if records.len() < 3 {
            continue;
        }
        let headers = &records[0];
        let header_index = header_index(headers);
        let mut file_rows = 0usize;

        for record in records.into_iter().skip(2) {
            if record.iter().all(|field| field.trim().is_empty()) {
                continue;
            }
            let item = SettlementRecord::from_row(&header_index, &record, &path, &shop_name)?;
            if !item.settlement_date.is_empty() {
                available_dates.insert(item.settlement_date.clone());
            }
            if selected_start_date.is_some_and(|start| item.settlement_date.as_str() < start)
                || selected_end_date.is_some_and(|end| item.settlement_date.as_str() > end)
            {
                continue;
            }
            file_rows += 1;
            add_record(&mut summary, &item);
            add_record(
                by_month.entry(item.settlement_month.clone()).or_default(),
                &item,
            );
            add_record(by_shop.entry(item.shop_name.clone()).or_default(), &item);
            add_record(by_subject.entry(item.subject.clone()).or_default(), &item);
            add_record(
                by_business_type
                    .entry(item.business_type.clone())
                    .or_default(),
                &item,
            );
            if rows.len() < DETAIL_LIMIT {
                rows.push(item.as_json());
            }
        }

        parsed_files.push(json!({
            "path": path.to_string_lossy(),
            "name": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
            "shop_name": shop_name,
            "rows": file_rows,
        }));
    }

    Ok(json!({
        "summary": summary_json(&summary),
        "months": groups_json(by_month),
        "shop_groups": groups_json(by_shop),
        "shops": shop_names.into_iter().collect::<Vec<_>>(),
        "selected_shop": selected_shop.unwrap_or(""),
        "available_dates": available_dates.into_iter().collect::<Vec<_>>(),
        "selected_start_date": selected_start_date.unwrap_or(""),
        "selected_end_date": selected_end_date.unwrap_or(""),
        "subjects": groups_json(by_subject),
        "business_types": groups_json(by_business_type),
        "rows": rows,
        "files": parsed_files,
        "row_limit": DETAIL_LIMIT,
    }))
}

pub fn save_settlement_upload(
    paths: &RuntimePaths,
    original_file_name: &str,
    shop_name: &str,
    bytes: &[u8],
) -> Result<Value> {
    let clean_shop = clean_text(shop_name);
    if clean_shop.is_empty() {
        anyhow::bail!("请填写店铺名称");
    }
    if bytes.is_empty() {
        anyhow::bail!("上传文件为空");
    }
    if !original_file_name.to_ascii_lowercase().ends_with(".csv") {
        anyhow::bail!("只支持上传 CSV 结算文件");
    }

    let row_count = validate_settlement_csv(bytes)?;
    let dir = paths.output_dir.join("settlement");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let mut shop_map = read_shop_map(&dir)?;
    for existing in csv_files(&dir)? {
        let existing_bytes =
            fs::read(&existing).with_context(|| format!("read {}", existing.display()))?;
        if existing_bytes == bytes {
            let file_name = existing
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_string();
            shop_map.insert(file_name.clone(), clean_shop.clone());
            write_shop_map(&dir, &shop_map)?;
            return Ok(json!({
                "file": {
                    "name": file_name,
                    "original_name": original_file_name,
                    "path": existing.to_string_lossy(),
                    "shop_name": clean_shop,
                    "rows": row_count,
                    "deduplicated": true,
                }
            }));
        }
    }

    let file_name = uploaded_file_name(original_file_name, &clean_shop, bytes);
    let path = dir.join(&file_name);
    fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;

    shop_map.insert(file_name.clone(), clean_shop.clone());
    write_shop_map(&dir, &shop_map)?;

    Ok(json!({
        "file": {
            "name": file_name,
            "original_name": original_file_name,
            "path": path.to_string_lossy(),
            "shop_name": clean_shop,
            "rows": row_count,
            "deduplicated": false,
        }
    }))
}

fn csv_files(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let path = entry?.path();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
        {
            files.push(path);
        }
    }
    Ok(files)
}

fn shop_map_path(dir: &Path) -> std::path::PathBuf {
    dir.join(SHOP_MAP_FILE)
}

fn read_shop_map(dir: &Path) -> Result<BTreeMap<String, String>> {
    let path = shop_map_path(dir);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn write_shop_map(dir: &Path, shop_map: &BTreeMap<String, String>) -> Result<()> {
    let path = shop_map_path(dir);
    let temp_path = dir.join(format!(
        ".shops.{}.json.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let text = serde_json::to_string_pretty(shop_map)?;
    fs::write(&temp_path, text).with_context(|| format!("write {}", temp_path.display()))?;
    fs::rename(&temp_path, &path)
        .with_context(|| format!("replace {} with {}", temp_path.display(), path.display()))
}

fn strip_bom(text: &str) -> String {
    text.trim_start_matches('\u{feff}').to_string()
}

fn validate_settlement_csv(bytes: &[u8]) -> Result<usize> {
    let text = std::str::from_utf8(bytes).context("结算 CSV 必须是 UTF-8 编码")?;
    let records = parse_csv(&strip_bom(text));
    if records.len() < 3 {
        anyhow::bail!("结算 CSV 缺少表头或明细行");
    }
    let headers = &records[0];
    for required in ["结算时间", "订单号", "结算金额", "收入合计", "支出合计"] {
        if !headers.iter().any(|header| header.trim() == required) {
            anyhow::bail!("结算 CSV 缺少字段：{required}");
        }
    }
    let row_count = records
        .into_iter()
        .skip(2)
        .filter(|record| record.iter().any(|field| !field.trim().is_empty()))
        .count();
    if row_count == 0 {
        anyhow::bail!("结算 CSV 没有可解析的明细行");
    }
    Ok(row_count)
}

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                row.push(std::mem::take(&mut field));
            }
            '\n' if !in_quotes => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\r' if !in_quotes => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(ch),
        }
    }

    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn header_index(headers: &[String]) -> BTreeMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| (header.trim().to_string(), index))
        .collect()
}

fn field(row: &[String], index: &BTreeMap<String, usize>, name: &str) -> String {
    index
        .get(name)
        .and_then(|position| row.get(*position))
        .map(|value| clean_text(value))
        .unwrap_or_default()
}

fn number(row: &[String], index: &BTreeMap<String, usize>, name: &str) -> f64 {
    field(row, index, name)
        .replace(',', "")
        .parse::<f64>()
        .unwrap_or(0.0)
}

fn clean_text(value: &str) -> String {
    value.trim().trim_start_matches('\'').trim().to_string()
}

fn settlement_shop_name(path: &Path, shop_map: &BTreeMap<String, String>) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if let Some(shop_name) = shop_map.get(file_name) {
        return shop_name.clone();
    }
    "未标注店铺".to_string()
}

fn uploaded_file_name(original_file_name: &str, shop_name: &str, bytes: &[u8]) -> String {
    let hash = stable_hash(shop_name.as_bytes())
        .wrapping_mul(0x100000001b3)
        .wrapping_add(stable_hash(bytes));
    let mut safe_original = original_file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe_original.len() > 80 {
        safe_original.truncate(80);
    }
    if !safe_original.to_ascii_lowercase().ends_with(".csv") {
        safe_original.push_str(".csv");
    }
    format!("upload_{hash:016x}_{safe_original}")
}

fn stable_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[derive(Debug)]
struct SettlementRecord {
    shop_name: String,
    settlement_time: String,
    settlement_date: String,
    settlement_month: String,
    order_id: String,
    sub_order_id: String,
    settlement_amount: f64,
    account: String,
    statement_type: String,
    order_time: String,
    product_id: String,
    product_name: String,
    quantity: f64,
    business_type: String,
    order_type: String,
    order_total: f64,
    product_total: f64,
    user_paid: f64,
    income_total: f64,
    expense_total: f64,
    platform_subsidy: f64,
    government_merchant: f64,
    government_platform: f64,
    refund_before_settlement: f64,
    service_fee: f64,
    talent_commission: f64,
    free_commission: String,
    free_commission_amount: f64,
    subject: String,
    app_channel: String,
    source_file: String,
}

impl SettlementRecord {
    fn from_row(
        index: &BTreeMap<String, usize>,
        row: &[String],
        path: &Path,
        shop_name: &str,
    ) -> Result<Self> {
        let settlement_time = field(row, index, "结算时间");
        let settlement_date = settlement_time.chars().take(10).collect::<String>();
        let settlement_month = settlement_date.chars().take(7).collect::<String>();
        Ok(Self {
            shop_name: shop_name.to_string(),
            settlement_time,
            settlement_date,
            settlement_month,
            order_id: field(row, index, "订单号"),
            sub_order_id: field(row, index, "子订单号"),
            settlement_amount: number(row, index, "结算金额"),
            account: field(row, index, "结算账户"),
            statement_type: field(row, index, "结算单类型"),
            order_time: field(row, index, "下单时间"),
            product_id: field(row, index, "商品ID"),
            product_name: field(row, index, "商品名称"),
            quantity: number(row, index, "商品数量"),
            business_type: fallback_label(field(row, index, "业务类型")),
            order_type: field(row, index, "订单类型"),
            order_total: number(row, index, "订单总价"),
            product_total: number(row, index, "商品总价"),
            user_paid: number(row, index, "用户实付"),
            income_total: number(row, index, "收入合计"),
            expense_total: number(row, index, "支出合计"),
            platform_subsidy: number(row, index, "平台补贴")
                + number(row, index, "其他平台补贴")
                + number(row, index, "平台补贴运费"),
            government_merchant: number(row, index, "政府补贴商家垫资"),
            government_platform: number(row, index, "政府补贴平台垫资"),
            refund_before_settlement: number(row, index, "结算前退款金额"),
            service_fee: number(row, index, "平台服务费"),
            talent_commission: number(row, index, "达人佣金"),
            free_commission: field(row, index, "是否免佣"),
            free_commission_amount: number(row, index, "免佣金额"),
            subject: fallback_label(field(row, index, "商户主体名称")),
            app_channel: field(row, index, "APP渠道"),
            source_file: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_string(),
        })
    }

    fn as_json(&self) -> Value {
        json!({
            "shop_name": self.shop_name,
            "settlement_time": self.settlement_time,
            "settlement_date": self.settlement_date,
            "settlement_month": self.settlement_month,
            "order_id": self.order_id,
            "sub_order_id": self.sub_order_id,
            "settlement_amount": self.settlement_amount,
            "account": self.account,
            "statement_type": self.statement_type,
            "order_time": self.order_time,
            "product_id": self.product_id,
            "product_name": self.product_name,
            "quantity": self.quantity,
            "business_type": self.business_type,
            "order_type": self.order_type,
            "order_total": self.order_total,
            "product_total": self.product_total,
            "user_paid": self.user_paid,
            "income_total": self.income_total,
            "expense_total": self.expense_total,
            "platform_subsidy": self.platform_subsidy,
            "government_merchant": self.government_merchant,
            "government_platform": self.government_platform,
            "refund_before_settlement": self.refund_before_settlement,
            "service_fee": self.service_fee,
            "talent_commission": self.talent_commission,
            "free_commission": self.free_commission,
            "free_commission_amount": self.free_commission_amount,
            "subject": self.subject,
            "app_channel": self.app_channel,
            "source_file": self.source_file,
        })
    }
}

fn fallback_label(value: String) -> String {
    if value.is_empty() {
        "未标注".to_string()
    } else {
        value
    }
}

fn add_record(group: &mut Group, record: &SettlementRecord) {
    group.summary.settlement_amount += record.settlement_amount;
    group.summary.income_total += record.income_total;
    group.summary.expense_total += record.expense_total;
    group.summary.user_paid += record.user_paid;
    group.summary.platform_subsidy += record.platform_subsidy;
    group.summary.government_merchant += record.government_merchant;
    group.summary.government_platform += record.government_platform;
    group.summary.refund_before_settlement += record.refund_before_settlement;
    group.summary.service_fee += record.service_fee;
    group.summary.talent_commission += record.talent_commission;
    group.summary.row_count += 1;
    if !record.order_id.is_empty() {
        group.order_ids.insert(record.order_id.clone());
    }
    group.summary.order_count = group.order_ids.len();
}

fn groups_json(groups: BTreeMap<String, Group>) -> Vec<Value> {
    groups
        .into_iter()
        .map(|(name, group)| {
            let mut value = summary_json(&group);
            value["name"] = json!(name);
            value
        })
        .collect()
}

fn summary_json(group: &Group) -> Value {
    json!({
        "settlement_amount": round_money(group.summary.settlement_amount),
        "income_total": round_money(group.summary.income_total),
        "expense_total": round_money(group.summary.expense_total),
        "user_paid": round_money(group.summary.user_paid),
        "platform_subsidy": round_money(group.summary.platform_subsidy),
        "government_merchant": round_money(group.summary.government_merchant),
        "government_platform": round_money(group.summary.government_platform),
        "refund_before_settlement": round_money(group.summary.refund_before_settlement),
        "service_fee": round_money(group.summary.service_fee),
        "talent_commission": round_money(group.summary.talent_commission),
        "order_count": group.summary.order_count,
        "row_count": group.summary.row_count,
    })
}

fn round_money(value: f64) -> f64 {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.abs() < 0.005 { 0.0 } else { rounded }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_multiline_csv_records() {
        let rows = parse_csv("a,b\n\"x\ny\",2\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][0], "x\ny");
        assert_eq!(rows[1][1], "2");
    }

    #[test]
    fn strips_accounting_apostrophes() {
        assert_eq!(clean_text("'6953319116962666149"), "6953319116962666149");
    }

    #[test]
    fn rounds_negative_zero_to_zero() {
        assert_eq!(round_money(-0.001), 0.0);
    }

    #[test]
    fn marks_unmapped_download_files_as_unlabeled() {
        assert_eq!(
            settlement_shop_name(
                Path::new("DL202607181143232999613441.csv"),
                &BTreeMap::new()
            ),
            "未标注店铺"
        );
        assert_eq!(
            settlement_shop_name(
                Path::new("DL202607181203353587675137.csv"),
                &BTreeMap::new()
            ),
            "未标注店铺"
        );
    }

    #[test]
    fn uploaded_shop_map_overrides_file_name_fallback() {
        let mut shop_map = BTreeMap::new();
        shop_map.insert(
            "DL202607181143232999613441.csv".to_string(),
            "手动填写店铺".to_string(),
        );
        assert_eq!(
            settlement_shop_name(Path::new("DL202607181143232999613441.csv"), &shop_map),
            "手动填写店铺"
        );
    }

    #[test]
    fn validates_settlement_csv_shape() {
        let text =
            "结算时间,订单号,结算金额,收入合计,支出合计\n说明,,,,\n2026-07-01,1,2.00,3.00,-1.00\n";
        assert_eq!(validate_settlement_csv(text.as_bytes()).unwrap(), 1);
    }

    #[test]
    fn saves_uploaded_csv_with_shop_mapping() {
        let base = std::env::temp_dir().join(format!(
            "luopan-settlement-upload-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: base.clone(),
            output_dir: base.join("output"),
            state_dir: base.join("state"),
            config_dir: base.join("config"),
            logs_dir: base.join("logs"),
            session_dir: base.join("session"),
        };
        let text = "结算时间,订单号,结算金额,收入合计,支出合计\n说明,,,,\n2026-07-01,order-1,2.00,3.00,-1.00\n";

        let upload = save_settlement_upload(&paths, "plain.csv", "测试店铺", text.as_bytes())
            .expect("save upload");
        let saved_name = upload["file"]["name"].as_str().unwrap();
        assert!(saved_name.starts_with("upload_"));

        let dashboard = load_settlement_dashboard_for_shop(&paths, Some("测试店铺")).unwrap();
        assert_eq!(dashboard["summary"]["row_count"], json!(1));
        assert_eq!(dashboard["summary"]["order_count"], json!(1));
        assert_eq!(dashboard["shops"], json!(["测试店铺"]));

        let second_upload =
            save_settlement_upload(&paths, "plain.csv", "改名店铺", text.as_bytes())
                .expect("deduplicate upload");
        assert_eq!(second_upload["file"]["deduplicated"], json!(true));
        assert_eq!(
            csv_files(&paths.output_dir.join("settlement"))
                .unwrap()
                .len(),
            1
        );
        let renamed_dashboard =
            load_settlement_dashboard_for_shop(&paths, Some("改名店铺")).unwrap();
        assert_eq!(renamed_dashboard["summary"]["row_count"], json!(1));

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn filters_dashboard_by_settlement_date_range() {
        let base = std::env::temp_dir().join(format!(
            "luopan-settlement-date-filter-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: base.clone(),
            output_dir: base.join("output"),
            state_dir: base.join("state"),
            config_dir: base.join("config"),
            logs_dir: base.join("logs"),
            session_dir: base.join("session"),
        };
        let text = "结算时间,订单号,结算金额,收入合计,支出合计\n说明,,,,\n2026-06-30 10:00:00,order-1,2.00,3.00,-1.00\n2026-07-02 10:00:00,order-2,4.00,5.00,-1.00\n";
        save_settlement_upload(&paths, "range.csv", "测试店铺", text.as_bytes())
            .expect("save upload");

        let dashboard = load_settlement_dashboard_filtered(
            &paths,
            Some("测试店铺"),
            Some("2026-07-01"),
            Some("2026-07-31"),
        )
        .unwrap();
        assert_eq!(dashboard["summary"]["row_count"], json!(1));
        assert_eq!(dashboard["summary"]["settlement_amount"], json!(4.0));
        assert_eq!(
            dashboard["available_dates"],
            json!(["2026-06-30", "2026-07-02"])
        );
        assert_eq!(dashboard["selected_start_date"], json!("2026-07-01"));
        assert_eq!(dashboard["selected_end_date"], json!("2026-07-31"));
        assert_eq!(dashboard["months"][0]["name"], json!("2026-07"));
        assert_eq!(dashboard["rows"][0]["settlement_date"], json!("2026-07-02"));

        let _ = fs::remove_dir_all(base);
    }
}
