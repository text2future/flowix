use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::user::PropertyFieldConfig;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPresetRegistry {
    #[serde(default)]
    pub system_fields: Vec<PropertyFieldConfig>,
    #[serde(default)]
    pub fields: Vec<PropertyFieldConfig>,
    #[serde(default)]
    pub deleted_fields: Vec<PropertyFieldConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPresetChange {
    pub scope: String,
    pub field: PropertyFieldConfig,
    /// None creates a new field; updates compare the stored version atomically.
    pub expected_revision: Option<u64>,
}

/// Runtime IPC model. Parallel option arrays exist only in legacy migration input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyPresetOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPresetDefinition {
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub position: u32,
    pub multiple: Option<bool>,
    pub key: String,
    pub r#type: String,
    #[serde(default)]
    pub options: Vec<PropertyPresetOption>,
}

impl From<PropertyFieldConfig> for PropertyPresetDefinition {
    fn from(field: PropertyFieldConfig) -> Self {
        Self {
            id: field.id,
            name: field.name,
            revision: field.revision,
            position: field.position,
            multiple: field.multiple,
            key: field.key,
            r#type: field.r#type,
            options: field
                .option_ids
                .into_iter()
                .zip(field.options)
                .map(|(id, label)| PropertyPresetOption { id, label })
                .collect(),
        }
    }
}

