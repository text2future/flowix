//! Markdown frontmatter 解析与编辑。
//!
//! 唯一持久化字段: `key` (= memo id, 字符集 `[0-9a-z]`；当前 8 位, 兼容旧 6 位)。
//!
//! ## 工具
//!
//! - [`extract_body_content`] — 切掉 `---\n...\n---` 块, 返回 body 切片。
//! - [`build_md_content`] — 整段生成 frontmatter + body, 第一次创建 .md 时使用。
//! - [`merge_frontmatter`] — 就地编辑 frontmatter 块, 见下文。
//!
//! ## `merge_frontmatter` 行为
//!
//! 1. 找到 `---\n...\n---` 块。
//! 2. 逐行扫描内部:
//!    - 命中顶层 `key: value` 单行 (`FM_LINE_RE` 匹配) 且 key 名在 `overrides` 里 →
//!      **就地替换** value;
//!    - 其它行 (注释 / 空行 / 列表 / 多行值起点 / 其它 map) → **字节级保留**。
//! 3. `overrides` 里有但 frontmatter 找不到对应行的新 key:
//!    - key 名 == `"key"` → **头部**追加 (紧邻 `---` 闭行后第一行);
//!    - 其它字段名 → **末尾**追加。
//! 4. 无 frontmatter 块 → 在文件头插入完整块, key 字段头部追加。
//! 5. body 字节级不动。
//!
//! 引号策略: 替换 / 追加时按 YAML 标准不加引号 (`key` 字符集 `[0-9a-z]`,
//! 无 `:` `#` `&` `*` `!` `|` `>` `"` `%` `@` `` ` `` 歧义字符, 无
//! 引号合法且无可读性损失)。body 字符串本身走 caller 传入的形态, merge
//! 工具不动。

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Map, Value};

pub static FRONTMATTER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\u{FEFF}?---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n?([\s\S]*)$").unwrap());

/// 顶层 `key: value` 单行识别 (无引号 / 单引号 / 双引号 value 都识别)。
///
/// 嵌套 / 多行值 / 列表 / 注释 / 空行 不走这条匹配。捕获组:
/// 1. 缩进 (用于后续可能的对齐, 当前版本忽略)
/// 2. 字段名
/// 3. value (含引号, 替换时由 caller 决定是否重新加引号)
static FM_LINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$").unwrap());

/// 注入指令集: key → 新 value。**就地替换**语义。
///
/// 当前 caller 永远只传 `("key", id)`, 但工具本身对任意字段名生效。
/// 头部 / 末尾追加策略由 key 名 == "key" 决定, 写死在 [`merge_frontmatter`] 内。
pub type MergeOverrides = BTreeMap<String, String>;

/// 切掉 YAML frontmatter 块, 返回剩余 body。
///
/// 输入示例:
/// ```text
/// ---
/// key: abc123
/// ---
/// # Hello
/// body
/// ```
/// 返回 `"# Hello\nbody\n"`。
pub fn extract_body_content(content: &str) -> &str {
    if let Some(captures) = FRONTMATTER_RE.captures(content) {
        captures.get(2).map(|m| m.as_str()).unwrap_or("")
    } else {
        content
    }
}

/// 从 frontmatter 块里提取 `key` 字段值, 找不到返回 None。
///
/// 用于 `register_existing_file` 走"按磁盘 key 反查 memo index entry"路径,
/// 避免 inode rename 漏命中时 (Windows / tracker 还没扫到) 把物理 rename
/// 当成 create 重复生成 id。
///
/// 行为:
/// - 无 frontmatter 块 → None
/// - 有 frontmatter 但没 `key:` 行 → None
/// - `key:` value 不在 `[0-9a-z]{6|8}` 字符集 → None (防止用户手写垃圾值)
pub fn extract_frontmatter_key(content: &str) -> Option<String> {
    let caps = FRONTMATTER_RE.captures(content)?;
    let inner = caps.get(1)?.as_str();
    for line in inner.split('\n') {
        if let Some(c) = FM_LINE_RE.captures(line) {
            let name = c.get(2).map(|m| m.as_str())?;
            if name == "key" {
                let value = c
                    .get(3)
                    .map(|m| m.as_str())?
                    .trim()
                    .trim_matches(|ch| ch == '"' || ch == '\'');
                if matches!(value.len(), 6 | super::MEMO_ID_LENGTH)
                    && value.chars().all(|c| {
                        c.is_ascii_alphanumeric() && (c.is_ascii_digit() || c.is_ascii_lowercase())
                    })
                {
                    return Some(value.to_string());
                }
                return None;
            }
        }
    }
    None
}

