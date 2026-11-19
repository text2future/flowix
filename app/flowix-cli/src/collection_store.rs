//! Read-only collection dataset access shared by the CLI and MCP operation layer.
use crate::{errors::CliError, store};
use flowix_core::{
    collection::{
        display_name_for_path, valid_id, CollectionDocument, CollectionPlacement, CollectionType,
    },
    memo_file::{FileManagementPolicy, NoteEntry, ResourceKind},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

fn add_field_definitions_json(fields: &mut Vec<Value>, source: &str) -> Result<Vec<Value>, CliError> {
    let input: Value = serde_json::from_str(source)
        .map_err(|e| CliError::Usage(format!("invalid fields JSON: {e}")))?;
    let definitions = input.as_array().ok_or_else(|| CliError::Usage("fields file must contain an array".into()))?;
    if definitions.is_empty() { return Err(CliError::Usage("fields array must not be empty".into())); }
    let make_id = |prefix: &str| format!("{prefix}{}", uuid::Uuid::now_v7().simple());
    let mut keys = fields.iter().filter_map(|field| field["property_key"].as_str().map(|v| v.trim().to_lowercase())).collect::<std::collections::HashSet<_>>();
    let start = fields.len();
    for definition in definitions {
        let obj = definition.as_object().ok_or_else(|| CliError::Usage("each field must be an object".into()))?;
        if obj.keys().any(|key| !["name", "property_key", "type", "options"].contains(&key.as_str())) {
            return Err(CliError::Usage("unknown field definition key".into()));
        }
        let name = obj.get("name").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
            .ok_or_else(|| CliError::Usage("field name is required".into()))?;
        let key = obj.get("property_key").map(|v| v.as_str().unwrap_or("").trim()).unwrap_or(name);
        if key.is_empty() || !keys.insert(key.to_lowercase()) || ["flowix_property_types", "flowix_plugin"].iter().any(|reserved| key.eq_ignore_ascii_case(reserved)) {
            return Err(CliError::Usage(format!("invalid or duplicate property_key: {key}")));
        }
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if !["Text", "URL", "Icon", "Boolean", "Number", "Date", "Select", "MultiSelect", "Tag", "Color", "Image"].contains(&kind) {
            return Err(CliError::Usage(format!("unsupported field type: {kind}")));
        }
        if matches!(kind, "Select" | "MultiSelect") && obj.get("options").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return Err(CliError::Usage(format!("{kind} field requires at least one option: {name}")));
        }
        let mut field = json!({"id":make_id("fld_"),"name":name,"property_key":key,"type":kind});
        if let Some(options) = obj.get("options") {
            if !matches!(kind, "Select" | "MultiSelect") {
                return Err(CliError::Usage(format!("options are only supported for Select and MultiSelect: {name}")));
            }
            let options = options.as_array().ok_or_else(|| CliError::Usage(format!("options must be an array: {name}")))?;
            let mut labels = std::collections::HashSet::new();
            let mut result = Vec::new();
            for option in options {
                let label = option.as_str().map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| CliError::Usage(format!("option must be a nonempty string: {name}")))?;
                if !labels.insert(label.to_lowercase()) { return Err(CliError::Usage(format!("duplicate option: {label}"))); }
                result.push(json!({"id":make_id("opt_"),"label":label}));
            }
            field["options"] = json!(result);
        }
        fields.push(field);
    }
    Ok(fields[start..].to_vec())
}

/// Create through the same notebook file lock and collection validator used by the app.
pub(crate) fn create(notebook_key: &str, relative: &str, fields_file: Option<&str>) -> Result<Value, CliError> {
    let input = fields_file.map(fs::read_to_string).transpose()?;
    create_with_fields(notebook_key, relative, input.as_deref())
}

pub(crate) fn create_with_fields(notebook_key: &str, relative: &str, fields_input: Option<&str>) -> Result<Value, CliError> {
    let memo = store::open()?;
    let notebook = store::resolve_notebook_config(&memo, notebook_key)?;
    let catalog = flowix_core::collection_store::CollectionCatalog::open(&memo, &notebook.id)
        .map_err(CliError::Other)?;
    let path = catalog.checked_path(relative).map_err(CliError::Usage)?;
    let filename = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
    if !filename.ends_with(".index.yaml") || filename == ".index.yaml" {
        return Err(CliError::Usage("standalone collection path must end in .index.yaml".into()));
    }
    let make_id = |prefix: &str| format!("{prefix}{}", uuid::Uuid::now_v7().simple());
    let collection_id = make_id("col_");
    let primary = make_id("fld_");
    let view = make_id("view_");
    let mut fields = vec![json!({"id":primary,"type":"primary","property_key":"note"})];
    if let Some(input) = fields_input { add_field_definitions_json(&mut fields, input)?; }
    let ids: Vec<Value> = fields.iter().map(|field| field["id"].clone()).collect();
    let mut order = ids.clone();
    order.extend(["__note_tags__", "__note_icon__", "__note_created_at__", "__note_updated_at__", "__note_relative_path__", "__note_size__"].iter().map(|v| json!(v)));
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let source = json!({"format":"flowix.collection", "schema_version":2,
        "collection":{"id":collection_id,"type":"notes","placement":"standalone","revision":0,"created_at":now,"updated_at":now,"properties":{}},
        "payload":{"schema_version":2,"dataset":{"source":{"scope":"notebook"},"schema":{"primary_field_id":primary,"fields":fields,"preset_fields":["__note_tags__","__note_icon__"],"field_order":order},"records":{"include":[],"exclude":[]},"filter":null},
        "views":{"default_id":view,"items":[{"id":view,"name":"表格","layout":"table","filter":{"all":[],"any":[]},"sort":[{"field":"modified_at","direction":"desc"}],"config":{"visible_fields":ids}}]}}});
    let document = CollectionDocument::parse(&source.to_string()).map_err(CliError::Other)?;
    document.validate().map_err(CliError::Usage)?;
    let content = document.serialize().map_err(CliError::Other)?;
    memo.create_file_for_notebook(&notebook.id, &path, content.as_bytes())?;
    flowix_core::collection_store::refresh_path(&memo, &path);
    Ok(json!({"ok":true,"action":"collection.create","notebookId":notebook.id,"collectionId":collection_id,"relativePath":relative,"revision":0,"fields":fields}))
}

pub(crate) fn add_fields(notebook_key: &str, id: Option<&str>, relative: Option<&str>, fields_file: &str) -> Result<Value, CliError> {
    add_fields_with_json(notebook_key, id, relative, &fs::read_to_string(fields_file)?)
}