impl From<PropertyPresetDefinition> for PropertyFieldConfig {
    fn from(field: PropertyPresetDefinition) -> Self {
        Self {
            id: field.id,
            name: field.name,
            revision: field.revision,
            position: field.position,
            multiple: field.multiple,
            key: field.key,
            r#type: field.r#type,
            option_ids: field
                .options
                .iter()
                .map(|option| option.id.clone())
                .collect(),
            options: field
                .options
                .into_iter()
                .map(|option| option.label)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPresetCatalog {
    pub system_fields: Vec<PropertyPresetDefinition>,
    pub fields: Vec<PropertyPresetDefinition>,
    pub deleted_fields: Vec<PropertyPresetDefinition>,
}

impl From<PropertyPresetRegistry> for PropertyPresetCatalog {
    fn from(registry: PropertyPresetRegistry) -> Self {
        Self {
            system_fields: registry.system_fields.into_iter().map(Into::into).collect(),
            fields: registry.fields.into_iter().map(Into::into).collect(),
            deleted_fields: registry
                .deleted_fields
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPresetMutation {
    pub scope: String,
    pub field: PropertyPresetDefinition,
    pub expected_revision: Option<u64>,
}

impl From<PropertyPresetMutation> for PropertyPresetChange {
    fn from(mutation: PropertyPresetMutation) -> Self {
        Self {
            scope: mutation.scope,
            field: mutation.field.into(),
            expected_revision: mutation.expected_revision,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PropertyPresetStore {
    path: PathBuf,
}

const SYSTEM_PRESET_TYPES: [(&str, &str); 8] = [
    ("name", "Text"),
    ("description", "Text"),
    ("tags", "Tag"),
    ("flowix_colors", "Color"),
    ("flowix_icon", "Icon"),
    ("flowix_favorited", "Boolean"),
    ("status", "Select"),
    ("calendar_date", "Date"),
];

const PROPERTY_PRESET_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS property_presets (
                scope TEXT NOT NULL CHECK(scope IN ('system', 'user', 'deleted_user')),
                id TEXT NOT NULL,
                property_key TEXT NOT NULL,
                display_name TEXT,
                property_type TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                multiple INTEGER,
                updated_at INTEGER NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(scope, id)
             );
             CREATE TABLE IF NOT EXISTS property_preset_options (
                scope TEXT NOT NULL,
                preset_id TEXT NOT NULL,
                option_id TEXT NOT NULL,
                label TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(scope, preset_id, option_id),
                UNIQUE(scope, preset_id, position),
                FOREIGN KEY(scope, preset_id) REFERENCES property_presets(scope, id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_property_presets_key ON property_presets(property_key);
             CREATE TABLE IF NOT EXISTS local_migrations (
                migration_key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL
             );";

impl PropertyPresetStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
            )
            .map_err(|error| error.to_string())?;
        let migration_connection = connection;
        migration_connection
            .execute_batch(PROPERTY_PRESET_SCHEMA)
            .map_err(|error| error.to_string())?;
        Ok(migration_connection)
    }

    /// Apply legacy SQLite shape changes from the explicit startup
    /// initialization phase. Normal reads only open the current schema.
    pub fn initialize_legacy_schema(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
            )
            .map_err(|error| error.to_string())?;
        flowix_core::memo_file::initialize_local_migration_table(&mut connection)
            .map_err(|error| error.to_string())?;
        migrate_legacy_schema(&mut connection)?;
        let has_position: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('property_presets') WHERE name='position')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !has_position && connection.prepare("SELECT scope,id,property_key,display_name,property_type,revision,multiple,updated_at FROM property_presets LIMIT 0").is_ok() {
            connection.execute_batch("ALTER TABLE property_presets ADD COLUMN position INTEGER NOT NULL DEFAULT 0;")
                .map_err(|error| error.to_string())?;
        }
        drop(connection);
        let _ = self.open()?;
        Ok(())
    }

    pub fn runtime_defaults() -> PropertyPresetRegistry {
        PropertyPresetRegistry {
            system_fields: SYSTEM_PRESET_TYPES
                .into_iter()
                .enumerate()
                .map(|(position, (key, kind))| default_system_field(position, key, kind))
                .collect(),
            ..Default::default()
        }
    }

    /// Repair only this module's tables. Access errors and failures in shared
    /// tables never grant permission to replace local.db or the notebook rows.
    pub fn initialize_runtime_storage(&self) -> Result<(), String> {
        let initialize = || {
            self.initialize_legacy_schema()?;
            self.initialize_system_presets()
        };
        if let Err(error) = initialize() {
            if !self.repair_property_tables()? {
                return Err(error);
            }
            initialize()?;
        }
        Ok(())
    }

    fn repair_property_tables(&self) -> Result<bool, String> {
        if flowix_core::memo_file::database_file_is_corrupt(&self.path)
            .map_err(|error| error.to_string())?
        {
            return Ok(false);
        }
        let mut connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_millis(100))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let incompatible = |sql: &str| -> Result<bool, String> {
            match transaction.prepare(sql) {
                Ok(_) => Ok(false),
                Err(error) if flowix_core::memo_file::is_rebuildable_storage_error(&error) => {
                    Ok(true)
                }
                Err(error) => Err(error.to_string()),
            }
        };
        let broken_presets = incompatible("SELECT scope,id,property_key,display_name,property_type,revision,multiple,updated_at,position FROM property_presets LIMIT 0")?;
        let broken_options = incompatible(
            "SELECT scope,preset_id,option_id,label,position FROM property_preset_options LIMIT 0",
        )?;
        if !broken_presets && !broken_options {
            return Ok(false);
        }
        if broken_presets || broken_options {
            transaction
                .execute_batch("DROP TABLE IF EXISTS property_preset_options;")
                .map_err(|error| error.to_string())?;
        }
        if broken_presets {
            transaction
                .execute_batch("DROP TABLE IF EXISTS property_presets;")
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute_batch(PROPERTY_PRESET_SCHEMA)
            .map_err(|error| error.to_string())?;
        if broken_presets {
            transaction
                .execute(
                    "DELETE FROM local_migrations WHERE migration_key='property_presets_v1'",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub fn get(&self) -> Result<PropertyPresetRegistry, String> {
        let mut database = self.open()?;
        let connection = database.transaction().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare(
            "SELECT scope, id, property_key, display_name, property_type, revision, multiple, position FROM property_presets ORDER BY scope, position, property_key",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, Option<i64>>(6)?.map(|value| value != 0),
                    row.get::<_, u32>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut registry = PropertyPresetRegistry::default();
        for row in rows {
            let (scope, id, key, name, kind, revision, multiple, position) = row;
            let mut options_statement = connection.prepare(
                "SELECT option_id, label FROM property_preset_options WHERE scope = ?1 AND preset_id = ?2 ORDER BY position",
            ).map_err(|error| error.to_string())?;
            let options = options_statement
                .query_map(params![scope, id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let field = PropertyFieldConfig {
                position,
                id: Some(id),
                name,
                revision,
                option_ids: options.iter().map(|(id, _)| id.clone()).collect(),
                multiple,
                key,
                r#type: kind,
                options: options.into_iter().map(|(_, label)| label).collect(),
            };
            match scope.as_str() {
                "system" => registry.system_fields.push(field),
                "user" => registry.fields.push(field),
                "deleted_user" => registry.deleted_fields.push(field),
                _ => return Err("unknown property preset scope".into()),
            }
        }
        Ok(registry)
    }

    #[cfg(test)]
    pub fn replace(&self, registry: &PropertyPresetRegistry) -> Result<(), String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM property_preset_options", [])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM property_presets", [])
            .map_err(|error| error.to_string())?;
        insert_registry(&transaction, registry)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn patch(
        &self,
        changes: &[PropertyPresetChange],
    ) -> Result<PropertyPresetRegistry, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        for change in changes {
            let id = change
                .field
                .id
                .as_deref()
                .ok_or("missing property preset ID")?;
            if !id.starts_with("fld_")
                || id.len() != 36
                || !id[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("invalid property preset ID".into());
            }
            if !["system", "user", "deleted_user"].contains(&change.scope.as_str()) {
                return Err("invalid property preset scope".into());
            }
            let current = transaction.query_row(
                "SELECT scope, revision, property_key, display_name, property_type, multiple, position FROM property_presets WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<bool>>(5)?,
                        row.get::<_, u32>(6)?,
                    ))
                },
            );
            let revision = match current {
                Ok((scope, revision, key, name, kind, multiple, _position)) => {
                    if change.expected_revision != Some(revision) {
                        return Err("属性预设已被修改，请刷新后重试".into());
                    }
                    // A user preset's key IS its user-facing name, so renaming is allowed.
                    // System presets keep their identity and allow only Select/MultiSelect options to change.
                    if scope == "system" {
                        let options_editable = matches!(kind.as_str(), "Select" | "MultiSelect");
                        if key != change.field.key
                            || change
                                .field
                                .name
                                .as_ref()
                                .is_some_and(|next| Some(next) != name.as_ref())
                            || kind != change.field.r#type
                            || change
                                .field
                                .multiple
                                .is_some_and(|next| Some(next) != multiple)
                        {
                            return Err("系统预设只允许修改单选或多选选项".into());
                        }
                        let mut statement = transaction
                            .prepare("SELECT option_id, label FROM property_preset_options WHERE scope = 'system' AND preset_id = ?1 ORDER BY position")
                            .map_err(|error| error.to_string())?;
                        let existing_options = statement
                            .query_map([id], |row| {
                                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                            })
                            .map_err(|error| error.to_string())?
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|error| error.to_string())?;
                        let next_options = change
                            .field
                            .option_ids
                            .iter()
                            .cloned()
                            .zip(change.field.options.iter().cloned())
                            .collect::<Vec<_>>();
                        if !options_editable && existing_options != next_options {
                            return Err("系统预设只允许修改单选或多选选项".into());
                        }
                    } else if key != change.field.key && scope != "user" {
                        return Err("属性 key 不允许通过定义编辑修改".into());
                    }
                    if scope != change.scope && !(scope == "user" && change.scope == "deleted_user")
                    {
                        return Err("invalid property preset scope transition".into());
                    }
                    if scope == "system" && change.scope != "system" {
                        return Err("系统预设不允许删除或更改范围".into());
                    }
                    revision + 1
                }
                Err(rusqlite::Error::QueryReturnedNoRows)
                    if change.expected_revision.is_none() && change.scope != "deleted_user" =>
                {
                    1
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    return Err("属性预设已不存在，请刷新后重试".into())
                }
                Err(error) => return Err(error.to_string()),
            };
            if ![
                "Text",
                "URL",
                "Icon",
                "Boolean",
                "Number",
                "Date",
                "Select",
                "MultiSelect",
                "Tag",
                "Color",
                "Image",
            ]
            .contains(&change.field.r#type.as_str())
            {
                return Err("invalid property preset type".into());
            }
            if change.field.key.trim().is_empty()
                || ["flowix_property_types", "flowix_plugin"].contains(&change.field.key.as_str())
            {
                return Err("invalid property preset key".into());
            }
            if change.field.option_ids.len() != change.field.options.len() {
                return Err("invalid property preset options".into());
            }
            let mut labels = std::collections::HashSet::new();
            let mut ids = std::collections::HashSet::new();
            for (option_id, label) in change.field.option_ids.iter().zip(&change.field.options) {
                if !option_id.starts_with("opt_")
                    || option_id.len() != 36
                    || !option_id[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
                    || label.trim().is_empty()
                    || !labels.insert(label)
                    || !ids.insert(option_id)
                {
                    return Err("invalid property preset option".into());
                }
            }
            let collision: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM property_presets WHERE scope != 'deleted_user' AND lower(property_key) = lower(?1) AND id != ?2)",
                params![change.field.key, id], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if change.scope != "deleted_user" && collision {
                return Err("属性 key 已存在".into());
            }
            let system_metadata: Option<(Option<String>, Option<bool>, u32)> =
                if change.scope == "system" && change.expected_revision.is_some() {
                    Some(transaction.query_row(
                    "SELECT display_name, multiple, position FROM property_presets WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                ).map_err(|error| error.to_string())?)
                } else {
                    None
                };
            transaction
                .execute("DELETE FROM property_presets WHERE id = ?1", [id])
                .map_err(|error| error.to_string())?;
            let mut field = change.field.clone();
            if let Some((name, multiple, position)) = system_metadata {
                field.name = name;
                field.multiple = multiple;
                field.position = position;
            }
            field.revision = revision;
            let mut registry = PropertyPresetRegistry::default();
            match change.scope.as_str() {
                "system" => registry.system_fields.push(field),
                "user" => registry.fields.push(field),
                _ => registry.deleted_fields.push(field),
            }
            insert_registry(&transaction, &registry)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        self.get()
    }

    /// Import the former preference.json registry once. Existing DB data wins.
    /// The marker and imported rows are committed atomically.
    pub fn migrate_legacy_once(&self, registry: &PropertyPresetRegistry) -> Result<bool, String> {
        self.initialize_legacy_schema()?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let done: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_migrations WHERE migration_key = 'property_presets_v1')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if done {
            return Ok(false);
        }
        let has_data: bool = transaction
            .query_row("SELECT EXISTS(SELECT 1 FROM property_presets)", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if !has_data {
            insert_registry(&transaction, registry)?;
        }
        transaction.execute(
            "INSERT INTO local_migrations(migration_key, completed_at) VALUES ('property_presets_v1', ?1)",
            [chrono::Utc::now().timestamp_millis()],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
    }

    /// Bootstrap defaults and legacy type names before any frontend consumes the catalog.
    /// Existing definitions retain their identity, options and revision.
    pub fn initialize_system_presets(&self) -> Result<(), String> {
        let existing = self.get()?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "UPDATE property_presets SET property_type = CASE property_type
                WHEN 'List' THEN 'MultiSelect' WHEN 'Tags' THEN 'Tag' WHEN 'noteTag' THEN 'Tag' END
             WHERE property_type IN ('List', 'Tags', 'noteTag')",
            )
            .map_err(|error| error.to_string())?;
        for (position, (key, kind)) in SYSTEM_PRESET_TYPES.into_iter().enumerate() {
            if existing.system_fields.iter().any(|field| field.key == key) {
                continue;
            }
            let field = if let Some(legacy) = existing.fields.iter().find(|field| field.key == key)
            {
                // A former custom definition may have become a system preset in an upgrade.
                transaction
                    .execute(
                        "DELETE FROM property_presets WHERE scope = 'user' AND id = ?1",
                        [legacy.id.as_deref()],
                    )
                    .map_err(|error| error.to_string())?;
                legacy.clone()
            } else {
                default_system_field(position, key, kind)
            };
            insert_registry(
                &transaction,
                &PropertyPresetRegistry {
                    system_fields: vec![field],
                    ..Default::default()
                },
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }
}

fn default_system_field(position: usize, key: &str, kind: &str) -> PropertyFieldConfig {
    let options = if key == "status" {
        vec!["未开始".into(), "进行中".into(), "完成".into()]
    } else {
        vec![]
    };
    PropertyFieldConfig {
        id: Some(legacy_property_id(&format!("system:{key}"))),
        key: key.into(),
        r#type: kind.into(),
        revision: 1,
        position: position as u32,
        option_ids: options
            .iter()
            .map(|label| {
                format!(
                    "opt_{}",
                    &legacy_property_id(&format!("system:{key}:{label}"))[4..]
                )
            })
            .collect(),
        options,
        ..Default::default()
    }
}

fn insert_registry(
    transaction: &rusqlite::Transaction<'_>,
    registry: &PropertyPresetRegistry,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    for (scope, fields) in [
        ("system", &registry.system_fields),
        ("user", &registry.fields),
        ("deleted_user", &registry.deleted_fields),
    ] {
        for field in fields {
            let mut normalized = field.clone();
            normalized.r#type = match normalized.r#type.as_str() {
                "List" => "MultiSelect".into(),
                "Tags" | "noteTag" => "Tag".into(),
                _ => normalized.r#type,
            };
            let id = normalized
                .id
                .clone()
                .unwrap_or_else(|| legacy_property_id(&normalized.key));
            normalized.id = Some(id.clone());
            if normalized.revision == 0 {
                normalized.revision = 1;
            }
            if normalized.option_ids.len() != normalized.options.len() {
                normalized.option_ids = normalized
                    .options
                    .iter()
                    .map(|label| {
                        let stable = legacy_property_id(&format!("{}:{}", id, label));
                        format!("opt_{}", &stable[4..])
                    })
                    .collect();
            }
            transaction.execute(
                    "INSERT INTO property_presets(scope, id, property_key, display_name, property_type, revision, multiple, updated_at, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![scope, id, normalized.key, normalized.name, normalized.r#type, normalized.revision as i64, normalized.multiple.map(|value| if value { 1_i64 } else { 0_i64 }), now, normalized.position],
                ).map_err(|error| error.to_string())?;
            for (position, (option_id, label)) in normalized
                .option_ids
                .iter()
                .zip(&normalized.options)
                .enumerate()
            {
                transaction.execute(
                        "INSERT INTO property_preset_options(scope, preset_id, option_id, label, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![scope, id, option_id, label, position as i64],
                    ).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

/// Upgrade the first local.db schema, which stored each field as a JSON blob,
/// without replacing the database or dropping any preset data.
fn migrate_legacy_schema(connection: &mut Connection) -> Result<(), String> {
    let has_table = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='property_presets')",
        [], |row| row.get::<_, bool>(0),
    ).map_err(|error| error.to_string())?;
    if !has_table {
        return Ok(());
    }

    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(property_presets)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    if columns.iter().any(|column| column == "display_name") {
        return Ok(());
    }
    if !columns.iter().any(|column| column == "definition_json") {
        return Err(format!(
            "unsupported property_presets schema: {}",
            columns.join(", ")
        ));
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let legacy_rows = {
        let mut statement = transaction.prepare(
            "SELECT scope, id, property_key, definition_json, revision, updated_at FROM property_presets ORDER BY scope, property_key",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let legacy_options = {
        let exists = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='property_preset_options')",
            [], |row| row.get::<_, bool>(0),
        ).map_err(|error| error.to_string())?;
        if exists {
            let mut statement = transaction.prepare(
                "SELECT scope, preset_id, option_id, label, position FROM property_preset_options ORDER BY scope, preset_id, position",
            ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        } else {
            Vec::new()
        }
    };

    transaction
        .execute_batch(
            "ALTER TABLE property_presets RENAME TO property_presets_legacy;
         DROP TABLE IF EXISTS property_preset_options;
         CREATE TABLE property_presets (
            scope TEXT NOT NULL CHECK(scope IN ('system', 'user', 'deleted_user')),
            id TEXT NOT NULL,
            property_key TEXT NOT NULL,
            display_name TEXT,
            property_type TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            multiple INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(scope, id)
         );
         CREATE TABLE property_preset_options (
            scope TEXT NOT NULL,
            preset_id TEXT NOT NULL,
            option_id TEXT NOT NULL,
            label TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY(scope, preset_id, option_id),
            UNIQUE(scope, preset_id, position),
            FOREIGN KEY(scope, preset_id) REFERENCES property_presets(scope, id) ON DELETE CASCADE
         );",
        )
        .map_err(|error| error.to_string())?;

    for (scope, id, key, definition_json, revision, updated_at) in legacy_rows {
        let mut field: PropertyFieldConfig = serde_json::from_str(&definition_json)
            .map_err(|error| format!("cannot migrate property preset {id}: {error}"))?;
        field.id = Some(id.clone());
        field.key = key.clone();
        field.revision = u64::try_from(revision).unwrap_or(1).max(1);
        transaction.execute(
            "INSERT INTO property_presets(scope, id, property_key, display_name, property_type, revision, multiple, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![scope, id, key, field.name, field.r#type, field.revision as i64, field.multiple.map(|value| if value { 1_i64 } else { 0_i64 }), updated_at],
        ).map_err(|error| error.to_string())?;

        let saved_options = legacy_options
            .iter()
            .filter(|(option_scope, preset_id, _, _, _)| option_scope == &scope && preset_id == &id)
            .collect::<Vec<_>>();
        if !saved_options.is_empty() {
            for (_, _, option_id, label, position) in saved_options {
                transaction.execute(
                    "INSERT INTO property_preset_options(scope, preset_id, option_id, label, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![scope, id, option_id, label, position],
                ).map_err(|error| error.to_string())?;
            }
        } else {
            if field.option_ids.len() != field.options.len() {
                field.option_ids = field
                    .options
                    .iter()
                    .map(|label| {
                        let stable = legacy_property_id(&format!("{}:{}", id, label));
                        format!("opt_{}", &stable[4..])
                    })
                    .collect();
            }
            for (position, (option_id, label)) in
                field.option_ids.iter().zip(&field.options).enumerate()
            {
                transaction.execute(
                    "INSERT INTO property_preset_options(scope, preset_id, option_id, label, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![scope, id, option_id, label, position as i64],
                ).map_err(|error| error.to_string())?;
            }
        }
    }
    transaction
        .execute_batch("DROP TABLE property_presets_legacy;")
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn legacy_property_id(value: &str) -> String {
    let text = value.trim().to_lowercase();
    let mut words = [2166136261_u32, 2246822507, 3266489909, 668265263];
    for unit in text.encode_utf16() {
        for (index, word) in words.iter_mut().enumerate() {
            *word = (*word ^ unit as u32).wrapping_mul(16777619 + index as u32 * 2);
        }
    }
    format!(
        "fld_{:08x}{:08x}{:08x}{:08x}",
        words[0], words[1], words[2], words[3]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_defaults_match_fresh_system_presets() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        store.initialize_runtime_storage().unwrap();
        assert_eq!(
            serde_json::to_value(store.get().unwrap()).unwrap(),
            serde_json::to_value(PropertyPresetStore::runtime_defaults()).unwrap()
        );
    }

    #[test]
    fn repairing_options_preserves_healthy_preset_definitions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("local.db");
        let store = PropertyPresetStore::new(&path);
        let field = PropertyFieldConfig {
            id: Some("fld_0123456789abcdef0123456789abcdef".into()),
            key: "custom".into(),
            name: Some("Keep this definition".into()),
            r#type: "Text".into(),
            revision: 7,
            ..Default::default()
        };
        store
            .replace(&PropertyPresetRegistry {
                fields: vec![field],
                ..Default::default()
            })
            .unwrap();
        let before = serde_json::to_value(store.get().unwrap().fields).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("DROP TABLE property_preset_options; CREATE TABLE property_preset_options(bad TEXT);").unwrap();
        store.initialize_runtime_storage().unwrap();
        assert_eq!(
            serde_json::to_value(store.get().unwrap().fields).unwrap(),
            before
        );
        assert!(!directory.path().join("rebuild-backups").exists());
    }

    #[test]
    fn property_repair_failure_rolls_back_table_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("local.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE property_presets(bad TEXT); INSERT INTO property_presets VALUES ('retained'); CREATE TABLE local_migrations(bad TEXT);").unwrap();
        let store = PropertyPresetStore::new(&path);
        assert!(store.repair_property_tables().is_err());
        assert_eq!(
            connection
                .query_row("SELECT bad FROM property_presets", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "retained"
        );
    }

    #[test]
    fn property_write_lock_does_not_reset_existing_definitions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("local.db");
        let store = PropertyPresetStore::new(&path);
        store.initialize_runtime_storage().unwrap();
        let before = serde_json::to_value(store.get().unwrap()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        assert!(store.initialize_runtime_storage().is_err());
        connection.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(serde_json::to_value(store.get().unwrap()).unwrap(), before);
        assert!(!directory.path().join("rebuild-backups").exists());
    }

    #[test]
    fn per_id_changes_preserve_other_fields_and_reject_stale_writes_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let change = |suffix: &str, key: &str, expected_revision| PropertyPresetChange {
            scope: "user".into(),
            expected_revision,
            field: PropertyFieldConfig {
                id: Some(format!("fld_{}", suffix.repeat(32))),
                key: key.into(),
                r#type: "Tag".into(),
                ..Default::default()
            },
        };
        store.patch(&[change("a", "topics", None)]).unwrap();
        store.patch(&[change("b", "labels", None)]).unwrap();
        assert_eq!(store.get().unwrap().fields.len(), 2);
        let mut update = change("a", "topics", Some(1));
        update.field.name = Some("Topics".into());
        store.patch(&[update.clone()]).unwrap();
        assert!(store.patch(&[change("c", "new", None), update]).is_err());
        let registry = store.get().unwrap();
        assert_eq!(registry.fields.len(), 2);
        assert_eq!(
            registry
                .fields
                .iter()
                .find(|field| field.key == "topics")
                .unwrap()
                .revision,
            2
        );
        let mut delete = change("a", "topics", Some(2));
        delete.scope = "deleted_user".into();
        store.patch(&[delete]).unwrap();
        assert_eq!(store.get().unwrap().deleted_fields[0].revision, 3);
    }

    #[test]
    fn user_preset_key_can_rename_but_a_system_key_cannot() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let user_id = format!("fld_{}", "a".repeat(32));
        store
            .patch(&[PropertyPresetChange {
                scope: "user".into(),
                expected_revision: None,
                field: PropertyFieldConfig {
                    id: Some(user_id.clone()),
                    key: "topics".into(),
                    r#type: "Tag".into(),
                    ..Default::default()
                },
            }])
            .unwrap();
        store
            .patch(&[PropertyPresetChange {
                scope: "user".into(),
                expected_revision: Some(1),
                field: PropertyFieldConfig {
                    id: Some(user_id),
                    key: "主题".into(),
                    r#type: "Tag".into(),
                    ..Default::default()
                },
            }])
            .unwrap();
        let registry = store.get().unwrap();
        assert_eq!(registry.fields[0].key, "主题");
        assert_eq!(registry.fields[0].revision, 2);

        let system_id = format!("fld_{}", "b".repeat(32));
        store
            .patch(&[PropertyPresetChange {
                scope: "system".into(),
                expected_revision: None,
                field: PropertyFieldConfig {
                    id: Some(system_id.clone()),
                    key: "tags".into(),
                    r#type: "Tag".into(),
                    ..Default::default()
                },
            }])
            .unwrap();
        assert!(store
            .patch(&[PropertyPresetChange {
                scope: "system".into(),
                expected_revision: Some(1),
                field: PropertyFieldConfig {
                    id: Some(system_id),
                    key: "renamed".into(),
                    r#type: "Tag".into(),
                    ..Default::default()
                },
            }])
            .is_err());
    }

    #[test]
    fn system_presets_only_allow_option_updates_and_cannot_be_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let id = format!("fld_{}", "c".repeat(32));
        let original = PropertyFieldConfig {
            id: Some(id.clone()),
            name: Some("状态".into()),
            key: "status".into(),
            r#type: "Select".into(),
            revision: 1,
            position: 7,
            option_ids: vec![format!("opt_{}", "a".repeat(32))],
            options: vec!["待办".into()],
            ..Default::default()
        };
        store
            .patch(&[PropertyPresetChange {
                scope: "system".into(),
                expected_revision: None,
                field: original,
            }])
            .unwrap();

        store
            .patch(&[PropertyPresetChange {
                scope: "system".into(),
                expected_revision: Some(1),
                field: PropertyFieldConfig {
                    id: Some(id.clone()),
                    key: "status".into(),
                    r#type: "Select".into(),
                    option_ids: vec![format!("opt_{}", "b".repeat(32))],
                    options: vec!["进行中".into()],
                    ..Default::default()
                },
            }])
            .unwrap();
        let registry = store.get().unwrap();
        let saved = &registry.system_fields[0];
        assert_eq!(saved.name.as_deref(), Some("状态"));
        assert_eq!(saved.position, 7);
        assert_eq!(saved.options, vec!["进行中"]);

        let mut changed_type = saved.clone();
        changed_type.r#type = "Text".into();
        assert!(store
            .patch(&[PropertyPresetChange {
                scope: "system".into(),
                expected_revision: Some(2),
                field: changed_type
            }])
            .is_err());

        let mut delete = saved.clone();
        delete.revision = 0;
        assert!(store
            .patch(&[PropertyPresetChange {
                scope: "deleted_user".into(),
                expected_revision: Some(2),
                field: delete
            }])
            .is_err());
    }

    #[test]
    fn migration_marker_prevents_reimport_after_the_registry_is_emptied() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let legacy = PropertyPresetRegistry {
            fields: vec![PropertyFieldConfig {
                key: "topics".into(),
                r#type: "Tag".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(store.migrate_legacy_once(&legacy).unwrap());
        store.replace(&PropertyPresetRegistry::default()).unwrap();
        assert!(!store.migrate_legacy_once(&legacy).unwrap());
        assert!(store.get().unwrap().fields.is_empty());
    }

    #[test]
    fn startup_seeds_system_definitions_and_preserves_legacy_status_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let id = format!("fld_{}", "a".repeat(32));
        store
            .migrate_legacy_once(&PropertyPresetRegistry {
                fields: vec![PropertyFieldConfig {
                    id: Some(id.clone()),
                    key: "status".into(),
                    r#type: "List".into(),
                    revision: 7,
                    options: vec!["Custom".into()],
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap();
        store.initialize_system_presets().unwrap();
        store.initialize_system_presets().unwrap();
        let registry = store.get().unwrap();
        assert!(registry.fields.is_empty());
        assert_eq!(registry.system_fields.len(), 8);
        let status = registry
            .system_fields
            .iter()
            .find(|field| field.key == "status")
            .unwrap();
        assert_eq!(status.id.as_deref(), Some(id.as_str()));
        assert_eq!(status.r#type, "MultiSelect");
        assert_eq!(status.revision, 7);
        let catalog: PropertyPresetCatalog = registry.into();
        let json = serde_json::to_value(catalog).unwrap();
        let status = json["systemFields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["key"] == "status")
            .unwrap();
        assert!(status.get("optionIds").is_none());
        assert_eq!(status["options"][0]["label"], "Custom");
        assert!(status["options"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("opt_"));
    }

    #[test]
    fn local_database_round_trips_system_user_and_deleted_presets() {
        let directory = tempfile::tempdir().unwrap();
        let store = PropertyPresetStore::new(directory.path().join("local.db"));
        let field = PropertyFieldConfig {
            id: Some("fld_0123456789abcdef0123456789abcdef".into()),
            key: "topics".into(),
            r#type: "Tag".into(),
            revision: 2,
            ..PropertyFieldConfig::default()
        };
        let registry = PropertyPresetRegistry {
            system_fields: vec![field.clone()],
            fields: vec![field.clone()],
            deleted_fields: vec![field],
        };
        store.replace(&registry).unwrap();
        assert_eq!(store.get().unwrap().system_fields.len(), 1);
        assert_eq!(store.get().unwrap().fields.len(), 1);
        assert_eq!(store.get().unwrap().deleted_fields.len(), 1);
        assert!(directory.path().join("local.db").is_file());
    }

    #[test]
    fn migrates_definition_json_schema_and_keeps_database_writable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("local.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE property_presets (
                scope TEXT NOT NULL CHECK(scope IN ('system', 'user', 'deleted_user')),
                id TEXT NOT NULL, property_key TEXT NOT NULL, definition_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
                PRIMARY KEY(scope, id)
             );
             CREATE TABLE property_preset_options (
                scope TEXT NOT NULL, preset_id TEXT NOT NULL, option_id TEXT NOT NULL,
                label TEXT NOT NULL, position INTEGER NOT NULL,
                PRIMARY KEY(scope, preset_id, option_id), UNIQUE(scope, preset_id, position),
                FOREIGN KEY(scope, preset_id) REFERENCES property_presets(scope, id) ON DELETE CASCADE
             );
             INSERT INTO property_presets VALUES
                ('user', 'fld_user', 'topics', '{\"id\":\"fld_user\",\"name\":\"Topics\",\"revision\":4,\"optionIds\":[\"opt_a\"],\"multiple\":true,\"key\":\"topics\",\"type\":\"MultiSelect\",\"options\":[\"Work\"]}', 4, 123),
                ('system', 'fld_system', 'tags', '{\"id\":\"fld_system\",\"key\":\"tags\",\"type\":\"Tag\",\"options\":[]}', 1, 456),
                ('deleted_user', 'fld_deleted', 'old', '{\"id\":\"fld_deleted\",\"key\":\"old\",\"type\":\"Text\",\"options\":[]}', 2, 789);
             INSERT INTO property_preset_options VALUES ('user', 'fld_user', 'opt_a', 'Work', 0);"
        ).unwrap();
        drop(connection);

        let store = PropertyPresetStore::new(&path);
        store.initialize_legacy_schema().unwrap();
        let registry = store.get().unwrap();
        assert_eq!(registry.fields[0].id.as_deref(), Some("fld_user"));
        assert_eq!(registry.fields[0].name.as_deref(), Some("Topics"));
        assert_eq!(registry.fields[0].revision, 4);
        assert_eq!(registry.fields[0].multiple, Some(true));
        assert_eq!(registry.fields[0].option_ids, vec!["opt_a"]);
        assert_eq!(registry.fields[0].options, vec!["Work"]);
        assert_eq!(registry.system_fields[0].r#type, "Tag");
        assert_eq!(registry.deleted_fields[0].key, "old");

        store.replace(&registry).unwrap();
        assert_eq!(store.get().unwrap().fields[0].options, vec!["Work"]);
        let connection = Connection::open(&path).unwrap();
        let definition_json: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('property_presets') WHERE name='definition_json')",
            [], |row| row.get(0),
        ).unwrap();
        assert!(!definition_json);
    }
}
