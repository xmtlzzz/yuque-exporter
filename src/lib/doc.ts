import path from 'path';

import type { Link, Text } from 'mdast';
import { remark } from 'remark';
import { selectAll } from 'unist-util-select';

import { TreeNode } from './types.js';
import { logger, readJSON, download, getRedirectLink } from './utils.js';
import { config } from '../config.js';

const { host, metaDir, outputDir, userAgent } = config;

interface Options {
  doc: TreeNode;
  mapping: Record<string, TreeNode>;
}

export async function buildDoc(
  doc: TreeNode,
  mapping: Record<string, TreeNode>,
) {
  const docFilePath = path.join(metaDir, doc.namespace, 'docs', `${doc.url}.json`);
  const docDetail = await readJSON(docFilePath).catch(err => {
    if (err.code === 'ENOENT') {
      logger.warn(`[SKIP] Doc file not found: ${docFilePath}`);
      return null;
    }
    throw err;
  });
  if (!docDetail) return null;

  const content = await remark()
    .data('settings', { bullet: '-', listItemIndent: 'one' })
    .use([
      [ replaceHTML ],
      [ relativeLink, { doc, mapping }],
      [ downloadAsset, { doc, mapping }],
    ])
    .process(docDetail.body);

  doc.content = frontmatter() + content.toString();

  // FIXME: remark will transform `*` to `\*`
  doc.content = doc.content.replaceAll('\\*', '*');

  return doc;
}

function frontmatter() {
  return '';
}

function replaceHTML() {
  return tree => {
    const htmlNodes = selectAll('html', tree) as Text[];
    for (const node of htmlNodes) {
      if (node.value === '<br />' || node.value === '<br/>') {
        node.type = 'text';
        node.value = '\n';
      }
    }
  };
}

function relativeLink({ doc, mapping }: Options) {
  return async tree => {
    const links = selectAll('link', tree) as Link[];
    for (const node of links) {
      if (!isYuqueDocLink(node.url)) continue;

      // 语雀分享链接功能已下线，替换为 302 后的地址
      if (node.url.startsWith(`${host}/docs/share/`)) {
        node.url = await getRedirectLink(node.url, host);
      }

      // 语雀链接有多种显示方式，其中一种会插入该参数，会导致点击后的页面缺少头部导航
      node.url = node.url.replace('view=doc_embed', '');

      const { pathname } = new URL(node.url);
      const targetNode = mapping[pathname.substring(1)];
      if (!targetNode) {
        console.warn(`[WARN] ${node.url}, ${pathname.substring(1)} not found`);
      } else {
        node.url = path.relative(path.dirname(doc.filePath), targetNode.filePath) + '.md';
      }
    }
  };
}

function isYuqueDocLink(url?: string) {
  if (!url) return false;
  if (!url.startsWith(host)) return false;
  if (url.startsWith(host + '/attachments/')) return false;
  return true;
}

function downloadAsset(opts: Options) {
  return async tree => {
    const docFilePath = opts.doc.filePath;
    const assetsDir = path.join(docFilePath.split('/')[0], 'assets');

    // FIXME: 语雀附件现在不允许直接访问，需要登录后才能下载，这里先跳过。
    // const assetNodes = selectAll(`image[url^=http], link[url^=${host}/attachments/]`, tree) as Link[];
    const assetNodes = selectAll('image[url^=http]', tree) as Link[];
    for (const node of assetNodes) {
      const assetName = `${opts.doc.url}/${new URL(node.url).pathname.split('/').pop()}`;
      const filePath = path.join(assetsDir, assetName);
      await download(node.url, path.join(outputDir, filePath), { headers: { 'User-Agent': userAgent } });
      node.url = path.relative(path.dirname(docFilePath), filePath);
    }
  };
}
