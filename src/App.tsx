import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon, type IconName } from "./components/Icon";
import { VerificationPanel } from "./components/verification/VerificationPanel";
import { fileSize, importFirmware, importMessage, type FirmwareImportState } from "./lib/firmware";
import appVersion from "../VERSION?raw";
import { adapters, adapterName, desktop, loadConfig, operationNames, statusNames, targetName, targets, validAddress, validate, type Config, type EngineInfo, type Firmware, type FirmwarePurpose, type Job, type Operation, type OperationRequest } from "./lib/flash";
import "./App.css";

const operationIcons: Record<Operation, IconName> = { probe: "plug", flash: "bolt", verify: "shield", erase: "trash" };
const operationDescriptions: Record<Operation, string> = { probe: "检测探针与目标芯片的连接", flash: "选择固件，写入目标芯片", verify: "核对参考固件与芯片内容的一致性", erase: "按 Bank 或扇区清除 Flash 内容" };
interface FirmwareInput { firmware: Firmware | null; address: string; resetAfter: boolean }
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="section-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" size={18}/></button></div>{children}
  </dialog>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function App() {
  const [config, setConfig] = useState(loadConfig);
  const [customTarget, setCustomTarget] = useState(() => !targets.some(t => t.path === config.target));
  const [operation, setOperation] = useState<Operation>("flash");
  const [firmwareInputs, setFirmwareInputs] = useState<Record<FirmwarePurpose, FirmwareInput>>({
    flash: { firmware: null, address: "0x08000000", resetAfter: true },
    verify: { firmware: null, address: "0x08000000", resetAfter: true },
  });
  const purpose: FirmwarePurpose = operation === "verify" ? "verify" : "flash";
  const { firmware, address, resetAfter } = firmwareInputs[purpose];
  const updateFirmwareInput = <K extends keyof FirmwareInput>(key: K, value: FirmwareInput[K]) =>
    setFirmwareInputs(current => ({ ...current, [purpose]: { ...current[purpose], [key]: value } }));
  const setAddress = (value: string) => updateFirmwareInput("address", value);
  const setResetAfter = (value: boolean) => updateFirmwareInput("resetAfter", value);
  const [verifyAfterWrite, setVerifyAfterWrite] = useState(true);
  const [bank, setBank] = useState("0");
  const [eraseMode, setEraseMode] = useState("bank");
  const [firstSector, setFirstSector] = useState("0");
  const [lastSector, setLastSector] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [pending, setPending] = useState(false);
  const [importing, setImporting] = useState<FirmwareImportState | null>(null);
  const [hydrating, setHydrating] = useState(desktop);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [help, setHelp] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem("flashstudio.theme") === "dark"; } catch { return false; } });
  const [tick, setTick] = useState(Date.now());
  const busyRef = useRef(false);
  const engineCheck = useRef<Promise<EngineInfo> | null>(null);
  const isRunning = job?.status === "running";
  const busy = pending || hydrating || isRunning;
  const updateConfig = <K extends keyof Config>(key: K, value: Config[K]) => setConfig(current => ({ ...current, [key]: value }));
  const request: OperationRequest = { config, operation, firmwareId: operation === "erase" ? null : firmware?.id ?? null, address, verifyAfterWrite: operation === "flash" && verifyAfterWrite, resetAfter,
    bank: bank.trim() ? Number(bank) : NaN, firstSector: eraseMode === "bank" ? 0 : firstSector.trim() ? Number(firstSector) : NaN,
    lastSector: eraseMode === "bank" || !lastSector.trim() ? null : Number(lastSector), eraseConfirmed: false };
  const validation = validate(request) || (operation !== "erase" && firmware?.format === "bin" && !validAddress(address) ? "请输入有效的 32 位 BIN 起始地址" : "");
  const eraseRange = `Bank ${bank} · ${eraseMode === "bank" ? "全部扇区" : `扇区 ${firstSector}–${lastSector.trim() || "末尾"}`}`;

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("flashstudio.theme", dark ? "dark" : "light"); } catch { /* Keep theme in memory. */ }
  }, [dark]);
  useEffect(() => {
    try {
      localStorage.setItem("flashstudio.config", JSON.stringify(config));
      localStorage.removeItem("flashstudio.records");
    } catch { setError("配置无法保存，本次会话仍可使用。"); }
  }, [config]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false; let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const result = await invoke<Job | null>("get_job");
        if (!disposed) setJob(current => current && (!result || result.startedAt < current.startedAt || (result.id === current.id && current.status !== "running" && result.status === "running")) ? current : result);
      } catch (e) { if (!disposed) setError(`读取任务状态失败：${String(e)}`); }
      finally { polling = false; }
    };
    const initialize = async () => {
      await poll();
      // StrictMode shares this promise instead of starting two engine checks.
      engineCheck.current ??= invoke<EngineInfo>("check_engine");
      try { const info = await engineCheck.current; if (!disposed) setEngine(info); }
      catch (e) { if (!disposed) setError(String(e)); }
      finally { if (!disposed) setHydrating(false); }
    };
    void initialize();
    const timer = setInterval(() => void poll(), 350);
    const unlisten = listen("close-blocked", () => setError("请等待当前任务完成或取消后，再关闭窗口。"));
    return () => { disposed = true; clearInterval(timer); void unlisten.then(fn => fn()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!job || job.status === "running") return;
    setCancelling(false);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!isRunning || job?.operation !== "verify") return;
    const timer = setInterval(() => setTick(Date.now()), 250); return () => clearInterval(timer);
  }, [isRunning, job?.operation]);
  const work = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setPending(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setPending(false); }
  }, []);
  const importFile = (file: File) => {
    if (busy || !desktop) return;
    void work(async () => {
      try {
        const imported = await importFirmware(file, purpose, setImporting);
        setFirmwareInputs(current => ({ ...current, [purpose]: { ...current[purpose], firmware: imported } }));
      } finally { setImporting(null); }
    });
  };
  const start = (next: Operation, confirmed = false) => {
    if (busy || !desktop) return;
    setEraseConfirm(false);
    void work(async () => {
      const input = next === "flash" || next === "verify" ? firmwareInputs[next] : null;
      const nextRequest = { ...request, operation: next, firmwareId: input?.firmware?.id ?? null,
        address: input?.address ?? "0x08000000", resetAfter: input?.resetAfter ?? false,
        verifyAfterWrite: next === "flash" && verifyAfterWrite, eraseConfirmed: confirmed };
      const problem = validate(nextRequest);
      if (problem) throw new Error(problem);
      setJob(await invoke<Job>("start_operation", { request: nextRequest }));
      setTick(Date.now());
    });
  };
  const authorize = () => {
    if (busy) return;
    void work(async () => {
      setNotice(await invoke<string>("authorize_usb"));
      setEngine(await invoke<EngineInfo>("check_engine"));
    });
  };
  const duration = job ? Math.max(0, ((job.finishedAt ?? tick) - job.startedAt) / 1000).toFixed(1) : "0.0";

  return <div className="app-shell" data-operation={operation}>
    <aside className="sidebar">
      <div className="brand-header">
        <img src="/flashstudio.svg" alt=""/>
        <div className="brand-meta">
          <div className="brand"><strong>Flash<span>Studio</span></strong></div>
          <span className="brand-version" aria-label={`应用版本 ${appVersion.trim()}`}>v{appVersion.trim()}</span>
        </div>
      </div>
      <div className="sidebar-label">烧录工具</div>
      <nav aria-label="烧录工具">{(["flash", "verify", "erase"] as const).map(op => <button key={op} disabled={busy} className={`nav-item ${operation === op ? "active" : ""}`} aria-current={operation === op ? "page" : undefined} onClick={() => setOperation(op)}><Icon name={operationIcons[op]} size={18}/><span>{operationNames[op]}</span></button>)}</nav>
      <div className="sidebar-bottom">
        <div className="engine-card" title={engine ? `内置 OpenOCD ${engine.version}` : undefined}><div className="engine-name"><Icon name="cpu" size={16}/><strong>OpenOCD</strong><span>内置</span></div><div className="engine-badge"><i className={`status-dot ${engine ? "ready" : ""}`}/>{desktop ? hydrating ? "正在准备引擎" : engine ? "内置引擎就绪" : "引擎未就绪" : "浏览器预览"}</div></div>
        <div className="sidebar-actions"><button className="help-button" onClick={() => setHelp(true)}><Icon name="help" size={17}/>使用说明</button><button className="icon-button" aria-label={dark ? "切换浅色主题" : "切换深色主题"} title={dark ? "切换浅色主题" : "切换深色主题"} onClick={() => setDark(!dark)}><Icon name={dark ? "sun" : "moon"} size={17}/></button></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div><h1>{operationNames[operation]}</h1><p>{operationDescriptions[operation]}</p></div><span className="workspace-label"><Icon name="grid" size={14}/>烧录工作台</span></header>
    <main>
      {error && <div className="notice error" role="alert"><Icon name="info" size={17}/><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError("")}><Icon name="close" size={15}/></button></div>}
      {notice && <div className="notice success" role="status"><Icon name="check" size={17}/><span>{notice}</span></div>}
      {!desktop && <div className="preview-notice">当前为界面预览，连接设备请使用桌面应用。</div>}
      <section className="card connection-card">
        <div className="section-heading"><h2><Icon name="plug" size={18}/>{operation === "verify" ? "校验目标" : "连接设备"}</h2><button className="text-button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>高级设置<Icon name="down" size={13} className={advanced ? "expanded" : ""}/></button></div>
        <div className="connection-row">
          <fieldset className="connection-fields" disabled={busy}>
            <Field label={operation === "verify" ? "连接探针" : "烧录探针"}><select aria-label={operation === "verify" ? "连接探针" : "烧录探针"} value={config.adapter} onChange={e => updateConfig("adapter", e.target.value as Config["adapter"])}>{adapters.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="目标芯片"><select aria-label="目标芯片" value={customTarget ? "custom" : config.target} onChange={e => { const custom = e.target.value === "custom"; setCustomTarget(custom); updateConfig("target", custom ? "" : e.target.value); if (custom) setAdvanced(true); }}>{targets.map(t => <option key={t.path} value={t.path}>{t.name}</option>)}<option value="custom">自定义配置…</option></select></Field>
            <Field label="时钟 (kHz)"><select aria-label="接口时钟" value={config.speedKhz} onChange={e => updateConfig("speedKhz", Number(e.target.value))}>{[100, 500, 1000, 2000, 4000, 8000].map(speed => <option key={speed} value={speed}>{speed}</option>)}{![100,500,1000,2000,4000,8000].includes(config.speedKhz) && <option value={config.speedKhz}>{config.speedKhz}</option>}</select></Field>
          </fieldset>
          <button className="secondary probe-button" disabled={busy || !desktop || !engine} onClick={() => start("probe")}><Icon name="plug" size={15}/>检测连接</button>
        </div>
        {advanced && <div className="advanced-panel">
          <fieldset disabled={busy}>
            <div className="advanced-grid"><Field label="传输接口"><select value={config.transport} onChange={e => updateConfig("transport", e.target.value as Config["transport"])}><option value="swd">SWD</option><option value="jtag">JTAG</option></select></Field><Field label="探针序列号"><input value={config.serial} onChange={e => updateConfig("serial", e.target.value)} placeholder="留空自动选择"/></Field><Field label="任务超时（秒）"><input type="number" min="5" max="3600" value={config.timeoutSecs || ""} onChange={e => updateConfig("timeoutSecs", Number(e.target.value))}/></Field></div>
            {customTarget && <Field label="目标配置路径"><input aria-label="目标配置路径" value={config.target} onChange={e => updateConfig("target", e.target.value)} placeholder="target/stm32h7x_dual_bank.cfg"/></Field>}
            <div className="advanced-bottom"><label className="checkbox"><input type="checkbox" checked={config.connectUnderReset} onChange={e => updateConfig("connectUnderReset", e.target.checked)}/><span>复位下连接 <small>需连接 NRST</small></span></label><span className="muted">默认使用 SWD · 检测连接会复位芯片</span></div>
          </fieldset>
          {engine?.canAuthorizeUsb && <div className="usb-access"><span><Icon name="shield" size={15}/>{engine.usbRulesInstalled ? "USB 权限已配置" : "首次使用或提示权限不足时，可授权访问探针。"}</span><button className="secondary small" disabled={busy} onClick={authorize}>授权访问探针</button></div>}
        </div>}
        {operation === "verify" && job?.operation === "probe" && <div className="verification-probe-status" role="status"><Icon name={isRunning ? "refresh" : job.status === "success" ? "check" : "info"} size={15} className={isRunning ? "spinning" : ""}/><span>连接检测 · {statusNames[job.status]} · {job.message}</span>{isRunning && <button className="danger-outline small" disabled={cancelling} onClick={() => setCancelConfirm(true)}>{cancelling ? "正在取消…" : "取消检测"}</button>}</div>}
      </section>
      {operation === "verify" ? <VerificationPanel firmware={firmware} importing={importing} config={config} address={address} resetAfter={resetAfter} job={job} duration={duration}
        busy={busy} canImport={!busy && desktop} canStart={!busy && desktop && !!engine && !validation} cancelling={cancelling} validation={validation}
        onImport={importFile} onAddress={setAddress} onResetAfter={setResetAfter} onStart={() => start("verify")} onCancel={() => setCancelConfirm(true)}/>
      : <section className="card firmware-card">
        <div className="section-heading"><h2><Icon name={operation === "erase" ? "trash" : "archive"} size={18}/>{operation === "erase" ? "擦除范围" : "固件文件"}</h2><span className="muted">{operation === "erase" ? "请确认目标区域" : "支持拖放文件"}</span></div>
        <fieldset disabled={busy}>
          {operation !== "erase" ? <>
            <label className={`firmware-drop ${dragging ? "dragging" : ""} ${firmware ? "has-file" : ""} ${importing ? "importing" : ""}`} aria-busy={!!importing} onDragOver={e => { e.preventDefault(); if (!busy && desktop) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) importFile(file); }}>
              <input type="file" aria-label="选择固件文件" accept=".bin,.hex,.ihex,.elf,.axf" disabled={busy || !desktop} onChange={e => { const file = e.target.files?.[0]; if (file) importFile(file); e.target.value = ""; }}/>
              <span className="file-icon"><Icon name={importing ? "refresh" : firmware ? "archive" : "download"} className={importing ? "spinning" : ""} size={25}/></span><strong>{importing?.name ?? firmware?.name ?? "选择或拖入固件文件"}</strong><span>{importing ? `${fileSize(importing.size)} · ${importMessage(importing)}` : firmware ? `${fileSize(firmware.size)} · ${firmware.format.toUpperCase()} · 点击更换` : "BIN / HEX / ELF / AXF"}</span>
            </label>
            <div className="firmware-options"><Field label="烧录地址"><input className="mono" aria-label="BIN 起始地址" value={firmware && firmware.format !== "bin" ? "使用文件内地址" : address} disabled={!!firmware && firmware.format !== "bin"} onChange={e => setAddress(e.target.value)} spellCheck={false}/></Field><div className="write-options"><label className="checkbox"><input type="checkbox" checked={verifyAfterWrite} onChange={e => setVerifyAfterWrite(e.target.checked)}/><span>烧录后校验</span></label><label className="checkbox"><input type="checkbox" checked={resetAfter} onChange={e => setResetAfter(e.target.checked)}/><span>完成后运行</span></label></div></div>
            <p className="footnote">BIN 需确认起始地址；烧录将擦除固件覆盖的扇区。</p>
          </> : <div className="erase-panel">
            <div className="erase-intro"><Icon name="trash" size={24}/><div><h3>指定区域擦除</h3><p>仅擦除所选 Bank，双 Bank 芯片需分别操作。</p></div></div>
            <div className="form-row"><Field label="Flash Bank 编号"><input aria-label="Flash Bank 编号" type="number" min="0" max="255" value={bank} onChange={e => setBank(e.target.value)}/></Field><Field label="擦除方式"><select value={eraseMode} onChange={e => setEraseMode(e.target.value)}><option value="bank">该 Bank 全部扇区</option><option value="sectors">指定扇区范围</option></select></Field></div>
            {eraseMode === "sectors" && <div className="form-row"><Field label="起始扇区"><input type="number" min="0" value={firstSector} onChange={e => setFirstSector(e.target.value)}/></Field><Field label="结束扇区"><input type="number" min="0" value={lastSector} placeholder="留空至末尾" onChange={e => setLastSector(e.target.value)}/></Field></div>}
            <p className="footnote warning">擦除不可恢复，请先检测连接，并确认 Bank 编号及扇区范围。</p>
          </div>}
        </fieldset>
        <div className="execution-row">
          <div className="execution-status"><span className={`run-icon ${importing ? "running" : job?.status ?? ""}`}><Icon name={importing || isRunning ? "refresh" : job?.status === "success" ? "check" : job?.status === "failed" ? "info" : "circle"} size={19} className={importing || isRunning ? "spinning" : ""}/></span><div><strong>{importing ? "正在导入固件" : isRunning ? `${operationNames[job.operation]}进行中` : job ? `${operationNames[job.operation]} · ${statusNames[job.status]}` : "准备就绪"}</strong><p role="status">{importing ? "请稍候，导入完成后即可操作。" : job ? job.message : validation || "可以开始操作"}</p></div></div>
          {isRunning ? <button className="danger-outline" disabled={cancelling} onClick={() => setCancelConfirm(true)}><Icon name="pause" size={15}/>{cancelling ? "正在取消…" : "取消操作"}</button> : <button className={operation === "erase" ? "danger" : "primary"} disabled={busy || !desktop || !engine || !!validation} onClick={() => operation === "erase" ? setEraseConfirm(true) : start(operation)}><Icon name={importing ? "refresh" : operationIcons[operation]} className={importing ? "spinning" : ""} size={17}/>{importing ? "正在导入…" : pending ? "处理中…" : operation === "flash" ? "开始烧录" : "擦除 Flash"}</button>}
        </div>
        {isRunning && <div className="activity-track" aria-label="OpenOCD 正在执行"><span/></div>}
      </section>}
    </main>
    </div>
    {eraseConfirm && <Modal title="确认擦除 Flash" close={() => setEraseConfirm(false)}><div className="modal-copy"><p>{targetName(config.target)} · {adapterName(config.adapter)}{config.serial ? ` · ${config.serial}` : ""}</p><div className="confirm-range mono">{eraseRange}</div><p>此范围内的固件和数据将被清除，无法撤销。擦除后芯片保持暂停。</p></div><div className="modal-actions"><button autoFocus className="secondary" onClick={() => setEraseConfirm(false)}>返回检查</button><button className="danger" onClick={() => start("erase", true)}>确认擦除</button></div></Modal>}
    {cancelConfirm && <Modal title="取消当前操作" close={() => setCancelConfirm(false)}><div className="modal-copy"><p>{job?.operation === "verify" ? "将停止本次校验。未完成的比较不能代表完整校验结果，可稍后重新开始。" : job?.operation === "probe" ? "将停止本次连接检测。" : "已写入或擦除的数据无法回滚，取消后请重新烧录并校验。"}</p></div><div className="modal-actions"><button autoFocus className="secondary" onClick={() => setCancelConfirm(false)}>继续等待</button><button className="danger" onClick={() => { setCancelConfirm(false); setCancelling(true); void invoke("cancel_operation", { jobId: job!.id }).catch(e => { setCancelling(false); setError(String(e)); }); }}>确认取消</button></div></Modal>}
    {help && <Modal title="使用说明" close={() => setHelp(false)}><div className="modal-copy help-copy"><ol><li>为目标板供电，连接探针，选择对应芯片。</li><li>选择固件；BIN 按实际内存布局填写起始地址。</li><li>点击开始烧录，等待校验完成。</li></ol><p>软件已自带 OpenOCD，无需另外安装或配置路径。</p>{engine?.canAuthorizeUsb ? <><p>Linux 提示 USB 权限不足时，点击下方按钮，经系统授权后安装权限规则，再重新插拔探针。</p><button className="secondary" disabled={busy} onClick={authorize}><Icon name="shield" size={16}/>授权访问探针</button>{notice && <p className="success-text" role="status">{notice}</p>}{error && <p className="warning" role="alert">{error}</p>}</> : <p>Windows 的 USB 探针需要兼容驱动；无法连接时请检查驱动、目标板供电与接线。</p>}<p>检测连接会复位芯片。复位下连接需 NRST，可在高级设置中启用。</p><small className="muted">内置 OpenOCD {engine?.version ?? "0.12.0-7"}</small></div></Modal>}
  </div>;
}
export default App;
