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

use super::frontmatter::{extract_body_content, extract_document_metadata};
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
    static TAG_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)(^|[\s])#((?:[^/\s\p{P}]+/)*[^/\s\p{P}]+)").unwrap());

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
    static TAG_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)(^|[\s])#((?:[^/\s\p{P}]+/)*[^/\s\p{P}]+)").unwrap());

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
    static INVALID_SEGMENT_CHAR: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"[\s\p{P}]").unwrap());

    let s = raw.trim();
    if s.is_empty() || s.contains("//") {
        return None;
    }
    if s.starts_with('/') || s.ends_with('/') {
        return None;
    }
    for seg in s.split('/') {
        if seg.is_empty() || INVALID_SEGMENT_CHAR.is_match(seg) {
            return None;
        }
    }
    Some(s.to_string())
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
    if let Ok(metadata) = extract_document_metadata(full_content) {
        memo.tags = merge_document_tag_sources(metadata.tags, full_content);
        memo.properties = metadata.properties;
    }
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
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" agentType=\"flowix\" collapsed=\"false\"}
# Real title
real preview line
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview line");
    }

    #[test]
    fn agent_thread_card_refs_are_extracted_from_body() {
        let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI &amp; Helper\" agentType=\"flowix\" collapsed=\"false\"}
::agent-thread-card{threadId=\"abc\" title=\"Duplicate\" agentType=\"flowix\" collapsed=\"true\"}
::agent-thread-card{threadId=\"\" title=\"Draft\" agentType=\"flowix\" collapsed=\"false\"}
";
        let agents = extract_agent_threads_from_body(md);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].thread_id, "abc");
        assert_eq!(agents[0].title, "AI & Helper");
        assert_eq!(agents[0].agent_type, "flowix");
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
    ::agent-thread-card{threadId=\"x\" title=\"t\" agentType=\"flowix\" collapsed=\"false\"}
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
::agent-thread-card{threadId=\"a\" title=\"A\" agentType=\"flowix\" collapsed=\"false\"}
::agent-thread-card{threadId=\"b\" title=\"B\" agentType=\"flowix\" collapsed=\"false\"}
# Real title
real preview
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "real preview");
    }

    /// 纯节点文档 (没有任何用户文本) 派生出的 title / preview 都应为空 ──
    /// 不应把节点 attribute 串当作 title 写进 memo index。
    #[test]
    fn card_only_document_yields_empty_title_and_preview() {
        let md = "\
::agent-thread-card{threadId=\"abc\" title=\"AI 对话\" agentType=\"flowix\" collapsed=\"false\"}
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
    fn markdown_image_size_attrs_are_removed_for_title_and_preview() {
        let md = "\
# Real title
preview ![image.png](asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5Cimage_3.png){width=34%} tail
";
        let (t, p) = extract_title_and_preview(md);
        assert_eq!(t, "Real title");
        assert_eq!(p, "preview tail");
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
    }

    /// 路径式 tag 仍走 strip_code_regions, NUL 占位不影响。
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

    // ============== HTML 实体解码 (title / preview 派生) ==============

    /// 行内 `&nbsp;` 不应作为实体字符串泄漏到 title ── 应被解码成 NBSP 后由
    /// 末尾 `.trim()` / `\s+` 折叠掉。
    #[test]
    fn inline_nbsp_entity_is_decoded_and_trimmed() {
        let (t, p) = extract_title_and_preview("&nbsp;Hello\n&nbsp;World\n");
        assert_eq!(t, "Hello");
        assert_eq!(p, "World");
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

    /// 验证只取前 2 个非空行 ── 后面的内容无论多长都不会影响 title / preview。
    /// 同时隐式验证短路不会破坏语义 (即使输入 100+ 行也只取首二)。
    #[test]
    fn title_and_preview_use_only_first_two_non_empty_lines() {
        let mut lines: Vec<String> = vec!["# Title".to_string()];
        for i in 0..200 {
            lines.push(format!("body line {i}"));
        }
        let input = lines.join("\n");
        let (t, p) = extract_title_and_preview(&input);
        assert_eq!(t, "Title");
        assert_eq!(p, "body line 0");
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
            assert_eq!(p, "body");
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
            assert_eq!(p, "body");
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
}
