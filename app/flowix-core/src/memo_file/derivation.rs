//! 派生字段提取 — `extract_tags_from_body` / `extract_todos_from_body` /
//! `extract_title_and_preview` / `apply_derived_memo_fields` / `strip_markdown` /
//! `is_blank_line` / `strip_block_node_lines`。
//!
//! 派生语义: memo 的 `filename` / `preview` / `tags` / `todos` 都可以从 .md body
//! 算出来, 写盘后由 [`apply_derived_memo_fields`] 同步回 index.json。这样 UI 列表
//! 不必每次都读 .md 文件 (大场景下 IO 减半), 同时保证"正文是真相, index.json 是
//! 派生缓存"。
//!
//! ## 块节点过滤档案 (`BLOCK_NODE_FILTERS`)
//!
//! Tiptap 自定义节点 (例如 `agent-thread-card`) 在 markdown 序列化时会产出一段
//! 非用户语义的元数据 (节点属性 / 围栏 marker), 不应进入 filename / preview 派生。
//! 所有需要在 title / preview 流水线里剔除的节点形态都登记在
//! [`BLOCK_NODE_FILTERS`] 这个**单点配置**里: filename (经
//! [`extract_title_and_preview`]) 和 preview 共用一次过滤, 加新节点时只动
//! 这一处。
//!
//! 节点可能出现的两种形态:
//! - **单行**: `::node-name{attrs}` (整行, 行 trim 后整行匹配即视为节点)
//! - **围栏**: `:::node-name ... :::` (跨行, 整段跳过)

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

use super::frontmatter::extract_body_content;
use super::types::{Memo, TodoItem};

/// 判定 markdown 行是否"语义空白" (空行 / 全空格 / HTML 实体 `&nbsp;` /
/// 不间断空格 U+00A0)。`is_blank_line` 用于过滤 title/preview/todo 提取前的源。
pub fn is_blank_line(line: &str) -> bool {
    line.replace("&nbsp;", "")
        .replace('\u{00a0}', "")
        .trim()
        .is_empty()
}