pub(crate) fn add_fields_with_json(notebook_key: &str, id: Option<&str>, relative: Option<&str>, fields_input: &str) -> Result<Value, CliError> {
    let (notebook, root, path, mut document) = load_collection(notebook_key, id, relative)?;
    if document.collection.kind != CollectionType::Table {
        return Err(CliError::Usage("add-fields currently supports notes tables".into()));
    }
    let original_id = document.collection.id.clone();
    let original = fs::read_to_string(&path)?;
    // Re-read and validate the exact content used for the compare-and-swap.
    document = CollectionDocument::parse(&original).map_err(CliError::Other)?.normalized_v2().map_err(CliError::Other)?;
    document.validate().map_err(CliError::Other)?;
    if document.collection.kind != CollectionType::Table { return Err(CliError::Conflict("COLLECTION_TYPE_CHANGED".into())); }
    if original_id != document.collection.id { return Err(CliError::Conflict("COLLECTION_IDENTITY_CHANGED".into())); }
    let fields = document.payload.pointer_mut("/dataset/schema/fields").and_then(Value::as_array_mut).ok_or_else(|| CliError::Other("INVALID_COLLECTION_SCHEMA".into()))?;
    let added = add_field_definitions_json(fields, fields_input)?;
    let ids = added.iter().map(|field| field["id"].clone()).collect::<Vec<_>>();
    document.payload.pointer_mut("/dataset/schema/field_order").and_then(Value::as_array_mut).ok_or_else(|| CliError::Other("INVALID_COLLECTION_SCHEMA".into()))?.extend(ids.clone());
    if let Some(views) = document.payload.pointer_mut("/views/items").and_then(Value::as_array_mut) {
        for view in views {
            if matches!(view["layout"].as_str(), Some("table" | "gallery")) {
                if let Some(visible) = view.pointer_mut("/config/visible_fields").and_then(Value::as_array_mut) { visible.extend(ids.clone()); }
            }
        }
    }
    document.revise().map_err(CliError::Other)?;
    document.validate().map_err(CliError::Usage)?;
    let content = document.serialize().map_err(CliError::Other)?;
    let memo = store::open()?;
    match memo.write_file_if_matches_for_notebook(&notebook.id, &path, &content, Some(&original))? {
        flowix_core::memo_file::FileWriteOutcome::Saved => {},
        flowix_core::memo_file::FileWriteOutcome::Conflict { .. } => return Err(CliError::Conflict("COLLECTION_CONTENT_CONFLICT".into())),
    }
    flowix_core::collection_store::refresh_path(&memo, &path);
    Ok(json!({"ok":true,"action":"collection.add-fields","notebookId":notebook.id,"collectionId":document.collection.id,"relativePath":relative_string(&root, &path)?,"revision":document.collection.revision,"fields":added}))
}

/// Create a structured record and derive its frontmatter types from the collection schema.
pub(crate) fn add_record(notebook_key: &str, id: Option<&str>, relative: Option<&str>, input: &str, request_id: Option<&str>) -> Result<Value, CliError> {
    let record: Value = serde_json::from_str(input).map_err(|e| CliError::Usage(format!("invalid record JSON: {e}")))?;
    let obj = record.as_object().ok_or_else(|| CliError::Usage("record must be an object".into()))?;
    if obj.keys().any(|key| !["title", "properties", "content"].contains(&key.as_str())) { return Err(CliError::Usage("unknown record key; expected title, properties, content".into())); }
    let title = obj.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && !s.contains(['\n','\r'])).ok_or_else(|| CliError::Usage("record title must be a nonempty single line".into()))?;
    let body = match obj.get("content") { None => "", Some(Value::String(body)) => body, _ => return Err(CliError::Usage("content must be a string".into())) };
    let mut properties = match obj.get("properties") { None => serde_json::Map::new(), Some(Value::Object(p)) => p.clone(), _ => return Err(CliError::Usage("properties must be an object".into())) };
    let (notebook, _, _, document) = load_collection(notebook_key, id, relative)?;
    let dataset = dataset_for(&document, "notes").ok_or_else(|| CliError::Usage("COLLECTION_NOTES_DOMAIN_MISSING".into()))?;
    let fields = dataset.pointer("/schema/fields").and_then(Value::as_array).ok_or_else(|| CliError::Other("INVALID_COLLECTION_SCHEMA".into()))?;
    let mut types = serde_json::Map::new();
    for (key, value) in &mut properties {
        let field = fields.iter().find(|field| field["property_key"].as_str() == Some(key) && field["type"] != "primary")
            .ok_or_else(|| CliError::Usage(format!("unknown property `{key}`")))?;
        types.insert(key.clone(), field["type"].clone());
        let label = |input: &mut Value| {
            if let Some(options) = field["options"].as_array() {
                if let Some(option) = options.iter().find(|option| option["id"] == *input) { *input = option["label"].clone(); }
            }
        };
        match field["type"].as_str() {
            Some("Select") => label(value),
            Some("MultiSelect") => if let Some(values) = value.as_array_mut() { for value in values { label(value); } },
            _ => {},
        }
    }
    if !types.is_empty() { properties.insert("flowix_property_types".into(), Value::Object(types)); }
    let yaml = serde_json::to_string(&properties).map_err(|e| CliError::Other(e.to_string()))?;
    let content = format!("---\n{yaml}\n---\n\n# {title}\n\n{body}\n");
    let memo = store::open()?;
    let note = flowix_core::collection_store::add_note_with_request_schema(&memo, &notebook.id, Some(&document.collection.id), None, title, &content, request_id, dataset.get("schema"))
        .map_err(|message| {
            let mut error = CliError::collection_error(message);
            if let CliError::InvalidField { field, allowed, .. } = &mut error {
                *allowed = fields.iter().find(|item| item["property_key"].as_str() == Some(field))
                    .and_then(|item| item["options"].as_array())
                    .map(|options| options.iter().filter_map(|option| option["label"].as_str().map(str::to_owned)).collect());
            }
            error
        })?;
    Ok(json!({"ok":true,"action":"collection.add","notebookId":note.notebook_id,"collectionId":note.collection_id,"collectionPath":note.collection_path,"collectionRevision":note.collection_revision,"note":{"address":note.address,"relativePath":note.note_path}}))
}

pub(crate) fn read(
    notebook_key: &str,
    collection_id: Option<&str>,
    relative_path: Option<&str>,
) -> Result<Value, CliError> {
    if collection_id.is_some() == relative_path.is_some() {
        return Err(CliError::Usage(
            "collection read requires exactly one of collection id or path".into(),
        ));
    }

    let memo = store::open()?;
    let notebook = store::resolve_notebook_config(&memo, notebook_key)?;
    let root = fs::canonicalize(&notebook.path)?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    let (path, document) = if let Some(id) = collection_id {
        find_by_id(&root, &policy, id)?
    } else {
        read_by_path(&root, &policy, relative_path.expect("selector checked"))?
    };
    document.validate().map_err(CliError::Other)?;
    let relative_path = path
        .strip_prefix(&root)
        .map_err(|error| CliError::Other(error.to_string()))?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(json!({
        "ok": true,
        "action": "collection.read",
        "notebookId": notebook.id,
        "notebook": notebook.name,
        "relativePath": relative_path,
        "collection": {
            "id": document.collection.id,
            "type": document.collection.kind.as_str(),
            "name": display_name_for_path(&path, document.collection.placement),
            "revision": document.collection.revision,
            "createdAt": document.collection.created_at,
            "updatedAt": document.collection.updated_at,
            "properties": document.collection.properties,
        },
        "payload": document.payload,
    }))
}

