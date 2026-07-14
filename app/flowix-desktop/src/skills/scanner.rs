//! Walk a single skills root and collect every SKILL.md file under it.
//!
//! Two scan areas inside the same root (e.g. `~/.flowix/skills/`):
//!
//! - **System area**: `<root>/.system/<skill_name>/SKILL.md` — built-in
//!   skills, seeded once from the app bundle. Walked at depth 2 (the
//!   `SKILL.md` file is exactly two levels under the system area root).
//! - **User area**: `<root>/<skill_name>/SKILL.md` — user-authored skills.
//!   Walked at depth 1 (a single folder under the root, containing a
//!   `SKILL.md`).
//!
//! The two areas are scanned in order: system first, user second. When the
//! same skill name exists in both, the user version **wins** because it's
//! scanned last and inserted into the dedup map last. This matches the
//! "user edits override shipped skills" contract.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::parser::parse_skill_file;
use super::{Skill, SkillOrigin};

/// Scan a single skills root (e.g. `~/.flowix/skills/`).
///
/// Missing areas (`<root>/.system/` absent, `<root>` itself absent) are
/// silently skipped — the scanner is robust against partial state. Per-file
/// parse failures log a warning and are dropped, never aborting the scan.
///
/// Both areas use the same shape `<area_root>/<skill_name>/SKILL.md`, so
/// the same `scan_area` walker handles both — the `area_root` argument
/// just differs (`.system` for built-in skills, the root itself for user).
pub fn scan_root(root: &Path) -> Vec<Skill> {
    let mut by_name: HashMap<String, Skill> = HashMap::new();

    // System area: `<root>/.system/<skill_name>/SKILL.md`.
    let system_dir = root.join(".system");
    if system_dir.is_dir() {
        for skill in scan_area(&system_dir, SkillOrigin::System) {
            by_name.insert(skill.name.clone(), skill);
        }
    } else {
        tracing::debug!(
            "[skills] no .system/ area under {} (first run or system skills not seeded yet)",
            root.display()
        );
    }

    // User area: `<root>/<skill_name>/SKILL.md` — top-level children of root.
    // `<root>/.system` is its own walk above; the user walker would also pick
    // up `<root>/.system/<name>/SKILL.md` (depth 3, doesn't match our depth-2
    // walk) and we skip it via `is_hidden` on the `.system` boundary folder.
    if root.is_dir() {
        for skill in scan_area(root, SkillOrigin::User) {
            by_name.insert(skill.name.clone(), skill);
        }
    } else {
        tracing::debug!("[skills] no skills root at {}", root.display());
    }

    let mut out: Vec<Skill> = by_name.into_values().collect();
    // Stable ordering for the system prompt: System first (seeded), then
    // User; within each group, alphabetical by name. Sorting here keeps the
    // prompt content deterministic across machines.
    out.sort_by(|a, b| match (a.origin, b.origin) {
        (SkillOrigin::System, SkillOrigin::User) => std::cmp::Ordering::Less,
        (SkillOrigin::User, SkillOrigin::System) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    out
}

/// Walk an area (root or `.system/`) looking for `<name>/SKILL.md` files at
/// depth 2 below the area root. The shape is uniform across both areas:
/// `<area_root>/<skill_name>/SKILL.md`.
///
/// Hidden filtering is done **post-walk**, on the resulting path: any path
/// whose intermediate segments include a `.`-prefixed component is
/// dropped. WalkDir's `filter_entry` would be cleaner but it does not
/// fire on intermediate directories when `min_depth > 0` (only on yielded
/// entries) — and we want to skip whole subtrees like `<root>/.drafts/`,
/// so post-filtering on path is the reliable approach.
fn scan_area(area_root: &Path, origin: SkillOrigin) -> Vec<Skill> {
    let mut out = Vec::new();
    let walker = WalkDir::new(area_root)
        .min_depth(2)
        .max_depth(2)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok());
    for entry in walker {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name() != "SKILL.md" {
            continue;
        }
        let path = entry.path();
        // Skip any SKILL.md that lives under a `.`-prefixed intermediate
        // directory (`.drafts/`, `.metadata/`, etc.).
        if path_has_hidden_segment(path, area_root) {
            continue;
        }
        match parse_skill_file(path, origin) {
            Ok(skill) => {
                // Validate that the frontmatter name matches the folder.
                // On mismatch, override with folder name (canonical key) and
                // log a warning so the author fixes the frontmatter later.
                let folder_name = path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
                if let Some(folder) = folder_name {
                    if skill.name != folder {
                        tracing::warn!(
                            "[skills] frontmatter `name: {}` does not match folder `{}` in {}; using folder name",
                            skill.name,
                            folder,
                            path.display()
                        );
                        let mut fixed = skill;
                        fixed.name = folder;
                        out.push(fixed);
                    } else {
                        out.push(skill);
                    }
                } else {
                    out.push(skill);
                }
            }
            Err(e) => {
                tracing::warn!("[skills] failed to parse {}: {e}", path.display());
            }
        }
    }
    out
}

/// True if any path component strictly between `area_root` and the leaf
/// of `path` is a `.`-prefixed directory name (e.g. `.drafts`,
/// `.metadata`). The area_root itself and the leaf file name are not
/// checked.
fn path_has_hidden_segment(path: &Path, area_root: &Path) -> bool {
    // Strip the area_root prefix; only intermediate segments remain.
    let stripped = path.strip_prefix(area_root).unwrap_or(path);
    // Walk every component between the area root and the SKILL.md file
    // (the parent directory). Skip the leaf file name itself.
    let comps: Vec<_> = stripped.components().collect();
    if comps.is_empty() {
        return false;
    }
    // All but the last component are intermediate directories.
    comps
        .iter()
        .take(comps.len().saturating_sub(1))
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Best-effort bundled-skills root resolution.
///
/// Used by `lib.rs::run()` to find the app-bundled `resources/skills/`
/// directory at startup so `seed.rs` can copy built-in skills into the
/// user's `~/.flowix/skills/.system/`. The bundled root doesn't exist in
/// every environment (it's only present after `tauri build`), so a `None`
/// return is normal — `seed.rs` treats that as a no-op.
///
/// Resolution order:
/// 1. `FLOWIX_BUNDLED_SKILLS` env var (escape hatch for ops).
/// 2. `CARGO_MANIFEST_DIR` + `resources/skills` (dev: `cargo test` /
///    `cargo run` from `app/flowix-desktop/`).
/// 3. `<exe_parent>/resources/skills` (production bundle).
pub fn resolve_bundled_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FLOWIX_BUNDLED_SKILLS") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    if let Ok(dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(dir).join("resources/skills");
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("resources/skills");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_skill(dir: &Path, area: &str, name: &str, body: &str) {
        let skill_dir = dir.join(area).join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {body}\n---\n\nbody of {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn scan_root_picks_up_both_areas() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, ".system", "alpha", "system alpha");
        write_skill(root, "", "beta", "user beta");

        let skills = scan_root(root);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"], "system first, user second");
        assert_eq!(skills[0].origin, SkillOrigin::System);
        assert_eq!(skills[1].origin, SkillOrigin::User);
    }

    #[test]
    fn scan_root_user_wins_on_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, ".system", "shared", "system version");
        write_skill(root, "", "shared", "user version");

        let skills = scan_root(root);
        assert_eq!(skills.len(), 1);
        // User wins because it's scanned last and overwrites the system entry.
        assert_eq!(skills[0].origin, SkillOrigin::User);
        assert!(skills[0].description.contains("user version"));
    }

    #[test]
    fn scan_root_silent_on_missing_system_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, "", "only_user", "user only");

        let skills = scan_root(root);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "only_user");
    }

    #[test]
    fn scan_root_silent_on_missing_root_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("does_not_exist");
        let skills = scan_root(&root);
        assert!(skills.is_empty());
    }

    #[test]
    fn scan_root_skips_non_skill_md_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A README.md in a folder must not be picked up.
        let user_dir = root.join("weird");
        fs::create_dir_all(&user_dir).unwrap();
        fs::write(user_dir.join("README.md"), "# readme\n").unwrap();
        // A SKILL.md at depth 0 (the root itself) is also skipped because
        // the user area is scanned at depth 1.
        fs::write(
            root.join("SKILL.md"),
            "---\nname: top\ndescription: x\n---\nbody\n",
        )
        .unwrap();
        write_skill(root, "", "valid", "real skill");

        let skills = scan_root(root);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "valid");
    }

    #[test]
    fn scan_root_name_mismatch_uses_folder_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let folder = root.join("canonical-name");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("SKILL.md"),
            "---\nname: different\ndescription: mismatch\n---\nbody\n",
        )
        .unwrap();

        let skills = scan_root(root);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "canonical-name");
        assert_eq!(skills[0].description, "mismatch"); // body still loads
    }

    #[test]
    fn scan_root_skips_hidden_folders_other_than_system() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A hidden user folder like `.drafts` should NOT be picked up.
        let hidden = root.join(".drafts");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(
            hidden.join("SKILL.md"),
            "---\nname: drafts\ndescription: hidden draft\n---\nbody\n",
        )
        .unwrap();
        write_skill(root, "", "visible", "visible skill");

        let skills = scan_root(root);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(skills.len(), 1, "got: {:?}", names);
        assert_eq!(skills[0].name, "visible");
    }
}
