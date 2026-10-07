//! Common collection identity and file envelope. The file is the source of truth.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionType {
    Table,
    MediaLibrary,
}
impl CollectionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::MediaLibrary => "media_library",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionProperty {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub value: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionMetadata {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: CollectionType,
    pub name: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub properties: BTreeMap<String, CollectionProperty>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionDocument {
    pub format: String,
    pub schema_version: i64,
    pub collection: CollectionMetadata,
    pub payload: Value,
}
pub fn valid_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn validate_properties(
    properties: &BTreeMap<String, CollectionProperty>,
) -> Result<(), String> {
    for (key, property) in properties {
        if key.is_empty()
            || !key.as_bytes()[0].is_ascii_lowercase()
            || !key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || property
                .name
                .as_ref()
                .is_some_and(|name| name.trim().is_empty())
        {
            return Err("INVALID_COLLECTION_PROPERTY".into());
        }
        let value = &property.value;
        let valid = match property.kind.as_str() {
            "Text" | "URL" | "Icon" => value.is_string(),
            "Number" => value.as_f64().is_some_and(f64::is_finite),
            "Boolean" => value.is_boolean(),
            "Tag" | "Color" => value
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string)),
            "Date" => value.as_str().is_some_and(|date| {
                date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
            }),
            _ => false,
        };
        if !valid {
            return Err("INVALID_COLLECTION_PROPERTY_VALUE".into());
        }
    }
    Ok(())
}
impl CollectionDocument {
    pub fn parse(source: &str) -> Result<Self, String> {
        let document: Self =
            serde_yaml::from_str(source).map_err(|e| format!("INVALID_COLLECTION_DOCUMENT:{e}"))?;
        document.validate_header()?;
        Ok(document)
    }
    pub fn validate_header(&self) -> Result<(), String> {
        let metadata = &self.collection;
        if self.format != "flowix.collection"
            || self.schema_version < 1
            || !valid_id(&metadata.id, "col_")
            || metadata.name.trim().is_empty()
            || metadata.name != metadata.name.trim()
            || !(0..=9_007_199_254_740_991).contains(&metadata.revision)
            || chrono::DateTime::parse_from_rfc3339(&metadata.created_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&metadata.updated_at).is_err()
            || !self.payload.is_object()
            || self
                .payload
                .get("schema_version")
                .and_then(Value::as_i64)
                .is_none_or(|v| v < 1)
        {
            return Err("INVALID_COLLECTION_METADATA".into());
        }
        validate_properties(&metadata.properties)
    }
    pub fn supported(&self) -> bool {
        self.schema_version == 1 && self.payload["schema_version"] == 1
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_header()?;
        if !self.supported() {
            return Err("UNSUPPORTED_COLLECTION_VERSION".into());
        }
        let keys: &[&str] = match self.collection.kind {
            CollectionType::Table => &["schema_version", "table", "records"],
            CollectionType::MediaLibrary => &["schema_version", "view", "records"],
        };
        only_keys(&self.payload, keys)?;
        match self.collection.kind {
            CollectionType::Table => validate_table(&self.payload)?,
            CollectionType::MediaLibrary => validate_media_library(&self.payload)?,
        }
        Ok(())
    }
    pub fn serialize(&self) -> Result<String, String> {
        self.validate()?;
        serde_yaml::to_string(self).map_err(|e| e.to_string())
    }
    pub fn revise(&mut self) -> Result<(), String> {
        self.collection.revision = self
            .collection
            .revision
            .checked_add(1)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("COLLECTION_REVISION_OVERFLOW")?;
        self.collection.updated_at =
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(())
    }
}
fn only_keys(value: &Value, keys: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_none_or(|map| map.keys().any(|key| !keys.contains(&key.as_str())))
    {
        return Err("INVALID_COLLECTION_PAYLOAD_KEYS".into());
    }
    Ok(())
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value[key]
        .as_array()
        .ok_or_else(|| format!("INVALID_COLLECTION_ARRAY:{key}"))
}
fn id(value: &Value, prefix: &str, ids: &mut HashSet<String>) -> Result<String, String> {
    let id = value["id"].as_str().ok_or("INVALID_COLLECTION_CHILD_ID")?;
    if !valid_id(id, prefix) || !ids.insert(id.to_owned()) {
        return Err("INVALID_COLLECTION_CHILD_ID".into());
    }
    Ok(id.to_owned())
}
fn records(value: &Value, table: bool) -> Result<(), String> {
    only_keys(
        value,
        if table {
            &["data", "auto_collect"]
        } else {
            &["data"]
        },
    )?;
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for record in array(value, "data")? {
        only_keys(record, &["id", "updated_at", "note_path"])?;
        id(record, "rec_", &mut ids)?;
        if record["updated_at"]
            .as_str()
            .is_none_or(|date| chrono::DateTime::parse_from_rfc3339(date).is_err())
        {
            return Err("INVALID_COLLECTION_RECORD_TIME".into());
        }
        let path = record["note_path"]
            .as_str()
            .ok_or("INVALID_COLLECTION_RECORD_PATH")?;
        if (!table || !path.is_empty())
            && (path.starts_with('/')
                || path.contains('\\')
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || !paths.insert(path.to_owned()))
        {
            return Err("INVALID_COLLECTION_RECORD_PATH".into());
        }
    }
    if table {
        let auto = value.get("auto_collect").ok_or("MISSING_AUTO_COLLECT")?;
        if !auto.is_null() {
            only_keys(auto, &["condition", "excluded_note_paths"])?;
            if array(auto, "excluded_note_paths")?
                .iter()
                .any(|path| !path.is_string())
            {
                return Err("INVALID_EXCLUDED_PATH".into());
            }
            let condition = &auto["condition"];
            only_keys(
                condition,
                &["property_conditions", "property_match", "file_condition"],
            )?;
            if let Some(properties) = condition.get("property_conditions") {
                let properties = properties
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or("INVALID_PROPERTY_CONDITION")?;
                if !matches!(
                    condition["property_match"].as_str(),
                    Some("union" | "intersection")
                ) {
                    return Err("INVALID_PROPERTY_MATCH".into());
                }
                for property in properties {
                    only_keys(property, &["field_id", "operator", "value"])?;
                    if property["field_id"]
                        .as_str()
                        .is_none_or(|v| v.trim().is_empty())
                        || property["value"]
                            .as_str()
                            .is_none_or(|v| v.trim().is_empty())
                        || !matches!(property["operator"].as_str(), Some("equals" | "contains"))
                    {
                        return Err("INVALID_PROPERTY_CONDITION".into());
                    }
                }
            } else if condition.get("property_match").is_some() {
                return Err("INVALID_PROPERTY_MATCH".into());
            }
            if let Some(file) = condition.get("file_condition") {
                file_condition(file, true)?;
            }
            if condition.get("property_conditions").is_none()
                && condition.get("file_condition").is_none()
            {
                return Err("EMPTY_COLLECTION_CONDITION".into());
            }
        }
    }
    Ok(())
}
fn file_condition(condition: &Value, table: bool) -> Result<(), String> {
    only_keys(
        condition,
        &["file_name_contains", "file_type", "path_contains"],
    )?;
    if condition
        .as_object()
        .unwrap()
        .values()
        .any(|v| !v.is_string())
    {
        return Err("INVALID_FILE_CONDITION".into());
    }
    if let Some(kind) = condition.get("file_type").and_then(Value::as_str) {
        if !(kind.is_empty()
            || if table {
                kind == "markdown"
            } else {
                kind == "image" || kind == "video"
            })
        {
            return Err("INVALID_FILE_CONDITION_TYPE".into());
        }
    }
    Ok(())
}
fn validate_table(payload: &Value) -> Result<(), String> {
    let table = &payload["table"];
    only_keys(table, &["primary_field_id", "fields", "views"])?;
    let mut fields = HashSet::new();
    let mut property_keys = HashSet::new();
    let mut primary_count = 0;
    let field_values = array(table, "fields")?;
    for field in field_values {
        only_keys(
            field,
            &["id", "type", "name", "property_key", "options", "multiple"],
        )?;
        id(field, "fld_", &mut fields)?;
        let kind = field["type"].as_str().ok_or("INVALID_FIELD_TYPE")?;
        if ![
            "primary",
            "Text",
            "URL",
            "Icon",
            "Boolean",
            "Number",
            "Date",
            "Select",
            "MultiSelect",
            "Tag",
            "Tags",
            "Color",
            "Image",
        ]
        .contains(&kind)
        {
            return Err("INVALID_FIELD_TYPE".into());
        }
        if kind == "primary" {
            primary_count += 1;
            if field["property_key"] != "note" {
                return Err("INVALID_PRIMARY_FIELD".into());
            }
        }
        let key = field["property_key"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or("MISSING_FIELD_PROPERTY_KEY")?;
        if !property_keys.insert(key.trim().to_lowercase()) {
            return Err("DUPLICATE_FIELD_PROPERTY_KEY".into());
        }
        if field
            .get("name")
            .is_some_and(|v| v.as_str().is_none_or(|v| v.trim().is_empty()))
        {
            return Err("INVALID_FIELD_NAME".into());
        }
        if let Some(options) = field.get("options") {
            let options = options.as_array().ok_or("INVALID_FIELD_OPTIONS")?;
            let mut option_ids = HashSet::new();
            for option in options {
                only_keys(option, &["id", "label"])?;
                id(option, "opt_", &mut option_ids)?;
                if option["label"].as_str().is_none_or(|v| v.trim().is_empty()) {
                    return Err("INVALID_FIELD_OPTION".into());
                }
            }
        }
        if field.get("multiple").is_some_and(|v| !v.is_boolean()) {
            return Err("INVALID_FIELD_MULTIPLE".into());
        }
    }
    if primary_count != 1
        || field_values.first().is_none_or(|field| {
            field["type"] != "primary" || field["id"] != table["primary_field_id"]
        })
    {
        return Err("INVALID_PRIMARY_FIELD".into());
    }
    let mut views = HashSet::new();
    let view_values = array(table, "views")?;
    if view_values.is_empty() {
        return Err("MISSING_TABLE_VIEW".into());
    }
    for view in view_values {
        only_keys(view, &["id", "name", "type", "config"])?;
        id(view, "view_", &mut views)?;
        if view["name"].as_str().is_none_or(|v| v.trim().is_empty()) {
            return Err("INVALID_VIEW_NAME".into());
        }
        let config = &view["config"];
        let kind = view["type"].as_str().ok_or("INVALID_VIEW_TYPE")?;
        match kind {
            "table" | "gallery" => {
                only_keys(config, &["visible_fields"])?;
                if array(config, "visible_fields")?
                    .iter()
                    .any(|v| v.as_str().is_none_or(|id| !fields.contains(id)))
                {
                    return Err("INVALID_VIEW_FIELD".into());
                }
            }
            "kanban" => {
                only_keys(config, &["group_by"])?;
                if !field_values
                    .iter()
                    .any(|field| field["id"] == config["group_by"] && field["type"] == "Select")
                {
                    return Err("INVALID_KANBAN_FIELD".into());
                }
            }
            "calendar" => {
                only_keys(config, &["date_field", "title_field", "week_start"])?;
                let date = config["date_field"].as_str().ok_or("INVALID_DATE_FIELD")?;
                if !["__note_created_at__", "__note_updated_at__"].contains(&date)
                    && !field_values
                        .iter()
                        .any(|field| field["id"] == date && field["type"] == "Date")
                {
                    return Err("INVALID_DATE_FIELD".into());
                }
                if config["title_field"]
                    .as_str()
                    .is_none_or(|id| !fields.contains(id))
                    || config.get("week_start").is_some_and(|v| *v != 1)
                {
                    return Err("INVALID_CALENDAR_CONFIG".into());
                }
            }
            _ => return Err("INVALID_VIEW_TYPE".into()),
        }
    }
    records(&payload["records"], true)
}
fn validate_media_library(payload: &Value) -> Result<(), String> {
    let view = &payload["view"];
    only_keys(view, &["id", "layout", "condition", "sort"])?;
    if view["id"].as_str().is_none_or(|v| !valid_id(v, "view_")) || view["layout"] != "waterfall" {
        return Err("INVALID_MEDIA_VIEW".into());
    }
    only_keys(&view["condition"], &["file_condition"])?;
    if let Some(condition) = view["condition"].get("file_condition") {
        file_condition(condition, false)?;
    }
    if let Some(sort) = view.get("sort") {
        only_keys(sort, &["field", "direction"])?;
        if sort["field"] != "created_at" || sort["direction"] != "desc" {
            return Err("INVALID_MEDIA_SORT".into());
        }
    }
    records(&payload["records"], false)
}
