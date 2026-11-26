//! Exercise the actual desktop ZIP decoder and transactional writer before release.
#![allow(dead_code)]

use std::path::Path;

extern crate self as flowix_core;

#[path = "../../../app/flowix-core/src/path_scope.rs"]
mod path_scope;
#[path = "../../../app/flowix-desktop/src/config/path_scope.rs"]
mod config;
#[path = "../../../app/flowix-core/src/skill_frontmatter.rs"]
mod skill_frontmatter;
#[path = "../../../app/flowix-core/src/market_archive.rs"]
mod market_archive;
mod commands {
    pub mod market_package {
        pub use crate::market_archive::is_market_archive_origin;
    }
}
#[path = "../../../app/flowix-desktop/src/commands/agent/skill_package.rs"]
mod skill_package;

fn run(market: &Path) -> Result<(), String> {
    let notebook = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut count = 0;
    for entry in std::fs::read_dir(market).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let id = manifest["id"].as_str().ok_or("Manifest has no skill ID")?;
        let mut archive = manifest["archive"].clone();
        archive["url"] =
            serde_json::Value::String(format!("https://skills.flowix.cc/skills/archives/{id}.zip"));
        archive["source"] = manifest["source"].clone();
        let archive = serde_json::from_value(archive).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(market.join("archives").join(format!("{id}.zip")))
            .map_err(|e| e.to_string())?;
        let installed =
            skill_package::install_project_skill_zip(notebook.path(), id, &bytes, &archive)
                .map_err(|e| format!("{id}: {e}"))?;
        let folder = installed.parent().unwrap();
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(&bytes)).map_err(|e| e.to_string())?;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let target = folder.join(entry.name());
            let mut expected = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut expected).map_err(|e| e.to_string())?;
            if std::fs::read(&target).map_err(|e| e.to_string())? != expected {
                return Err(format!("{id}: installed file differs: {}", entry.name()));
            }
        }
        let record: serde_json::Value = serde_json::from_slice(
            &std::fs::read(folder.join(".flowix-install.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if record["skillId"] != id
            || record["installedAt"].as_str().is_none()
            || record["source"] != manifest["source"]
        {
            return Err(format!("{id}: invalid installation record"));
        }
        count += 1;
    }
    if count == 0 {
        return Err("No skill manifests found".into());
    }
    println!("Verified {count} real ZIP installations and their complete file trees.");
    Ok(())
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../flowix-home/skill-files".into());
    if let Err(error) = run(Path::new(&path)) {
        eprintln!("Skill package release check failed: {error}");
        std::process::exit(1);
    }
}
