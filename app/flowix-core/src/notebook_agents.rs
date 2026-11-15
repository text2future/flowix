//! 笔记本内的 `.agents/` 工作区：只认 v1 的三个可移植文件。
//!
//! 范围有意收窄：`mcp.json`、`skills/<id>/SKILL.md`、`agents/<id>/agent.md`。
//! 不碰 Codex 的 `.codex/config.toml`，也不碰 Flowix 自己的 `.flowix` 访问元数据。
//!
//! 三条不变量：
//! 1. **符号链接一律拒绝**（目录和文件都算），否则一次保存就能写到笔记本外面；
//! 2. **写入先校验再落盘**，ID / 命令名 / 描述 / 正文都有长度与字符集约束，
//!    前端传什么都不能绕过；
//! 3. **删除只删配置里消失的条目**，路径必须仍在笔记本内才动手。
//!
//! 这里没有 IPC。desktop 的 `commands::agent::notebook_agents` 只是三个
//! `#[tauri::command]` 包装，Pi 侧读技能直接调 [`enabled_notebook_skills`]。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const WORKSPACE_VERSION: u32 = 1;
const MAX_ID_LENGTH: usize = 64;
const MAX_NAME_LENGTH: usize = 200;
const MAX_DESCRIPTION_LENGTH: usize = 500;
const MAX_BODY_LENGTH: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAgentWorkspace {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, Value>,
    #[serde(default)]
    pub skills: Vec<NotebookAgentFile>,
    #[serde(default)]
    pub agents: Vec<NotebookAgentFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAgentFile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_name: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub frontmatter: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct NotebookSkillResource {
    pub directory: PathBuf,
    pub path: PathBuf,
    pub command_name: String,
    pub declared_name: Option<String>,
    pub contents: Vec<u8>,
}

fn default_version() -> u32 {
    WORKSPACE_VERSION
}

fn default_true() -> bool {
    true
}

fn agents_root(root: &Path) -> PathBuf {
    root.join(".agents")
}

pub fn notebook_root<'a>(cwd: &'a str) -> Result<&'a Path, String> {
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("笔记本路径必须是绝对路径".to_string());
    }
    reject_symlink(path, "笔记本目录")?;
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取笔记本目录: {error}"))?;
    if !metadata.is_dir() {
        return Err("笔记本路径不是目录".to_string());
    }
    Ok(path)
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("拒绝使用符号链接作为 {label}: {}", path.display()));
    }
    Ok(())
}

fn ensure_agents_root(root: &Path) -> Result<PathBuf, String> {
    let directory = agents_root(root);
    reject_symlink(&directory, ".agents 目录")?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建 .agents 目录失败: {error}"))?;
    if !crate::path_scope::path_is_inside(&directory, root) {
        return Err(".agents 目录超出笔记本范围".to_string());
    }
    Ok(directory)
}

fn read_mcp_servers(root: &Path) -> Result<BTreeMap<String, Value>, String> {
    let path = agents_root(root).join("mcp.json");
    reject_symlink(&path, "mcp.json")?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析 {} 失败: {error}", path.display()))?;
    let object = value
        .get("mcpServers")
        .or_else(|| value.get("mcp_servers"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{} 缺少 mcpServers 对象", path.display()))?;
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect())
}

fn find_markdown_file(directory: &Path, lower_name: &str, upper_name: &str) -> Option<PathBuf> {
    let upper = directory.join(upper_name);
    if upper.is_file() {
        return Some(upper);
    }
    let lower = directory.join(lower_name);
    if lower.is_file() {
        return Some(lower);
    }
    None
}

fn parse_frontmatter(content: &str) -> (BTreeMap<String, String>, String) {
    match crate::skill_frontmatter::parse(content) {
        Ok((header, body)) => {
            let fields = header
                .into_iter()
                .filter_map(|(key, value)| {
                    let key = key.as_str()?.to_string();
                    let value = match value {
                        serde_yaml::Value::String(text) => text,
                        serde_yaml::Value::Bool(value) => value.to_string(),
                        serde_yaml::Value::Number(value) => value.to_string(),
                        _ => return None,
                    };
                    Some((key, value))
                })
                .collect();
            (fields, body)
        }
        Err(_) => (
            BTreeMap::new(),
            content.replace("\r\n", "\n").trim().to_string(),
        ),
    }
}

fn encode_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value.replace('"', "\\\"")))
}

