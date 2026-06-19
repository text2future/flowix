//! System prompt assembly for agents.

mod base;
mod behavior;
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
}

pub fn build_system_prompt(config: SystemPromptConfig<'_>) -> String {
    let mut sections = vec![
        base::section(config.model),
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
