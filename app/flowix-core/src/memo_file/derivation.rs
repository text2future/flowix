//! 派生字段提取 — `extract_todos_from_body` / `extract_title_and_preview` /
//! `apply_derived_memo_fields` / `strip_markdown` /
//! `is_blank_line` / `strip_block_node_lines`。
//!
//! 派生语义: `tags` / `properties` 来自头部 YAML，其余展示字段来自 Markdown
//! 正文。写盘后由 [`apply_derived_memo_fields`] 同步回 memo index，使 YAML 成为
//! 文档属性真源、memo index 仅作为派生缓存。
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

use super::frontmatter::{
    extract_body_content, extract_document_metadata_preserving_invalid_tag_paths,
};
use super::types::{AgentThreadItem, Memo, TodoItem};

/// 解码常见 HTML 实体为对应 Unicode 字符。title/preview 派生的最小集:
/// - 空白类 (`&nbsp;` / `&ensp;` / `&emsp;` / `&thinsp;` / `&hairsp;` /
///   `&numsp;` / `&puncsp;` / `&mediumsp;` / `&idsp;` / `&#160;` / `&#xa0;`)
///   → Unicode Zs 空白, 由下游 `\s+` 自然折叠为单空格, `.trim()` 吃掉首尾
/// - 基础符号 (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#34;`) → 对应字符
///
/// 未知 / 畸形实体原样保留 (不抛错也不吃字符), 保证非 HTML 内容不受影响。
/// 故意未含零宽连接符 (`&zwnj;` / `&zwj;`) ── 它们在 Unicode 中不是空白,
/// 字面保留能让文本塑形语义不丢; 若日后要按"全空白"过滤再单独加。
fn decode_html_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let c = s[i..].chars().next().unwrap();
        if c == '&' {
            if let Some((decoded, consumed)) = try_decode_entity(&s[i..]) {
                out.push(decoded);
                i += consumed;
                continue;
            }
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// 尝试从 `s` 起始位置匹配一个已知 HTML 实体。成功返回 (解码字符, 消费的字节数);
/// 失败返回 `None`, 调用方按普通字符处理。
fn try_decode_entity(s: &str) -> Option<(char, usize)> {
    // 命名实体 ── 互不为前缀, 顺序无关; `&` 已在 caller 判定过。
    // 空白类全部归位到 Unicode Zs (Separator, Space), 让下游 `is_whitespace` /
    // `str::trim` / Rust regex `\s` (匹配 White_Space) 统一处理 ── 不需要在
    // 这里为每种空白单独写折叠逻辑。
    const NAMED: &[(&str, char)] = &[
        // 空白类 (HTML5 named character references)
        ("&nbsp;", '\u{00A0}'),     // NO-BREAK SPACE
        ("&ensp;", '\u{2002}'),     // EN SPACE
        ("&emsp;", '\u{2003}'),     // EM SPACE
        ("&thinsp;", '\u{2009}'),   // THIN SPACE
        ("&hairsp;", '\u{200A}'),   // HAIR SPACE
        ("&numsp;", '\u{2007}'),    // FIGURE SPACE
        ("&puncsp;", '\u{2008}'),   // PUNCTUATION SPACE
        ("&mediumsp;", '\u{205F}'), // MEDIUM MATHEMATICAL SPACE
        ("&idsp;", '\u{3000}'),     // IDEOGRAPHIC SPACE
        // 基础符号
        ("&quot;", '"'),
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
    ];
    for (pat, ch) in NAMED {
        if s.starts_with(pat) {
            return Some((*ch, pat.len()));
        }
    }
    // 数字实体 &#NN; / &#xHH; ── 上限 8 位防止病态输入。
    let after_hash = s.strip_prefix("&#")?;
    let semi_pos = after_hash.find(';')?;
    let num_str = &after_hash[..semi_pos];
    if num_str.is_empty() || num_str.len() > 8 {
        return None;
    }
    let n = if let Some(hex) = num_str
        .strip_prefix('x')
        .or_else(|| num_str.strip_prefix('X'))
    {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        num_str.parse::<u32>().ok()?
    };
    let ch = char::from_u32(n)?;
    // 阻止 NUL 控制字符泄漏到 title / preview (HTML5 规范中 `&#0;` 渲染为空)。
    if ch == '\0' {
        return None;
    }
    Some((ch, 2 + semi_pos + 1))
}

/// 判定 markdown 行是否"语义空白" (空行 / 全空格 / 任意空白类 HTML 实体 /
/// 不间断空格 U+00A0)。`is_blank_line` 用于过滤 title/preview/todo 提取前的源。
///
/// 先过 [`decode_html_entities`] 再 trim, 让所有空白类实体
/// (`&nbsp;` / `&#160;` / `&#xa0;` 等) 都被正确折叠为单空格再被 trim 吃掉。
/// 性能优化: 大多数行不含 `&`, 用 `contains('&')` 短路避免无谓的 String 分配。
pub fn is_blank_line(line: &str) -> bool {
    if line.contains('&') {
        decode_html_entities(line).trim().is_empty()
    } else {
        line.trim().is_empty()
    }
}

/// 去掉 markdown 装饰字符 (heading `#` / list `-*+` / quote `>` / checkbox `[ ]`
/// / link 包装 / 强调 `*_` / 反引号), 折叠连续空白为单空格, 留作 title 派生。
///
/// 流水线首步先做 HTML 实体解码 (`&nbsp;` → U+00A0 等), 让 `&nbsp;` 行内残留
/// 被下游 `\s+` 自然折叠为单空格, 然后被末尾 `.trim()` 吃掉 ── 这样无论
/// `&nbsp;` 出现在行首 / 行尾 / 行内都能被清洗, 不再泄漏实体字符串。
pub fn strip_markdown(text: &str) -> String {
    let mut value = decode_html_entities(text.trim());

    // Remove body tags before stripping Markdown heading markers. Otherwise a
    // tag-only line such as `#project/backend` would first become
    // `project/backend` and leak into the derived title/preview.
    //
    // Keep this syntax aligned with `extract_tags_from_body`: a tag starts at
    // the beginning of the line or after whitespace, and may contain `/`
    // separated path segments. Retain the captured prefix so surrounding prose
    // keeps a natural word boundary after whitespace collapsing.
    static BODY_TAG_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)(^|[\s])#((?:[^/\s\p{P}]+/)*[^/\s\p{P}]+)").unwrap());
    value = BODY_TAG_RE.replace_all(&value, "$1").into_owned();

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
        Lazy::new(|| Regex::new(r"!\[[^\]]*\]\([^)]+\)(?:\{[^}\n]*\})?").unwrap());
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

/// `::agent-thread-card{threadId="..." title="..." agentType="..." collapsed="..."}`
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
///
/// 性能要点: 只取前两个非空行, 找到后立即结束迭代。典型笔记正文 5KB+ 也只
/// 处理 2-10 行, 不再为求前两条结果跑遍整文件。
pub fn extract_title_and_preview(content: &str) -> (String, String) {
    let body = strip_block_node_lines(&strip_fenced_code_blocks(extract_body_content(content)));
    let mut iter = body
        .lines()
        .map(str::trim)
        .filter(|line| !is_blank_line(line))
        .map(strip_markdown)
        .filter(|line| !line.is_empty());

    let title = iter.next().unwrap_or_default();
    let preview = iter.next().unwrap_or_default().chars().take(200).collect();
    (title, preview)
}

pub fn extract_thumbnail(content: &str) -> Option<String> {
    static MARKDOWN_IMAGE_URL_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)(?:\{[^}\n]*\})?"#).unwrap()
    });

    let body_without_code = strip_fenced_code_blocks(extract_body_content(content));
    let body = strip_block_node_lines(&body_without_code);
    MARKDOWN_IMAGE_URL_RE
        .captures(&body)
        .and_then(|captures| captures.get(1))
        .map(|matched| matched.as_str().trim().to_string())
        .filter(|url| !url.is_empty())
}