fn read_markdown_collection_with_contents(
    root: &Path,
    kind: &str,
) -> Result<Vec<(NotebookAgentFile, String)>, String> {
    let directory = agents_root(root).join(kind);
    reject_symlink(&directory, &format!(".agents/{kind} 目录"))?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    if !directory.is_dir() {
        return Err(format!(".agents/{kind} 不是目录"));
    }

    let mut children = fs::read_dir(&directory)
        .map_err(|error| format!("读取 .agents/{kind} 目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 .agents/{kind} 目录失败: {error}"))?;
    children.sort_by_key(|entry| entry.file_name());

    let (lower_name, upper_name) = if kind == "skills" {
        ("skill.md", "SKILL.md")
    } else {
        ("agent.md", "AGENT.md")
    };

    let mut files = children
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            Some((path, entry.file_name().to_string_lossy().into_owned()))
        })
        .map(|(directory, folder_id)| {
            reject_symlink(&directory, "Agent 配置目录")?;
            let path = find_markdown_file(&directory, lower_name, upper_name)
                .ok_or_else(|| format!("{} 缺少 {lower_name}", directory.display()))?;
            reject_symlink(&path, "Agent 配置文件")?;
            let content = fs::read_to_string(&path)
                .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
            let (frontmatter, body) = parse_frontmatter(&content);
            let id = frontmatter
                .get("id")
                .cloned()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(folder_id);
            let declared_name = frontmatter.get("name");
            let command_name = if kind == "skills" {
                declared_name
                    .filter(|value| valid_pi_skill_name(value))
                    .cloned()
            } else {
                None
            };
            let display_name = if kind == "skills" {
                frontmatter
                    .get("display-name")
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| declared_name.filter(|value| !valid_pi_skill_name(value)))
                    .or(declared_name)
            } else {
                declared_name
            };
            let name = display_name
                .cloned()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| id.clone());
            let description = frontmatter.get("description").cloned().unwrap_or_default();
            let enabled = frontmatter
                .get("enabled")
                .map(|value| value.trim().to_ascii_lowercase() != "false")
                .unwrap_or(true);
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            Ok((
                NotebookAgentFile {
                    id,
                    name,
                    command_name,
                    description,
                    enabled,
                    body,
                    path: relative_path,
                    frontmatter,
                },
                content,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if kind == "skills" {
        assign_unique_pi_skill_names(&mut files);
    }
    Ok(files)
}

fn normalized_pi_skill_name(value: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if separator && !result.is_empty() && result.len() < 64 {
                result.push('-');
            }
            if result.len() >= 64 {
                break;
            }
            result.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    while result.ends_with('-') {
        result.pop();
    }
    if result.is_empty() {
        "skill".to_string()
    } else {
        result
    }
}

fn unique_pi_skill_name(base: &str, used: &HashSet<String>) -> String {
    if !used.contains(base) {
        return base.to_string();
    }
    for suffix in 2.. {
        let suffix = format!("-{suffix}");
        let prefix_length = 64usize.saturating_sub(suffix.len());
        let prefix = base
            .chars()
            .take(prefix_length)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string();
        let candidate = format!("{prefix}{suffix}");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("finite skill names cannot exhaust the command-name space")
}

fn assign_unique_pi_skill_names(files: &mut [(NotebookAgentFile, String)]) {
    let mut explicit_names = HashSet::new();
    for (skill, _) in files.iter_mut() {
        skill.command_name = skill
            .frontmatter
            .get("name")
            .filter(|name| valid_pi_skill_name(name))
            .cloned()
            .filter(|name| explicit_names.insert(name.clone()));
    }

    let mut used = explicit_names;
    for (skill, _) in files.iter_mut() {
        if skill.command_name.is_some() {
            continue;
        }
        let folder_id = Path::new(&skill.path)
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or(&skill.id);
        let base = normalized_pi_skill_name(&skill.id);
        let base = if base == "skill" {
            normalized_pi_skill_name(folder_id)
        } else {
            base
        };
        let command_name = unique_pi_skill_name(&base, &used);
        used.insert(command_name.clone());
        skill.command_name = Some(command_name);
    }
}

pub fn read_markdown_collection(root: &Path, kind: &str) -> Result<Vec<NotebookAgentFile>, String> {
    Ok(read_markdown_collection_with_contents(root, kind)?
        .into_iter()
        .map(|(file, _)| file)
        .collect())
}

pub fn read_workspace(root: &Path) -> Result<NotebookAgentWorkspace, String> {
    let directory = agents_root(root);
    reject_symlink(&directory, ".agents 目录")?;
    Ok(NotebookAgentWorkspace {
        version: WORKSPACE_VERSION,
        root_path: root.to_string_lossy().into_owned(),
        mcp_servers: read_mcp_servers(root)?,
        skills: read_markdown_collection(root, "skills")?,
        agents: read_markdown_collection(root, "agents")?,
    })
}

pub fn enabled_notebook_skills(root: &Path) -> Result<Vec<NotebookSkillResource>, String> {
    let root_text = root.to_string_lossy().into_owned();
    let root = notebook_root(&root_text)?;
    read_markdown_collection_with_contents(root, "skills")?
        .into_iter()
        .filter(|(skill, _)| {
            skill.enabled
                && skill.command_name.is_some()
                && !skill.description.trim().is_empty()
                && skill.path.rsplit('/').next() == Some("SKILL.md")
        })
        .map(|(skill, contents)| {
            let path = root.join(&skill.path);
            let directory = path
                .parent()
                .ok_or_else(|| format!("Pi Skill 路径无效: {}", path.display()))?
                .to_path_buf();
            Ok(NotebookSkillResource {
                directory,
                path,
                command_name: skill
                    .command_name
                    .clone()
                    .unwrap_or_else(|| skill.id.clone()),
                declared_name: skill.frontmatter.get("name").cloned(),
                contents: contents.into_bytes(),
            })
        })
        .collect()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LENGTH
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn valid_pi_skill_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.contains("--")
}

fn valid_text(value: &str, max_length: usize) -> bool {
    value.len() <= max_length
        && !value
            .chars()
            .any(|character| character == '\n' || character == '\r')
}

fn validate_file(item: &NotebookAgentFile, kind: &str) -> Result<(), String> {
    if !valid_id(&item.id) {
        return Err(format!("{kind} ID 只能使用小写字母、数字和连字符"));
    }
    if !valid_text(item.name.trim(), MAX_NAME_LENGTH) || item.name.trim().is_empty() {
        return Err(format!(
            "{kind} 名称不能为空且不能超过 {MAX_NAME_LENGTH} 个字符"
        ));
    }
    if kind == "Skill" {
        let command_name = item.command_name.as_deref().unwrap_or(&item.id);
        if !valid_pi_skill_name(command_name) {
            return Err(
                "Pi Skill 命令名只能使用小写字母、数字和连字符，不能以连字符开头或结尾，也不能含连续连字符；长度不超过 64".into(),
            );
        }
    }
    if !valid_text(item.description.trim(), MAX_DESCRIPTION_LENGTH) {
        return Err(format!(
            "{kind} 描述不能超过 {MAX_DESCRIPTION_LENGTH} 个字符"
        ));
    }
    if item.body.trim().is_empty() || item.body.len() > MAX_BODY_LENGTH {
        return Err(format!(
            "{kind} 指令不能为空且不能超过 {MAX_BODY_LENGTH} 个字符"
        ));
    }
    for key in item.frontmatter.keys() {
        if key.is_empty()
            || !key.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
        {
            return Err(format!("{kind} frontmatter 含有无效字段名: {key}"));
        }
    }
    Ok(())
}

fn validate_mcp(name: &str, definition: &Value) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_ID_LENGTH
        || !name.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '_'
        })
    {
        return Err("MCP 名称只能使用小写字母、数字、连字符和下划线".to_string());
    }
    let object = definition
        .as_object()
        .ok_or_else(|| format!("MCP {name} 配置必须是对象"))?;
    if let Some(transport) = object.get("transport").and_then(Value::as_str) {
        if !matches!(transport, "stdio" | "streamable-http" | "http") {
            return Err(format!("MCP {name} 使用了不支持的连接方式"));
        }
    }
    if let Some(command) = object.get("command") {
        if !command.is_string() {
            return Err(format!("MCP {name} 的 command 必须是字符串"));
        }
    }
    if let Some(args) = object.get("args") {
        if !args
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
        {
            return Err(format!("MCP {name} 的 args 必须是字符串数组"));
        }
    }
    if let Some(url) = object.get("url") {
        if !url.is_string() {
            return Err(format!("MCP {name} 的 url 必须是字符串"));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    reject_symlink(path, "配置文件")?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "配置文件名无效".to_string())?;
    let temporary = parent.join(format!(".{file_name}.flowix-tmp"));
    reject_symlink(&temporary, "配置临时文件")?;
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("打开配置临时文件失败: {error}"))?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入配置失败: {error}"))?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("替换配置文件失败: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("替换配置文件失败: {error}"))
}