pub(crate) fn list(
    notebook_key: Option<&str>,
    raw_type: Option<&str>,
    domain: Option<&str>,
    query: Option<&str>,
    limit: usize,
    offset: usize,
    snapshot: Option<&str>,
) -> Result<Value, CliError> {
    validate_page(limit, offset)?;
    if let Some(domain) = domain {
        validate_domain(domain)?;
    }
    let type_filter = raw_type.map(parse_collection_type).transpose()?;
    let memo = store::open()?;
    let notebook_key = store::resolve_notebook_key(notebook_key)?;
    let notebook = store::resolve_notebook_config(&memo, &notebook_key)?;
    let root = fs::canonicalize(&notebook.path)?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    let mut paths = Vec::new();
    collect_collection_files(&root, &root, &policy, &mut paths)?;
    paths.sort();

    let mut items = Vec::new();
    let mut diagnostics = Vec::new();
    let mut identities = std::collections::HashMap::<String, usize>::new();
    let mut complete = true;
    for path in paths {
        let relative = relative_string(&root, &path)?;
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                complete = false;
                diagnostics.push(json!({"relativePath":relative,"code":"COLLECTION_READ_FAILED","message":error.to_string()}));
                continue;
            }
        };
        let parsed = match CollectionDocument::parse(&source) {
            Ok(document) => document,
            Err(error) => {
                complete = false;
                diagnostics.push(
                    json!({"relativePath":relative,"code":"INVALID_COLLECTION","message":error}),
                );
                continue;
            }
        };
        if let Err(error) =
            validate_file_type(&path, parsed.collection.kind, parsed.collection.placement)
        {
            complete = false;
            diagnostics.push(
                json!({"relativePath":relative,"collectionId":parsed.collection.id,"code":error.to_string()}),
            );
            continue;
        }
        *identities.entry(parsed.collection.id.clone()).or_default() += 1;
        if let Err(error) = parsed.validate() {
            complete = false;
            diagnostics.push(
                json!({"relativePath":relative,"collectionId":parsed.collection.id,"code":error}),
            );
            continue;
        }
        if type_filter.is_some_and(|kind| parsed.collection.kind != kind) {
            continue;
        }
        let domains = domains_for(&parsed);
        if domain.is_some_and(|wanted| !domains.iter().any(|item| item == wanted)) {
            continue;
        }
        let name = display_name_for_path(&path, parsed.collection.placement);
        let query = query.unwrap_or_default();
        if !query.is_empty()
            && !format!("{name} {relative}")
                .to_lowercase()
                .contains(&query.to_lowercase())
        {
            continue;
        }
        let metadata = fs::metadata(&path)?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        items.push(json!({
            "collectionId":parsed.collection.id,
            "name":name,
            "type":parsed.collection.kind.as_str(),
            "placement":parsed.collection.placement,
            "relativePath":relative,
            "domains":domains,
            "revision":parsed.collection.revision,
            "state":"valid",
            "modifiedMs":modified,
            "sizeBytes":metadata.len(),
        }));
    }
    items.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
    for item in &mut items {
        if item
            .get("collectionId")
            .and_then(Value::as_str)
            .is_some_and(|id| identities.get(id).copied().unwrap_or_default() > 1)
        {
            item["state"] = json!("identityConflict");
            item["identityConflict"] = json!(true);
        }
    }
    let total = items.len();
    let token = snapshot_token(
        &json!({"notebookId":notebook.id,"type":raw_type,"domain":domain,"query":query,"complete":complete,"diagnostics":diagnostics,"items":items}),
    );
    check_snapshot(snapshot, &token)?;
    let page_items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(page_items.len());
    Ok(json!({
        "ok":true,"action":"collection.list","notebookId":notebook.id,
        "items":page_items,
        "page":{"limit":limit,"offset":offset,"returned":next_offset.saturating_sub(offset),"total":total,"hasMore":next_offset<total,"nextOffset":(next_offset<total).then_some(next_offset)},
        "snapshot":token,"complete":complete,"diagnostics":diagnostics
    }))
}

