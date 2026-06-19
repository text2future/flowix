//! `index.json` / `memo.json` IO + 同步方法 — 维护 `.metadata/` 下两个元数据文件。
//!
//! - `index.json` — 全部 memo 的 metadata 数组 (`MemoIndexEntry`)。`filename` 字段
//!   即磁盘文件名 (含 `.md` 后缀); 物理路径运行时拼。这是 `get_memos` /
//!   `search_memos` / `read_memo` 的真源, .md 文件 body 不在此缓存。
//! - `memo.json` — 跨 memo 的派生索引, 当前只存 `MemoTodoEntry` 列表 (按 memo_id
//!   索引, 用于 list 过滤 `todos`)。规模小, 全量 rewrite 无压力。
//!
//! 写策略: 单条 memo 写 → 整文件 read-modify-write, 通过临时文件 + rename
//! 原子落盘。
//!
//! ## 锁约定
//!
//! `_locked` 变体**不**自己拿 `current_index_io` Mutex, 由调用方 (ops /
//! `update_memo_item`) 持锁后再调, 避免 `std::sync::Mutex` 不可重入死锁。

use std::fs;

use super::types::{Memo, MemoIndexEntry, MemoIndexFile, MemoMetadataFile, MemoTodoEntry};
use super::MemoFile;

/// `<notebook>/.metadata/` 下保存 memo metadata 数组的文件名。
///
/// 真源路径由 [`MemoFile::get_index_path`] 拼 (base + .metadata + 本常量)。
/// IPC `commands::memo::get_index_filename` 暴露给前端, 避免前端硬编码。
pub const MEMO_INDEX_FILENAME: &str = "index.json";

impl MemoFile {
    pub fn storage_title_from_filename(filename: &str) -> String {
        // v3: filename 已是磁盘文件名 (含 .md), 直接去后缀。
        let stem = filename.strip_suffix(".md").unwrap_or(filename).to_string();
        let safe_title = Self::sanitize_memo_filename_component(&stem);
        if safe_title.is_empty() {
            chrono::Local::now().format("untitled-%Y-%m-%d").to_string()
        } else {
            safe_title
        }
    }

    pub fn get_index_path(&self) -> std::path::PathBuf {
        self.get_metadata_dir().join("index.json")
    }

    pub fn get_memo_json_path(&self) -> std::path::PathBuf {
        self.get_metadata_dir().join("memo.json")
    }

