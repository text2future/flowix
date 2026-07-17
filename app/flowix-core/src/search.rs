//! 当前 notebook 内的全文搜索. 内存倒排索引, 不落盘.
//!
//! # 设计
//! - **tokenize**: v1 用 `BigramTokenizer`(ASCII 单词 + CJK 字符 bigram + 长度 1 的
//!   CJK 段出 unigram 兜底). 通过 [`Tokenizer`] trait 抽象, v2 可换成 jieba-rs
//!   不改 [`MemoIndex`] 任何代码.
//! - **倒排表**: `HashMap<token, BTreeSet<memo_id>>`; 搜索时求多 token 交集
//!   (从最小 set 起手 fold).
//! - **打分**: title 命中 +10, tag 命中 +5, body 命中按词频(min 1.0, +0.1/次, 上限 3.0);
//!   再加 `(updated_at / 1e13)` 微调打破平局. 排序后取 limit.
//! - **snippet**: 在 `body_lower` 里找首次出现位置, 按 `char_indices` 算 UTF-8 安全
//!   字符偏移, 取 `p-40..p+query.len()+40` 切片; 命中区间用 `\x01...\x02` 包裹,
//!   前端切片渲染为 `<mark>`.
//! - **假阳性防御**: bigram 倒排表天然有"ab+bc 两个 token 都命中不代表 abc 子串命中"
//!   的问题, search() 末尾用 `body.contains(query_lower)` 等做精确校验, 不通过的
//!   候选会被丢弃.
//!
//! # 局限性 (v1)
//! 索引只跟踪 IPC 写命令 (`update_memo_db` / `write_document` / `add_document` /
//! `import_external_document_to_memo` / `clear_memos` / `delete_memo`). 若用户用
//! 外部编辑器直接改 `.md` 文件, 索引会过期, 需要切换 notebook 触发 rebuild
//! 才能恢复一致性. 后续可挂 `notify` 监听.
//!
//! 切换 notebook 与索引 rebuild 通过 `spawn_blocking` 在后台线程执行. 在 rebuild
//! 期间 (几百 ms) `search()` 返回空 (`loaded == false`), 写命令的 `try_index_upsert`
//! 也会被守卫跳过 — 这是一致性优先的取舍, 换取不阻塞主线程.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use serde::Serialize;

use crate::memo_file::frontmatter::extract_body_content;
use crate::memo_file::{MemoFile, MemoIndexEntry, NotebookConfig};

// ============================================================
// Tokenizer
// ============================================================

/// 把一段文本切成搜索用的 token 序列.
///
/// v1 用 [`BigramTokenizer`]; v2 想接 jieba-rs 只需实现这个 trait 替换
/// [`MemoIndex::new`] 的实参, 倒排表/打分/snippet 全部不动.
pub trait Tokenizer: Send + Sync {
    fn tokens(&self, text: &str) -> Vec<String>;
}

/// ASCII 单词 + CJK bigram. CJK 字符连续段里相邻两字成 bigram, 长度 1 的尾巴
/// 段也出 unigram 兜底 (单字查询能用).
pub struct BigramTokenizer;

impl Tokenizer for BigramTokenizer {
    fn tokens(&self, text: &str) -> Vec<String> {
        let lower = text.to_lowercase();
        let mut out: Vec<String> = Vec::new();
        let mut ascii_buf = String::new();
        let mut cjk_window: Vec<char> = Vec::new();

        for ch in lower.chars() {
            if ch.is_ascii_alphanumeric() {
                flush_cjk(&mut cjk_window, &mut out);
                ascii_buf.push(ch);
            } else if is_cjk(ch) {
                flush_ascii(&mut ascii_buf, &mut out);
                cjk_window.push(ch);
            } else {
                // 空白 / 标点 / 换行 — 双方都断流
                flush_ascii(&mut ascii_buf, &mut out);
                flush_cjk(&mut cjk_window, &mut out);
            }
        }
        flush_ascii(&mut ascii_buf, &mut out);
        flush_cjk(&mut cjk_window, &mut out);

        out
    }
}

fn flush_ascii(buf: &mut String, out: &mut Vec<String>) {
    if !buf.is_empty() {
        out.push(std::mem::take(buf));
    }
}