pub(crate) fn describe(
    notebook_key: &str,
    collection_id: Option<&str>,
    relative_path: Option<&str>,
) -> Result<Value, CliError> {
    let (notebook, root, path, document) =
        load_collection(notebook_key, collection_id, relative_path)?;
    let domains = domains_for(&document).into_iter().map(|domain| {
        let dataset = dataset_for(&document, &domain).cloned().unwrap_or(Value::Null);
        let views = views_for(&document).into_iter().filter(|view| view_domain(view, &document) == domain).collect::<Vec<_>>();
        json!({"domain":domain,"source":dataset.get("source"),"schema":dataset.get("schema"),"datasetFilter":dataset.get("filter"),"records":{"includeCount":dataset.pointer("/records/include").and_then(Value::as_array).map(Vec::len).unwrap_or(0),"excludeCount":dataset.pointer("/records/exclude").and_then(Value::as_array).map(Vec::len).unwrap_or(0)},"views":views})
    }).collect::<Vec<_>>();
    Ok(
        json!({"ok":true,"action":"collection.describe","notebookId":notebook.id,"notebook":notebook.name,"relativePath":relative_string(&root,&path)?,"collection":{"id":document.collection.id,"type":document.collection.kind.as_str(),"name":display_name_for_path(&path,document.collection.placement),"placement":document.collection.placement,"revision":document.collection.revision,"createdAt":document.collection.created_at,"updatedAt":document.collection.updated_at,"properties":document.collection.properties},"schemaVersion":document.schema_version,"domains":domains,"views":views_for(&document),"capabilities":{"query":true,"readNoteBody":true,"readBinaryContent":false}}),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn query(
    notebook_key: &str,
    collection_id: Option<&str>,
    relative_path: Option<&str>,
    domain: Option<&str>,
    view_id: Option<&str>,
    text_query: Option<&str>,
    raw_filters: &[String],
    requested_fields: &[String],
    raw_sorts: &[String],
    limit: usize,
    offset: usize,
    snapshot: Option<&str>,
) -> Result<Value, CliError> {
    validate_page(limit, offset)?;
    let (notebook, root, path, document) =
        load_collection(notebook_key, collection_id, relative_path)?;
    let domains = domains_for(&document);
    let domain = match domain {
        Some(domain) => {
            validate_domain(domain)?;
            domain.to_owned()
        }
        None if domains.len() == 1 => domains[0].clone(),
        None => {
            return Err(CliError::Usage(
                "DOMAIN_REQUIRED: hybrid collections require --domain".into(),
            ));
        }
    };
    if !domains.contains(&domain) {
        return Err(CliError::Usage(format!(
            "collection does not contain domain `{domain}`"
        )));
    }
    let dataset = dataset_for(&document, &domain)
        .ok_or_else(|| CliError::Other("COLLECTION_DATASET_MISSING".into()))?;
    let schema = dataset.get("schema").cloned().unwrap_or_else(|| json!({}));
    let fields = schema
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let view = if let Some(view_id) = view_id {
        let view = views_for(&document)
            .into_iter()
            .find(|view| view.get("id").and_then(Value::as_str) == Some(view_id))
            .ok_or_else(|| CliError::NotFound("VIEW_NOT_FOUND".into()))?;
        if view_domain(&view, &document) != domain {
            return Err(CliError::Usage("VIEW_DOMAIN_MISMATCH".into()));
        }
        Some(view)
    } else {
        None
    };
    let selected_fields = if requested_fields.is_empty() {
        fields
            .iter()
            .filter_map(|field| field.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>()
    } else {
        requested_fields.iter().map(|requested| {
            fields.iter().find(|field| field["id"].as_str() == Some(requested))
                .or_else(|| fields.iter().find(|field| field["property_key"].as_str() == Some(requested)))
                .and_then(|field| field["id"].as_str())
                .map(str::to_owned)
                .ok_or_else(|| CliError::Usage(format!("unknown field id or property key `{requested}`")))
        }).collect::<Result<Vec<_>, _>>()?
    };
    for field in &selected_fields {
        if !fields
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(field))
        {
            return Err(CliError::Usage(format!("unknown field id `{field}`")));
        }
    }
    let sorts = parse_sorts(raw_sorts, &fields, view.as_ref(), domain == "notes")?;
    let mut filters = Vec::new();
    if !raw_filters.is_empty() && domain != "notes" { return Err(CliError::Usage("field filters currently support the notes domain".into())); }
    for raw in raw_filters {
        let (key, value) = raw.split_once('=').ok_or_else(|| CliError::Usage("filter must use field=value".into()))?;
        let field = fields.iter().find(|field| field["id"].as_str() == Some(key) || field["property_key"].as_str() == Some(key)).ok_or_else(|| CliError::Usage(format!("unknown filter field `{key}`")))?;
        let expected = match field["type"].as_str() {
            Some("Number") => serde_json::from_str::<Value>(value).ok().filter(Value::is_number).ok_or_else(|| CliError::Usage(format!("invalid number filter value for `{key}`")))?,
            Some("Boolean") => serde_json::from_str::<Value>(value).ok().filter(Value::is_boolean).ok_or_else(|| CliError::Usage(format!("invalid boolean filter value for `{key}`")))?,
            _ => Value::String(value.to_owned()),
        };
        filters.push((field, expected));
    }
    let mut records = if domain == "notes" {
        note_records(&notebook, &root, &path, &document, dataset, &fields)?
    } else {
        resource_records(&notebook, &root, &path, &document, dataset, &domain)?
    };
    // Keep diagnostics even when a filter cannot evaluate a missing record.
    let diagnostics = records.iter().filter(|record| record.state == "missing")
        .map(|record| json!({"code":"NOTE_MISSING","relativePath":record.relative_path,"recordId":record.record_id})).collect::<Vec<_>>();
    if let Some(view) = &view {
        records.retain(|record| {
            record_matches_filter(record, view.get("filter").unwrap_or(&Value::Null), &fields)
        });
    }
    if let Some(query) = text_query.filter(|query| !query.is_empty()) {
        let needle = query.to_lowercase();
        records.retain(|record| {
            record.title.to_lowercase().contains(&needle)
                || record.relative_path.to_lowercase().contains(&needle)
        });
    }
    if !filters.is_empty() {
        records.retain(|record| record.entry.as_ref().is_some_and(|entry| filters.iter().all(|(field, expected)| {
            let actual = note_actual(entry, field["id"].as_str().unwrap_or_default(), &fields);
            let normalize = |value: &Value| -> Value {
                if matches!(field["type"].as_str(), Some("Select" | "MultiSelect")) {
                    if let Some(option) = field["options"].as_array().and_then(|options| options.iter().find(|option| option["id"] == *value)) {
                        return option["label"].clone();
                    }
                }
                value.clone()
            };
            let expected = normalize(expected);
            normalize(&actual) == expected || actual.as_array().is_some_and(|values| values.iter().any(|value| normalize(value) == expected))
        })));
    }
    if !sorts.is_empty() {
        records.sort_by(|a, b| compare_records(a, b, &sorts, &fields));
    }
    let all_items = records
        .iter()
        .map(|record| record.to_json(&notebook.id, &selected_fields, &fields))
        .collect::<Vec<_>>();
    let complete = diagnostics.is_empty();
    let total = all_items.len();
    let token = snapshot_token(
        &json!({"notebookId":notebook.id,"collectionId":document.collection.id,"revision":document.collection.revision,"relativePath":relative_string(&root,&path)?,"domain":domain,"viewId":view_id,"query":text_query,"filters":raw_filters,"fields":selected_fields,"sort":sorts,"complete":complete,"diagnostics":diagnostics,"items":all_items}),
    );
    check_snapshot(snapshot, &token)?;
    let page_items = all_items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(page_items.len());
    Ok(
        json!({"ok":true,"action":"collection.query","notebookId":notebook.id,"collectionId":document.collection.id,"collectionRevision":document.collection.revision,"domain":domain,"viewId":view_id,"items":page_items,"page":{"limit":limit,"offset":offset,"returned":next_offset.saturating_sub(offset),"total":total,"hasMore":next_offset<total,"nextOffset":(next_offset<total).then_some(next_offset)},"snapshot":token,"complete":complete,"diagnostics":diagnostics}),
    )
}

#[derive(Clone)]
struct CollectionRecord {
    record_id: Option<String>,
    origin: &'static str,
    state: &'static str,
    kind: &'static str,
    title: String,
    relative_path: String,
    entry: Option<NoteEntry>,
    resource_id: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    modified_ms: Option<u64>,
    created_ms: Option<u64>,
}

impl CollectionRecord {
    fn to_json(
        &self,
        notebook_id: &str,
        selected_fields: &[String],
        schema_fields: &[Value],
    ) -> Value {
        let mut properties = serde_json::Map::new();
        let mut properties_by_key = serde_json::Map::new();
        for field_id in selected_fields {
            let Some(field) = schema_fields
                .iter()
                .find(|field| field.get("id").and_then(Value::as_str) == Some(field_id))
            else {
                continue;
            };
            let key = field
                .get("property_key")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = if field.get("type").and_then(Value::as_str) == Some("primary") {
                self.entry
                    .as_ref()
                    .map(|entry| Value::String(entry.title.clone()))
                    .unwrap_or(Value::Null)
            } else {
                self.entry
                    .as_ref()
                    .and_then(|entry| entry.properties.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            properties_by_key.insert(key.to_owned(), value.clone());
            properties.insert(field_id.clone(), value);
        }
        let address = if self.kind == "note" && !self.relative_path.is_empty() {
            Some(format!("{notebook_id}::{}", self.relative_path))
        } else {
            None
        };
        json!({"recordId":self.record_id,"origin":self.origin,"kind":self.kind,"state":self.state,"title":self.title,"relativePath":self.relative_path,"address":address,"properties":properties,"propertiesByKey":properties_by_key,"resourceId":self.resource_id,"mimeType":self.mime_type,"sizeBytes":self.size_bytes,"modifiedMs":self.modified_ms,"createdMs":self.created_ms,"read":{"action":if self.kind == "note" {"show"} else {"file.read"},"address":address,"available":self.kind == "note" && self.state == "available" && address.is_some(),"reason":if self.kind != "note" {json!("unsupportedContentType")} else if self.state == "missing" {json!("missing")} else {Value::Null}}})
    }
}

#[derive(Clone, serde::Serialize)]
struct SortKey {
    field: String,
    descending: bool,
}

fn load_collection(
    notebook_key: &str,
    collection_id: Option<&str>,
    relative_path: Option<&str>,
) -> Result<
    (
        flowix_core::memo_file::NotebookConfig,
        PathBuf,
        PathBuf,
        CollectionDocument,
    ),
    CliError,
> {
    if collection_id.is_some() == relative_path.is_some() {
        return Err(CliError::Usage(
            "collection operation requires exactly one of --id or --path".into(),
        ));
    }
    let memo = store::open()?;
    let notebook = store::resolve_notebook_config(&memo, notebook_key)?;
    let root = fs::canonicalize(&notebook.path)?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    let (path, document) = if let Some(id) = collection_id {
        find_by_id(&root, &policy, id)?
    } else {
        read_by_path(&root, &policy, relative_path.expect("selector checked"))?
    };
    document.validate().map_err(CliError::Other)?;
    let document = document.normalized_v2().map_err(CliError::Other)?;
    Ok((notebook, root, path, document))
}

fn relative_string(root: &Path, path: &Path) -> Result<String, CliError> {
    path.strip_prefix(root)
        .map_err(|error| CliError::Other(error.to_string()))
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn validate_page(limit: usize, _offset: usize) -> Result<(), CliError> {
    if !(1..=200).contains(&limit) {
        return Err(CliError::Usage(
            "collection limit must be between 1 and 200".into(),
        ));
    }
    Ok(())
}

fn validate_domain(domain: &str) -> Result<(), CliError> {
    if matches!(domain, "notes" | "media" | "work_documents") {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "unsupported collection domain `{domain}`"
        )))
    }
}

fn parse_collection_type(kind: &str) -> Result<CollectionType, CliError> {
    match kind {
        "table" | "notes" => Ok(CollectionType::Table),
        "media_library" | "media" => Ok(CollectionType::MediaLibrary),
        "work_documents" => Ok(CollectionType::WorkDocuments),
        "hybrid" => Ok(CollectionType::Hybrid),
        _ => Err(CliError::Usage(format!(
            "unsupported collection type `{kind}`"
        ))),
    }
}

fn domains_for(document: &CollectionDocument) -> Vec<String> {
    if document.collection.kind == CollectionType::Hybrid {
        document
            .payload
            .get("domains")
            .and_then(Value::as_object)
            .map(|domains| {
                domains
                    .keys()
                    .filter(|domain| {
                        matches!(domain.as_str(), "notes" | "media" | "work_documents")
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![match document.collection.kind {
            CollectionType::Table => "notes",
            CollectionType::MediaLibrary => "media",
            CollectionType::WorkDocuments => "work_documents",
            CollectionType::Hybrid => unreachable!(),
        }
        .to_owned()]
    }
}

fn dataset_for<'a>(document: &'a CollectionDocument, domain: &str) -> Option<&'a Value> {
    if document.collection.kind == CollectionType::Hybrid {
        document.payload.pointer(&format!("/domains/{domain}"))
    } else {
        document.payload.get("dataset")
    }
}

fn views_for(document: &CollectionDocument) -> Vec<Value> {
    if document.collection.kind == CollectionType::Hybrid {
        document
            .payload
            .pointer("/views/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        document
            .payload
            .pointer("/dataset/views/items")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| {
                document
                    .payload
                    .pointer("/views/items")
                    .and_then(Value::as_array)
                    .cloned()
            })
            .unwrap_or_default()
    }
}

fn view_domain(view: &Value, document: &CollectionDocument) -> String {
    view.get("domain")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            match document.collection.kind {
                CollectionType::Table => "notes",
                CollectionType::MediaLibrary => "media",
                CollectionType::WorkDocuments => "work_documents",
                CollectionType::Hybrid => "",
            }
            .to_owned()
        })
}

fn snapshot_token(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let hash = bytes.into_iter().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x100000001b3)
    });
    format!("v1:{hash:016x}")
}

