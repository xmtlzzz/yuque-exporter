import path from 'path';
import { createHash } from 'crypto';
import filenamify from 'filenamify';
import { visit } from 'unist-util-visit';
import { inspectNoColor } from 'unist-util-inspect';

import type { Doc, Repository, TocInfo, TreeNode } from './types.js';
import { readJSON } from './utils.js';
import { config } from '../config.js';
import { validateNamespace } from './cache.js';

interface TravelResult {
  node: TreeNode;
  index: number;
  parent?: TreeNode;
}

export async function buildTree(repos: Repository[]) {
  const tree = {
    children: [] as TreeNode[],
    docs: {} as Record<string, TreeNode>,
    travel(fn: (args: TravelResult) => void) {
      visit<TreeNode>(this as any, (node, index, parent?: TreeNode) => {
        if (parent) fn({ node, index, parent });
      });
    },
    * [Symbol.iterator]() {
      const result: TravelResult[] = [];
      this.travel(args => result.push(args));
      yield* result;
    },
    inspect() {
      console.log(inspectNoColor(this.children));
    },
  };
  for (const repo of repos) tree.children.push(await buildRepoTree(repo));

  // Use physical paths, across node types, with Windows case-insensitive semantics.
  const occupied = new Set([ '.meta', 'export-report.json' ]);
  const extensions = [ '', '.md', '.html', '.lake', '.sheet.json', '.table.json', '.raw.json' ];
  tree.travel(({ node, parent }) => {
    const title = filenamify(node.title || 'Untitled', { replacement: '_', maxLength: 100 }) || 'Untitled';
    const prefix = parent.filePath ? `${parent.filePath}/` : '';
    const suffix = createHash('sha256').update(`${node.namespace}/${node.uuid}`).digest('hex')
      .slice(0, 8);
    let candidate = title;
    let count = 0;
    const key = (value: string) => value.toLowerCase();
    const collides = (name: string) => extensions.some(ext => occupied.has(key(prefix + name + ext)));
    while (collides(candidate)) {
      candidate = `${title}_${suffix}${count ? `_${count}` : ''}`;
      count++;
    }
    node.filePath = prefix + candidate;
    for (const ext of extensions) occupied.add(key(node.filePath + ext));
    if (node.type === 'REPO') occupied.add(key(`${node.filePath}/assets`));
    if ([ 'DOC', 'DRAFT_DOC', 'UNCREATED_DOC' ].includes(node.type) && node.url) {
      // Repeated TOC placements refer to the same document; keep the first link target.
      tree.docs[`${node.namespace}/${node.url}`] ||= node;
    }
  });
  return tree;
}

export async function buildRepoTree(repo: Repository) {
  validateNamespace(repo.namespace);
  const repoNode: TreeNode = {
    type: 'REPO', title: repo.name, namespace: repo.namespace,
    url: repo.namespace, uuid: repo.namespace, parent_uuid: '', children: [],
  };
  const docs: Doc[] = await readJSON(path.join(config.metaDir, repo.namespace, 'docs.json'));
  const toc: TocInfo[] = await readJSON(path.join(config.metaDir, repo.namespace, 'toc.json'));
  if (!Array.isArray(docs) || !Array.isArray(toc)) throw new Error('Invalid document list or TOC cache');
  const nodes = new Map<string, TreeNode>();
  const parents = new Map<string, string>();
  for (const [ index, item ] of toc.entries()) {
    if (item.type === 'META') continue;
    const uuid = item.uuid || `toc-${index}`;
    if (nodes.has(uuid)) throw new Error('Duplicate TOC UUID');
    if (![ 'TITLE', 'DOC', 'UNCREATED_DOC', 'LINK' ].includes(item.type)) throw new Error('Unsupported TOC node type');
    nodes.set(uuid, { ...item, type: item.type as TreeNode['type'], uuid, namespace: repo.namespace, children: [] });
    parents.set(uuid, item.parent_uuid || repoNode.uuid);
  }
  for (const [ uuid, node ] of nodes) {
    const ancestors = new Set([ uuid ]);
    let parentId = parents.get(uuid);
    while (nodes.has(parentId)) {
      if (ancestors.has(parentId)) throw new Error('Cycle in repository TOC');
      ancestors.add(parentId);
      parentId = parents.get(parentId);
    }
    const parent = nodes.get(parents.get(uuid)) || repoNode;
    // A missing parent is attached at the root instead of silently losing a document.
    node.parent_uuid = parent.uuid;
    parent.children.push(node);
  }
  const slugs = new Set([ ...nodes.values() ].map(node => node.url));
  for (const doc of docs) {
    if (slugs.has(doc.slug)) continue;
    repoNode.children.push({
      type: doc.status === 0 ? 'DRAFT_DOC' : 'DOC', title: doc.title,
      uuid: `doc-${doc.id}`, parent_uuid: repoNode.uuid,
      url: doc.slug, namespace: repo.namespace,
    });
  }
  return repoNode;
}
