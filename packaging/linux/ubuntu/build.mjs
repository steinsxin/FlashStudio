import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, publish, readJson, root, run } from '../../common/build.mjs';

const ctx = context('ubuntu');
const overlay = join(root, 'packaging/linux/ubuntu/tauri.conf.json');
run('pkg-config', ['--exists', 'webkit2gtk-4.1', 'gtk+-3.0']);
ctx.tauri(['build', '--no-bundle', '--target', ctx.target, '--config', overlay, '--', '--locked']);
const stage = mkdtempSync(join(ctx.outputDir, '.build-'));
try {
  mkdirSync(join(stage, 'debian'));
  writeFileSync(join(stage, 'debian/control'), 'Source: flash-studio\nSection: utils\nPriority: optional\n\nPackage: flash-studio\nArchitecture: any\nDescription: FlashStudio\n');
  const dependencies = run('dpkg-shlibdeps', ['-O', `-e${join(ctx.releaseDir, 'flashstudio')}`], { cwd: stage, stdio: 'pipe' });
  const libraries = dependencies.split('\n').find(line => line.startsWith('shlibs:Depends='))?.slice('shlibs:Depends='.length).trim();
  if (!libraries) throw new Error('Cannot determine Ubuntu runtime dependencies.');
  const config = readJson(overlay);
  config.bundle.linux.deb.depends = [...new Set([...config.bundle.linux.deb.depends, ...libraries.split(',').map(value => value.trim())])];
  const generated = join(stage, 'tauri-deb.json');
  writeFileSync(generated, JSON.stringify(config));
  ctx.tauri(['bundle', '--bundles', 'deb', '--target', ctx.target, '--config', generated]);
  const file = join(ctx.releaseDir, 'bundle/deb', `FlashStudio_${ctx.version}_amd64.deb`);
  run('dpkg-deb', ['--info', file]);
  publish(file, ctx);
} finally { rmSync(stage, { recursive: true, force: true }); }