/// 去掉 markdown 装饰字符 (heading `#` / list `-*+` / quote `>` / checkbox `[ ]`
/// / link 包装 / 强调 `*_` / 反引号), 折叠连续空白为单空格, 留作 title 派生。
pub fn strip_markdown(text: &str) -> String {
    let mut value = text.trim().to_string();

    for prefix in ["#", "-", "*", "+", ">"] {
        while value.starts_with(prefix) {
            value = value[prefix.len()..].trim_start().to_string();
        }
    }

    for marker in ["[ ]", "[x]", "[X]"] {
        if value.starts_with(marker) {
            value = value[marker.len()..].trim_start().to_string();
        }
    }

    static NOTE_LINK_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?is)<note\b[^>]*>.*?</note>").unwrap());
    static MARKDOWN_IMAGE_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"!\[[^\]]*\]\([^)]+\)").unwrap());
    static MARKDOWN_LINK_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[[^\]]*\]\([^)]+\)").unwrap());
    static MARKDOWN_DECORATION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[*_`]").unwrap());
    static WHITESPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

    let value = NOTE_LINK_RE.replace_all(&value, "");
    let value = MARKDOWN_IMAGE_RE.replace_all(&value, "");
    let value = MARKDOWN_LINK_RE.replace_all(&value, "");
    let value = MARKDOWN_DECORATION_RE.replace_all(&value, "");
    WHITESPACE_RE.replace_all(value.trim(), " ").to_string()
}

// ---------------------------------------------------------------------------
// 块节点过滤档案
// ---------------------------------------------------------------------------

/// `::agent-thread-card{threadId="..." title="..." roleKey="..." collapsed="..."}`
/// ── 由 Tiptap `extensions/agent-thread-card.tsx` 的 `renderMarkdown` 序列化
/// 出来的单行节点形态。行 trim 后整行匹配视为"该行属于块节点, 派生时跳过"。
static AGENT_THREAD_CARD_LINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^::agent-thread-card(?:\{[^}]*\})?$").unwrap());

static TABLE_DELIMITER_CELL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^:?-{3,}:?$").unwrap());

/// `:::agent-thread-card ... :::` ── 围栏形态, 用于节点将来扩展出 body 时的
/// markdown 往返。命中整段 (跨多行) 一并跳过。
static AGENT_THREAD_CARD_FENCE_RE: Lazy<Regex> = Lazy::new(|| {
    // 围栏开闭允许行首缩进 ── 与单行形态的"trim 后整行匹配"保持对称, 未来
    // 节点出现在 list item / blockquote 等缩进上下文里也能被剥掉。
    Regex::new(r"(?m)^[ \t]*:::agent-thread-card[^\n]*\n[\s\S]*?\n[ \t]*:::[ \t]*$").unwrap()
});

/// 块节点过滤档案 ── 集中登记需要在 title / preview 派生前剔除的 Tiptap
/// 自定义节点序列化形态。filename 和 preview 都经由
/// [`extract_title_and_preview`], 因此**单点配置, 一处生效**。新节点只需要
/// 在此 push 一项 [`BlockNodeFilter`]。
struct BlockNodeFilter {
    /// 可读标识 (日志 / 调试用)。当前无 in-process 读取路径, 但保留以便
    /// 后续接入结构化日志 / 调试输出时不需要改 array 形态。
    #[allow(dead_code)]
    name: &'static str,
    /// 行级判定: 传入 trim 后的整行, 返回 `true` 表示该行属于此块节点, 跳过。
    is_block_line: fn(&str) -> bool,
    /// 围栏剥离: 若节点存在围栏形态, 给出"在文本中剥掉所有围栏实例"的函数;
    /// 不存在则传 `None`。
    strip_fences: Option<fn(&str) -> String>,
}

static BLOCK_NODE_FILTERS: &[BlockNodeFilter] = &[
    BlockNodeFilter {
        name: "agent-thread-card",
        is_block_line: |line| AGENT_THREAD_CARD_LINE_RE.is_match(line),
        strip_fences: Some(|input| {
            AGENT_THREAD_CARD_FENCE_RE
                .replace_all(input, "")
                .into_owned()
        }),
    },
    BlockNodeFilter {
        name: "markdown-table",
        is_block_line: |_| false,
        strip_fences: Some(strip_markdown_table_blocks),
    },
];

/// 在 title / preview 派生前剥离所有已登记的块节点 (围栏优先剥, 然后按行
/// 剔除单行形态)。返回的字符串已不含块节点元数据, 可直接交给原有的
/// "取首行 / 第二行" 逻辑。
///
/// **不变量 (改本函数时务必保持) ──**
///
/// 1. **围栏优先**: 围栏剥离在行级剔除之前完成, 反复 `replace_all` 到稳定。
///    这样围栏内残留的"看起来像单行节点"的字符串也不会被行级阶段误剥。
/// 2. **行级判定基于 trim 后整行**: 调用 `is_block_line` 前必须先 `trim()`,
///    以兼容复制粘贴 / 缩进场景。这与单行正则 `^...$` 的"整字符串匹配"
///    语义保持对称 (即 `<truncated-line-of-node>` 作为唯一内容)。
/// 3. **缩进容忍**: 围栏的开闭 marker (`:::`) 与单行节点 (`::name...`)
///    都允许 `[ \t]*` 前导空白 ── 节点出现在 list / blockquote 嵌套里也能
///    命中。这条与产品当前 Tiptap 序列化形态 (顶层无缩进) 一致, 但作为
///    防御性行为保留。
fn strip_block_node_lines(body: &str) -> String {
    // 1. 围栏剥离 ── 反复 replace 直到稳定, 处理相邻 / 多次出现的围栏块。
    let mut current = body.to_string();
    for filter in BLOCK_NODE_FILTERS {
        let Some(strip) = filter.strip_fences else {
            continue;
        };
        let mut prev = String::new();
        while prev != current {
            prev = current.clone();
            current = strip(&current);
        }
    }

    // 2. 行级剔除 ── trim 后整行命中任一过滤器即丢。
    let kept: Vec<&str> = current
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !BLOCK_NODE_FILTERS
                .iter()
                .any(|filter| (filter.is_block_line)(trimmed))
        })
        .collect();
    kept.join("\n")
}

fn strip_markdown_table_blocks(input: &str) -> String {
    let lines: Vec<&str> = input.lines().collect();
    let mut kept = Vec::with_capacity(lines.len());
    let mut index = 0;

    while index < lines.len() {
        if index + 1 < lines.len()
            && is_markdown_table_row(lines[index])
            && is_markdown_table_delimiter(lines[index + 1])
        {
            index += 2;

            while index < lines.len() && is_markdown_table_row(lines[index]) {
                index += 1;
            }

            continue;
        }

        kept.push(lines[index]);
        index += 1;
    }

    kept.join("\n")
}

fn is_markdown_table_row(line: &str) -> bool {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return false;
    }

    let pipe_count = trimmed.matches('|').count();
    pipe_count >= 2 || ((trimmed.starts_with('|') || trimmed.ends_with('|')) && pipe_count >= 1)
}

fn is_markdown_table_delimiter(line: &str) -> bool {
    if !is_markdown_table_row(line) {
        return false;
    }

    let cells: Vec<String> = line
        .trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().replace(' ', ""))
        .collect();

    !cells.is_empty()
        && cells
            .iter()
            .all(|cell| TABLE_DELIMITER_CELL_RE.is_match(cell))
}

/// 提取 (title, preview): title = 第一条非空行 (经 `strip_markdown` 清洗),
/// preview = 第二条非空行 (取前 200 字符)。
///
/// 两条规则之前先经过 [`strip_block_node_lines`] ── 任何已登记的 Tiptap 自定
/// 义节点 (`::agent-thread-card{...}` / `:::agent-thread-card ... :::`) 都不会
/// 占据首行或第二行, 也就不会泄漏到 `filename` (title) 或 `preview` 里。
pub fn extract_title_and_preview(content: &str) -> (String, String) {
    let body_without_code = strip_fenced_code_blocks(extract_body_content(content));
    let body = strip_block_node_lines(&body_without_code);
    let lines: Vec<String> = body
        .lines()
        .map(str::trim)
        .filter(|line| !is_blank_line(line))
        .map(strip_markdown)
        .filter(|line| !line.is_empty())
        .collect();

    let title = lines.first().cloned().unwrap_or_default();
    let preview = lines
        .get(1)
        .cloned()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    (title, preview)
}

/// 从 body 抽 `#tag` — 匹配行首或空白后的 `#` 后跟非空白 / 非标点字符。
/// 大小写敏感 (跟 markdown 风格一致); 重复 tag 去重。
///
/// 排除区: 围栏代码块 (3+ 反引号) 与行内反引号代码段内的 `#tag` 不参与
/// 提取 — 块内是代码示例, 不是用户的标签; 行内反引号包裹的内容是"代码"
/// 语义。两种区域在抽取前先从源文本里"挖空"成 NUL 占位, NUL 不在
/// `\s` 内且不会被 `#` 误连, 保证原 TAG_RE 不需要任何修改。
pub fn extract_tags_from_body(content: &str) -> Vec<String> {
    static TAG_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)(^|[\s])#([^\s[:punct:]]+)").unwrap());

    let mut seen = HashSet::new();
    let mut tags = Vec::new();

    let body = strip_code_regions(extract_body_content(content));
    for captures in TAG_RE.captures_iter(&body) {
        if let Some(tag) = captures.get(2).map(|m| m.as_str().trim().to_string()) {
            if !tag.is_empty() && seen.insert(tag.clone()) {
                tags.push(tag);
            }
        }
    }

    tags
}

