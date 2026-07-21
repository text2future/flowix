//! YAML frontmatter parser for `SKILL.md`.
//!
//! Format (matches existing `flowix-note` skill):
//!
//! ```text
//! ---
//! name: <skill_name>
//! description: <one-line what & when>
//! metadata:
//!   short-description: <terse line for prompt listing>
//! ---
//!
//! <markdown body 鈥?usage instructions>
//! ```
//!
//! Frontmatter and body are split by the leading + closing `---` fences.
//! The parser tolerates a leading BOM and either `\n` or `\r\n` line endings,
//! so files authored on Windows / macOS / Linux all parse identically.
//!
//! `name` and `description` are mandatory. `metadata.short-description` is
//! optional 鈥?when absent it falls back to `description`.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

use super::{Skill, SkillOrigin};

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("missing frontmatter (expected `---\\n` on first line)")]
    MissingFrontmatter,
    #[error("unterminated frontmatter (no closing `---`)")]
    UnterminatedFrontmatter,
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("frontmatter field `name` missing or not a string")]
    MissingName,
    #[error("frontmatter field `description` missing or not a string")]
    MissingDescription,
}

/// Raw frontmatter shape 鈥?`metadata` is a freeform map; we only look up
/// `short-description` and ignore other keys. The real-world `flowix-note`
/// skill uses `metadata.short-description`, but the parser stays permissive
/// so future keys don't break loading.
///
/// `name` / `description` are `Option<String>` so a missing field surfaces
/// as our dedicated `ParseError::MissingName` / `MissingDescription` rather
/// than the opaque `serde_yaml::Error` variant 鈥?easier for callers to
/// diagnose and align with the rest of the error vocabulary.
#[derive(Debug, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    metadata: HashMap<String, serde_yaml::Value>,
}

/// Parse a single SKILL.md file into a [`Skill`].
///
/// `origin` is injected by the scanner based on which scan area
/// (`.system/` vs top-level) the file came from; this function does not
/// inspect the path.
pub fn parse_skill_file(path: &Path, origin: SkillOrigin) -> Result<Skill, ParseError> {
    let raw = std::fs::read_to_string(path)?;
    let (yaml, body) = split_frontmatter(&raw)?;
    let fm: Frontmatter = serde_yaml::from_str(yaml)?;
    let name = fm
        .name
        .filter(|s| !s.trim().is_empty())
        .ok_or(ParseError::MissingName)?;
    let description = fm
        .description
        .filter(|s| !s.trim().is_empty())
        .ok_or(ParseError::MissingDescription)?;
    let short_description = match fm
        .metadata
        .get("short-description")
        .and_then(|v| v.as_str())
    {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => description.clone(),
    };
    Ok(Skill {
        name,
        description,
        short_description,
        body: body.to_string(),
        origin,
        source_path: path.to_path_buf(),
    })
}

/// Split raw SKILL.md text into `(frontmatter_yaml, body)`.
///
/// The leading fence is `---\n` (or `---\r\n`). The closing fence is a line
/// whose trimmed contents are exactly `---`. Body starts after that line.
fn split_frontmatter(raw: &str) -> Result<(&str, &str), ParseError> {
    // Tolerate a leading BOM 鈥?some Windows editors add one.
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let rest = raw
        .strip_prefix("---\r\n")
        .or_else(|| raw.strip_prefix("---\n"))
        .ok_or(ParseError::MissingFrontmatter)?;

    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" {
            let body_start = idx + line.len();
            // Strip a single leading blank line (the conventional separator
            // after the closing fence) and any trailing newlines so the
            // body is the actual markdown content, not whitespace.
            let body_with_leading = &rest[body_start..];
            let body = body_with_leading
                .trim_start_matches('\n')
                .trim_start_matches("\r\n")
                .trim_end_matches('\n')
                .trim_end_matches("\r\n");
            return Ok((&rest[..idx], body));
        }
        idx += line.len();
    }
    Err(ParseError::UnterminatedFrontmatter)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_skill(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("SKILL.md");
        std::fs::write(&path, content).expect("write");
        (dir, path)
    }

    #[test]
    fn parses_valid_flowix_note_fixture() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill_dir = dir.path().join("flowix-note");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");
        // Bundled fixture: same content as the production seed.
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\n\
             name: flowix-note\n\
             description: 鍦?Flowix 榛樿绗旇鏈?(nb_default) 鍐欎竴鏉°€屾湰娆′慨澶嶉棶棰樸€嶇瑪璁般€俓n\
             metadata:\n  \
             short-description: 鍦?Flowix 榛樿绗旇鏈啓涓€鏉′慨澶嶇瑪璁癨n\
             ---\n\n\
             # body line 1\n\
             body line 2\n",
        )
        .expect("write");

        let skill =
            parse_skill_file(&skill_dir.join("SKILL.md"), SkillOrigin::System).expect("parse ok");
        assert_eq!(skill.name, "flowix-note");
        assert!(skill.description.starts_with("鍦?Flowix"));
        assert!(skill.short_description.starts_with("鍦?Flowix"));
        assert!(skill.body.starts_with("# body line 1"));
        assert_eq!(skill.origin, SkillOrigin::System);
        assert!(skill.source_path.ends_with("SKILL.md"));
    }

    #[test]
    fn missing_frontmatter_returns_err() {
        let (_dir, path) = temp_skill("# Just markdown\nNo fence here.\n");
        let err = parse_skill_file(&path, SkillOrigin::User).unwrap_err();
        assert!(matches!(err, ParseError::MissingFrontmatter), "got {err:?}");
    }

    #[test]
    fn unterminated_frontmatter_returns_err() {
        let (_dir, path) = temp_skill("---\nname: foo\ndescription: bar\n# no closing fence\n");
        let err = parse_skill_file(&path, SkillOrigin::User).unwrap_err();
        assert!(
            matches!(err, ParseError::UnterminatedFrontmatter),
            "got {err:?}"
        );
    }

    #[test]
    fn short_description_falls_back_to_description() {
        let (_dir, path) =
            temp_skill("---\nname: foo\ndescription: long description here\n---\n\nbody\n");
        let skill = parse_skill_file(&path, SkillOrigin::User).expect("parse ok");
        assert_eq!(skill.short_description, "long description here");
    }

    #[test]
    fn bom_tolerated() {
        let (_dir, path) = temp_skill("\u{feff}---\nname: foo\ndescription: bar\n---\n\nbody\n");
        let skill = parse_skill_file(&path, SkillOrigin::User).expect("parse ok");
        assert_eq!(skill.name, "foo");
        assert_eq!(skill.body, "body");
    }

    #[test]
    fn missing_name_returns_err() {
        let (_dir, path) = temp_skill("---\ndescription: bar\n---\n\nbody\n");
        let err = parse_skill_file(&path, SkillOrigin::User).unwrap_err();
        // Either missing name (empty) or YAML error depending on serde semantics.
        assert!(matches!(err, ParseError::MissingName), "got {err:?}");
    }

    #[test]
    fn missing_description_returns_err() {
        let (_dir, path) = temp_skill("---\nname: foo\n---\n\nbody\n");
        let err = parse_skill_file(&path, SkillOrigin::User).unwrap_err();
        assert!(matches!(err, ParseError::MissingDescription), "got {err:?}");
    }
}
