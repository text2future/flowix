use super::*;

#[test]
fn title_from_first_heading() {
    let (t, p) = extract_title_and_preview("# Hello\nworld\n");
    assert_eq!(t, "Hello");
    assert_eq!(p, "Hello");
}

#[test]
fn preview_truncates_to_200_chars() {
    let body: String = "x".repeat(500);
    let (_, p) = extract_title_and_preview(&body);
    assert_eq!(p.chars().count(), 200);
}

#[test]
fn html_comments_are_removed_before_title_and_preview_extraction() {
    for (content, expected) in [
        ("<!-- hidden -->\nVisible text", "Visible text"),
        ("<!-- hidden\nmetadata\n-->\nVisible text", "Visible text"),
        ("Before <!-- hidden -->after", "Before after"),
        (
            "<!-- first --><!-- second -->\nVisible text",
            "Visible text",
        ),
        ("&lt;!-- hidden --&gt;\nVisible text", "Visible text"),
        ("&lt;!— hidden —&gt;\nVisible text", "Visible text"),
        ("<!— hidden —>\nVisible text", "Visible text"),
        ("<!-- hidden only -->", ""),
        ("<!-- unfinished\nhidden metadata", ""),
    ] {
        let (title, preview) = extract_title_and_preview(content);
        assert_eq!(title, expected, "content: {content}");
        assert_eq!(preview, expected, "content: {content}");
    }
}

#[test]
fn indexed_preview_excludes_html_comment_metadata() {
    let fields = derive_note_fields(
        "---\ndesc: Example\n---\n<!-- flowix:agent-thread-card {\n\"version\":1\n} -->\nVisible text",
    );
    assert_eq!(fields.preview, "Visible text");
}

