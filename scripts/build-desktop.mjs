#!/usr/bin/env node
// One-command desktop build: compile the sidecar, then let Tauri produce the
// installer. Kept in a script so the sidecar name (which Tauri requires to carry
// the target triple) lives in exactly one place.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binaries = path.join(root, 'src-tauri', 'binaries');

// Tauri resolves externalBin as "<name>-<target-triple><ext>".
function targetTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = out.match(/host:\s*(\S+)/);
  if (!match) throw new Error('Unable to determine the Rust host triple');
  return match[1];
}

const triple = targetTriple();
const ext = process.platform === 'win32' ? '.exe' : '';
const sidecar = path.join(binaries, `yuque-exporter-core-${triple}${ext}`);

console.log('1/3  Building TypeScript…');
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

console.log(`2/3  Bundling sidecar -> ${path.relative(root, sidecar)}`);
mkdirSync(binaries, { recursive: true });
execFileSync('bun', ['build', 'src/lib/web/server.ts', '--compile', '--outfile', sidecar], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log('3/3  Running tauri build…');
execFileSync('npx', ['tauri', 'build', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const release = path.join(root, 'src-tauri', 'target', 'release');
if (existsSync(release)) console.log(`\nDone. Output: ${release}`);
