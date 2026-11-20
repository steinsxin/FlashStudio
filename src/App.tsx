import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon, type IconName } from "./components/Icon";
import { adapters, adapterName, defaults, desktop, download, loadConfig, loadRecords, operationNames, planText, statusNames, targetName, targets, validAddress, validate, type Config, type Firmware, type Job, type Operation, type OperationRequest, type Plan, type RecordEntry } from "./lib/flash";
import "./App.css";

type Page = "workspace" | "records" | "settings";
const pages: { id: Page; label: string; icon: IconName; subtitle: string }[] = [
  { id: "workspace", label: "烧录工作台", icon: "grid", subtitle: "连接探针，选择固件，完成芯片烧录。" },
  { id: "records", label: "操作记录", icon: "clock", subtitle: "追溯每一次烧录、校验与擦除。" },
  { id: "settings", label: "引擎设置", icon: "settings", subtitle: "配置本机 OpenOCD 与运行偏好。" },
];
const operationIcons: Record<Operation, IconName> = { probe: "plug", flash: "bolt", verify: "shield", erase: "trash" };
const time = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const size = (value: number) => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="card-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" size={18}/></button></div>{children}
  </dialog>;
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function App() {
  const [page, setPage] = useState<Page>("workspace");
  const [config, setConfig] = useState(loadConfig);
  const [customTarget, setCustomTarget] = useState(() => !targets.some(t => t.path === config.target));
  const [operation, setOperation] = useState<Operation>("flash");
  const [firmware, setFirmware] = useState<Firmware | null>(null);
  const [address, setAddress] = useState("0x08000000");
  const [verifyAfterWrite, setVerifyAfterWrite] = useState(true);
  const [resetAfter, setResetAfter] = useState(true);
  const [bank, setBank] = useState("0");
  const [eraseMode, setEraseMode] = useState("bank");
  const [firstSector, setFirstSector] = useState("0");
  const [lastSector, setLastSector] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [records, setRecords] = useState(loadRecords);
  const [pending, setPending] = useState(false);
  const [hydrating, setHydrating] = useState(desktop);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState<{ path: string; version: string } | null>(null);
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [help, setHelp] = useState(false);
  const [preview, setPreview] = useState<Plan | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<RecordEntry | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem("flashstudio.theme") === "dark"; } catch { return false; } });
  const [tick, setTick] = useState(Date.now());
  const busyRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  const isRunning = job?.status === "running";
  const busy = pending || hydrating || isRunning;
  const updateConfig = <K extends keyof Config>(key: K, value: Config[K]) => setConfig(current => ({ ...current, [key]: value }));
  const request: OperationRequest = { config, operation, firmwareId: firmware?.id ?? null, address, verifyAfterWrite, resetAfter,
    bank: bank.trim() ? Number(bank) : NaN, firstSector: eraseMode === "bank" ? 0 : firstSector.trim() ? Number(firstSector) : NaN,
    lastSector: eraseMode === "bank" || !lastSector.trim() ? null : Number(lastSector), eraseConfirmed: false };
  const validation = validate(request) || (operation !== "erase" && firmware?.format === "bin" && !validAddress(address) ? "请输入有效的 32 位 BIN 起始地址" : "");
  const eraseRange = `Bank ${bank} · ${eraseMode === "bank" ? "全部扇区" : `扇区 ${firstSector}–${lastSector.trim() || "末尾"}`}`;
  const version = engine?.path === config.executable ? engine.version : "";

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("flashstudio.theme", dark ? "dark" : "light"); } catch { /* Theme still works in memory. */ }
  }, [dark]);
  useEffect(() => { try { localStorage.setItem("flashstudio.config", JSON.stringify(config)); } catch { setError("配置无法保存到本地存储，本次会话仍可使用。"); } }, [config]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false; let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const result = await invoke<Job | null>("get_job");
        if (!disposed) {
          setJob(current => current && (!result || result.startedAt < current.startedAt || (result.id === current.id && current.status !== "running" && result.status === "running")) ? current : result);
          setHydrating(false);
        }
      } catch (e) { if (!disposed) setError(`读取任务状态失败：${String(e)}`); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 350);
    const unlisten = listen("close-blocked", () => setError("任务正在执行，请等待完成或先取消任务，再关闭窗口。"));
    return () => { disposed = true; clearInterval(timer); void unlisten.then(fn => fn()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!job || job.status === "running") return;
    setCancelling(false);
    setRecords(current => {
      if (current.some(r => r.id === job.id)) return current;
      const { logs: _logs, ...record } = job;
      const next = [record, ...current].slice(0, 100);
      return next;
    });
  }, [job]);
  useEffect(() => { try { localStorage.setItem("flashstudio.records", JSON.stringify(records)); } catch { setError("操作记录无法保存，请导出记录。当前结果仍可查看。"); } }, [records]);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setTick(Date.now()), 250); return () => clearInterval(timer);
  }, [isRunning]);
  useEffect(() => {
    if (followLog.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.nextSequence, page]);

  const work = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setPending(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setPending(false); }
  }, []);
  const importFile = (file: File) => {
    if (busy || !desktop) return;
    void work(async () => {
      if (!/\.(bin|hex|ihex|elf|axf)$/i.test(file.name)) throw new Error("请选择 BIN、HEX、ELF 或 AXF 固件");
      if (!file.size || file.size > 32 * 1024 * 1024) throw new Error("固件须非空，且不超过 32 MiB");
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await invoke<Firmware>("import_firmware", { name: file.name, bytes });
      setFirmware(result);
    });
  };
  const start = (next: Operation, confirmed = false) => {
    if (busy || !desktop) return;
    setEraseConfirm(false); followLog.current = true;
    void work(async () => {
      const nextRequest = { ...request, operation: next, eraseConfirmed: confirmed };
      const problem = validate(nextRequest);
      if (problem) throw new Error(problem);
      setJob(await invoke<Job>("start_operation", { request: nextRequest }));
      setTick(Date.now());
    });
  };
  const duration = job ? Math.max(0, ((job.finishedAt ?? tick) - job.startedAt) / 1000).toFixed(1) : "0.0";
  const title = pages.find(p => p.id === page)!;
  const logText = job ? `${operationNames[job.operation]} · ${statusNames[job.status]}\n${planText(job.plan)}\n\n${job.logs.map(l => `[${time(l.time)}] ${l.text}`).join("\n")}\n` : "";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img src="/flashstudio.svg" alt=""/><div><strong>Flash<span>Studio</span></strong><small>FIRMWARE PROGRAMMING</small></div></div>
      <div className="nav-label">工作空间</div>
      <nav>{pages.map(item => <button key={item.id} aria-label={item.label} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}><Icon name={item.icon} size={18}/><span>{item.label}</span>{item.id === "records" && records.length > 0 && <small>{records.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="engine-card"><span className="engine-icon"><Icon name="cpu" size={21}/></span><div><strong>OpenOCD</strong><small>{version ? "本机引擎可用" : "本机烧录引擎"}</small></div><i className={`status-dot ${version ? "green" : ""}`}/></div><button className="nav-item" onClick={() => setHelp(true)}><Icon name="help" size={18}/><span>使用说明</span></button><div className="sidebar-footer"><span>FlashStudio <b>v0.1.0</b></span><button className="icon-button" aria-label={dark ? "切换浅色主题" : "切换深色主题"} onClick={() => setDark(!dark)}><Icon name={dark ? "sun" : "moon"} size={16}/></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span className="breadcrumb">FlashStudio <Icon name="chevron" size={12}/> 工作空间</span><h1>{title.label}</h1></div><div className={`header-state ${isRunning ? "working" : ""}`}><i className="status-dot"/>{isRunning ? `${operationNames[job.operation]}中` : "USB 探针 · 按任务连接"}</div></header>
      <main>
        <div className="page-intro"><p>{title.subtitle}</p><span className="subtle-tag">OPENOCD ENGINE</span></div>
        {!desktop && <div className="notice"><Icon name="info" size={17}/><span>浏览器预览模式。请使用桌面应用连接探针和执行烧录。</span></div>}
        {error && <div className="notice error" role="alert"><Icon name="info" size={17}/><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError("")}><Icon name="close" size={15}/></button></div>}
        {page === "workspace" && <>
          <div className="workspace-grid">
            <section className="card connection-card">
              <div className="card-heading"><h2><span className="step-number">01</span>探针与芯片</h2><Icon name="plug" size={19}/></div>
              <fieldset disabled={busy}>
                <span className="field-label">烧录探针</span>
                <div className="adapter-options" role="group" aria-label="烧录探针">{adapters.map(a => <button key={a.id} className={`adapter-option ${config.adapter === a.id ? "selected" : ""}`} aria-pressed={config.adapter === a.id} title={a.description} onClick={() => updateConfig("adapter", a.id)}><Icon name={a.id === "cmsis-dap" ? "cpu" : "plug"} size={19}/><strong>{a.name}</strong>{config.adapter === a.id && <span className="option-check"><Icon name="check" size={9}/></span>}</button>)}</div>
                <Field label="目标芯片"><select aria-label="目标芯片" value={customTarget ? "custom" : config.target} onChange={e => { const custom = e.target.value === "custom"; setCustomTarget(custom); updateConfig("target", custom ? "" : e.target.value); }}>{targets.map(t => <option key={t.path} value={t.path}>{t.name} 系列</option>)}<option value="custom">自定义目标配置…</option></select></Field>
                {customTarget ? <Field label="目标配置路径"><input value={config.target} onChange={e => updateConfig("target", e.target.value)} placeholder="target/stm32h7x_dual_bank.cfg"/></Field> : <p className="config-path mono">{config.target}</p>}
                <div className="form-row"><Field label="传输接口"><select value={config.transport} onChange={e => updateConfig("transport", e.target.value as Config["transport"])}><option value="swd">SWD</option><option value="jtag">JTAG</option></select></Field><Field label="接口时钟 (kHz)"><input type="number" min="1" max="50000" value={config.speedKhz || ""} onChange={e => updateConfig("speedKhz", Number(e.target.value))}/></Field></div>
                <Field label="探针序列号" hint="留空自动选择；连接多个同类探针时请指定。"><input className="mono" value={config.serial} onChange={e => updateConfig("serial", e.target.value)} placeholder="自动选择"/></Field>
                <label className="checkbox"><input type="checkbox" checked={config.connectUnderReset} onChange={e => updateConfig("connectUnderReset", e.target.checked)}/><span>复位下连接 <small>需连接 NRST</small></span></label>
              </fieldset>
              <button className="secondary full-width probe-button" disabled={busy || !desktop} onClick={() => start("probe")}><Icon name="plug" size={16}/>检测连接</button>
              <p className="footnote">检测会复位芯片并读取目标信息，完成后释放探针。</p>
            </section>
            <section className="card firmware-card">
              <div className="card-heading"><h2><span className="step-number">02</span>{operation === "erase" ? "擦除范围" : "固件与操作"}</h2><span className="muted">STM32 WORKSPACE</span></div>
              <div className="operation-tabs" role="tablist" aria-label="操作类型">{(["flash", "verify", "erase"] as const).map(op => <button key={op} role="tab" aria-selected={operation === op} disabled={busy} className={operation === op ? "active" : ""} onClick={() => setOperation(op)}><Icon name={operationIcons[op]} size={16}/>{operationNames[op]}</button>)}</div>
              <fieldset disabled={busy}>
                {operation !== "erase" ? <>
                  <label className={`firmware-drop ${dragging ? "dragging" : ""} ${firmware ? "has-file" : ""} ${!desktop || busy ? "disabled" : ""}`} onDragOver={e => { e.preventDefault(); if (!busy && desktop) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) importFile(file); }}>
                    <input type="file" aria-label="选择固件文件" accept=".bin,.hex,.ihex,.elf,.axf" disabled={busy || !desktop} onChange={e => { const file = e.target.files?.[0]; if (file) importFile(file); e.target.value = ""; }}/>
                    <span className="file-icon"><Icon name={firmware ? "archive" : "download"} size={28}/></span><strong>{firmware?.name ?? "点击选择或拖入固件文件"}</strong><span>{firmware ? `${size(firmware.size)} · ${firmware.format.toUpperCase()} · 点击更换` : "支持 BIN、HEX、ELF、AXF · 最大 32 MiB"}</span><span className="choose-file">{firmware ? "更换固件" : "选择固件"}<Icon name="plus" size={13}/></span>
                  </label>
                  <div className="firmware-metadata"><div><span>文件格式</span><strong className="mono">{firmware?.format.toUpperCase() ?? "—"}</strong></div><div><span>文件大小</span><strong className="mono">{firmware ? size(firmware.size) : "—"}</strong></div><div className="hash-row"><span>SHA-256</span><code title={firmware?.sha256}>{firmware?.sha256 ?? "选择固件后计算文件指纹"}</code></div></div>
                  <Field label="BIN 起始地址" hint={firmware && firmware.format !== "bin" ? "当前固件使用文件内地址，不附加偏移。" : "填写芯片实际烧录地址；带 Bootloader 时请确认应用偏移。"}><div className="input-suffix"><input className="mono" aria-label="BIN 起始地址" value={address} disabled={!!firmware && firmware.format !== "bin"} onChange={e => setAddress(e.target.value)} spellCheck={false}/><span>HEX / ELF 自动寻址</span></div></Field>
                  <div className="options-row">{operation === "flash" && <label className="checkbox"><input type="checkbox" checked={verifyAfterWrite} onChange={e => setVerifyAfterWrite(e.target.checked)}/><span>烧录后校验</span></label>}<label className="checkbox"><input type="checkbox" checked={resetAfter} onChange={e => setResetAfter(e.target.checked)}/><span>完成后复位运行</span></label></div>
                  <p className="footnote"><Icon name="info" size={13}/>{operation === "flash" ? "烧录会擦除固件覆盖的 Flash 扇区；同扇区其他数据可能被清除。" : "独立校验将芯片内容与所选固件比较，不写入 Flash。"}</p>
                </> : <div className="erase-panel">
                  <div className="erase-intro"><span className="erase-icon"><Icon name="trash" size={26}/></span><h3>指定 Flash Bank 擦除</h3><p>擦除选定 Bank 的全部或部分扇区。</p></div>
                  <div className="form-row"><Field label="Flash Bank 编号"><input aria-label="Flash Bank 编号" type="number" min="0" max="255" value={bank} onChange={e => setBank(e.target.value)}/></Field><Field label="擦除方式"><select value={eraseMode} onChange={e => setEraseMode(e.target.value)}><option value="bank">该 Bank 全部扇区</option><option value="sectors">指定扇区范围</option></select></Field></div>
                  {eraseMode === "sectors" && <div className="form-row"><Field label="起始扇区"><input type="number" min="0" value={firstSector} onChange={e => setFirstSector(e.target.value)}/></Field><Field label="结束扇区"><input type="number" min="0" value={lastSector} placeholder="留空至 Bank 末尾" onChange={e => setLastSector(e.target.value)}/></Field></div>}
                  <div className="notice warning"><Icon name="info" size={17}/><span>擦除不可恢复。请先检测连接，在日志中核对 Bank；双 Bank 芯片需分别处理。此操作不会解除读写保护。</span></div>
                  <div className="erase-summary"><span>待擦除范围</span><strong className="mono">{eraseRange}</strong></div><p className="footnote">擦除后芯片保持暂停，烧录有效固件后再复位运行。</p>
                </div>}
              </fieldset>
            </section>
          </div>
          <section className="card execution-card">
            <div className="execution-heading"><div className={`run-icon ${job?.status ?? ""}`}><Icon name={isRunning ? "refresh" : job?.status === "success" ? "check" : "bolt"} size={22} className={isRunning ? "spinning" : ""}/></div><div className="execution-copy"><h2>{isRunning ? `${operationNames[job.operation]}进行中` : job ? `${operationNames[job.operation]} · ${statusNames[job.status]}` : "准备开始"}</h2><p role="status">{job ? job.message : validation || "配置就绪，可以执行操作"}</p></div>{job && <div className="elapsed mono">{duration}<small> s</small></div>}
              {isRunning ? <button className="danger-outline" disabled={cancelling} onClick={() => setCancelConfirm(true)}><Icon name="pause" size={16}/>{cancelling ? "正在取消…" : "取消操作"}</button> : <button className={operation === "erase" ? "danger" : "primary"} disabled={busy || !desktop || !!validation} onClick={() => operation === "erase" ? setEraseConfirm(true) : start(operation)}><Icon name={operationIcons[operation]} size={17}/>{pending ? "处理中…" : operation === "flash" ? "开始烧录" : operation === "verify" ? "开始校验" : "擦除 Flash"}<Icon name="arrowRight" size={16}/></button>}
            </div>
            {isRunning && <div className="activity-track" aria-label="OpenOCD 正在执行"><span/></div>}
            <div className="execution-footer"><span><Icon name="cpu" size={14}/>{targetName(config.target) || "未选择芯片"}</span><span><Icon name="plug" size={14}/>{adapterName(config.adapter)} / {config.transport.toUpperCase()} / {config.speedKhz} kHz</span><button disabled={busy || !desktop || !!validation} onClick={() => void work(async () => setPreview(await invoke<Plan>("preview_operation", { request: { ...request, eraseConfirmed: true } })))}><Icon name="terminal" size={14}/>查看执行参数</button></div>
          </section>
          <section className="card log-card"><div className="card-heading"><h2><Icon name="terminal" size={17}/>运行日志 <span className="log-count mono">{job?.logs.length ?? 0}</span></h2><div className="log-actions"><span className="muted">最近 1000 行</span><button className="icon-button" aria-label="导出运行日志" disabled={!job} onClick={() => download(`flashstudio-${job!.id}.log`, logText)}><Icon name="download" size={16}/></button></div></div>
            <div className="log-content mono" ref={logRef} onScroll={() => { const el = logRef.current; if (el) followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 35; }}>{job?.logs.length ? job.logs.map(line => <div className={`log-line ${/error|failed|失败|错误/i.test(line.text) ? "log-error" : /SUCCESS|verified|完成/i.test(line.text) ? "log-success" : ""}`} key={`${job.id}-${line.sequence}`}><time>{time(line.time)}</time><span>{line.text}</span></div>) : <div className="log-empty"><Icon name="terminal" size={23}/><span>等待执行任务</span><small>OpenOCD 的连接信息与操作结果将在这里显示</small></div>}</div>
          </section>
        </>}
        {page === "settings" && <section className="card settings-card"><div className="card-heading"><h2><Icon name="cpu" size={19}/>OpenOCD 引擎</h2><span className="tag">本机执行</span></div><p className="section-description">使用已安装的 OpenOCD。探针支持与芯片支持由所选引擎及其 scripts 配置决定。</p><fieldset disabled={busy}>
          <Field label="OpenOCD 可执行文件" hint="可填写 PATH 中的命令名或完整路径，无需手动加引号。"><input value={config.executable} onChange={e => updateConfig("executable", e.target.value)} placeholder="openocd" spellCheck={false}/></Field>
          <Field label="Scripts 目录（可选）" hint="留空使用 OpenOCD 默认路径；自定义安装可指定包含 interface、target 的 scripts 目录。"><input value={config.scriptsDir} onChange={e => updateConfig("scriptsDir", e.target.value)} placeholder="/usr/share/openocd/scripts" spellCheck={false}/></Field>
          <Field label="单次任务超时（秒）" hint="超时会终止进程并释放探针；范围 5–3600 秒。"><input type="number" min="5" max="3600" value={config.timeoutSecs || ""} onChange={e => updateConfig("timeoutSecs", Number(e.target.value))}/></Field>
          <div className="settings-actions"><button className="primary" disabled={!desktop || !config.executable.trim()} onClick={() => void work(async () => { const path = config.executable; setEngine(null); const result = await invoke<string>("check_engine", { executable: path }); setEngine({ path, version: result }); })}><Icon name="refresh" size={16}/>{pending ? "检测中…" : "检测引擎"}</button><button className="secondary" onClick={() => { setConfig({ ...defaults }); setCustomTarget(false); }}>恢复默认配置</button></div>
        </fieldset>{version && <div className="notice success" role="status"><Icon name="check" size={17}/><span>{version}</span></div>}<div className="settings-note"><h3>配置自动保存</h3><p>探针、芯片与引擎配置保存在本机。固件文件每次启动需重新选择。应用保留最近 100 条操作记录。</p><h3>仅提供烧录工作流</h3><p>支持 ST-Link、J-Link、CMSIS-DAP，经 OpenOCD 执行烧录、Flash 擦除与固件校验。</p></div></section>}
        {page === "records" && <section className="card records-card"><div className="card-heading"><h2>操作记录 <span className="log-count mono">{records.length}</span></h2><button className="secondary" disabled={!records.length} onClick={() => download("flashstudio-records.json", JSON.stringify(records, null, 2), "application/json")}><Icon name="download" size={15}/>导出记录</button></div>{records.length ? <div className="table-scroll"><table><thead><tr><th>开始时间</th><th>操作 / 目标</th><th>固件 / 范围</th><th>探针</th><th>耗时</th><th>结果</th></tr></thead><tbody>{records.map(r => <tr key={r.id} onClick={() => setSelectedRecord(r)}><td className="mono">{new Date(r.startedAt).toLocaleString("zh-CN", { hour12: false })}</td><td><strong>{operationNames[r.operation]}</strong><small>{targetName(r.request.config.target)}</small></td><td>{r.operation === "erase" ? `Bank ${r.request.bank} · ${r.request.firstSector}–${r.request.lastSector ?? "末尾"}` : r.operation === "probe" ? "读取目标信息" : r.firmware?.name ?? "—"}</td><td>{adapterName(r.request.config.adapter)}</td><td className="mono">{((r.finishedAt! - r.startedAt) / 1000).toFixed(1)} s</td><td><button className={`result-badge ${r.status}`} onClick={e => { e.stopPropagation(); setSelectedRecord(r); }}>{statusNames[r.status]}<Icon name="chevron" size={12}/></button></td></tr>)}</tbody></table></div> : <div className="empty-records"><span className="file-icon"><Icon name="clock" size={30}/></span><h3>还没有操作记录</h3><p>完成一次连接检测、烧录、校验或擦除后，结果会自动记录在这里。</p><button className="secondary" onClick={() => setPage("workspace")}>前往烧录工作台<Icon name="arrowRight" size={15}/></button></div>}<p className="records-note">仅保留最近 100 条本机记录；点击结果查看执行参数与固件指纹。完整日志请在工作台导出。</p></section>}
      </main>
      <footer className="statusbar"><span><i className={`status-dot ${isRunning ? "blue" : ""}`}/>{isRunning ? "任务执行中" : "就绪"}</span><span>{desktop ? "桌面模式" : "浏览器预览"}<i/>OpenOCD<span className="mono">v0.1.0</span></span></footer>
    </div>
    {eraseConfirm && <Modal title="确认擦除 Flash" close={() => setEraseConfirm(false)}><div className="modal-copy"><p>即将擦除 <strong>{targetName(config.target)}</strong> 的以下区域：</p><div className="confirm-range mono">{eraseRange}</div><p>探针：{adapterName(config.adapter)}{config.serial ? ` · ${config.serial}` : " · 自动选择"}</p><p>所选扇区内的固件与数据将被清除，无法撤销。请确认 Bank 编号与目标芯片一致。</p></div><div className="modal-actions"><button autoFocus className="secondary" onClick={() => setEraseConfirm(false)}>返回检查</button><button className="danger" onClick={() => start("erase", true)}>确认擦除</button></div></Modal>}
    {cancelConfirm && <Modal title="取消当前操作" close={() => setCancelConfirm(false)}><div className="modal-copy"><p>取消会终止 OpenOCD。已经写入或擦除的数据无法回滚，完成后请重新烧录并校验。</p></div><div className="modal-actions"><button autoFocus className="secondary" onClick={() => setCancelConfirm(false)}>继续等待</button><button className="danger" onClick={() => { setCancelConfirm(false); setCancelling(true); void invoke("cancel_operation", { jobId: job!.id }).catch(e => { setCancelling(false); setError(String(e)); }); }}>确认取消</button></div></Modal>}
    {preview && <Modal title="OpenOCD 执行参数" close={() => setPreview(null)}><p className="section-description">以下参数由当前配置生成，预览不会连接设备。每个参数独立传给进程，不经系统 Shell。</p><pre className="command-preview">{planText(preview)}</pre><div className="modal-actions"><button className="secondary" onClick={() => download("flashstudio-command.txt", planText(preview))}><Icon name="download" size={15}/>导出参数</button></div></Modal>}
    {selectedRecord && <Modal title={`${operationNames[selectedRecord.operation]} · ${statusNames[selectedRecord.status]}`} close={() => setSelectedRecord(null)}><div className="modal-copy"><p>{selectedRecord.message}</p><p>{targetName(selectedRecord.request.config.target)} · {adapterName(selectedRecord.request.config.adapter)}</p>{selectedRecord.firmware && <><p>{selectedRecord.firmware.name}</p><small className="mono hash-detail">SHA-256 {selectedRecord.firmware.sha256}</small></>}</div><pre className="command-preview">{planText(selectedRecord.plan)}</pre></Modal>}
    {help && <Modal title="开始使用 FlashStudio" close={() => setHelp(false)}><div className="modal-copy help-copy"><ol><li><strong>配置引擎</strong><p>安装 OpenOCD，在引擎设置中检测可执行文件。自定义安装时指定 scripts 目录。</p></li><li><strong>连接探针与芯片</strong><p>为目标板供电，连接 GND、SWDIO、SWCLK 与参考电压；复位下连接还需 NRST。选择对应芯片配置后检测连接。</p></li><li><strong>选择固件并烧录</strong><p>BIN 需指定起始地址；HEX、ELF、AXF 使用内嵌地址。默认烧录后校验并复位运行。</p></li></ol><p>连接失败时请检查 USB 权限或驱动、供电与接线，并尝试降低时钟。Linux 通常需要安装 OpenOCD 随附的 udev 规则。</p><p>独立校验不写入 Flash；擦除作用于指定 Bank 的扇区，不包含解锁、Option Bytes 或芯片调试。</p></div></Modal>}
  </div>;
}
export default App;
