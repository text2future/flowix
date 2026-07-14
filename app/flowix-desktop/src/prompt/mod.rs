//! System prompt assembly for agents.

mod base;
mod behavior;
mod role;
mod safety;
mod skills;
mod tools;

use crate::skills::SkillSummary;

pub struct SystemPromptConfig<'a> {
    pub model: &'a str,
    pub tools_enabled: bool,
    /// Skills discovered at startup; injected as a `# Skills` section
    /// between `# Safety` and `# Tools`. Empty slice = section omitted.
    pub skills: &'a [SkillSummary],
    /// Runtime Agent Role override (e.g. user-supplied persona memo).
    /// When `Some`, **replaces** [`role::section`] — the two are mutually
    /// exclusive; the default role section is omitted entirely.
    /// When `None`, the default [`role::section`] is injected.
    pub role_override: Option<&'a str>,
}

pub fn build_system_prompt(config: SystemPromptConfig<'_>) -> String {
    // Role: runtime override takes precedence over the default static role.
    // Exactly one of the two appears in the final prompt.
    let role_section = match config.role_override {
        Some(custom) => custom.to_string(),
        None => role::section(),
    };

    let mut sections = vec![
        base::section(config.model),
        role_section,
        behavior::section(),
        safety::section(),
        skills::section(config.skills),
    ];

    if config.tools_enabled {
        sections.push(tools::section());
    }

    sections
        .into_iter()
        .filter(|section| !section.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_role_included_when_no_override() {
        let out = build_system_prompt(SystemPromptConfig {
            model: "test-model",
            tools_enabled: false,
            skills: &[],
            role_override: None,
        });
        assert!(out.contains("Document Types You Own"));
        assert!(out.contains("Role name: Flowix Writer"));
    }

    #[test]
    fn runtime_role_replaces_default_role() {
        let custom_marker = "CUSTOM_RUNTIME_ROLE_MARKER";
        let out = build_system_prompt(SystemPromptConfig {
            model: "test-model",
            tools_enabled: false,
            skills: &[],
            role_override: Some(custom_marker),
        });
        assert!(out.contains(custom_marker));
        assert!(
            !out.contains("Document Types You Own"),
            "default role must be omitted when override is provided"
        );
        assert!(
            !out.contains("Role name: Flowix Writer"),
            "default role heading must be omitted when override is provided"
        );
    }

    #[test]
    fn exactly_one_agent_role_heading_in_default_path() {
        let out = build_system_prompt(SystemPromptConfig {
            model: "m",
            tools_enabled: false,
            skills: &[],
            role_override: None,
        });
        assert_eq!(
            out.matches("# Agent Role").count(),
            1,
            "default path must contain exactly one `# Agent Role` heading"
        );
    }

    #[test]
    fn exactly_one_agent_role_heading_in_override_path() {
        let custom = "# Agent Role\nRole name: Custom\n\n<role-instructions>\nbe helpful\n</role-instructions>";
        let out = build_system_prompt(SystemPromptConfig {
            model: "m",
            tools_enabled: false,
            skills: &[],
            role_override: Some(custom),
        });
        assert_eq!(
            out.matches("# Agent Role").count(),
            1,
            "override path must contain exactly one `# Agent Role` heading"
        );
    }

    #[test]
    fn identity_mission_remains_in_both_paths() {
        let out_default = build_system_prompt(SystemPromptConfig {
            model: "m",
            tools_enabled: false,
            skills: &[],
            role_override: None,
        });
        let out_override = build_system_prompt(SystemPromptConfig {
            model: "m",
            tools_enabled: false,
            skills: &[],
            role_override: Some("# Agent Role\ncustom"),
        });
        // `# Identity` and `## Mission` are in base.rs — must survive
        // both paths; the role refactor must not touch them.
        for out in [&out_default, &out_override] {
            assert!(out.contains("# Identity"));
            assert!(out.contains("## Mission"));
            assert!(out.contains("Model: m"));
        }
    }
}
