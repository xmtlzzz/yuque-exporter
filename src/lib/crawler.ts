import path from 'path';
import PQueue from 'p-queue';
import yaml from 'yaml';

import { SDK } from './sdk.js';
import type { Doc, DocDetail, TocItem } from './sdk.js';
import { logger, writeFile, errorMessage } from './utils.js';
import { config } from '../config.js';
import { contentHash, documentFingerprint, documentPath, isCacheReusable, manifestPath, readManifest, validateNamespace } from './cache.js';
import { resolveContent } from './content.js';
import { emitProgress } from './progress.js';
import type { CrawlResult } from './report.js';

export async function crawl(inputs?: string[]): Promise<CrawlResult> {
  logger.info('Start crawling...');
  const sdk = new SDK(config);
  const result: CrawlResult = { repos: [], downloaded: 0, cached: 0, failures: [] };
  const namespaces = new Set<string>();
  try {
    // No targets means all Book repositories visible to the authenticated user.
    for (const input of inputs?.length ? inputs : [ '' ]) {
      try {
        const parts = input.split('/');
        if (parts.length > 2) throw new Error('Use owner/book or an owner login');
        if (parts.length === 2) {
          namespaces.add(validateNamespace(input));
        } else {
          const user = await sdk.getUser(input);
          if (!/^[\w.-]+$/.test(user.login) || [ '.', '..' ].includes(user.login)) throw new Error('Invalid owner login');
          const repos = await sdk.getRepos(user.login);
          await writeFile(path.join(config.metaDir, user.login, 'user.json'), user);
          await writeFile(path.join(config.metaDir, user.login, 'repos.json'), repos);
          for (const repo of repos) {
            if (repo.type === 'Book') namespaces.add(validateNamespace(repo.namespace));
          }
        }
      } catch (error) {
        result.failures.push({ namespace: input, message: errorMessage(error) });
      }
    }
    result.repos = [ ...namespaces ];
    emitProgress({ type: 'phase', phase: 'crawl', message: `${namespaces.size} repository(ies)` });
    for (const namespace of namespaces) {
      try {
        emitProgress({ type: 'repo', namespace, total: namespaces.size });
        await crawlRepo(namespace, sdk, result);
      } catch (error) {
        result.failures.push({ namespace, message: errorMessage(error) });
        logger.error(`Crawl failed for ${namespace}: ${errorMessage(error)}`);
      }
    }
    return result;
  } finally {
    await sdk.close();
  }
}

export async function crawlRepo(namespace: string, suppliedSDK?: SDK, suppliedResult?: CrawlResult) {
  validateNamespace(namespace);
  const sdk = suppliedSDK || new SDK(config);
  const result = suppliedResult || { repos: [ namespace ], downloaded: 0, cached: 0, failures: [] };
  try {
    logger.info(`Crawling ${namespace}`);
    const repo = await sdk.getRepoDetail(namespace);
    if (repo.type !== 'Book') throw new Error('Only Book repositories are supported');
    const docList = await sdk.getDocs(namespace);
    const toc = repo.toc_yml ? yaml.parse(repo.toc_yml) : await sdk.getToc(namespace);
    if (!Array.isArray(toc)) throw new Error('Repository TOC must be an array');
    const base = path.join(config.metaDir, namespace);
    await writeFile(path.join(base, 'repo.json'), repo);
    await writeFile(path.join(base, 'toc.json'), normalizeToc(toc, docList));
    await writeFile(path.join(base, 'docs.json'), docList);
    const manifest = await readManifest(namespace);
    const queue = new PQueue({ concurrency: config.concurrency });
    await queue.addAll(docList.map(doc => async () => {
      try {
        if (!config.clean && await isCacheReusable(namespace, doc, manifest.documents[doc.id])) {
          result.cached++;
          return;
        }
        const detail: DocDetail & { exporter_warnings?: string[] } = { ...doc, ...await sdk.getDocDetail(namespace, doc.slug) };
        const resolved = resolveContent(detail);
        const ordinary = !detail.type || detail.type.toLowerCase() === 'doc';
        if (config.preferYfm && ordinary && detail.status !== 0 &&
            (resolved.status !== 'ready' || resolved.extension !== '.md')) {
          try {
            const markdown = await sdk.getYmdDoc(detail.id);
            if (markdown.trim()) detail.exporter_markdown = markdown;
          } catch (error) {
            // Keep every legacy representation if YFM is unavailable for this account.
            detail.exporter_warnings = [ `YFM fallback unavailable: ${errorMessage(error)}` ];
          }
        }
        await writeFile(documentPath(namespace, doc.slug), detail);
        result.downloaded++;
        const content = resolveContent(detail);
        // Missing/unsupported bodies are stored as evidence, never marked reusable.
        if (content.status === 'ready' || (content.status === 'empty' && detail.word_count === 0)) {
          manifest.documents[doc.id] = {
            slug: doc.slug,
            fingerprint: documentFingerprint(doc),
            contentHash: contentHash(detail),
            fetchedAt: new Date().toISOString(),
          };
        } else {
          delete manifest.documents[doc.id];
        }
      } catch (error) {
        result.failures.push({ namespace, slug: doc.slug, title: doc.title, message: errorMessage(error) });
        logger.error(`Document fetch failed: ${namespace}/${doc.slug}: ${errorMessage(error)}`);
      }
    }));
    // Commit the manifest after all successful detail files have been atomically saved.
    await writeFile(manifestPath(namespace), manifest);
    return { repo, toc, docList, result };
  } finally {
    if (!suppliedSDK) await sdk.close();
  }
}

function normalizeToc(items: TocItem[], docs: Doc[]) {
  const levels: string[] = [];
  return items.map((item, index) => {
    const doc = docs.find(doc => doc.id === (item.doc_id || item.id) || doc.slug === (item.url || item.slug));
    const uuid = item.uuid || `toc-${index}`;
    const level = Math.max(0, (item.depth ?? item.level ?? 1) - 1);
    const parent = item.parent_uuid || levels[level - 1];
    levels[level] = uuid;
    levels.length = level + 1;
    return {
      ...item,
      uuid,
      parent_uuid: parent,
      type: item.type || (doc ? 'DOC' : 'TITLE'),
      title: item.title || doc?.title || 'Untitled',
      url: item.url || item.slug || doc?.slug,
    };
  });
}
