use std::{os::windows::process::CommandExt, path::Path, process::Command};

pub const ENGINE_EXECUTABLE: &str = "bin/openocd.exe";
pub const CAN_AUTHORIZE_USB: bool = false;

pub fn configure_process(command: &mut Command) {
    // CREATE_NO_WINDOW: OpenOCD logs go to the app, never a console popup.
    command.creation_flags(0x08000000);
}

pub fn usb_rules_installed(_engine_root: &Path) -> bool {
    false
}

pub fn authorize_usb(_resources: &Path) -> Result<String, String> {
    Err("此功能仅用于 Linux USB 权限配置".into())
}
