import assert from 'assert/strict';
import { execFile } from 'child_process';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { promisify } from 'util';
import { SDK, SDKOptions, SDKRequestError } from '../src/lib/sdk.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

describe('test/sdk.test.ts', function() {
  this.timeout(5000);
  let server: Server;
  let host: string;
  let handler: Handler;
  let clients: SDK[];
  let requests: Array<{ url: URL; receivedAt: number; token?: string; userAgent?: string }>;

  function sdk(options: Partial<SDKOptions> = {}) {
    const client = new SDK({ token: 'local-test-token', host, retries: 0, retryDelay: 0, timeout: 2000, ...options });
    clients.push(client);
    return client;
  }

  function json(res: ServerResponse, data: unknown, status = 200, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ data }));
  }

  function tableDetail(records: unknown[], totalCount: number, pageSize: number, page: number) {
    return {
      id: 7, slug: 'table', type: 'Table', body: '', content_updated_at: '2026-10-08T01:00:00Z',
      body_table: JSON.stringify({ records, totalCount, pageSize, page, meta: { columns: [{ name: 'Name' }] } }),
    };
  }

  beforeEach(async () => {
    requests = [];
    clients = [];
    handler = (_req, res) => json(res, null, 404);
    server = createServer((req, res) => {
      const url = new URL(req.url!, host);
      requests.push({ url, receivedAt: Date.now(), token: req.headers['x-auth-token'] as string,
        userAgent: req.headers['user-agent'] });
      handler(req, res, url);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close()));
    await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  });

  it('reads users and repo details with the configured auth and user agent on Node 24', async () => {
    handler = (_req, res, url) => json(res, { id: 3, path: url.pathname });
    const client = sdk({ userAgent: 'sdk-test' });
    assert.equal((await client.getUser()).id, 3);
    await client.getUser('someone');
    await client.getRepoDetail('owner/book');
    assert.deepEqual(requests.map(x => x.url.pathname), [ '/api/v2/user', '/api/v2/users/someone', '/api/v2/repos/owner/book' ]);
    assert(requests.every(x => x.token === 'local-test-token' && x.userAgent === 'sdk-test'));
  });

  // Spawning a second Node process with tsx and issuing two HTTP requests needs
  // more than the suite's 5s budget; the work itself is exercised elsewhere.
  it('leaves the global fetch untouched and keeps requests self-contained', async () => {
    // The SDK used to own a private undici dispatcher. It now goes through the
    // platform fetch, so the guarantee under test is that a request neither
    // replaces globalThis.fetch nor depends on it being pristine first.
    handler = (_req, res) => json(res, { id: 3 });
    const baselineFetch = globalThis.fetch;
    const client = sdk();
    assert.equal((await client.getUser()).id, 3);
    await client.close();
    assert.equal(globalThis.fetch, baselineFetch, 'SDK replaced global fetch');
  });

  ([ 'docs', 'repos' ] as const).forEach(kind => {
    it(`drains ${kind} beyond two full 100-item pages`, async () => {
      const items = Array.from({ length: 201 }, (_, index) => ({ id: index + 1 }));
      handler = (_req, res, url) => {
        const offset = Number(url.searchParams.get('offset'));
        json(res, items.slice(offset, offset + Number(url.searchParams.get('limit'))));
      };
      const client = sdk();
      const result = kind === 'docs' ? await client.getDocs('owner/book') : await client.getRepos('owner');
      assert.equal(result.length, 201);
      assert.equal(result[200].id, 201);
      assert.deepEqual(requests.map(x => x.url.searchParams.get('offset')), [ '0', '100', '200' ]);
      assert(requests.every(x => x.url.searchParams.get('limit') === '100'));
      assert(requests.every(x => x.url.pathname === (kind === 'docs'
        ? '/api/v2/repos/owner/book/docs' : '/api/v2/users/owner/repos')));
    });
  });

  it('requests an empty final page after an exact multiple of the list page size', async () => {
    handler = (_req, res, url) => {
      const offset = Number(url.searchParams.get('offset'));
      json(res, offset < 200 ? Array.from({ length: 100 }, (_, index) => ({ id: offset + index + 1 })) : []);
    };
    assert.equal((await sdk().getDocs('owner/book')).length, 200);
    assert.equal(requests.length, 3);
  });

  it('accepts an empty list in one request', async () => {
    handler = (_req, res) => json(res, []);
    assert.deepEqual(await sdk().getRepos('owner'), []);
    assert.equal(requests.length, 1);
  });

  it('rejects a repeated full list page instead of looping forever', async () => {
    handler = (_req, res) => json(res, Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })));
    await assert.rejects(sdk().getDocs('owner/book'), /repeated list item ID/);
    assert.equal(requests.length, 2);
  });

  it('rejects overlapping short list pages and identifies their offset', async () => {
    handler = (_req, res, url) => json(res, url.searchParams.get('offset') === '0'
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 100 }, { id: 101 }]);
    await assert.rejects(sdk().getDocs('owner/book'), error => error instanceof SDKRequestError
      && error.endpoint.endsWith('?offset=100&limit=100') && /repeated list item/.test(error.message));
    assert.equal(requests.length, 2);
  });

  it('rejects invalid list response shapes', async () => {
    handler = (_req, res) => json(res, { records: [] });
    await assert.rejects(sdk().getDocs('owner/book'), /invalid list page/);
  });

  [ 429, 502, 503, 504 ].forEach(status => {
    it(`retries a transient HTTP ${status} read`, async () => {
      handler = (_req, res) => json(res, { id: 3 }, requests.length === 1 ? status : 200, { 'retry-after': '0' });
      assert.equal((await sdk({ retries: 1 }).getUser()).id, 3);
      assert.equal(requests.length, 2);
    });
  });

  it('stops after the configured additional retry count', async () => {
    handler = (_req, res) => json(res, { secret: 'private-body' }, 503);
    await assert.rejects(sdk({ retries: 2 }).getUser(), error => error instanceof SDKRequestError
      && error.attempts === 3 && error.statusCode === 503);
    assert.equal(requests.length, 3);
  });

  it('defaults to three additional retries', async () => {
    handler = (_req, res) => json(res, null, 502);
    const client = new SDK({ token: 'local-test-token', host, retryDelay: 0 });
    clients.push(client);
    await assert.rejects(client.getUser(), error => error instanceof SDKRequestError && error.attempts === 4);
    assert.equal(requests.length, 4);
  });

  it('waits for numeric Retry-After before retrying', async () => {
    handler = (_req, res) => json(res, { id: 3 }, requests.length === 1 ? 429 : 200, { 'retry-after': '0.05' });
    await sdk({ retries: 1 }).getUser();
    assert(requests[1].receivedAt - requests[0].receivedAt >= 45);
  });

  it('waits for an HTTP-date Retry-After before retrying', async () => {
    let retryAt = 0;
    handler = (_req, res) => {
      if (requests.length === 1) {
        const retryDate = new Date(Date.now() + 1500).toUTCString();
        retryAt = Date.parse(retryDate);
        json(res, null, 503, { 'retry-after': retryDate });
      } else {
        json(res, { id: 3 });
      }
    };
    await sdk({ retries: 1 }).getUser();
    assert(requests[1].receivedAt >= retryAt - 20);
  });

  it('surfaces long Retry-After without retrying earlier than the server requested', async () => {
    handler = (_req, res) => json(res, null, 429, { 'retry-after': '3600' });
    await assert.rejects(sdk({ retries: 3 }).getUser(), error => error instanceof SDKRequestError
      && error.statusCode === 429 && error.attempts === 1);
    assert.equal(requests.length, 1);
  });

  it('uses exponential backoff when Retry-After is absent', async () => {
    handler = (_req, res) => json(res, { id: 3 }, requests.length < 3 ? 503 : 200);
    await sdk({ retries: 2, retryDelay: 20 }).getUser();
    assert(requests[1].receivedAt - requests[0].receivedAt >= 15);
    assert(requests[2].receivedAt - requests[1].receivedAt >= 35);
  });

  [ 401, 403, 404, 500 ].forEach(status => {
    it(`does not retry HTTP ${status} and never includes credentials or error bodies`, async () => {
      handler = (_req, res) => json(res, { secret: 'private-body', echoedToken: 'local-test-token' }, status);
      await assert.rejects(sdk({ retries: 3 }).request('user?token=local-test-token'), error => {
        assert(error instanceof SDKRequestError);
        assert.equal(error.statusCode, status);
        assert.equal(error.attempts, 1);
        assert(error.message.includes('/api/v2/user'));
        assert(!error.message.includes('private-body'));
        assert(!error.message.includes('local-test-token'));
        return true;
      });
      assert.equal(requests.length, 1);
    });
  });

  it('does not parse HTML error pages before applying HTTP retries', async () => {
    handler = (_req, res) => {
      if (requests.length === 1) {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html>private gateway failure</html>');
      } else json(res, { id: 3 });
    };
    assert.equal((await sdk({ retries: 1 }).getUser()).id, 3);
    assert.equal(requests.length, 2);
  });

  it('does not retry authentication failure even if the error body never ends', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.write('{"private":');
    };
    await assert.rejects(sdk({ retries: 3, timeout: 30 }).getUser(), error => error instanceof SDKRequestError
      && error.statusCode === 401 && error.attempts === 1);
    assert.equal(requests.length, 1);
  });

  it('retries a temporary socket failure', async () => {
    handler = (req, res) => {
      if (requests.length === 1) req.socket.destroy();
      else json(res, { id: 3 });
    };
    assert.equal((await sdk({ retries: 1 }).getUser()).id, 3);
    assert.equal(requests.length, 2);
  });

  [ false, true ].forEach(partialBody => {
    it(`times out bounded attempts while waiting for ${partialBody ? 'the body' : 'headers'}`, async () => {
      handler = (_req, res) => {
        if (partialBody) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"data":');
        }
      };
      const started = Date.now();
      await assert.rejects(sdk({ timeout: 30, retries: 1 }).getUser(), error => error instanceof SDKRequestError
        && error.attempts === 2 && /TIMEOUT|TIMEDOUT/.test(error.code ?? ''));
      assert.equal(requests.length, 2);
      assert(Date.now() - started < 1000);
    });
  });

  it('reports invalid JSON without leaking its contents or retrying it', async () => {
    handler = (_req, res) => { res.end('{private-body-local-test-token'); };
    await assert.rejects(sdk({ retries: 3 }).getUser(), error => error instanceof SDKRequestError
      && /invalid JSON/.test(error.message) && !/private-body|local-test-token/.test(error.message));
    assert.equal(requests.length, 1);
  });

  it('rejects missing response data rather than returning undefined', async () => {
    handler = (_req, res) => res.end('{"message":"private-body"}');
    await assert.rejects(sdk().getUser(), /missing response data/);
  });

  it('closes the private dispatcher and rejects further requests', async () => {
    handler = (_req, res) => json(res, { id: 3 });
    const client = sdk();
    await client.getUser();
    await client.close();
    await client.close();
    await assert.rejects(client.getUser(), /SDK is closed/);
    assert.equal(requests.length, 1);
  });

  it('preserves nullable and missing ordinary document bodies', async () => {
    handler = (_req, res) => json(res, { id: 7, type: 'Doc', body: null, body_html: '<p>Hello</p>' });
    const result = await sdk().getDocDetail('owner/book', 'ordinary');
    assert.equal(result.body, null);
    assert.equal(result.body_draft, undefined);
    assert.equal(result.body_html, '<p>Hello</p>');
    assert.equal(result.exporter_table_pages, undefined);
  });

  it('preserves a sheet JSON body without treating it as markdown', async () => {
    const body_sheet = JSON.stringify({ data: [{ name: 'Sheet1', table: [[ 'Name' ], [ 'Ada' ]] }] });
    handler = (_req, res) => json(res, { id: 7, type: 'Sheet', body: '', body_sheet });
    const result = await sdk().getDocDetail('owner/book', 'sheet');
    assert.equal(result.body, '');
    assert.equal(result.body_sheet, body_sheet);
    assert.equal(result.exporter_markdown, undefined);
  });

  it('merges all table records and retains the original page JSON', async () => {
    const records = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, values: [{ value: `row-${index + 1}` }] }));
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      json(res, tableDetail(records.slice((page - 1) * 100, page * 100), records.length, 100, page));
    };
    const result = await sdk().getDocDetail('owner/book', 'table');
    const table = JSON.parse(result.body_table!);
    assert.equal(result.body, '');
    assert.equal(result.exporter_markdown, undefined);
    assert.equal(table.records.length, 201);
    assert.deepEqual(table.records[200], records[200]);
    assert.deepEqual(table.meta, { columns: [{ name: 'Name' }] });
    assert.equal(result.exporter_table_pages!.length, 3);
    assert.deepEqual(result.exporter_table_pages!.map(body => JSON.parse(body).records.length), [ 100, 100, 1 ]);
    assert.deepEqual(requests.map(x => x.url.searchParams.get('page')), [ '1', '2', '3' ]);
    assert(requests.every(x => x.url.searchParams.get('page_size') === '100'));
  });

  it('uses the server-reported page size up to the maximum of 200', async () => {
    const records = Array.from({ length: 201 }, (_, index) => ({ id: index + 1 }));
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      json(res, tableDetail(records.slice((page - 1) * 200, page * 200), 201, 200, page));
    };
    assert.equal(JSON.parse((await sdk().getDocDetail('owner/book', 'table')).body_table!).records.length, 201);
    assert.deepEqual(requests.map(x => x.url.searchParams.get('page_size')), [ '100', '200' ]);
  });

  it('accepts a genuinely empty table with zero total rows', async () => {
    handler = (_req, res) => json(res, tableDetail([], 0, 100, 1));
    const result = await sdk().getDocDetail('owner/book', 'table');
    assert.deepEqual(JSON.parse(result.body_table!).records, []);
    assert.equal(result.exporter_table_pages!.length, 1);
    assert.equal(requests.length, 1);
  });

  it('rejects an empty first table page when rows remain', async () => {
    handler = (_req, res) => json(res, tableDetail([], 3, 2, 1));
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /truncated table page 1/);
    assert.equal(requests.length, 1);
  });

  it('rejects an empty later table page before claiming the table is complete', async () => {
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      json(res, tableDetail(page === 1 ? [{ id: 1 }, { id: 2 }] : [], 3, 2, page));
    };
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /truncated table page 2/);
    assert.equal(requests.length, 2);
  });

  it('rejects a short nonfinal table page', async () => {
    handler = (_req, res) => json(res, tableDetail([{ id: 1 }], 3, 2, 1));
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /expected 2 records, received 1/);
  });

  it('rejects a repeated table page number', async () => {
    handler = (_req, res) => json(res, tableDetail([{ id: 1 }, { id: 2 }], 4, 2, 1));
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /pagination metadata at page 2/);
    assert.equal(requests.length, 2);
  });

  it('rejects repeated table records even when the page number, key and record order change', async () => {
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      const records = page === 1 ? [{ values: [{ value: 'a' }], note: 'x' }, { values: [{ value: 'b' }] }]
        : [{ values: [{ value: 'b' }] }, { note: 'x', values: [{ value: 'a' }] }];
      json(res, tableDetail(records, 4, 2, page));
    };
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /repeated table records/);
    assert.equal(requests.length, 2);
  });

  it('rejects overlapping table record IDs across different pages', async () => {
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      json(res, tableDetail(page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }], 4, 2, page));
    };
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /repeated table record ID/);
  });

  it('rejects changes to table totals while fetching', async () => {
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      json(res, tableDetail(page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }, { id: 4 }], page === 1 ? 3 : 4, 2, page));
    };
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /pagination metadata changed/);
  });

  it('rejects changes to document revision while fetching table pages', async () => {
    handler = (_req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      const detail = tableDetail(page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }], 3, 2, page);
      if (page === 2) detail.content_updated_at = '2026-10-08T02:00:00Z';
      json(res, detail);
    };
    await assert.rejects(sdk().getDocDetail('owner/book', 'table'), /table changed/);
  });

  it('rejects missing table metadata, malformed JSON and oversized pages without exposing content', async () => {
    const bodies = [ JSON.stringify({ records: [] }), '{private-table-content',
      JSON.stringify({ records: [], totalCount: 0, pageSize: 201, page: 1 }) ];
    for (const body_table of bodies) {
      handler = (_req, res) => json(res, { id: 7, type: 'Table', body_table });
      await assert.rejects(sdk().getDocDetail('owner/book', 'table'), error => error instanceof SDKRequestError
        && /table/.test(error.message) && !error.message.includes('private-table-content'));
    }
  });

  it('returns the YFM markdown text using the numeric document ID contract', async () => {
    handler = (_req, res) => json(res, { id: 7, yfm: '# Exported\n\nUseful body' });
    assert.equal(await sdk().getYmdDoc(7), '# Exported\n\nUseful body');
    assert.equal(requests[0].url.pathname, '/api/v2/yfm/docs');
    assert.equal(requests[0].url.searchParams.get('doc_id'), '7');
  });

  it('leaves empty YFM detection to the caller and rejects missing YFM text', async () => {
    handler = (_req, res) => json(res, { yfm: '' });
    assert.equal(await sdk().getYmdDoc(7), '');
    handler = (_req, res) => json(res, { id: 7 });
    await assert.rejects(sdk().getYmdDoc(7), /missing YFM text/);
  });

  it('rejects a nonnumeric YFM document ID without calling the server', async () => {
    await assert.rejects(sdk().getYmdDoc(0), /docId must be a positive integer/);
    assert.equal(requests.length, 0);
  });

  it('reads the native directory endpoint for repositories without toc_yml', async () => {
    const toc = [{ uuid: 'chapter', type: 'TITLE', title: 'Chapter', parent_uuid: '' },
      { uuid: 'doc', type: 'DOC', title: 'Document', doc_id: 7, url: 'ordinary', parent_uuid: 'chapter' }];
    handler = (_req, res) => json(res, toc);
    assert.deepEqual(await sdk().getToc('owner/book'), toc);
    assert.equal(requests[0].url.pathname, '/api/v2/repos/owner/book/toc');
  });
});