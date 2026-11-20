use crate::engine::Plan;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Success,
    Failed(String),
    Cancelled,
    TimedOut,
}

#[derive(Default)]
struct ErrorSummary(Option<String>);

impl ErrorSummary {
    fn observe(&mut self, line: &str) {
        let line = line.trim();
        let explicit = line.strip_prefix("FLASHSTUDIO_ERROR:");
        let detail = explicit.or_else(|| {
            line.strip_prefix("Error")
                .or_else(|| line.strip_prefix("ERROR"))?
                .trim_start()
                .strip_prefix(':')
        });
        if let Some(detail) = detail.map(str::trim).filter(|text| !text.is_empty())
            && (explicit.is_some() || self.0.is_none())
        {
            // A single bounded reason replaces the former raw log history.
            let mut chars = detail.chars().filter(|c| !c.is_control());
            let mut summary: String = chars.by_ref().take(320).collect();
            if chars.next().is_some() {
                summary.push('…');
            }
            if !summary.is_empty() {
                self.0 = Some(summary);
            }
        }
    }
}

fn reader(
    stream: impl Read + Send + 'static,
    output: Arc<dyn Fn(String) + Send + Sync>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut stream = BufReader::new(stream);
        loop {
            let mut bytes = Vec::new();
            match stream.by_ref().take(8192).read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(_) => output(String::from_utf8_lossy(&bytes).trim_end().to_owned()),
            }
        }
    })
}

pub fn execute(
    plan: &Plan,
    cancelled: Arc<AtomicBool>,
    output: Arc<dyn Fn(String) + Send + Sync>,
) -> Outcome {
    if cancelled.load(Ordering::SeqCst) {
        return Outcome::Cancelled;
    }
    let mut command = Command::new(&plan.executable);
    command
        .args(&plan.args)
        .env_remove("OPENOCD_SCRIPTS")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let executable = std::path::Path::new(&plan.executable);
    if executable.is_absolute()
        && let Some(parent) = executable.parent()
    {
        command.current_dir(parent);
    }
    crate::platform::configure_process(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Outcome::Failed(format!("无法启动 OpenOCD：{error}。请检查可执行文件路径。"));
        }
    };
    let error_summary = Arc::new(Mutex::new(ErrorSummary::default()));
    let capture = error_summary.clone();
    let on_output = Arc::new(move |line: String| {
        capture.lock().unwrap().observe(&line);
        output(line);
    });
    let stdout = reader(child.stdout.take().unwrap(), on_output.clone());
    let stderr = reader(child.stderr.take().unwrap(), on_output);
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Outcome::Success
                } else {
                    Outcome::Failed(format!(
                        "OpenOCD 退出码：{}",
                        status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "被信号终止".into())
                    ))
                };
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Outcome::Failed(error.to_string());
            }
            Ok(None) => {}
        }
        let cancel = cancelled.load(Ordering::SeqCst);
        if cancel || started.elapsed() >= Duration::from_secs(plan.timeout_secs) {
            let _ = child.kill();
            let _ = child.wait();
            break if cancel {
                Outcome::Cancelled
            } else {
                Outcome::TimedOut
            };
        }
        thread::sleep(Duration::from_millis(40));
    };
    let _ = stdout.join();
    let _ = stderr.join();
    match result {
        Outcome::Failed(error) => {
            let summary = error_summary.lock().unwrap();
            Outcome::Failed(match &summary.0 {
                Some(detail) => format!("{error}；{detail}"),
                None => format!("{error}；请检查探针连接与目标配置"),
            })
        }
        outcome => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn error_summary_is_bounded_and_preserves_the_failure_reason() {
        let mut summary = ErrorSummary::default();
        summary.observe("Info : ready");
        summary.observe("FLASHSTUDIO_ERROR: ");
        assert!(summary.0.is_none());
        summary.observe("Error : unable to open probe");
        summary.observe("Error: generic shutdown failure");
        summary.observe("Info : shutdown requested");
        assert_eq!(summary.0.as_deref(), Some("unable to open probe"));
        summary.observe("FLASHSTUDIO_ERROR: verify mismatch");
        assert_eq!(summary.0.as_deref(), Some("verify mismatch"));
        summary.observe(&format!("FLASHSTUDIO_ERROR: {}", "错".repeat(1000)));
        assert_eq!(summary.0.unwrap(), format!("{}…", "错".repeat(320)));
    }
    #[cfg(unix)]
    fn plan(script: &str, timeout: u64) -> Plan {
        Plan {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            timeout_secs: timeout,
        }
    }
    #[cfg(unix)]
    #[test]
    fn captures_both_streams_and_nonzero_exit() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let copy = lines.clone();
        let result = execute(
            &plan(
                "echo info; echo 'Error: unable to open probe' >&2; echo 'Info : shutdown' >&2; exit 7",
                2,
            ),
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |s| copy.lock().unwrap().push(s)),
        );
        assert_eq!(
            result,
            Outcome::Failed("OpenOCD 退出码：7；unable to open probe".into())
        );
        let lines = lines.lock().unwrap();
        assert!(lines.contains(&"info".into()));
        assert!(lines.contains(&"Error: unable to open probe".into()));
    }
    #[cfg(unix)]
    #[test]
    fn timeout_and_cancellation_reap_process() {
        assert_eq!(
            execute(
                &plan("exec sleep 10", 0),
                Arc::new(AtomicBool::new(false)),
                Arc::new(|_| {})
            ),
            Outcome::TimedOut
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let copy = cancel.clone();
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            copy.store(true, Ordering::SeqCst);
        });
        assert_eq!(
            execute(&plan("exec sleep 10", 3), cancel, Arc::new(|_| {})),
            Outcome::Cancelled
        );
        trigger.join().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn missing_executable_and_success() {
        let mut p = plan("exit 0", 1);
        assert_eq!(
            execute(&p, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})),
            Outcome::Success
        );
        p.executable = "/definitely-not-a-flashstudio-executable".into();
        assert!(matches!(
            execute(&p, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})),
            Outcome::Failed(_)
        ));
    }
}
