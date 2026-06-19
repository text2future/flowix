//! Memo CRUD 原语 — index.json 始终是全量索引的真源。
//!
//! 物理文件: `<notebook>/<filename>.md`, `filename` 即 index.json entry.filename。
//! 命名规则:
//! - 文件名由 `sanitize(title)` 派生, 后缀恒为 `.md`。
//! - 同 title 冲突时自动追加 `-1` / `-2` / ... (不去重 id 段, 6 位 shortid
//!   仅作为 index.json 的内部 key, 不再出现在文件名)。
//! - id 仍由 `generate_memo_id` 6 位 nanoid 生成, 字符集 `[0-9a-z]`。
//!
//! 所有写路径 (UI / Agent / 外部工具 / 文件监听器) 都过本模块, 唯一入口。
//! 跨 IPC 边界的 `Memo` / `MemoIndexEntry` 字段语义: `filename` 存磁盘文件名
//! (含 `.md`); 前端展示时去后缀; 旧版 `path` 字段删除。
//!
//! ## 锁模型
//!
//! 写路径 (`create` / `rename` / `write` / `delete` / `register_*` / `reconcile`)
//! 持有 `current_index_io` Mutex, 跨 "rename 物理文件 + 写 index.json" 全过程,
//! 串行化 index.json RMW, 杜绝 lost update。`std::sync::Mutex` 不可重入,
//! 内部 _locked 变体跳过自拿锁。

use std::fs;
use std::path::{Path, PathBuf};

use super::derivation::{apply_derived_memo_fields, extract_title_and_preview};
use super::frontmatter::{build_md_content, merge_frontmatter, MergeOverrides};
use super::types::{Memo, ReconcileReport};
use super::MemoFile;

/// title 派生 fallback: 空 body / 不可见首行时用 `untitled-YYYY-MM-DD`。
fn fallback_filename(now: chrono::DateTime<chrono::Local>) -> String {
    format!("{}.md", now.format("untitled-%Y-%m-%d"))
}

/// title 清洗: 替换文件系统非法字符 `\ / : * ? " < > |` 为空格,
/// 截到 200 字符, 去尾随 `.` (Windows 不接受 `name.`)。
pub fn sanitize_filename_component(title: &str) -> String {
    let mut sanitized: String = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            other => other,
        })
        .take(200)
        .collect();
    sanitized = sanitized.trim().to_string();
    if sanitized.ends_with('.') {
        sanitized.pop();
        sanitized.push(' ');
    }
    sanitized.trim().to_string()
}

/// 算基准 filename (不含冲突后缀): `<sanitized>.md`。
/// 空 title 时用 `untitled-YYYY-MM-DD.md` 兜底。
pub fn base_filename(title: &str) -> String {
    let sanitized = sanitize_filename_component(title);
    if sanitized.is_empty() {
        fallback_filename(chrono::Local::now())
    } else {
        sanitized
    }
}

/// 冲突检测: 在 base 目录下, `candidate.md` 是否已存在, 或已被 index.json
/// 某条 entry 占用。 任意一种情况都视为冲突, 自动追加 `-1` / `-2` / ...。
///
/// 关键: 之前只看 `fs::exists` 是不够的 ── 两次并发 `create_memo` 在
/// `current_index_io` 锁内串行, 但 `resolve_filename_conflict` 不读
/// index.json, 导致两个不同 id 写到同一个磁盘文件 (前一个 entry 的
/// filename 跟后一个冲突但磁盘文件已存在 → 仍报 "不冲突", 后一个
/// 覆盖前一个文件)。 现在加 index.json 维度, 跟 `apply_derived_memo_fields`
/// / `sync_index_on_write` 走同一真源。
pub fn resolve_filename_conflict(
    base: &Path,
    candidate_base: &str,
    occupied_filenames: &[String],
) -> String {
    let primary = format!("{candidate_base}.md");
    if !base.join(&primary).exists() && !occupied_filenames.contains(&primary) {
        return primary;
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{candidate_base}-{n}.md");
        if !base.join(&candidate).exists() && !occupied_filenames.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// `.md` / `.markdown` 后缀判定 (大小写不敏感)。
pub trait IsMd {
    fn is_md(&self) -> bool;
}

impl IsMd for Path {
    fn is_md(&self) -> bool {
        self.extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let lower = e.to_ascii_lowercase();
                lower == "md" || lower == "markdown"
            })
            .unwrap_or(false)
    }
}