/// 仅供一次性旧数据迁移：从 body 抽取历史 `#tag`。
/// 大小写敏感 (跟 markdown 风格一致); 重复 tag 去重。
///
/// **路径式 tag**: tag 名允许用 `/` 分隔的多段路径 (如 `旅行/泰国/曼谷`),
/// 每段内部仍然排除空白 / `/` / Unicode 标点。每条 tag 整体作为**一条**
/// 完整字符串入库, 不同前缀路径视为不同 tag
/// (`旅行/泰国/曼谷` ≠ `泰国/曼谷` ≠ `曼谷`)。
///
/// 排除区: 围栏代码块 (3+ 反引号) 与行内反引号代码段内的 `#tag` 不参与
/// 提取 — 块内是代码示例, 不是用户的标签; 行内反引号包裹的内容是"代码"
/// 语义。两种区域在抽取前先从源文本里"挖空"成 NUL 占位, NUL 不在
/// `\s` 内且不会被 `#` 误连, 保证原 TAG_RE 不需要任何修改。
pub(crate) fn extract_tags_from_body(content: &str) -> Vec<String> {
    // 结构: 前缀 (^|空白) + # + (level/)*level
    //   - level: 1+ 个非空白 / 非 `/` / 非 Unicode 标点字符
    //   - 段间用 `/` 分隔
    // 末段不能以 `/` 收尾 — 尾部多余的 `/` 触发回溯, 留在 body 变孤儿文本
    // (参见 [normalize_tag_path] 进一步校验)。
    static TAG_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)(^|[\s])#((?:(?:[-_]|[^/\s\p{P}])+/)*(?:[-_]|[^/\s\p{P}])+)").unwrap()
    });

    let mut seen = HashSet::new();
    let mut tags = Vec::new();

    let body = strip_code_regions(extract_body_content(content));
    for captures in TAG_RE.captures_iter(&body) {
        if let Some(raw) = captures.get(2).map(|m| m.as_str()) {
            if let Some(tag) = normalize_tag_path(raw) {
                if seen.insert(tag.clone()) {
                    tags.push(tag);
                }
            }
        }
    }

    tags
}

