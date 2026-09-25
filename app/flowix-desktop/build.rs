use std::fs;
use std::path::{Path, PathBuf};

fn collect_template_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    let entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("failed to read template directory {}: {error}", directory.display()));

    for entry in entries {
        let entry = entry.expect("failed to read template directory entry");
        let path = entry.path();
        let file_type = entry
            .file_type()
            .unwrap_or_else(|error| panic!("failed to inspect {}: {error}", path.display()));
        if file_type.is_dir() {
            collect_template_files(root, &path, files);
        } else if file_type.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(path.strip_prefix(root).unwrap().to_path_buf());
        }
    }
}

fn generate_notebook_template_assets() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
    );
    let template_root = manifest_dir.join("../../.flowix/templates/notebook-templates");
    let template_root = template_root
        .canonicalize()
        .unwrap_or_else(|error| panic!("notebook template source is unavailable: {error}"));
    println!("cargo:rerun-if-changed={}", template_root.display());

    let mut files = Vec::new();
    collect_template_files(&template_root, &template_root, &mut files);
    files.sort();

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let generated_file = out_dir.join("notebook_template_assets.rs");
    let mut generated = String::from(
        "pub const NOTEBOOK_TEMPLATE_ASSETS: &[(&str, &[u8])] = &[\n",
    );
    for relative in files {
        let absolute = template_root.join(&relative);
        generated.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            relative.to_string_lossy().replace('\\', "/"),
            absolute.to_string_lossy(),
        ));
    }
    generated.push_str("];\n");
    fs::write(generated_file, generated).expect("failed to write generated template asset list");
}

fn main() {
    generate_notebook_template_assets();

    // `tauri dev` launches the macOS executable directly instead of an
    // `.app` bundle, so the bundle plist configured in tauri.conf.json is
    // unavailable to AppKit/WebKit while developing. Embed the localization
    // metadata in the executable as well; this is also harmless for release
    // builds, whose packaged bundle has its own generated Info.plist.
    #[cfg(target_os = "macos")]
    {
        let info_plist = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
        )
        .join("Info.plist");
        println!("cargo:rerun-if-changed={}", info_plist.display());
        println!("cargo:rustc-link-arg-bin=flowix-desktop=-sectcreate");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__TEXT");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__info_plist");
        println!("cargo:rustc-link-arg-bin=flowix-desktop={}", info_plist.display());
    }

    tauri_build::build()
}
