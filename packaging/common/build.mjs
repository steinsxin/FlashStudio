// Shared build contract: versions, native target, isolated output and checksums.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})${result.stderr ? `\n${result.stderr}` : ''}`);
  return result.stdout?.toString().trim();
}
export function context(platform) {
  const os = platform === 'windows' ? 'win32' : 'linux';
  if (process.platform !== os || process.arch !== 'x64') throw new Error(`Build ${platform} on its native x64 system.`);
  if (os === 'linux') {
    const id = readFileSync('/etc/os-release', 'utf8').match(/^ID=["']?([^\s"']+)/m)?.[1];
    if (id !== platform) throw new Error(`Build ${platform} on ${platform}, not ${id}.`);
  }
  if (!existsSync(join(root, 'node_modules/@tauri-apps/cli/tauri.js'))) throw new Error('Run npm ci first.');
  const config = readJson(join(root, 'src-tauri/tauri.conf.json'));
  const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--no-deps', '--format-version', '1', '--locked'], { stdio: 'pipe' }));
  const version = config.version;
  if (readJson(join(root, 'package.json')).version !== version || metadata.packages.find(p => p.name === 'flashstudio')?.version !== version) {
    throw new Error('package.json, Cargo.toml and tauri.conf.json must have the same version.');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Unsupported version: ${version}`);
  const target = os === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
  const host = run('rustc', ['-vV'], { stdio: 'pipe' }).match(/^host: (.+)$/m)?.[1];
  if (host !== target) throw new Error(`Expected native Rust target ${target}, got ${host}.`);
  const targetDir = join(root, 'src-tauri/target/packages', platform, 'target');
  const releaseDir = join(targetDir, target, 'release');
  const outputDir = join(root, 'dist-packages', platform);
  mkdirSync(outputDir, { recursive: true });
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  const tauri = args => run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args], { env });
  return { platform, productName: config.productName, version, target, releaseDir, outputDir, env, tauri };
}
export function publish(source, context) {
  const destination = join(context.outputDir, basename(source));
  if (source !== destination) copyFileSync(source, destination);
  const checksum = createHash('sha256').update(readFileSync(destination)).digest('hex');
  writeFileSync(`${destination}.sha256`, `${checksum}  ${basename(destination)}\n`);
  console.log(`Installer: ${destination}`);
}