fn check_snapshot(supplied: Option<&str>, current: &str) -> Result<(), CliError> {
    if supplied.is_some_and(|token| token != current) {
        Err(CliError::DataChanged(
            "collection data changed during pagination; restart at offset 0".into(),
        ))
    } else {
        Ok(())
    }
}

fn note_records(
    notebook: &flowix_core::memo_file::NotebookConfig,
    root: &Path,
    collection_path: &Path,
    document: &CollectionDocument,
    dataset: &Value,
    fields: &[Value],
) -> Result<Vec<CollectionRecord>, CliError> {
    let memo = store::open()?;
    let policy = FileManagementPolicy::from_notebook_root(root);
    let source = dataset.get("source").unwrap_or(&Value::Null);
    let collection_relative = relative_string(root, collection_path)?;
    let filter = effective_dataset_filter(dataset.get("filter"), document, &collection_relative);
    let includes = dataset
        .pointer("/records/include")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut note_indices = std::collections::HashMap::<String, usize>::new();
    let mut notes = Vec::new();
    {
        for note_path in includes
            .iter()
            .filter_map(|item| item.get("note_path").and_then(Value::as_str))
            .map(normalize_slashes)
            .filter(|path| !path.is_empty() && source_contains(source, &collection_relative, path))
        {
            if !note_indices.contains_key(&note_path) {
                match memo.derive_note_entry_from_disk(&notebook.id, &note_path) {
                    Ok(entry) => { note_indices.insert(note_path, notes.len()); notes.push(entry); }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    Err(error) => return Err(CliError::Io(error)),
                }
            }
        }
    }
    if !filter.is_null() {
        let mut paths = Vec::new();
        collect_markdown_files(root, root, &policy, &mut paths)?;
        paths.sort();
        for path in paths {
            let relative = relative_string(root, &path)?;
            if note_indices.contains_key(&relative) { continue; }
            let entry = memo
                .derive_note_entry_from_disk(&notebook.id, &relative)
                .map_err(CliError::Io)?;
            note_indices.insert(relative, notes.len());
            notes.push(entry);
        }
    }
    let excludes = dataset
        .pointer("/records/exclude")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let linked = includes
        .iter()
        .filter_map(|item| item.get("note_path").and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(normalize_slashes)
        .collect::<std::collections::HashSet<_>>();
    let excluded = excludes
        .iter()
        .filter_map(|item| item.get("note_path").and_then(Value::as_str))
        .map(normalize_slashes)
        .collect::<std::collections::HashSet<_>>();
    let mut output = Vec::new();
    for record in includes {
        let note_path = record
            .get("note_path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        if !note_path.is_empty() && !source_contains(source, &collection_relative, &note_path) {
            continue;
        }
        let entry = note_indices
            .get(&note_path)
            .map(|index| notes[*index].clone());
        let state = if note_path.is_empty() {
            "draft"
        } else if entry.is_some() {
            "available"
        } else {
            "missing"
        };
        output.push(CollectionRecord {
            record_id: record.get("id").and_then(Value::as_str).map(str::to_owned),
            origin: "explicit",
            state,
            kind: "note",
            title: entry
                .as_ref()
                .map(|note| note.title.clone())
                .unwrap_or_else(|| note_path.rsplit('/').next().unwrap_or("Draft").to_owned()),
            relative_path: note_path,
            entry: entry.clone(),
            resource_id: None,
            mime_type: None,
            size_bytes: entry.as_ref().map(|note| note.size_bytes),
            modified_ms: entry.as_ref().and_then(|note| u64::try_from(note.updated_at).ok()),
            created_ms: entry.as_ref().and_then(|note| u64::try_from(note.created_at).ok()),
        });
    }
    if !filter.is_null() {
        for entry in notes {
            let note_path = entry.relative_path.replace('\\', "/");
            if linked.contains(&note_path)
                || excluded.contains(&note_path)
                || !source_contains(source, &collection_relative, &note_path)
            {
                continue;
            }
            if !dataset_filter_matches(&filter, &entry, fields) {
                continue;
            }
            output.push(CollectionRecord {
                record_id: None,
                origin: "automatic",
                state: "available",
                kind: "note",
                title: entry.title.clone(),
                relative_path: note_path,
                entry: Some(entry),
                resource_id: None,
                mime_type: None,
                size_bytes: None,
                modified_ms: None,
                created_ms: None,
            });
        }
    }
    Ok(output)
}

fn collect_markdown_files(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    output: &mut Vec<PathBuf>,
) -> Result<(), CliError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| CliError::Other(error.to_string()))?;
        if policy.is_index_hidden_at(root, relative) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_markdown_files(root, &path, policy, output)?;
        } else if kind.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        {
            output.push(path);
        }
    }
    Ok(())
}

