fn main() {
    let dev_mode = std::env::var_os("FLOWIX_DEV_MODE").is_some();
    println!("cargo:rerun-if-env-changed=FLOWIX_DEV_MODE");
    println!(
        "cargo:rustc-env=FLOWIX_DEV_MODE={}",
        if dev_mode { "1" } else { "0" }
    );

    // `tauri dev` launches the macOS executable directly instead of an
    // `.app` bundle, so the bundle plist configured in tauri.conf.json is
    // unavailable to AppKit/WebKit while developing. Embed the localization
    // metadata in the executable as well; this is also harmless for release
    // builds, whose packaged bundle has its own generated Info.plist.
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
        );
        let info_plist = if dev_mode {
            let source = std::fs::read_to_string(manifest_dir.join("Info.plist"))
                .expect("failed to read Info.plist");
            println!(
                "cargo:rerun-if-changed={}",
                manifest_dir.join("Info.plist").display()
            );
            let dev = source
                .replace("<string>flowix</string>", "<string>flowix-dev</string>")
                .replace("<string>Flowix</string>", "<string>Flowix Dev</string>")
                .replace("com.flowix.app.deeplink", "com.flowix-dev.app.deeplink");
            let generated =
                std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set"))
                    .join("Flowix-Dev-Info.plist");
            std::fs::write(&generated, dev).expect("failed to write dev Info.plist");
            generated
        } else {
            manifest_dir.join("Info.plist")
        };
        println!("cargo:rerun-if-changed={}", info_plist.display());
        println!("cargo:rustc-link-arg-bin=flowix-desktop=-sectcreate");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__TEXT");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__info_plist");
        println!(
            "cargo:rustc-link-arg-bin=flowix-desktop={}",
            info_plist.display()
        );
    }

    tauri_build::build()
}
