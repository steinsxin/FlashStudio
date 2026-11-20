//! OpenOCD command planning. No shell or hardware access occurs in this module.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(skip)]
    pub executable: String,
    #[serde(skip)]
    pub scripts_dir: String,
    pub adapter: Adapter,
    pub transport: Transport,
    pub serial: String,
    pub target: String,
    pub speed_khz: u32,
    pub connect_under_reset: bool,
    pub timeout_secs: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Adapter {
    Stlink,
    Jlink,
    CmsisDap,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Swd,
    Jtag,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Probe,
    Flash,
    Verify,
    Erase,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    pub config: ConnectionConfig,
    pub operation: Operation,
    pub firmware_id: Option<String>,
    pub address: String,
    pub verify_after_write: bool,
    pub reset_after: bool,
    pub bank: u32,
    pub first_sector: u32,
    pub last_sector: Option<u32>,
    pub erase_confirmed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub executable: String,
    pub args: Vec<String>,
    pub timeout_secs: u64,
}

pub fn validate_config(c: &ConnectionConfig) -> Result<(), String> {
    if c.executable.trim().is_empty() || c.executable.contains('\0') {
        return Err("内置引擎路径无效，请重新安装 FlashStudio".into());
    }
    if c.target.trim().is_empty()
        || !c.target.to_lowercase().ends_with(".cfg")
        || c.target.contains('\0')
    {
        return Err("请选择有效的目标芯片 .cfg 配置".into());
    }
    if !(1..=50_000).contains(&c.speed_khz) {
        return Err("接口时钟须在 1–50000 kHz 之间".into());
    }
    if !(5..=3600).contains(&c.timeout_secs) {
        return Err("超时须在 5–3600 秒之间".into());
    }
    if c.serial.len() > 256 || c.serial.contains('\0') || c.scripts_dir.contains('\0') {
        return Err("路径或序列号不合法".into());
    }
    Ok(())
}

// Tcl quotes must also suppress command and variable substitution. Braces alone
// are unsafe for file names containing unmatched braces or backslash-newlines.
pub fn tcl_word(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' | '"' | '$' | '[' | ']' | '{' | '}' => {
                out.push('\\');
                out.push(ch);
            }
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

pub fn parse_address(text: &str) -> Result<u32, String> {
    let value = text.trim();
    let parsed = if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u32::from_str_radix(hex, 16)
    } else {
        value.parse::<u32>()
    };
    parsed.map_err(|_| "BIN 起始地址须为有效的 32 位地址，例如 0x08000000".into())
}

pub fn image_type(name: &str) -> Result<&'static str, String> {
    match Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "bin" => Ok("bin"),
        "hex" | "ihex" => Ok("ihex"),
        "elf" | "axf" => Ok("elf"),
        _ => Err("支持 BIN、HEX、ELF、AXF 固件".into()),
    }
}

