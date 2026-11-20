import { join } from 'node:path';
import { context, publish, root } from '../common/build.mjs';

const ctx = context('windows');
// Pinned tauri-build 2.6 exposes this setting via the environment. Link the
// Visual C++ runtime into the app instead of requiring a separate redistributable.
ctx.env.STATIC_VCRUNTIME = 'true';
ctx.tauri(['build', '--bundles', 'nsis', '--target', ctx.target, '--config', join(root, 'packaging/windows/tauri.conf.json'), '--', '--locked']);
publish(join(ctx.releaseDir, 'bundle/nsis', `FlashStudio_${ctx.version}_x64-setup.exe`), ctx);
