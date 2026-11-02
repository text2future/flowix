//! Common collection identity and file envelope. The file is the source of truth.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionType {
    #[serde(rename = "notes", alias = "table")]
    Table,
    #[serde(rename = "media", alias = "media_library")]
    MediaLibrary,
    #[serde(rename = "work_documents")]
    WorkDocuments,
    /// v3 multi-domain collection: notes / media / work_documents datasets and
    /// domain-tagged views share one document (see `validate_collection_hybrid`).
    #[serde(rename = "hybrid")]
    Hybrid,
}
impl CollectionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::MediaLibrary => "media_library",
            Self::WorkDocuments => "work_documents",
            Self::Hybrid => "hybrid",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CollectionPlacement {
    #[default]
    Standalone,
    Folder,
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
    #[serde(default, skip_serializing_if = "is_standalone")]
    pub placement: CollectionPlacement,
    /// Deprecated compatibility field. Names are derived from the collection path.
    #[serde(default, skip_serializing)]
    pub name: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub properties: BTreeMap<String, CollectionProperty>,
}
fn is_standalone(value: &CollectionPlacement) -> bool {
    *value == CollectionPlacement::Standalone
}

pub fn display_name_for_path(path: &std::path::Path, placement: CollectionPlacement) -> String {
    let display_path = if placement == CollectionPlacement::Folder {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let filename = display_path.file_name().unwrap_or_default().to_string_lossy();
    if placement == CollectionPlacement::Folder {
        return filename.into_owned();
    }
    [".index.yaml", ".index.yml", ".table.yaml", ".table.yml", ".lib.yaml", ".lib.yml", ".workdocs.yaml", ".workdocs.yml"]
        .iter()
        .find_map(|suffix| filename.get(..filename.len().checked_sub(suffix.len())?)
            .filter(|_| filename.to_ascii_lowercase().ends_with(suffix)))
        .unwrap_or(&filename)
        .to_owned()
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
        matches!(self.schema_version, 1 | 2 | 3)
            && self.payload["schema_version"] == self.schema_version
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_header()?;
        if !self.supported() {
            return Err("UNSUPPORTED_COLLECTION_VERSION".into());
        }
        if self.schema_version == 3 {
            if self.collection.kind != CollectionType::Hybrid {
                return Err("UNSUPPORTED_COLLECTION_VERSION".into());
            }
            validate_collection_hybrid(self)?;
        } else if self.schema_version == 2 {
            if self.collection.kind == CollectionType::Hybrid {
                return Err("UNSUPPORTED_COLLECTION_VERSION".into());
            }
            validate_collection_v2(self)?;
        } else {
            if matches!(self.collection.kind, CollectionType::WorkDocuments | CollectionType::Hybrid) {
                return Err("UNSUPPORTED_COLLECTION_VERSION".into());
            }
            let keys: &[&str] = match self.collection.kind {
                CollectionType::Table => &["schema_version", "table", "records"],
                CollectionType::MediaLibrary => &["schema_version", "view", "records"],
                CollectionType::WorkDocuments | CollectionType::Hybrid => {
                    return Err("UNSUPPORTED_COLLECTION_VERSION".into())
                }
            };
            only_keys(&self.payload, keys)?;
            match self.collection.kind {
                CollectionType::Table => validate_table(&self.payload)?,
                CollectionType::MediaLibrary => validate_media_library(&self.payload)?,
                CollectionType::WorkDocuments | CollectionType::Hybrid => {
                    return Err("UNSUPPORTED_COLLECTION_VERSION".into())
                }
            }
        }
        Ok(())
    }
    pub fn serialize(&self) -> Result<String, String> {
        self.validate()?;
        serde_yaml::to_string(self).map_err(|e| e.to_string())
    }
    /// Convert a validated legacy file for an edit. Reading alone never rewrites it.
    /// v2 and v3 documents are already canonical and pass through unchanged.
    pub fn normalized_v2(&self) -> Result<Self, String> {
        self.validate()?;
        if self.schema_version >= 2 {
            return Ok(self.clone());
        }
        let source = match self.collection.placement {
            CollectionPlacement::Folder => serde_json::json!({"scope":"containing_folder","depth":"descendants"}),
            CollectionPlacement::Standalone => serde_json::json!({"scope":"notebook","depth":"descendants"}),
        };
        let payload = match self.collection.kind {
            CollectionType::Table => {
                let table = &self.payload["table"];
                let auto = &self.payload["records"]["auto_collect"];
                let views = array(table, "views")?.iter().map(|view| serde_json::json!({
                    "id": view["id"], "name": view["name"], "layout": view["type"],
                    "filter": {"all":[],"any":[]},
                    "sort": [{"field":"modified_at","direction":"desc"}],
                    "config": view["config"]
                })).collect::<Vec<_>>();
                let exclude = if auto.is_null() { Vec::new() } else {
                    array(auto, "excluded_note_paths")?.iter()
                        .map(|path| serde_json::json!({"note_path":path}))
                        .collect::<Vec<_>>()
                };
                serde_json::json!({
                    "schema_version":2,
                    "dataset": {
                        "source":source,
                        "schema":{"primary_field_id":table["primary_field_id"],"fields":table["fields"]},
                        "records":{"include":self.payload["records"]["data"],"exclude":exclude},
                        "filter":legacy_table_filter(auto)?
                    },
                    "views":{"default_id":views[0]["id"],"items":views}
                })
            }
            CollectionType::MediaLibrary => {
                let view = &self.payload["view"];
                let mut rules = Vec::new();
                if let Some(file) = view["condition"].get("file_condition") {
                    legacy_file_rules(file, false, &mut rules);
                }
                let records = array(&self.payload["records"], "data")?.iter()
                    .map(|record| serde_json::json!({
                        "id":record["id"], "updated_at":record["updated_at"],
                        "resource_id":format!("path:{}",record["note_path"].as_str().unwrap_or_default()),
                        "relative_path":record["note_path"]
                    })).collect::<Vec<_>>();
                serde_json::json!({
                    "schema_version":2,
                    "dataset": {
                        "source":source,"schema":{"fields":[]},
                        "records":{"include":records,"exclude":[]},
                        "filter":if rules.is_empty() { Value::Null } else { serde_json::json!({"all":rules,"any":[]}) }
                    },
                    "views":{"default_id":view["id"],"items":[{
                        "id":view["id"],"name":"图墙","layout":"waterfall",
                        "filter":{"all":rules,"any":[]},
                        "sort":[view.get("sort").cloned().unwrap_or_else(|| serde_json::json!({"field":"created_at","direction":"desc"}))],
                        "config":{}
                    }]}
                })
            }
            CollectionType::WorkDocuments | CollectionType::Hybrid => {
                return Err("UNSUPPORTED_COLLECTION_VERSION".into())
            }
        };
        let normalized = Self {
            format: self.format.clone(),
            schema_version: 2,
            collection: self.collection.clone(),
            payload,
        };
        normalized.validate()?;
        Ok(normalized)
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

    /// Set media resource references to the canonical notebook-and-path ID.
    /// Collection row IDs remain collection-local record identities.
    pub fn normalize_media_resource_ids(&mut self, notebook_id: &str) -> Result<bool, String> {
        if self.collection.kind == CollectionType::Hybrid {
            let mut changed = false;
            if let Some(domains) = self.payload.get_mut("domains") {
                for domain in ["media", "work_documents"] {
                    if let Some(records) = domains
                        .get_mut(domain)
                        .and_then(|dataset| dataset.get_mut("records"))
                    {
                        changed |= normalize_media_resource_records(records, notebook_id)?;
                    }
                }
            }
            return Ok(changed);
        }
        if self.collection.kind != CollectionType::MediaLibrary {
            return Ok(false);
        }
        let records = self
            .payload
            .get_mut("dataset")
            .and_then(|dataset| dataset.get_mut("records"))
            .ok_or("INVALID_MEDIA_LIBRARY_RECORDS")?;
        normalize_media_resource_records(records, notebook_id)
    }

    /// Rebase file references and update media resource identities in one edit.
    pub fn rebase_paths_for_notebook(
        &mut self,
        notebook_id: &str,
        previous: &str,
        next: &str,
    ) -> Result<bool, String> {
        let changed = self.rebase_paths(previous, next);
        if changed {
            self.normalize_media_resource_ids(notebook_id)?;
        }
        Ok(changed)
    }

    /// Rebase notebook-relative references after a confirmed file or directory move.
    /// The caller owns revision updates and persistence.
    pub fn rebase_paths(&mut self, previous: &str, next: &str) -> bool {
        fn rebase(path: &str, previous: &str, next: &str) -> Option<String> {
            if path == previous {
                return Some(next.to_owned());
            }
            path.strip_prefix(&format!("{previous}/"))
                .map(|suffix| format!("{next}/{suffix}"))
        }
        fn rules(value: &mut Value, previous: &str, next: &str) -> bool {
            let mut changed = false;
            match value {
                Value::Object(object) => {
                    if object.get("field").and_then(Value::as_str) == Some("path") {
                        if let Some(path) = object.get("value").and_then(Value::as_str) {
                            if let Some(path) = rebase(path, previous, next) {
                                object.insert("value".into(), Value::String(path));
                                changed = true;
                            }
                        }
                    }
                    for child in object.values_mut() {
                        changed |= rules(child, previous, next);
                    }
                }
                Value::Array(array) => {
                    for child in array { changed |= rules(child, previous, next); }
                }
                _ => {}
            }
            changed
        }
        let previous = previous.trim_matches('/');
        let next = next.trim_matches('/');
        if previous.is_empty() || next.is_empty() || previous == next { return false; }
        /// Rebase records, source scope path and dataset filter of one dataset.
        fn rebase_dataset(dataset: &mut Value, previous: &str, next: &str) -> bool {
            let mut changed = false;
            if let Some(records) = dataset.get_mut("records") {
                for kind in ["include", "exclude"] {
                    if let Some(items) = records.get_mut(kind).and_then(Value::as_array_mut) {
                        for record in items {
                            for key in ["note_path", "relative_path"] {
                                if let Some(path) = record.get(key).and_then(Value::as_str) {
                                    if let Some(path) = rebase(path, previous, next) {
                                        record[key] = Value::String(path);
                                        changed = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some(path) = dataset.get("source").and_then(|source| source.get("path")).and_then(Value::as_str) {
                if let Some(path) = rebase(path, previous, next) {
                    dataset["source"]["path"] = Value::String(path);
                    changed = true;
                }
            }
            if let Some(filter) = dataset.get_mut("filter") {
                if let Some(path) = filter.get("path").and_then(Value::as_str) {
                    if let Some(path) = rebase(path, previous, next) {
                        filter["path"] = Value::String(path);
                        changed = true;
                    }
                }
                changed |= rules(filter, previous, next);
            }
            changed
        }
        let mut changed = false;
        if self.collection.kind == CollectionType::Hybrid {
            let Some(domains) = self.payload.get_mut("domains").and_then(Value::as_object_mut) else { return false; };
            for dataset in domains.values_mut() {
                changed |= rebase_dataset(dataset, previous, next);
            }
        } else if let Some(dataset) = self.payload.get_mut("dataset") {
            changed = rebase_dataset(dataset, previous, next);
        }
        if let Some(views) = self.payload.get_mut("views").and_then(|views| views.get_mut("items")).and_then(Value::as_array_mut) {
            for view in views {
                if let Some(filter) = view.get_mut("filter") { changed |= rules(filter, previous, next); }
            }
        }
        changed
    }
}
fn legacy_file_rules(file: &Value, notes: bool, output: &mut Vec<Value>) {
    for (key, field) in [("file_name_contains", "file_name"), ("path_contains", "path")] {
        if let Some(value) = file[key].as_str().filter(|value| !value.is_empty()) {
            output.push(serde_json::json!({"field":field,"op":"contains","value":value}));
        }
    }
    if let Some(kind) = file["file_type"].as_str().filter(|kind| !kind.is_empty()) {
        output.push(serde_json::json!({"field":"kind","op":"eq","value":if notes { "note" } else { kind }}));
    }
}
fn legacy_table_filter(auto: &Value) -> Result<Value, String> {
    if auto.is_null() {
        return Ok(Value::Null);
    }
    let condition = &auto["condition"];
    let properties = condition.get("property_conditions").and_then(Value::as_array)
        .map(|items| items.iter().map(|item| serde_json::json!({
            "field":item["field_id"].as_str().map(str::trim).unwrap_or_default(),"op":item["operator"],
            "value":item["value"].as_str().map(str::trim).unwrap_or_default()
        })).collect::<Vec<_>>()).unwrap_or_default();
    let mut files = Vec::new();
    if let Some(file) = condition.get("file_condition") {
        legacy_file_rules(file, true, &mut files);
    }
    let mut paths = Vec::new();
    files.retain(|rule| {
        if rule["field"] == "path" {
            paths.push(rule.clone());
            false
        } else {
            true
        }
    });
    if properties.is_empty() && files.is_empty() && paths.is_empty() {
        return Ok(Value::Null);
    }
    if condition["property_match"] == "intersection" && !properties.is_empty() {
        if !files.is_empty() {
            let mut any = vec![serde_json::json!({"all":properties,"any":[]})];
            any.extend(files);
            return Ok(serde_json::json!({"all":paths,"any":any}));
        }
        paths.extend(properties);
        return Ok(serde_json::json!({"all":paths,"any":[]}));
    }
    let mut any = properties;
    any.extend(files);
    Ok(serde_json::json!({"all":paths,"any":any}))
}
fn hybrid_domain_type(domain: &str) -> Option<CollectionType> {
    match domain {
        "notes" => Some(CollectionType::Table),
        "media" => Some(CollectionType::MediaLibrary),
        "work_documents" => Some(CollectionType::WorkDocuments),
        _ => None,
    }
}

fn normalize_media_resource_records(records: &mut Value, notebook_id: &str) -> Result<bool, String> {
    let mut changed = false;
    for key in ["include", "exclude"] {
        let entries = records
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .ok_or("INVALID_MEDIA_LIBRARY_RECORDS")?;
        for record in entries {
            let path = record
                .get("relative_path")
                .and_then(Value::as_str)
                .ok_or("INVALID_MEDIA_LIBRARY_PATH")?;
            let id = crate::memo_file::media_resource_id(notebook_id, path)
                .map_err(|error| error.to_string())?;
            if record.get("resource_id").and_then(Value::as_str) != Some(id.as_str()) {
                record["resource_id"] = Value::String(id);
                changed = true;
            }
        }
    }
    Ok(changed)
}

/// v3 hybrid validation. Each domain dataset is validated by reusing the v2
/// validator on a synthetic single-type document, so domain rules stay in one
/// place (the v2 validator) and stay in lockstep with the frontend projection.
fn validate_collection_hybrid(document: &CollectionDocument) -> Result<(), String> {
    let payload = &document.payload;
    only_keys(payload, &["schema_version", "file_tree", "domains", "views"])?;
    match payload.get("file_tree") {
        Some(Value::Bool(false)) => {}
        // The file tree tab only renders for folder collections anchored to a path.
        Some(Value::Bool(true)) if document.collection.placement == CollectionPlacement::Folder => {}
        _ => return Err("INVALID_COLLECTION_FILE_TREE".into()),
    }
    let domains = payload
        .get("domains")
        .and_then(Value::as_object)
        .ok_or("INVALID_COLLECTION_DOMAINS")?;
    let views = payload.get("views").ok_or("MISSING_COLLECTION_VIEWS")?;
    only_keys(views, &["default_by_domain", "items"])?;
    let items = array(views, "items")?;
    let defaults = views
        .get("default_by_domain")
        .and_then(Value::as_object)
        .ok_or("INVALID_DEFAULT_VIEW")?;
    if domains.is_empty() && items.is_empty() && defaults.is_empty()
        && document.collection.placement == CollectionPlacement::Folder
        && payload.get("file_tree") == Some(&Value::Bool(true))
    {
        return Ok(());
    }
    if domains.is_empty() {
        return Err("INVALID_COLLECTION_DOMAINS".into());
    }
    if items.is_empty() {
        return Err("COLLECTION_REQUIRES_VIEW".into());
    }
    let mut ids = HashSet::new();
    let mut views_by_domain: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for view in items {
        only_keys(view, &["id", "name", "domain", "layout", "filter", "sort", "config"])?;
        id(view, "view_", &mut ids)?;
        let domain = view
            .get("domain")
            .and_then(Value::as_str)
            .ok_or("INVALID_COLLECTION_VIEW_DOMAIN")?;
        if !domains.contains_key(domain) {
            return Err("INVALID_COLLECTION_VIEW_DOMAIN".into());
        }
        let mut stripped = view.as_object().cloned().unwrap_or_default();
        stripped.remove("domain");
        views_by_domain
            .entry(domain)
            .or_default()
            .push(Value::Object(stripped));
    }
    // A domain exists exactly when it owns at least one view, and every view
    // tag points back at an existing domain key.
    for key in domains.keys() {
        if hybrid_domain_type(key).is_none() || !views_by_domain.contains_key(key.as_str()) {
            return Err("INVALID_COLLECTION_DOMAINS".into());
        }
    }
    if views_by_domain.len() != domains.len() {
        return Err("INVALID_COLLECTION_DOMAINS".into());
    }
    if defaults.len() != domains.len() || defaults.keys().any(|key| !domains.contains_key(key)) {
        return Err("INVALID_DEFAULT_VIEW".into());
    }
    for (key, dataset) in domains {
        let kind = hybrid_domain_type(key).unwrap_or(CollectionType::Table);
        let pseudo = CollectionDocument {
            format: "flowix.collection".into(),
            schema_version: 2,
            collection: CollectionMetadata {
                id: document.collection.id.clone(),
                kind,
                placement: document.collection.placement,
                name: String::new(),
                revision: document.collection.revision,
                created_at: document.collection.created_at.clone(),
                updated_at: document.collection.updated_at.clone(),
                properties: BTreeMap::new(),
            },
            payload: serde_json::json!({
                "schema_version": 2,
                "dataset": dataset,
                "views": {
                    "default_id": defaults.get(key).cloned().unwrap_or(Value::Null),
                    "items": views_by_domain.get(key.as_str()).cloned().unwrap_or_default(),
                },
            }),
        };
        validate_collection_v2(&pseudo)?;
    }
    Ok(())
}

fn validate_collection_v2(document: &CollectionDocument) -> Result<(), String> {
    let payload = &document.payload;
    only_keys(payload, &["schema_version", "dataset", "views"])?;
    let dataset = payload.get("dataset").ok_or("MISSING_COLLECTION_DATASET")?;
    only_keys(dataset, &["source", "schema", "records", "filter"])?;
    let source = dataset.get("source").ok_or("MISSING_COLLECTION_SOURCE")?;
    only_keys(source, &["scope", "depth", "path"])?;
    let scope = source["scope"].as_str().ok_or("INVALID_COLLECTION_SCOPE")?;
    let depth = source["depth"].as_str().ok_or("INVALID_COLLECTION_DEPTH")?;
    if !matches!(depth, "direct_children" | "descendants") {
        return Err("INVALID_COLLECTION_DEPTH".into());
    }
    match (document.collection.placement, scope) {
        (CollectionPlacement::Folder, "containing_folder") if source.get("path").is_none() => {}
        (CollectionPlacement::Standalone, "notebook") if source.get("path").is_none() => {}
        (CollectionPlacement::Standalone, "folder") => {
            let path = source["path"]
                .as_str()
                .ok_or("INVALID_COLLECTION_SCOPE_PATH")?;
            if path.is_empty()
                || path.starts_with('/')
                || path.contains('\\')
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err("INVALID_COLLECTION_SCOPE_PATH".into());
            }
        }
        _ => return Err("COLLECTION_SCOPE_PLACEMENT_MISMATCH".into()),
    }

    let schema = dataset.get("schema").ok_or("MISSING_COLLECTION_SCHEMA")?;
    only_keys(
        schema,
        if document.collection.kind == CollectionType::Table {
            &["primary_field_id", "fields", "field_order", "preset_fields", "deleted_presets"]
        } else {
            &["fields"]
        },
    )?;
    let fields = schema["fields"]
        .as_array()
        .ok_or("INVALID_COLLECTION_SCHEMA")?;
    if document.collection.kind == CollectionType::Table {
        if let Some(presets) = schema.get("preset_fields") {
            let presets = presets.as_array().ok_or("INVALID_PRESET_FIELDS")?;
            let allowed = [
                "__note_name__",
                "__note_description__",
                "__note_tags__",
                "__note_colors__",
                "__note_icon__",
                "__note_pinned__",
                "__note_calendar_date__",
            ];
            let mut seen = HashSet::new();
            for id in presets {
                let id = id.as_str().ok_or("INVALID_PRESET_FIELDS")?;
                if !allowed.contains(&id) || !seen.insert(id) {
                    return Err("INVALID_PRESET_FIELDS".into());
                }
            }
        }
        if let Some(deleted) = schema.get("deleted_presets") {
            let deleted = deleted.as_array().ok_or("INVALID_DELETED_PRESETS")?;
            let mut deleted_ids = HashSet::new();
            for preset in deleted {
                only_keys(preset, &["id", "name", "revision", "optionIds", "multiple", "key", "type", "options"])?;
                let id = preset["id"].as_str().ok_or("INVALID_DELETED_PRESET_ID")?;
                let key = preset["key"].as_str().filter(|key| !key.trim().is_empty()).ok_or("INVALID_DELETED_PRESET_KEY")?;
                let kind = preset["type"].as_str().ok_or("INVALID_DELETED_PRESET_TYPE")?;
                if !valid_id(id, "fld_") || !deleted_ids.insert(id.to_owned()) || key == "flowix_property_types"
                    || !["Text", "URL", "Icon", "Boolean", "Number", "Date", "Select", "MultiSelect", "Tag", "Color", "Image"].contains(&kind)
                    || preset.get("revision").and_then(Value::as_u64).is_none_or(|revision| revision == 0)
                    || preset.get("options").is_some_and(|options| options.as_array().is_none_or(|values| values.iter().any(|value| !value.is_string())))
                    || preset.get("optionIds").is_some_and(|ids| ids.as_array().is_none_or(|values| values.iter().any(|value| value.as_str().is_none_or(|id| !valid_id(id, "opt_"))))) {
                    return Err("INVALID_DELETED_PRESET".into());
                }
            }
        }
    }
    if matches!(document.collection.kind, CollectionType::MediaLibrary | CollectionType::WorkDocuments) && !fields.is_empty() {
        return Err("COLLECTION_FIELDS_UNSUPPORTED".into());
    }
    let records = dataset.get("records").ok_or("MISSING_COLLECTION_RECORDS")?;
    only_keys(records, &["include", "exclude"])?;
    for key in ["include", "exclude"] {
        let entries = array(records, key)?;
        let mut record_ids = HashSet::new();
        let mut record_paths = HashSet::new();
        for entry in entries {
            match document.collection.kind {
                CollectionType::Table => {
                    only_keys(entry, &["id", "updated_at", "note_path"])?;
                    let path = entry["note_path"]
                        .as_str()
                        .ok_or("INVALID_NOTE_RECORD_PATH")?;
                    if entry.get("id").is_some_and(|value| {
                        value.as_str().is_none_or(|id| {
                            !valid_id(id, "rec_") || !record_ids.insert(id.to_owned())
                        })
                    }) || entry.get("updated_at").is_some_and(|value| {
                        value
                            .as_str()
                            .is_none_or(|date| chrono::DateTime::parse_from_rfc3339(date).is_err())
                    }) {
                        return Err("INVALID_NOTE_RECORD".into());
                    }
                    let is_draft = key == "include" && path.is_empty();
                    if !is_draft {
                        validate_relative_resource_path(Some(path), "note_path")?;
                    }
                    if !is_draft && !record_paths.insert(path.to_owned()) {
                        return Err("DUPLICATE_NOTE_RECORD".into());
                    }
                }
                CollectionType::MediaLibrary => {
                    only_keys(entry, &["id", "updated_at", "resource_id", "relative_path"])?;
                    let path = entry.get("relative_path").and_then(Value::as_str);
                    if entry["resource_id"].as_str().is_none_or(str::is_empty)
                        || entry.get("id").is_some_and(|value| {
                            value.as_str().is_none_or(|id| {
                                !valid_id(id, "rec_") || !record_ids.insert(id.to_owned())
                            })
                        })
                        || entry.get("updated_at").is_some_and(|value| {
                            value.as_str().is_none_or(|date| {
                                chrono::DateTime::parse_from_rfc3339(date).is_err()
                            })
                        })
                    {
                        return Err("INVALID_MEDIA_RESOURCE_ID".into());
                    }
                    validate_relative_resource_path(path, "relative_path")?;
                    if !record_paths.insert(path.unwrap().to_owned()) {
                        return Err("DUPLICATE_MEDIA_RECORD".into());
                    }
                }
                CollectionType::WorkDocuments | CollectionType::Hybrid => return Err("WORK_DOCUMENTS_RECORDS_UNSUPPORTED".into()),
            }
        }
    }
    if let Some(filter) = dataset.get("filter") {
        if !filter.is_null() {
            validate_dataset_filter(filter, document.collection.kind)?;
        }
    }
    let views = payload.get("views").ok_or("MISSING_COLLECTION_VIEWS")?;
    only_keys(views, &["default_id", "items"])?;
    let items = array(views, "items")?;
    if items.is_empty() {
        return Err("COLLECTION_REQUIRES_VIEW".into());
    }
    let mut ids = HashSet::new();
    for view in items {
        only_keys(view, &["id", "name", "layout", "filter", "sort", "config"])?;
        id(view, "view_", &mut ids)?;
        let layout = view["layout"].as_str().ok_or("INVALID_COLLECTION_VIEW")?;
        let layout_valid = match document.collection.kind {
            CollectionType::Table => matches!(layout, "table" | "kanban" | "calendar" | "gallery"),
            CollectionType::MediaLibrary => layout == "waterfall",
            CollectionType::WorkDocuments => layout == "gallery",
            CollectionType::Hybrid => false,
        };
        if view["name"]
            .as_str()
            .is_none_or(|name| name.trim().is_empty())
            || !layout_valid
            || !view["config"].is_object()
        {
            return Err("INVALID_COLLECTION_VIEW".into());
        }
        if let Some(filter) = view.get("filter") {
            validate_rule_filter(filter, document.collection.kind)?;
        }
        if let Some(sort) = view.get("sort") {
            for item in sort.as_array().ok_or("INVALID_COLLECTION_SORT")? {
                only_keys(item, &["field", "direction"])?;
                if item["field"].as_str().is_none_or(str::is_empty)
                    || !matches!(item["direction"].as_str(), Some("asc" | "desc"))
                {
                    return Err("INVALID_COLLECTION_SORT".into());
                }
                if document.collection.kind == CollectionType::MediaLibrary
                    && (item["field"] != "created_at" || item["direction"] != "desc")
                {
                    return Err("INVALID_COLLECTION_SORT".into());
                }
            }
        }
    }
    let default_id = views["default_id"].as_str().ok_or("INVALID_DEFAULT_VIEW")?;
    // Table view selection is a recoverable preference. A dangling ID falls
    // back to the first view in the frontend; structural view validation remains strict.
    if document.collection.kind != CollectionType::Table && !ids.contains(default_id) {
        return Err("INVALID_DEFAULT_VIEW".into());
    }
    if document.collection.kind == CollectionType::Table {
        let table_views = items.iter().map(|view| serde_json::json!({
            "id": view["id"], "name": view["name"], "type": view["layout"], "config": view["config"]
        })).collect::<Vec<_>>();
        let legacy = serde_json::json!({
            "schema_version": 1,
            "table": { "primary_field_id": schema["primary_field_id"], "fields": fields, "views": table_views },
            "records": { "data": [], "auto_collect": null }
        });
        validate_table(&legacy)?;
        if let Some(order) = schema.get("field_order") {
            let order = order.as_array().ok_or("INVALID_FIELD_ORDER")?;
            let mut seen = HashSet::new();
            for (index, id) in order.iter().enumerate() {
                let id = id.as_str().ok_or("INVALID_FIELD_ORDER")?;
                if !seen.insert(id) || (index == 0 && schema["primary_field_id"] != id)
                    || (!fields.iter().any(|field| field["id"] == id) && !is_supported_table_field_id(id)) {
                    return Err("INVALID_FIELD_ORDER".into());
                }
            }
        }
    }
    Ok(())
}
fn validate_rule_filter(filter: &Value, collection_type: CollectionType) -> Result<(), String> {
  validate_rule_filter_depth(filter, collection_type, 0, false)
}
fn validate_dataset_filter(filter: &Value, collection_type: CollectionType) -> Result<(), String> {
    if filter.get("conditions").is_none() && filter.get("match").is_none() {
        return validate_rule_filter(filter, collection_type);
    }
    only_keys(filter, &["path", "match", "conditions"])?;
    match filter.get("path") {
        Some(Value::Null) => {}
        Some(Value::String(path)) if path.is_empty() => {}
        Some(Value::String(path)) => validate_relative_resource_path(Some(path), "filter.path")?,
        _ => return Err("INVALID_COLLECTION_FILTER_PATH".into()),
    }
    if !matches!(filter["match"].as_str(), Some("all" | "any")) {
        return Err("INVALID_COLLECTION_FILTER_MATCH".into());
    }
    if collection_type == CollectionType::MediaLibrary && filter["match"] != "all" {
        return Err("INVALID_COLLECTION_FILTER_MATCH".into());
    }
    for rule in array(filter, "conditions")? {
        if rule.get("all").is_some() || rule.get("any").is_some() || rule["field"] == "path" {
            return Err("INVALID_COLLECTION_FILTER_CONDITION".into());
        }
    }
    validate_rule_filter_depth(&serde_json::json!({"all":array(filter, "conditions")?,"any":[]}), collection_type, 0, true)
}
fn validate_rule_filter_depth(filter: &Value, collection_type: CollectionType, depth: usize, shared_asset_kinds: bool) -> Result<(), String> {
    only_keys(filter, &["all", "any"])?;
    for key in ["all", "any"] {
        for rule in array(filter, key)? {
            if rule.get("all").is_some() || rule.get("any").is_some() {
                if depth != 0 { return Err("INVALID_COLLECTION_FILTER_DEPTH".into()); }
                validate_rule_filter_depth(rule, collection_type, depth + 1, shared_asset_kinds)?;
                continue;
            }
            only_keys(rule, &["field", "op", "value"])?;
            if rule["field"].as_str().is_none_or(str::is_empty)
                || !matches!(
                    rule["op"].as_str(),
                    Some("eq" | "equals" | "contains" | "in" | "gt" | "lt")
                )
                || rule.get("value").is_none()
            {
                return Err("INVALID_COLLECTION_FILTER_RULE".into());
            }
            match rule["op"].as_str().unwrap_or_default() {
                "contains" if !rule["value"].is_string() => {
                    return Err("INVALID_COLLECTION_FILTER_VALUE".into());
                }
                "in" if rule["value"].as_array().is_none_or(Vec::is_empty) => {
                    return Err("INVALID_COLLECTION_FILTER_VALUE".into());
                }
                "eq" | "equals"
                    if !(rule["value"].is_string()
                        || rule["value"].is_number()
                        || rule["value"].is_boolean()) =>
                {
                    return Err("INVALID_COLLECTION_FILTER_VALUE".into());
                }
                _ => {}
            }
            let field = rule["field"].as_str().unwrap_or_default();
            if shared_asset_kinds && field == "kind"
                && matches!(collection_type, CollectionType::MediaLibrary | CollectionType::WorkDocuments) {
                let asset_kind = |value: &Value| matches!(value.as_str(), Some("image" | "video" | "document" | "spreadsheet" | "presentation" | "web" | "archive" | "database"));
                if (rule["op"] == "eq" && asset_kind(&rule["value"]))
                    || (rule["op"] == "in" && rule["value"].as_array().is_some_and(|values| !values.is_empty() && values.iter().all(asset_kind))) {
                    continue;
                }
                return Err("INVALID_COLLECTION_FILTER_RULE".into());
            }
            let valid_for_type = match collection_type {
                CollectionType::Table => match field {
                    "file_name" | "path" => rule["op"] == "contains",
                    "kind" => (rule["op"] == "eq" && rule["value"] == "note")
                        || (rule["op"] == "in"
                            && rule["value"].as_array().is_some_and(|values| {
                                values.len() == 1 && values[0] == "note"
                            })),
                    _ => matches!(rule["op"].as_str(), Some("eq" | "equals" | "contains" | "in" | "gt" | "lt")),
                },
                CollectionType::MediaLibrary => match field {
                    "file_name" | "path" => rule["op"] == "contains" && rule["value"].is_string(),
                    "kind" => (rule["op"] == "eq"
                        && matches!(rule["value"].as_str(), Some("image" | "video")))
                        || (rule["op"] == "in"
                            && rule["value"].as_array().is_some_and(|values| {
                                !values.is_empty()
                                    && values
                                        .iter()
                                        .all(|value| matches!(value.as_str(), Some("image" | "video")))
                            })),
                    _ => false,
                },
                CollectionType::WorkDocuments => match field {
                    "file_name" | "path" => rule["op"] == "contains" && rule["value"].is_string(),
                    "kind" => (rule["op"] == "eq"
                        && matches!(rule["value"].as_str(), Some("document" | "spreadsheet" | "presentation" | "web" | "archive" | "database")))
                        || (rule["op"] == "in"
                            && rule["value"].as_array().is_some_and(|values| {
                                !values.is_empty() && values.iter().all(|value| matches!(value.as_str(), Some("document" | "spreadsheet" | "presentation" | "web" | "archive" | "database")))
                            })),
                    _ => false,
                },
                CollectionType::Hybrid => false,
            };
            if !valid_for_type {
                return Err("INVALID_COLLECTION_FILTER_RULE".into());
            }
        }
    }
    Ok(())
}
fn validate_relative_resource_path(path: Option<&str>, field: &str) -> Result<(), String> {
    let path = path.ok_or_else(|| format!("INVALID_COLLECTION_RESOURCE:{field}"))?;
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("INVALID_COLLECTION_RESOURCE:{field}"));
    }
    Ok(())
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
                        || !matches!(property["operator"].as_str(), Some("equals" | "contains" | "gt" | "lt"))
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
const BUILTIN_TABLE_FIELD_IDS: &[&str] = &[
    "__note_created_at__",
    "__note_updated_at__",
    "__note_relative_path__",
    "__note_size__",
    "__note_icon__",
    "__note_tags__",
    "__note_colors__",
    "__note_pinned__",
    "__note_description__",
    "__note_name__",
    "__note_calendar_date__",
];
const LEGACY_TABLE_FIELD_IDS: &[&str] = &["__note_todos__"];

fn is_supported_table_field_id(id: &str) -> bool {
    BUILTIN_TABLE_FIELD_IDS.contains(&id) || LEGACY_TABLE_FIELD_IDS.contains(&id)
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
            &["id", "type", "name", "property_key", "options", "multiple", "preset_revision", "preset_pending"],
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
            "noteTag",
            // Legacy spelling retained so older saved tables remain valid.
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
        if field.get("preset_pending").is_some_and(|v| !v.is_boolean()) {
            return Err("INVALID_PRESET_PENDING".into());
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
                // Accept widths persisted by the older manual-resize table UI.
                if kind == "table" {
                    only_keys(config, &["visible_fields", "tag_column_width"])?;
                    if config.get("tag_column_width").is_some_and(|width| {
                        width.as_f64().is_none_or(|width| !width.is_finite() || !(120.0..=320.0).contains(&width))
                    }) {
                        return Err("INVALID_TAG_COLUMN_WIDTH".into());
                    }
                } else {
                    only_keys(config, &["visible_fields"])?;
                }
                if array(config, "visible_fields")?
                    .iter()
                    .any(|v| v.as_str().is_none_or(|id| {
                        !fields.contains(id)
                            && !(kind == "table" && is_supported_table_field_id(id))
                    }))
                {
                    return Err("INVALID_VIEW_FIELD".into());
                }
            }
            "kanban" => {
                only_keys(config, &["group_by"])?;
                if config.get("group_by").is_some_and(|value| {
                    value.as_str().is_none_or(str::is_empty)
                }) {
                    return Err("INVALID_KANBAN_FIELD".into());
                }
            }
            "calendar" => {
                only_keys(config, &["date_field", "title_field", "week_start"])?;
                if config.get("date_field").is_some_and(|value| {
                    value.as_str().is_none_or(str::is_empty)
                }) || config.get("title_field").is_some_and(|value| {
                    value.as_str().is_none_or(str::is_empty)
                }) {
                    return Err("INVALID_DATE_FIELD".into());
                }
                if config.get("week_start").is_some_and(|v| *v != 1) {
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

#[cfg(test)]
mod builtin_field_tests {
    use super::*;

    #[test]
    fn shared_asset_dataset_accepts_all_asset_kinds_but_views_keep_their_domain() {
        let rule = serde_json::json!({"field":"kind","op":"in","value":["image","document"]});
        let filter = serde_json::json!({"path":"项目","match":"all","conditions":[rule.clone()]});
        for kind in [CollectionType::MediaLibrary, CollectionType::WorkDocuments] {
            assert!(validate_dataset_filter(&filter, kind).is_ok());
            assert!(validate_rule_filter(&serde_json::json!({"all":[rule.clone()],"any":[]}), kind).is_err());
        }
        assert!(validate_dataset_filter(&filter, CollectionType::Table).is_err());
    }

    #[test]
    fn hybrid_folder_round_trips_and_validates_domains() {
        let source = include_str!("../../fixtures/collections/hybrid-folder.yaml");
        let document = CollectionDocument::parse(source).unwrap();
        document.validate().unwrap();
        assert_eq!(document.collection.kind, CollectionType::Hybrid);
        assert_eq!(document.collection.kind.as_str(), "hybrid");
        let restored = CollectionDocument::parse(&document.serialize().unwrap()).unwrap();
        assert_eq!(restored.payload, document.payload);
        // v2 single-type files stay rejected when re-typed as hybrid at v2.
        let mut swapped = CollectionDocument::parse(source).unwrap();
        swapped.schema_version = 2;
        swapped.payload["schema_version"] = serde_json::json!(2);
        assert_eq!(swapped.validate().unwrap_err(), "UNSUPPORTED_COLLECTION_VERSION");
    }

    #[test]
    fn hybrid_requires_views_for_every_domain_and_rejects_unknown_domains() {
        let source = include_str!("../../fixtures/collections/hybrid-folder.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        document.payload["views"]["items"].as_array_mut().unwrap().retain(|view| view["domain"] != "media");
        assert_eq!(document.validate().unwrap_err(), "INVALID_COLLECTION_DOMAINS");
        let mut document = CollectionDocument::parse(source).unwrap();
        document.payload["views"]["items"][1]["domain"] = serde_json::json!("bookmarks");
        assert_eq!(document.validate().unwrap_err(), "INVALID_COLLECTION_VIEW_DOMAIN");
        let mut document = CollectionDocument::parse(source).unwrap();
        document.payload["domains"]["bookmarks"] = serde_json::json!({"source":{"scope":"containing_folder","depth":"descendants"},"schema":{"fields":[]},"records":{"include":[],"exclude":[]},"filter":null});
        document.payload["views"]["default_by_domain"]["bookmarks"] = serde_json::json!("view_cccccccccccccccccccccccccccccccc");
        assert_eq!(document.validate().unwrap_err(), "INVALID_COLLECTION_DOMAINS");
    }

    #[test]
    fn hybrid_file_tree_flag_requires_folder_placement() {
        let source = include_str!("../../fixtures/collections/hybrid-folder.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        document.collection.placement = CollectionPlacement::Standalone;
        // containing_folder scope is folder-only, so also relax the source to notebook.
        for dataset in document.payload["domains"].as_object_mut().unwrap().values_mut() {
            dataset["source"] = serde_json::json!({"scope":"notebook","depth":"descendants"});
        }
        assert_eq!(document.validate().unwrap_err(), "INVALID_COLLECTION_FILE_TREE");
        document.payload["file_tree"] = serde_json::json!(false);
        assert!(document.validate().is_ok());
    }

    #[test]
    fn hybrid_rebase_and_media_normalization_cover_every_domain() {
        let source = include_str!("../../fixtures/collections/hybrid-folder.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        // The rebase uses standalone `folder` scopes, which require a standalone
        // placement; the file tree flag is folder-only.
        document.collection.placement = CollectionPlacement::Standalone;
        document.payload["file_tree"] = serde_json::json!(false);
        for key in ["media", "work_documents"] {
            document.payload["domains"][key]["source"] = serde_json::json!({"scope":"notebook","depth":"descendants"});
        }
        document.payload["domains"]["notes"]["source"] = serde_json::json!({"scope":"folder","path":"Old","depth":"descendants"});
        document.payload["domains"]["notes"]["records"] = serde_json::json!({
            "include":[{"id":"rec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","updated_at":"2026-10-31T00:00:00Z","note_path":"Old/note.md"}],
            "exclude":[]
        });
        document.payload["domains"]["media"]["records"] = serde_json::json!({
            "include":[
                {"id":"rec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","updated_at":"2026-10-31T00:00:00Z","resource_id":"old","relative_path":"Old/a.png"},
                {"id":"rec_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","updated_at":"2026-10-31T00:00:00Z","resource_id":"old","relative_path":"Old/b.png"}
            ],
            "exclude":[]
        });
        document.payload["domains"]["media"]["filter"] = serde_json::json!({"all":[{"field":"path","op":"contains","value":"Old/sub"}],"any":[]});
        // work_documents records may not be handwritten; rebase still covers its filter.
        document.payload["domains"]["work_documents"]["filter"] = serde_json::json!({"all":[{"field":"path","op":"contains","value":"Old"}],"any":[]});
        document.payload["views"]["items"][0]["filter"] = serde_json::json!({"all":[],"any":[{"field":"path","op":"contains","value":"Old"}]});
        assert!(document.rebase_paths("Old", "New"));
        assert_eq!(document.payload["domains"]["notes"]["records"]["include"][0]["note_path"], "New/note.md");
        assert_eq!(document.payload["domains"]["notes"]["source"]["path"], "New");
        assert_eq!(document.payload["domains"]["media"]["records"]["include"][0]["relative_path"], "New/a.png");
        assert_eq!(document.payload["domains"]["media"]["filter"]["all"][0]["value"], "New/sub");
        assert_eq!(document.payload["domains"]["work_documents"]["filter"]["all"][0]["value"], "New");
        assert_eq!(document.payload["views"]["items"][0]["filter"]["any"][0]["value"], "New");
        assert!(document.validate().is_ok());
        assert!(document.normalize_media_resource_ids("nb_00000000000000000000000000000000").unwrap());
        assert_eq!(document.payload["domains"]["media"]["records"]["include"][0]["resource_id"], "nb_00000000000000000000000000000000::New/a.png");
        document.validate().unwrap();
    }

    #[test]
    fn calendar_date_preset_contract_round_trips() {
        let source = include_str!("../../fixtures/collections/table-calendar-preset.yaml");
        let document = CollectionDocument::parse(source).unwrap();
        document.validate().unwrap();
        assert_eq!(document.payload["views"]["items"][0]["config"]["date_field"], "__note_calendar_date__");
        let restored = CollectionDocument::parse(&document.serialize().unwrap()).unwrap();
        assert_eq!(restored.payload, document.payload);
    }


    #[test]
    fn directory_rebase_updates_records_sources_and_filters_without_touching_similar_prefixes() {
        let mut document = CollectionDocument::parse(include_str!("../../fixtures/collections/table-builtin-fields.yaml")).unwrap();
        document.collection.placement = CollectionPlacement::Standalone;
        document.payload["dataset"]["source"] = serde_json::json!({"scope":"folder","path":"Old","depth":"descendants"});
        document.payload["dataset"]["records"] = serde_json::json!({
            "include":[{"id":"rec_dddddddddddddddddddddddddddddddd","updated_at":"2026-10-11T00:00:00Z","note_path":"Old/a.md"}],
            "exclude":[{"note_path":"Old/sub/b.md"},{"note_path":"Oldish/keep.md"}]
        });
        document.payload["dataset"]["filter"] = serde_json::json!({"all":[{"field":"path","op":"contains","value":"Old/sub"}],"any":[]});
        document.payload["views"]["items"][0]["filter"] = serde_json::json!({"all":[],"any":[{"field":"path","op":"contains","value":"Old"}]});
        assert!(document.rebase_paths("Old", "New"));
        assert_eq!(document.payload["dataset"]["records"]["include"][0]["note_path"], "New/a.md");
        assert_eq!(document.payload["dataset"]["records"]["exclude"][0]["note_path"], "New/sub/b.md");
        assert_eq!(document.payload["dataset"]["records"]["exclude"][1]["note_path"], "Oldish/keep.md");
        assert_eq!(document.payload["dataset"]["source"]["path"], "New");
        assert_eq!(document.payload["dataset"]["filter"]["all"][0]["value"], "New/sub");
        assert_eq!(document.payload["views"]["items"][0]["filter"]["any"][0]["value"], "New");
        assert!(!document.rebase_paths("Old", "New"));
        document.validate().unwrap();
    }

    #[test]
    fn table_allows_deleted_remembered_view_but_still_validates_view_definitions() {
        let source = include_str!("../../fixtures/collections/table-builtin-fields.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        document.payload["views"]["default_id"] = serde_json::json!("view_ffffffffffffffffffffffffffffffff");
        assert!(document.validate().is_ok());
        document.payload["views"]["items"][0]["config"]["visible_fields"] = serde_json::json!(["__unknown__"]);
        assert_eq!(document.validate().unwrap_err(), "INVALID_VIEW_FIELD");
    }

    #[test]
    fn v2_secondary_views_allow_deleted_or_missing_referenced_fields() {
        let source = include_str!("../../fixtures/collections/table-builtin-fields.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        let views = document.payload["views"]["items"].as_array_mut().unwrap();
        views[0]["layout"] = serde_json::json!("calendar");
        views[0]["config"] = serde_json::json!({});
        views[0]["id"] = serde_json::json!("view_cccccccccccccccccccccccccccccccc");
        views[0]["name"] = serde_json::json!("日历");
        views.push(serde_json::json!({
            "id": "view_dddddddddddddddddddddddddddddddd",
            "name": "看板",
            "layout": "kanban",
            "filter": { "all": [], "any": [] },
            "sort": [],
            "config": {}
        }));
        assert!(document.validate().is_ok());
    }

    fn payload(layout: &str, visible: Value) -> Value {
        serde_json::json!({
            "table": {
                "primary_field_id": "fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "fields": [{ "id": "fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "type": "primary", "property_key": "note" }],
                "views": [{ "id": "view_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "name": "表格", "type": layout, "config": { "visible_fields": visible } }]
            },
            "records": { "data": [], "auto_collect": null }
        })
    }

    #[test]
    fn shared_v2_fixture_preserves_builtin_visibility_and_rejects_unknown_fields() {
        let source = include_str!("../../fixtures/collections/table-builtin-fields.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        assert!(CollectionDocument::parse(&document.serialize().unwrap()).is_ok());
        document.payload["views"]["items"][0]["config"]["visible_fields"] = serde_json::json!([]);
        let hidden = CollectionDocument::parse(&document.serialize().unwrap()).unwrap();
        assert_eq!(hidden.payload["views"]["items"][0]["config"]["visible_fields"], serde_json::json!([]));
        document.payload["views"]["items"][0]["config"]["visible_fields"] = serde_json::json!(["__unknown__"]);
        assert_eq!(document.validate().unwrap_err(), "INVALID_VIEW_FIELD");
    }

    #[test]
    fn table_accepts_builtin_visibility_without_schema_fields() {
        let visible = serde_json::json!(["__note_created_at__", "__note_updated_at__", "__note_relative_path__", "__note_size__"]);
        assert!(validate_table(&payload("table", visible.clone())).is_ok());
        assert_eq!(validate_table(&payload("gallery", visible)).unwrap_err(), "INVALID_VIEW_FIELD");
        assert_eq!(validate_table(&payload("table", serde_json::json!(["__unknown__"]))).unwrap_err(), "INVALID_VIEW_FIELD");
    }

    #[test]
    fn table_reopens_persisted_tag_widths_and_validates_their_range() {
        let source = include_str!("../../fixtures/collections/table-builtin-fields.yaml");
        let mut document = CollectionDocument::parse(source).unwrap();
        for width in [120, 245, 320] {
            document.payload["views"]["items"][0]["config"]["tag_column_width"] = serde_json::json!(width);
            let saved = document.serialize().unwrap();
            assert!(CollectionDocument::parse(&saved).is_ok());
        }
        for width in [serde_json::json!(119), serde_json::json!(321), serde_json::json!("160"), Value::Null] {
            document.payload["views"]["items"][0]["config"]["tag_column_width"] = width;
            assert_eq!(document.validate().unwrap_err(), "INVALID_TAG_COLUMN_WIDTH");
        }
    }
}