pub fn build_plan(r: &OperationRequest, firmware: Option<(&Path, &str)>) -> Result<Plan, String> {
    validate_config(&r.config)?;
    let c = &r.config;
    let mut args = Vec::<String>::new();
    if !c.scripts_dir.trim().is_empty() {
        args.extend(["-s".into(), c.scripts_dir.trim().into()]);
    }
    // Disable every debug/control listener; the process only lives for one job.
    args.extend([
        "-c".into(),
        "gdb port disabled; tcl port disabled; telnet port disabled".into(),
    ]);
    let interface = match c.adapter {
        Adapter::Stlink => "interface/stlink.cfg",
        Adapter::Jlink => "interface/jlink.cfg",
        Adapter::CmsisDap => "interface/cmsis-dap.cfg",
    };
    args.extend(["-f".into(), interface.into()]);
    let transport = match c.transport {
        Transport::Swd => "swd",
        Transport::Jtag => "jtag",
    };
    // The pinned engine uses the unified SWD/JTAG names for the ST-Link DAP driver.
    args.extend(["-c".into(), format!("if {{[adapter name] eq \"hla\"}} {{ transport select hla_{transport} }} else {{ transport select {transport} }}")]);
    if !c.serial.trim().is_empty() {
        args.extend([
            "-c".into(),
            format!("adapter serial {}", tcl_word(c.serial.trim())),
        ]);
    }
    args.extend(["-f".into(), c.target.trim().into()]);
    // Target scripts often set their own speed: user overrides must come last.
    args.extend(["-c".into(), format!("adapter speed {}", c.speed_khz)]);
    if c.connect_under_reset {
        args.extend([
            "-c".into(),
            "reset_config srst_only srst_nogate connect_assert_srst".into(),
        ]);
    }
    let mut steps = vec!["init".to_string(), "reset init".to_string()];
    match r.operation {
        Operation::Probe => {
            steps.push("targets".into());
            steps.push("flash probe 0".into());
            steps.push("flash banks".into());
        }
        Operation::Flash | Operation::Verify => {
            let (path, name) = firmware.ok_or("请先选择固件文件")?;
            let kind = image_type(name)?;
            let address = if kind == "bin" {
                parse_address(&r.address)?
            } else {
                0
            };
            let file = tcl_word(path.to_str().ok_or("固件路径不是有效的 UTF-8")?);
            if r.operation == Operation::Flash {
                steps.push(format!(
                    "flash write_image erase {file} 0x{address:08x} {kind}"
                ));
            }
            if r.operation == Operation::Verify || r.verify_after_write {
                if r.operation == Operation::Verify {
                    steps.push(format!("echo {}", crate::verification::COMPARING_MARKER));
                }
                steps.push(format!("verify_image {file} 0x{address:08x} {kind}"));
                if r.operation == Operation::Verify {
                    steps.push(format!("echo {}", crate::verification::MATCHED_MARKER));
                }
            }
        }
        Operation::Erase => {
            if !r.erase_confirmed {
                return Err("请确认 Flash 擦除范围后再执行".into());
            }
            if r.bank > 255
                || r.first_sector > 65535
                || r.last_sector
                    .is_some_and(|last| last < r.first_sector || last > 65535)
            {
                return Err("Flash Bank 或扇区范围无效".into());
            }
            steps.push(format!(
                "flash erase_sector {} {} {}",
                r.bank,
                r.first_sector,
                r.last_sector
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "last".into())
            ));
        }
    }
    // A probe should leave the application running; erase intentionally leaves
    // the CPU halted rather than attempting to execute blank flash.
    if r.operation == Operation::Probe || (r.reset_after && r.operation != Operation::Erase) {
        steps.push("reset run".into());
    }
    let body = steps.join("; ");
    // Explicitly propagate Tcl failures: exit code 0 alone is otherwise unsafe.
    args.extend(["-c".into(), format!("if {{[catch {{ {body} }} message]}} {{ echo $message; shutdown error }} else {{ echo FLASHSTUDIO_SUCCESS; shutdown }}")]);
    Ok(Plan {
        executable: c.executable.trim().into(),
        args,
        timeout_secs: c.timeout_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn request(operation: Operation) -> OperationRequest {
        OperationRequest {
            config: ConnectionConfig {
                executable: "openocd".into(),
                scripts_dir: "".into(),
                adapter: Adapter::Stlink,
                transport: Transport::Swd,
                serial: "".into(),
                target: "target/stm32f4x.cfg".into(),
                speed_khz: 4000,
                connect_under_reset: false,
                timeout_secs: 30,
            },
            operation,
            firmware_id: None,
            address: "0x08004000".into(),
            verify_after_write: true,
            reset_after: true,
            bank: 0,
            first_sector: 0,
            last_sector: None,
            erase_confirmed: false,
        }
    }
    #[test]
    fn bin_offset_and_embedded_addresses() {
        for (name, kind, address) in [
            ("x.bin", "bin", "0x08004000"),
            ("x.hex", "ihex", "0x00000000"),
            ("x.elf", "elf", "0x00000000"),
        ] {
            let p = build_plan(&request(Operation::Flash), Some((Path::new(name), name))).unwrap();
            let script = p.args.last().unwrap();
            assert!(script.contains(&format!(
                "flash write_image erase \"{name}\" {address} {kind}"
            )));
            assert!(script.contains(&format!("verify_image \"{name}\" {address} {kind}")));
            assert!(script.contains("shutdown error"));
        }
    }
    #[test]
    fn verification_never_writes_or_erases() {
        let p = build_plan(
            &request(Operation::Verify),
            Some((Path::new("a.bin"), "a.bin")),
        )
        .unwrap();
        assert!(!p.args.last().unwrap().contains("write_image"));
        assert!(!p.args.last().unwrap().contains("erase"));
    }
    #[test]
    fn verification_milestones_follow_real_tcl_execution_and_failures() {
        use crate::verification::{COMPARING_MARKER, MATCHED_MARKER, VerificationStage};
        let engine = crate::bundled::from_root(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/openocd"),
        )
        .unwrap();
        let plan = build_plan(
            &request(Operation::Verify),
            Some((Path::new("a.bin"), "a.bin")),
        )
        .unwrap();
        // Only execute the generated operation body. Every hardware command is
        // replaced before it runs; this exercises the bundled Tcl interpreter.
        let fixture = "foreach cmd {init reset verify_image} {if {[llength [info commands $cmd]]} {rename $cmd fs_original_$cmd}; proc $cmd {args} {}}";
        for (failure, comparing, matched) in [
            ("", true, true),
            ("proc init {args} {error CONNECTION_FAILED}", false, false),
            (
                "proc verify_image {args} {error VERIFY_FAILED}",
                true,
                false,
            ),
            (
                "proc reset {mode} {if {$mode eq \"run\"} {error RESET_FAILED}}",
                true,
                true,
            ),
        ] {
            let setup = format!("{fixture}; {failure}");
            let result = std::process::Command::new(&engine.executable)
                .args(["-c", &setup, "-c", plan.args.last().unwrap()])
                .output()
                .unwrap();
            let output = format!(
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            let contains = |marker: &str| output.lines().any(|line| line.trim() == marker);
            assert_eq!(contains(COMPARING_MARKER), comparing, "{output}");
            assert_eq!(contains(MATCHED_MARKER), matched, "{output}");
            assert_eq!(
                contains("FLASHSTUDIO_SUCCESS"),
                failure.is_empty(),
                "{output}"
            );
            assert_eq!(result.status.success(), failure.is_empty(), "{output}");
            let mut stage = VerificationStage::Connecting;
            for line in output.lines() {
                stage.observe(line);
            }
            assert_eq!(
                stage,
                if matched {
                    VerificationStage::Matched
                } else if comparing {
                    VerificationStage::Comparing
                } else {
                    VerificationStage::Connecting
                }
            );
        }
    }
    #[test]
    fn erase_is_explicit_and_bounded_to_selected_bank() {
        let mut r = request(Operation::Erase);
        assert!(build_plan(&r, None).is_err());
        r.erase_confirmed = true;
        r.bank = 1;
        r.first_sector = 2;
        r.last_sector = Some(5);
        let p = build_plan(&r, None).unwrap();
        assert!(p.args.last().unwrap().contains("flash erase_sector 1 2 5"));
        assert!(!p.args.last().unwrap().contains("reset run"));
        r.last_sector = Some(1);
        assert!(build_plan(&r, None).is_err());
    }
    #[test]
    fn invalid_address_and_file_are_rejected() {
        for address in ["-1", "0x100000000", "0x08000000; shutdown", ""] {
            assert!(parse_address(address).is_err());
        }
        assert!(image_type("firmware.txt").is_err());
        assert!(build_plan(&request(Operation::Flash), None).is_err());
    }
    #[test]
    fn quotes_prevent_tcl_substitution() {
        assert_eq!(
            tcl_word("a $x[exit];\"\\\n{}"),
            "\"a \\$x\\[exit\\];\\\"\\\\\\n\\{\\}\""
        );
    }
    #[test]
    fn all_adapters_and_speed_override() {
        for (adapter, file) in [
            (Adapter::Stlink, "stlink"),
            (Adapter::Jlink, "jlink"),
            (Adapter::CmsisDap, "cmsis-dap"),
        ] {
            let mut r = request(Operation::Probe);
            r.config.adapter = adapter;
            let p = build_plan(&r, None).unwrap();
            assert!(p.args.contains(&format!("interface/{file}.cfg")));
            let target = p
                .args
                .iter()
                .position(|s| s == "target/stm32f4x.cfg")
                .unwrap();
            let speed = p
                .args
                .iter()
                .position(|s| s == "adapter speed 4000")
                .unwrap();
            assert!(speed > target);
            assert!(p.args.iter().any(|s| s.contains("gdb port disabled")));
        }
    }

    #[test]
    fn bundled_openocd_parses_adapter_and_target_configs() {
        let engine = crate::bundled::from_root(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/openocd"),
        )
        .unwrap();
        for adapter in [Adapter::Stlink, Adapter::Jlink, Adapter::CmsisDap] {
            for transport in [Transport::Swd, Transport::Jtag] {
                let mut r = request(Operation::Probe);
                r.config.adapter = adapter;
                r.config.transport = transport;
                r.config.executable = engine.executable.to_string_lossy().into_owned();
                r.config.scripts_dir = engine.scripts.to_string_lossy().into_owned();
                let mut plan = build_plan(&r, None).unwrap();
                // Replace the entire operation BEFORE launching. OpenOCD exits
                // during configuration and never invokes init or a USB driver.
                *plan.args.last_mut().unwrap() = "echo CONFIG_PARSED; shutdown".into();
                let result = std::process::Command::new(&plan.executable)
                    .args(&plan.args)
                    .output()
                    .unwrap();
                let output = format!(
                    "{}{}",
                    String::from_utf8_lossy(&result.stdout),
                    String::from_utf8_lossy(&result.stderr)
                );
                assert!(
                    result.status.success(),
                    "{adapter:?} / {transport:?}: {output}"
                );
                assert!(output.contains("CONFIG_PARSED"));
            }
        }
    }

    #[test]
    fn bundled_openocd_executes_quoted_paths_and_propagates_verify_failure() {
        let engine = crate::bundled::from_root(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/openocd"),
        )
        .unwrap();
        // Jim Tcl itself parses the generated command. No target/adapter config
        // is loaded, and every hardware command is replaced before execution.
        let fixture = "foreach cmd {init reset flash verify_image} { if {[llength [info commands $cmd]]} {rename $cmd fs_original_$cmd}; proc $cmd {args} {} }; proc flash {args} {echo [lindex $args 2]}";
        let filename = "固件 } {$injection [exit]; \"C:\\file.bin";
        let plan = build_plan(
            &request(Operation::Flash),
            Some((Path::new(filename), "file.bin")),
        )
        .unwrap();
        for fail in [false, true] {
            let setup = if fail {
                format!("{fixture}; proc verify_image {{args}} {{error VERIFY_MISMATCH}}")
            } else {
                fixture.into()
            };
            let result = std::process::Command::new(&engine.executable)
                .args(["-c", &setup, "-c", plan.args.last().unwrap()])
                .output()
                .unwrap();
            let output = format!(
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(result.status.success(), !fail, "{output}");
            assert!(output.contains(filename), "{output}");
            assert_eq!(output.contains("FLASHSTUDIO_SUCCESS"), !fail, "{output}");
            if fail {
                assert!(output.contains("VERIFY_MISMATCH"));
            }
        }
    }

    #[test]
    fn frontend_cannot_override_bundled_engine_paths() {
        let mut value = serde_json::to_value(request(Operation::Probe).config).unwrap();
        value["executable"] = "/untrusted/old/openocd".into();
        value["scriptsDir"] = "/untrusted/scripts".into();
        let config: ConnectionConfig = serde_json::from_value(value).unwrap();
        assert!(config.executable.is_empty());
        assert!(config.scripts_dir.is_empty());
    }
}
