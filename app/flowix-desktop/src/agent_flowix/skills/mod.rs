//! Skills subsystem for the Flowix Agent.
//!
//! ## What this module owns
//!
//! - **Discovery**: scanning the user skills root (`~/.flowix/skills/`)
//!   for SKILL.md files in two areas — `.system/<name>/SKILL.md` (built-in,
//!   seeded from the app bundle once) and `<name>/SKILL.md` (user-authored).
//! - **Parsing**: YAML frontmatter (name, description, optional
//!   `metadata.short-description`) and markdown body.
//! - **Loading**: a [`SkillStore`] that holds the discovered skills in
//!   memory for the lifetime of the app — read-only after construction.
//! - **Seeding**: one-shot copy of bundled built-in skills into the user's
//!   `.system/` on first run; never overwrites user edits.
//!
//! ## Consumers
//!
//! - The system prompt builder reads [`SkillStore::summaries`] to inject a
//!   "# Skills" section into the agent's prompt.
//! - The `load_skill` tool calls [`SkillStore::get`] to fetch a skill's
//!   full body on demand.
//! - `~/.flowix/skills/` is auto-added to `agent-access.json` so the agent
//!   can also `read` / `grep` skills directly without `load_skill`.
//!
//! ## Threading
//!
//! `SkillStore` is immutable after `SkillStore::load`. Wrap in
//! `Arc<SkillStore>` and share between the system-prompt builder and the
//! tool handler — no `RwLock` needed.

pub mod parser;
pub mod scanner;
pub mod seed;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Origin tag — system skills are bundled with the app and seeded once;
/// user skills are authored directly under the skills root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillOrigin {
    System,
    User,
}

/// A single loaded skill — full content + provenance. Returned by
/// [`SkillStore::get`] when the LLM calls `load_skill`.
#[derive(Debug, Clone)]
pub struct Skill {
    /// Skill identifier; matches the folder name (frontmatter `name` is
    /// overridden by the scanner if the two disagree).
    pub name: String,
    /// Long description from frontmatter — used in tool results and the
    /// system prompt detail view.
    pub description: String,
    /// Short description for the system-prompt bullet list. Falls back to
    /// `description` when `metadata.short-description` is absent.
    pub short_description: String,
    /// Markdown body after the frontmatter fence.
    pub body: String,
    /// Where the skill was loaded from.
    pub origin: SkillOrigin,
    /// Absolute path of the SKILL.md file on disk.
    #[allow(dead_code)]
    pub source_path: PathBuf,
}

/// Lightweight projection of [`Skill`] used in the system prompt. Just
/// enough for the LLM to decide whether to call `load_skill` on it.
#[derive(Debug, Clone, Serialize)]
pub struct SkillSummary {
    pub name: String,
    pub short_description: String,
    pub origin: SkillOrigin,
}

/// In-memory registry of every skill discovered at startup.
///
/// Constructed once via [`SkillStore::load`] and treated as read-only. Wrap
/// in `Arc<SkillStore>` to share across the system-prompt builder and the
/// `load_skill` tool handler.
#[derive(Debug)]
pub struct SkillStore {
    /// name → Skill. Last-write-wins on collision (user > system per the
    /// scanner's iteration order).
    skills: HashMap<String, Skill>,
    /// Stable sorted projection used by the system prompt.
    summaries: Vec<SkillSummary>,
    /// The root that was scanned. Logged at startup for diagnostics; not
    /// used by tool handlers (which fetch via `get(name)`).
    root: PathBuf,
}

impl SkillStore {
    /// Scan `root` (typically `~/.flowix/skills/`) and build the store.
    /// The store is immutable after this call returns.
    pub fn load(root: &Path) -> Self {
        let skills_vec = scanner::scan_root(root);
        let mut skills: HashMap<String, Skill> = HashMap::with_capacity(skills_vec.len());
        for skill in skills_vec {
            skills.insert(skill.name.clone(), skill);
        }
        // Build summaries in stable order — `HashMap::values()` has
        // arbitrary iteration order, so we re-apply the (origin, name) sort
        // here to keep the system prompt content deterministic.
        let mut summaries: Vec<SkillSummary> = skills
            .values()
            .map(|s| SkillSummary {
                name: s.name.clone(),
                short_description: s.short_description.clone(),
                origin: s.origin,
            })
            .collect();
        summaries.sort_by(|a, b| match (a.origin, b.origin) {
            (SkillOrigin::System, SkillOrigin::User) => std::cmp::Ordering::Less,
            (SkillOrigin::User, SkillOrigin::System) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        });
        Self {
            skills,
            summaries,
            root: root.to_path_buf(),
        }
    }

    /// Sorted summaries (system first, then user, alphabetical within each
    /// group) for the system-prompt builder.
    pub fn summaries(&self) -> &[SkillSummary] {
        &self.summaries
    }

    /// Look up a skill by name. Returns `None` for unknown names so the
    /// tool handler can return a helpful "available: [...]" error.
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    /// Number of skills discovered. Convenience for logging.
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// The root that was scanned. Useful for diagnostic logs.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

// Re-exports so callers (and tests) don't have to dig into submodules.
// `#[allow(unused_imports)]` quiets the "unused import" lint that fires
// when this crate is checked in isolation — these are part of the module's
// public surface, intended for downstream consumers and integration tests.
#[allow(unused_imports)]
pub use parser::{parse_skill_file, ParseError};
#[allow(unused_imports)]
pub use scanner::scan_root;
#[allow(unused_imports)]
pub use seed::{seed_system_skills, SeedReport};

#[cfg(test)]
mod tests {
    use super::*;

    fn make_skill(root: &Path, area: &str, name: &str, desc: &str) {
        let dir = root.join(area).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\n\nbody of {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn store_load_populates_summaries_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        make_skill(root, ".system", "alpha", "alpha desc");
        make_skill(root, "", "beta", "beta desc");

        let store = SkillStore::load(root);
        assert_eq!(store.len(), 2);

        let summaries = store.summaries();
        assert_eq!(summaries[0].name, "alpha");
        assert_eq!(summaries[0].origin, SkillOrigin::System);
        assert_eq!(summaries[1].name, "beta");
        assert_eq!(summaries[1].origin, SkillOrigin::User);

        let skill = store.get("beta").expect("beta loaded");
        assert_eq!(skill.body, "body of beta");
        assert!(skill.source_path.ends_with("beta/SKILL.md"));

        assert!(store.get("nope").is_none());
    }

    #[test]
    fn store_empty_root_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SkillStore::load(tmp.path());
        assert_eq!(store.len(), 0);
        assert!(store.summaries().is_empty());
    }
}