pub fn extract_frontmatter_properties(content: &str) -> Value {
    let Some(caps) = FRONTMATTER_RE.captures(content) else {
        return Value::Object(Map::new());
    };
    let Some(inner) = caps.get(1).map(|m| m.as_str().trim()) else {
        return Value::Object(Map::new());
    };
    if inner.is_empty() {
        return Value::Object(Map::new());
    }

    match serde_yaml::from_str::<Value>(inner) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => Value::Object(Map::new()),
    }
}

/// `create_memo` 第一次创建 .md 时使用。
///
/// `key` 字符集 `[0-9a-z]`, YAML 标准下无引号合法。
pub fn build_md_content(key: &str, body: &str) -> String {
    format!("---\nkey: {}\n---\n{}", key, body)
}

/// 就地编辑 frontmatter 块, 见模块 doc 详述行为契约。
pub fn merge_frontmatter(content: &str, overrides: &MergeOverrides) -> String {
    if overrides.is_empty() {
        return content.to_string();
    }

    let collapsed;
    let content = if let Some(next) = collapse_adjacent_override_frontmatter(content, overrides) {
        collapsed = next;
        collapsed.as_str()
    } else {
        content
    };

    match FRONTMATTER_RE.captures(content) {
        Some(caps) => {
            let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let mut body = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
            // 宽容 regex `\n?` 可能让 body 头部多一个 `\n`, 吃掉
            if body.starts_with('\n') {
                body.remove(0);
            }
            let merged_inner = merge_inner(inner, overrides);
            if merged_inner.is_empty() {
                // inner 仍空 (无 overrides 匹配也无待追加), 维持原块结构
                format!("---\n---\n{}", body)
            } else {
                format!("---\n{}\n---\n{}", merged_inner, body)
            }
        }
        None => {
            // 无 frontmatter 块 → 插入完整块, 注入 key 走头部追加路径
            let mut block_lines: Vec<String> = Vec::new();
            let mut tail_lines: Vec<String> = Vec::new();
            for (k, v) in overrides {
                if k == "key" {
                    block_lines.push(format!("{}: {}", k, v));
                } else {
                    tail_lines.push(format!("{}: {}", k, v));
                }
            }
            block_lines.extend(tail_lines);
            let block = block_lines.join("\n");
            // body 前补一个换行: 文件头插入 `---\n...\n---\n\n<body>`
            format!("---\n{}\n---\n\n{}", block, content)
        }
    }
}

fn collapse_adjacent_override_frontmatter(
    content: &str,
    overrides: &MergeOverrides,
) -> Option<String> {
    let first = FRONTMATTER_RE.captures(content)?;
    let first_inner = first.get(1).map(|m| m.as_str()).unwrap_or("");
    let body = first.get(2).map(|m| m.as_str()).unwrap_or("");

    if !frontmatter_contains_only_override_fields(first_inner, overrides) {
        return None;
    }

    if FRONTMATTER_RE.is_match(body) {
        Some(body.to_string())
    } else {
        None
    }
}

fn frontmatter_contains_only_override_fields(inner: &str, overrides: &MergeOverrides) -> bool {
    let mut saw_override_field = false;

    for line in inner.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(cap) = FM_LINE_RE.captures(line) else {
            return false;
        };
        let Some(key_name) = cap.get(2).map(|m| m.as_str()) else {
            return false;
        };
        if !overrides.contains_key(key_name) {
            return false;
        }
        saw_override_field = true;
    }

    saw_override_field
}

