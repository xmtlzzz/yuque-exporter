import assert from 'assert/strict';
import { createHash } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { createTransport, drain, type HttpTransport } from './http.js';

export interface User {
  id: number;
  type: string;
  login: string;
  name: string;
  description: string;
  avatar_url: string;
  books_count: number;
  public_books_count: number;
  followers_count: number;
  following_count: number;
  public: number;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  type: string;
  namespace: string;
  slug: string;
  name: string;
  description: string;
  creator_id: number;
  public: number;
  items_count: number;
  likes_count: number;
  watches_count: number;
  content_updated_at: Date;
  updated_at: Date;
  created_at: Date;
  user_id: number;
  user: User;
}

export interface RepoDetail extends Repo {
  toc?: string | null;
  toc_yml?: string | null;
}

export interface Doc {
  id: number;
  slug: string;
  title: string;
  description: string;
  user_id: number;
  book_id: number;
  format: string;
  public: number;
  status: number;
  view_status: number;
  read_status: number;
  likes_count: number;
  read_count: number;
  comments_count: number;
  content_updated_at: string;
  created_at: string;
  updated_at: string;
  published_at: string;
  first_published_at: string;
  draft_version: number;
  last_editor_id: number;
  word_count: number;
  cover?: any;
  custom_description?: any;
  last_editor: User;
  book: Repo;
}

export interface DocDetail extends Doc {
  type?: string | null;
  body?: string | null;
  body_draft?: string | null;
  body_html?: string | null;
  body_lake?: string | null;
  body_draft_lake?: string | null;
  body_sheet?: string | null;
  body_table?: string | null;
  exporter_markdown?: string;
  /** The original table page bodies, retained alongside the merged records. */
  exporter_table_pages?: string[];
}

export interface TocItem {
  uuid?: string;
  type?: string;
  title?: string;
  url?: string;
  slug?: string;
  id?: number;
  doc_id?: number;
  level?: number;
  depth?: number;
  parent_uuid?: string;
  prev_uuid?: string;
  sibling_uuid?: string;
  child_uuid?: string;
}

export interface SDKOptions {
  token: string;
  host?: string;
  userAgent?: string;
  /** Additional attempts after the initial read; defaults to 3, maximum 10. */
  retries?: number;
  /** Initial exponential retry delay in milliseconds; defaults to 500. */
  retryDelay?: number;
  /** Overall timeout for each attempt in milliseconds; defaults to 30000. */
  timeout?: number;
}

export interface ResponseData<T> {
  data?: T;
  message?: string;
  code?: number;
}

export class SDKRequestError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly attempts: number,
    reason: string,
    public readonly statusCode?: number,
    public readonly code?: string,
  ) {
    super(`Yuque GET ${endpoint} failed (${reason}; attempts: ${attempts})`);
    this.name = 'SDKRequestError';
  }
}

interface TablePage {
  records: unknown[];
  totalCount: number;
  pageSize: number;
  page: number;
  [key: string]: unknown;
}

// fetch reports transport failures as a generic "fetch failed" with a nested
// cause, and a dropped connection surfaces as a TypeError rather than a socket
// error code. Map those back onto the codes the retry policy understands.
function transportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  const name = (error as { name?: string }).name;
  if (name === 'AbortError') return 'ETIMEDOUT';
  // A socket destroyed mid-request shows up as a plain TypeError under fetch.
  if (name === 'TypeError') return 'ECONNRESET';
  return undefined;
}

