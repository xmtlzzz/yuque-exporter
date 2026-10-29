import path from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import filenamify from 'filenamify';
import type { Link, Image, Definition, ImageReference } from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import { selectAll } from 'unist-util-select';
import { visit } from 'unist-util-visit';

import type { TreeNode } from './types.js';
import type { DocDetail } from './sdk.js';
import type { ResolvedContent } from './content.js';
import { resolveContent } from './content.js';
import { readCachedDetail } from './cache.js';
import { download, getRedirectLink, errorMessage, exists } from './utils.js';
import { config } from '../config.js';

export interface BuiltDocument extends ResolvedContent {
  detail: DocDetail;
  filePath: string;
}

interface Options {
  doc: TreeNode;
  mapping: Record<string, TreeNode>;
  warnings: string[];
}

export async function buildDoc(doc: TreeNode, mapping: Record<string, TreeNode>, suppliedDetail?: DocDetail): Promise<BuiltDocument> {
  const detail = suppliedDetail || await readCachedDetail(doc.namespace, doc.url);
  const resolved = resolveContent(detail);
  const warnings = [ ...resolved.warnings, ...((detail as any).exporter_warnings || []) ];
  if (resolved.status !== 'ready' || resolved.extension !== '.md') {
    if (resolved.status === 'ready') warnings.push('Original representation preserved; embedded resources and Yuque widgets may require Yuque.');
    return { ...resolved, warnings, detail, filePath: doc.filePath };
  }
  const result = await remark()
    .data('settings', { bullet: '-', listItemIndent: 'one' })
    .use(remarkGfm)
    .use(repairYuqueBold)
    .use([
      [ relativeLink, { doc, mapping, warnings }],
      [ downloadAsset, { doc, mapping, warnings }],
    ])
    .process(separateHtmlBlocks(resolved.content));
  const content = result.toString();
  if (!content.trim()) throw new Error('Markdown transformation produced empty content');
  return { ...resolved, content, warnings, detail, filePath: doc.filePath };
}

// Yuque emits bold that CommonMark misparses in two shapes:
//
//   1. "导致**<u>区分</u>**"   - "**" glued to CJK with inline HTML inside; the
//      closing run is not right-flanking, so remark keeps the asterisks literal.
//   2. "**A****B**"        - two adjacent bold runs collapse into one strong node
//      holding a literal "****", which renders as visible stars between them.
//   3. "- **桶数组：**范围"  - a closing run that follows full-width punctuation is
//      left inside a single text node, so the bold never forms.
//
// All three are repaired on the AST before serialisation.
// A run of "**bold**" glued to CJK text or full-width punctuation.
const CJK_BOUNDARY = /[\u3000-\u303f\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/;
const BOLD_IN_TEXT = /(^|[^\s*])\*\*([^*\n]+?)\*\*/g;

function repairYuqueBold() {
  return (tree: any): void => {
    // Shape 2 first: splitting a strong node may expose asterisks for shape 1.
    visit(tree, 'strong', (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return;
      const marker = node.children.findIndex((child: any) => child.type === 'text' && /^\*{4}$/.test(child.value));
      if (marker <= 0 || marker >= node.children.length - 1) return;
      const left = node.children.slice(0, marker);
      const right = node.children.slice(marker + 1);
      // Each half must carry real markup; otherwise the asterisks were literal.
      if (!left.some((child: any) => child.type === 'html') || !right.some((child: any) => child.type === 'html')) return;
      // Without a separator the serialiser joins the two runs back into "****".
      // A zero-width space is invisible when rendered but keeps them distinct.
      parent.children.splice(index, 1,
        { type: 'strong', children: left },
        { type: 'text', value: '\u200B' },
        { type: 'strong', children: right });
    });

    // Shape 1: literal "**" text nodes wrapped around inline HTML.
    visit(tree, (node: any) => {
      const kids = node.children;
      if (!Array.isArray(kids) || kids.length < 3) return;
      for (let start = 0; start < kids.length; start++) {
        const open = kids[start];
        if (open.type !== 'text' || !open.value.endsWith('**')) continue;
        for (let end = start + 1; end < kids.length; end++) {
          const close = kids[end];
          if (close.type !== 'text' || !close.value.startsWith('**')) continue;
          const inner = kids.slice(start + 1, end);
          // Repair only bold that wraps inline HTML. That is the shape Yuque emits
          // for coloured emphasis; widening this to plain text changed no output.
          if (!inner.some((child: any) => child.type === 'html')) break;
          open.value = open.value.slice(0, -2);
          close.value = close.value.slice(2);
          kids.splice(start + 1, end - start - 1, { type: 'strong', children: inner });
          break;
        }
      }
    });

    // Shape 3: the whole run sits inside one text node. Only CJK-adjacent runs
    // qualify; ordinary Markdown emphasis was already parsed by remark.
    visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined || !node.value.includes('**')) return;
      const parts: any[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      BOLD_IN_TEXT.lastIndex = 0;
      while ((match = BOLD_IN_TEXT.exec(node.value)) !== null) {
        const lead = match[1];
        const inner = match[2];
        if (/^\s|\s$/.test(inner)) continue;
        const afterChar = node.value[match.index + match[0].length] || '';
        const beforeOk = lead === '' || CJK_BOUNDARY.test(lead.slice(-1));
        const afterOk = afterChar === '' || CJK_BOUNDARY.test(afterChar) || /^\s/.test(afterChar);
        if (!beforeOk || !afterOk) continue;
        parts.push({ type: 'text', value: node.value.slice(last, match.index) + lead });
        parts.push({ type: 'strong', children: [{ type: 'text', value: inner }] });
        last = match.index + match[0].length;
      }
      if (!parts.length) return;
      parts.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts.filter((part: any) => part.type !== 'text' || part.value));
    });
  };
}


