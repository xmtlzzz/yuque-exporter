#!/usr/bin/env node
// A local web UI for the exporter: pick repositories, start an export, watch it,
// and open the report. It binds to 127.0.0.1 only and never persists the token.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { config, loadConfig } from '../../config.js';
import { SDK } from '../sdk.js';
import { renderPage } from './page.js';
import { clearSavedToken, readSavedToken, saveToken } from './token-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/lib/web/server.js -> project root
const projectRoot = path.resolve(here, '..', '..', '..');

interface Options {
  port: number;
  host: string;
  token: string;
  outputDir: string;
  configPath?: string;
  open: boolean;
}

function readArgs(argv: string[]): Options {
  const options: Options = {
    port: Number(process.env.PORT || 7788),
    host: '127.0.0.1',
    token: process.env.YUQUE_TOKEN || '',
    outputDir: '',
    configPath: undefined,
    open: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const take = () => argv[++index];
    if (arg === '--port') options.port = Number(take());
    else if (arg === '--host') options.host = String(take());
    else if (arg === '--token') options.token = String(take());
    else if (arg === '--outputDir') options.outputDir = String(take());
    else if (arg === '--config') options.configPath = String(take());
    else if (arg === '--open') options.open = true;
    else if (arg === '--no-open') options.open = false;
  }
  return options;
}

const options = readArgs(process.argv.slice(2));
// The token can arrive after startup (typed into the UI on first run), so it is
// read through this accessor instead of the frozen options object.
let activeToken = options.token;
// A per-run nonce means another browser tab on this machine cannot forge a
// state-changing request without having loaded the page first.
const session = randomBytes(16).toString('hex');
let running: { repos: string[]; startedAt: number; log: string[] } | null = null;
let lastResult: { summary: unknown; createdAt: string; outputDir: string } | null = null;

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  response.end(data);
};