    pub fn read_index(&self) -> Option<MemoIndexFile> {
        // 见 [`MemoFile::current_index_io`] ── 调用方**必须**已持有
        // `current_index_io` 锁再调本函数 (高层 RMW 包装:
        // `sync_index_on_write` / `sync_index_on_delete`)。本函数
        // 不自己拿锁, 否则会死锁 (`std::sync::Mutex` 不可重入)。
        //
        // 内存缓存命中: 跳过磁盘 IO + JSON parse, 直接 clone 返回 ──
        // 这是 `get_memos` 热路径性能的关键。 cache 由 [`Self::write_index`]
        // 在落盘成功后回填, 由 [`super::MemoFile::set_current_notebook`] 在
        // 切 notebook 时失效。 并发安全: 写路径持外层 `Arc<RwLock<MemoFile>>`
        // 写锁, 读路径持外层读锁, 互不交叉。
        if let Some(cached) = self
            .index_cache
            .read()
            .expect("index_cache poisoned")
            .as_ref()
        {
            return Some(cached.clone());
        }

        let path = self.get_index_path();
        if !path.exists() {
            // 文件不存在 ≠ 错误 ── 新建 / 空 notebook 是合法状态。 不写
            // cache, 避免一次写锁; 下次 save 路径 (`write_index`) 自然
            // 会建 cache。
            return None;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[index.json] read failed: {e}");
                return None;
            }
        };
        match serde_json::from_str::<MemoIndexFile>(&content) {
            Ok(l) => {
                // 成功 parse → 写 cache。 失败 / missing → 不写 cache (同上)。
                *self.index_cache.write().expect("index_cache poisoned") = Some(l.clone());
                Some(l)
            }
            Err(e) => {
                // 解析失败时把坏文件挪到 .corrupt 备份, 下次 save 不会覆盖它。
                let backup = path.with_extension("json.corrupt");
                let _ = fs::rename(&path, &backup);
                eprintln!(
                    "[index.json] parse failed: {e}, moved to {}",
                    backup.display()
                );
                None
            }
        }
    }

    /// 严格读取当前 notebook 的 `index.json`。
    ///
    /// 与 [`Self::read_index`] 的兼容行为不同，本方法不会把 IO/JSON 解析错误
    /// 折叠成 `None`，也不会移动损坏文件；适合 CLI 和发布面向用户的路径。
    pub fn read_index_result(&self) -> std::io::Result<Option<MemoIndexFile>> {
        if let Some(cached) = self
            .index_cache
            .read()
            .expect("index_cache poisoned")
            .as_ref()
        {
            return Ok(Some(cached.clone()));
        }

        let path = self.get_index_path();
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)?;
        let list = serde_json::from_str::<MemoIndexFile>(&content).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("failed to parse {}: {e}", path.display()),
            )
        })?;
        *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        Ok(Some(list))
    }

    pub fn write_index(&self, list: &MemoIndexFile) -> std::io::Result<()> {
        // 同 `read_index`: 调用方**必须**已持有 `current_index_io` 锁。
        //
        // 顺序: 先落盘, 成功后再回填 cache。 这样落盘失败时 cache 保持
        // 旧值, 下次 `read_index` 仍能从磁盘读出真实状态; 颠倒顺序会
        // 出现"cache 已更新到新值, 磁盘还是旧值"的脏窗口。
        let content = serde_json::to_string_pretty(list).unwrap();
        self.atomic_write_json("index.json", &content)?;
        *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        Ok(())
    }

    pub fn read_memo_json(&self) -> Option<MemoMetadataFile> {
        let path = self.get_memo_json_path();
        if !path.exists() {
            return None;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[memo.json] read failed: {e}");
                return None;
            }
        };
        match serde_json::from_str(&content) {
            Ok(m) => Some(m),
            Err(e) => {
                let backup = path.with_extension("json.corrupt");
                let _ = fs::rename(&path, &backup);
                eprintln!(
                    "[memo.json] parse failed: {e}, moved to {}",
                    backup.display()
                );
                None
            }
        }
    }

    pub fn write_memo_json(&self, metadata: &MemoMetadataFile) -> std::io::Result<()> {
        let content = serde_json::to_string_pretty(metadata).unwrap();
        self.atomic_write_json("memo.json", &content)
    }

    /// 原子写: 写临时文件 → fsync → rename, 中途崩溃看到的永远是完整旧文件或
    /// 完整新文件。
    fn atomic_write_json(&self, filename: &str, content: &str) -> std::io::Result<()> {
        self.ensure_dirs()?;
        let final_path = self.get_metadata_dir().join(filename);
        let tmp_path = final_path.with_extension(format!(
            "tmp.{}.{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        {
            use std::io::Write;
            let mut f = fs::File::create(&tmp_path)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp_path, &final_path)
    }

    /// 把 `Memo` 转 index.json entry。`filename` 直传 (磁盘文件名, 含 .md)。
    pub fn memo_to_index_entry(memo: &Memo) -> MemoIndexEntry {
        MemoIndexEntry {
            id: memo.id.clone(),
            filename: memo.filename.clone(),
            preview: memo.preview.clone(),
            tags: memo.tags.clone(),
            todos: memo.todos.clone(),
            created_at: memo.created_at,
            updated_at: memo.updated_at,
            favorited: memo.favorited,
            icon: memo.icon.clone(),
            colors: memo.colors.clone(),
        }
    }

    /// 把 index.json entry 转 `Memo` (IPC 边界用)。`filename` 直传。
    pub fn index_entry_to_memo(entry: &MemoIndexEntry) -> Memo {
        Memo {
            id: entry.id.clone(),
            filename: entry.filename.clone(),
            preview: entry.preview.clone(),
            tags: entry.tags.clone(),
            todos: entry.todos.clone(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            favorited: entry.favorited,
            icon: entry.icon.clone(),
            colors: entry.colors.clone(),
        }
    }

    /// 写 index.json: 删旧条目, push 新条目, last_updated 戳当前。
    /// 顺带把 memo 的 todos 同步到 memo.json (派生索引)。
    ///
    /// 锁住整个 RMW 区块 ── 串行化 read+modify+write, 杜绝 lost update。
    pub fn sync_index_on_write(&self, memo: &Memo) -> std::io::Result<()> {
        {
            let _guard = self.current_index_io.lock().expect("index_io poisoned");
            self.sync_index_on_write_locked(memo)?;
        }
        // memo.json 单独写, 不在 index_io 锁内
        self.sync_memo_json_todos_on_write(memo)
    }

    /// 无锁版本的 [`Self::sync_index_on_write`]。调用方已持 `current_index_io` 锁。
    /// 内部不再 lock, 避免自重入死锁 (`std::sync::Mutex` 不可重入)。
    pub fn sync_index_on_write_locked(&self, memo: &Memo) -> std::io::Result<()> {
        let mut list = self.read_index().unwrap_or_default();
        list.memos.retain(|e| e.id != memo.id);
        list.memos.push(Self::memo_to_index_entry(memo));
        list.last_updated = chrono::Utc::now().timestamp_millis();
        self.write_index(&list)?;
        // memo.json 单独写, 不在 index_io 锁内 (避免无谓串行化)
        self.sync_memo_json_todos_on_write(memo)
    }

    /// 仅同步 index.json (不重写 .md), 用于 metadata-only 字段更新
    /// (`sync_metadata_only` / 收藏状态变化 / colors / icon 等)。
    pub fn sync_to_index_only(&self, memo: &Memo) -> std::io::Result<()> {
        self.sync_index_on_write(memo)
    }

    /// 写 memo.json 的 todos 部分: 删旧 memo_id 条目, 推入当前 todos。
    pub fn sync_memo_json_todos_on_write(&self, memo: &Memo) -> std::io::Result<()> {
        let mut metadata = self.read_memo_json().unwrap_or_default();
        let now = chrono::Utc::now().timestamp_millis();
        let existing_todos = metadata.todos.clone();

        metadata.todos.retain(|todo| todo.memo_id != memo.id);
        metadata.todos.extend(memo.todos.iter().map(|todo| {
            let existing = existing_todos
                .iter()
                .find(|entry| entry.memo_id == memo.id && entry.content == todo.content);

            let created_at = existing
                .map(|entry| entry.created_at)
                .unwrap_or(memo.created_at);
            let updated_at = existing
                .filter(|entry| entry.status == todo.status)
                .map(|entry| entry.updated_at)
                .unwrap_or(now);

            MemoTodoEntry {
                content: todo.content.clone(),
                status: todo.status.clone(),
                memo_id: memo.id.clone(),
                priority: existing
                    .map(|entry| entry.priority.clone())
                    .unwrap_or_default(),
                time_range: existing
                    .map(|entry| entry.time_range.clone())
                    .unwrap_or_default(),
                owner: existing
                    .map(|entry| entry.owner.clone())
                    .unwrap_or_default(),
                assignee: existing
                    .map(|entry| entry.assignee.clone())
                    .unwrap_or_default(),
                created_at,
                updated_at,
            }
        }));

        metadata.last_updated = now;
        self.write_memo_json(&metadata)
    }

    /// 删 index.json 的对应条目; 顺带删 memo.json 的 todos。
    pub fn sync_index_on_delete(&self, memo_id: &str) -> std::io::Result<()> {
        {
            let _guard = self.current_index_io.lock().expect("index_io poisoned");
            self.sync_index_on_delete_locked(memo_id)?;
        }
        self.sync_memo_json_todos_on_delete(memo_id)
    }

    /// 无锁版本的 [`Self::sync_index_on_delete`]。调用方已持 `current_index_io` 锁。
    pub fn sync_index_on_delete_locked(&self, memo_id: &str) -> std::io::Result<()> {
        let Some(mut list) = self.read_index() else {
            return Ok(());
        };
        list.memos.retain(|e| e.id != memo_id);
        list.last_updated = chrono::Utc::now().timestamp_millis();
        self.write_index(&list)
    }

    pub fn sync_memo_json_todos_on_delete(&self, memo_id: &str) -> std::io::Result<()> {
        let mut metadata = match self.read_memo_json() {
            Some(m) => m,
            None => return Ok(()),
        };

        metadata.todos.retain(|todo| todo.memo_id != memo_id);
        metadata.last_updated = chrono::Utc::now().timestamp_millis();

        self.write_memo_json(&metadata)
    }
}
