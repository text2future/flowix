//! 笔记本配置 (notebook.json) IO — `read_notebook_configs` /
//! `write_notebook_configs` / `init_default_notebook` / `registered_notebook_paths` /
//! `get_notebook_config_by_id`。
//!
//! 文件位置: `~/.flowix/notebook.json` (跟 preference.json / flowix-ai-config.toml 同目录),
//! 早期版本写在 `<app_data_path>/notebook.json`, 由 `lib.rs` 的迁移逻辑一次性搬过来。

use std::fs;
use std::path::PathBuf;

use super::types::NotebookConfig;
use super::MemoFile;

impl MemoFile {
    /// 笔记本配置文件的实际路径。早期版本写在 `app_data_path/notebook.json`,
    /// 现已迁到 `~/.flowix/notebook.json` 与 preference.json / flowix-ai-config.toml 同目录。
    pub fn get_notebook_file_path(&self) -> PathBuf {
        self.notebook_file_path.clone()
    }

    /// 缺省 notebook 目录 — `~/Documents/flowix`。macOS / Linux / Windows
    /// 行为差异由 `dirs::document_dir()` 兜底 (返回 None 时退到 `/tmp`)。
    pub fn get_default_notebook_path(&self) -> PathBuf {
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("flowix")
    }

    /// 启动时确保 `notebooks/<base>` / `<base>/.metadata` / `<base>/attachments`
    /// 三个目录都存在。`commands::save_attachment` 等写入路径会再各自 mkdir。
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        let base = self.get_memo_base();
        fs::create_dir_all(&base)?;
        fs::create_dir_all(self.get_metadata_dir())?;
        fs::create_dir_all(self.get_memo_base().join("attachments"))?;
        Ok(())
    }

    /// 按 id 在磁盘 notebook.json 里查 config。返回 `Some(cfg)` 或 `None`。
    /// 内部走 `read_notebook_configs` 整表读 + 线性查找 — 笔记本规模 (<10) 下
    /// 无需建索引。 命中 `notebook_configs_cache` 时直接线性扫描, 跳过磁盘 IO。
    pub fn get_notebook_config_by_id(&self, id: &str) -> Option<NotebookConfig> {
        let configs = self.read_notebook_configs().ok()?;
        configs.into_iter().find(|c| c.id == id)
    }

    /// 读 `notebook.json`。文件不存在时返回空 Vec；读取或解析失败时返回
    /// `Err`，由调用方决定是否降级。
    ///
    /// 内存缓存: 进程内首次调用走磁盘, 之后命中 `notebook_configs_cache`,
    /// 跳过 fs::read_to_string + serde_json::from_str。 `notebook.json` 位置
    /// 固定 (`~/.flowix/notebook.json`), 跟 notebook 切换无关, cache
    /// 不需要按 notebook 失效。 cache 由 [`Self::write_notebook_configs`]
    /// 在落盘成功后回填。 `init_default_notebook` 的自愈路径如果修改了
    /// 磁盘, 也会走 `write_notebook_configs`, cache 自动同步。
    pub fn read_notebook_configs(&self) -> std::io::Result<Vec<NotebookConfig>> {
        if let Some(cached) = self
            .notebook_configs_cache
            .read()
            .expect("notebook_configs_cache poisoned")
            .as_ref()
        {
            return Ok(cached.clone());
        }

        let path = self.get_notebook_file_path();
        if !path.exists() {
            // 不存在 = 空配置 (合法状态, e.g. 全新安装)。 写 cache 避免
            // 后续每次启动都白走一次 `path.exists()`。
            let empty: Vec<NotebookConfig> = Vec::new();
            *self
                .notebook_configs_cache
                .write()
                .expect("notebook_configs_cache poisoned") = Some(empty.clone());
            return Ok(empty);
        }
        let content = fs::read_to_string(&path)?;
        let configs: Vec<NotebookConfig> = serde_json::from_str(&content).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("failed to parse {}: {e}", path.display()),
            )
        })?;
        *self
            .notebook_configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(configs.clone());
        Ok(configs)
    }

    /// 已注册 notebook 目录的绝对路径列表 — 缺省一定包含 `~/Documents/flowix`,
    /// 防止 JSON 缺省时路径集合空。
    pub fn registered_notebook_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = self
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .map(|config| PathBuf::from(config.path))
            .collect();

        let default_path = self.get_default_notebook_path();
        if !paths.iter().any(|path| path == &default_path) {
            paths.push(default_path);
        }

        paths
    }

    /// 写 `notebook.json` — `serde_json::to_string_pretty` 序列化, 走
    /// [`crate::memo_file::ops::atomic_write_bytes`] (temp + fsync + rename),
    /// 中途崩溃看到的永远是完整旧文件或完整新文件。`read_notebook_configs`
    /// 的 `unwrap_or_default` 兜底现在只是"文件不存在"的合法 fallback,
    /// 不再是"截断 JSON 被读出来"的兜底。
    ///
    /// 顺序: 先落盘, 成功后再回填 cache。 落盘失败时 cache 保持旧值, 跟
    /// [`Self::write_index`] 同口径。
    pub fn write_notebook_configs(&self, notebooks: &[NotebookConfig]) -> std::io::Result<()> {
        fs::create_dir_all(self.app_data_path.as_path())?;
        let content = serde_json::to_string_pretty(notebooks).unwrap();
        super::ops::atomic_write_bytes(&self.get_notebook_file_path(), content.as_bytes())?;
        *self
            .notebook_configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(notebooks.to_vec());
        Ok(())
    }

    /// 启动时调用 — 如果 `notebook.json` 里没有 default 条目, 补一个指向
    /// `~/Documents/flowix` 的; 已有但路径已不存在的, 自我修复回到 canonical 路径。
    /// 第二次启动不会再写 (`existing default + path exists` 早 return)。
    pub fn init_default_notebook(&self) -> NotebookConfig {
        if let Ok(configs) = self.read_notebook_configs() {
            if let Some(nb) = configs.iter().find(|n| n.is_default).cloned() {
                // Self-heal: if the persisted path no longer exists on disk
                // (e.g. user migrated dirs and the legacy path is gone, or
                // notebook.json was hand-edited), fall back to the canonical
                // Flowix default and persist. This is the second line of
                // defense after the migration-time rewrite in
                // `lib.rs::migrate_legacy_woop_dirs` step 4 — that one runs
                // once at startup, this one runs on every `init_default_notebook`
                // until the path exists.
                let trimmed = nb.path.trim_end_matches(|c| c == '/' || c == '\\');
                let p = std::path::PathBuf::from(trimmed);
                if !p.exists() {
                    let canonical_default = self.get_default_notebook_path();
                    tracing::warn!(
                        "default notebook path {} missing on disk; falling back to {}",
                        p.display(),
                        canonical_default.display()
                    );
                    let mut configs = configs;
                    let now = chrono::Utc::now().timestamp_millis();
                    for cfg in configs.iter_mut() {
                        if cfg.is_default {
                            cfg.path = format!("{}/", canonical_default.to_string_lossy());
                            cfg.updated_at = now;
                        }
                    }
                    let _ = self.write_notebook_configs(&configs);
                    return configs.into_iter().find(|n| n.is_default).unwrap_or(nb);
                }
                return nb;
            }
        }

        let default_nb = NotebookConfig {
            id: "nb_default".to_string(),
            name: "Default Notebook".to_string(),
            icon: Some("📓".to_string()),
            path: format!("{}/", self.get_default_notebook_path().to_string_lossy()),
            is_default: true,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };

        let mut configs = match self.read_notebook_configs() {
            Ok(configs) => configs,
            Err(e) => {
                tracing::error!(
                    "failed to read notebook config {}; default notebook not persisted: {e}",
                    self.get_notebook_file_path().display()
                );
                return default_nb;
            }
        };
        configs.push(default_nb.clone());
        let _ = self.write_notebook_configs(&configs);
        default_nb
    }
}
