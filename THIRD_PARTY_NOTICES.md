# Third-party engine distribution

FlashStudio invokes OpenOCD as a separate executable. The build downloads unmodified **xPack OpenOCD 0.12.0-7** portable archives. The SHA-256 digests and download URLs are pinned in `packaging/openocd.lock.json`; each prepared resource tree also contains a file inventory in `manifest.json`.

- Binary release: https://github.com/xpack-dev-tools/openocd-xpack/releases/tag/v0.12.0-7
- Release/build source: https://github.com/xpack-dev-tools/openocd-xpack/tree/v0.12.0-7
- OpenOCD upstream: https://openocd.org/
- xPack source repository: https://github.com/xpack-dev-tools/openocd

The entire upstream `distro-info/licenses` tree, upstream README, scripts, libraries and contribution files remain included in the application resources. This contains OpenOCD's COPYING / GPL-2.0 text and component notices for libusb, HIDAPI, libftdi and other bundled/build components. Refer to those original files for each component's license and source information; this notice does not replace them.

Windows OpenOCD is the x64 xPack distribution, following the same executable + DLL + scripts packaging pattern as the user's existing `OpenOCD烧录` directory. The reference directory and its firmware files are not copied or modified.

Windows installers use Tauri's `offlineInstaller` mode for Microsoft WebView2, obtained by the bundler at build time. Microsoft component terms apply. Probe kernel drivers are not redistributed by the current package.