fn render_markdown(item: &NotebookAgentFile, kind: &str) -> String {
    let mut frontmatter = item.frontmatter.clone();
    frontmatter.insert(
        "description".to_string(),
        item.description.trim().to_string(),
    );
    frontmatter.insert("enabled".to_string(), item.enabled.to_string());
    frontmatter.insert("id".to_string(), item.id.clone());
    if kind == "skills" {
        // `name` is Pi's slash-command identifier. Keep the editor's human
        // readable label separately so a Chinese display name never becomes
        // an invalid `/skill:<name>` command.
        let command_name = item
            .command_name
            .as_deref()
            .filter(|name| valid_pi_skill_name(name))
            .unwrap_or(&item.id);
        frontmatter.insert("name".to_string(), command_name.to_string());
        if item.name.trim() == command_name {
            frontmatter.remove("display-name");
        } else {
            frontmatter.insert("display-name".to_string(), item.name.trim().to_string());
        }
    } else {
        frontmatter.insert("name".to_string(), item.name.trim().to_string());
    }
    if kind == "agents" {
        frontmatter
            .entry("role".to_string())
            .or_insert_with(|| "delegation-target".to_string());
    }
    let lines = frontmatter
        .into_iter()
        .map(|(key, value)| format!("{key}: {}", encode_scalar(&value)))
        .collect::<Vec<_>>();
    format!("---\n{}\n---\n\n{}\n", lines.join("\n"), item.body.trim())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    reject_symlink(path, "待删除的 Agent 配置")?;
    fs::remove_file(path).map_err(|error| format!("删除 {} 失败: {error}", path.display()))
}

