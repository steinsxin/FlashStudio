# FlashStudio

简洁的桌面烧录工具，使用 Tauri 2 + React + Rust。支持 **Windows x64 / Linux x64**，通过内置 OpenOCD 使用 ST-Link、J-Link 和 CMSIS-DAP，提供固件烧录、独立校验和指定 Flash Bank / 扇区擦除。

## 界面

左侧导航切换固件烧录、固件校验和 Flash 擦除，右侧集中完成连接与操作；侧栏底部显示内置引擎状态，并提供帮助与主题切换。默认烧录后校验并复位运行。

- 不提供操作记录页面，不保存任务历史；旧版本的本地历史在升级后清除。
- SWD / JTAG、序列号、复位下连接和超时放在「高级设置」。
- 日志默认收起，连接检测或任务失败时自动展开；可导出当前任务最近 1000 行日志。
- 引擎自动就绪，没有 OpenOCD 路径、scripts 路径或环境配置页面。
- 保留连接参数与主题偏好；每次启动重新选择固件。

支持 BIN、HEX/IHEX、ELF/AXF，最大 32 MiB。BIN 使用明确的起始地址，其他格式使用文件内地址。固件导入后生成临时快照，避免源文件变化影响烧录。指定 Bank 擦除需确认范围；不解除保护、不修改 Option Bytes，不提供芯片调试。

## 自带引擎与离线使用

构建时从 [xPack OpenOCD 的固定发布版本](https://github.com/xpack-dev-tools/openocd-xpack/releases/tag/v0.12.0-7) 下载便携包，使用仓库内的 SHA-256 锁文件校验，保留引擎、配置脚本、动态库与上游许可文件。Linux 包使用自身的 `libexec`，Windows 包保留 DLL。运行时只解析应用资源目录中的引擎，**不查找系统 OpenOCD、不依赖 PATH、不下载组件**。缺少资源时明确报错，不回退到用户机器上的安装。

| 平台 | 分发方式 | 环境处理 |
| --- | --- | --- |
| Windows x64 | NSIS 安装程序 | 内置 OpenOCD、DLL、scripts，以及 WebView2 离线安装器 |
| Linux x64 | AppImage | 内置 OpenOCD 与依赖；AppImage 携带桌面运行库 |

Linux 打包流水线使用 **Ubuntu 22.04**，以控制 glibc 基线。目标是 Ubuntu 22.04+ / Debian 12 等兼容的 glibc 桌面系统，不承诺任意发行版、musl 系统或任意老系统。AppImage 如果遇到 FUSE 限制，可使用 `APPIMAGE_EXTRACT_AND_RUN=1 ./FlashStudio_*.AppImage`。参见 [Tauri AppImage 说明](https://v2.tauri.app/distribute/appimage/)。

Windows 安装器的 WebView2 选项使用 `offlineInstaller`：构建机下载，安装者无需联网下载运行库；不会静默假定用户已经安装。参见 [Tauri Windows 离线安装说明](https://v2.tauri.app/distribute/windows-installer/#offline-installer)。

### USB 访问权限

- **Linux**：在「高级设置」或「使用说明」点击「授权访问探针」，系统通过 polkit / pkexec 请求授权。只安装随包的 OpenOCD udev 规则到 `/etc/udev/rules.d/60-flashstudio.rules` 并重新加载规则，随后重新插拔探针。用户取消授权不会开始任何烧录。主程序和烧录进程仍以普通用户运行。系统需具备 udev、polkit 和桌面授权代理；这些是系统设备权限组件，不能作为普通应用绕过。
- **Windows**：HID 模式 CMSIS-DAP 通常使用系统驱动；ST-Link、J-Link 及 USB bulk 模式的探针需要与 OpenOCD 兼容的 USB 驱动。这与 OpenOCD 的可执行文件/DLL 是不同层。当前不会自动替换用户的探针驱动，以免影响其他厂商工具；仍需在目标探针上验证驱动兼容性。随包的 `distro-info/licenses/openocd-0.12.0/README.Windows` 说明了上游要求。

## 开发与构建

**开发机**需要 Node.js 22.12+、Python 3、Rust（edition 2024）及对应平台的 Tauri 构建依赖。**安装者不需要这些开发工具**。

```bash
cd FlashStudio
npm ci
npm run tauri dev
```

开发/打包命令会先准备对应平台的内置引擎。首次需要联网下载约 3 MB；准备好的引擎和缓存可供后续离线构建。生成资源不提交到 Git，以固定来源和校验值重建。

```bash
npm run engine:prepare                 # 准备并校验当前平台引擎
npm run build                          # 前端构建
npm test                               # Rust 与真实内置引擎的无硬件测试
python3 scripts/test-prepare-openocd.py # 下载校验/路径安全测试（Windows 使用 python）
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run package:linux                  # 在 Ubuntu 22.04 构建 AppImage
npm run package:windows                # 在 Windows x64 构建离线 NSIS 安装程序
```

离线准备或交叉准备引擎：

```bash
npm run engine:prepare -- --platform linux-x64 --archive /path/to/xpack-openocd-0.12.0-7-linux-x64.tar.gz
npm run engine:prepare -- --platform win32-x64 --archive C:/path/to/xpack-openocd-0.12.0-7-win32-x64.zip
```

离线压缩包仍须通过固定 SHA-256；错误或损坏的包不会替换现有引擎。交叉准备之后应使用匹配目标构建，Rust build script 会拒绝平台不一致的资源。

`.github/workflows/desktop.yml` 可手动触发，或在推送 `v*` 标签时构建 Ubuntu 22.04 AppImage 与 Windows NSIS，结果作为工作流附件；不自动发布 Release。

## 验证范围

已经验证：

- Windows/Linux 便携发布包下载、SHA-256、目录结构与库文件。
- Linux 引擎在干净 Ubuntu 22.04 容器中，以普通用户、空 PATH、无网络运行，解析三种探针配置；容器中没有安装系统 OpenOCD。
- 内置引擎命令规划、路径转义、退出码、单独校验、擦除确认、进程取消与超时。
- 单窗口 UI、无历史和引擎路径输入、高级设置折叠、模拟 USB 授权成功/取消、烧录/校验/擦除流程、800px 最小窗口。

尚需验收：真实 STM32 板卡烧录、真实系统授权窗口、Windows 驱动兼容性，以及最终安装包在目标桌面系统上的安装运行。容器测试验证的是 **烧录引擎的可携带性**，不等于整个图形应用已在所有 Linux 桌面通过验收。

UI 测试需要启动专用 Vite 与隔离 Chrome：

```bash
npm run dev -- --host 127.0.0.1 --port 1430
google-chrome-stable --headless=new --disable-gpu --remote-debugging-port=9334 --user-data-dir=/tmp/flashstudio-chrome about:blank
npm run test:ui
```

测试使用模拟 Tauri 桥接，不会连接硬件或请求真实 root 授权。地址可通过 `FLASHSTUDIO_UI_URL` / `FLASHSTUDIO_CDP_PORT` 设置。

## 主要代码

- `src/App.tsx`：单窗口工作流与高级选项。
- `src-tauri/src/bundled.rs`：内置资源定位，禁止回退系统引擎。
- `src-tauri/src/engine.rs`：OpenOCD 命令规划与参数校验。
- `src-tauri/src/runner.rs`：子进程、日志、取消和超时。
- `scripts/prepare-openocd.py`、`packaging/openocd.lock.json`：固定引擎下载与完整性验证。
- `packaging/linux/install-usb-rules.sh`：用户授权后的 USB 权限配置。

第三方组件信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
