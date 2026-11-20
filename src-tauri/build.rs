fn copy_tree(source: &std::path::Path, destination: &std::path::Path) {
    std::fs::create_dir_all(destination).expect("Cannot create bundled resource directory");
    for entry in std::fs::read_dir(source).expect("Cannot read bundled engine") {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).expect("Cannot copy bundled engine resource");
        }
    }
}

fn main() {
    let manifest = std::path::Path::new("resources/openocd/manifest.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let content = std::fs::read(manifest)
        .expect("Bundled OpenOCD missing: run npm run engine:prepare before building");
    let info: serde_json::Value =
        serde_json::from_slice(&content).expect("Invalid OpenOCD manifest");
    let platform = match (
        std::env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(),
        std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str(),
    ) {
        ("linux", "x86_64") => "linux-x64",
        ("windows", "x86_64") => "win32-x64",
        _ => panic!("FlashStudio currently bundles engines for Linux x64 and Windows x64"),
    };
    assert_eq!(
        info["platform"].as_str(),
        Some(platform),
        "Bundled OpenOCD does not match the target. Re-run engine:prepare for the target platform."
    );
    tauri_build::build();

    // Cargo 1.100 adds a package-name level under build/. Tauri 2.6's
    // fixed three-parent traversal then lands in $profile/build rather than
    // $profile. Stage our resources alongside the executable for either layout.
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let profile = out
        .ancestors()
        .find(|path| path.file_name() == Some(std::ffi::OsStr::new("build")))
        .and_then(std::path::Path::parent)
        .expect("Cannot determine Cargo output directory");
    copy_tree(
        std::path::Path::new("resources/openocd"),
        &profile.join("openocd"),
    );
    if platform == "linux-x64" {
        println!("cargo:rerun-if-changed=../packaging/linux/install-usb-rules.sh");
        std::fs::copy(
            "../packaging/linux/install-usb-rules.sh",
            profile.join("install-usb-rules.sh"),
        )
        .expect("Cannot stage USB authorization helper");
    }
    std::fs::copy(
        "../THIRD_PARTY_NOTICES.md",
        profile.join("THIRD_PARTY_NOTICES.md"),
    )
    .expect("Cannot stage third-party notices");
    println!(
        "cargo:rustc-env=FLASHSTUDIO_BUILD_RESOURCE_DIR={}",
        profile.display()
    );
}
