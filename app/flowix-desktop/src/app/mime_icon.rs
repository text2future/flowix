//! Linux `.md` MIME icon installer.
//!
//! Why this module exists — the Linux rule is genuinely different from macOS
//! and Windows: a file manager never asks the handler application for a file
//! icon. Nautilus / Dolphin / Thunar resolve a file's icon from its MIME type
//! name (`text/markdown` -> icon `text-markdown`), looked up in the active icon
//! theme and then in the `hicolor` fallback theme. There is no per-document
//! icon hook a `.desktop` file can set, so the only app-controlled lever is to
//! put a `text-markdown` icon into the user's `hicolor` theme before the
//! generic sheet would be found.
//!
//! Two consequences worth stating out loud:
//!   - The override is per-user and MIME-wide: after it lands, *every* `.md`
//!     the user sees gets the Flowix mark, not only files opened by Flowix.
//!     That is the cost of owning the association on Linux.
//!   - A theme that ships its own `text-markdown` (rare — Adwaita and Yaru rely
//!     on the generic `text-x-generic` for markdown) outranks hicolor and wins.
//!
//! Opt out with `FLOWIX_SKIP_MIME_ICON=1`; the target directory honours
//! `XDG_DATA_HOME` because it is derived from `dirs::data_dir()`.
//!
//! The module compiles on every platform (only [`spawn_install`] is called on
//! Linux) so `cargo check` and the unit tests below keep it honest on macOS and
//! Windows developer machines.

// Only the Linux call site is cfg-gated; everything else here stays reachable
// from unit tests on every host.
#![allow(dead_code)]

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Sizes GTK and KDE probe for MIME icons, embedded at build time so the
/// installer works identically in an AppImage (no installed resources), a .deb
/// and a dev build. Source of truth: `scripts/gen-md-linux-icons.mjs`.
const ICONS: &[(u32, &[u8])] = &[
    (16, include_bytes!("../../icons/md-linux/16.png")),
    (24, include_bytes!("../../icons/md-linux/24.png")),
    (32, include_bytes!("../../icons/md-linux/32.png")),
    (48, include_bytes!("../../icons/md-linux/48.png")),
    (64, include_bytes!("../../icons/md-linux/64.png")),
    (128, include_bytes!("../../icons/md-linux/128.png")),
    (256, include_bytes!("../../icons/md-linux/256.png")),
    (512, include_bytes!("../../icons/md-linux/512.png")),
];

/// `text/markdown` is what shared-mime-info resolves `.md` to today;
/// `text/x-markdown` is its long-standing alias and is still what some older
/// file managers look up, so both names get an icon.
const MIME_ICON_NAMES: [&str; 2] = ["text-markdown", "text-x-markdown"];

const OPT_OUT_ENV: &str = "FLOWIX_SKIP_MIME_ICON";

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct InstallReport {
    /// Files whose bytes changed (first run, or the artwork was regenerated).
    pub written: usize,
    /// Files already carrying the current artwork — the steady state.
    pub unchanged: usize,
    /// A missing `hicolor/index.theme` was created, without which GTK would not
    /// scan the directory at all.
    pub index_theme_created: bool,
    /// `gtk-update-icon-cache` ran and succeeded. Purely an optimisation: GTK
    /// falls back to scanning the directories when the cache is absent.
    pub cache_refreshed: bool,
}

/// Install in the background from the Tauri setup hook.
pub fn spawn_install() {
    if opted_out() {
        tracing::info!("markdown MIME icon install skipped via {OPT_OUT_ENV}");
        return;
    }
    let Some(theme_dir) = hicolor_dir() else {
        tracing::warn!("markdown MIME icon install skipped: no XDG data directory");
        return;
    };
    let install = std::thread::Builder::new()
        .name("md-mime-icon".to_string())
        .spawn(move || match install_into(&theme_dir) {
            Ok(report) if report.written > 0 || report.index_theme_created => {
                tracing::info!(
                    "installed markdown MIME icon: {} written, {} unchanged, index_theme={}, cache={}",
                    report.written,
                    report.unchanged,
                    report.index_theme_created,
                    report.cache_refreshed
                );
                crate::runtime_log::record_event(
                    "info",
                    "linux.mime_icon.installed",
                    format!(
                        "written={} unchanged={} index_theme={} cache={} dir={}",
                        report.written,
                        report.unchanged,
                        report.index_theme_created,
                        report.cache_refreshed,
                        theme_dir.display()
                    ),
                );
            }
            Ok(_) => tracing::debug!("markdown MIME icon already current"),
            Err(error) => tracing::warn!("markdown MIME icon install failed: {error}"),
        });
    if let Err(error) = install {
        tracing::warn!("markdown MIME icon thread failed to start: {error}");
    }
}

fn opted_out() -> bool {
    std::env::var_os(OPT_OUT_ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

fn hicolor_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|data| data.join("icons").join("hicolor"))
}

