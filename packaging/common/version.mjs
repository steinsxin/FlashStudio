// VERSION is authoritative. Sync the metadata required by npm, Cargo and Tauri
// without resolving dependencies or changing their locked versions.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

export function readVersion(directory = root) {
  const version = readFileSync(join(directory, 'VERSION'), 'utf8').trim();
  // All three package formats support a numeric release version. Windows PE
  // version fields are 16-bit, so reject values the installer cannot represent.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('VERSION must contain MAJOR.MINOR.PATCH (each component 0–65535, without leading zeros).');
  }
  return version;
}

function updateCargoVersion(source, header, version) {
  let matches = 0;
  const updated = source.split(/(?=^\[)/m).map(section => {
    if (section.split(/\r?\n/, 1)[0].trim() !== header
        || !/^name\s*=\s*"flashstudio"\s*(?:#.*)?$/m.test(section)) return section;
    matches++;
    if (!/^version\s*=\s*"[^"\r\n]+"/m.test(section)) throw new Error(`Missing version in ${header} flashstudio.`);
    return section.replace(/^(version\s*=\s*)"[^"\r\n]+"/m, (_, prefix) => `${prefix}"${version}"`);
  }).join('');
  if (matches !== 1) throw new Error(`Expected exactly one ${header} flashstudio entry.`);
  return updated;
}

export function syncVersion(directory = root) {
  const version = readVersion(directory);
  const files = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  const original = new Map(files.map(file => [file, readFileSync(join(directory, file), 'utf8')]));
  // Validate every input before writing any derived metadata.
  const updates = new Map();
  for (const file of files.slice(0, 3)) {
    const data = JSON.parse(original.get(file));
    data.version = version;
    if (file === 'package-lock.json') {
      if (!data.packages?.['']) throw new Error('package-lock.json must contain the root package.');
      data.packages[''].version = version;
    }
    updates.set(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  updates.set('src-tauri/Cargo.toml', updateCargoVersion(original.get('src-tauri/Cargo.toml'), '[package]', version));
  updates.set('src-tauri/Cargo.lock', updateCargoVersion(original.get('src-tauri/Cargo.lock'), '[[package]]', version));
  for (const [file, content] of updates) {
    if (content !== original.get(file)) writeFileSync(join(directory, file), content);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Synchronized application version from VERSION: ${syncVersion()}`);
}
