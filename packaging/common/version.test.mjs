import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readVersion, syncVersion } from './version.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'flashstudio-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'src-tauri'));
  const files = {
    'VERSION': '1.0.0\n',
    'package.json': JSON.stringify({ name: 'flashstudio', version: '0.1.0', dependencies: { example: '0.1.0' } }),
    'package-lock.json': JSON.stringify({ version: '0.1.0', lockfileVersion: 3, packages: { '': { version: '0.1.0' }, 'node_modules/example': { version: '0.1.0', integrity: 'unchanged' } } }),
    'src-tauri/tauri.conf.json': JSON.stringify({ productName: 'FlashStudio', version: '0.1.0', bundle: { active: true } }),
    'src-tauri/Cargo.toml': '[package]\nname = "flashstudio"\nversion = "0.1.0" # application\n\n[dependencies.example]\nversion = "0.1.0"\n',
    'src-tauri/Cargo.lock': '# Generated lockfile\nversion = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0"\nchecksum = "unchanged"\n\n[[package]]\nname = "flashstudio"\nversion = "0.1.0"\ndependencies = ["example"]\n',
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
  return { directory, files, read: file => readFileSync(join(directory, file), 'utf8') };
}

test('synchronizes all package versions while preserving dependency locks', t => {
  const { directory, read } = fixture(t);
  assert.equal(syncVersion(directory), '1.0.0');
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    assert.equal(JSON.parse(read(file)).version, '1.0.0');
  }
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].version, '1.0.0');
  assert.deepEqual(lock.packages['node_modules/example'], { version: '0.1.0', integrity: 'unchanged' });
  assert.equal(JSON.parse(read('package.json')).dependencies.example, '0.1.0');
  assert.match(read('src-tauri/Cargo.toml'), /version = "1\.0\.0" # application/);
  assert.match(read('src-tauri/Cargo.toml'), /\[dependencies.example\]\nversion = "0\.1\.0"/);
  assert.match(read('src-tauri/Cargo.lock'), /name = "example"\nversion = "0\.1\.0"\nchecksum = "unchanged"/);
  assert.match(read('src-tauri/Cargo.lock'), /name = "flashstudio"\nversion = "1\.0\.0"/);
  assert.match(read('src-tauri/Cargo.lock'), /^# Generated lockfile\nversion = 4/);
});

test('a VERSION-only change updates stale metadata, including Windows line endings', t => {
  const { directory, read } = fixture(t);
  syncVersion(directory);
  writeFileSync(join(directory, 'VERSION'), '\uFEFF2.7.13\r\n');
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    writeFileSync(join(directory, file), read(file).replaceAll('\n', '\r\n'));
  }
  assert.equal(readVersion(directory), '2.7.13');
  syncVersion(directory);
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].version, '2.7.13');
  assert.match(read('src-tauri/Cargo.lock'), /name = "flashstudio"\r\nversion = "2\.7\.13"\r\n/);
});

test('unchanged versions do not rewrite metadata and trigger unnecessary rebuilds', t => {
  const { directory, files } = fixture(t);
  syncVersion(directory);
  const derived = Object.keys(files).filter(file => file !== 'VERSION');
  for (const file of derived) utimesSync(join(directory, file), new Date(0), new Date(0));
  syncVersion(directory);
  for (const file of derived) assert.equal(statSync(join(directory, file)).mtimeMs, 0);
});

test('invalid versions fail before changing any metadata', t => {
  const { directory, files, read } = fixture(t);
  for (const version of ['', '1.0', 'v1.0.0', '01.0.0', '1.0.0\n2.0.0', '1.0.0-rc.1', '65536.0.0']) {
    writeFileSync(join(directory, 'VERSION'), version);
    assert.throws(() => syncVersion(directory), /VERSION must contain/);
    for (const [file, content] of Object.entries(files)) {
      if (file !== 'VERSION') assert.equal(read(file), content);
    }
  }
});

test('missing or ambiguous Cargo lock entries fail before partially synchronizing files', t => {
  const { directory, files, read } = fixture(t);
  for (const lock of ['version = 4\n', files['src-tauri/Cargo.lock'] + '\n[[package]]\nname = "flashstudio"\nversion = "0.2.0"\n']) {
    writeFileSync(join(directory, 'src-tauri/Cargo.lock'), lock);
    assert.throws(() => syncVersion(directory), /Expected exactly one/);
    for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml']) {
      assert.equal(read(file), files[file]);
    }
  }
});
