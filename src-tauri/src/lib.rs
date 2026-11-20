mod bundled;
mod engine;
mod firmware;
mod platform;
mod runner;
mod verification;

use engine::{Operation, OperationRequest, Plan};
use firmware::{FirmwareFiles, FirmwareInfo, FirmwarePurpose};
use serde::Serialize;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

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
struct Job {
    id: String,
    operation: Operation,
    status: String,
    started_at: u64,
    finished_at: Option<u64>,
    message: String,
    request: OperationRequest,
    firmware: Option<FirmwareInfo>,
    verification_stage: Option<verification::VerificationStage>,
}
impl Job {
    fn observe_output(&mut self, text: &str) {
        // Keep only the current milestone; raw engine output is not retained.
        if let Some(stage) = self.verification_stage.as_mut() {
            stage.observe(text);
        }
    }
}
#[derive(Default)]
struct Runtime {
    firmware: FirmwareFiles,
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
    purpose: FirmwarePurpose,
    name: String,
    bytes: Vec<u8>,
    studio: State<'_, Studio>,
) -> Result<FirmwareInfo, String> {
    let mut state = studio.0.lock().map_err(|e| e.to_string())?;
    if state.cancel.is_some() || state.checking {
        return Err("任务执行期间不能更换固件".into());
    }
    state.firmware.import(purpose, name, &bytes)
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
    let firmware = runtime
        .firmware
        .select(request.operation, request.firmware_id.as_deref())?;
    let plan = engine::build_plan(
        &request,
        firmware
            .as_ref()
            .map(|f| (f.path.as_path(), f.info.name.as_str())),
    )?;
    let job = Job {
        id: id(),
        operation: request.operation,
        status: "running".into(),
        started_at: now(),
        finished_at: None,
        message: "OpenOCD 正在执行".into(),
        request: request.clone(),
        firmware: firmware.as_ref().map(|f| f.info.clone()),
        verification_stage: (request.operation == Operation::Verify)
            .then_some(verification::VerificationStage::Connecting),
    };
    runtime.job = Some(job.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    runtime.cancel = Some(cancel.clone());
    let shared = studio.inner().clone();
    let job_id = job.id.clone();
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
                    job.observe_output(&text);
                }
            }),
        );
        let (status, message) = match result {
            runner::Outcome::Success if success_marker.load(Ordering::SeqCst) => (
                "success",
                if request.operation == Operation::Verify {
                    "固件校验通过，目标内容与参考固件一致".to_string()
                } else {
                    "操作完成".to_string()
                },
            ),
            runner::Outcome::Success => (
                "failed",
                "OpenOCD 未确认操作完成，请检查目标配置并重试".into(),
            ),
            runner::Outcome::Failed(error) => ("failed", error),
            runner::Outcome::Cancelled if request.operation == Operation::Verify => {
                ("cancelled", "校验任务已取消，可重新开始校验".into())
            }
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
                job.message = message;
                job.finished_at = Some(now());
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
                    runtime.firmware = FirmwareFiles::default();
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