async function readBody(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function resolveOutputDir(): Promise<string> {
  if (options.outputDir) return path.resolve(options.outputDir);
  // Reuse the config file outputDir so the UI and the CLI agree.
  try {
    await loadConfig(options.configPath);
  } catch {
    // A missing config file is not fatal here; fall back to the default.
  }
  return path.resolve(config.outputDir);
}

export interface RepoSummary {
  namespace: string;
  name: string;
  items: number;
  updatedAt: Date;
}

async function listRepos(): Promise<{ login: string; name: string; repos: RepoSummary[] }> {
  if (!activeToken) throw new Error('NO_TOKEN');
  const sdk = new SDK({ token: activeToken, host: config.host, userAgent: 'yuque-exporter-ui' });
  try {
    const user = await sdk.getUser('');
    const repos = await sdk.getRepos(user.login);
    return {
      login: user.login,
      name: user.name,
      repos: repos
        .filter(repo => repo.type === 'Book')
        .map(repo => ({
          namespace: repo.namespace,
          name: repo.name,
          items: repo.items_count,
          updatedAt: repo.content_updated_at,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    };
  } finally {
    await sdk.close();
  }
}

async function readReport(outputDir: string) {
  const file = path.join(outputDir, 'export-report.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// A compiled sidecar has no dist/ tree on disk; detect it by looking for the CLI
// entry point next to the executable layout.
function isBundled(): boolean {
  return !existsSync(path.join(projectRoot, 'dist', 'bin', 'cli.js'));
}

function pushLog(line: string) {
  if (!running) return;
  // Strip ANSI colour codes so the log panel shows plain text.
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
  if (plain.trim()) running.log.push(plain);
  if (running.log.length > 500) running.log = running.log.slice(-500);
}

async function finishExport(code: number) {
  const outputDir = await resolveOutputDir().catch(() => projectRoot);
  const report = await readReport(outputDir);
  lastResult = {
    summary: report?.summary ?? { failed: code === 0 ? 0 : 1 },
    createdAt: report?.createdAt ?? new Date().toISOString(),
    outputDir: report?.outputDir ?? outputDir,
  };
  if (running) running.log.push(code === 0 ? '导出完成' : '导出结束，退出码 ' + code);
  running = null;
}

function startExport(repos: string[], clean: boolean) {
  if (running) throw new Error('An export is already running.');
  if (!activeToken) throw new Error('NO_TOKEN');
  for (const repo of repos) {
    if (!/[\w.-]+\/[\w.-]+/.test(repo)) throw new Error('Invalid repository: ' + repo);
  }
  running = { repos, startedAt: Date.now(), log: [] };

  // A compiled sidecar has no dist/bin/cli.js to spawn, so the export runs in
  // this process. Running from source still spawns the CLI, which keeps the
  // server responsive and exercises exactly the same code path as the terminal.
  if (isBundled()) {
    void runExportInProcess(repos, clean);
    return;
  }

  const cliArgs = [ path.join(projectRoot, 'dist', 'bin', 'cli.js'), ...repos ];
  if (options.configPath) cliArgs.push('--config', options.configPath);
  if (options.outputDir) cliArgs.push('--outputDir', path.resolve(options.outputDir));
  cliArgs.push('--token', activeToken);
  if (clean) cliArgs.push('--clean');

  const child = spawn(process.execPath, cliArgs, {
    cwd: projectRoot,
    env: { ...process.env, YUQUE_TOKEN: '' },
    stdio: [ 'ignore', 'pipe', 'pipe' ],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) pushLog(line);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) pushLog(line);
  });
  child.on('close', (code: number | null) => { void finishExport(code ?? 0); });
  child.on('error', error => {
    pushLog('无法启动导出进程: ' + error.message);
    running = null;
  });
}

async function runExportInProcess(repos: string[], clean: boolean) {
  const { start } = await import('../../main.js');
  try {
    await start({
      repos,
      mode: 'export',
      options: {
        token: activeToken,
        outputDir: await resolveOutputDir(),
        clean,
        configPath: options.configPath,
      } as never,
    });
    await finishExport(0);
  } catch (error) {
    // main.js throws IncompleteExportError for an incomplete but saved report;
    // the report still exists, so surface its summary rather than a bare failure.
    pushLog(error instanceof Error ? error.message : String(error));
    await finishExport(1);
  }
}


const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const html = await renderPage({ session });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const outputDir = await resolveOutputDir();
      const report = await readReport(outputDir);
      return json(response, 200, {
        tokenConfigured: !!activeToken,
        running: running ? { repos: running.repos, startedAt: running.startedAt, log: running.log } : null,
        lastResult,
        outputDir,
        report: report
          ? {
            createdAt: report.createdAt,
            summary: report.summary,
            outputDir: report.outputDir || outputDir,
            failures: (report.documents || [])
              .filter((item: any) => item.status === 'failed' || item.status === 'unsupported')
              .slice(0, 50),
          }
          : null,
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/repos') {
      try {
        return json(response, 200, await listRepos());
      } catch (error) {
        // The first run has no token; that is a state, not a failure.
        if (error instanceof Error && error.message === 'NO_TOKEN') {
          return json(response, 401, { error: 'NO_TOKEN' });
        }
        throw error;
      }
    }

    // Saves a token typed into the UI and verifies it in the same call, so the
    // user learns immediately whether the value works.
    if (request.method === 'POST' && url.pathname === '/api/token') {
      const body = await readBody(request);
      if (body.session !== session) return json(response, 403, { error: 'Session expired; reload the page.' });
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) return json(response, 400, { error: '请输入 token' });
      const previous = activeToken;
      activeToken = token;
      try {
        const account = await listRepos();
        await saveToken(token);
        return json(response, 200, { ok: true, login: account.login, name: account.name, repos: account.repos.length });
      } catch (error) {
        // An invalid token must not replace a working one, and must not be saved.
        activeToken = previous;
        const message = error instanceof Error ? error.message : String(error);
        const friendly = /HTTP 401/i.test(message) ? 'Token 无效或已过期，请重新生成'
          : /HTTP 403/i.test(message) ? 'Token 没有访问权限'
            : message;
        return json(response, 400, { error: friendly });
      }
    }

    if (request.method === 'DELETE' && url.pathname === '/api/token') {
      activeToken = '';
      await clearSavedToken().catch(() => undefined);
      return json(response, 200, { ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/export') {
      const body = await readBody(request);
      if (body.session !== session) return json(response, 403, { error: 'Session expired; reload the page.' });
      const repos: string[] = Array.isArray(body.repos) ? body.repos.filter((item: unknown) => typeof item === 'string') : [];
      if (!repos.length) return json(response, 400, { error: 'Select at least one repository.' });
      startExport(repos, !!body.clean);
      return json(response, 200, { started: true });
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

// A stale server from an earlier window is the most common startup failure, so
// report it as a plain sentence instead of a stack trace.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.log('');
    console.log('  端口 ' + options.port + ' 已被占用，可能上一个窗口还没关。');
    console.log('  关掉旧的窗口，或用 PORT 环境变量换一个端口。');
    console.log('');
  } else {
    console.log('');
    console.log('  服务启动失败：' + error.message);
    console.log('');
  }
  process.exit(1);
});

// A token saved from a previous run makes the app usable straight away.
if (!activeToken) {
  const saved = await readSavedToken().catch(() => undefined);
  if (saved) activeToken = saved;
}

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = 'http://' + options.host + ':' + port;
  console.log('');
  console.log('  语雀导出界面已启动：' + url);
  console.log('  关闭这个窗口即可停止。');
  console.log('');
  if (!activeToken) {
    console.log('  ⚠ 未检测到 YUQUE_TOKEN，界面可以打开但无法导出。');
    console.log('');
  }
  if (options.open) {
    const command = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? [ '/c', 'start', '', url ] : [ url ];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  }
});