fn resource_records(
    notebook: &flowix_core::memo_file::NotebookConfig,
    root: &Path,
    collection_path: &Path,
    document: &CollectionDocument,
    dataset: &Value,
    domain: &str,
) -> Result<Vec<CollectionRecord>, CliError> {
    let policy = FileManagementPolicy::from_notebook_root(root);
    let collection_relative = relative_string(root, collection_path)?;
    let source = dataset.get("source").unwrap_or(&Value::Null);
    let filter = effective_dataset_filter(dataset.get("filter"), document, &collection_relative);
    let mut paths = Vec::new();
    if !filter.is_null() {
        collect_resource_files(root, root, &policy, &mut paths)?;
        paths.sort();
    }
    let includes = dataset
        .pointer("/records/include")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let excludes = dataset
        .pointer("/records/exclude")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let included_paths = includes
        .iter()
        .filter_map(|item| item.get("relative_path").and_then(Value::as_str))
        .map(|path| normalize_slashes(path).to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let excluded_paths = excludes
        .iter()
        .filter_map(|item| item.get("relative_path").and_then(Value::as_str))
        .map(|path| normalize_slashes(path).to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let mut output = Vec::new();
    for record in includes {
        let relative = record
            .get("relative_path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        if excluded_paths.contains(&relative.to_lowercase()) {
            continue;
        }
        if !relative.is_empty() && !source_contains(source, &collection_relative, &relative) {
            continue;
        }
        let absolute = root.join(&relative);
        let metadata = safe_resource_metadata(root, &relative);
        let resource_kind = flowix_core::memo_file::resource_kind_for_path(&absolute);
        if metadata.is_some() && !domain_accepts_kind(domain, resource_kind) {
            continue;
        }
        let kind = resource_kind
            .map(ResourceKind::as_str)
            .unwrap_or(if domain == "media" {
                "image"
            } else {
                "document"
            });
        let title = relative.rsplit('/').next().unwrap_or_default().to_owned();
        let id = record
            .get("resource_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| flowix_core::memo_file::resource_catalog_id(&notebook.id, &relative).ok());
        output.push(CollectionRecord {
            record_id: record.get("id").and_then(Value::as_str).map(str::to_owned),
            origin: "explicit",
            state: if metadata.is_some() {
                "available"
            } else {
                "missing"
            },
            kind,
            title,
            relative_path: relative.clone(),
            entry: None,
            resource_id: id,
            mime_type: Some(mime_for_path(&absolute)),
            size_bytes: metadata.as_ref().map(fs::Metadata::len),
            modified_ms: metadata
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
            created_ms: metadata
                .as_ref()
                .and_then(|meta| meta.created().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
        });
    }
    if !filter.is_null() {
        for path in paths {
            let relative = relative_string(root, &path)?;
            if included_paths.contains(&relative.to_lowercase())
                || excluded_paths.contains(&relative.to_lowercase())
                || !source_contains(source, &collection_relative, &relative)
            {
                continue;
            }
            let kind = flowix_core::memo_file::resource_kind_for_path(&path);
            if !domain_accepts_kind(domain, kind)
                || !resource_filter_matches(&filter, &relative, kind.map(ResourceKind::as_str))
            {
                continue;
            }
            let metadata = safe_resource_metadata(root, &relative)
                .ok_or_else(|| CliError::NotFound(format!("resource not found: {relative}")))?;
            output.push(CollectionRecord {
                record_id: None,
                origin: "automatic",
                state: "available",
                kind: kind.map(ResourceKind::as_str).unwrap_or("document"),
                title: relative.rsplit('/').next().unwrap_or_default().to_owned(),
                relative_path: relative.clone(),
                entry: None,
                resource_id: flowix_core::memo_file::resource_catalog_id(&notebook.id, &relative)
                    .ok(),
                mime_type: Some(mime_for_path(&path)),
                size_bytes: Some(metadata.len()),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
                created_ms: metadata
                    .created()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
            });
        }
    }
    Ok(output)
}

fn collect_resource_files(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    output: &mut Vec<PathBuf>,
) -> Result<(), CliError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| CliError::Other(error.to_string()))?;
        if policy.is_index_hidden_at(root, relative) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_resource_files(root, &path, policy, output)?;
        } else if kind.is_file() && flowix_core::memo_file::resource_kind_for_path(&path).is_some()
        {
            output.push(path);
        }
    }
    Ok(())
}

fn domain_accepts_kind(domain: &str, kind: Option<ResourceKind>) -> bool {
    match (domain, kind) {
        ("media", Some(ResourceKind::Image | ResourceKind::Video)) => true,
        (
            "work_documents",
            Some(
                ResourceKind::Document
                | ResourceKind::Spreadsheet
                | ResourceKind::Presentation
                | ResourceKind::Web
                | ResourceKind::Archive
                | ResourceKind::Database,
            ),
        ) => true,
        _ => false,
    }
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn effective_dataset_filter(
    raw: Option<&Value>,
    document: &CollectionDocument,
    collection_path: &str,
) -> Value {
    let Some(filter) = raw else {
        return Value::Null;
    };
    let mut filter = filter.clone();
    if document.collection.placement == CollectionPlacement::Folder {
        let parent = Path::new(collection_path)
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        relocate_path_filter(&mut filter, &parent);
    }
    filter
}

fn relocate_path_filter(filter: &mut Value, path: &str) {
    if filter.get("conditions").is_some() {
        filter["path"] = Value::String(path.to_owned());
        return;
    }
    for key in ["all", "any"] {
        if let Some(items) = filter.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if item.get("field").and_then(Value::as_str) == Some("path") {
                    item["value"] = Value::String(path.to_owned());
                } else {
                    relocate_path_filter(item, path);
                }
            }
        }
    }
}

fn source_contains(source: &Value, collection_path: &str, relative: &str) -> bool {
    let scope = source
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("notebook");
    let base = match scope {
        "containing_folder" => Path::new(collection_path)
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .replace('\\', "/"),
        "folder" => source
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim_matches('/')
            .to_owned(),
        _ => String::new(),
    };
    if base.is_empty() {
        return true;
    }
    relative.starts_with(&format!("{base}/"))
}

fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn builtin_note_property_key(field: &str) -> Option<&'static str> {
    match field {
        "__note_name__" => Some("name"),
        "__note_status__" => Some("status"),
        "__note_calendar_date__" => Some("calendar_date"),
        "__note_description__" => Some("description"),
        "__note_tags__" => Some("tags"),
        "__note_colors__" => Some("flowix_colors"),
        "__note_icon__" => Some("flowix_icon"),
        "__note_pinned__" => Some("flowix_favorited"),
        _ => None,
    }
}

fn note_actual(entry: &NoteEntry, field: &str, fields: &[Value]) -> Value {
    let path = entry.relative_path.replace('\\', "/");
    let configured = fields.iter().find(|item| {
        item.get("id").and_then(Value::as_str) == Some(field)
            || item.get("property_key").and_then(Value::as_str) == Some(field)
    });
    if field == "kind" {
        Value::String("note".into())
    } else if field == "file_name" || field == "__note_filename__" {
        Value::String(if field == "__note_filename__" {
            entry.title.clone()
        } else {
            path.rsplit('/').next().unwrap_or_default().into()
        })
    } else if field == "path" {
        Value::String(
            path.rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or_default()
                .into(),
        )
    } else if field == "__note_relative_path__" {
        Value::String(path)
    } else if field == "__note_size__" {
        json!(entry.size_bytes)
    } else if field == "__note_created_at__" || field == "created_at" {
        local_timestamp(entry.created_at)
    } else if field == "__note_updated_at__" || field == "modified_at" {
        local_timestamp(entry.updated_at)
    } else if configured
        .is_some_and(|item| item.get("type").and_then(Value::as_str) == Some("primary"))
    {
        Value::String(entry.title.clone())
    } else {
        let key = configured
            .and_then(|item| item.get("property_key"))
            .and_then(Value::as_str)
            .or_else(|| builtin_note_property_key(field))
            .unwrap_or(field);
        entry
            .properties
            .get(key)
            .cloned()
            .unwrap_or_else(|| match key {
                "tags" => json!(entry.tags),
                "flowix_colors" => serde_json::to_value(&entry.colors).unwrap_or(Value::Null),
                "flowix_icon" => json!(entry.icon),
                "flowix_favorited" => json!(entry.favorited),
                _ => Value::Null,
            })
    }
}

