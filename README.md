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
| Arch Linux x86_64 | `.pkg.tar.zst` | 内置 OpenOCD；pacman 安装声明的桌面运行库、polkit、udev |
| Ubuntu 24.04 amd64 | `.deb` | 内置 OpenOCD；apt 安装按实际二进制计算的运行库依赖 |
| Windows x64 | NSIS `setup.exe` 安装向导 | 内置 OpenOCD、DLL、scripts，以及 WebView2 离线安装器 |

与 MotorStudio 一致，Arch 与 Ubuntu 分别在各自系统中编译，构建缓存相互隔离。Ubuntu 包以 **24.04** 为基线，不用于 Ubuntu 22.04；Arch 包面向当前滚动发行版。两个包都不依赖用户预装 OpenOCD、Node、Python 或 Rust，但原生 Linux 包的系统运行库仍由包管理器提供，首次补齐依赖可能需要网络。参见 [Tauri Debian 打包说明](https://v2.tauri.app/distribute/debian/)。

Windows 安装器支持中文/英文、选择安装目录、开始菜单与桌面快捷方式，并注册系统卸载入口。默认安装给当前用户，主程序不要求管理员身份。WebView2 使用 `offlineInstaller`：在构建机下载并放入安装器，安装者无需联网下载运行库。平台配置在 `packaging/windows/tauri.conf.json`，采用 [Tauri NSIS 安装向导](https://v2.tauri.app/distribute/windows-installer/)。

Windows 构建入口还启用当前锁定 Tauri 版本的静态 Visual C++ runtime 链接；构建检查会用 `dumpbin` 核对主程序没有额外的 VC runtime DLL 依赖，避免构建机预装的运行库掩盖缺项。安装检查只使用 Windows 自带的 PowerShell，不依赖 Python 或 Visual Studio。

Windows 引擎附带 `openocd.exe.manifest`，使进程使用 UTF-8，支持中文路径和输出；上游可执行文件保持原样。该清单与 DLL、脚本一起打包并校验，缺少它的旧缓存会自动重建。此 UTF-8 机制要求 Windows 10 1903 或更新版本。

安装方式：Arch 使用 `sudo pacman -U ./flashstudio-*.pkg.tar.zst`，Ubuntu 使用 `sudo apt install ./FlashStudio_*.deb`，Windows 双击 `FlashStudio_*-setup.exe` 按向导安装。

### USB 访问权限

- **Linux**：在「高级设置」或「使用说明」点击「授权访问探针」，系统通过 polkit / pkexec 请求授权。只安装随包的 OpenOCD udev 规则到 `/etc/udev/rules.d/60-flashstudio.rules` 并重新加载规则，随后重新插拔探针。用户取消授权不会开始任何烧录。主程序和烧录进程仍以普通用户运行。系统需具备 udev、polkit 和桌面授权代理；这些是系统设备权限组件，不能作为普通应用绕过。
- **Windows**：HID 模式 CMSIS-DAP 通常使用系统驱动；ST-Link、J-Link 及 USB bulk 模式的探针需要与 OpenOCD 兼容的 USB 驱动。这与 OpenOCD 的可执行文件/DLL 是不同层。当前不会自动替换用户的探针驱动，以免影响其他厂商工具；仍需在目标探针上验证驱动兼容性。随包的 `distro-info/licenses/openocd-0.12.0/README.Windows` 说明了上游要求。

## 开发与构建

**开发机**需要 Node.js 22.12+、Python 3、Rust（edition 2024）及对应平台的 Tauri 构建依赖。**安装者不需要这些开发工具**。

```bash
cd FlashStudio
npm run version:sync
npm ci
npm run tauri dev
```

开发/打包命令会先准备对应平台的内置引擎。首次需要联网下载约 3 MB；准备好的引擎和缓存可供后续离线构建。生成资源不提交到 Git，以固定来源和校验值重建。

```bash
npm run version:sync                   # 从 VERSION 同步 npm / Cargo / Tauri 元数据
npm run test:version                   # 版本同步、锁文件及 Windows 换行检查
npm run engine:prepare                 # 准备并校验当前平台引擎
npm run build                          # 前端构建
npm test                               # Rust 与真实内置引擎的无硬件测试
python3 scripts/test-prepare-openocd.py # 下载校验/路径安全测试（Windows 使用 python）
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run package:arch                   # 在 Arch 中构建 .pkg.tar.zst，使用普通用户
npm run package:ubuntu                 # 在 Ubuntu 24.04 构建 .deb（别名 package:deb）
npm run package:linux                  # 按当前 Linux 发行版选择上述原生包
npm run package:windows                # 在 Windows x64 构建离线 NSIS 安装程序
```

根目录的 `VERSION` 是应用版本的唯一来源，当前为 `1.0.0`。版本使用 `MAJOR.MINOR.PATCH`，三个数字均为 0–65535，不带前导零，以兼容三个平台的包格式。以后发布只需修改此文件；共用打包入口会自动同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 Tauri 配置，仅修改应用自身版本，保留第三方依赖锁定版本。界面底部也读取 `VERSION`。

安装包及同名 `.sha256` 校验文件分别输出到 `dist-packages/arch/`、`dist-packages/ubuntu/` 和 `dist-packages/windows/`，例如 `flashstudio-1.0.0-1-x86_64.pkg.tar.zst`、`FlashStudio_1.0.0_amd64.deb`、`FlashStudio_1.0.0_x64-setup.exe`。各入口检查当前系统、x64 架构和同步后的版本一致性。共用 Tauri 配置不默认选择包类型，请使用上面的平台打包命令。

两个 Linux 包共用 `/usr/lib/FlashStudio/` 资源目录，与 Tauri 的 `productName` 大小写一致；入口为 `/usr/bin/flashstudio`。Windows 资源放在安装目录内。包管理器中的名称分别是 Arch 的 `flashstudio`、Ubuntu 的 `flash-studio`。

Ubuntu 构建依赖：

```bash
sudo apt install build-essential curl file pkg-config dpkg-dev python3 libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Arch 构建依赖：

```bash
sudo pacman -S --needed base-devel git nodejs npm python rust gtk3 webkit2gtk-4.1 libsoup3 polkit xdg-utils
```

Windows 使用 MSVC Rust 工具链和 Visual Studio C++ Build Tools，另装 Node.js 与 Python。工作流使用原生 Windows runner 构建，不在 Linux 上交叉生成安装器。

离线准备或交叉准备引擎：

```bash
npm run engine:prepare -- --platform linux-x64 --archive /path/to/xpack-openocd-0.12.0-7-linux-x64.tar.gz
npm run engine:prepare -- --platform win32-x64 --archive C:/path/to/xpack-openocd-0.12.0-7-win32-x64.zip
```

离线压缩包仍须通过固定 SHA-256；错误或损坏的包不会替换现有引擎。交叉准备之后应使用匹配目标构建，Rust build script 会拒绝平台不一致的资源。

### GitHub Actions

三个独立工作流都在 **推送 main** 时触发，也支持 `workflow_dispatch` 手动运行；都先调用共用的 `version:sync` 读取该次提交中的 `VERSION`，再安装依赖、测试和打包。同一分支有新提交时取消旧任务，安装包和 SHA-256 作为 Actions artifacts 保留 30 天，不自动发布 Release。

| 工作流 | 构建与安装检查 | Artifact |
| --- | --- | --- |
| `build-linux-arch.yml` | 官方 Arch bootstrap；普通用户构建，另一个干净 Arch 环境安装并验证 | `flashstudio-arch-x86_64` |
| `build-linux-ubuntu.yml` | Ubuntu 24.04 构建；干净 Ubuntu 容器安装，检查真实依赖 | `flashstudio-ubuntu-24.04-amd64` |
| `build-windows.yml` | Windows 2022 / MSVC；NSIS 安装到带空格路径，验证引擎、快捷方式、启动与卸载 | `flashstudio-windows-x64` |

安装检查会核对完整引擎清单，并在空 PATH 下解析 ST-Link、J-Link、CMSIS-DAP 配置，不访问真实探针。Linux 以普通用户执行检查，Windows 验证实际安装目录中的 DLL 与脚本；Windows runner 已带 WebView2，因此其测试不能替代无 WebView2 机器上的首次安装验收。

在独立 Windows 测试机上，把安装器和 `packaging/windows/verify-*.ps1`、`packaging/openocd.lock.json` 按原目录结构复制过去，再运行以下命令。测试会安装到带空格的目录、启动应用并卸载，发现已有 FlashStudio 安装时会拒绝覆盖。

```powershell
./packaging/windows/verify-install.ps1 -Installer ./FlashStudio_1.0.0_x64-setup.exe -TestRoot C:\FlashStudio-validation\install-test
```

## 验证范围

已经验证：

- Windows/Linux 便携发布包下载、SHA-256、目录结构与库文件。
- Linux 引擎在干净 Ubuntu 22.04 容器中，以普通用户、空 PATH、无网络运行，解析三种探针配置；容器中没有安装系统 OpenOCD。
- Arch `.pkg.tar.zst` 与 Ubuntu 24.04 `.deb` 已实际构建，并在各自干净容器中安装；以普通用户核对桌面入口、运行库、资源目录，以及内置引擎的完整清单和三种探针配置。Arch 官方 Docker 镜像的文档裁剪规则在本地测试中关闭，工作流使用标准 bootstrap 环境。
- Ubuntu 24.04.4 实机已安装 `.deb`，在 GNOME X11 桌面启动，内置引擎就绪，烧录/校验/擦除页面正常显示；安装目录中的引擎清单和三种探针配置检查通过。
- Windows 11 Enterprise LTSC 2024（build 26100）KVM 虚拟机已原生构建 NSIS 安装器：4 项引擎打包测试、12 项 Rust 测试、Clippy 和静态 VC runtime 检查通过。
- Windows 恢复干净快照后，在无开发工具、无系统 OpenOCD、已移除 WebView2、断网且未提权的条件下，安装到含中文和空格的目录；安装器离线补齐当前用户的 WebView2，应用启动、内置引擎完整清单、UTF-8、三种探针配置、开始菜单入口和卸载检查通过。
- Windows 中文安装向导、安装目录选择、桌面快捷方式、烧录/校验/擦除页面及中文固件文件导入已实测。安装器约 287 MiB，包含 WebView2 离线安装文件；本次日志和截图位于本地 `dist-packages/validation/`。
- 内置引擎命令规划、路径转义、退出码、单独校验、擦除确认、进程取消与超时。
- 单窗口 UI、无历史和引擎路径输入、高级设置折叠、模拟 USB 授权成功/取消、烧录/校验/擦除流程、800px 最小窗口。

尚需验收：真实 STM32 板卡的烧录、校验和擦除，Linux 真实系统授权窗口，以及 Windows USB 探针驱动兼容性。虚拟机未直通探针；配置解析和界面检查不代表硬件烧录已经通过。其他 Linux 桌面环境和 Windows 版本仍需分别验收。

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
- `src-tauri/src/runner.rs`：共用子进程、日志、取消和超时逻辑。
- `src-tauri/src/platform/mod.rs`：操作系统共用接口；`linux/` 实现 USB 授权，`windows/` 实现 Windows 进程设置。
- `scripts/prepare-openocd.py`、`packaging/openocd.lock.json`：固定引擎下载与完整性验证。
- `packaging/common/`：共用构建接口、版本与架构检查、产物校验、已安装引擎验证。
- `VERSION`、`packaging/common/version.mjs`：应用版本唯一来源及三端共用的元数据同步。
- `packaging/linux/`：Linux 共用桌面入口、权限助手、安装检查；`arch/`、`ubuntu/` 分别处理包格式与依赖。
- `packaging/windows/`：NSIS 配置、构建与安装/卸载检查。
- `packaging/linux/install-usb-rules.sh`：用户授权后的 USB 权限配置。

第三方组件信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
