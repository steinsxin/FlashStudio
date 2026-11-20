import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { context, publish, root, run } from '../../common/build.mjs';

if (process.getuid?.() === 0) throw new Error('Build as a normal user; use sudo only when installing the package.');
const ctx = context('arch');
const recipe = join(root, 'packaging/linux/arch/PKGBUILD');
run('bash', ['-euc', 'source "$1"; pacman -T base-devel "${depends[@]}"', 'flashstudio', recipe]);
ctx.tauri(['build', '--no-bundle', '--target', ctx.target, '--', '--locked']);
const stage = mkdtempSync(join(ctx.outputDir, '.build-'));
try {
  const payload = join(stage, 'payload');
  const install = (source, target, mode = 0o644) => {
    const path = join(payload, target);
    mkdirSync(join(path, '..'), { recursive: true });
    copyFileSync(source, path); chmodSync(path, mode);
  };
  // Tauri resolves Linux resources using productName, including its case.
  const resources = `usr/lib/${ctx.productName}`;
  install(join(ctx.releaseDir, 'flashstudio'), 'usr/bin/flashstudio', 0o755);
  cpSync(join(root, 'src-tauri/resources/openocd'), join(payload, resources, 'openocd'), { recursive: true });
  install(join(root, 'packaging/linux/install-usb-rules.sh'), `${resources}/install-usb-rules.sh`);
  install(join(root, 'THIRD_PARTY_NOTICES.md'), `${resources}/THIRD_PARTY_NOTICES.md`);
  install(join(root, 'packaging/linux/flashstudio.desktop'), `usr/share/applications/${ctx.productName}.desktop`);
  install(join(root, 'public/flashstudio.svg'), 'usr/share/icons/hicolor/scalable/apps/flashstudio.svg');
  for (const [size, name] of [[32, '32x32'], [64, '64x64'], [128, '128x128'], [256, '128x128@2x']]) {
    install(join(root, `src-tauri/icons/${name}.png`), `usr/share/icons/hicolor/${size}x${size}/apps/flashstudio.png`);
  }
  for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) install(join(root, name), `usr/share/doc/flashstudio/${name}`);
  run('tar', ['-czf', join(stage, 'payload.tar.gz'), '-C', stage, 'payload']);
  const checksum = createHash('sha256').update(readFileSync(join(stage, 'payload.tar.gz'))).digest('hex');
  const version = ctx.version.replaceAll('-', '_');
  writeFileSync(join(stage, 'PKGBUILD'), readFileSync(recipe, 'utf8').replace(/^pkgver=.*$/m, `pkgver=${version}`).replace("sha256sums=('SKIP')", `sha256sums=('${checksum}')`));
  const options = { cwd: stage, env: { ...ctx.env, PKGDEST: ctx.outputDir, SRCDEST: stage, SRCPKGDEST: stage, BUILDDIR: join(stage, 'build'), LOGDEST: stage, PKGEXT: '.pkg.tar.zst' } };
  run('makepkg', ['--cleanbuild', '--clean', '--force', '--nosign'], options);
  const packages = run('makepkg', ['--packagelist'], { ...options, stdio: 'pipe' }).split('\n');
  if (packages.length !== 1 || !packages[0].endsWith('.pkg.tar.zst')) throw new Error('Expected one Arch package.');
  publish(packages[0], ctx);
} finally { rmSync(stage, { recursive: true, force: true }); }