#[cfg(target_os = "linux")]
fn remove_legacy_lowercase_skill(directory: &Path) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("读取 {} 失败: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取 {} 失败: {error}", directory.display()))?;
        if entry.file_name() == "skill.md" {
            remove_if_present(&entry.path())?;
        }
    }
    Ok(())
}

fn remove_empty_directory(path: &Path) {
    if path.is_dir()
        && fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    {
        let _ = fs::remove_dir(path);
    }
}

fn write_collection(
    root: &Path,
    kind: &str,
    incoming: &[NotebookAgentFile],
    existing: &[NotebookAgentFile],
) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut command_names = HashSet::new();
    for item in incoming {
        validate_file(
            item,
            if kind == "skills" {
                "Skill"
            } else {
                "子 Agent"
            },
        )?;
        if !ids.insert(item.id.clone()) {
            return Err(format!("{kind} ID 重复: {}", item.id));
        }
        if kind == "skills" {
            let command_name = item.command_name.as_deref().unwrap_or(&item.id);
            if !command_names.insert(command_name.to_string()) {
                return Err(format!("Skill 命令名重复: {command_name}"));
            }
        }
    }
    let base = ensure_agents_root(root)?.join(kind);
    reject_symlink(&base, &format!(".agents/{kind} 目录"))?;
    let file_name = if kind == "skills" {
        "SKILL.md"
    } else {
        "agent.md"
    };
    for item in incoming {
        let directory = base.join(&item.id);
        if !crate::path_scope::path_is_inside(&directory, root) {
            return Err("Agent 配置路径超出笔记本范围".to_string());
        }
        reject_symlink(&directory, "Agent 配置目录")?;
        let path = directory.join(file_name);
        atomic_write(&path, &render_markdown(item, kind))?;
        #[cfg(target_os = "linux")]
        if kind == "skills" {
            // Read legacy lowercase filenames for compatibility, but always
            // leave the DSH-discoverable uppercase form after a save.
            remove_legacy_lowercase_skill(&directory)?;
        }
    }
    for old in existing.iter().filter(|item| !ids.contains(&item.id)) {
        let path = root.join(old.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if crate::path_scope::path_is_inside(&path, root) {
            remove_if_present(&path)?;
            #[cfg(target_os = "linux")]
            if kind == "skills" {
                remove_legacy_lowercase_skill(&base.join(&old.id))?;
            }
            if let Some(parent) = path.parent() {
                remove_empty_directory(parent);
            }
        }
    }
    if incoming.is_empty() {
        remove_empty_directory(&base);
    }
    Ok(())
}