#[test]
fn tag_only_lines_are_skipped_for_title_and_preview() {
    let md = "\
#project/backend
# Real title
#gettingstarted/quickstart/榜单如何上榜
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn preview_uses_first_line_after_inline_tag_cleaning() {
    let md = "\
# Real title
before #project/backend after #release
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn preview_uses_first_line_and_title_hashes_are_preserved() {
    let md = "\
# Real title
Use C# and # heading marker
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// `::agent-thread-card{...}` 作为单行节点出现在 body 顶部时, 不应
/// 占用第一条有效正文行 (title / preview)。
#[test]
fn agent_thread_card_single_line_is_skipped_for_title_and_preview() {
    let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" agentType=\"deepseek-harness\" collapsed=\"false\"}
# Real title
real preview line
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn agent_thread_card_refs_are_extracted_from_body() {
    let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI &amp; Helper\" agentType=\"deepseek-harness\" collapsed=\"false\"}
::agent-thread-card{threadId=\"abc\" title=\"Duplicate\" agentType=\"deepseek-harness\" collapsed=\"true\"}
::agent-thread-card{threadId=\"\" title=\"Draft\" agentType=\"deepseek-harness\" collapsed=\"false\"}
";
    let agents = extract_agent_threads_from_body(md);
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].thread_id, "abc");
    assert_eq!(agents[0].title, "AI & Helper");
    assert_eq!(agents[0].agent_type, "deepseek-harness");
}

/// 围栏形态 `:::agent-thread-card ... :::` 同样要在 title / preview 之前
/// 整段剥离 ── 围栏里夹的多行文本不能作为第一条有效正文行。
#[test]
fn agent_thread_card_fenced_block_is_skipped_for_title_and_preview() {
    let md = "\
:::agent-thread-card
some internal line
:::
# Real title
real preview line
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// 围栏允许行首缩进 (A 项: 防御 list / blockquote 嵌套场景) ──
/// 开闭 marker 前置 [ \t]* 必须命中。
#[test]
fn fenced_agent_thread_card_with_leading_indent_is_stripped() {
    let md = "\
    :::agent-thread-card
    internal line
    :::
# Real title
real preview line
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// 多段围栏紧邻出现时也都要剥离 ── 不能只剥第一段。
#[test]
fn adjacent_fenced_agent_thread_cards_are_all_stripped() {
    let md = "\
:::agent-thread-card
foo
:::
:::agent-thread-card
bar
:::
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// 缩进的单行节点 (复制粘贴常见) ── 行级剔除应基于 trim 后整行,
/// 不应被前置空白漏掉。
#[test]
fn indented_single_line_agent_thread_card_is_stripped() {
    let md = "\
    ::agent-thread-card{threadId=\"x\" title=\"t\" agentType=\"deepseek-harness\" collapsed=\"false\"}
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// 多张节点堆叠时也都要剥离 ── 不能只剥第一张。
#[test]
fn stacked_agent_thread_cards_are_all_stripped() {
    let md = "\
::agent-thread-card{threadId=\"a\" title=\"A\" agentType=\"deepseek-harness\" collapsed=\"false\"}
::agent-thread-card{threadId=\"b\" title=\"B\" agentType=\"deepseek-harness\" collapsed=\"false\"}
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

/// 纯节点文档 (没有任何用户文本) 派生出的 title / preview 都应为空 ──
/// 不应把节点 attribute 串当作 title 写进 memo index。
#[test]
fn card_only_document_yields_empty_title_and_preview() {
    let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" agentType=\"deepseek-harness\" collapsed=\"false\"}
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "");
    assert_eq!(p, "");
}

#[test]
fn markdown_table_at_top_is_skipped_for_title_and_preview() {
    let md = "\
| Name | Value |
| --- | --- |
| A | 1 |
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn markdown_table_after_title_does_not_change_preview() {
    let md = "\
# Real title
| Name | Value |
| :--- | ---: |
| A | 1 |
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn pipe_text_without_table_delimiter_is_not_stripped() {
    let md = "\
# Real title
left | right
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn note_reference_line_is_skipped_for_title_and_preview() {
    let md = "\
<note id=\"abc\" notebook=\"nb\" path=\"/tmp/a.md\" stale=\"true\">Notebook/A</note>
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn inline_note_reference_is_removed_but_surrounding_text_remains() {
    let md = "\
# Real title
prefix <note id=\"abc\" notebook=\"nb\" path=\"/tmp/a.md\">Notebook/A</note> suffix
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn fenced_code_block_is_skipped_for_title_and_preview() {
    let md = "\
```ts
const title = 'not title';
```
# Real title
real preview
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn attachment_and_image_links_are_removed_for_title_and_preview() {
    let md = "\
[file.pdf](asset://localhost/file.pdf)
# Real title
preview ![shot](asset://localhost/shot.png) tail [doc](asset://localhost/doc.pdf)
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn markdown_image_size_attrs_are_removed_for_title_and_preview() {
    let md = "\
# Real title
preview ![image.png](asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5Cimage_3.png){width=34%} tail
";
    let (t, p) = extract_title_and_preview(md);
    assert_eq!(t, "Real title");
    assert_eq!(p, "Real title");
}

#[test]
fn thumbnail_uses_first_markdown_image() {
    let md = "\
# Real title
![cover](asset://localhost/C%3A%5Ccover.png){width=34%}
![second](https://example.com/second.png)
";
    assert_eq!(
        extract_thumbnail(md),
        Some("asset://localhost/C%3A%5Ccover.png".to_string())
    );
}

#[test]
fn thumbnail_ignores_images_inside_fenced_code() {
    let md = "\
```md
![skip](https://example.com/skip.png)
```
# Real title
![cover](https://example.com/cover.png)
";
    assert_eq!(
        extract_thumbnail(md),
        Some("https://example.com/cover.png".to_string())
    );
}

#[test]
fn tags_dedup_and_trim() {
    let v = extract_tags_from_body("#a #b #a");
    assert_eq!(v, vec!["a".to_string(), "b".to_string()]);
}

/// 围栏代码块内的 `#tag` 不应被提取 — 块内是代码示例, 不是用户标签。
/// 块外紧邻的 `#tag` 仍要正确提取。`after` 不带 `-` 是因为原 TAG_RE
/// 不允许 `[\s[:punct:]]+`, 这里聚焦在"代码区域剔除"契约。
#[test]
fn tags_inside_fenced_code_block_are_excluded() {
    let md = r"#outer

```
#inside-block
```
#after
";
    assert_eq!(
        extract_tags_from_body(md),
        vec!["outer".to_string(), "after".to_string()]
    );
}

/// 围栏可使用 3 个以上反引号 — 必须能匹配任意长度的 opening fence,
/// 然后用同等长度的 closing fence 闭合 (CommonMark 规范)。
#[test]
fn tags_inside_quadruple_backtick_fence_are_excluded() {
    let md = r"#outer

````python
#inside-quad-fence
````
#after
";
    assert_eq!(
        extract_tags_from_body(md),
        vec!["outer".to_string(), "after".to_string()]
    );
}

/// 行内反引号代码内的 `#tag` 不应被提取 — 用户视角是"代码"而非"标签"。
/// 即使前缀是空白也不应触发 (regex `[\s]` 会把空白作为前置, 但代码内的
/// `#` 不应被读作 tag 起始)。
#[test]
fn tags_inside_inline_code_span_are_excluded() {
    let md = "see `#not-a-tag` here #real";
    assert_eq!(extract_tags_from_body(md), vec!["real".to_string()]);
}

/// 围栏内含多个 `#tag` 行 / 行内 code 含多个 `#tag` 都不应被提取。
/// 注意: TAG_RE 的 `[^\s[:punct:]]+` 不允许 `-`, 所以源里用纯字母
/// 命名以让测试聚焦在"代码区域剔除"这一行为契约上。
#[test]
fn tags_mixed_block_and_inline_code_excluded() {
    let md = r"#keep
```
#skip-1
#skip-2
```
use `#skip-3` and `#skip-4`
#keep2
";
    assert_eq!(
        extract_tags_from_body(md),
        vec!["keep".to_string(), "keep2".to_string()]
    );
}

// ============== 路径式 tag (Step 1) ==============

/// 基础路径式 tag: 整段 `旅行/泰国/曼谷` 应作为一条 tag 提取,
/// 不是三条独立 tag。
#[test]
fn tag_with_slash_path_is_one_entry() {
    let v = extract_tags_from_body("#旅行/泰国/曼谷");
    assert_eq!(v, vec!["旅行/泰国/曼谷".to_string()]);
}

/// 不同前缀路径视为不同 tag — `#旅行/泰国/曼谷` / `#泰国/曼谷` /
/// `#曼谷` 三者独立出现在结果中, 各占一条, 不被前缀化简合并。
#[test]
fn different_prefixes_are_distinct_tags() {
    let v = extract_tags_from_body("#旅行/泰国/曼谷 #泰国/曼谷 #曼谷");
    assert_eq!(
        v,
        vec![
            "旅行/泰国/曼谷".to_string(),
            "泰国/曼谷".to_string(),
            "曼谷".to_string(),
        ]
    );
}

/// 同一 memo 内出现多次相同路径视为一条 (按字符串去重, 跟扁平语义一致)。
#[test]
fn duplicate_path_dedup_within_memo() {
    let v = extract_tags_from_body("#旅行/泰国 #旅行/泰国 #旅行/泰国/曼谷");
    assert_eq!(
        v,
        vec!["旅行/泰国".to_string(), "旅行/泰国/曼谷".to_string()]
    );
}

/// 末尾 `/` 触发 regex 回溯 — 捕获去掉末尾 `/` 的部分, 末尾 `/`
/// 留在 body 变孤儿 (宽容解析, 配合 mid-edit 场景)。
#[test]
fn trailing_slash_is_trimmed_via_backtracking() {
    let v = extract_tags_from_body("#旅行/泰国/曼谷/");
    assert_eq!(v, vec!["旅行/泰国/曼谷".to_string()]);
}

/// 首字符 `/` — regex 字符类直接 reject, 整条不识别。
#[test]
fn leading_slash_yields_no_match() {
    let v = extract_tags_from_body("#/旅行/泰国");
    assert!(v.is_empty(), "leading / 整条应被拒绝, 实际: {v:?}");
}

/// `#a//b` 在 regex 层级捕获 `a` — 跟旧 regex 行为一致 (旧 regex 在
/// 第一个 `/` 处停, 新 regex 通过 `(?:level/)*level` 的回溯同样
/// 落到 `a`)。剩余 `//b` 留在 body 当孤儿。整段 `//` 不被 normalize
/// 拒绝 (捕获段是 `a`, 自身不含 `//`)。
///
/// 这与 trailing `/` (`#旅行/泰国/曼谷/` → `旅行/泰国/曼谷`) 同性质
/// ── 末段尾部多余的 `/` 触发回溯, 留下半个孤儿。属于宽容解析。
#[test]
fn double_slash_extracts_prefix_only() {
    let v = extract_tags_from_body("#a//b");
    assert_eq!(v, vec!["a".to_string()]);
}

/// 标点终止路径: `#a/b.c` 在 `.` 处结束, 捕获 `a/b`。
#[test]
fn punctuation_terminates_path() {
    let v = extract_tags_from_body("#a/b.c 后文");
    assert_eq!(v, vec!["a/b".to_string()]);
}

#[test]
fn hyphen_and_underscore_are_valid_inside_tag_segments() {
    let v = extract_tags_from_body("#Long-Term-Task #General-Features/Nav_Bar");
    assert_eq!(
        v,
        vec![
            "Long-Term-Task".to_string(),
            "General-Features/Nav_Bar".to_string(),
        ]
    );
}

/// 跨多段路径 + 行首 + 行内, 验证多种 anchor 形式都能匹配。
#[test]
fn path_tags_anchor_at_line_start_and_inline() {
    let v = extract_tags_from_body("正文 #旅行/泰国/曼谷\n#亚洲/曼谷\n");
    assert_eq!(
        v,
        vec!["旅行/泰国/曼谷".to_string(), "亚洲/曼谷".to_string()]
    );
}

/// 路径式 tag 在围栏代码块内仍被剔除 (Step 1 不破坏既有契约)。
#[test]
fn path_tag_inside_fenced_code_is_excluded() {
    let md = r"#a/b
```
#skip/inside
```
#c/d
";
    assert_eq!(
        extract_tags_from_body(md),
        vec!["a/b".to_string(), "c/d".to_string()]
    );
}

/// 行内反引号内的路径式 tag 仍被剔除 (跟 `#a` 行为一致)。
#[test]
fn path_tag_inside_inline_code_is_excluded() {
    let md = "见 `#not/a/tag` 一下 #real/b";
    assert_eq!(extract_tags_from_body(md), vec!["real/b".to_string()]);
}

/// `normalize_tag_path` 直接单测: 不经 regex 也能识别合法 / 非法。
#[test]
fn normalize_tag_path_unit() {
    // 合法
    assert_eq!(normalize_tag_path("a"), Some("a".to_string()));
    assert_eq!(normalize_tag_path("a/b"), Some("a/b".to_string()));
    assert_eq!(normalize_tag_path("a/b/c"), Some("a/b/c".to_string()));
    assert_eq!(
        normalize_tag_path("Long-Term-Task"),
        Some("Long-Term-Task".to_string())
    );
    assert_eq!(
        normalize_tag_path("General-Features/Nav_Bar"),
        Some("General-Features/Nav_Bar".to_string())
    );
    assert_eq!(
        normalize_tag_path("旅行/泰国/曼谷"),
        Some("旅行/泰国/曼谷".to_string())
    );
    // 非法
    assert_eq!(normalize_tag_path(""), None);
    assert_eq!(normalize_tag_path("  "), None);
    assert_eq!(normalize_tag_path("a//b"), None);
    assert_eq!(normalize_tag_path("/a"), None);
    assert_eq!(normalize_tag_path("a/"), None);
    assert_eq!(normalize_tag_path("/"), None);
    assert_eq!(normalize_tag_path("---"), None);
    assert_eq!(normalize_tag_path("___"), None);
}

#[test]
fn normalize_search_tag_filter_accepts_optional_hash() {
    assert_eq!(
        normalize_search_tag_filter(" #项目/Flowix "),
        Some("项目/Flowix".to_string())
    );
    assert_eq!(normalize_search_tag_filter("#"), None);
    assert_eq!(normalize_search_tag_filter("项目//Flowix"), None);
}

/// 路径式 tag 复用生产代码的围栏与行内代码预处理, NUL 占位不影响。
/// 围栏外紧邻的 `#a/b` 仍正确提取, 不被前一行围栏内的 orphan
/// `//#c` 串错位。
#[test]
fn path_tag_after_fence_still_extracts() {
    let md = "#a/b\n```\n#inside/x/y\n```\n#c/d\n";
    assert_eq!(
        extract_tags_from_body(md),
        vec!["a/b".to_string(), "c/d".to_string()]
    );
}

#[test]
fn todos_parse_checked_and_unchecked() {
    let v = extract_todos_from_body("- [ ] one\n- [x] two\n");
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].status, "pending");
    assert_eq!(v[1].status, "completed");
}

#[test]
fn todos_ignore_fenced_examples_and_strip_legacy_identity_comments() {
    let markdown = "- [ ] keep <!-- flowix-todo-id:legacy_1 -->\n```md\n- [ ] example\n```\n* [x] done\n+ [ ] also keep\n";
    let todos = extract_todos_from_body(markdown);
    assert_eq!(todos.len(), 3);
    assert_eq!(todos[0].content, "keep");
    assert_eq!(todos[0].status, "pending");
    assert_eq!(todos[1].content, "done");
    assert_eq!(todos[1].status, "completed");
    assert_eq!(todos[2].content, "also keep");
}

// ============== HTML 实体解码 (title / preview 派生) ==============

/// 行内 `&nbsp;` 不应作为实体字符串泄漏到 title ── 应被解码成 NBSP 后由
/// 末尾 `.trim()` / `\s+` 折叠掉。
#[test]
fn inline_nbsp_entity_is_decoded_and_trimmed() {
    let (t, p) = extract_title_and_preview("&nbsp;Hello\n&nbsp;World\n");
    assert_eq!(t, "Hello");
    assert_eq!(p, "Hello");
}

/// 行首 `&nbsp;` + 字面内容: NBSP 解码后被 `.trim()` 吃掉; 但**不会**
/// 进一步吃掉后面的 `#` ── `strip_markdown` 的 markdown 前缀剥离在实体解码
/// 之后跑, 此时 NBSP 已吞掉, `#` 不再处于首位, 视为字面字符保留。
#[test]
fn leading_nbsp_entity_is_trimmed_from_title() {
    let (t, _) = extract_title_and_preview("&nbsp;Real title\nbody\n");
    assert_eq!(t, "Real title");
}

/// 行内 NBSP 折叠为单空格: `A&nbsp;B` → `A B`。
#[test]
fn inline_nbsp_acts_as_separator() {
    let (t, _) = extract_title_and_preview("A&nbsp;B&nbsp;C\nbody\n");
    assert_eq!(t, "A B C");
}

/// 十六进制形式 `&#xa0;` 同样能解码为 NBSP。
#[test]
fn hex_nbsp_entity_is_decoded() {
    let (t, _) = extract_title_and_preview("&#xa0;Hello\nbody\n");
    assert_eq!(t, "Hello");
}

/// `&amp;` 解码为 `&`, 不再以实体字符串残留。
#[test]
fn amp_entity_is_decoded() {
    let (t, _) = extract_title_and_preview("A &amp; B\nbody\n");
    assert_eq!(t, "A & B");
}

/// `&lt;` / `&gt;` 解码为 `<` / `>`。
#[test]
fn lt_gt_entities_are_decoded() {
    let (t, _) = extract_title_and_preview("&lt;tag&gt;\nbody\n");
    assert_eq!(t, "<tag>");
}

/// `&quot;` / `&#34;` 解码为 `"`。
#[test]
fn quot_entity_is_decoded() {
    let (t, _) = extract_title_and_preview("say &quot;hi&quot;\nbody\n");
    assert_eq!(t, "say \"hi\"");
    let (t2, _) = extract_title_and_preview("say &#34;hi&#34;\nbody\n");
    assert_eq!(t2, "say \"hi\"");
}

/// 未知 / 畸形实体原样保留, 不抛错也不吃字符。
#[test]
fn unknown_entity_is_left_as_is() {
    let (t, _) = extract_title_and_preview("foo &unknown; bar\nbody\n");
    assert_eq!(t, "foo &unknown; bar");
    // 缺分号也原样保留
    let (t2, _) = extract_title_and_preview("foo &amp bar\nbody\n");
    assert_eq!(t2, "foo &amp bar");
}

/// HTML 实体解码不应对 markdown 装饰字符产生误判 ── `*` / `_` 仍按原
/// 逻辑被剥除。
#[test]
fn entity_decode_does_not_break_markdown_stripping() {
    let (t, _) = extract_title_and_preview("**bold &amp; italic**\nbody\n");
    assert_eq!(t, "bold & italic");
}

// ============== extract_title_and_preview 短路语义 ==============

/// 验证 preview 只使用第一条有效正文行 ── 后续内容不会改变展示结果。
#[test]
fn title_and_preview_use_first_non_empty_line() {
    let mut lines: Vec<String> = vec!["# Title".to_string()];
    for i in 0..200 {
        lines.push(format!("body line {i}"));
    }
    let input = lines.join("\n");
    let (t, p) = extract_title_and_preview(&input);
    assert_eq!(t, "Title");
    assert_eq!(p, "Title");
}

// ============== 边界 / 兜底行为 ==============

/// `&#0;` 不应解码为 NUL 控制字符泄漏到 title ── HTML5 规范里 `&#0;`
/// 渲染为空, 我们让整个实体原样保留以保持用户语义可读。
#[test]
fn numeric_null_entity_is_not_decoded_to_nul_char() {
    let (t, _) = extract_title_and_preview("&#0;Hello\nbody\n");
    assert_eq!(t, "&#0;Hello");
    assert!(!t.contains('\0'));
}

/// `is_blank_line` 对所有空白类 HTML 实体 (命名 + 数字 + 十六进制) 都应
/// 识别为 blank, 同时对夹杂内容的行仍正确判定为非 blank。
#[test]
fn is_blank_line_recognizes_all_whitespace_entities() {
    // 命名实体
    for entity in [
        "&nbsp;",
        "&ensp;",
        "&emsp;",
        "&thinsp;",
        "&hairsp;",
        "&numsp;",
        "&puncsp;",
        "&mediumsp;",
        "&idsp;",
    ] {
        assert!(
            is_blank_line(entity),
            "named entity {entity} should be blank"
        );
    }
    // 数字 / 十六进制实体 ── 验证 `decode_html_entities` 数字路径也对空白类生效
    for entity in [
        "&#160;", "&#xa0;", "&#xA0;", "&#8194;", "&#x2002;", // EN SPACE
        "&#8201;", "&#x2009;", // THIN SPACE
        "&#12288;", "&#x3000;", // IDEOGRAPHIC SPACE
    ] {
        assert!(
            is_blank_line(entity),
            "numeric entity {entity} should be blank"
        );
    }
    // 字面 NBSP 字符
    assert!(is_blank_line("\u{00A0}"));
    // 夹杂内容 → 非 blank
    assert!(!is_blank_line("&ensp;Hello"));
    assert!(!is_blank_line("A&emsp;B"));
    assert!(!is_blank_line("&#160;x"));
    assert!(!is_blank_line("A &amp; B"));
}

// ============== 其他空白类 HTML 实体 ==============

/// `&ensp;` / `&emsp;` / `&thinsp;` / `&hairsp;` / `&numsp;` / `&puncsp;` /
/// `&mediumsp;` / `&idsp;` ── 所有 Unicode Zs (Separator, Space) 命名实体
/// 都应被解码并被 `str::trim` + `\s+` 折叠为单空格, 不应作为可见字符
/// 残留在 title / preview 中。
#[test]
fn other_whitespace_entities_decode_and_collapse() {
    for (entity, label) in [
        ("&ensp;", "EN SPACE"),
        ("&emsp;", "EM SPACE"),
        ("&thinsp;", "THIN SPACE"),
        ("&hairsp;", "HAIR SPACE"),
        ("&numsp;", "FIGURE SPACE"),
        ("&puncsp;", "PUNCTUATION SPACE"),
        ("&mediumsp;", "MEDIUM MATHEMATICAL SPACE"),
        ("&idsp;", "IDEOGRAPHIC SPACE"),
    ] {
        let md = format!("{entity}Hello\nbody\n");
        let (t, p) = extract_title_and_preview(&md);
        assert_eq!(t, "Hello", "entity {entity} ({label}) leaked into title");
        assert_eq!(p, "Hello");
    }
}

/// 行内混合多种空白实体 ── 全部折叠为单空格, 不出现连续多个空格。
#[test]
fn mixed_whitespace_entities_collapse_to_single_spaces() {
    let (t, _) = extract_title_and_preview("A&ensp;B&emsp;C&nbsp;D&thinsp;E\nbody\n");
    assert_eq!(t, "A B C D E");
}

/// 整行是任意空白类实体 ── 应被 `is_blank_line` 或下游 `is_empty` 过滤。
/// 覆盖命名实体 (`&nbsp;` 等 9 种) + 数字实体 (`&#160;` 等 4 种) 两条路径,
/// 验证 `is_blank_line` 解码 + `strip_markdown` 解码对空白类实体都生效。
#[test]
fn whole_line_whitespace_entity_is_blank() {
    for entity in [
        // 命名实体 ── 互不为前缀, 顺序无关
        "&nbsp;",
        "&ensp;",
        "&emsp;",
        "&thinsp;",
        "&hairsp;",
        "&numsp;",
        "&puncsp;",
        "&mediumsp;",
        "&idsp;",
        // 数字实体 ── 验证 `try_decode_entity` 数字路径也对空白类生效
        "&#160;",   // NBSP 十进制
        "&#xa0;",   // NBSP 十六进制
        "&#8199;",  // FIGURE SPACE 十进制
        "&#x2002;", // EN SPACE 十六进制
    ] {
        let md = format!("{entity}\n# Real title\nbody\n");
        let (t, p) = extract_title_and_preview(&md);
        assert_eq!(t, "Real title", "entity {entity} should be blank");
        assert_eq!(p, "Real title");
    }
}

/// todo content 含空白类 HTML 实体时不应被提取 ── 与 title/preview 的
/// 空白判定对齐。修复前 `is_blank_line` 不识别 `&#160;`, 会泄漏空白 todo。
#[test]
fn todos_skip_blank_content_with_whitespace_entities() {
    let v = extract_todos_from_body("- [ ] &nbsp;\n- [ ] &#160;\n- [x] real task\n");
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].content, "real task");
    assert_eq!(v[0].status, "completed");
}

/// todo content 里的实体解码 (与 title/preview 流水线对齐)。
#[test]
fn todos_decode_entities_in_content() {
    let v = extract_todos_from_body("- [ ] buy &amp; sell\n- [ ] A &lt; B\n");
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].content, "buy & sell");
    assert_eq!(v[1].content, "A < B");
}

/// agent thread card 的 `title="..."` 属性应解全部实体 (此前 `decode_markdown_attr`
/// 只解 `&amp;` / `&quot;`, 现委托 `decode_html_entities` 后覆盖全部)。
/// 注: `&nbsp;` 解码后保留为字面 NBSP ── agent thread title 不走 `strip_markdown`
/// 的空白折叠流水线, 这是与 title/preview 的有意差别 (前者保留原文结构)。
#[test]
fn agent_thread_card_attr_decodes_all_supported_entities() {
    let md = "::agent-thread-card{threadId=\"x\" title=\"&lt;AI&gt; &amp; Helper &nbsp; v2\" agentType=\"r\" collapsed=\"false\"}\n";
    let agents = extract_agent_threads_from_body(md);
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].title, "<AI> & Helper \u{00A0} v2");
}

#[test]
fn wiki_note_references_do_not_become_derived_titles_or_previews() {
    for reference in [
        "[[./target.md]]",
        "[[../资料/目标.md#标题|别名]]",
        "[[C:/Notes/target.md]]",
        r"[[\\server\share\target.md]]",
        "[[file://server/share/target.md]]",
    ] {
        let (title, preview) = extract_title_and_preview(&format!("{reference}\n实际正文"));
        assert_eq!(title, "实际正文", "{reference}");
        assert_eq!(preview, "实际正文", "{reference}");
    }
    assert_eq!(
        extract_title_and_preview("前文 [[./target.md]] 后文").1,
        "前文 后文"
    );
}
