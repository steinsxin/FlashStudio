use crate::engine::Plan;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    sync::{
        Arc,
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Outcome::Failed(format!("无法启动 OpenOCD：{error}。请检查可执行文件路径。"));
        }
    };
    let stdout = reader(child.stdout.take().unwrap(), output.clone());
    let stderr = reader(child.stderr.take().unwrap(), output);
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Outcome::Success
                } else {
                    Outcome::Failed(format!(
                        "OpenOCD 退出码：{}，请查看运行日志",
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
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn plan(script: &str, timeout: u64) -> Plan {
        Plan {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            timeout_secs: timeout,
        }
    }
    #[test]
    fn captures_both_streams_and_nonzero_exit() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let copy = lines.clone();
        let result = execute(
            &plan("echo info; echo error >&2; exit 7", 2),
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |s| copy.lock().unwrap().push(s)),
        );
        assert!(matches!(result, Outcome::Failed(_)));
        let lines = lines.lock().unwrap();
        assert!(lines.contains(&"info".into()));
        assert!(lines.contains(&"error".into()));
    }
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