/// CJK 窗口长度 >= 2 时按相邻两字串成 bigram; 长度 1 时也单独出 unigram.
fn flush_cjk(window: &mut Vec<char>, out: &mut Vec<String>) {
    if window.is_empty() {
        return;
    }
    if window.len() == 1 {
        out.push(window[0].to_string());
    } else {
        for pair in window.windows(2) {
            let mut s = String::with_capacity(2);
            s.push(pair[0]);
            s.push(pair[1]);
            out.push(s);
        }
    }
    window.clear();
}

/// 覆盖 CJK 统一表意 (U+4E00..U+9FFF 主体 + 扩展 A 区 U+3400..U+4DBF),
/// 日文假名 (U+3040..U+30FF), 韩文音节 (U+AC00..U+D7AF).
fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x3040..=0x309F | // 平假名
        0x30A0..=0x30FF | // 片假名
        0x3400..=0x4DBF | // CJK 统一表意扩展 A
        0x4E00..=0x9FFF | // CJK 统一表意
        0xAC00..=0xD7AF   // 韩文音节
    )
}

// ============================================================
// Index entry
// ============================================================

/// 单条 memo 的索引条目. `body_lower` 存全文 (strip frontmatter + lowercase) 是为了
/// (1) snippet 抽取能在原文里定位命中位置, (2) bigram 假阳性做精确校验.
/// `id` 本身是 HashMap 的 key, 不在 value 里重复存.
#[derive(Debug, Clone)]
pub struct SearchIndexEntry {
    pub filename: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
    pub title_lower: String,
    pub body_lower: String,
}

