import assert from 'assert/strict';

import { resolveContent, ContentDetail } from '../src/lib/content.js';

describe('resolveContent', () => {
  it('exports a legacy lake-format body that is already Markdown', () => {
    const content = '# Title\n\n[Link](https://example.test)\n';
    assert.deepEqual(resolveContent({ type: 'Doc', format: 'lake', status: 1, body: content }), {
      status: 'ready', content, extension: '.md', source: 'body', warnings: [],
    });
  });

  it('prefers the official YFM supplement for a published ordinary document', () => {
    const result = resolveContent({ type: 'Doc', status: 1, format: 'lake', body: 'Legacy content', exporter_markdown: '# Complete YFM' });
    assert.equal(result.content, '# Complete YFM');
    assert.equal(result.source, 'exporter_markdown');
    assert.equal(result.extension, '.md');
  });

  it('ignores an empty YFM supplement', () => {
    assert.equal(resolveContent({ body: '# Body', exporter_markdown: ' \n ' }).source, 'body');
  });

  it('uses the unpublished Markdown draft before all published snapshots', () => {
    const content = '# New draft\n';
    const result = resolveContent({ status: 0, format: 'lake', body_draft: content, body_draft_lake: '<lake>new</lake>', body: '# Old version', exporter_markdown: '# Old YFM' });
    assert.deepEqual(result, { status: 'ready', content, extension: '.md', source: 'body_draft', warnings: [] });
  });

  it('uses the unpublished Lake draft before an available published body or YFM', () => {
    const content = '<p data-lake-id="draft">New draft</p>';
    const result = resolveContent({ status: 0, body_draft: ' \n ', body_draft_lake: content, body: '# Old', exporter_markdown: '# Old YFM' });
    assert.deepEqual(result, { status: 'ready', content, extension: '.lake', source: 'body_draft_lake', warnings: [] });
  });

  it('warns when a published document falls back to a Markdown draft', () => {
    const result = resolveContent({ status: 1, body: '', body_draft: '# Saved draft' });
    assert.equal(result.content, '# Saved draft');
    assert.equal(result.source, 'body_draft');
    assert.match(result.warnings.join('\n'), /draft fallback/i);
  });

  it('warns when a published document falls back to a Lake draft', () => {
    const content = '<ne-card value="unchanged" />';
    const result = resolveContent({ status: 1, body: null, body_draft_lake: content });
    assert.equal(result.content, content);
    assert.equal(result.extension, '.lake');
    assert.match(result.warnings.join('\n'), /draft fallback/i);
  });

  it('keeps an available published body ahead of the draft', () => {
    const result = resolveContent({ status: 1, body: '# Published', body_draft: '# New draft' });
    assert.equal(result.source, 'body');
    assert.deepEqual(result.warnings, []);
  });

  for (const kind of [ 'sheet', 'table' ] as const) {
    const field = kind === 'sheet' ? 'body_sheet' : 'body_table';
    it(`exports ${kind} JSON without merging the ordinary body`, () => {
      const content = ' {"cells":[["A",1]]} \n';
      const result = resolveContent({ type: kind.toUpperCase(), body: '# Unrelated body', [field]: content, exporter_markdown: '# YFM snapshot' });
      assert.deepEqual(result, { status: 'ready', content, extension: `.${kind}.json`, source: field, warnings: [] });
      assert.deepEqual(JSON.parse(result.content), { cells: [[ 'A', 1 ]] });
    });

    it(`accepts a ${kind} object without mutating it`, () => {
      const data = Object.freeze({ rows: Object.freeze([{ text: '中文', count: 2 }]) });
      const result = resolveContent({ format: kind === 'sheet' ? 'lakesheet' : 'table', body: '', [field]: data });
      assert.equal(result.status, 'ready');
      assert.equal(result.extension, `.${kind}.json`);
      assert.deepEqual(JSON.parse(result.content), data);
      assert.deepEqual(data, { rows: [{ text: '中文', count: 2 }] });
    });

    it(`recognizes ${kind} from a dedicated field without metadata`, () => {
      assert.equal(resolveContent({ body: '', [field]: [] }).extension, `.${kind}.json`);
    });

    it(`keeps invalid ${kind} JSON for a raw backup instead of selecting another snapshot`, () => {
      const content = '{ invalid JSON \n';
      const result = resolveContent({ type: kind, body: '# Existing body', [field]: content });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.content, content);
      assert.equal(result.source, field);
      assert.equal(result.extension, '');
      assert.match(result.warnings.join('\n'), /not valid JSON/i);
    });

    it(`uses a verified body JSON fallback for ${kind}`, () => {
      const result = resolveContent({ type: kind, body: '{"rows":[]}', [field]: null });
      assert.equal(result.status, 'ready');
      assert.equal(result.source, 'body');
      assert.equal(result.extension, `.${kind}.json`);
      assert.match(result.warnings.join('\n'), /unavailable/i);
    });

    it(`reports missing ${kind} content as unsupported`, () => {
      const result = resolveContent({ type: kind, body: '' });
      assert.equal(result.status, 'unsupported');
      assert.match(result.warnings.join('\n'), new RegExp(field));
    });
  }

  it('recognizes the sheet format alias independently of type', () => {
    assert.equal(resolveContent({ format: 'sheet', body_sheet: '{}' }).extension, '.sheet.json');
  });

  it('uses the declared structured type when both dedicated fields exist', () => {
    const result = resolveContent({ type: 'Table', body_sheet: '{"sheet":1}', body_table: '{"table":2}' });
    assert.equal(result.source, 'body_table');
    assert.equal(result.content, '{"table":2}');
  });

  it('does not classify nullable unused structured fields as a sheet or table', () => {
    assert.equal(resolveContent({ body: '# Text', body_sheet: null, body_table: undefined }).extension, '.md');
  });

  it('rejects non-string and non-object structured values', () => {
    const result = resolveContent({ type: 'Sheet', body_sheet: 12 });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.content, '12');
  });

  it('preserves native HTML byte for byte and does not select a YFM snapshot for HtmlDoc', () => {
    const content = '<!DOCTYPE html>\n<html><body><table><tr><td>内容</td></tr></table></body></html>\n';
    const result = resolveContent({ type: 'HtmlDoc', body: content, exporter_markdown: '# Reduced YFM' });
    assert.deepEqual(result, { status: 'ready', content, extension: '.html', source: 'body', warnings: [] });
  });

  it('preserves HTML selected from the HTML field', () => {
    const content = ' <div class="rich"><img src="https://example.test/image.png">Text</div>\n';
    const result = resolveContent({ body: '', body_html: content });
    assert.equal(result.content, content);
    assert.equal(result.extension, '.html');
    assert.equal(result.source, 'body_html');
  });

  it('preserves a body explicitly labelled HTML', () => {
    const result = resolveContent({ format: 'HTML', body: 'HTML source text' });
    assert.equal(result.extension, '.html');
  });

  it('preserves obvious HTML in a body without a format', () => {
    assert.equal(resolveContent({ body: '<div><strong>Rich content</strong></div>' }).extension, '.html');
  });

  it('preserves HTML consisting of an image or inline element', () => {
    assert.equal(resolveContent({ body: '<img src="https://example.test/image.png">' }).extension, '.html');
    assert.equal(resolveContent({ body: '<span class="original">Rich content</span>' }).extension, '.html');
  });

  it('preserves HTML-like markup labelled lake as Lake', () => {
    assert.equal(resolveContent({ format: 'lake', body: '<p>Rich content</p>' }).extension, '.lake');
  });

  it('keeps a complete HTML document as HTML even though it carries lake attributes', () => {
    // Yuque compiles every unpublished draft body to HTML that still contains
    // "data-lake-index-type" and "ne-*" classes. Treating those files as Lake
    // produced output that no editor or browser would open.
    const content = '<!doctype html><div class="lake-content" typography="classic"><ul class="ne-ul"><li data-lake-index-type="0"><span class="ne-text">内容</span></li></ul></div>';
    const result = resolveContent({ status: 0, body_draft: content });
    assert.equal(result.status, 'ready');
    assert.equal(result.extension, '.html');
    assert.equal(result.content, content);
  });

  it('keeps an HTML root element as HTML even without a doctype', () => {
    assert.equal(resolveContent({ body: '<html><body><p data-lake-id="a">x</p></body></html>' }).extension, '.html');
  });

  it('still recognises the compiled Lake prologue', () => {
    const content = '<!doctype lake><meta name="doc-version" content="1" /><p id="u1" class="ne-p">正文</p>';
    assert.equal(resolveContent({ body: content }).extension, '.lake');
  });

  for (const content of [ '<lake><p>Native lake</p></lake>', '<ne-card type="image" value="original-data" />', '<p data-lake-id="abc">Original lake</p>' ]) {
    it(`preserves obvious Lake syntax: ${content.substring(0, 20)}`, () => {
      const result = resolveContent({ body: content });
      assert.equal(result.status, 'ready');
      assert.equal(result.extension, '.lake');
      assert.equal(result.content, content);
    });
  }

  it('preserves the complete Lake field without removing tags or resource attributes', () => {
    const content = '<p id="text">Hello</p><ne-card value="{&quot;url&quot;:&quot;asset://photo&quot;}" />';
    const result = resolveContent({ body: '', body_lake: content });
    assert.equal(result.content, content);
    assert.equal(result.extension, '.lake');
    assert.equal(result.source, 'body_lake');
  });

  it('keeps Markdown with embedded HTML in the Markdown pipeline', () => {
    const content = '# Heading\n\nHello<br />world\n\n<div>HTML block</div>\n';
    assert.equal(resolveContent({ body: content, format: 'lake' }).extension, '.md');
  });

  it('does not mistake Lake syntax inside a Markdown code example for native Lake', () => {
    const content = '# Example\n\n```html\n<ne-card value="example" />\n```\n';
    assert.equal(resolveContent({ body: content, format: 'lake' }).extension, '.md');
  });

  for (const type of [ 'Board', 'Thread', 'UnknownCanvas' ]) {
    it(`requires a raw backup for unsupported ${type} content`, () => {
      const content = '{"nodes":[{"kind":"drawing","data":"preserved"}]}';
      const result = resolveContent({ type, body: content });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.content, content);
      assert.match(result.warnings.join('\n'), /Unsupported document type/);
    });

    it(`does not call an empty ${type} successfully exported or truly empty`, () => {
      assert.equal(resolveContent({ type, body: '', word_count: 0 }).status, 'unsupported');
    });
  }

  it('preserves content with an unknown format for raw backup', () => {
    const content = 'opaque native payload';
    const result = resolveContent({ format: 'canvas-v2', body: content });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.content, content);
    assert.match(result.warnings.join('\n'), /Unsupported document format/);
  });

  for (const detail of [ undefined, null, {}, { body: undefined }, { body: null }, { body: '', word_count: 12 }]) {
    it(`reports missing or contradictory content: ${JSON.stringify(detail)}`, () => {
      const result = resolveContent(detail);
      assert.equal(result.status, 'unsupported');
      assert.equal(result.content, '');
      assert.ok(result.warnings.length > 0);
    });
  }

  it('reports a non-string ordinary body as unsupported and retains it', () => {
    const result = resolveContent({ body: { unexpected: true } });
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(JSON.parse(result.content), { unexpected: true });
  });

  it('uses a valid alternate field when the body is missing or null', () => {
    assert.equal(resolveContent({ body: null, body_html: '<p>Content</p>' }).status, 'ready');
    assert.equal(resolveContent({ status: 0, body_draft: '# Draft' }).status, 'ready');
  });

  for (const body of [ '', ' \t\r\n ' ]) {
    it(`classifies explicit empty or whitespace-only body as truly empty: ${JSON.stringify(body)}`, () => {
      assert.deepEqual(resolveContent({ type: 'Doc', body, word_count: 0, body_draft: null, body_html: undefined }), {
        status: 'empty', content: '', extension: '', source: 'body', warnings: [],
      });
    });
  }

  it('does not confuse whitespace with ready content or remove meaningful whitespace', () => {
    const content = '  # Draft\n\n';
    const result = resolveContent({ status: 0, body: '\t\n ', body_draft: content });
    assert.equal(result.status, 'ready');
    assert.equal(result.content, content);
    assert.ok(result.content.trim());
  });

  it('treats the blank markup Yuque returns for an unwritten document as empty', () => {
    // These are the exact payloads observed for real word_count:0 documents.
    // Reporting them as "exported" wrote 7-byte files and inflated the summary.
    // A missing body field stays unsupported: it cannot be told apart from a
    // failed response. Yuque always returns a string, so these payloads do too.
    for (const blank of [ '<p></p>', '<p><br></p>', '\u200b', '<div class="lake-content" typography="classic"><p class="ne-p"><br></p></div>' ]) {
      assert.equal(resolveContent({ type: 'Doc', status: 1, body: blank, word_count: 0 }).status, 'empty', blank);
      assert.equal(resolveContent({ status: 0, body: '', body_draft: blank, word_count: 0 }).status, 'empty', blank);
    }
  });

  it('keeps markup that only looks blank because it holds media', () => {
    const withImage = '<p><img src="https://example.test/a.png"></p>';
    const withLink = '<p><a href="https://example.test">参考链接</a></p>';
    const withMarkdownImage = '![](https://example.test/a.png)';
    for (const content of [ withImage, withLink, withMarkdownImage ]) {
      const result = resolveContent({ type: 'Doc', status: 1, body: content, word_count: 0 });
      assert.equal(result.status, 'ready', content);
      assert.equal(result.content, content);
    }
  });

  it('skips a blank representation and selects the next field with real content', () => {
    const result = resolveContent({ status: 0, body_draft: '<p></p>', body_draft_lake: '<p data-lake-id="a">真正内容</p>' });
    assert.equal(result.status, 'ready');
    assert.equal(result.source, 'body_draft_lake');
    assert.equal(result.content, '<p data-lake-id="a">真正内容</p>');
  });

  it('does not mutate the input detail or any of its snapshots', () => {
    const detail: ContentDetail = Object.freeze({ type: 'Doc', status: 0, body: '# Published', body_draft: '# Draft', format: 'lake' });
    assert.equal(resolveContent(detail).source, 'body_draft');
    assert.deepEqual(detail, { type: 'Doc', status: 0, body: '# Published', body_draft: '# Draft', format: 'lake' });
  });
});