fn merge_document_tag_sources(mut tags: Vec<String>, content: &str) -> Vec<String> {
    let mut seen: HashSet<String> = tags.iter().cloned().collect();
    for tag in extract_tags_from_body(content) {
        if seen.insert(tag.clone()) {
            tags.push(tag);
        }
    }
    tags
}

pub(crate) fn rewrite_body_tag_path(
    content: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> String {
    static TAG_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)(^|[\s])#((?:(?:[-_]|[^/\s\p{P}])+/)*(?:[-_]|[^/\s\p{P}])+)").unwrap()
    });

    let body = extract_body_content(content);
    let body_offset = body.as_ptr() as usize - content.as_ptr() as usize;
    let mut rewritten_body = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut fence_len = 0usize;
    let prefix = format!("{old_path}/");

    for line in body.split_inclusive('\n') {
        if !in_fence {
            if let Some(length) = fence_open_len(line) {
                in_fence = true;
                fence_len = length;
                rewritten_body.push_str(line);
                continue;
            }

            let inline_ranges = inline_code_ranges(line);
            let mut cursor = 0usize;
            for captures in TAG_RE.captures_iter(line) {
                let Some(tag_match) = captures.get(2) else {
                    continue;
                };
                if inline_ranges
                    .iter()
                    .any(|(start, end)| tag_match.start() >= *start && tag_match.start() < *end)
                {
                    continue;
                }
                let tag = tag_match.as_str();
                let suffix = if tag == old_path {
                    Some("")
                } else {
                    tag.strip_prefix(&prefix)
                };
                let Some(suffix) = suffix else {
                    continue;
                };
                let hash_start = tag_match.start().saturating_sub(1);
                rewritten_body.push_str(&line[cursor..hash_start]);
                if let Some(new_path) = new_path {
                    rewritten_body.push('#');
                    rewritten_body.push_str(new_path);
                    if !suffix.is_empty() {
                        rewritten_body.push('/');
                        rewritten_body.push_str(suffix);
                    }
                }
                cursor = tag_match.end();
            }
            rewritten_body.push_str(&line[cursor..]);
        } else {
            rewritten_body.push_str(line);
            if is_fence_close_line(line, fence_len) {
                in_fence = false;
                fence_len = 0;
            }
        }
    }

    format!("{}{}", &content[..body_offset], rewritten_body)
}

fn inline_code_ranges(line: &str) -> Vec<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut ranges = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'`' {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor] != b'`' {
            cursor += 1;
        }
        if cursor < bytes.len() {
            cursor += 1;
            ranges.push((start, cursor));
        }
    }
    ranges
}

/// 把 regex 抓到的原始 tag 字符串规范化为合法路径。返回 `None` 表示该
/// 候选不应作为 tag 入库 (空串、含 `//`、首尾 `/`、存在空段)。
///
/// 设计动机: TAG_RE 是宽松匹配 ── 末段尾部多余的 `/` 触发回溯并被
/// 吞掉 (例如 `#a/b/c/` 捕获为 `a/b/c`), 这种情况 normalize 一定能
/// 通过; 但**含 `//` / 空前缀 / 末尾 `/` (整段无末段字符) ** 等残缺
/// 形态可能通过 regex 的回溯路径绕过字符类检查 ── normalize 是兜底
/// 防线, 保证入库的 tag 永远是可以被 step 3 的 prefix 替换正确处理
/// 的合法路径。
pub fn normalize_tag_path(raw: &str) -> Option<String> {
    static VALID_SEGMENT_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^(?:[-_]|[^/\s\p{P}])+$").unwrap());

    let s = raw.trim();
    if s.is_empty() || s.contains("//") {
        return None;
    }
    if s.starts_with('/') || s.ends_with('/') {
        return None;
    }
    for seg in s.split('/') {
        if seg.is_empty()
            || seg.chars().all(|ch| matches!(ch, '-' | '_'))
            || !VALID_SEGMENT_RE.is_match(seg)
        {
            return None;
        }
    }
    Some(s.to_string())
}