const PAGE_SIZE = 100;
const MAX_RETRY_DELAY = 60_000;
const RETRY_STATUSES = new Set([ 429, 502, 503, 504 ]);
const RETRY_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function retryAfterMillis(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

// Page comparisons must not depend on object-key order or retain duplicate bodies.
function pageFingerprint(records: unknown[]): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([ a ], [ b ]) => a.localeCompare(b))
        .map(([ key, entry ]) => [ key, sortKeys(entry) ]));
    }
    return value;
  };
  const entries = records.map(record => JSON.stringify(sortKeys(record))).sort();
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export class SDK {
  private token: string;
  private host: string;
  private userAgent: string;
  private retries: number;
  private retryDelay: number;
  private timeout: number;
  private transport: HttpTransport;
  private closePromise?: Promise<void>;

  constructor(opts: SDKOptions) {
    this.token = opts.token;
    this.host = opts.host || 'https://www.yuque.com';
    this.userAgent = opts.userAgent || 'yuque-sdk';
    assert(this.token, 'Missing yuque token, see https://www.yuque.com/yuque/developer/api for more detail.');
    this.retries = opts.retries ?? 3;
    this.retryDelay = opts.retryDelay ?? 500;
    this.timeout = opts.timeout ?? 30_000;
    assert(Number.isInteger(this.retries) && this.retries >= 0 && this.retries <= 10,
      'retries must be an integer between 0 and 10');
    assert(Number.isFinite(this.retryDelay) && this.retryDelay >= 0 && this.retryDelay <= MAX_RETRY_DELAY,
      'retryDelay must be between 0 and 60000 milliseconds');
    assert(Number.isInteger(this.timeout) && this.timeout > 0 && this.timeout <= 2_147_483_647,
      'timeout must be a positive integer no greater than 2147483647 milliseconds');
    // One transport for the whole client; it works under both Node and Bun.
    this.transport = createTransport();
  }

  async close(): Promise<void> {
    this.closePromise ??= this.transport.close();
    await this.closePromise;
  }

  async getUser(user = '') {
    const api = user ? `users/${encodeURIComponent(user)}` : 'user';
    return await this.requestAPI<User>(api);
  }

  async getRepos(user: string) {
    return await this.requestAll<Repo>(`users/${encodeURIComponent(user)}/repos`);
  }

  async getRepoDetail(namespace: string) {
    return await this.requestAPI<RepoDetail>(`repos/${encodePath(namespace)}`);
  }

  async getToc(namespace: string): Promise<TocItem[]> {
    const api = `repos/${encodePath(namespace)}/toc`;
    const toc = await this.requestAPI<TocItem[]>(api);
    if (!Array.isArray(toc)) throw this.invalidResponse(api, 'expected a directory array');
    return toc;
  }

  async getDocs(namespace: string) {
    return await this.requestAll<Doc>(`repos/${encodePath(namespace)}/docs`);
  }

  async getDocDetail(namespace: string, slug: string) {
    const api = `repos/${encodePath(namespace)}/docs/${encodeURIComponent(slug)}`;
    const first = await this.requestAPI<DocDetail>(`${api}?page=1&page_size=${PAGE_SIZE}`);
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      throw this.invalidResponse(api, 'expected a document object');
    }
    if (first.body_table == null || first.body_table === '') return first;
    if (typeof first.body_table !== 'string') throw this.invalidResponse(api, 'expected a table JSON string');
    if (first.body_table.trim() === '') return first;

    const table = this.parseTablePage(first.body_table, api, 1);
    const records = [ ...table.records ];
    const pages = [ first.body_table ];
    const fingerprints = new Set([ pageFingerprint(table.records) ]);
    const recordIds = new Set<string>();
    this.checkRecordIds(table.records, recordIds, api, 1);
    for (let page = 2; records.length < table.totalCount; page++) {
      const next = await this.requestAPI<DocDetail>(`${api}?page=${page}&page_size=${table.pageSize}`);
      if (!next || next.id !== first.id || typeof next.body_table !== 'string') {
        throw this.invalidResponse(api, `missing or mismatched table document at page ${page}`);
      }
      if (first.content_updated_at && next.content_updated_at !== first.content_updated_at) {
        throw this.invalidResponse(api, `table changed while reading page ${page}`);
      }
      const nextTable = this.parseTablePage(next.body_table, api, page);
      if (nextTable.totalCount !== table.totalCount || nextTable.pageSize !== table.pageSize) {
        throw this.invalidResponse(api, `table pagination metadata changed at page ${page}`);
      }
      const fingerprint = pageFingerprint(nextTable.records);
      if (fingerprints.has(fingerprint)) {
        throw this.invalidResponse(api, `repeated table records at page ${page}`);
      }
      fingerprints.add(fingerprint);
      this.checkRecordIds(nextTable.records, recordIds, api, page);
      records.push(...nextTable.records);
      pages.push(next.body_table);
    }
    return {
      ...first,
      body_table: JSON.stringify({ ...table, records }),
      exporter_table_pages: pages,
    };
  }

  async getYmdDoc(docId: number): Promise<string> {
    assert(Number.isSafeInteger(docId) && docId > 0, 'docId must be a positive integer');
    const api = `yfm/docs?doc_id=${docId}`;
    const data = await this.requestAPI<{ yfm?: string | null }>(api);
    if (typeof data.yfm !== 'string') throw this.invalidResponse(api, 'missing YFM text');
    return data.yfm;
  }

  async request<T>(api: string): Promise<ResponseData<T>> {
    const url = new URL(`/api/v2/${api}`, this.host);
    const endpoint = this.endpoint(api);
    if (this.closePromise) throw new SDKRequestError(endpoint, 0, 'SDK is closed');

    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let statusCode: number | undefined;
      let retryAfter: number | undefined;
      let failure: SDKRequestError;
      let retryable = false;
      try {
        const response = await this.transport.request(url, {
          method: 'GET',
          headers: { 'X-Auth-Token': this.token, 'User-Agent': this.userAgent },
          timeout: this.timeout,
          maxRedirections: 5,
          signal: controller.signal,
        });
        statusCode = response.statusCode;
        if (statusCode !== 200) {
          retryAfter = retryAfterMillis(response.headers['retry-after']);
          // Never parse or log an error body: it may contain private content.
          await drain(response);
          throw new SDKRequestError(endpoint, attempt, `HTTP ${statusCode}`, statusCode);
        }
        const json = await response.json<ResponseData<T>>();
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          throw new SDKRequestError(endpoint, attempt, 'invalid response envelope', statusCode);
        }
        return json;
      } catch (error) {
        if (error instanceof SDKRequestError) {
          failure = error;
          retryable = RETRY_STATUSES.has(error.statusCode ?? 0);
        } else {
          const code = controller.signal.aborted ? 'ETIMEDOUT' : transportErrorCode(error);
          const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : undefined;
          const reason = safeCode ?? (error instanceof SyntaxError ? 'invalid JSON response' : 'request error');
          failure = new SDKRequestError(endpoint, attempt, reason, statusCode, safeCode);
          retryable = !!safeCode && RETRY_CODES.has(safeCode);
        }
      } finally {
        clearTimeout(timer);
      }
      // A long Retry-After is surfaced instead of retrying earlier than requested.
      if (!retryable || attempt > this.retries || (retryAfter ?? 0) > MAX_RETRY_DELAY) throw failure;
      await delay(Math.max(retryAfter ?? 0, Math.min(MAX_RETRY_DELAY, this.retryDelay * 2 ** (attempt - 1))));
    }
    throw new SDKRequestError(endpoint, 0, 'request attempts exhausted');
  }

  async requestAPI<T>(api: string): Promise<T> {
    const response = await this.request<T>(api);
    if (response.data == null) throw this.invalidResponse(api, 'missing response data');
    return response.data;
  }

  private endpoint(api: string): string {
    const url = new URL(`/api/v2/${api}`, this.host);
    // Keep identifiers and pagination useful for diagnosis, excluding arbitrary
    // query parameters and URL credentials from public errors.
    const query = new URLSearchParams();
    for (const key of [ 'offset', 'limit', 'page', 'page_size', 'doc_id' ]) {
      const value = url.searchParams.get(key);
      if (value !== null && /^\d+$/.test(value)) query.set(key, value);
    }
    return `${url.origin}${url.pathname}${query.size ? `?${query}` : ''}`;
  }

  private invalidResponse(api: string, reason: string): SDKRequestError {
    return new SDKRequestError(this.endpoint(api), 1, reason);
  }

  private async requestAll<T extends { id: number }>(api: string): Promise<T[]> {
    const all: T[] = [];
    const ids = new Set<number>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const pageApi = `${api}?offset=${offset}&limit=${PAGE_SIZE}`;
      const page = await this.requestAPI<T[]>(pageApi);
      if (!Array.isArray(page) || page.length > PAGE_SIZE) {
        throw this.invalidResponse(pageApi, 'invalid list page');
      }
      for (const item of page) {
        if (!item || !Number.isSafeInteger(item.id) || ids.has(item.id)) {
          throw this.invalidResponse(pageApi, 'missing or repeated list item ID');
        }
        ids.add(item.id);
      }
      all.push(...page);
      if (page.length < PAGE_SIZE) return all;
    }
  }

  private parseTablePage(body: string, api: string, expectedPage: number): TablePage {
    let table: TablePage;
    try {
      table = JSON.parse(body) as TablePage;
    } catch {
      throw this.invalidResponse(api, `invalid table JSON at page ${expectedPage}`);
    }
    if (!table || !Array.isArray(table.records) || !Number.isSafeInteger(table.totalCount)
      || table.totalCount < 0 || !Number.isInteger(table.pageSize) || table.pageSize < 1
      || table.pageSize > 200 || table.page !== expectedPage) {
      throw this.invalidResponse(api, `invalid table pagination metadata at page ${expectedPage}`);
    }
    const expectedCount = Math.min(table.pageSize, Math.max(0, table.totalCount - (expectedPage - 1) * table.pageSize));
    if (table.records.length !== expectedCount) {
      throw this.invalidResponse(api, `truncated table page ${expectedPage}: expected ${expectedCount} records, received ${table.records.length}`);
    }
    return table;
  }

  private checkRecordIds(records: unknown[], ids: Set<string>, api: string, page: number) {
    for (const record of records) {
      const id = record && typeof record === 'object' ? (record as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const key = `${typeof id}:${id}`;
      if (ids.has(key)) throw this.invalidResponse(api, `repeated table record ID at page ${page}`);
      ids.add(key);
    }
  }
}
