import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { start } from '../src/main.js';
import { config, loadConfig, resetConfig } from '../src/config.js';
import { build } from '../src/lib/builder.js';
import { crawl } from '../src/lib/crawler.js';
import { documentPath, manifestPath } from '../src/lib/cache.js';
import { writeFile, download, getRedirectLink, logger } from '../src/lib/utils.js';
import { IncompleteExportError } from '../src/lib/report.js';

const execute = promisify(execFile);
const project = path.resolve('.');
type Route = (url: URL, response: http.ServerResponse, request: http.IncomingMessage) => void;

describe('export integration', () => {
  let directory: string;
  let server: http.Server;
  let host: string;
  let docs: any[];
  let details: Record<string, any>;
  let toc: any[];
  let requests: string[];
  let detailReads: Record<string, number>;
  let extra: Route;
  let originalToken: string | undefined;
  let originalLogLevel: number;
  const namespace = 'owner/book';

  before(() => {
    originalLogLevel = logger.level;
    logger.level = -999;
  });
  after(() => { logger.level = originalLogLevel; });

  const json = (response: http.ServerResponse, data: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data }));
  };
  const doc = (slug: string, id = 1, values: any = {}) => ({
    id, slug, title: slug, type: 'Doc', status: 1, format: 'markdown',
    word_count: 3, published_at: '2026-10-01', updated_at: 'v1', content_updated_at: 'v1', ...values,
  });
  const run = (values: any = {}, repos = [ namespace ]) => start({
    repos,
    options: { host, token: 'synthetic-test-token', outputDir: directory, retries: 0, retryDelay: 0, preferYfm: false, ...values },
  });
  const readReport = async () => JSON.parse(await fs.readFile(path.join(directory, 'export-report.json'), 'utf8'));
  const itemFile = (report: any, slug: string, extension = '.md') => report.documents.find((item: any) => item.slug === slug).files.find((file: string) => file.endsWith(extension));
  const text = (file: string) => fs.readFile(path.join(directory, file), 'utf8');
  const exported = async () => {
    const files: string[] = [];
    async function visit(folder: string) {
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        if (item.name === '.meta') continue;
        const absolute = path.join(folder, item.name);
        if (item.isDirectory()) await visit(absolute);
        else files.push(absolute);
      }
    }
    await visit(directory);
    return files;
  };

  beforeEach(async () => {
    originalToken = process.env.YUQUE_TOKEN;
    delete process.env.YUQUE_TOKEN;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuque-exporter-test-'));
    docs = [ doc('normal') ];
    details = { normal: { ...docs[0], body: '# Normal\n\nActual content.' } };
    toc = [];
    requests = [];
    detailReads = {};
    extra = () => {};
    server = http.createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      requests.push(request.url!);
      extra(url, response, request);
      if (response.headersSent) return;
      if (url.pathname === `/api/v2/repos/${namespace}`) return json(response, { id: 1, type: 'Book', namespace, name: 'Book', toc_yml: JSON.stringify(toc) });
      if (url.pathname === `/api/v2/repos/${namespace}/docs`) {
        const offset = Number(url.searchParams.get('offset') || 0);
        return json(response, docs.slice(offset, offset + 100));
      }
      const prefix = `/api/v2/repos/${namespace}/docs/`;
      if (url.pathname.startsWith(prefix)) {
        const slug = decodeURIComponent(url.pathname.slice(prefix.length));
        detailReads[slug] = (detailReads[slug] || 0) + 1;
        if (details[slug]) return json(response, details[slug]);
      }
      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterEach(async () => {
    // Undici keeps connections alive between requests, so close() would wait for
    // them and leak a stalled server into the next test. Close the sockets first.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (originalToken === undefined) delete process.env.YUQUE_TOKEN;
    else process.env.YUQUE_TOKEN = originalToken;
    resetConfig();
    const allowedPrefix = path.resolve(os.tmpdir()) + path.sep + 'yuque-exporter-test-';
    assert.ok(path.resolve(directory).startsWith(allowedPrefix));
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('exports a normal document through start, with actual output and report', async () => {
    const report = await run();
    assert.equal(report.summary.exported, 1);
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
    assert.deepEqual((await readReport()).summary, report.summary);
    for (const file of await exported()) assert.ok((await fs.stat(file)).size > 0);
  });

  it('recovers a former 0-byte cache despite unchanged published_at and migrates the manifest', async () => {
    config.outputDir = directory;
    await writeFile(path.join(config.metaDir, namespace, 'docs', 'normal.json'), { ...docs[0], body: '' });
    await writeFile(path.join(config.metaDir, namespace, 'docs-published-at.json'), { 1: docs[0].published_at });
    const report = await run();
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
    assert.equal(detailReads.normal, 1);
    assert.equal(JSON.parse(await fs.readFile(manifestPath(namespace), 'utf8')).schemaVersion, 2);
  });

  it('reuses a validated nonempty cache then detects updated_at without republishing', async () => {
    await run();
    await run();
    assert.equal(detailReads.normal, 1);
    docs[0].updated_at = 'v2';
    details.normal.body = 'Edited without publishing.';
    const report = await run();
    assert.equal(detailReads.normal, 2);
    assert.match(await text(itemFile(report, 'normal')), /Edited without publishing/);
  });

  it('detects unpublished edits with null published_at and uses the new draft', async () => {
    docs[0] = doc('draft', 1, { status: 0, published_at: null, draft_version: 1 });
    details = { draft: { ...docs[0], body: 'Old published snapshot', body_draft: 'First draft' } };
    const first = await run();
    assert.match(await text(itemFile(first, 'draft')), /First draft/);
    docs[0].draft_version = 2;
    details.draft.body_draft = 'Second draft';
    const second = await run();
    assert.match(await text(itemFile(second, 'draft')), /Second draft/);
    assert.equal(detailReads.draft, 2);
  });

  it('refetches a missing detail file even when its version is unchanged', async () => {
    await run();
    await fs.unlink(documentPath(namespace, 'normal'));
    await run();
    assert.equal(detailReads.normal, 2);
  });

  it('refetches corrupt JSON cache and repairs it', async () => {
    await run();
    await fs.writeFile(documentPath(namespace, 'normal'), '{');
    await run();
    assert.equal(detailReads.normal, 2);
    assert.match(JSON.parse(await fs.readFile(documentPath(namespace, 'normal'), 'utf8')).body, /Actual content/);
  });

  it('refetches a parseable cache that has been emptied or modified', async () => {
    await run();
    await fs.writeFile(documentPath(namespace, 'normal'), JSON.stringify({ ...docs[0], body: '' }));
    const report = await run();
    assert.equal(detailReads.normal, 2);
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
  });

  it('does not commit a failed fetch and succeeds on the next unchanged-version run', async () => {
    extra = (url, response) => {
      if (url.pathname.endsWith('/docs/normal')) {
        response.writeHead(503);
        response.end('temporary');
      }
    };
    await assert.rejects(run(), IncompleteExportError);
    assert.equal((await readReport()).summary.failed, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath(namespace), 'utf8')).documents, {});
    extra = () => {};
    const report = await run();
    assert.equal(report.summary.exported, 1);
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
  });

  it('keeps old output when a newer version fetch fails, and later recovers', async () => {
    const first = await run();
    const file = itemFile(first, 'normal');
    const before = await text(file);
    docs[0].content_updated_at = 'v2';
    extra = (url, response) => {
      if (url.pathname.endsWith('/docs/normal')) { response.writeHead(503); response.end(); }
    };
    await assert.rejects(run(), IncompleteExportError);
    assert.equal(await text(file), before);
    const failed = await readReport();
    assert.equal(failed.summary.exported, 0);
    assert.equal(failed.documents[0].preserved, true);
    extra = () => {};
    details.normal.body = 'Recovered new version';
    const next = await run();
    assert.match(await text(itemFile(next, 'normal')), /Recovered new version/);
  });

  it('continues independent documents when one detail request fails', async () => {
    docs.push(doc('bad', 2));
    await assert.rejects(run(), IncompleteExportError);
    const report = await readReport();
    assert.equal(report.summary.exported, 1);
    assert.equal(report.summary.failed, 1);
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
  });

  it('clean forces refetch while retaining valid previous output on failure', async () => {
    const report = await run();
    const previous = await text(itemFile(report, 'normal'));
    extra = (url, response) => {
      if (url.pathname.endsWith('/docs/normal')) { response.writeHead(403); response.end(); }
    };
    await assert.rejects(run({ clean: true }), IncompleteExportError);
    assert.equal(await text(itemFile(report, 'normal')), previous);
    assert.ok((await fs.stat(documentPath(namespace, 'normal'))).size > 0);
  });

  it('exports all 101 documents through real list pagination and build', async () => {
    docs = Array.from({ length: 101 }, (_, index) => doc(`doc-${index}`, index + 1));
    details = Object.fromEntries(docs.map(item => [ item.slug, { ...item, body: `Content ${item.id}` } ]));
    const report = await run();
    assert.equal(report.summary.exported, 101);
    assert.match(await text(itemFile(report, 'doc-100')), /Content 101/);
    assert.ok(requests.some(url => url.includes('offset=100')));
  });

  it('reports genuine empty docs and TOC placeholders without creating 0-byte files', async () => {
    docs[0].word_count = 0;
    details.normal = { ...docs[0], body: '' };
    toc = [ { type: 'UNCREATED_DOC', title: 'Not created', uuid: 'placeholder', url: 'new' } ];
    await fs.mkdir(path.join(directory, 'Book'), { recursive: true });
    await fs.writeFile(path.join(directory, 'Book', 'Not created.md'), '');
    const report = await run();
    assert.equal(report.summary.empty, 1);
    assert.equal(report.summary.uncreated, 1);
    assert.equal(report.summary.exported, 0);
    assert.equal((await exported()).filter(file => file.endsWith('.md')).length, 0);
    for (const file of await exported()) assert.ok((await fs.stat(file)).size > 0);
  });

  it('backs up missing positive-word-count content and returns an incomplete result', async () => {
    details.normal = { ...docs[0], body: null };
    await assert.rejects(run(), IncompleteExportError);
    const report = await readReport();
    assert.equal(report.summary.unsupported, 1);
    assert.equal(report.summary.exported, 0);
    assert.equal(JSON.parse(await text(itemFile(report, 'normal', '.raw.json'))).body, null);
    assert.equal((await exported()).filter(file => file.endsWith('.md')).length, 0);
  });

  it('uses numeric-ID YFM for a published document whose legacy body is empty', async () => {
    details.normal.body = '';
    extra = (url, response) => {
      if (url.pathname === '/api/v2/yfm/docs') {
        assert.equal(url.searchParams.get('doc_id'), '1');
        json(response, { yfm: '# Recovered YFM' });
      }
    };
    const report = await run({ preferYfm: true });
    assert.match(await text(itemFile(report, 'normal')), /Recovered YFM/);
    assert.equal(report.documents[0].source, 'exporter_markdown');
  });

  it('preserves native Lake if YFM is unavailable and reports the fallback warning', async () => {
    details.normal = { ...docs[0], body: '', body_lake: '<lake><p>Native</p></lake>' };
    const report = await run({ preferYfm: true });
    assert.equal(await text(itemFile(report, 'normal', '.lake')), details.normal.body_lake);
    assert.ok(report.documents[0].warnings.some((warning: string) => warning.includes('YFM fallback unavailable')));
  });

  it('does not use published YFM to overwrite an unpublished Lake draft', async () => {
    docs[0].status = 0;
    details.normal = { ...docs[0], body: 'Published old body', body_draft_lake: '<lake>Draft</lake>' };
    const report = await run({ preferYfm: true });
    assert.equal(await text(itemFile(report, 'normal', '.lake')), '<lake>Draft</lake>');
    assert.ok(!requests.some(url => url.includes('/yfm/')));
  });

  it('preserves Sheet JSON and native HTML as their own nonempty formats', async () => {
    docs = [ doc('sheet', 1, { type: 'Sheet', format: 'lakesheet' }), doc('html', 2, { type: 'HtmlDoc', format: 'html' }) ];
    details = {
      sheet: { ...docs[0], body: '', body_sheet: '{"sheets":[{"cells":[["A"]]}]}' },
      html: { ...docs[1], body: '', body_html: '<html><body>Preserved</body></html>' },
    };
    const report = await run();
    assert.equal(await text(itemFile(report, 'sheet', '.sheet.json')), details.sheet.body_sheet);
    assert.equal(await text(itemFile(report, 'html', '.html')), details.html.body_html);
    assert.equal(report.summary.exported, 2);
  });

  it('exports a complete 201-row table with three original page bodies in cache', async () => {
    docs = [ doc('table', 1, { type: 'Table', format: 'table' }) ];
    extra = (url, response) => {
      if (!url.pathname.endsWith('/docs/table')) return;
      const page = Number(url.searchParams.get('page'));
      const start = (page - 1) * 100;
      json(response, { ...docs[0], body: '', body_table: JSON.stringify({ records: Array.from({ length: Math.min(100, 201 - start) }, (_, index) => ({ id: start + index + 1 })), totalCount: 201, pageSize: 100, page }) });
    };
    const report = await run();
    const table = JSON.parse(await text(itemFile(report, 'table', '.table.json')));
    assert.equal(table.records.length, 201);
    assert.equal(table.records[200].id, 201);
    const cache = JSON.parse(await fs.readFile(documentPath(namespace, 'table'), 'utf8'));
    assert.equal(cache.exporter_table_pages.length, 3);
  });

  it('creates a visible raw backup for Board without silently treating it as Markdown', async () => {
    docs[0].type = 'Board';
    details.normal = { ...docs[0], body: 'Board structure' };
    await assert.rejects(run(), IncompleteExportError);
    const report = await readReport();
    assert.equal(report.summary.unsupported, 1);
    assert.equal(JSON.parse(await text(itemFile(report, 'normal', '.raw.json'))).body, 'Board structure');
  });

  it('preserves existing Markdown when the latest detail has no verified body', async () => {
    const old = await run();
    const file = itemFile(old, 'normal');
    const previous = await text(file);
    docs[0].updated_at = 'v2';
    details.normal.body = '';
    await assert.rejects(run(), IncompleteExportError);
    assert.equal(await text(file), previous);
    assert.equal((await readReport()).documents[0].preserved, true);
  });

  it('avoids collisions across DOC/DRAFT_DOC, case variants and folder-file names', async () => {
    docs = [ doc('one', 1, { title: 'Same' }), doc('two', 2, { title: 'same', status: 0 }), doc('three', 3, { title: 'Folder' }) ];
    details = Object.fromEntries(docs.map((item, index) => [ item.slug, { ...item, body: `Unique ${index}` } ]));
    toc = [
      { type: 'DOC', uuid: 'one', url: 'one', title: 'Same' },
      { type: 'TITLE', uuid: 'folder', title: 'Folder.md' },
    ];
    const report = await run();
    const paths = report.documents.filter(item => item.status === 'exported').map(item => item.files[0].toLowerCase());
    assert.equal(new Set(paths).size, 3);
    for (const [ index, slug ] of [ 'one', 'two', 'three' ].entries()) assert.match(await text(itemFile(report, slug)), new RegExp(`Unique ${index}`));
  });

  it('uses real target extensions, forward slashes and anchors for internal links', async () => {
    docs.push(doc('target', 2, { type: 'HtmlDoc', format: 'html', title: 'Target' }));
    details.target = { ...docs[1], body_html: '<p>Target content</p>' };
    details.normal.body = `[go](${host}/${namespace}/target#section)\n[missing](${host}/${namespace}/new)`;
    toc = [
      { type: 'TITLE', uuid: 'folder', title: 'Nested' },
      { type: 'DOC', uuid: 'normal', parent_uuid: 'folder', title: 'normal', url: 'normal' },
      { type: 'UNCREATED_DOC', uuid: 'new', title: 'New', url: 'new' },
    ];
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.match(content, /\.\.\/Target\.html#section/);
    assert.ok(!content.includes('\\'));
    assert.ok(content.includes(`${host}/${namespace}/new`));
  });

  it('keeps escaped asterisks and GFM tables/task lists semantically intact', async () => {
    details.normal.body = 'Literal \\*stars\\*\n\n| Name | Value |\n| --- | --- |\n| a | b |\n\n- [x] Done\n';
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.match(content, /\\\*stars\\\*/);
    assert.match(content, /\| Name\s*\| Value/);
    assert.match(content, /- \[x\] Done/);
  });

  it('retains a remote image URL on 403 without writing a local empty asset', async () => {
    details.normal.body = `![restricted](${host}/images/denied.png)`;
    extra = (url, response) => { if (url.pathname === '/images/denied.png') { response.writeHead(403); response.end(); } };
    const report = await run();
    assert.ok((await text(itemFile(report, 'normal'))).includes(`${host}/images/denied.png`));
    assert.ok(report.documents[0].warnings.some(warning => warning.includes('remote link retained')));
    assert.equal((await exported()).filter(file => file.endsWith('.png')).length, 0);
  });

  it('downloads a nonempty image atomically and rewrites the local path only after success', async () => {
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    details.normal.body = `![image](${host}/images/a.png)`;
    extra = (url, response) => {
      if (url.pathname === '/images/a.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(image); }
    };
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.match(content, /assets\/normal\/[a-f0-9]{16}-a\.png/);
    assert.ok(!content.includes(host));
    const asset = (await exported()).find(file => file.endsWith('.png'))!;
    assert.deepEqual(await fs.readFile(asset), image);
    assert.ok(!(await exported()).some(file => file.endsWith('.tmp')));
  });

  it('rejects HTML login responses and zero-byte resources without replacing remote URLs', async () => {
    details.normal.body = `![html](${host}/images/html.png)\n![empty](${host}/images/empty.png)`;
    extra = (url, response) => {
      if (url.pathname === '/images/html.png') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>Login</html>'); }
      if (url.pathname === '/images/empty.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(); }
    };
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.ok(content.includes(`${host}/images/html.png`));
    assert.ok(content.includes(`${host}/images/empty.png`));
    assert.equal((await exported()).filter(file => file.endsWith('.png')).length, 0);
  });

  it('makes same-basename images from different URLs use distinct asset files', async () => {
    details.normal.body = `![one](${host}/one/image.png)\n![two](${host}/two/image.png)`;
    extra = (url, response) => {
      if (url.pathname.endsWith('/image.png')) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(url.pathname); }
    };
    await run();
    const images = (await exported()).filter(file => file.endsWith('.png'));
    assert.equal(images.length, 2);
    assert.notEqual(await fs.readFile(images[0], 'utf8'), await fs.readFile(images[1], 'utf8'));
  });

  it('preserves an existing file when a download fails or content serialization is invalid', async () => {
    const file = path.join(directory, 'existing.png');
    await fs.writeFile(file, 'previous');
    config.outputDir = directory;
    config.retries = 0;
    assert.equal(await download(host + '/not-found', file), host + '/not-found');
    await assert.rejects(writeFile(file, undefined), /undefined/);
    assert.equal(await fs.readFile(file, 'utf8'), 'previous');
  });

  it('resolves relative HEAD redirects without a header union typing or dispatcher conflict', async () => {
    extra = (url, response) => {
      if (url.pathname === '/share') { response.writeHead(302, { location: `/${namespace}/normal` }); response.end(); }
    };
    assert.equal(await getRedirectLink(host + '/share', host), host + '/' + namespace + '/normal');
  });

  it('initializes TOML host/output before SDK creation and uses environment token priority', async () => {
    const configPath = path.join(directory, 'settings.toml');
    await fs.writeFile(configPath, `[yuque]\nhost = "${host}"\ntoken = "toml-test-token"\noutputDir = "./nested"\nretries = 0\npreferYfm = false\n[yuque.target]\nrepos = ["${namespace}"]\n`);
    process.env.YUQUE_TOKEN = 'environment-test-token';
    extra = (_url, _response, request) => { assert.equal(request.headers['x-auth-token'], 'environment-test-token'); };
    const report = await start({ configPath });
    assert.equal(report.summary.exported, 1);
    assert.equal(report.outputDir, path.join(directory, 'nested'));
    assert.match(await fs.readFile(path.join(report.outputDir, itemFile(report, 'normal')), 'utf8'), /Actual content/);
  });

  it('explicit options override TOML and environment without leaking the token', async () => {
    const configPath = path.join(directory, 'settings.toml');
    await fs.writeFile(configPath, `[yuque]\nhost = "http://127.0.0.1:1"\ntoken = "toml-test-token"\noutputDir = "./ignored"\n[yuque.target]\nrepos = ["${namespace}"]\n`);
    process.env.YUQUE_TOKEN = 'environment-test-token';
    extra = (_url, _response, request) => { assert.equal(request.headers['x-auth-token'], 'cli-test-token'); };
    const report = await start({ configPath, options: { host, token: 'cli-test-token', outputDir: directory, retries: 0, preferYfm: false } });
    assert.equal(report.outputDir, directory);
    assert.ok(!JSON.stringify(report).includes('cli-test-token'));
  });

  it('does not silently ignore an explicitly missing config file', async () => {
    await assert.rejects(loadConfig(path.join(directory, 'missing.toml')), /ENOENT/);
  });

  it('exports all visible books when no targets are supplied', async () => {
    extra = (url, response) => {
      if (url.pathname === '/api/v2/user') json(response, { login: 'owner' });
      if (url.pathname === '/api/v2/users/owner/repos') json(response, [ { id: 1, namespace, type: 'Book' }, { id: 2, namespace: 'owner/nonbook', type: 'Design' } ]);
    };
    const report = await run({}, []);
    assert.equal(report.summary.exported, 1);
    assert.deepEqual(report.crawl!.repos, [ namespace ]);
  });

  it('restricts offline build to the requested repository and works without a token', async () => {
    await run();
    const other = 'owner/other';
    await writeFile(path.join(config.metaDir, other, 'repo.json'), { type: 'Book', namespace: other, name: 'Other' });
    await writeFile(path.join(config.metaDir, other, 'toc.json'), []);
    await writeFile(path.join(config.metaDir, other, 'docs.json'), [ doc('other', 2) ]);
    await writeFile(path.join(config.metaDir, other, 'docs', 'other.json'), { ...doc('other', 2), body: 'Other cache' });
    const report = await start({ mode: 'build', repos: [ namespace ], options: { outputDir: directory, token: undefined } });
    assert.equal(report.summary.exported, 1);
    assert.ok(report.documents.every(item => item.namespace === namespace));
  });

  it('rejects invalid traversal targets before making any document request', async () => {
    await assert.rejects(run({}, [ '../book' ]), IncompleteExportError);
    assert.equal(requests.length, 0);
    assert.equal((await readReport()).summary.failed, 1);
  });

  it('reports a missing offline cache rather than claiming export success', async () => {
    await assert.rejects(start({ mode: 'build', repos: [ namespace ], options: { outputDir: directory } }), IncompleteExportError);
    assert.ok((await readReport()).summary.failed > 0);
  });

  it('source CLI help works without an environment token', async () => {
    const result = await execute(process.execPath, [ '--import', 'tsx', 'src/bin/cli.ts', '--help' ], { cwd: project, env: { ...process.env, YUQUE_TOKEN: '' } });
    assert.match(result.stdout, /export-report.json/);
    assert.ok(!result.stderr.includes('Missing yuque token'));
  });

  it('source CLI applies --token after imports and produces a nonempty export', async () => {
    extra = (_url, _response, request) => { assert.equal(request.headers['x-auth-token'], 'source-cli-test-token'); };
    const result = await execute(process.execPath, [ '--import', 'tsx', 'src/bin/cli.ts', namespace, '--host', host, '--token', 'source-cli-test-token', '--outputDir', directory, '--retries', '0' ], { cwd: project, env: { ...process.env, YUQUE_TOKEN: '' } });
    assert.ok(!result.stdout.includes('source-cli-test-token'));
    assert.ok(!result.stderr.includes('source-cli-test-token'));
    assert.equal((await readReport()).summary.exported, 1);
  });

  it('source CLI returns exit code 1 for a missing body and still writes the report', async () => {
    details.normal.body = '';
    try {
      await execute(process.execPath, [ '--import', 'tsx', 'src/bin/cli.ts', namespace, '--host', host, '--token', 'source-cli-test-token', '--outputDir', directory, '--retries', '0' ], { cwd: project, env: { ...process.env, YUQUE_TOKEN: '' } });
      assert.fail('CLI should fail');
    } catch (error: any) {
      assert.equal(error.code, 1);
      assert.ok(!error.stdout.includes('source-cli-test-token'));
      assert.ok(!error.stderr.includes('source-cli-test-token'));
    }
    assert.equal((await readReport()).summary.unsupported, 1);
  });

  it('compiled CLI help includes the copied help asset and needs no token', async () => {
    const result = await execute(process.execPath, [ 'dist/bin/cli.js', '--help' ], { cwd: project, env: { ...process.env, YUQUE_TOKEN: '' } });
    assert.match(result.stdout, /export-report.json/);
  });

  it('compiled CLI exports through the same initialized configuration path', async () => {
    const result = await execute(process.execPath, [ 'dist/bin/cli.js', namespace, '--host', host, '--token', 'compiled-cli-test-token', '--outputDir', directory, '--retries', '0' ], { cwd: project, env: { ...process.env, YUQUE_TOKEN: '' } });
    assert.ok(!result.stdout.includes('compiled-cli-test-token'));
    assert.equal((await readReport()).summary.exported, 1);
    assert.match(await text(itemFile(await readReport(), 'normal')), /Actual content/);
  });

  it('downloads reference-style images and rewrites their definitions', async () => {
    details.normal.body = `![image][picture]\n\n[picture]: ${host}/images/ref.png`;
    extra = (url, response) => {
      if (url.pathname === '/images/ref.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end('reference-image'); }
    };
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.match(content, /assets\/normal\/[a-f0-9]{16}-ref\.png/);
    assert.ok(!content.includes(host));
  });

  it('retains malformed encoded URLs without failing the document export', async () => {
    details.normal.body = `[bad](${host}/${namespace}/bad%zz)\n![image](${host}/image%zz.png)`;
    extra = (url, response) => {
      if (url.pathname === '/image%zz.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end('image'); }
    };
    const report = await run();
    assert.equal(report.summary.exported, 1);
    assert.ok(report.documents[0].warnings.includes('Malformed document URL retained.'));
  });

  it('uses the native TOC endpoint when toc_yml is absent', async () => {
    extra = (url, response) => {
      if (url.pathname === `/api/v2/repos/${namespace}`) json(response, { id: 1, type: 'Book', namespace, name: 'Book' });
      if (url.pathname === `/api/v2/repos/${namespace}/toc`) json(response, [ { id: 1, title: 'Native TOC title', depth: 1 } ]);
    };
    const report = await run();
    assert.equal(report.summary.exported, 1);
    assert.ok(itemFile(report, 'normal').includes('Native TOC title'));
    assert.ok(requests.some(url => url.endsWith('/toc')));
  });

  it('attaches orphan TOC nodes at the root instead of dropping their documents', async () => {
    toc = [ { type: 'DOC', uuid: 'normal', parent_uuid: 'missing-parent', url: 'normal', title: 'Orphan' } ];
    const report = await run();
    assert.equal(report.summary.exported, 1);
    assert.match(await text(itemFile(report, 'normal')), /Actual content/);
  });

  it('reports cyclic TOC cache rather than silently dropping nodes or hanging', async () => {
    toc = [
      { type: 'TITLE', uuid: 'a', parent_uuid: 'b', title: 'A' },
      { type: 'DOC', uuid: 'b', parent_uuid: 'a', title: 'B', url: 'normal' },
    ];
    await assert.rejects(run(), IncompleteExportError);
    const report = await readReport();
    assert.equal(report.summary.exported, 0);
    assert.ok(report.documents.some(item => item.message.includes('Cycle')));
  });

  it('skips attachments already on disk instead of re-downloading them every run', async () => {
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let downloads = 0;
    details.normal.body = `![image](${host}/images/reuse.png)`;
    extra = (url, response) => {
      if (url.pathname === '/images/reuse.png') {
        downloads++;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(image);
      }
    };
    const first = await run();
    const asset = (await exported()).find(file => file.endsWith('.png'))!;
    assert.equal(downloads, 1);
    const before = await fs.stat(asset);

    // The rewritten document and the asset both survive; nothing is fetched again.
    const second = await run({ clean: true });
    assert.equal(downloads, 1);
    assert.match(await text(itemFile(second, 'normal')), /assets\/normal\/[a-f0-9]{16}-reuse\.png/);
    assert.deepEqual(await fs.readFile(asset), image);
    assert.equal((await fs.stat(asset)).size, before.size);
  });

  it('re-downloads an attachment whose local copy was removed or truncated', async () => {
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let downloads = 0;
    details.normal.body = `![image](${host}/images/repair.png)`;
    extra = (url, response) => {
      if (url.pathname === '/images/repair.png') {
        downloads++;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(image);
      }
    };
    await run();
    const asset = (await exported()).find(file => file.endsWith('.png'))!;

    // A zero-byte file is not a complete copy, so the next run must replace it.
    await fs.writeFile(asset, '');
    await run({ clean: true });
    assert.equal(downloads, 2);
    assert.deepEqual(await fs.readFile(asset), image);
  });

  it('downloads an image that directly follows a self-contained HTML block', async () => {
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    // Yuque emits this shape when a published body contains an inline HTML widget
    // followed by an image with no blank line between them.
    details.normal.body = `<details class="lake-collapse"><summary><span class="ne-text">注意事项</span></summary></details>\n![]( ${host}/images/after-html.png)`.replace('![]( ', '![](');
    extra = (url, response) => {
      if (url.pathname === '/images/after-html.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(image);
      }
    };
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.match(content, /assets\/normal\/[a-f0-9]{16}-after-html\.png/);
    assert.ok(!content.includes(host));
    assert.deepEqual(await fs.readFile((await exported()).find(file => file.endsWith('.png'))!), image);
  });

  it('keeps a multi-line HTML block and the Markdown after it intact', async () => {
    details.normal.body = '<div class="note">\n第一行\n第二行\n</div>\n后续段落';
    const report = await run();
    const content = await text(itemFile(report, 'normal'));
    assert.ok(content.includes('第一行'));
    assert.ok(content.includes('第二行'));
    assert.ok(content.includes('后续段落'));
  });

  it('keeps old assets and cleans a partial temporary download after socket interruption', async () => {
    const target = path.join(directory, 'kept.png');
    await fs.writeFile(target, 'old asset');
    extra = (url, response) => {
      if (url.pathname !== '/truncated.png') return;
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '100' });
      response.write('partial');
      setTimeout(() => response.destroy(), 5);
    };
    config.retries = 0;
    await assert.rejects(download(host + '/truncated.png', target, { image: true }));
    assert.equal(await fs.readFile(target, 'utf8'), 'old asset');
    assert.ok(!(await fs.readdir(directory)).some(file => file.endsWith('.tmp')));
  });
});
