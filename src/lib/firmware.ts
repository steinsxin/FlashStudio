import { invoke } from "@tauri-apps/api/core";
import type { Firmware, FirmwarePurpose } from "./flash";

export interface FirmwareImportState {
  name: string;
  size: number;
  stage: "reading" | "preparing";
}

export const importMessage = (state: FirmwareImportState) =>
  state.stage === "reading" ? "正在读取文件…" : "正在准备固件…";

export const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

// Let React commit and the WebView paint the status before starting each stage.
const paintStatus = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

export async function importFirmware(file: File, purpose: FirmwarePurpose, update: (state: FirmwareImportState) => void): Promise<Firmware> {
  if (!/\.(bin|hex|ihex|elf|axf)$/i.test(file.name)) throw new Error("请选择 BIN、HEX、ELF 或 AXF 固件");
  if (!file.size || file.size > 32 * 1024 * 1024) throw new Error("固件须非空，且不超过 32 MiB");
  update({ name: file.name, size: file.size, stage: "reading" });
  await paintStatus();
  const bytes = await file.arrayBuffer();
  update({ name: file.name, size: file.size, stage: "preparing" });
  await paintStatus();
  // Keep the file binary. ASCII JSON metadata preserves Unicode names in HTTP
  // headers without expanding every file byte into a JSON number on the UI thread.
  const metadata = JSON.stringify({ purpose, name: file.name }).replace(/[^\x20-\x7e]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return invoke<Firmware>("import_firmware", bytes, { headers: { "x-flashstudio-firmware": metadata } });
}
