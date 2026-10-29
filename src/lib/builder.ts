import path from 'path';
import fs from 'fs/promises';
import PQueue from 'p-queue';
import fg from 'fast-glob';

import type { Repository, TreeNode } from './types.js';
import type { Doc, DocDetail } from './sdk.js';
import type { CrawlResult, ExportItem } from './report.js';
import { createReport, saveReport } from './report.js';
import { logger, mkdir, readJSON, writeFile, errorMessage } from './utils.js';
import { buildDoc } from './doc.js';
import { buildRepoTree, buildTree } from './tree.js';
import { contentHash, documentFingerprint, readCachedDetail, readManifest } from './cache.js';
import { resolveContent } from './content.js';
import { emitProgress } from './progress.js';
import { config } from '../config.js';

export async function build(inputs?: string[], crawlResult?: CrawlResult) {
  logger.info('Start building...');
  const report = createReport();
  report.crawl = crawlResult;
  const failedDocs = new Set<string>();
  const failedRepos = new Set<string>();
  for (const failure of crawlResult?.failures || []) {
    report.documents.push({ ...failure, status: 'failed', files: [], warnings: [] });
    if (failure.slug) failedDocs.add(`${failure.namespace}/${failure.slug}`);
    else failedRepos.add(failure.namespace);
  }
  const repos: Repository[] = [];
  const matches = (namespace: string) => inputs === undefined || inputs.some(input => namespace === input || (!input.includes('/') && namespace.startsWith(input + '/')));
  for (const repoPath of await fg('**/repo.json', { cwd: config.metaDir, deep: 3 })) {
    try {
      const repo: Repository = await readJSON(path.join(config.metaDir, repoPath));
      if (repo.type !== 'Book' || !matches(repo.namespace) || failedRepos.has(repo.namespace)) continue;
      await buildRepoTree(repo);
      repos.push(repo);
    } catch (error) {
      const namespace = repoPath.replace(/\\/g, '/').replace(/\/repo.json$/, '');
      if (matches(namespace) && !failedRepos.has(namespace)) {
        report.documents.push({ namespace, status: 'failed', files: [], warnings: [], message: errorMessage(error) });
      }
    }
  }
  if (!repos.length && !crawlResult && inputs?.length !== 0) {
    report.documents.push({ namespace: inputs?.join(', ') || '', status: 'failed', files: [], warnings: [], message: 'No readable repository cache found; run crawl first.' });
  }
  if (inputs && !crawlResult) {
    for (const input of inputs) {
      if (input.includes('/') && !repos.some(repo => repo.namespace === input) && !report.documents.some(item => item.namespace === input)) {
        report.documents.push({ namespace: input, status: 'failed', files: [], warnings: [], message: 'Requested repository cache was not found.' });
      }
    }
  }
  const tree = await buildTree(repos);
  const details = new Map<string, DocDetail>();
  const docLists = new Map<string, Doc[]>();
  const manifests = new Map<string, Awaited<ReturnType<typeof readManifest>>>();
  for (const repo of repos) {
    docLists.set(repo.namespace, await readJSON(path.join(config.metaDir, repo.namespace, 'docs.json')));
    manifests.set(repo.namespace, await readManifest(repo.namespace));
  }
  // Resolve every link target before rewriting any document.
  for (const { node } of tree) {
    if (![ 'DOC', 'DRAFT_DOC' ].includes(node.type)) continue;
    const key = `${node.namespace}/${node.url}`;
    try {
      if (failedDocs.has(key)) throw new Error('Current document fetch failed; previous export preserved');
      const detail = await readCachedDetail(node.namespace, node.url);
      const current = docLists.get(node.namespace).find(doc => doc.slug === node.url);
      const entry = current && manifests.get(node.namespace).documents[current.id];
      if (entry && (entry.fingerprint !== documentFingerprint(current) || entry.contentHash !== contentHash(detail))) {
        throw new Error('Document cache is stale or corrupted; run crawl again');
      }
      details.set(key, detail);
      const resolved = resolveContent(detail);
      node.extension = resolved.extension;
      node.exportable = resolved.status === 'ready';
    } catch (error) {
      node.exportable = false;
      if (!failedDocs.has(key)) {
        report.documents.push({
          namespace: node.namespace, slug: node.url, title: node.title,
          status: 'failed', files: [], warnings: [], message: errorMessage(error),
        });
        failedDocs.add(key);
      }
    }
  }
  emitProgress({ type: 'phase', phase: 'build', message: `${tree.docs ? Object.keys(tree.docs).length : 0} document(s) cached` });
  const queue = new PQueue({ concurrency: config.concurrency });
  await queue.addAll([ ...tree ].map(({ node }) => async () => {
    const item: ExportItem = {
      namespace: node.namespace, slug: node.url, title: node.title,
      status: 'failed', files: [], warnings: [],
    };
    try {
      if (node.type === 'TITLE' || node.type === 'REPO') {
        await mkdir(path.join(config.outputDir, node.filePath));
        return;
      }
      if (node.type === 'UNCREATED_DOC') {
        item.status = 'uncreated';
        item.message = 'TOC placeholder has no document; no empty file created.';
      } else if (node.type === 'LINK') {
        if (!node.url?.trim()) throw new Error('TOC link has no URL');
        const file = node.filePath + '.md';
        await writeFile(path.join(config.outputDir, file), node.url + '\n');
        item.files.push(file);
        item.status = 'exported';
        item.source = 'toc.url';
      } else {
        const key = `${node.namespace}/${node.url}`;
        if (failedDocs.has(key)) {
          const preserved = await existingExports(node);
          for (const failure of report.documents.filter(item => item.namespace === node.namespace && item.slug === node.url && item.status === 'failed')) {
            failure.files.push(...preserved);
            failure.preserved = preserved.length > 0;
          }
          return;
        }
        const doc = await buildDoc(node, tree.docs, details.get(key));
        item.source = doc.source;
        item.warnings = doc.warnings;
        if (doc.status === 'ready') {
          if (!doc.content.trim()) throw new Error('Refusing to create an empty exported document');
          const file = doc.filePath + doc.extension;
          await writeFile(path.join(config.outputDir, file), doc.content);
          item.status = 'exported';
          item.files.push(file);
          logger.success(`Exported ${node.namespace}/${node.url}`);
        } else if (doc.status === 'unsupported') {
          const raw = doc.filePath + '.raw.json';
          await writeFile(path.join(config.outputDir, raw), doc.detail);
          item.status = 'unsupported';
          item.files.push(raw);
          item.message = 'No verified export representation; complete detail saved as a raw backup.';
        } else {
          item.status = 'empty';
          item.message = 'Explicitly empty document; no empty file created.';
        }
      }
    } catch (error) {
      item.status = 'failed';
      item.message = errorMessage(error);
    }
    if (item.status !== 'exported') {
      const preserved = await existingExports(node);
      item.preserved = preserved.length > 0;
      item.files.push(...preserved.filter(file => !item.files.includes(file)));
    }
    report.documents.push(item);
    emitProgress({ type: 'doc', namespace: item.namespace, slug: item.slug, title: item.title, status: item.status });
  }));
  return await saveReport(report);
}

async function existingExports(node: TreeNode) {
  const files: string[] = [];
  for (const extension of [ '.md', '.html', '.lake', '.sheet.json', '.table.json' ]) {
    const file = node.filePath + extension;
    const absolute = path.resolve(config.outputDir, file);
    if (!absolute.startsWith(path.resolve(config.outputDir) + path.sep)) throw new Error('Export path escapes output directory');
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      if (stat.size > 0) files.push(file);
      // Remove only verified zero-byte placeholders from earlier exporter versions.
      else await fs.unlink(absolute);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return files;
}