/// 判定一行是否是 markdown 围栏代码块的 opening fence ── 3+ 个反引号开头,
/// 后面可接 info string (语言名)。返回 fence 的反引号长度。
fn fence_open_len(line: &str) -> Option<usize> {
    let t = line.trim_end_matches('\n').trim_start();
    let n = t.chars().take_while(|&c| c == '`').count();
    if n >= 3 {
        Some(n)
    } else {
        None
    }
}

/// 判定一行是否是长度为 `fence_len` 的 closing fence ── 整行 (trim 后)
/// 是 `fence_len` 个反引号, 其后只允许空白。
fn strip_fenced_code_blocks(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut fence_len: usize = 0;

    for line in body.split_inclusive('\n') {
        if !in_fence {
            if let Some(n) = fence_open_len(line) {
                in_fence = true;
                fence_len = n;
                continue;
            }
            out.push_str(line);
        } else if is_fence_close_line(line, fence_len) {
            in_fence = false;
            fence_len = 0;
        }
    }

    out
}

fn is_fence_close_line(line: &str, fence_len: usize) -> bool {
    let t = line.trim_end_matches('\n').trim();
    if t.chars().count() < fence_len {
        return false;
    }
    let head_ok = t.chars().take(fence_len).all(|c| c == '`');
    let tail_ok = t.chars().skip(fence_len).all(|c| c.is_whitespace());
    head_ok && tail_ok
}

