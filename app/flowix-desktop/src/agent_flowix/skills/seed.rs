//! Seed-once: copy the app's bundled built-in skills into the user's
//! `~/.flowix/skills/.system/` directory on first run.
//!
//! ## Contract
//!
//! - Only copies skills whose folder does **not** already exist in the user
//!   area. Existing user edits always win.
//! - Recursive copy: a skill folder may contain auxiliary files alongside
//!   `SKILL.md` (templates, examples). All of them get copied.
//! - Missing bundled root or missing user root → no-op + warn, never panic.
//!   (Production builds with a stripped bundle still start cleanly; users
//!   can later drop skills in manually.)
//!
//! ## Return value
//!
//! Returns a [`SeedReport`] with two lists: skills copied this run, and
//! skills that were skipped because the user already had them. The startup
//! code logs both, so the first-run copy is visible in the log without
//! spamming subsequent boots.

use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct SeedReport {
    /// Skill names that were copied on this run.
    pub copied: Vec<String>,
    /// Skill names that were skipped because the user already had them.
    pub skipped: Vec<String>,
}

/// Walk `<bundled_root>/.system/` and copy any skill folder that doesn't
/// exist yet under `<user_root>/.system/<name>/`.
///
/// The function is **idempotent** — calling it repeatedly after the user
/// already has all bundled skills is a no-op (everything lands in
/// `skipped`).
///
/// Failures are logged and counted as no-ops so a single bad bundle entry
/// can't poison the rest of the copy.
pub fn seed_system_skills(bundled_root: &Path, user_root: &Path) -> SeedReport {
    let mut report = SeedReport::default();

    if !bundled_root.is_dir() {
        tracing::debug!(
            "[skills] bundled root {} not present; skipping seed",
            bundled_root.display()
        );
        return report;
    }

    let bundled_system = bundled_root.join(".system");
    if !bundled_system.is_dir() {
        tracing::debug!(
            "[skills] bundled .system/ missing at {}; no built-in skills to seed",
            bundled_system.display()
        );
        return report;
    }

    let user_system = user_root.join(".system");
    if let Err(e) = std::fs::create_dir_all(&user_system) {
        tracing::warn!(
            "[skills] failed to create {}: {e}; skipping seed",
            user_system.display()
        );
        return report;
    }

    let entries = match std::fs::read_dir(&bundled_system) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!(
                "[skills] failed to read {}: {e}; skipping seed",
                bundled_system.display()
            );
            return report;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            // Defensive: skip any nested dot-folders in the bundle.
            continue;
        }

        let dest = user_system.join(name);
        if dest.exists() {
            tracing::debug!(
                "[skills] {} already present in user .system/; leaving user copy intact",
                name
            );
            report.skipped.push(name.to_string());
            continue;
        }

        match copy_dir_recursive(&path, &dest) {
            Ok(()) => {
                tracing::info!("[skills] seeded built-in skill '{}'", name);
                report.copied.push(name.to_string());
            }
            Err(e) => {
                tracing::warn!(
                    "[skills] failed to seed '{}': {e}; user can retry by deleting the partial copy",
                    name
                );
            }
        }
    }

    report
}

/// Recursive copy: `src` directory → `dst` directory. Mirrors the helper
/// in `lib.rs::copy_dir_recursive` but lives here so the skills module is
/// self-contained and easy to test.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &to)?;
        }
        // Symlinks / devices / etc. intentionally skipped — bundled skills
        // are plain files.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_skill(bundled: &Path, name: &str, body: &str) {
        let d = bundled.join(".system").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {body}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn seed_copies_missing_skills() {
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        make_skill(bundled.path(), "alpha", "alpha desc");
        make_skill(bundled.path(), "beta", "beta desc");

        let report = seed_system_skills(bundled.path(), user.path());
        assert_eq!(report.copied.len(), 2);
        assert!(report.skipped.is_empty());
        assert!(user.path().join(".system/alpha/SKILL.md").is_file());
        assert!(user.path().join(".system/beta/SKILL.md").is_file());
    }

    #[test]
    fn seed_skips_existing_skills() {
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        make_skill(bundled.path(), "alpha", "fresh");

        // User already has alpha with a custom version.
        let user_alpha = user.path().join(".system/alpha");
        fs::create_dir_all(&user_alpha).unwrap();
        fs::write(user_alpha.join("SKILL.md"), "user-edited body").unwrap();

        let report = seed_system_skills(bundled.path(), user.path());
        assert!(report.copied.is_empty());
        assert_eq!(report.skipped, vec!["alpha"]);
        // User content is untouched.
        let content = fs::read_to_string(user_alpha.join("SKILL.md")).unwrap();
        assert_eq!(content, "user-edited body");
    }

    #[test]
    fn seed_copies_recursively() {
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let skill = bundled.path().join(".system/rich");
        fs::create_dir_all(skill.join("templates")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: rich\ndescription: r\n---\nbody\n",
        )
        .unwrap();
        fs::write(skill.join("templates/main.md"), "tmpl").unwrap();

        let report = seed_system_skills(bundled.path(), user.path());
        assert_eq!(report.copied, vec!["rich"]);
        assert!(user.path().join(".system/rich/templates/main.md").is_file());
    }

    #[test]
    fn seed_is_noop_when_bundled_missing() {
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        // No .system/ in bundled.
        let report = seed_system_skills(bundled.path(), user.path());
        assert!(report.copied.is_empty());
        assert!(report.skipped.is_empty());
    }

    #[test]
    fn seed_idempotent_on_repeat_run() {
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        make_skill(bundled.path(), "alpha", "alpha desc");

        let first = seed_system_skills(bundled.path(), user.path());
        assert_eq!(first.copied, vec!["alpha"]);

        let second = seed_system_skills(bundled.path(), user.path());
        assert!(second.copied.is_empty());
        assert_eq!(second.skipped, vec!["alpha"]);
    }
}
