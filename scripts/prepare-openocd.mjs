// Python is only a build dependency. Installed FlashStudio never downloads tools.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./prepare-openocd.py', import.meta.url));
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error(`Preparing bundled OpenOCD requires Python 3 on the build machine: ${result.error.message}`);
process.exit(result.status ?? 1);