// ============================================================
// Search hit (序列化到前端)
// ============================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MatchField {
    Title,
    Tag,
    Body,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoSearchHit {
    pub id: String,
    pub filename: String,
    pub snippet: String,
    pub matched_in: MatchField,
    pub score: f32,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSearchHit {
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    pub id: String,
    pub filename: String,
    pub snippet: String,
    pub matched_in: MatchField,
    pub score: f32,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSearchResults {
    pub query: String,
    pub hits: Vec<NotebookSearchHit>,
    pub total: usize,
}

// ============================================================
// MemoIndex
// ============================================================

/// 当前 notebook 的内存倒排索引. 单实例, 挂在 `AppState` 上.
pub struct MemoIndex {
    notebook_id: Option<String>,
    entries: HashMap<String, SearchIndexEntry>,
    postings: HashMap<String, BTreeSet<String>>,
    /// false 时 `search()` 返回空, 写命令的 `try_index_upsert/remove` 也会跳过.
    /// `rebuild` 成功置 true, 显式 `mark_unloaded` 置 false.
    loaded: bool,
    tokenizer: Arc<dyn Tokenizer>,
}

impl MemoIndex {
    pub fn new(tokenizer: Arc<dyn Tokenizer>) -> Self {
        Self {
            notebook_id: None,
            entries: HashMap::new(),
            postings: HashMap::new(),
            loaded: false,
            tokenizer,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn current_notebook(&self) -> Option<&str> {
        self.notebook_id.as_deref()
    }

    /// 清空 entries/postings/notebook_id 并把 `loaded` 置 false. 通常在 `rebuild`
    /// 开始前调用, 让 rebuild 期间的 search() 立即返回空, 也让
    /// `current_notebook()` 返回 None — 配合上层 `switch_notebook_and_rebuild`
    /// 强制触发 rebuild 的判断.
    pub fn mark_unloaded(&mut self) {
        self.entries.clear();
        self.postings.clear();
        self.notebook_id = None;
        self.loaded = false;
    }

    /// 全量重建. `items` 是 (metadata, 完整 .md 原始内容) 对的列表.
    /// 读失败或条目不存在的项会被静默跳过 (在 memo index 里的 metadata 仍会进索引,
    /// 只是 body_lower 为空, 搜不到正文).
    pub fn rebuild(&mut self, notebook_id: String, items: Vec<(MemoIndexEntry, String)>) {
        self.mark_unloaded();
        self.notebook_id = Some(notebook_id);
        for (entry, full_md) in items {
            self.insert_entry(entry, &full_md);
        }
        self.loaded = true;
    }

    /// 单条新增 / 更新. 内部先按 id 删旧 token 再插新 token. 无声吞掉不在索引的 id
    /// (例如尚未 rebuild 的 notebook, 由 `try_index_upsert` 的 `is_loaded` 守卫).
    pub fn upsert(&mut self, entry: MemoIndexEntry, full_md: &str) {
        if !self.loaded {
            return;
        }
        self.remove(&entry.id);
        self.insert_entry(entry, full_md);
    }

    /// 按 id 删除. 不存在的 id 静默忽略.
    pub fn remove(&mut self, id: &str) {
        if !self.loaded {
            return;
        }
        if let Some(old) = self.entries.remove(id) {
            for tok in self.tokenizer.tokens(&old.title_lower) {
                if let Some(set) = self.postings.get_mut(&tok) {
                    set.remove(id);
                    if set.is_empty() {
                        self.postings.remove(&tok);
                    }
                }
            }
            for tok in self.tokenizer.tokens(&old.body_lower) {
                if let Some(set) = self.postings.get_mut(&tok) {
                    set.remove(id);
                    if set.is_empty() {
                        self.postings.remove(&tok);
                    }
                }
            }
        }
    }

    /// 全文检索. 算法见模块顶部注释.
    pub fn search(&self, query: &str, limit: usize) -> Vec<MemoSearchHit> {
        if !self.loaded {
            return Vec::new();
        }
        let query_trim = query.trim();
        if query_trim.is_empty() {
            return Vec::new();
        }
        let query_lower = query_trim.to_lowercase();

        let q_tokens = self.tokenizer.tokens(&query_lower);
        if q_tokens.is_empty() {
            return Vec::new();
        }
        // 精确校验用去空白版: 用户输入 "今天 天气" 应当匹配正文 "今天天气...".
        // tokenize 阶段空格已经是分隔符, 但 contains() 还按字面比对, 这里抹平.
        let query_for_contains: String = query_lower.split_whitespace().collect();

        // 1. 候选集: q_tokens 在 postings 里的 set 之交集. 任一 token 缺失 -> 候选空.
        let mut candidates: Option<BTreeSet<String>> = None;
        for tok in &q_tokens {
            match self.postings.get(tok) {
                Some(set) => {
                    let s = set.clone();
                    candidates = Some(match candidates.take() {
                        Some(prev) => {
                            // 用较小的一边 reduce, 减少分配
                            if prev.len() < s.len() {
                                prev.intersection(&s).cloned().collect()
                            } else {
                                let mut s = s;
                                s.retain(|id| prev.contains(id));
                                s
                            }
                        }
                        None => s,
                    });
                }
                None => return Vec::new(),
            }
        }
        let Some(candidates) = candidates else {
            return Vec::new();
        };

        // 2. 精确校验 + 打分
        let mut hits: Vec<MemoSearchHit> = Vec::with_capacity(candidates.len());
        for id in &candidates {
            let Some(entry) = self.entries.get(id) else {
                continue;
            };
            let mut score = 0.0_f32;
            let mut matched_in = MatchField::Body;
            let mut any_match = false;

            if entry.title_lower.contains(&query_for_contains) {
                score += 10.0;
                matched_in = MatchField::Title;
                any_match = true;
            }
            if entry
                .tags
                .iter()
                .any(|t| t.to_lowercase().contains(&query_for_contains))
            {
                score += 5.0;
                if matched_in != MatchField::Title {
                    matched_in = MatchField::Tag;
                }
                any_match = true;
            }
            let body_hits = entry.body_lower.matches(&query_for_contains).count();
            if body_hits > 0 {
                let tf = 1.0 + (body_hits as f32 * 0.1).min(2.0);
                score += tf;
                if !any_match {
                    matched_in = MatchField::Body;
                }
                any_match = true;
            }

            if !any_match {
                // bigram 假阳性: 倒排表命中但 title/tag/body 都不含 query 子串
                continue;
            }

            // 时间微调, 毫秒时间戳 / 1e13 量级在 0..10 之间, 不会喧宾夺主
            score += entry.updated_at as f32 / 1e13;

            let snippet = make_snippet(entry, &query_for_contains, &matched_in);
            hits.push(MemoSearchHit {
                id: id.clone(),
                filename: entry.filename.clone(),
                snippet,
                matched_in,
                score,
                updated_at: entry.updated_at,
            });
        }

        // 3. 排序 + 截断
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        hits.truncate(limit);
        hits
    }

    // ---- private ----

    fn insert_entry(&mut self, entry: MemoIndexEntry, full_md: &str) {
        let id = entry.id.clone();
        let title_lower = entry.filename.to_lowercase();
        // strip frontmatter (YAML --- ... --- 块), 但保留 #tag 字面量供后续 tag 抽取用
        let body_lower = extract_body_content(full_md).to_lowercase();

        let idx_entry = SearchIndexEntry {
            filename: entry.filename,
            preview: entry.preview,
            tags: entry.tags,
            updated_at: entry.updated_at,
            title_lower: title_lower.clone(),
            body_lower: body_lower.clone(),
        };
        self.entries.insert(id.clone(), idx_entry);

        for tok in self.tokenizer.tokens(&title_lower) {
            self.postings.entry(tok).or_default().insert(id.clone());
        }
        for tok in self.tokenizer.tokens(&body_lower) {
            self.postings.entry(tok).or_default().insert(id.clone());
        }
    }
}
/// 抽 snippet. title/tag 命中用 preview 替代; body 命中在 body_lower 里找首次出现位置,
/// 用 `char_indices` 算 UTF-8 字符级偏移 (绝不能按字节切). 命中区间用 `\x01...\x02` 包裹.
pub fn rebuild_index_from_store(index: &mut MemoIndex, memo_file: &MemoFile, notebook_id: String) {
    let items = memo_file.read_all_memos_with_body_for_notebook_id(Some(&notebook_id));
    index.rebuild(notebook_id, items);
}

pub fn upsert_index_from_store(index: &mut MemoIndex, memo_file: &MemoFile, id: &str) -> bool {
    if !index.is_loaded() {
        return false;
    };
    let Some(location) = memo_file.resolve_memo_location(id).ok().flatten() else {
        return false;
    };
    if index.current_notebook() != Some(location.notebook.id.as_str()) {
        return false;
    }
    let path = std::path::PathBuf::from(location.notebook.path).join(&location.memo.filename);
    let Ok(full_md) = std::fs::read_to_string(path) else {
        return false;
    };
    index.upsert(location.memo, &full_md);
    true
}

pub fn remove_from_index(index: &mut MemoIndex, id: &str) -> bool {
    if !index.is_loaded() {
        return false;
    }
    index.remove(id);
    true
}

pub fn search_notebooks(
    memo_file: &MemoFile,
    configs: &[NotebookConfig],
    notebook_filter: Option<&str>,
    query: &str,
    limit: usize,
) -> NotebookSearchResults {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return NotebookSearchResults {
            query: query.to_string(),
            hits: Vec::new(),
            total: 0,
        };
    }

    let tokenizer = Arc::new(BigramTokenizer);
    let mut hits: Vec<NotebookSearchHit> = Vec::new();

    for notebook in configs.iter().filter(|config| {
        notebook_filter
            .map(|filter| config.id == filter || config.name == filter)
            .unwrap_or(true)
    }) {
        let mut index = MemoIndex::new(tokenizer.clone());
        rebuild_index_from_store(&mut index, memo_file, notebook.id.clone());

        for hit in index.search(query, limit) {
            hits.push(NotebookSearchHit {
                notebook_id: notebook.id.clone(),
                notebook_name: notebook.name.clone(),
                notebook_path: notebook.path.clone(),
                id: hit.id,
                filename: hit.filename,
                snippet: hit.snippet,
                matched_in: hit.matched_in,
                score: hit.score,
                updated_at: hit.updated_at,
            });
        }
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    let total = hits.len();
    hits.truncate(limit);

    NotebookSearchResults {
        query: query.to_string(),
        hits,
        total,
    }
}

fn make_snippet(entry: &SearchIndexEntry, query_lower: &str, field: &MatchField) -> String {
    const SNIPPET_RADIUS: usize = 40;
    const MARK_START: char = '\x01';
    const MARK_END: char = '\x02';
    const ELLIPSIS: &str = "…";

    let source = match field {
        MatchField::Title | MatchField::Tag => entry.preview.as_str(),
        MatchField::Body => entry.body_lower.as_str(),
    };
    if source.is_empty() {
        return String::new();
    }

    // 找 query 在 source 里的首次出现位置 (按 char 索引)
    let q_chars: Vec<char> = query_lower.chars().collect();
    let source_chars: Vec<char> = source.chars().collect();
    let mut hit_pos: Option<usize> = None;
    if !q_chars.is_empty() {
        'outer: for i in 0..source_chars.len() {
            if i + q_chars.len() > source_chars.len() {
                break;
            }
            for j in 0..q_chars.len() {
                if source_chars[i + j] != q_chars[j] {
                    continue 'outer;
                }
            }
            hit_pos = Some(i);
            break;
        }
    }
    let Some(hit_pos) = hit_pos else {
        // 找不到 (理论上 any_match 已经保证能找到, 防御性返回 preview 前 80 字符)
        let preview: String = source_chars.into_iter().take(80).collect();
        return preview;
    };

    let start = hit_pos.saturating_sub(SNIPPET_RADIUS);
    let end = (hit_pos + q_chars.len() + SNIPPET_RADIUS).min(source_chars.len());
    let prefix = if start > 0 { ELLIPSIS } else { "" };
    let suffix = if end < source_chars.len() {
        ELLIPSIS
    } else {
        ""
    };
    let local_hit = hit_pos - start;

    let mut out = String::with_capacity(end - start + q_chars.len() + 4);
    out.push_str(prefix);
    for (i, ch) in source_chars[start..end].iter().enumerate() {
        if i == local_hit {
            out.push(MARK_START);
        }
        if i == local_hit + q_chars.len() {
            out.push(MARK_END);
        }
        out.push(*ch);
    }
    // 收尾: 如果命中区间正好延伸到切片末尾, 补一个 MARK_END
    if local_hit + q_chars.len() >= end - start {
        out.push(MARK_END);
    }
    out.push_str(suffix);
    out
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_entry(
        id: &str,
        filename: &str,
        body: &str,
        tags: Vec<&str>,
        updated_at: i64,
    ) -> (MemoIndexEntry, String) {
        let entry = MemoIndexEntry {
            id: id.to_string(),
            filename: filename.to_string(),
            preview: "preview".to_string(),
            thumbnail: None,
            tags: tags.into_iter().map(String::from).collect(),
            todos: vec![],
            agents: vec![],
            created_at: updated_at,
            updated_at,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        let full_md = format!("---\nfilename: {}\n---\n{}", filename, body);
        (entry, full_md)
    }

    fn fixture_index() -> MemoIndex {
        let tok = Arc::new(BigramTokenizer);
        let mut idx = MemoIndex::new(tok);
        let items = vec![
            mk_entry(
                "m_001",
                "项目周报",
                "今天天气很好,适合写代码 #review",
                vec!["review"],
                1000,
            ),
            mk_entry(
                "m_002",
                "Meeting notes Q2",
                "Discussed roadmap and OKRs for next quarter",
                vec![],
                2000,
            ),
            mk_entry(
                "m_003",
                "读书笔记",
                "禅与摩托车维修艺术,关于 quality 的思考",
                vec!["reading"],
                3000,
            ),
            mk_entry("m_004", "购物清单", "牛奶、面包、鸡蛋", vec![], 4000),
            mk_entry(
                "m_005",
                "今日总结",
                "今天天气一般,代码写了不少",
                vec![],
                5000,
            ),
        ];
        idx.rebuild("nb_test".to_string(), items);
        idx
    }

    #[test]
    fn tokenize_cjk_bigram() {
        let toks = BigramTokenizer.tokens("今天天气");
        assert!(toks.contains(&"今天".to_string()));
        assert!(toks.contains(&"天天".to_string()));
        assert!(toks.contains(&"天气".to_string()));
    }

    #[test]
    fn tokenize_cjk_unigram_fallback() {
        // 长度 1 段也出 unigram
        let toks = BigramTokenizer.tokens("中");
        assert_eq!(toks, vec!["中".to_string()]);
    }

    #[test]
    fn tokenize_ascii_word_split() {
        let toks = BigramTokenizer.tokens("Hello World OKR-2026");
        assert!(toks.contains(&"hello".to_string()));
        assert!(toks.contains(&"world".to_string()));
        assert!(toks.contains(&"okr".to_string()));
        assert!(toks.contains(&"2026".to_string()));
    }

    #[test]
    fn tokenize_mixed_cjk_ascii() {
        let toks = BigramTokenizer.tokens("今天 meeting OKR");
        assert!(toks.contains(&"今天".to_string()));
        assert!(toks.contains(&"meeting".to_string()));
        assert!(toks.contains(&"okr".to_string()));
    }

    #[test]
    fn search_chinese_returns_correct_hits() {
        let idx = fixture_index();
        let hits = idx.search("今天天气", 10);
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert!(ids.contains(&"m_001"));
        assert!(ids.contains(&"m_005"));
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn search_english_case_insensitive() {
        let idx = fixture_index();
        let hits = idx.search("ROADMAP", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "m_002");
    }

    #[test]
    fn search_title_match_outranks_body() {
        let idx = fixture_index();
        let hits = idx.search("读书笔记", 10);
        assert_eq!(hits[0].id, "m_003");
        assert_eq!(hits[0].matched_in, MatchField::Title);
        assert!(hits[0].score >= 10.0);
    }

    #[test]
    fn search_bigram_false_positive_rejected() {
        // body 只含 "abc def", 查 "bcde" — bc/de 两个 bigram 都不存在, 不命中
        let mut idx = MemoIndex::new(Arc::new(BigramTokenizer));
        idx.rebuild(
            "nb".to_string(),
            vec![mk_entry("m_x", "x", "abc def", vec![], 0)],
        );
        assert_eq!(idx.search("bcde", 10).len(), 0);
    }

    #[test]
    fn search_cross_token_intersection() {
        // "今天" + "天气" — 两个 token 都得在同一篇 memo 里出现
        let idx = fixture_index();
        let hits = idx.search("今天 天气", 10);
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert!(ids.contains(&"m_001"));
        assert!(ids.contains(&"m_005"));
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let idx = fixture_index();
        assert!(idx.search("", 10).is_empty());
        assert!(idx.search("   ", 10).is_empty());
    }

    #[test]
    fn search_limit_truncates() {
        let idx = fixture_index();
        let hits = idx.search("今天", 1);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn snippet_contains_markers() {
        let idx = fixture_index();
        let hits = idx.search("禅与", 10);
        assert!(hits[0].snippet.contains('\x01'));
        assert!(hits[0].snippet.contains('\x02'));
        assert!(hits[0].snippet.contains("禅与"));
    }

    #[test]
    fn snippet_is_utf8_safe() {
        // 中文 4 字节 UTF-8 切片, 不能在字节边界切
        let mut idx = MemoIndex::new(Arc::new(BigramTokenizer));
        idx.rebuild(
            "nb".to_string(),
            vec![mk_entry(
                "m_zh",
                "中文",
                "这是一段非常非常非常非常长的中文内容,用来测试 snippet 在字符边界附近切片",
                vec![],
                0,
            )],
        );
        let hits = idx.search("中文内容", 10);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("中文内容"));
    }

    #[test]
    fn upsert_then_search_finds_new_doc() {
        let mut idx = fixture_index();
        idx.upsert(
            MemoIndexEntry {
                id: "m_new".to_string(),
                filename: "新增".to_string(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: 9999,
                updated_at: 9999,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            },
            "---\nfilename: 新增\n---\n这是新内容,神奇",
        );
        let hits = idx.search("神奇", 10);
        assert_eq!(hits[0].id, "m_new");
    }

    #[test]
    fn upsert_replaces_old_tokens() {
        // 先有 m_z, body 含 "alpha"; upsert 改成 "beta", 不应再命中 "alpha"
        let mut idx = MemoIndex::new(Arc::new(BigramTokenizer));
        idx.rebuild(
            "nb".to_string(),
            vec![mk_entry("m_z", "z", "alpha content here", vec![], 0)],
        );
        assert_eq!(idx.search("alpha", 10).len(), 1);

        idx.upsert(
            MemoIndexEntry {
                id: "m_z".to_string(),
                filename: "z".to_string(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: 0,
                updated_at: 0,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            },
            "---\nfilename: z\n---\nbeta content here",
        );
        assert_eq!(idx.search("alpha", 10).len(), 0);
        assert_eq!(idx.search("beta", 10).len(), 1);
    }

    #[test]
    fn remove_drops_doc_from_results() {
        let mut idx = fixture_index();
        idx.remove("m_001");
        let hits = idx.search("今天天气", 10);
        assert!(hits.iter().all(|h| h.id != "m_001"));
    }

    #[test]
    fn mark_unloaded_clears_state() {
        let mut idx = fixture_index();
        assert!(idx.is_loaded());
        idx.mark_unloaded();
        assert!(!idx.is_loaded());
        assert!(idx.search("今天", 10).is_empty());
        assert_eq!(idx.current_notebook(), None);
    }

    #[test]
    fn upsert_when_unloaded_is_noop() {
        let mut idx = MemoIndex::new(Arc::new(BigramTokenizer));
        idx.upsert(
            MemoIndexEntry {
                id: "m_x".to_string(),
                filename: "x".to_string(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: 0,
                updated_at: 0,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            },
            "hello",
        );
        assert!(idx.search("hello", 10).is_empty());
    }
}
