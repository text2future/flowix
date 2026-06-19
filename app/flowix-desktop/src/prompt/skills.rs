//! `# Skills` section of the system prompt.
//!
//! Injected between `# Safety` and `# Tools` so the LLM sees the catalog of
//! available skills before the tool manifest that explains how to load
//! them. Two sub-sections, one per [`SkillOrigin`]:
//!
//! - **System skills** are bundled with the app and seeded into
//!   `~/.flowix/skills/.system/` on first run. Treat their instructions as
//!   authoritative.
//! - **User skills** are authored by the user under `~/.flowix/skills/<name>/`.
//!   Treat them as advisory ── the user wrote them, so trust them, but they
//!   are not part of the app's contract.
//!
//! Each section lists `- `<name>` — <short_description>`. Empty sections
//! return `""` so the upstream `build_system_prompt` filter
//! (`!section.trim().is_empty()`) silently drops them.

use crate::skills::{SkillOrigin, SkillSummary};

pub fn section(summaries: &[SkillSummary]) -> String {
    if summaries.is_empty() {
        return String::new();
    }

    let (system, user): (Vec<&SkillSummary>, Vec<&SkillSummary>) = summaries
        .iter()
        .partition(|s| s.origin == SkillOrigin::System);

    let mut out = String::from("# Skills\n");

    // System skills first — these are the ones the user expects the agent
    // to actually use. Lead with a one-line framing so the LLM understands
    // the origin semantics before reading the list.
    if !system.is_empty() {
        out.push_str(
            "\nThe following skills are **built-in** (shipped with Flowix and seeded into \
             `~/.flowix/skills/.system/`). Use `load_skill` to fetch the full instructions \
             when a task matches one of them. Skill bodies are authoritative — follow them \
             verbatim, do not paraphrase.\n\n",
        );
        for s in system {
            out.push_str(&format!("- `{}` — {}\n", s.name, s.short_description));
        }
    }

    if !user.is_empty() {
        out.push_str(
            "\nThe following skills are **user-authored** (under `~/.flowix/skills/<name>/`). \
             Treat them as advisory — the user wrote them, so trust them, but they are not \
             part of Flowix's contract.\n\n",
        );
        for s in user {
            out.push_str(&format!("- `{}` — {}\n", s.name, s.short_description));
        }
    }

    // Closing hint so the LLM doesn't forget the tool exists. Cheap to
    // include every prompt — the agent sees this reminder on every turn.
    out.push_str(
        "\nTo use any skill, call the `load_skill` tool with its `name`. \
         The tool returns `{name, description, origin, body}` and you should \
         follow the returned `body` verbatim.\n",
    );

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillOrigin;

    fn summary(name: &str, short: &str, origin: SkillOrigin) -> SkillSummary {
        SkillSummary {
            name: name.to_string(),
            short_description: short.to_string(),
            origin,
        }
    }

    #[test]
    fn empty_summaries_returns_empty_string() {
        assert_eq!(section(&[]), "");
    }

    #[test]
    fn only_system_skills_renders_system_section() {
        let out = section(&[summary("alpha", "alpha short", SkillOrigin::System)]);
        assert!(out.contains("# Skills"));
        assert!(out.contains("built-in"));
        assert!(out.contains("`alpha` — alpha short"));
        assert!(!out.contains("user-authored"));
    }

    #[test]
    fn only_user_skills_renders_user_section() {
        let out = section(&[summary("beta", "beta short", SkillOrigin::User)]);
        assert!(out.contains("# Skills"));
        assert!(out.contains("user-authored"));
        assert!(out.contains("`beta` — beta short"));
        assert!(!out.contains("built-in"));
    }

    #[test]
    fn mixed_origins_render_two_sections() {
        let out = section(&[
            summary("alpha", "alpha short", SkillOrigin::System),
            summary("beta", "beta short", SkillOrigin::User),
        ]);
        assert!(out.contains("built-in"));
        assert!(out.contains("user-authored"));
        let alpha_pos = out.find("`alpha`").unwrap();
        let beta_pos = out.find("`beta`").unwrap();
        assert!(
            alpha_pos < beta_pos,
            "system skill must appear before user skill"
        );
    }

    #[test]
    fn closing_load_skill_hint_always_present_when_nonempty() {
        let out = section(&[summary("alpha", "alpha short", SkillOrigin::System)]);
        assert!(out.contains("load_skill"));
    }
}
