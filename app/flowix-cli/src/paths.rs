//! CLI 路径解析 + 首次使用兜底。
//!
//! 解析流程:
//! 1. `FLOWIX_DATA` 环境变量优先, 否则走 `get_app_data_path()`
//! 2. `FLOWIX_HOME` 环境变量优先, 否则走 `get_user_config_dir($HOME)`
//! 3. 如果 `notebook.json` 不存在 (新装用户), 调一次 `migrate_legacy_woop_dirs`
//!    兜底, 让只装 CLI 没启过桌面端的用户也能工作。
//!
//! 两个 env 覆盖主要用于: 脚本 / CI / 集成测试切换数据目录。
//!
//! 路径常量 / 旧目录迁移复用桌面端在 `flowix_desktop` 暴露的同名 `pub fn`,
//! 业务核心 (`flowix-core`) 故意不依赖 ── 那些是"应用入口"职责, 不是
//! "存储层"职责。

use std::path::{Path, PathBuf};

use crate::errors::CliError;

/// 用户配置目录名 (~/.<NAME>/ 下放 preference.json / flowix-ai-config.toml /
/// notebook.json / global_meta_data.json)。原 WoopMemo 时代叫 `.woop`,
/// 2026/06 品牌重塑后改为 `.flowix`。 旧目录由 `migrate_legacy_woop_dirs`
/// 一次性迁移, 见 `run()`。
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 桌面应用数据目录名 (在 `dirs::data_dir()` 之下, macOS:
/// `~/Library/Application Support/<NAME>/`)。 旧 WoopMemo 时代叫
/// `woopmemo`, 现统一为 `flowix`。
pub const APP_DATA_DIR_NAME: &str = "flowix";

/// 解析后的三组路径, 给 store.rs 用来构造 `MemoFile`。
pub struct Resolved {
    /// `~/Library/Application Support/flowix` (macOS)
    /// 或 `$XDG_DATA_HOME/flowix` (Linux)
    #[allow(dead_code)]
    pub app_data: PathBuf,
    /// `~/.flowix/`
    #[allow(dead_code)]
    pub config_dir: PathBuf,
    /// `~/.flowix/notebook.json`
    pub notebook_file: PathBuf,
}

pub fn resolve() -> Result<Resolved, CliError> {
    let home = dirs::home_dir().ok_or_else(|| {
        CliError::Usage("cannot resolve home directory (no $HOME / $USERPROFILE)".into())
    })?;

    let app_data = std::env::var("FLOWIX_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_app_data_path());

    let config_dir = std::env::var("FLOWIX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_user_config_dir(&home));

    let notebook_file = config_dir.join("notebook.json");

    // 首次使用兜底: 如果 notebook.json 不存在, 跑一次旧目录迁移。
    // 函数内部有"旧目录不存在就静默返回"的安全检查, 可以无条件调用。
    if !notebook_file.exists() {
        migrate_legacy_woop_dirs(&home, &app_data);
    }

    Ok(Resolved {
        app_data,
        config_dir,
        notebook_file,
    })
}

pub fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_symlink() {
            // 重新解析 symlink 后再 copy。
            // Unix: 重建符号链接,保留指针语义;Windows: 符号链接创建需要
            // 开发者模式/管理员权限,退化为复制目标内容(若目标是文件)。
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&from)?;
                std::os::unix::fs::symlink(&target, &to).ok();
            }
            #[cfg(not(unix))]
            {
                if let Ok(target) = std::fs::read_link(&from) {
                    if target.is_file() {
                        let _ = std::fs::copy(&target, &to);
                    }
                }
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 把 `~/.woop/` (旧 WoopMemo 配置) → `~/.flowix/`, 把
/// `<data_dir>/woopmemo/` → `<data_dir>/flowix/`, 仅当旧目录存在
/// **且** 新目录不存在 (避免覆盖)。
///
/// 任何步骤出错都 `eprintln!` 但不中断启动。复制成功后保留旧目录，并在新目录
/// 写 migration marker；发布路径不做不可逆删除。
fn migrate_legacy_woop_dirs(home_dir: &PathBuf, app_data_path: &PathBuf) {
    // 1. ~/.woop/ → ~/.flowix/
    let old_cfg = home_dir.join(".woop");
    let new_cfg = home_dir.join(USER_CONFIG_DIR_NAME);
    if old_cfg.exists() && !new_cfg.exists() {
        match copy_dir_recursive(&old_cfg, &new_cfg) {
            Ok(()) => {
                write_migration_marker(&new_cfg, &old_cfg);
                eprintln!("[flowix-cli] info: copied legacy ~/.woop → ~/.flowix (legacy dir kept)");
            }
            Err(e) => eprintln!("[flowix-cli] warn: failed to copy ~/.woop → ~/.flowix: {e}"),
        }
    }

    // 2. <data_dir>/woopmemo/ → <app_data_path>
    //    app_data_path 此时已是 data_dir.join(APP_DATA_DIR_NAME) = data_dir/flowix。
    if let Some(parent) = app_data_path.parent() {
        let old_data = parent.join("woopmemo");
        if old_data.exists() && !app_data_path.exists() {
            match copy_dir_recursive(&old_data, app_data_path) {
                Ok(()) => {
                    write_migration_marker(app_data_path, &old_data);
                    eprintln!(
                        "[flowix-cli] info: copied legacy app data: woopmemo → flowix (legacy dir kept)"
                    );
                }
                Err(e) => {
                    eprintln!("[flowix-cli] warn: failed to copy app data: woopmemo → flowix: {e}")
                }
            }
        }
    }
}

fn write_migration_marker(new_dir: &Path, old_dir: &Path) {
    let marker = new_dir.join(".flowix-migration");
    let content = format!("copied_from={}\nlegacy_dir_kept=true\n", old_dir.display());
    if let Err(e) = std::fs::write(&marker, content) {
        eprintln!(
            "[flowix-cli] warn: failed to write migration marker {}: {e}",
            marker.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_migration_keeps_old_dirs_and_writes_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let data_parent = tmp.path().join("data");
        let old_cfg = home.join(".woop");
        let old_data = data_parent.join("woopmemo");
        let new_data = data_parent.join(APP_DATA_DIR_NAME);

        std::fs::create_dir_all(&old_cfg).unwrap();
        std::fs::create_dir_all(&old_data).unwrap();
        std::fs::write(old_cfg.join("notebook.json"), "[]").unwrap();
        std::fs::write(old_data.join("sample.txt"), "x").unwrap();

        migrate_legacy_woop_dirs(&home, &new_data);

        assert!(old_cfg.exists(), "legacy config dir must be kept");
        assert!(old_data.exists(), "legacy data dir must be kept");
        assert!(home
            .join(USER_CONFIG_DIR_NAME)
            .join("notebook.json")
            .exists());
        assert!(new_data.join("sample.txt").exists());
        assert!(home
            .join(USER_CONFIG_DIR_NAME)
            .join(".flowix-migration")
            .exists());
        assert!(new_data.join(".flowix-migration").exists());
    }
}