/// 原子写: temp file + fsync + rename ── 中途崩溃看到的永远是完整旧文件或
/// 完整新文件。跟 `index_store::atomic_write_json` 同源, 推广到任意路径 + bytes
/// 供 `.md` 写路径复用。
///
/// Windows 上 `MoveFileExW + MOVEFILE_REPLACE_EXISTING` 跨同一目录是原子;
/// `dunce::canonicalize` 去除 `\\?\` UNC 前缀, 确保 tmp 与 final 落在同一
/// canonical 根下, 否则跨盘符 rename 会失败。`canonicalize` 失败时 (文件
/// 还没创建 ── e.g. 全新 register_existing_file 场景) 退回原路径, 这时
/// rename 在同一目录下仍然原子。
pub fn atomic_write_bytes(final_path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let final_path = dunce::canonicalize(final_path).unwrap_or_else(|_| final_path.to_path_buf());
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = final_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 跟 `flowix-desktop::fs_watcher::normalize_for_compare` 同口径的路径归一。
fn normalize_for_compare(path: &Path) -> PathBuf {
    if let Ok(canon) = dunce::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}

impl MemoFile {
    /// 生成一个新的 6 位 memo id (字符集 `[0-9a-z]`)。同 id 已存在时循环重抽。
    pub fn generate_memo_id(&self) -> String {
        loop {
            let id = nanoid::nanoid!(6, &super::MEMO_ID_ALPHABET);
            if self.read_memo(&id).is_none() {
                return id;
            }
        }
    }

    /// 公开 title 清洗工具: 供 index_store 复用, 行为等同 `sanitize_filename_component`。
    pub fn sanitize_memo_filename_component(title: &str) -> String {
        sanitize_filename_component(title)
    }

    /// 创建一个 memo: 写 .md + 写 index.json。返回新建的 Memo (含 id / filename)。
    pub fn create_memo(&self, title: &str, body: &str, tag: Option<&str>) -> std::io::Result<Memo> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;

        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let base = self.get_memo_base();
        let candidate = base_filename(title);
        // 读 index.json 拿已占用 filenames ── 跟 `fs::exists` 双维度检测冲突,
        // 杜绝并发 create_memo 写到同一文件 (前一个 entry 已 index.json
        // 但磁盘文件被覆盖)。
        let occupied: Vec<String> = self
            .read_index()
            .map(|l| l.memos.into_iter().map(|e| e.filename).collect())
            .unwrap_or_default();
        let filename = resolve_filename_conflict(&base, &candidate, &occupied);

        let final_body = match tag {
            Some(t) if !t.is_empty() => {
                if body.is_empty() {
                    format!("#{}", t)
                } else {
                    format!("{}\n#{}", body, t)
                }
            }
            _ => body.to_string(),
        };

        let path = base.join(&filename);
        if let Err(e) = (|| -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            atomic_write_bytes(&path, build_md_content(&id, &final_body).as_bytes())
        })() {
            return Err(e);
        }

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            tags: vec![],
            todos: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
        };
        let initial_content = build_md_content(&id, &final_body);
        apply_derived_memo_fields(&mut memo, &initial_content);
        MemoFile::sync_index_on_write_locked(self, &memo)?;
        Ok(memo)
    }

    /// 改名: 物理文件可能 rename, index.json entry.filename 同步更新。
    /// `new_title` 为空字符串时**不**重命名, 仅刷新派生字段 (no-op)。
    /// 冲突自动追加 `-1` / `-2`。
    pub fn rename_memo(&self, id: &str, new_title: &str) -> std::io::Result<Memo> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;

        let mut memo = self.read_memo(id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let old_filename = memo.filename.clone();

        let old_base = old_filename.strip_suffix(".md").unwrap_or(&old_filename);
        let new_candidate = base_filename(new_title);
        let new_filename = if new_candidate == old_base {
            old_filename.clone()
        } else {
            let base = self.get_memo_base();
            // 锁内读 index.json: 跟 create_memo 同款, 排除本 memo 自身
            // (rename 自己的 entry 也占着 old_filename, 不应触发冲突)。
            let occupied: Vec<String> = self
                .read_index()
                .map(|l| {
                    l.memos
                        .into_iter()
                        .filter(|e| e.id != memo.id)
                        .map(|e| e.filename)
                        .collect()
                })
                .unwrap_or_default();
            resolve_filename_conflict(&base, &new_candidate, &occupied)
        };

        if new_filename != old_filename {
            let old_path = self.get_memo_base().join(&old_filename);
            let new_path = self.get_memo_base().join(&new_filename);
            if old_path.exists() {
                fs::rename(&old_path, &new_path)?;
            }
        }

        let path = self.get_memo_base().join(&new_filename);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&path, new_content.as_bytes())?;

        memo.filename = new_filename;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &new_content);
        MemoFile::sync_index_on_write_locked(self, &memo)?;
        Ok(memo)
    }

    /// 写入 body (不改 title)。物理文件不 rename, 仅重写 .md + 同步 index.json 派生字段。
    pub fn write_memo(&self, id: &str, body: &str) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;
        self.write_memo_inner_locked(id, body)
    }

    /// 无锁版本的 [`Self::write_memo`]。调用方已持 `current_index_io` 锁。
    /// 抽出供 [`Self::write_memo_renaming_on_title_change`] 单事务合用。
    fn write_memo_inner_locked(&self, id: &str, body: &str) -> std::io::Result<Memo> {
        let mut memo = self.read_memo(id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        let path = self.get_memo_base().join(&memo.filename);
        atomic_write_bytes(&path, merged.as_bytes())?;

        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &merged);
        MemoFile::sync_index_on_write_locked(self, &memo)?;
        Ok(memo)
    }

    /// 写 body, 并从最终磁盘内容抽首行 title, 若跟当前 filename 不一致
    /// 触发物理 rename + index.json 同步。整段持单把 `current_index_io` 锁,
    /// 杜绝 "write_memo 释放锁后 fs_watcher 误判外部改名" 的窗口期。
    ///
    /// title 派生走 [`extract_title_and_preview`] ── 跟 index.json `preview`
    /// / `tags` / `todos` 同一流水线, 同源派生。空 body / 不可见首行时
    /// 派生 title 为空, 跳过改名 (避免把已有 title 改回 `untitled-` 兜底)。
    ///
    /// 调用方: `commands::memo::write_document` (Tiptap 编辑保存 IPC 入口)。
    pub fn write_memo_renaming_on_title_change(
        &self,
        id: &str,
        body: &str,
    ) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;

        // 先 write_memo (含 key 注入 + index.json 同步)
        let memo = self.write_memo_inner_locked(id, body)?;

        // 抽最终磁盘内容(同锁内, 写盘已完成, 文件可读)
        let path = self.get_memo_base().join(&memo.filename);
        let final_content = fs::read_to_string(&path).unwrap_or_default();
        let (derived_title, _) = extract_title_and_preview(&final_content);
        if derived_title.is_empty() {
            return Ok(memo);
        }

        // 跟当前 index.json.filename 比对, 变了 → 复用 rename_memo 同款判定
        let old_base = memo
            .filename
            .strip_suffix(".md")
            .unwrap_or(&memo.filename)
            .to_string();
        let new_candidate = base_filename(&derived_title);
        if new_candidate == old_base {
            return Ok(memo);
        }

        // 走跟 rename_memo 完全相同的派生 + 物理 rename + index.json 同步路径
        // 锁内读 index.json 排除本 memo 自身, 跟 create_memo / rename_memo
        // 同源。
        let occupied: Vec<String> = self
            .read_index()
            .map(|l| {
                l.memos
                    .into_iter()
                    .filter(|e| e.id != memo.id)
                    .map(|e| e.filename)
                    .collect()
            })
            .unwrap_or_default();
        let new_filename =
            resolve_filename_conflict(&self.get_memo_base(), &new_candidate, &occupied);
        let old_filename = memo.filename.clone();
        if new_filename != old_filename {
            let old_path = self.get_memo_base().join(&old_filename);
            let new_path = self.get_memo_base().join(&new_filename);
            if old_path.exists() {
                fs::rename(&old_path, &new_path)?;
            }
        }

        // 重写新路径的 frontmatter, 锁内保证 frontmatter key == id
        let new_path = self.get_memo_base().join(&new_filename);
        let existing = fs::read_to_string(&new_path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&new_path, new_content.as_bytes())?;

        let mut updated = memo;
        updated.filename = new_filename;
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut updated, &new_content);
        MemoFile::sync_index_on_write_locked(self, &updated)?;
        Ok(updated)
    }

    /// 删除: 删 .md + index.json 移除 entry。
    /// 物理文件已不在 (例如外部 `rm`) 但 index.json 仍残留 → 清 list, 视为成功。
    /// 完全找不到 (list 也没有) → false。
    pub fn delete_memo(&self, id: &str) -> bool {
        self.delete_memo_result(id).unwrap_or(false)
    }

    /// 删除并返回真实 IO 结果。
    ///
    /// 保留 [`Self::delete_memo`] 的布尔兼容 API，CLI/JSON-RPC 使用本方法避免
    /// 把 remove/index 写入失败伪装成成功。
    pub fn delete_memo_result(&self, id: &str) -> std::io::Result<bool> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let path = self
            .read_memo(id)
            .map(|m| self.get_memo_base().join(&m.filename));

        let removed = match path {
            Some(p) if p.exists() => {
                fs::remove_file(&p)?;
                true
            }
            _ => {
                // 物理文件已无, 但 index.json 仍残留 → 兜底清 list
                self.read_memo(id).is_some()
            }
        };
        if removed {
            MemoFile::sync_index_on_delete_locked(self, id)?;
        }
        Ok(removed)
    }

    /// 把磁盘上已存在的 .md 注册为 memo, **不**重命名磁盘文件, **不**覆盖 body。
    /// 失败: 路径非 .md; 文件不存在; 文件名已在 index.json 走 reload 路径 (不重复 push)。
    ///
    /// Rename/reconcile 入口: 如果文件 frontmatter 里已有 `key: <id>` 字段, 以磁盘
    /// key 为真相修复 index.json。
    ///
    /// - key 命中已有 entry 且 filename 不同: 视为物理 rename, 保留 id 并更新 filename。
    /// - key 不在 index.json: 用磁盘 key 重建 entry, 用于启动/切换 notebook 对账。
    /// - 无 key: 生成新 id 并写入 frontmatter。
    ///
    /// 粘贴/复制导入不要走这个函数, 应走 `register_existing_file_as_new`, 以免沿用
    /// 被复制文件的 key。
    pub fn register_existing_file(&self, abs_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if self.find_memo_by_filename(&filename).is_some() {
            drop(_index_io_guard);
            return self.reload_memo_from_disk_by_filename(&filename);
        }

        // v2: 优先从 frontmatter 抽 key 反查 index.json, 命中则改 filename 保留 id。
        // 三种情况, 都是用磁盘 frontmatter key 当真相, 不生成新 id:
        // (a) read_memo 命中 + filename 不一致 → inode tracker 漏命中 / Windows 场景
        //     走 rename_memo_file 改 entry.filename
        // (b) read_memo 命中 + filename 一致 → 幂等, 不做任何事
        // (c) read_memo 没命中 (index.json 已被前面的 Remove 事件清掉) → 用磁盘 key
        //     重建 index.json entry, 这是 "Remove + Create 配对" 场景下避免 id 漂移的关键
        //     路径: 删了的 entry 仍然能靠磁盘 frontmatter key 复活, id 不变。
        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_memo(&existing_id) {
                if existing_memo.filename != filename {
                    // (a) 走 rename_memo_file 改 entry.filename, id 保留
                    drop(_index_io_guard);
                    return self.rename_memo_file(
                        &self.get_memo_base().join(&existing_memo.filename),
                        abs_path,
                    );
                }
                // (b) filename 一致: 幂等 no-op, 不重新生成
                return Ok(existing_memo);
            }
            // (c) read_memo 没命中: 重建 index.json entry, 保留磁盘 key 对应的 id
            // 物理文件已存在 (前面 if !abs_path.exists() 早返回), 跳到下方
            // "let id = existing_id" 分支处理 (替换原来的 generate_memo_id)。
            let id = existing_id;
            let now = chrono::Utc::now().timestamp_millis();
            // 磁盘 frontmatter 已经有正确的 key, 不需要再 merge_frontmatter 写盘。
            let mut memo = Memo {
                id: id.clone(),
                filename: filename.clone(),
                preview: String::new(),
                tags: vec![],
                todos: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
            };
            apply_derived_memo_fields(&mut memo, &content);
            MemoFile::sync_index_on_write_locked(self, &memo)
                .map_err(|e| format!("sync index.json failed: {e}"))?;
            return Ok(memo);
        }

        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();

        // 把生成的 key 就地注入到 frontmatter 块: 有 key 行就替换,
        // 没有就追加 (头部)。其它字段 (用户手写的 tags / description /
        // 注释 / 空行) 字节级保留。
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            tags: vec![],
            todos: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }

    /// 把**任意命名**的 .md 注册为 memo。v3 行为等同 `register_existing_file`:
    /// 原文件名入 index.json, **不**重命名磁盘文件 (保留外部工具句柄)。
    /// 返回 `(Memo, abs_path)` 以兼容旧调用方, abs_path 即原 `abs_path`。
    pub fn register_unnamed_file(&self, abs_path: &Path) -> Result<(Memo, PathBuf), String> {
        let memo = self.register_existing_file(abs_path)?;
        Ok((memo, abs_path.to_path_buf()))
    }

    /// Copy/import 入口: 把磁盘上的 .md 按“新文档”注册，忽略已有 frontmatter
    /// `key` 并写入新 key。
    ///
    /// 粘贴/复制导入的文件可能带着另一个 memo 的 key。此时不能按 rename 处理，
    /// 否则会把原 memo 的 index entry 移到新文件名上，而不是创建副本。
    pub fn register_existing_file_as_new(&self, abs_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if self.find_memo_by_filename(&filename).is_some() {
            drop(_index_io_guard);
            return self.reload_memo_from_disk_by_filename(&filename);
        }

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename,
            preview: String::new(),
            tags: vec![],
            todos: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }

    /// 无锁版本的 [`Self::register_existing_file`]。调用方**必须**已持有
    /// `current_index_io` 锁, 函数内不再 lock, 避免自重入死锁
    /// (`std::sync::Mutex` 不可重入)。
    ///
    /// 调用方约束: `abs_path` 的 `filename` 必须**不在** index.json (已被
    /// `reconcile_with_disk_bidirectional` 之类用集合差过滤过)。函数内不再走
    /// `find_memo_by_filename → reload_memo_from_disk` 的早期返回分支。
    ///
    /// 行为:
    /// - 磁盘 frontmatter 含 `key: <id>` 且 index.json 已存在同 id 的另一条 entry
    ///   (意味着 inode-tracker 漏命中场景: entry.filename != 当前 filename) →
    ///   走 `rename_memo_file_locked` 改 entry.filename, **保留 id**。
    /// - 磁盘 frontmatter 含 `key: <id>` 且 index.json 没记录 → 用磁盘 key 作为 id
    ///   重建 entry, 避免 id 漂移。
    /// - 磁盘无 key → 生成新 id, 通过 `merge_frontmatter` 注入到文件头。
    fn register_existing_file_locked(&self, abs_path: &Path) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_memo(&existing_id) {
                // 调用方已保证 filename 不在 index.json; 如果这里命中 read_memo,
                // 说明 entry 的 filename 跟当前不一致 (inode-tracker 漏命中场景),
                // 走 rename_memo_file_locked 保留 id, 改 entry.filename 为当前 filename。
                return self.rename_memo_file_locked(
                    &self.get_memo_base().join(&existing_memo.filename),
                    abs_path,
                );
            }
            // read_memo 没命中: 重建 entry, 用磁盘 frontmatter key 作为 id
            let id = existing_id;
            let now = chrono::Utc::now().timestamp_millis();
            let mut memo = Memo {
                id: id.clone(),
                filename: filename.clone(),
                preview: String::new(),
                tags: vec![],
                todos: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
            };
            apply_derived_memo_fields(&mut memo, &content);
            MemoFile::sync_index_on_write_locked(self, &memo)
                .map_err(|e| format!("sync index.json failed: {e}"))?;
            return Ok(memo);
        }

        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();

        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            tags: vec![],
            todos: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }

    /// 无锁版本的 [`Self::rename_memo_file`]。调用方**必须**已持有
    /// `current_index_io` 锁。
    fn rename_memo_file_locked(&self, old_path: &Path, new_path: &Path) -> Result<Memo, String> {
        let old_filename = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid old path: {}", old_path.display()))?
            .to_string();
        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();

        let mut memo = match self.find_memo_by_filename(&old_filename) {
            Some(m) => m.clone(),
            None => return Err(format!("old filename not in index.json: {old_filename}")),
        };
        let id = memo.id.clone();

        let base = self.get_memo_base();
        let expected_old_abs = base.join(&old_filename);
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        if let Some(existing) = self.find_memo_by_filename(&new_filename) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        memo.filename = new_filename.clone();
        let new_abs = base.join(&new_filename);
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        let now = chrono::Utc::now().timestamp_millis();
        memo.updated_at = now;

        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }

    /// 启动 / 切 notebook 时调用: 扫当前 notebook 根目录 .md, 把 index.json 没记录的补进来。
    /// **不**重命名磁盘文件, 保留外部工具的句柄。
    /// 跳过 `.metadata/` 目录; 已在 index.json 里的 .md 跳过 (按 filename 精确比对)。
    pub fn reconcile_with_disk(&self) -> Result<usize, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(0);
        }
        let entries = match fs::read_dir(&base) {
            Ok(e) => e,
            Err(e) => return Err(format!("read_dir failed: {e}")),
        };

        let known_filenames: std::collections::HashSet<String> = self
            .read_index()
            .map(|l| l.memos.into_iter().map(|e| e.filename).collect())
            .unwrap_or_default();

        // 收齐所有候选文件, 排完序再批量注册, 减少锁反复获取。
        let mut to_register: Vec<PathBuf> = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() || !path.is_md() {
                continue;
            }
            if path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                == Some(".metadata")
            {
                continue;
            }
            let filename = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if known_filenames.contains(&filename) {
                continue;
            }
            to_register.push(path);
        }
        drop(_index_io_guard);

        let mut added = 0usize;
        for path in to_register {
            if self.register_existing_file(&path).is_ok() {
                added += 1;
            }
        }
        Ok(added)
    }

    /// 双向对账: 注册 index.json 缺失的 .md **同时**清理指向已不存在文件的
    /// 幽灵条目 (index.json 里有但磁盘上无对应 .md)。
    ///
    /// 设计动机:
    /// - [`Self::reconcile_with_disk`] 纯加法 — 应用关闭期间被外部 `rm` /
    ///   同步盘删除的 .md, index.json 里的 entry 永远不会被清, 影响列表 /
    ///   tag 聚合 / 筛选正确性。
    /// - 删方向用「`disk_filenames - list_filenames`」反向集合差, 不需要 stat
    ///   每个 index.json entry; 10K memos 时一次 read_dir + 集合差 <500ms,
    ///   比 10K 次 stat 快一个数量级。
    /// - 单锁单 RMW: 整个函数在 `current_index_io` 锁内完成, 跟 IPC 写 / watcher
    ///   处理路径互斥, 不存在并发漂移。
    ///
    /// 调用方:
    /// - [`crate::commands::helpers::switch_notebook_and_rebuild`] (替换原来的
    ///   `reconcile_with_disk` 调用)
    /// - [`crate::lib::run`] `.setup()` 阶段启动不变量
    ///
    /// 幂等: `added == 0 && removed == 0` 时是 no-op。
    ///
    /// 实现注意: 注册阶段 (`register_existing_file_locked` 内部走
    /// `sync_index_on_write_locked`) 会改写 index.json on disk, 我们局部
    /// 持有的 `list` 副本会过时。 因此**注册完后必须重新读 index.json**, 再
    /// 算 prune 的差集 — 否则会把注册阶段刚加的 entry 误当成幽灵条目删掉。
    pub fn reconcile_with_disk_bidirectional(&self) -> Result<ReconcileReport, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(ReconcileReport::default());
        }

        // 1. 单次 read_dir: 收齐磁盘上所有 .md 文件名 (跳过 `.metadata/`)
        let disk_filenames: std::collections::HashSet<String> = match fs::read_dir(&base) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter_map(|entry| {
                    let path = entry.path();
                    if !path.is_file() || !path.is_md() {
                        return None;
                    }
                    if path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        == Some(".metadata")
                    {
                        return None;
                    }
                    path.file_name().and_then(|n| n.to_str()).map(String::from)
                })
                .collect(),
            Err(e) => return Err(format!("read_dir failed: {e}")),
        };

        // 2. 读 index.json (锁内, 仅用作算 to_register; 注册后会再读一次)
        let initial_list = self.read_index().unwrap_or_default();

        // 3. 算「需要注册」的文件名集合
        let to_register: Vec<String> = disk_filenames
            .iter()
            .filter(|f| !initial_list.memos.iter().any(|e| &e.filename == *f))
            .cloned()
            .collect();

        // 4. 串行注册新文件; 单条失败仅记 warn 不中断整批
        let mut added = 0usize;
        for filename in &to_register {
            let path = base.join(filename);
            match self.register_existing_file_locked(&path) {
                Ok(_) => added += 1,
                Err(e) => tracing::warn!(
                    "[reconcile_with_disk_bidirectional] register {} failed: {e}",
                    filename
                ),
            }
        }

        // 5. 重新读 index.json — 注册阶段 (含可能的 inode-rename 走
        //    rename_memo_file_locked) 已改写过磁盘, 局部 `initial_list` 已过时。
        //    基于磁盘最新状态算 prune 差集, 避免误删刚注册的 entry。
        let mut list = self.read_index().unwrap_or_default();
        let before = list.memos.len();
        list.memos.retain(|e| disk_filenames.contains(&e.filename));
        let removed = before - list.memos.len();
        if removed > 0 {
            list.last_updated = chrono::Utc::now().timestamp_millis();
            self.write_index(&list)
                .map_err(|e| format!("write_index failed: {e}"))?;
        }

        Ok(ReconcileReport { added, removed })
    }

    /// 重新读 .md 派生 preview / tags / todos, 同步到 index.json。
    pub fn reload_memo_from_disk(&self, id: &str) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let memo = self
            .read_memo(id)
            .ok_or_else(|| format!("memo {id} not in index.json"))?;
        self.reload_memo_inner_locked(memo)
    }

    /// 同 `reload_memo_from_disk`, 但定位用 `filename`。
    pub fn reload_memo_from_disk_by_filename(&self, filename: &str) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let memo = self
            .find_memo_by_filename(filename)
            .ok_or_else(|| format!("memo with filename {filename} not in index.json"))?;
        self.reload_memo_inner_locked(memo)
    }

    fn reload_memo_inner_locked(&self, mut memo: Memo) -> Result<Memo, String> {
        let path = self.get_memo_base().join(&memo.filename);
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &content);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }

    /// 按 filename 在 index.json 找 entry, 返回 Memo。
    pub fn find_memo_by_filename(&self, filename: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .into_iter()
            .find(|e| e.filename == filename)
            .map(|e| MemoFile::index_entry_to_memo(&e))
    }

    /// 按 id 找 memo 物理文件绝对路径。文件可能已不在 (返回路径不保证存在)。
    pub fn find_memo_file_path(&self, id: &str) -> Option<PathBuf> {
        let memo = self.read_memo(id)?;
        Some(self.get_memo_base().join(&memo.filename))
    }

    /// 按 filename 拼绝对路径。
    pub fn file_path_for(&self, filename: &str) -> PathBuf {
        self.get_memo_base().join(filename)
    }

    /// 同步 index.json 中某条 memo 的非文件字段 (favorited / colors / icon 等)。
    /// 不动磁盘文件, 不重写派生字段 (preview / tags / todos)。
    pub fn sync_metadata_only(&self, memo: &Memo) -> std::io::Result<()> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        MemoFile::sync_index_on_write_locked(self, memo)
    }

    /// 按绝对路径找 index.json entry 并移除 (index.json 同步)。物理文件删除由 caller 负责。
    /// 防御性 invariant guard: entry.filename 拼出的绝对路径规范化后, 跟 `abs_path`
    /// 规范化相等才删 (避免 rename 旧文件 Remove 事件误删 entry)。
    pub fn unregister_memo_by_path(&self, abs_path: &Path) -> bool {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        let Some(filename) = filename else {
            return false;
        };
        let Some(memo) = self.find_memo_by_filename(&filename) else {
            return false;
        };
        let expected_abs = self.get_memo_base().join(&memo.filename);
        if normalize_for_compare(&expected_abs) != normalize_for_compare(abs_path) {
            tracing::debug!(
                "[unregister_memo_by_path] refused: index.json entry.filename={} but abs_path={}",
                expected_abs.display(),
                abs_path.display()
            );
            return false;
        }
        MemoFile::sync_index_on_delete_locked(self, &memo.id).is_ok()
    }

    /// 物理 rename 同步: 把 index.json entry 从 old_filename 改成 new_filename,
    /// **保留 id**。 物理文件已由调用方 (OS / 用户) 搬好, 我们不动磁盘。
    ///
    /// 跟 `unregister_memo_by_path` + `register_existing_file` 的"双 register"
    /// 区别: 后者会生成**新** id, 把同一份磁盘内容当新 memo 入库;
    /// rename_memo_file 保留 id, 让 index.json 跟着物理 mv 走, 触发
    /// `MemoEvent::Updated` (id 永不变, 前端 store 按 id patch 即可)。
    ///
    /// 失败条件:
    /// - old_filename 不在 index.json (没记录)
    /// - new_filename 已在 index.json (新路径被另一条 entry 占用, 防覆盖)
    /// - new_filename 不是 .md 后缀
    /// - 任一路径规范化后不在当前 notebook base 下
    ///
    /// 物理文件 invariant: 调用方负责保证 new_path 实际指向同 id 的内容
    /// (即 OS 层 mv 已经完成)。 我们只更新 index.json 索引。
    pub fn rename_memo_file(&self, old_path: &Path, new_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let old_filename = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid old path: {}", old_path.display()))?
            .to_string();
        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();

        // 1. 找旧 entry
        let mut memo = match self.find_memo_by_filename(&old_filename) {
            Some(m) => m.clone(),
            None => return Err(format!("old filename not in index.json: {old_filename}")),
        };
        let id = memo.id.clone();

        // 2. 旧路径在不在当前 notebook base 下 (规范化检查)
        let base = self.get_memo_base();
        let expected_old_abs = base.join(&old_filename);
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        // 3. new_filename 后缀必须是 .md / .markdown
        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        // 4. new_filename 不能已在 index.json (会跟另一条 entry 撞名)
        if let Some(existing) = self.find_memo_by_filename(&new_filename) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        // 5. 改 entry.filename + 重新派生 preview / tags / todos (frontmatter 跟着物理文件
        //    一起被 mv 搬过来了, 重新读)
        memo.filename = new_filename.clone();
        let new_abs = base.join(&new_filename);
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        let now = chrono::Utc::now().timestamp_millis();
        memo.updated_at = now;

        // 6. 同步 index.json (沿用 sync_index_on_write_locked, 它走 filename 做索引)
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync index.json failed: {e}"))?;
        Ok(memo)
    }
}
