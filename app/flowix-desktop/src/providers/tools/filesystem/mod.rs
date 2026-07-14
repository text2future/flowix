mod constants;
mod edit;
mod frontmatter;
mod operations;
mod path;
mod schema;
mod search;

pub use schema::{delete_tool, edit_tool, glob_tool, grep_tool, ls_tool, read_tool, write_tool};

use crate::providers::tools::{ToolResult, ToolScope};

pub async fn execute_tool(
    tool_name: &str,
    arguments: &str,
    read_snapshot: Option<&str>,
    scope: &ToolScope,
) -> ToolResult {
    match tool_name {
        "read" => operations::read(arguments, scope).await,
        "write" => operations::write(arguments, scope).await,
        "delete" => operations::delete(arguments, scope).await,
        "edit" => edit::edit(arguments, read_snapshot, scope).await,
        "ls" => operations::ls(arguments, scope).await,
        "glob" => search::glob_paths(arguments, scope).await,
        "grep" => search::grep(arguments, scope).await,
        _ => ToolResult::error(format!("Unknown filesystem tool: {}", tool_name)),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use flowix_core::memo_file::extract_frontmatter_key;

    use super::edit::{edit, exact_match_boundary_error};
    use super::operations::{delete, ls, read, write};
    use super::path::glob_pattern_string;
    use super::search::glob_paths;
    use super::*;

    fn test_scope(root: PathBuf) -> ToolScope {
        ToolScope {
            allowed_roots: vec![root.clone()],
            _default_root: root,
            security_bookmarks: None,
        }
    }

    fn test_scope_many(roots: Vec<PathBuf>) -> ToolScope {
        ToolScope {
            _default_root: roots.first().cloned().unwrap_or_default(),
            allowed_roots: roots,
            security_bookmarks: None,
        }
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("flowix-{}-{}", name, suffix))
    }

    #[tokio::test]
    async fn read_line_zero_returns_parameter_error() {
        let root = unique_temp_dir("read-line-zero");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "first\nsecond\n").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "line": 0
        })
        .to_string();
        let result = read(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("line must be >= 1"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn read_missing_file_error_omits_default_notebook_hint() {
        let root = unique_temp_dir("read-missing-file");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("missing.md");

        let args = serde_json::json!({
            "path": path.display().to_string()
        })
        .to_string();
        let result = read(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        let message = result.error.unwrap_or_default();
        assert!(message.contains("Failed to read"));
        assert!(!message.contains("Default notebook is at"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn ls_outside_scope_error_omits_default_notebook_hint() {
        let root = unique_temp_dir("ls-scope-root");
        let outside = unique_temp_dir("ls-outside-scope");
        std::fs::create_dir_all(&root).expect("create root dir");
        std::fs::create_dir_all(&outside).expect("create outside dir");

        let args = serde_json::json!({
            "path": outside.display().to_string()
        })
        .to_string();
        let result = ls(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        let message = result.error.unwrap_or_default();
        assert!(message.contains("outside the registered notebook scope"));
        assert!(!message.contains("Hint:"));
        assert!(!message.contains("Default notebook"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn glob_relative_pattern_searches_all_allowed_roots() {
        let root_a = unique_temp_dir("glob-root-a");
        let root_b = unique_temp_dir("glob-root-b");
        std::fs::create_dir_all(root_a.join("nested")).expect("create root a");
        std::fs::create_dir_all(root_b.join("nested")).expect("create root b");
        std::fs::write(root_a.join("nested").join("a.md"), "# A\n").expect("write a");
        std::fs::write(root_b.join("nested").join("b.md"), "# B\n").expect("write b");

        let args = serde_json::json!({
            "pattern": "**/*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(
            &args,
            &test_scope_many(vec![root_a.clone(), root_b.clone()]),
        )
        .await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        let matches = data["matches"].as_array().expect("matches array");
        let match_text = matches
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(match_text.contains("a.md"), "matches: {match_text}");
        assert!(match_text.contains("b.md"), "matches: {match_text}");
        assert_eq!(data["pattern"].as_str(), Some("**/*.md"));
        assert_eq!(data["searched_roots"].as_array().unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }

    #[tokio::test]
    async fn glob_zero_matches_reports_not_found() {
        let root = unique_temp_dir("glob-zero");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("visible.md"), "# Visible\n").expect("write visible");

        let args = serde_json::json!({
            "pattern": "**/*.missing",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(false));
        assert_eq!(data["match_count"].as_u64(), Some(0));
        assert_eq!(data["displayed_count"].as_u64(), Some(0));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        assert!(data["matches"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_chinese_pattern_with_recursive_prefix_matches() {
        let root = unique_temp_dir("glob-chinese");
        std::fs::create_dir_all(root.join("资料")).expect("create root");
        std::fs::write(root.join("资料").join("测试文档.md"), "# 中文\n").expect("write chinese");

        let args = serde_json::json!({
            "pattern": "**/测试文档.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("测试文档.md"), "match: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_chinese_pattern_without_recursive_prefix_matches() {
        let root = unique_temp_dir("glob-chinese-flat");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("创新药研究.md"), "# 中文\n").expect("write chinese");

        let args = serde_json::json!({
            "pattern": "创新药*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("创新药研究.md"), "match: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_dot_slash_pattern_outputs_canonical_paths() {
        let root = unique_temp_dir("glob-dot-slash");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("note.md"), "# Note\n").expect("write note");

        let args = serde_json::json!({
            "pattern": "./*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        let first = data["matches"][0].as_str().expect("first match");
        let first_pattern = data["patterns"][0].as_str().expect("first pattern");
        assert!(
            !first_pattern.contains("\\.\\"),
            "pattern should be normalized: {first_pattern}"
        );
        assert!(
            !first_pattern.contains("/./"),
            "pattern should be normalized: {first_pattern}"
        );
        assert!(
            !first.contains("\\.\\"),
            "match should be canonical: {first}"
        );
        assert!(!first.contains("/./"), "match should be canonical: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_expands_brace_alternatives() {
        let root = unique_temp_dir("glob-brace");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("innovative-drug-one.md"), "# One\n").expect("write one");
        std::fs::write(root.join("workflow-sop.md"), "# Sop\n").expect("write sop");

        let args = serde_json::json!({
            "pattern": "{innovative-drug-*.md,*-sop.md}",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(2));
        assert_eq!(data["patterns"].as_array().unwrap().len(), 2);
        let matches = data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches.contains("innovative-drug-one.md"));
        assert!(matches.contains("workflow-sop.md"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_expands_absolute_brace_alternatives() {
        let root = unique_temp_dir("glob-absolute-brace");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("innovative-drug-one.md"), "# One\n").expect("write one");
        std::fs::write(root.join("workflow-sop.md"), "# Sop\n").expect("write sop");

        let pattern = format!(
            "{}/{{innovative-drug-*.md,*-sop.md}}",
            glob_pattern_string(root.clone())
        );
        let args = serde_json::json!({
            "pattern": pattern,
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(2));
        assert_eq!(data["patterns"].as_array().unwrap().len(), 2);
        assert!(data["searched_roots"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_absolute_pattern_scans_only_matching_root() {
        let root_a = unique_temp_dir("glob-absolute-root-a");
        let root_b = unique_temp_dir("glob-absolute-root-b");
        std::fs::create_dir_all(&root_a).expect("create root a");
        std::fs::create_dir_all(&root_b).expect("create root b");
        std::fs::write(root_a.join("target.md"), "# Target\n").expect("write target");
        std::fs::write(root_b.join("unrelated.md"), "# Unrelated\n").expect("write unrelated");

        let args = serde_json::json!({
            "pattern": glob_pattern_string(root_a.join("*.md")),
            "limit": 10
        })
        .to_string();
        let result = glob_paths(
            &args,
            &test_scope_many(vec![root_a.clone(), root_b.clone()]),
        )
        .await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["match_count"].as_u64(), Some(1));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("target.md"));
        assert!(!first.contains("unrelated.md"));
        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }

    #[tokio::test]
    async fn glob_prunes_heavy_and_hidden_directories() {
        let root = unique_temp_dir("glob-pruned-dirs");
        std::fs::create_dir_all(root.join("node_modules").join("pkg"))
            .expect("create node_modules");
        std::fs::create_dir_all(root.join(".metadata")).expect("create metadata");
        std::fs::write(root.join("visible.md"), "# Visible\n").expect("write visible");
        std::fs::write(
            root.join("node_modules").join("pkg").join("hidden.md"),
            "# Hidden\n",
        )
        .expect("write node_modules file");
        std::fs::write(root.join(".metadata").join("index.md"), "# Index\n")
            .expect("write metadata file");

        let args = serde_json::json!({
            "pattern": "**/*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["match_count"].as_u64(), Some(1));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        let matches = data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches.contains("visible.md"));
        assert!(!matches.contains("node_modules"));
        assert!(!matches.contains(".metadata"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_new_markdown_without_frontmatter_returns_null_key() {
        let root = unique_temp_dir("write-new-null-key");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Title\nbody\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert!(data["key"].is_null());
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(content, "# Title\nbody\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_existing_markdown_preserves_frontmatter_when_content_omits_it() {
        let root = unique_temp_dir("write-preserve-frontmatter");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(
            &path,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Old\nold body\n",
        )
        .expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Replacement\nnew body\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("abcdefgh"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            content,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Replacement\nnew body\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_existing_markdown_uses_new_body_but_preserves_original_frontmatter() {
        let root = unique_temp_dir("write-preserve-frontmatter-with-input-fm");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "---\nkey: abcdefgh\ntags: [old]\n---\n# Old\n")
            .expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "---\nkey: zzzzzzzz\ntags: [new]\n---\n# Replacement\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("abcdefgh"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            content,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Replacement\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_returns_key_from_delayed_disk_reread() {
        let root = unique_temp_dir("write-reread-key");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let path_for_update = path.clone();

        let delayed_update = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tokio::fs::write(&path_for_update, "---\nkey: zzzzzzzz\n---\n# Replacement\n")
                .await
                .expect("simulate watcher key rewrite");
        });

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Replacement\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;
        delayed_update.await.expect("delayed update task");

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("zzzzzzzz"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            extract_frontmatter_key(&content).as_deref(),
            Some("zzzzzzzz")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_append_inserts_newline_separator_when_needed() {
        let root = unique_temp_dir("write-append-separator");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "first paragraph").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "second paragraph",
            "append": true
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "append should succeed: {:?}", result);
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            "first paragraph\nsecond paragraph"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_removes_visible_file() {
        let root = unique_temp_dir("delete-file");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "content").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string()
        })
        .to_string();
        let result = delete(&args, &test_scope(root.clone())).await;

        assert!(result.success, "delete should succeed: {:?}", result);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_rejects_directories() {
        let root = unique_temp_dir("delete-dir");
        let dir = root.join("nested");
        std::fs::create_dir_all(&dir).expect("create dir");

        let args = serde_json::json!({
            "path": dir.display().to_string()
        })
        .to_string();
        let result = delete(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert!(dir.exists());
        assert!(result
            .error
            .unwrap_or_default()
            .contains("delete only supports files"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_dry_run_does_not_write_file() {
        let root = unique_temp_dir("edit-dry-run");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nhello world\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "hello world",
            "new_string": "hello flowix",
            "dry_run": true
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(result.success, "dry-run edit should succeed: {:?}", result);
        let data = result.data.expect("dry-run data");
        assert_eq!(data["dry_run"].as_bool(), Some(true));
        assert_eq!(data["would_write"].as_bool(), Some(true));
        assert_eq!(data["wrote"].as_bool(), Some(false));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_fuzzy_requires_explicit_apply_to_write() {
        let root = unique_temp_dir("edit-fuzzy");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nalpha beta gamma\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "alpha beta gamma",
            "new_string": "alpha beta delta",
            "fuzzy": true
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(
            result.success,
            "fuzzy candidate should succeed: {:?}",
            result
        );
        let data = result.data.expect("fuzzy data");
        assert_eq!(data["match_type"].as_str(), Some("exact_candidate"));
        assert_eq!(data["can_apply"].as_bool(), Some(true));
        assert_eq!(data["wrote"].as_bool(), Some(false));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_rejects_missing_trailing_punctuation_by_default() {
        let root = unique_temp_dir("edit-trailing-punctuation");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nTarget text. Next\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "Target text",
            "new_string": "Replacement"
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(!result.success, "missing punctuation must be rejected");
        let message = result.error.unwrap_or_default();
        assert!(message.contains("match_type=fuzzy_trailing"));
        assert!(message.contains("Possible cause: trailing punctuation differs"));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exact_match_rejects_missing_trailing_punctuation() {
        let content = "目标文本。后续";
        let matched = "目标文本";
        let error = exact_match_boundary_error(content, matched, 0)
            .expect("missing trailing punctuation must be rejected");

        assert!(!error.success);
        let message = error.error.unwrap_or_default();
        assert!(message.contains("match_type=fuzzy_trailing"));
        assert!(message.contains("Possible cause: trailing punctuation differs"));
    }

    #[test]
    fn exact_match_allows_whitespace_boundary() {
        let content = "目标文本 后续";
        let matched = "目标文本";
        assert!(exact_match_boundary_error(content, matched, 0).is_none());
    }
}