/// Normalize a user-facing search tag filter. Search accepts the same tag path
/// syntax as stored metadata and additionally tolerates one leading `#`.
pub fn normalize_search_tag_filter(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_hash = trimmed.strip_prefix('#').unwrap_or(trimmed);
    normalize_tag_path(without_hash)
}

/// Return whether a stored tag belongs to a requested tag path. Matching is
/// segment-aware: `project` matches `project` and `project/flowix`, but not
/// `project-management`.
pub fn tag_path_matches_filter(tag: &str, filter: &str) -> bool {
    tag == filter
        || tag
            .strip_prefix(filter)
            .is_some_and(|suffix| suffix.starts_with('/'))
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
///
/// content 走 [`decode_html_entities`] 后再判 blank ── 让 `&nbsp;` /
/// `&#160;` 等空白类实体被正确折叠为空, 不会作为空白条目泄漏到结果数组。
/// 实体解码也保证存储的 content 与 title/preview 流水线语义一致。
pub fn extract_todos_from_body(content: &str) -> Vec<TodoItem> {
    static TODO_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^\s*-\s*\[([ xX])\]\s*(.+)$").unwrap());

    TODO_RE
        .captures_iter(extract_body_content(content))
        .filter_map(|captures| {
            let content = decode_html_entities(captures.get(2)?.as_str().trim());
            if content.trim().is_empty() {
                return None;
            }

            let checked = captures.get(1)?.as_str().eq_ignore_ascii_case("x");
            Some(TodoItem {
                content,
                status: if checked { "completed" } else { "pending" }.to_string(),
            })
        })
        .collect()
}

pub fn extract_agent_threads_from_body(content: &str) -> Vec<AgentThreadItem> {
    static AGENT_THREAD_CARD_ATTRS_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"(?m)^\s*::agent-thread-card\{([^}]*)\}\s*$"#).unwrap());
    static ATTR_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"([A-Za-z][A-Za-z0-9_-]*)="([^"]*)""#).unwrap());

    let mut seen = HashSet::new();
    let mut agents = Vec::new();
    let body = strip_fenced_code_blocks(extract_body_content(content));

    for captures in AGENT_THREAD_CARD_ATTRS_RE.captures_iter(&body) {
        let attrs = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
        let mut thread_id = String::new();
        let mut title = String::new();
        let mut agent_type = String::new();

        for attr in ATTR_RE.captures_iter(attrs) {
            let key = attr.get(1).map(|m| m.as_str()).unwrap_or_default();
            let value = attr
                .get(2)
                .map(|m| decode_markdown_attr(m.as_str()))
                .unwrap_or_default();
            match key {
                "threadId" => thread_id = value,
                "title" => title = value,
                "agentType" => agent_type = value,
                _ => {}
            }
        }

        if thread_id.trim().is_empty() || !seen.insert(thread_id.clone()) {
            continue;
        }

        agents.push(AgentThreadItem {
            thread_id,
            title,
            agent_type,
        });
    }

    agents
}

fn decode_markdown_attr(value: &str) -> String {
    decode_html_entities(value)
}

/// 应用派生字段到 memo。`filename` 仅在为空时从 body 第一行覆盖 (用户显式设的
/// title 优先), `preview` / `todos` / `agents` 从 body 重算; `tags` 是
/// YAML tags 与正文标签的稳定去重并集, `properties` 仍只来自 YAML。
pub fn apply_derived_memo_fields(memo: &mut Memo, full_content: &str) {
    let (derived_title, preview) = extract_title_and_preview(full_content);
    if memo.filename.trim().is_empty() && !derived_title.is_empty() {
        memo.filename = derived_title;
    }
    memo.preview = preview;
    memo.thumbnail = extract_thumbnail(full_content);
    memo.todos = extract_todos_from_body(full_content);
    memo.agents = extract_agent_threads_from_body(full_content);
    if let Ok(metadata) = extract_document_metadata_preserving_invalid_tag_paths(full_content) {
        let mut seen = HashSet::new();
        let yaml_tags = metadata
            .tags
            .into_iter()
            .filter_map(|raw| match normalize_tag_path(&raw) {
                Some(tag) if seen.insert(tag.clone()) => Some(tag),
                Some(_) => None,
                None => {
                    tracing::warn!(
                        memo_id = %memo.id,
                        tag = %raw,
                        "ignoring invalid legacy frontmatter tag path while deriving memo metadata"
                    );
                    None
                }
            })
            .collect();
        memo.tags = merge_document_tag_sources(yaml_tags, full_content);
        memo.favorited = metadata
            .properties
            .get("flowix_favorited")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        memo.icon = metadata
            .properties
            .get("flowix_icon")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        memo.colors = metadata
            .properties
            .get("flowix_colors")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        memo.properties = metadata.properties;
    }
}

#[cfg(test)]
mod tests;
