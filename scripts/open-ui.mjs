#!/usr/bin/env node
// Double-click launcher. It compiles once if needed, then hands over to the
// server process directly: no supervisor process, so closing the window cannot
// leave an orphan listening on the port.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = path.join(root, 'dist', 'lib', 'web', 'server.js');

if (!process.env.YUQUE_TOKEN) {
  console.log('');
  console.log('  还没有设置语雀 token。在 PowerShell 里执行一次（只需一次）：');
  console.log('');
  console.log("    [Environment]::SetEnvironmentVariable('YUQUE_TOKEN','你的token','User')");
  console.log('');
  console.log('  然后重开一个窗口，再双击本快捷方式。');
  console.log('');
  process.exit(1);
}

if (!existsSync(server)) {
  console.log('首次运行，正在编译，请稍候…');
  const build = spawnSync('npm', [ 'run', 'build' ], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.log('编译失败，请把上面的错误信息反馈给维护者。');
    process.exit(build.status ?? 1);
  }
}

const port = Number(process.env.PORT || 7788);
// execFileSync with inherit keeps this process identical to the server, so the
// console window owns exactly one long-lived process.
const result = spawnSync(process.execPath, [ server, '--port', String(port), '--open' ], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 0);
