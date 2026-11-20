use std::{fs, path::Path, process::Command};

pub const ENGINE_EXECUTABLE: &str = "bin/openocd";
pub const CAN_AUTHORIZE_USB: bool = true;

pub fn configure_process(_command: &mut Command) {}

pub fn usb_rules_installed(engine_root: &Path) -> bool {
    let supplied = fs::read(engine_root.join("openocd/contrib/60-openocd.rules")).ok();
    let installed = fs::read("/etc/udev/rules.d/60-flashstudio.rules").ok();
    supplied.is_some() && supplied == installed
}

pub fn authorize_usb(resources: &Path) -> Result<String, String> {
    let helper = resources.join("install-usb-rules.sh");
    if !helper.is_file() {
        return Err("USB 授权组件缺失，请重新安装".into());
    }
    let output = Command::new("/usr/bin/pkexec")
        .arg("/bin/sh")
        .arg(helper)
        .output()
        .map_err(|e| format!("无法打开系统授权窗口：{e}。系统需要提供 polkit / pkexec。"))?;
    if !output.status.success() {
        return Err(format!(
            "USB 授权未完成（已取消或系统拒绝）：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok("USB 权限已配置，请重新插拔探针后再检测连接。".into())
}