/// 把行内反引号代码段内的字符替换为 NUL (`\0`), 同时删除两端的反引号。
/// NUL 不在 `\s` 也不在 `#`, 不会被 TAG_RE 误命中。同一行内多次出现都处理。
/// 简化处理: 单层 `…` 配对, 不处理多反引号嵌套 (CommonMark 边缘情形,
/// tag 提取的语义层不必要)。
fn blank_inline_code_spans(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            // 寻找同一行内的下一个反引号
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'`' {
                j += 1;
            }
            if j < bytes.len() {
                // 闭合找到, inline code 内部 NUL 化
                for _ in (i + 1)..j {
                    out.push('\0');
                }
                i = j + 1; // 跳过闭合反引号
            } else {
                // 行内没有闭合, 把反引号当普通字符保留
                out.push('`');
                i += 1;
            }
        } else {
            // 复制字符 (UTF-8 安全: 走 char boundary)
            let c = line[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// 一次性剥除 markdown 围栏代码块 (3+ 反引号) 与行内反引号代码段。
/// 围栏按行扫描, 找到 opening fence 后整段 (含 closing fence) 跳过;
/// 行内反引号则在每行内独立处理 (围栏外的行才会到达这一步)。
fn strip_code_regions(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut fence_len: usize = 0;

    for line in body.split_inclusive('\n') {
        if !in_fence {
            if let Some(n) = fence_open_len(line) {
                in_fence = true;
                fence_len = n;
                // 跳过 opening fence 行 (不写入 out)
                continue;
            }
            // 围栏外的普通行: 处理行内反引号代码段
            out.push_str(&blank_inline_code_spans(line));
        } else {
            // 围栏内: 检查是否到 closing fence
            if is_fence_close_line(line, fence_len) {
                in_fence = false;
                fence_len = 0;
                // 跳过 closing fence 行
            }
            // 围栏内其它行: 丢弃
        }
    }

    out
}

/// 从 body 抽 `- [ ]` / `- [x]` 复选框条目 (todo items)。
pub fn extract_todos_from_body(content: &str) -> Vec<TodoItem> {
    static TODO_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^\s*-\s*\[([ xX])\]\s*(.+)$").unwrap());

    TODO_RE
        .captures_iter(extract_body_content(content))
        .filter_map(|captures| {
            let content = captures.get(2)?.as_str().trim();
            if is_blank_line(content) {
                return None;
            }

            let checked = captures.get(1)?.as_str().eq_ignore_ascii_case("x");
            Some(TodoItem {
                content: content.to_string(),
                status: if checked { "completed" } else { "pending" }.to_string(),
            })
        })
        .collect()
}

/// 应用派生字段到 memo。`filename` 仅在为空时从 body 第一行覆盖 (用户显式设的
/// title 优先), `preview` / `tags` / `todos` 总是从 body 重算。
pub fn apply_derived_memo_fields(memo: &mut Memo, full_content: &str) {
    let (derived_title, preview) = extract_title_and_preview(full_content);
    if memo.filename.trim().is_empty() && !derived_title.is_empty() {
        memo.filename = derived_title;
    }
    memo.preview = preview;
    memo.tags = extract_tags_from_body(full_content);
    memo.todos = extract_todos_from_body(full_content);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_first_heading() {
        let (t, p) = extract_title_and_preview("# Hello\nworld\n");
        assert_eq!(t, "Hello");
        assert_eq!(p, "world");
    }

    #[test]
    fn preview_truncates_to_200_chars() {
        let body: String = "x".repeat(500);
        let (_, p) = extract_title_and_preview(&format!("# T\n{body}"));
        assert_eq!(p.chars().count(), 200);
    }

    /// `::agent-thread-card{...}` 作为单行节点出现在 body 顶部时, 不应
    /// 占用首行 (filename) 也不应霸占第二行 (preview)。
    #[test]
    fn agent_thread_card_single_line_is_skipped_for_title_and_preview() {
        let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" roleKey=\"flowix\" collapsed=\"false\"}
# Real title
real preview line
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview line");
    }

    /// 围栏形态 `:::agent-thread-card ... :::` 同样要在 title / preview 之前
    /// 整段剥离 ── 围栏里夹的多行文本不能算入首行/第二行。
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
        assert_eq!(p, "real preview line");
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
        assert_eq!(p, "real preview line");
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
        assert_eq!(p, "real preview");
    }

    /// 缩进的单行节点 (复制粘贴常见) ── 行级剔除应基于 trim 后整行,
    /// 不应被前置空白漏掉。
    #[test]
    fn indented_single_line_agent_thread_card_is_stripped() {
        let md = "\
    ::agent-thread-card{threadId=\"x\" title=\"t\" roleKey=\"flowix\" collapsed=\"false\"}
# Real title
real preview
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview");
    }

    /// 多张节点堆叠时也都要剥离 ── 不能只剥第一张。
    #[test]
    fn stacked_agent_thread_cards_are_all_stripped() {
        let md = "\
::agent-thread-card{threadId=\"a\" title=\"A\" roleKey=\"flowix\" collapsed=\"false\"}
::agent-thread-card{threadId=\"b\" title=\"B\" roleKey=\"flowix\" collapsed=\"false\"}
# Real title
real preview
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview");
    }

    /// 纯节点文档 (没有任何用户文本) 派生出的 title / preview 都应为空 ──
    /// 不应把节点 attribute 串当作 title 写进 index.json。
    #[test]
    fn card_only_document_yields_empty_title_and_preview() {
        let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" roleKey=\"flowix\" collapsed=\"false\"}
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
        assert_eq!(p, "real preview");
    }

    #[test]
    fn markdown_table_after_title_is_skipped_for_preview() {
        let md = "\
# Real title
| Name | Value |
| :--- | ---: |
| A | 1 |
real preview
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview");
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
        assert_eq!(p, "left | right");
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
        assert_eq!(p, "real preview");
    }

    #[test]
    fn inline_note_reference_is_removed_but_surrounding_text_remains() {
        let md = "\
# Real title
prefix <note id=\"abc\" notebook=\"nb\" path=\"/tmp/a.md\">Notebook/A</note> suffix
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "prefix suffix");
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
        assert_eq!(p, "real preview");
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
        assert_eq!(p, "preview tail");
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

    #[test]
    fn todos_parse_checked_and_unchecked() {
        let v = extract_todos_from_body("- [ ] one\n- [x] two\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].status, "pending");
        assert_eq!(v[1].status, "completed");
    }
}
