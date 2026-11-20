//! Resolve only application-owned OpenOCD resources, never PATH or user settings.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platform: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub version: String,
    pub platform: String,
    pub can_authorize_usb: bool,
    pub usb_rules_installed: bool,
}

pub struct BundledEngine {
    pub executable: PathBuf,
    pub scripts: PathBuf,
    pub info: EngineInfo,
}

pub fn platform_id() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("windows", "x86_64") => Ok("win32-x64"),
        _ => Err("当前安装包仅支持 Linux x64 和 Windows x64".into()),
    }
}

pub fn from_root(root: &Path) -> Result<BundledEngine, String> {
    let missing = |e: String| format!("内置烧录引擎不完整，请重新安装 FlashStudio：{e}");
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).map_err(|e| missing(e.to_string()))?,
    )
    .map_err(|e| missing(e.to_string()))?;
    if manifest.platform != platform_id()? {
        return Err("内置引擎与当前系统不匹配，请使用对应平台的安装包".into());
    }
    let executable = root.join(if cfg!(windows) {
        "bin/openocd.exe"
    } else {
        "bin/openocd"
    });
    let scripts = root.join("openocd/scripts");
    for path in [
        &executable,
        &scripts.join("interface/stlink.cfg"),
        &scripts.join("interface/jlink.cfg"),
        &scripts.join("interface/cmsis-dap.cfg"),
    ] {
        if !path.is_file() {
            return Err(missing(path.display().to_string()));
        }
    }
    let supplied_rules = fs::read(root.join("openocd/contrib/60-openocd.rules")).ok();
    let installed_rules = fs::read("/etc/udev/rules.d/60-flashstudio.rules").ok();
    let usb_rules_installed = supplied_rules.is_some() && supplied_rules == installed_rules;
    Ok(BundledEngine {
        executable,
        scripts,
        info: EngineInfo {
            version: manifest.version,
            platform: manifest.platform,
            can_authorize_usb: cfg!(target_os = "linux"),
            usb_rules_installed,
        },
    })
}

pub fn resolve(app: &tauri::AppHandle) -> Result<BundledEngine, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    from_root(&resources.join("openocd"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_bundle_never_falls_back_to_system_openocd() {
        assert!(from_root(Path::new("/definitely-not-a-flashstudio-bundle")).is_err());
    }
    #[test]
    fn built_executable_resource_layout_is_complete() {
        let root = Path::new(env!("FLASHSTUDIO_BUILD_RESOURCE_DIR"));
        assert!(from_root(&root.join("openocd")).is_ok());
        assert!(root.join("install-usb-rules.sh").is_file());
    }
    #[test]
    fn packaged_engine_runs_without_path_and_resolves_its_own_scripts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/openocd");
        let engine = from_root(&root).expect("Run npm run engine:prepare before testing");
        let result = std::process::Command::new(&engine.executable)
            .env("PATH", "")
            .env_remove("OPENOCD_SCRIPTS")
            .env_remove("LD_LIBRARY_PATH")
            .current_dir(std::env::temp_dir())
            .args([
                "-s",
                engine.scripts.to_str().unwrap(),
                "-f",
                "interface/stlink.cfg",
                "-f",
                "target/stm32f4x.cfg",
                "-c",
                "echo BUNDLED_ENGINE_READY; shutdown",
            ])
            .output()
            .unwrap();
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(result.status.success(), "{output}");
        assert!(output.contains("BUNDLED_ENGINE_READY"));
    }
}
