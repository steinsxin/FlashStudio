import { useState } from "react";
import { Icon } from "../Icon";
import { targetName, type Config, type Firmware, type Job } from "../../lib/flash";
import { fileSize, importMessage, type FirmwareImportState } from "../../lib/firmware";
import "./VerificationPanel.css";

interface Props {
  firmware: Firmware | null;
  importing: FirmwareImportState | null;
  config: Config;
  address: string;
  resetAfter: boolean;
  job: Job | null;
  duration: string;
  busy: boolean;
  canImport: boolean;
  canStart: boolean;
  cancelling: boolean;
  validation: string;
  onImport: (file: File) => void;
  onAddress: (address: string) => void;
  onResetAfter: (reset: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}

export function VerificationPanel(props: Props) {
  const { firmware, importing, config, address, resetAfter, busy } = props;
  const [dragging, setDragging] = useState(false);
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  // A result belongs to the exact inputs that were checked. Never carry a flash
  // result, or a previous file/target's successful verification, into this view.
  const previous = props.job;
  const job = previous?.operation === "verify"
    && !importing
    && previous.id !== dismissedJobId
    && previous.firmware?.id === firmware?.id
    && previous.request.address === address
    && previous.request.resetAfter === resetAfter
    && Object.entries(config).every(([key, value]) => previous.request.config[key as keyof Config] === value)
    ? previous : null;
  const running = job?.status === "running";
  const success = job?.status === "success";
  const matched = job?.verificationStage === "matched";
  const completed = success ? 3 : matched ? 2 : job?.verificationStage === "comparing" ? 1 : 0;
  const status = job?.status ?? "idle";
  const title = importing ? "正在导入参考固件" : success ? "校验通过，内容一致"
    : job?.status === "failed" ? matched ? "内容一致，结束任务失败" : "校验未完成"
    : job?.status === "cancelled" ? "校验已取消"
    : running ? matched ? "比对完成，正在结束任务" : completed === 1 ? "正在对比固件内容" : "正在连接目标芯片"
    : "等待开始校验";
  const detail = importing ? `${importMessage(importing)} 导入完成后即可校验。` : job && !running ? job.message
    : running ? matched ? "等待芯片状态处理及引擎退出。" : completed === 1 ? "正在核对参考固件对应的芯片内容。" : "连接探针并准备目标芯片。"
    : !firmware ? "选择参考固件，检查芯片内容是否与它一致。"
    : props.validation || "参考固件已就绪，可以开始校验。";
  const embeddedAddress = !!firmware && firmware.format !== "bin";

  return <section className="card verification-card" aria-label="固件一致性检查">
    <div className="section-heading">
      <h2><Icon name="compare" size={18}/>固件一致性检查</h2>
      <span className="verification-badge"><Icon name="shield" size={13}/>不写入 Flash</span>
    </div>
    <fieldset disabled={busy}>
      <div className="verification-pair">
        <label className={`verification-source ${dragging ? "dragging" : ""} ${firmware ? "has-file" : ""} ${importing ? "importing" : ""}`} aria-busy={!!importing}
          onDragOver={event => { event.preventDefault(); if (props.canImport) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file && props.canImport) props.onImport(file); }}>
          <input type="file" aria-label="选择参考固件" accept=".bin,.hex,.ihex,.elf,.axf" disabled={!props.canImport}
            onChange={event => { const file = event.target.files?.[0]; if (file) props.onImport(file); event.target.value = ""; }}/>
          <Icon name={importing ? "refresh" : "archive"} className={importing ? "spinning" : ""} size={23}/>
          <div><span className="verification-label">参考固件</span><strong title={importing?.name ?? firmware?.name}>{importing?.name ?? firmware?.name ?? "选择或拖入参考固件"}</strong><small>{importing ? `${fileSize(importing.size)} · ${importMessage(importing)}` : firmware ? `${fileSize(firmware.size)} · ${firmware.format.toUpperCase()} · 点击更换` : "BIN / HEX / ELF / AXF"}</small></div>
        </label>
        <Icon name="compare" size={23} className="verification-connector"/>
        <div className="verification-target"><Icon name="cpu" size={23}/><div><span className="verification-label">芯片内容</span><strong title={targetName(config.target)}>{targetName(config.target) || "请选择目标芯片"}</strong><small>{!firmware ? "等待确定校验范围" : embeddedAddress ? "按文件内的数据段地址比较" : "按 BIN 起始地址和文件长度比较"}</small></div></div>
      </div>
      <div className="verification-options">
        <label className="field"><span>校验起始地址</span><input className="mono" aria-label="校验起始地址" value={embeddedAddress ? "使用文件内地址" : address} disabled={embeddedAddress} onChange={event => props.onAddress(event.target.value)} spellCheck={false}/></label>
        <label className="checkbox"><input type="checkbox" checked={resetAfter} onChange={event => props.onResetAfter(event.target.checked)}/><span>校验后运行</span></label>
      </div>
    </fieldset>

    <div className={`verification-result ${status}`}>
      <div className="verification-progress-heading"><span>校验进度 <small>按执行阶段显示</small></span>{job && <span className="elapsed mono"><Icon name="clock" size={12}/>{props.duration} s</span>}</div>
      <div className="verification-summary">
        <span className="verification-result-icon"><Icon name={importing ? "refresh" : success ? "check" : status === "failed" ? "info" : status === "cancelled" ? "pause" : "shield"} className={importing ? "spinning" : ""} size={22}/></span>
        <div className="verification-message" role="status"><strong>{title}</strong><p>{detail}</p></div>
        {running
          ? <button className="danger-outline" disabled={props.cancelling} onClick={props.onCancel}><Icon name="pause" size={15}/>{props.cancelling ? "正在取消…" : "取消校验"}</button>
          : <button className="primary verification-start" disabled={!props.canStart} onClick={() => { setDismissedJobId(previous?.id ?? null); props.onStart(); }}><Icon name={importing ? "refresh" : "shield"} className={importing ? "spinning" : ""} size={16}/>{importing ? "正在导入…" : "开始校验"}</button>}
      </div>
      <div className="verification-progress" role="progressbar" aria-label="校验进度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={completed} aria-valuetext={`${title}，已完成 ${completed} 个阶段，共 3 个阶段`}>
        <ol className="verification-steps">{["连接芯片", "对比内容", "完成"].map((label, index) => <li key={label} className={index < completed ? "complete" : running && index === completed ? "active" : ""} aria-current={running && index === completed ? "step" : undefined}>
          <span className="verification-step-node">{index < completed ? <Icon name="check" size={12}/> : index + 1}</span><span className="verification-step-label">{label}</span>
        </li>)}</ol>
      </div>
    </div>
  </section>;
}