fn rule_matches(actual: Value, op: &str, expected: &Value, field: &str) -> bool {
    let values = actual.as_array().cloned().unwrap_or_else(|| vec![actual]);
    values.iter().any(|value| {
        if value.is_null() {
            return false;
        }
        match op {
            "eq" | "equals" => {
                value == expected
                    || (value
                        .as_str()
                        .and_then(|v| v.parse::<f64>().ok())
                        .zip(expected.as_f64())
                        .is_some_and(|(a, b)| (a - b).abs() < f64::EPSILON))
            }
            "contains" => {
                let Some(needle) = expected.as_str() else {
                    return false;
                };
                let hay = value.as_str().unwrap_or("");
                if field == "path" {
                    let prefix = needle.trim_matches('/');
                    prefix.is_empty() || hay == prefix || hay.starts_with(&format!("{prefix}/"))
                } else {
                    hay.to_lowercase().contains(&needle.to_lowercase())
                }
            }
            "in" => expected
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item == value)),
            "gt" | "lt" => {
                let cmp = if let (Some(a), Some(b)) = (value.as_f64(), expected.as_f64()) {
                    a.partial_cmp(&b)
                } else {
                    value
                        .as_str()
                        .zip(expected.as_str())
                        .and_then(|(a, b)| a.cmp(b).into())
                };
                cmp.is_some_and(|ord| if op == "gt" { ord.is_gt() } else { ord.is_lt() })
            }
            _ => false,
        }
    })
}

fn match_rule_list(entries: &[Value], mode: &str, entry: &NoteEntry, fields: &[Value]) -> bool {
    if mode == "all" {
        entries
            .iter()
            .all(|rule| rule_matches_value(rule, entry, fields))
    } else {
        entries.is_empty()
            || entries
                .iter()
                .any(|rule| rule_matches_value(rule, entry, fields))
    }
}

fn rule_matches_value(rule: &Value, entry: &NoteEntry, fields: &[Value]) -> bool {
    if let Some(field) = rule.get("field").and_then(Value::as_str) {
        return rule_matches(
            note_actual(entry, field, fields),
            rule.get("op").and_then(Value::as_str).unwrap_or(""),
            rule.get("value").unwrap_or(&Value::Null),
            field,
        );
    }
    match_rule_list(
        rule.get("all")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        "all",
        entry,
        fields,
    ) && match_rule_list(
        rule.get("any")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        "any",
        entry,
        fields,
    )
}

fn dataset_filter_matches(filter: &Value, entry: &NoteEntry, fields: &[Value]) -> bool {
    if filter.is_null() {
        return false;
    }
    if filter.get("conditions").is_some() {
        let path = filter.get("path").and_then(Value::as_str);
        if path.is_some_and(|path| {
            !rule_matches(
                note_actual(entry, "path", fields),
                "contains",
                &json!(path),
                "path",
            )
        }) {
            return false;
        }
        let conditions = filter
            .get("conditions")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if conditions.is_empty() {
            return true;
        }
        match_rule_list(
            conditions,
            filter.get("match").and_then(Value::as_str).unwrap_or("all"),
            entry,
            fields,
        )
    } else {
        match_rule_list(
            filter
                .get("all")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            "all",
            entry,
            fields,
        ) && match_rule_list(
            filter
                .get("any")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            "any",
            entry,
            fields,
        )
    }
}

fn record_matches_filter(record: &CollectionRecord, filter: &Value, fields: &[Value]) -> bool {
    if filter.is_null() || view_filter_is_empty(filter) {
        return true;
    }
    if let Some(entry) = record.entry.as_ref() {
        return dataset_filter_matches(filter, entry, fields);
    }
    if record.kind == "note" {
        return false;
    }
    resource_filter_matches(
        filter,
        &record.relative_path,
        Some(record.kind).filter(|_| record.kind != "note"),
    )
}

fn view_filter_is_empty(filter: &Value) -> bool {
    filter
        .get("all")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
        && filter
            .get("any")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
}

fn resource_filter_matches(filter: &Value, path: &str, kind: Option<&str>) -> bool {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let rule = |item: &Value| {
        let field = item.get("field").and_then(Value::as_str).unwrap_or("");
        let actual = match field {
            "file_name" => Value::String(filename.into()),
            "path" => Value::String(parent.into()),
            "kind" => kind
                .map(|value| Value::String(value.into()))
                .unwrap_or(Value::Null),
            _ => Value::Null,
        };
        rule_matches(
            actual,
            item.get("op").and_then(Value::as_str).unwrap_or(""),
            item.get("value").unwrap_or(&Value::Null),
            field,
        )
    };
    let list = |items: &[Value], all: bool| {
        if all {
            items
                .iter()
                .all(|item| item.get("field").is_some_and(|_| rule(item)))
        } else {
            items.is_empty()
                || items
                    .iter()
                    .any(|item| item.get("field").is_some_and(|_| rule(item)))
        }
    };
    if filter.get("conditions").is_some() {
        let path_filter = filter.get("path").and_then(Value::as_str);
        if path_filter.is_some_and(|prefix| {
            !prefix.trim_matches('/').is_empty()
                && !(parent == prefix
                    || parent.starts_with(&format!("{}/", prefix.trim_matches('/'))))
        }) {
            return false;
        }
        let conditions = filter
            .get("conditions")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        list(
            conditions,
            filter.get("match").and_then(Value::as_str) != Some("any"),
        )
    } else {
        list(
            filter
                .get("all")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            true,
        ) && list(
            filter
                .get("any")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            false,
        )
    }
}

fn parse_sorts(
    raw: &[String],
    fields: &[Value],
    view: Option<&Value>,
    note_domain: bool,
) -> Result<Vec<SortKey>, CliError> {
    let mut values = Vec::new();
    if raw.is_empty() {
        if let Some(items) = view
            .and_then(|view| view.get("sort"))
            .and_then(Value::as_array)
        {
            for item in items {
                let field = item
                    .get("field")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let desc = item.get("direction").and_then(Value::as_str) == Some("desc");
                values.push(SortKey {
                    field: field.into(),
                    descending: desc,
                });
            }
        }
    } else {
        for raw_sort in raw {
            let (field, direction) = raw_sort.rsplit_once(':').ok_or_else(|| {
                CliError::Usage("sort must use <field>:asc or <field>:desc".into())
            })?;
            if !matches!(direction, "asc" | "desc") {
                return Err(CliError::Usage("sort direction must be asc or desc".into()));
            }
            values.push(SortKey {
                field: field.into(),
                descending: direction == "desc",
            });
        }
    }
    for sort in &values {
        let common_field = matches!(
            sort.field.as_str(),
            "modified_at" | "created_at" | "file_name" | "path"
        );
        let note_field = note_domain
            && (matches!(
                sort.field.as_str(),
                "__note_created_at__"
                    | "__note_updated_at__"
                    | "__note_size__"
                    | "__note_relative_path__"
            ) || builtin_note_property_key(&sort.field).is_some());
        if !common_field
            && !note_field
            && !fields.iter().any(|field| {
                field.get("id").and_then(Value::as_str) == Some(&sort.field)
                    || field.get("property_key").and_then(Value::as_str) == Some(&sort.field)
            })
        {
            return Err(CliError::Usage(format!(
                "unknown sort field `{}`",
                sort.field
            )));
        }
    }
    Ok(values)
}

fn compare_records(
    a: &CollectionRecord,
    b: &CollectionRecord,
    sorts: &[SortKey],
    fields: &[Value],
) -> std::cmp::Ordering {
    for sort in sorts {
        let sort_value = |entry: &NoteEntry| match sort.field.as_str() {
            "created_at" | "__note_created_at__" => json!(entry.created_at),
            "modified_at" | "__note_updated_at__" => json!(entry.updated_at),
            _ => note_actual(entry, &sort.field, fields),
        };
        let left = a
            .entry
            .as_ref()
            .map(sort_value)
            .unwrap_or_else(|| resource_actual(a, &sort.field));
        let right = b
            .entry
            .as_ref()
            .map(sort_value)
            .unwrap_or_else(|| resource_actual(b, &sort.field));
        let order = compare_values(&left, &right);
        if order != std::cmp::Ordering::Equal {
            return if sort.descending {
                order.reverse()
            } else {
                order
            };
        }
    }
    a.relative_path
        .cmp(&b.relative_path)
        .then_with(|| a.record_id.cmp(&b.record_id))
}

