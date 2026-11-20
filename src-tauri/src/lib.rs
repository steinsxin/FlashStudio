mod bundled;
mod engine;
mod platform;
mod runner;

use engine::{Operation, OperationRequest, Plan};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

const MAX_IMAGE: usize = 32 * 1024 * 1024;
static COUNTER: AtomicU64 = AtomicU64::new(0);
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        now(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FirmwareInfo {
    id: String,
    name: String,
    size: usize,
    format: String,
    sha256: String,
}
struct Firmware {
    info: FirmwareInfo,
    path: PathBuf,
}
impl Drop for Firmware {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine {
    sequence: u64,
    time: u64,
    text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    operation: Operation,
    status: String,
    started_at: u64,
    finished_at: Option<u64>,
    message: String,
    logs: VecDeque<LogLine>,
    next_sequence: u64,
    plan: Plan,
    request: OperationRequest,
    firmware: Option<FirmwareInfo>,
}
impl Job {
    fn log(&mut self, text: String) {
        self.logs.push_back(LogLine {
            sequence: self.next_sequence,
            time: now(),
            text,
        });
        self.next_sequence += 1;
        if self.logs.len() > 1000 {
            self.logs.pop_front();
        }
    }
}
#[derive(Default)]
struct Runtime {
    firmware: Option<Arc<Firmware>>,
    job: Option<Job>,
    cancel: Option<Arc<AtomicBool>>,
    checking: bool,
}
#[derive(Clone, Default)]
struct Studio(Arc<Mutex<Runtime>>);
impl Studio {
    fn busy(&self) -> bool {
        let r = self.0.lock().unwrap();
        r.cancel.is_some() || r.checking
    }
}

#[tauri::command]
async fn import_firmware(
    name: String,
    bytes: Vec<u8>,
    studio: State<'_, Studio>,
) -> Result<FirmwareInfo, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE {
        return Err("固件须非空，且不超过 32 MiB".into());
    }
    let format = engine::image_type(&name)?;
    let mut state = studio.0.lock().map_err(|e| e.to_string())?;
    if state.cancel.is_some() || state.checking {
        return Err("任务执行期间不能更换固件".into());
    }
    let info = FirmwareInfo {
        id: id(),
        name,
        size: bytes.len(),
        format: format.into(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
    };
    // A private snapshot cannot change mid-job. The original filename is only
    // metadata; only our generated basename reaches the filesystem.
    let path = std::env::temp_dir().join(format!("flashstudio-{}.{}", info.id, format));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("无法缓存固件：{e}"))?;
    if let Err(e) = file.write_all(&bytes) {
        let _ = fs::remove_file(&path);
        return Err(e.to_string());
    }
    state.firmware = Some(Arc::new(Firmware {
        info: info.clone(),
        path,
    }));
    Ok(info)
}

fn plan_for(request: &OperationRequest, runtime: &Runtime) -> Result<Plan, String> {
    let firmware = if matches!(request.operation, Operation::Flash | Operation::Verify) {
        let firmware = runtime.firmware.as_ref().ok_or("请先选择固件文件")?;
        if request.firmware_id.as_deref() != Some(&firmware.info.id) {
            return Err("固件已变更，请重新选择".into());
        }
        if !firmware.path.is_file() {
            return Err("固件缓存已丢失，请重新选择文件".into());
        }
        Some((firmware.path.as_path(), firmware.info.name.as_str()))
    } else {
        None
    };
    engine::build_plan(request, firmware)
}

#[tauri::command]
fn start_operation(
    mut request: OperationRequest,
    app: tauri::AppHandle,
    studio: State<'_, Studio>,
) -> Result<Job, String> {
    let engine = bundled::resolve(&app)?;
    request.config.executable = engine.executable.to_str().ok_or("引擎路径无法识别")?.into();
    request.config.scripts_dir = engine
        .scripts
        .to_str()
        .ok_or("引擎脚本路径无法识别")?
        .into();
    let mut runtime = studio.0.lock().map_err(|e| e.to_string())?;
    if runtime.cancel.is_some() || runtime.checking {
        return Err("已有任务正在执行".into());
    }
    let plan = plan_for(&request, &runtime)?;
    let mut job = Job {
        id: id(),
        operation: request.operation,
        status: "running".into(),
        started_at: now(),
        finished_at: None,
        message: "OpenOCD 正在执行".into(),
        logs: VecDeque::new(),
        next_sequence: 0,
        plan: plan.clone(),
        request: request.clone(),
        firmware: runtime.firmware.as_ref().map(|f| f.info.clone()),
    };
    job.log(format!(
        "开始 {:?} · {}",
        request.operation, request.config.target
    ));
    runtime.job = Some(job.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    runtime.cancel = Some(cancel.clone());
    let shared = studio.inner().clone();
    let job_id = job.id.clone();
    let firmware = runtime.firmware.clone();
    std::thread::spawn(move || {
        let _firmware = firmware;
        let success_marker = Arc::new(AtomicBool::new(false));
        let marker = success_marker.clone();
        let output_state = shared.clone();
        let output_id = job_id.clone();
        let result = runner::execute(
            &plan,
            cancel,
            Arc::new(move |text| {
                if text.trim() == "FLASHSTUDIO_SUCCESS" {
                    marker.store(true, Ordering::SeqCst);
                }
                if let Ok(mut runtime) = output_state.0.lock()
                    && let Some(job) = runtime.job.as_mut().filter(|j| j.id == output_id)
                {
                    job.log(text);
                }
            }),
        );
        let (status, message) = match result {
            runner::Outcome::Success if success_marker.load(Ordering::SeqCst) => {
                ("success", "操作完成".to_string())
            }
            runner::Outcome::Success => (
                "failed",
                "OpenOCD 未返回操作完成标记，请检查配置与日志".into(),
            ),
            runner::Outcome::Failed(error) => ("failed", error),
            runner::Outcome::Cancelled => (
                "cancelled",
                "操作已取消；写入或擦除可能已部分执行，请重新烧录后校验".into(),
            ),
            runner::Outcome::TimedOut => (
                "failed",
                format!(
                    "操作超过 {} 秒，已终止；请检查连接并重新确认芯片内容",
                    plan.timeout_secs
                ),
            ),
        };
        if let Ok(mut runtime) = shared.0.lock() {
            if let Some(job) = runtime.job.as_mut().filter(|j| j.id == job_id) {
                job.status = status.into();
                job.message = message.clone();
                job.finished_at = Some(now());
                job.log(message);
            }
            runtime.cancel = None;
        }
    });
    Ok(job)
}

#[tauri::command]
fn get_job(studio: State<'_, Studio>) -> Option<Job> {
    studio.0.lock().ok()?.job.clone()
}

#[tauri::command]
fn cancel_operation(job_id: String, studio: State<'_, Studio>) -> Result<(), String> {
    let runtime = studio.0.lock().map_err(|e| e.to_string())?;
    if runtime.job.as_ref().is_none_or(|j| j.id != job_id) {
        return Err("任务已变更".into());
    }
    if let Some(cancel) = &runtime.cancel {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn check_engine(
    app: tauri::AppHandle,
    studio: State<'_, Studio>,
) -> Result<bundled::EngineInfo, String> {
    let engine = bundled::resolve(&app)?;
    {
        let mut state = studio.0.lock().map_err(|e| e.to_string())?;
        if state.cancel.is_some() {
            return Ok(engine.info);
        }
        if state.checking {
            return Err("已有任务正在执行".into());
        }
        state.checking = true;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = lines.clone();
        let result = runner::execute(
            &Plan {
                executable: engine.executable.to_string_lossy().into_owned(),
                args: vec!["--version".into()],
                timeout_secs: 5,
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |line| {
                let mut lines = copy.lock().unwrap();
                if lines.len() < 20 {
                    lines.push(line);
                }
            }),
        );
        if result != runner::Outcome::Success {
            return Err(format!("OpenOCD 检测失败：{result:?}"));
        }
        let lines = lines.lock().unwrap();
        lines
            .iter()
            .find(|s| s.contains("Open On-Chip Debugger"))
            .cloned()
            .ok_or_else(|| "可执行文件未返回 OpenOCD 版本信息".into())
    })
    .await
    .map_err(|e| e.to_string());
    studio.0.lock().map_err(|e| e.to_string())?.checking = false;
    result??;
    Ok(bundled::resolve(&app)?.info)
}

#[tauri::command]
async fn authorize_usb(app: tauri::AppHandle, studio: State<'_, Studio>) -> Result<String, String> {
    if !platform::CAN_AUTHORIZE_USB {
        return Err("此功能仅用于 Linux USB 权限配置".into());
    }
    bundled::resolve(&app)?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    {
        let mut state = studio.0.lock().map_err(|e| e.to_string())?;
        if state.cancel.is_some() || state.checking {
            return Err("请等待当前任务完成".into());
        }
        state.checking = true;
    }
    let result = tauri::async_runtime::spawn_blocking(move || platform::authorize_usb(&resources))
        .await
        .map_err(|e| e.to_string());
    studio.0.lock().map_err(|e| e.to_string())?.checking = false;
    result?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Studio::default())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Studio>().busy() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", ());
                } else if let Ok(mut runtime) = window.state::<Studio>().0.lock() {
                    runtime.firmware = None;
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            import_firmware,
            start_operation,
            get_job,
            cancel_operation,
            check_engine,
            authorize_usb
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlashStudio");
}