/// Copy the embedded artwork into `<theme_dir>/<N>x<N>/mimetypes/`.
///
/// Idempotent by content: a file that already holds the current bytes is left
/// untouched, so the steady-state cost is one small read per entry and no
/// writes, cache rebuild or icon-theme invalidation.
pub(crate) fn install_into(theme_dir: &Path) -> io::Result<InstallReport> {
    let mut report = InstallReport::default();
    for (size, bytes) in ICONS {
        let mime_dir = theme_dir.join(format!("{size}x{size}")).join("mimetypes");
        fs::create_dir_all(&mime_dir)?;
        for name in MIME_ICON_NAMES {
            let path = mime_dir.join(format!("{name}.png"));
            if write_if_changed(&path, bytes)? {
                report.written += 1;
            } else {
                report.unchanged += 1;
            }
        }
    }
    report.index_theme_created = ensure_index_theme(theme_dir)?;
    if report.written > 0 || report.index_theme_created {
        report.cache_refreshed = refresh_cache(theme_dir);
    }
    Ok(report)
}

/// Returns whether the file was (re)written.
///
/// The write goes through a sibling temp file + rename so a file manager
/// reading the directory concurrently can never observe a half-written PNG.
fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    match fs::read(path) {
        Ok(existing) if existing == bytes => return Ok(false),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let temporary = path.with_extension(format!("png.tmp{}", std::process::id()));
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(true)
}

/// GTK only scans a theme directory listed by an `index.theme` in its root, so
/// a machine that has never installed anything into `hicolor` needs one. An
/// existing file is left alone — distributions ship a complete index that lists
/// every size we write into.
fn ensure_index_theme(theme_dir: &Path) -> io::Result<bool> {
    let index = theme_dir.join("index.theme");
    if index.exists() {
        return Ok(false);
    }
    let mut directories = Vec::with_capacity(ICONS.len());
    let mut sections = String::new();
    for (size, _) in ICONS {
        let directory = format!("{size}x{size}/mimetypes");
        sections.push_str(&format!(
            "\n[{directory}]\nSize={size}\nContext=MimeTypes\nType=Fixed\n"
        ));
        directories.push(directory);
    }
    let body = format!(
        "[Icon Theme]\nName=Hicolor\nComment=Fallback icon theme\nHidden=true\nDirectories={}\n{sections}",
        directories.join(",")
    );
    fs::create_dir_all(theme_dir)?;
    fs::write(&index, body)?;
    Ok(true)
}

/// Best effort: a stale or missing `icon-theme.cache` only costs a directory
/// scan, and the tool is absent on minimal installs.
fn refresh_cache(theme_dir: &Path) -> bool {
    Command::new("gtk-update-icon-cache")
        .arg("-f")
        .arg("-q")
        .arg(theme_dir)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected_files() -> usize {
        ICONS.len() * MIME_ICON_NAMES.len()
    }

    #[test]
    fn first_install_writes_every_size_and_name() {
        let temp = tempfile::tempdir().expect("tempdir");
        let theme = temp.path().join("hicolor");

        let report = install_into(&theme).expect("install");

        assert_eq!(report.written, expected_files());
        assert_eq!(report.unchanged, 0);
        assert!(report.index_theme_created);
        for (size, bytes) in ICONS {
            for name in MIME_ICON_NAMES {
                let path = theme
                    .join(format!("{size}x{size}"))
                    .join("mimetypes")
                    .join(format!("{name}.png"));
                assert_eq!(fs::read(&path).expect("icon readable"), *bytes);
            }
        }
        assert!(theme.join("index.theme").exists());
    }

    #[test]
    fn second_install_is_a_no_op() {
        let temp = tempfile::tempdir().expect("tempdir");
        let theme = temp.path().join("hicolor");
        install_into(&theme).expect("first install");

        let report = install_into(&theme).expect("second install");

        assert_eq!(report.written, 0);
        assert_eq!(report.unchanged, expected_files());
        assert!(!report.index_theme_created);
        assert!(!report.cache_refreshed, "no rewrite means no cache rebuild");
    }

    #[test]
    fn stale_artwork_is_replaced() {
        let temp = tempfile::tempdir().expect("tempdir");
        let theme = temp.path().join("hicolor");
        install_into(&theme).expect("first install");
        let stale = theme.join("48x48").join("mimetypes").join("text-markdown.png");
        fs::write(&stale, b"not a png").expect("corrupt one icon");

        let report = install_into(&theme).expect("repair install");

        assert_eq!(report.written, 1);
        assert_eq!(report.unchanged, expected_files() - 1);
        // `cache_refreshed` depends on whether `gtk-update-icon-cache` is on the
        // host, so the repair itself is what the test checks.
        assert_eq!(fs::read(&stale).expect("repaired"), ICONS[3].1);
    }

    #[test]
    fn existing_index_theme_is_never_overwritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let theme = temp.path().join("hicolor");
        fs::create_dir_all(&theme).expect("theme dir");
        fs::write(theme.join("index.theme"), "[Icon Theme]\nName=Hicolor\n").expect("seed index");

        let report = install_into(&theme).expect("install");

        assert!(!report.index_theme_created);
        assert_eq!(
            fs::read_to_string(theme.join("index.theme")).expect("index readable"),
            "[Icon Theme]\nName=Hicolor\n"
        );
    }

    #[test]
    fn index_theme_lists_every_written_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let theme = temp.path().join("hicolor");
        install_into(&theme).expect("install");

        let index = fs::read_to_string(theme.join("index.theme")).expect("index readable");

        for (size, _) in ICONS {
            assert!(index.contains(&format!("{size}x{size}/mimetypes")), "missing {size} in index");
        }
    }
}