pub fn write_workspace(
    root: &Path,
    workspace: &NotebookAgentWorkspace,
) -> Result<NotebookAgentWorkspace, String> {
    if workspace.version != 0 && workspace.version != WORKSPACE_VERSION {
        return Err(format!("不支持的 Agent 配置版本: {}", workspace.version));
    }
    let existing = read_workspace(root)?;
    for (name, definition) in &workspace.mcp_servers {
        validate_mcp(name, definition)?;
    }
    let agents_directory = ensure_agents_root(root)?;
    let mcp_path = agents_directory.join("mcp.json");
    if !workspace.mcp_servers.is_empty() || mcp_path.exists() {
        let content = serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": workspace.mcp_servers,
        }))
        .map_err(|error| format!("生成 mcp.json 失败: {error}"))?;
        atomic_write(&mcp_path, &content)?;
    }
    write_collection(root, "skills", &workspace.skills, &existing.skills)?;
    write_collection(root, "agents", &workspace.agents, &existing.agents)?;
    read_workspace(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_frontmatter_and_body() {
        let (frontmatter, body) = parse_frontmatter(
            "---\nid: reviewer\nname: Review\ndescription: \"Checks code\"\nenabled: false\n---\n\nDo the review.",
        );
        assert_eq!(frontmatter.get("id").map(String::as_str), Some("reviewer"));
        assert_eq!(
            frontmatter.get("description").map(String::as_str),
            Some("Checks code")
        );
        assert_eq!(body, "Do the review.");
    }

    #[test]
    fn renders_deterministic_agent_frontmatter() {
        let item = NotebookAgentFile {
            id: "reviewer".into(),
            name: "Review".into(),
            command_name: None,
            description: "Checks code".into(),
            enabled: true,
            body: "Do the review.".into(),
            path: String::new(),
            frontmatter: BTreeMap::new(),
        };
        let content = render_markdown(&item, "agents");
        assert!(content.contains("id: \"reviewer\""));
        assert!(content.contains("role: \"delegation-target\""));
        assert!(content.ends_with("Do the review.\n"));
    }
}