// CommonMark keeps an HTML block open until a blank line, so a document that puts
// "<details>...</details>" immediately above "![](image)" hides the image inside
// raw HTML: it is never visited, never downloaded and never linked. Restoring the
// blank line lets the following Markdown be parsed as Markdown again.
function separateHtmlBlocks(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  // A single line that opens and closes its own element (or is a void element) is
  // a complete block; an opening tag alone may legitimately span several lines.
  const selfContained = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>\s*$|^<(?:img|hr|br|input|meta|link|source|embed|area|base|col|param|track|wbr)\b[^>]*>\s*$/i;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1];
    output.push(line);
    if (next === undefined || !next.trim()) continue;
    if (!line.trimStart().startsWith('<') || !selfContained.test(line.trim())) continue;
    if (next.trimStart().startsWith('<')) continue;
    output.push('');
  }
  return output.join('\n');
}

function relativeLink({ doc, mapping, warnings }: Options) {
  return async tree => {
    for (const node of selectAll('link, definition', tree) as Link[]) {
      let url: URL;
      try { url = new URL(node.url, `${config.host}/${doc.namespace}/${doc.url}`); } catch { continue; }
      if (url.origin !== new URL(config.host).origin || url.pathname.startsWith('/attachments/')) continue;
      if (url.pathname.startsWith('/docs/share/')) {
        try {
          url = new URL(await getRedirectLink(url.href, config.host));
        } catch (error) {
          warnings.push(`Share link resolution failed: ${errorMessage(error)}`);
          continue;
        }
      }
      if (url.origin !== new URL(config.host).origin) continue;
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.replace(/^\//, '').replace(/\/$/, ''));
      } catch {
        warnings.push('Malformed document URL retained.');
        continue;
      }
      const target = mapping[key];
      if (!target?.exportable || !target.extension) continue;
      const relative = path.posix.relative(path.posix.dirname(doc.filePath), target.filePath + target.extension);
      node.url = (relative || path.posix.basename(target.filePath + target.extension)) + url.hash;
    }
  };
}

function downloadAsset({ doc, warnings }: Options) {
  return async tree => {
    const nodes = selectAll('image, link, definition', tree) as (Link | Image | Definition)[];
    const imageReferences = new Set((selectAll('imageReference', tree) as ImageReference[]).map(node => node.identifier.toLowerCase()));
    const downloaded = new Map<string, string>();
    for (const node of nodes) {
      let url: URL;
      try { url = new URL(node.url); } catch { continue; }
      if (![ 'http:', 'https:' ].includes(url.protocol)) continue;
      const attachment = url.origin === new URL(config.host).origin && url.pathname.startsWith('/attachments/');
      const image = node.type === 'image' || (node.type === 'definition' && imageReferences.has(node.identifier.toLowerCase()));
      if (!image && !attachment) continue;
      const digest = createHash('sha256').update(url.href).digest('hex')
        .slice(0, 16);
      let assetName = url.pathname.split('/').pop() || 'asset';
      try { assetName = decodeURIComponent(assetName); } catch { /* Keep the encoded filename. */ }
      const basename = filenamify(assetName, { replacement: '_', maxLength: 80 }) || 'asset';
      const slug = filenamify(doc.url, { replacement: '_', maxLength: 60 }) || 'doc';
      const filePath = path.posix.join(doc.filePath.split('/')[0], 'assets', slug, `${digest}-${basename}`);
      const absolute = path.join(config.outputDir, filePath);
      try {
        // The name embeds a digest of the URL and writes are atomic, so a file
        // already on disk is a complete copy of this exact resource. Re-downloading
        // every attachment on every run kept incremental exports as slow as the first.
        let result = downloaded.get(url.href);
        if (!result && await exists(absolute) && (await fs.stat(absolute)).size > 0) result = absolute;
        if (!result) {
          result = await download(url.href, absolute, { image });
          downloaded.set(url.href, result);
        }
        if (result !== absolute) {
          warnings.push(`Resource download failed; remote link retained (${node.type}).`);
          continue;
        }
        node.url = path.posix.relative(path.posix.dirname(doc.filePath), filePath);
      } catch (error) {
        warnings.push(`Resource download failed; remote link retained: ${errorMessage(error)}`);
      }
    }
  };
}
