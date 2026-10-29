import assert from 'assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { buildDoc } from '../src/lib/doc.js';
import { config, resetConfig } from '../src/config.js';

// buildDoc rewrites a document the same way the exporter does, so these exercise
// the real remark pipeline rather than a copy of it.
describe('markdown fidelity', () => {
  let directory: string;
  const doc = { uuid: 'u1', type: 'DOC' as const, namespace: 'owner/book', url: 'slug', title: 'Title', filePath: 'Book/Title' };

  beforeEach(async () => {
    resetConfig();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuque-fidelity-'));
    config.outputDir = directory;
    config.host = 'https://www.yuque.com';
  });

  afterEach(async () => {
    resetConfig();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const build = (body: string) => buildDoc(doc as any, {}, {
    id: 1, slug: 'slug', title: 'Title', format: 'lake', status: 1, word_count: 1, body,
  } as any);

  it('keeps bold that wraps inline HTML next to CJK text', async () => {
    // remark escapes the "**" when it sits directly against Chinese text and the
    // content starts with a tag; 151 real documents were affected by this.
    const built = await build('导致**<u>无法区分</u>**\n');
    assert.ok(built.content.includes('**<u>无法区分</u>**'), built.content);
    assert.ok(!built.content.includes('\\*\\*'), built.content);
  });

  it('keeps bold around a styled span following text', async () => {
    const built = await build('这是**<font style="color:red">文字</font>**结尾\n');
    assert.ok(built.content.includes('**<font style="color:red">文字</font>**'), built.content);
  });

  it('leaves ordinary bold and already-correct HTML bold untouched', async () => {
    const ordinary = await build('正常**加粗**内容\n');
    assert.ok(ordinary.content.includes('**加粗**'));
    const spaced = await build('**<u>整段</u>**\n');
    assert.ok(spaced.content.includes('**<u>整段</u>**'));
  });

  it('separates two adjacent bold runs that Yuque glued together', async () => {
    // "**A****B**" parses as one strong node holding a literal "****", which
    // renders as visible asterisks between the two halves.
    const built = await build('**<font style="color:red">接口A：</font>****<font style="color:#000">使能检查</font>**\n');
    assert.ok(!built.content.includes('****'), built.content);
    assert.ok(built.content.includes('**<font style="color:red">接口A：</font>**'), built.content);
    assert.ok(built.content.includes('**<font style="color:#000">使能检查</font>**'), built.content);
  });

  it('does not invent emphasis for literal asterisks', async () => {
    const built = await build('文字****文字\n');
    assert.ok(!built.content.includes('<strong>'), built.content);
  });

  it('keeps bold whose closing delimiter follows full-width punctuation', async () => {
    // "- **桶数组：**范围" leaves the whole run inside one text node because the
    // closing "**" after "：" is not right-flanking.
    const bullet = await build('- **桶数组：**桶数组的范围是key\n');
    assert.ok(!bullet.content.includes('\\*\\*'), bullet.content);
    assert.ok(bullet.content.includes('**桶数组：**') || bullet.content.includes('<strong>桶数组：</strong>'), bullet.content);

    const inline = await build('基于另一个**Load Factor（负载因子）**来判断\n');
    assert.ok(!inline.content.includes('\\*\\*'), inline.content);
  });

  it('leaves ordinary markdown emphasis to the parser', async () => {
    const built = await build('正常**加粗**内容\n');
    assert.ok(built.content.includes('**加粗**'));
    assert.ok(!built.content.includes('\\*'));
  });

  it('does not wrap unrelated paragraphs together', async () => {
    // An unterminated "**" must stay escaped and must not swallow the next
    // paragraph; the repair only fires within one inline run around HTML.
    const built = await build('一行**结尾\n\n后面另一段\n');
    assert.ok(built.content.includes('后面另一段'));
    assert.ok(!built.content.includes('<strong>'));
  });
});
