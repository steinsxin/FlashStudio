import { isTauri } from "@tauri-apps/api/core";

export const desktop = isTauri();
export type Adapter = "stlink" | "jlink" | "cmsis-dap";
export type Operation = "probe" | "flash" | "verify" | "erase";
export type JobStatus = "running" | "success" | "failed" | "cancelled";
export interface Config {
  executable: string; scriptsDir: string; adapter: Adapter; transport: "swd" | "jtag";
  serial: string; target: string; speedKhz: number; connectUnderReset: boolean; timeoutSecs: number;
}
export interface Firmware { id: string; name: string; size: number; format: string; sha256: string }
export interface OperationRequest {
  config: Config; operation: Operation; firmwareId: string | null; address: string;
  verifyAfterWrite: boolean; resetAfter: boolean; bank: number; firstSector: number;
  lastSector: number | null; eraseConfirmed: boolean;
}
export interface Plan { executable: string; args: string[]; timeoutSecs: number }
export interface Job {
  id: string; operation: Operation; status: JobStatus; startedAt: number; finishedAt: number | null;
  message: string; logs: { sequence: number; time: number; text: string }[]; nextSequence: number;
  plan: Plan; request: OperationRequest; firmware: Firmware | null;
}
export type RecordEntry = Omit<Job, "logs">;
export const adapters: { id: Adapter; name: string; description: string }[] = [
  { id: "stlink", name: "ST-Link", description: "STMicroelectronics" },
  { id: "jlink", name: "J-Link", description: "SEGGER" },
  { id: "cmsis-dap", name: "CMSIS-DAP", description: "DAPLink / 兼容探针" },
];
export const targets = [
  ["STM32F0", "stm32f0x"], ["STM32F1", "stm32f1x"], ["STM32F2", "stm32f2x"],
  ["STM32F3", "stm32f3x"], ["STM32F4", "stm32f4x"], ["STM32F7", "stm32f7x"],
  ["STM32G0", "stm32g0x"], ["STM32G4", "stm32g4x"], ["STM32H7", "stm32h7x"],
  ["STM32L0", "stm32l0"], ["STM32L1", "stm32l1"], ["STM32L4", "stm32l4x"],
  ["STM32L5", "stm32l5x"], ["STM32U5", "stm32u5x"], ["STM32WB", "stm32wbx"], ["STM32WL", "stm32wlx"],
].map(([name, file]) => ({ name, path: `target/${file}.cfg` }));
export const defaults: Config = {
  executable: "openocd", scriptsDir: "", adapter: "stlink", transport: "swd", serial: "",
  target: "target/stm32f4x.cfg", speedKhz: 1000, connectUnderReset: false, timeoutSecs: 120,
};
export const operationNames: Record<Operation, string> = { probe: "连接检测", flash: "固件烧录", verify: "固件校验", erase: "Flash 擦除" };
export const statusNames: Record<JobStatus, string> = { running: "执行中", success: "成功", failed: "失败", cancelled: "已取消" };
export function targetName(target: string) { return targets.find(t => t.path === target)?.name ?? target; }
export function adapterName(adapter: Adapter) { return adapters.find(a => a.id === adapter)?.name ?? adapter; }
export function loadConfig(): Config {
  try {
    const data = JSON.parse(localStorage.getItem("flashstudio.config") ?? "{}");
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof Config)[]) {
      if (typeof data[key] === typeof defaults[key]) Object.assign(result, { [key]: data[key] });
    }
    if (!adapters.some(a => a.id === result.adapter)) result.adapter = defaults.adapter;
    if (!["swd", "jtag"].includes(result.transport)) result.transport = "swd";
    return result;
  } catch { return { ...defaults }; }
}
export function loadRecords(): RecordEntry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem("flashstudio.records") ?? "[]");
    return Array.isArray(data) ? data.filter((r): r is RecordEntry =>
      r && typeof r.id === "string" && r.operation in operationNames && ["success", "failed", "cancelled"].includes(r.status)
      && typeof r.startedAt === "number" && typeof r.finishedAt === "number" && typeof r.message === "string"
      && r.request?.config && typeof r.request.config.target === "string" && adapters.some(a => a.id === r.request.config.adapter)
      && Array.isArray(r.plan?.args) && typeof r.plan?.executable === "string"
    ).slice(0, 100) : [];
  } catch { return []; }
}
export function validate(request: OperationRequest): string {
  const c = request.config;
  if (!c.executable.trim()) return "请在引擎设置中填写 OpenOCD 路径";
  if (!c.target.trim().toLowerCase().endsWith(".cfg")) return "请选择目标芯片或填写 .cfg 配置路径";
  if (!Number.isInteger(c.speedKhz) || c.speedKhz < 1 || c.speedKhz > 50000) return "接口时钟须在 1–50000 kHz 之间";
  if (!Number.isInteger(c.timeoutSecs) || c.timeoutSecs < 5 || c.timeoutSecs > 3600) return "任务超时须在 5–3600 秒之间";
  if (["flash", "verify"].includes(request.operation) && !request.firmwareId) return "选择固件后即可开始";
  if (request.operation === "erase") {
    if (!Number.isInteger(request.bank) || request.bank < 0 || request.bank > 255) return "Bank 编号须为 0–255 的整数";
    if (!Number.isInteger(request.firstSector) || request.firstSector < 0 || request.firstSector > 65535) return "起始扇区须为 0–65535 的整数";
    if (request.lastSector !== null && (!Number.isInteger(request.lastSector) || request.lastSector < request.firstSector || request.lastSector > 65535)) return "结束扇区须不小于起始扇区，且不超过 65535";
  }
  return "";
}
export function validAddress(address: string) {
  return /^(0x[\da-f]+|\d+)$/i.test(address.trim()) && Number(address) >= 0 && Number(address) <= 0xffffffff;
}
export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function planText(plan: Plan) {
  return [plan.executable, ...plan.args].map(arg => JSON.stringify(arg)).join(" ");
}