fn resource_actual(record: &CollectionRecord, field: &str) -> Value {
    match field {
        "file_name" => json!(record.title),
        "path" => json!(record
            .relative_path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("")),
        "kind" => json!(record.kind),
        "modified_at" => json!(record.modified_ms),
        "created_at" => json!(record.created_ms),
        _ => Value::Null,
    }
}

fn local_timestamp(value: i64) -> Value {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value)
        .map(|date| {
            Value::String(
                date.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d %H:%M")
                    .to_string(),
            )
        })
        .unwrap_or(Value::Null)
}

fn safe_resource_metadata(root: &Path, relative: &str) -> Option<fs::Metadata> {
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    fs::metadata(canonical).ok()
}

fn compare_values(left: &Value, right: &Value) -> std::cmp::Ordering {
    if left.is_null() {
        return if right.is_null() {
            std::cmp::Ordering::Equal
        } else {
            std::cmp::Ordering::Greater
        };
    }
    if right.is_null() {
        return std::cmp::Ordering::Less;
    }
    if let (Some(a), Some(b)) = (left.as_f64(), right.as_f64()) {
        return a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal);
    }
    if let (Some(a), Some(b)) = (left.as_bool(), right.as_bool()) {
        return a.cmp(&b);
    }
    sort_text(left).cmp(&sort_text(right))
}

fn sort_text(value: &Value) -> String {
    let text = if let Some(values) = value.as_array() {
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
            })
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string())
    };
    text.to_lowercase()
}

fn read_by_path(
    root: &Path,
    policy: &FileManagementPolicy,
    raw_path: &str,
) -> Result<(PathBuf, CollectionDocument), CliError> {
    let relative = normalize_relative_path(raw_path)?;
    // Access scope, not display scope: a collection's `.index.yaml` is hidden
    // from the file tree yet must stay readable here. Catalog scans below use
    // index scope instead.
    if policy.is_tree_hidden_at(root, &relative) {
        return Err(CliError::NotFound(format!(
            "collection not found: {raw_path}"
        )));
    }
    let path = root.join(&relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| CliError::NotFound(format!("collection not found: {raw_path}")))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || collection_type(&path).is_none()
    {
        return Err(CliError::Usage(
            "path must name a collection file inside the notebook".into(),
        ));
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(root) {
        return Err(CliError::Usage(
            "collection path is outside the notebook".into(),
        ));
    }
    let canonical_relative = canonical
        .strip_prefix(root)
        .map_err(|error| CliError::Other(error.to_string()))?;
    if policy.is_tree_hidden_at(root, canonical_relative) {
        return Err(CliError::NotFound(format!(
            "collection not found: {raw_path}"
        )));
    }
    let source = fs::read_to_string(&canonical)?;
    let document = CollectionDocument::parse(&source).map_err(CliError::Other)?;
    validate_file_type(
        &canonical,
        document.collection.kind,
        document.collection.placement,
    )?;
    Ok((canonical, document))
}

fn find_by_id(
    root: &Path,
    policy: &FileManagementPolicy,
    id: &str,
) -> Result<(PathBuf, CollectionDocument), CliError> {
    if !valid_id(id, "col_") {
        return Err(CliError::Usage("invalid collection id".into()));
    }
    // Collection documents are the source of truth. Scan the permitted file
    // tree so stale catalog rows cannot hide duplicate IDs or moved files.
    let mut matches = Vec::new();
    collect_collection_files(root, root, policy, &mut matches)?;
    let mut found = Vec::new();
    for path in matches {
        if let Some(matched) = read_matching_collection(root, policy, &path, id) {
            found.push(matched);
        }
    }
    match found.len() {
        0 => Err(CliError::NotFound(format!("collection not found: {id}"))),
        1 => Ok(found.remove(0)),
        _ => Err(CliError::Other("COLLECTION_IDENTITY_CONFLICT".into())),
    }
}

fn read_matching_collection(
    root: &Path,
    policy: &FileManagementPolicy,
    candidate_path: &Path,
    id: &str,
) -> Option<(PathBuf, CollectionDocument)> {
    let path = if candidate_path.is_absolute() {
        candidate_path.to_owned()
    } else {
        root.join(candidate_path)
    };
    let relative_path = path.strip_prefix(root).ok()?;
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || policy.is_tree_hidden_at(root, relative_path)
    {
        return None;
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || collection_type(&path).is_none()
    {
        return None;
    }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let source = fs::read_to_string(&canonical).ok()?;
    let document = CollectionDocument::parse(&source).ok()?;
    if document.collection.id != id
        || validate_file_type(
            &canonical,
            document.collection.kind,
            document.collection.placement,
        )
        .is_err()
    {
        return None;
    }
    Some((canonical, document))
}

fn collect_collection_files(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    output: &mut Vec<PathBuf>,
) -> Result<(), CliError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| CliError::Other(error.to_string()))?;
        if policy.is_index_hidden_at(root, relative) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_collection_files(root, &path, policy, output)?;
        } else if file_type.is_file() && collection_type(&path).is_some() {
            output.push(path);
        }
    }
    Ok(())
}

fn normalize_relative_path(raw_path: &str) -> Result<PathBuf, CliError> {
    let normalized = raw_path.replace('\\', "/");
    let path = Path::new(&normalized);
    if normalized.trim().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CliError::Usage(
            "collection path must be a notebook-relative path without `.` or `..`".into(),
        ));
    }
    Ok(path.to_owned())
}

fn collection_type(path: &Path) -> Option<CollectionType> {
    let filename = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if filename == ".index.yaml" || filename.ends_with(".index.yaml") {
        Some(CollectionType::Table)
    } else if filename.ends_with(".table.yml") || filename.ends_with(".table.yaml") {
        Some(CollectionType::Table)
    } else if filename.ends_with(".lib.yml") || filename.ends_with(".lib.yaml") {
        Some(CollectionType::MediaLibrary)
    } else if filename.ends_with(".workdocs.yml") || filename.ends_with(".workdocs.yaml") {
        Some(CollectionType::WorkDocuments)
    } else {
        None
    }
}

fn validate_file_type(
    path: &Path,
    actual: CollectionType,
    placement: CollectionPlacement,
) -> Result<(), CliError> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let filename = filename.to_ascii_lowercase();
    let has_nonempty_stem = |suffix: &str| {
        filename
            .strip_suffix(suffix)
            .is_some_and(|stem| !stem.is_empty())
    };
    let placement_matches = match placement {
        CollectionPlacement::Folder => filename == ".index.yaml",
        CollectionPlacement::Standalone => {
            has_nonempty_stem(".index.yaml")
                || match actual {
                    CollectionType::Table => {
                        has_nonempty_stem(".table.yaml") || has_nonempty_stem(".table.yml")
                    }
                    CollectionType::MediaLibrary => {
                        has_nonempty_stem(".lib.yaml") || has_nonempty_stem(".lib.yml")
                    }
                    CollectionType::WorkDocuments => {
                        has_nonempty_stem(".workdocs.yaml") || has_nonempty_stem(".workdocs.yml")
                    }
                    // Standalone hybrid collections have no filename convention yet.
                    CollectionType::Hybrid => false,
                }
        }
    };
    if !placement_matches {
        return Err(CliError::Other("COLLECTION_TYPE_EXTENSION_MISMATCH".into()));
    }
    Ok(())
}
