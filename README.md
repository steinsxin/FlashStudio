# FlashStudio

基于 **Tauri 2 + React + TypeScript + Rust** 的桌面烧录工作台，沿用 CANStudio / MotorStudio 的 Studio 界面风格。当前通过 OpenOCD 驱动探针，专注固件烧录、Flash 擦除和固件校验，不包含芯片调试。

## 当前功能

- ST-Link、J-Link、CMSIS-DAP；SWD / JTAG、接口时钟、探针序列号、复位下连接。
- STM32 F0/F1/F2/F3/F4/F7、G0/G4、H7、L0/L1/L4/L5、U5、WB/WL 配置预设，以及自定义目标 `.cfg`。
- BIN、HEX/IHEX、ELF/AXF，最大 32 MiB。BIN 使用明确的起始地址；其他格式使用文件内地址，偏移为 0。
- 烧录时擦除固件覆盖扇区，默认写后校验并复位运行；也可独立校验。
- 指定 Flash Bank 全部扇区或扇区范围擦除，需要在界面确认目标与范围。**不是整片擦除**，不自动解锁，不修改 Option Bytes；擦除后 CPU 保持暂停。
- 独立连接检测：复位、读取目标与 Bank 信息，再复位运行并释放探针。界面不会将一次检测当作持续连接。
- stdout/stderr 实时日志、日志导出、执行参数预览、任务取消和超时终止。每次任务独占一个 OpenOCD 进程；运行时禁止关闭窗口。
- 固件导入后生成私有临时快照及 SHA-256，避免源文件变化影响本次烧录。更换文件或正常退出会删除快照；强制杀死应用后可能需清理系统临时目录内的 `flashstudio-*` 残留。
- 本地保存连接/引擎配置、最近 100 条操作记录；深浅主题。记录包含结果、固件指纹和执行参数，日志仅保留最近 1000 行。

## 开发与运行

需要 Node.js 22.12+、Rust（支持 edition 2024）、Tauri 2 对应平台的系统依赖，以及单独安装的 OpenOCD 0.12+。仓库暂未内置 OpenOCD。

```bash
cd FlashStudio
npm ci
npm run tauri dev
```

首次运行在「引擎设置」中检测 `openocd`，或填写完整可执行文件路径。需要时配置 scripts 目录。默认选择 **ST-Link / SWD / STM32F4 / 1000 kHz**，请按实际芯片更改。界面的脚本预设不代表所安装的 OpenOCD 一定包含该脚本或支持所有子型号。

```bash
npm run build          # TypeScript 检查与前端构建
npm test               # Rust 命令规划、进程控制测试
cargo test --locked --manifest-path src-tauri/Cargo.toml -- --include-ignored # 另含本机 OpenOCD 无硬件测试
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build    # 本机构建桌面包
```

`npm run dev` 仅启动浏览器预览；浏览器中禁止连接、导入固件和执行硬件操作。

## 使用流程

1. 为目标板供电，正确连接探针。Linux 需具备 USB 访问权限（通常使用 OpenOCD 提供的 udev 规则）；其他平台安装适当 USB 驱动。
2. 选择探针和目标配置，填写频率。多个同类探针同时连接时填写序列号。复位下连接需要 NRST。
3. 点击「检测连接」，在日志中检查识别结果与 Bank 编号。此操作会复位芯片。
4. 选择固件。BIN 默认地址 `0x08000000`，有 Bootloader 时按实际内存布局填写偏移地址。
5. 执行烧录或独立校验；需要擦除时切换「Flash 擦除」并确认 Bank / 扇区范围。

烧录会影响整个覆盖扇区，扇区内其他数据也可能被清除。取消或超时只终止进程，已经执行的写入/擦除不会回滚。应重新烧录有效固件并校验。固件 SHA-256 是文件指纹；设备内容校验由 OpenOCD `verify_image` 执行。

## 代码结构

```text
src/App.tsx                  工作台、记录、设置和操作状态
src/lib/flash.ts              前端类型、预设、配置校验和存储
src/components/Icon.tsx       复用 Studio 图标风格
src-tauri/src/engine.rs       配置校验与 OpenOCD 命令规划，无硬件访问
src-tauri/src/runner.rs       子进程、输出、超时、取消和回收
src-tauri/src/lib.rs          Tauri 命令、固件快照、任务互斥与状态
scripts/ui-smoke.mjs          浏览器与模拟桌面桥接的交互测试
```

探针类型与执行引擎分开：ST-Link、J-Link、CMSIS-DAP 当前都是 OpenOCD 的适配器。以后接入厂商独立工具时，可增加新的命令规划/执行实现，继续沿用任务、日志与固件模型；当前不预留无功能的调试入口。

OpenOCD 使用独立参数启动，不经过 Shell。Tcl 参数转义覆盖变量、命令与括号解析。ST-Link 传输按实际驱动选择 `hla_*` / `dapdirect_*`；目标脚本加载后再应用用户时钟。禁用 GDB、Tcl、Telnet 监听。成功须同时满足进程正常退出和任务完成标记，Tcl 错误显式返回失败。

自定义目标 `.cfg` 是本机执行的 OpenOCD 脚本，请使用可信配置。多核、双 Bank 或外部 Flash 的具体配置应按目标芯片单独验证。

## UI 验证

在两个终端启动专用预览与隔离浏览器：

```bash
npm run dev -- --host 127.0.0.1 --port 1430
google-chrome-stable --headless=new --disable-gpu --remote-debugging-port=9334 --user-data-dir=/tmp/flashstudio-chrome about:blank
```

然后运行 `npm run test:ui`。可通过 `FLASHSTUDIO_UI_URL` / `FLASHSTUDIO_CDP_PORT` 更改地址。测试使用模拟 Tauri 桥接，不会接触硬件；截图写入 `/tmp/flashstudio-*.png`。

验证范围包括浏览器禁用硬件操作、文件导入、BIN 地址校验、运行时互斥、烧录/校验/擦除请求、擦除确认、取消、失败恢复、历史记录、设置持久化、主题和最小窗口布局。实物探针、具体 STM32 子型号以及各操作系统的打包仍需硬件/平台验收。

## OpenOCD 参考

- [探针与传输配置](https://openocd.org/doc/html/Debug-Adapter-Configuration.html)
- [Flash 命令与擦除范围](https://openocd.org/doc/html/Flash-Commands.html)
- [烧录流程](https://openocd.org/doc/html/Flash-Programming.html)