/// 在已有 frontmatter 内部就地合并 `overrides`。
///
/// 行为要点:
/// - 保留所有**非** `key: value` 单行的字节 (注释 / 空行 / 列表 / 多行值起点 /
///   其它 map 字段)。
/// - 对 `key: value` 单行, 命中 overrides 内的 key 时**就地替换** value;
///   **不**命中时**保留原行** (含其原引号风格 / 缩进)。
/// - overrides 内出现但 frontmatter 找不到对应行的 key:
///   - `key` → 准备头部追加 (插入到首行位置);
///   - 其它 → 准备末尾追加。
fn merge_inner(inner: &str, overrides: &MergeOverrides) -> String {
    // 1. 行级扫描, 拆出 (key 名, 替换后 value 或 None) 与保留行
    let mut preserved_lines: Vec<String> = Vec::new();
    // overrides 中没找到对应行的待追加字段
    let mut pending: Vec<(String, String)> = Vec::new();
    for (k, v) in overrides {
        pending.push((k.clone(), v.clone()));
    }

    if !inner.is_empty() {
        for line in inner.split('\n') {
            if let Some(cap) = FM_LINE_RE.captures(line) {
                let key_name = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                if overrides.contains_key(&key_name) {
                    // 就地替换
                    let new_value = overrides.get(&key_name).unwrap();
                    preserved_lines.push(format!("{}: {}", key_name, new_value));
                    // 从 pending 移除此 key, 防止末尾重复追加
                    pending.retain(|(k, _)| k != &key_name);
                    continue;
                }
            }
            // 非替换目标行 / 非 key: value 形式 → 字节级保留
            preserved_lines.push(line.to_string());
        }
    }

    // 2. 头部追加 (仅 key) + 末尾追加 (其它)
    let mut head_lines: Vec<String> = Vec::new();
    let mut tail_lines: Vec<String> = Vec::new();
    for (k, v) in &pending {
        // pending 里剩下的就是 overrides 中未在 frontmatter 找到对应行的 key
        if k == "key" {
            head_lines.push(format!("{}: {}", k, v));
        } else {
            tail_lines.push(format!("{}: {}", k, v));
        }
    }

    // 3. 拼接
    let mut final_lines: Vec<String> =
        Vec::with_capacity(head_lines.len() + preserved_lines.len() + tail_lines.len());
    final_lines.extend(head_lines);
    final_lines.extend(preserved_lines);
    final_lines.extend(tail_lines);

    final_lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============== extract_body_content ==============

    #[test]
    fn extracts_body_after_frontmatter() {
        let md = "---\nkey: x\n---\n# Title\nbody\n";
        assert_eq!(extract_body_content(md), "# Title\nbody\n");
    }

    #[test]
    fn returns_unchanged_when_no_frontmatter() {
        let md = "# Title\nbody\n";
        assert_eq!(extract_body_content(md), md);
    }

    #[test]
    fn returns_empty_when_only_frontmatter() {
        let md = "---\nkey: x\n---\n";
        assert_eq!(extract_body_content(md), "");
    }

    #[test]
    fn extracts_quoted_frontmatter_keys() {
        assert_eq!(
            extract_frontmatter_key("---\nkey: \"abc12345\"\n---\nbody\n"),
            Some("abc12345".to_string())
        );
        assert_eq!(
            extract_frontmatter_key("---\nkey: 'abc123'\n---\nbody\n"),
            Some("abc123".to_string())
        );
    }

    // ============== build_md_content ==============

    #[test]
    fn build_with_key_and_body() {
        assert_eq!(
            build_md_content("abc123", "# Title\nbody\n"),
            "---\nkey: abc123\n---\n# Title\nbody\n"
        );
    }

    #[test]
    fn build_with_empty_body() {
        assert_eq!(build_md_content("abc123", ""), "---\nkey: abc123\n---\n");
    }

    // ============== merge_frontmatter: no frontmatter ==============

    #[test]
    fn merge_inserts_block_when_missing() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        let out = merge_frontmatter("body\n", &overrides);
        assert_eq!(out, "---\nkey: abc123\n---\n\nbody\n");
    }

    #[test]
    fn merge_inserts_block_with_empty_body() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        assert_eq!(
            merge_frontmatter("", &overrides),
            "---\nkey: abc123\n---\n\n"
        );
    }

    // ============== merge_frontmatter: replace existing key ==============

    #[test]
    fn merge_replaces_existing_key_in_place() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "newid1".to_string());
        let input = "---\nkey: oldid9\ntags: [a]\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: newid1\ntags: [a]\n---\nbody\n");
    }

    #[test]
    fn merge_preserves_unrelated_lines() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        let input = "---\ntags: [a, b]\n# comment\ndescription: |\n  multi\n  line\n\nauthor: x\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(
            out,
            "---\nkey: abc123\ntags: [a, b]\n# comment\ndescription: |\n  multi\n  line\n\nauthor: x\n---\nbody\n"
        );
    }

    // ============== merge_frontmatter: prepend key, append others ==============

    #[test]
    fn merge_prepends_missing_key() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        let input = "---\ntags: [a]\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: abc123\ntags: [a]\n---\nbody\n");
    }

    #[test]
    fn merge_prepends_missing_key_in_crlf_frontmatter() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        let input = "---\r\nname: imported\r\n---\r\nbody\r\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: abc123\nname: imported\n---\nbody\r\n");
    }

    #[test]
    fn merge_collapses_adjacent_key_block_into_user_frontmatter() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "sg8qgwdq".to_string());
        let input = concat!(
            "---\n",
            "key: sg8qgwdq\n",
            "---\n",
            "---\n",
            "name: guizang-ppt-skill\n",
            "description: deck generator\n",
            "---\n",
            "body\n"
        );
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(
            out,
            concat!(
                "---\n",
                "key: sg8qgwdq\n",
                "name: guizang-ppt-skill\n",
                "description: deck generator\n",
                "---\n",
                "body\n"
            )
        );
    }

    #[test]
    fn merge_appends_missing_non_key_field() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("extra".to_string(), "x".to_string());
        let input = "---\nkey: abc123\ntags: [a]\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: abc123\ntags: [a]\nextra: x\n---\nbody\n");
    }

    #[test]
    fn merge_prepends_key_and_appends_others_together() {
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        overrides.insert("extra".to_string(), "y".to_string());
        let input = "---\ntags: [a]\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: abc123\ntags: [a]\nextra: y\n---\nbody\n");
    }

    // ============== merge_frontmatter: edge cases ==============

    #[test]
    fn merge_replaces_duplicate_key_lines_too() {
        // 同一字段名出现两次: 都替换 (YAML 语义上重复 key 是非法的,
        // 工具做防御性替换避免用户 frontmatter 包含重复行时丢改)。
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "newid1".to_string());
        let input = "---\nkey: oldid9\nother: x\nkey: anotherold\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: newid1\nother: x\nkey: newid1\n---\nbody\n");
    }

    #[test]
    fn merge_empty_overrides_returns_content_unchanged() {
        let overrides: MergeOverrides = MergeOverrides::new();
        let input = "---\nkey: abc123\n---\nbody\n";
        assert_eq!(merge_frontmatter(input, &overrides), input);
    }

    #[test]
    fn merge_preserves_value_with_quotes() {
        // 替换时按 YAML 标准不引号, 工具统一输出 `key: <value>` 无引号
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "abc123".to_string());
        let input = "---\nkey: \"old999\"\n---\nbody\n";
        let out = merge_frontmatter(input, &overrides);
        assert_eq!(out, "---\nkey: abc123\n---\nbody\n");
    }

    #[test]
    fn merge_value_in_yaml_alphanumeric_set_has_no_ambiguity() {
        // 验证 [0-9a-z] 字符集 + 无引号, YAML 解析与手写一致
        let mut overrides = MergeOverrides::new();
        overrides.insert("key".to_string(), "z9y8x7".to_string());
        let out = merge_frontmatter("---\n---\nx", &overrides);
        assert_eq!(out, "---\nkey: z9y8x7\n---\nx");
    }
}
