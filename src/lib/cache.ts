import path from 'path';
import { createHash } from 'crypto';
import type { Doc, DocDetail } from './sdk.js';
import { config } from '../config.js';
import { readJSON } from './utils.js';
import { resolveContent } from './content.js';

export interface CacheEntry {
  slug: string;
  fingerprint: string;
  contentHash: string;
  fetchedAt: string;
}

export interface CacheManifest {
  schemaVersion: 2;
  documents: Record<string, CacheEntry>;
}

export function validateNamespace(namespace: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(namespace) || namespace.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid repository namespace; expected owner/book');
  }
  return namespace;
}

export function documentPath(namespace: string, slug: string) {
  validateNamespace(namespace);
  if (typeof slug !== 'string' || !slug) throw new Error('Document slug is missing');
  return path.join(config.metaDir, namespace, 'docs', `doc-${encodeURIComponent(slug)}.json`);
}

export function manifestPath(namespace: string) {
  return path.join(config.metaDir, validateNamespace(namespace), 'cache-manifest.json');
}

export function documentFingerprint(doc: Partial<Doc>) {
  const keys = [ 'id', 'slug', 'content_updated_at', 'updated_at', 'published_at', 'draft_version', 'status', 'format', 'type' ];
  return contentHash(Object.fromEntries(keys.map(key => [ key, doc[key] ?? null ])));
}

export function contentHash(content: unknown) {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export async function readManifest(namespace: string): Promise<CacheManifest> {
  try {
    const manifest = await readJSON(manifestPath(namespace));
    if (manifest.schemaVersion === 2 && manifest.documents && typeof manifest.documents === 'object') return manifest;
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return { schemaVersion: 2, documents: {} };
}

export async function readCachedDetail(namespace: string, slug: string): Promise<DocDetail> {
  let detail: DocDetail;
  try {
    detail = await readJSON(documentPath(namespace, slug));
  } catch (err) {
    // Old caches remain readable offline. Their publication-only manifest is not trusted.
    if (err.code !== 'ENOENT' || !/^[\w.-]+$/.test(slug) || slug === '.' || slug === '..') throw err;
    detail = await readJSON(path.join(config.metaDir, namespace, 'docs', `${slug}.json`));
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('Invalid document cache');
  return detail;
}

export async function isCacheReusable(namespace: string, doc: Doc, entry?: CacheEntry) {
  if (!entry || entry.slug !== doc.slug || entry.fingerprint !== documentFingerprint(doc)) return false;
  try {
    const detail = await readCachedDetail(namespace, doc.slug);
    if (contentHash(detail) !== entry.contentHash) return false;
    const resolved = resolveContent(detail);
    return resolved.status === 'ready' || (resolved.status === 'empty' && detail.word_count === 0);
  } catch {
    return false;
  }
}
