export interface ContentDetail {
  type?: string | null;
  format?: string | null;
  status?: number | null;
  word_count?: number | null;
  body?: unknown;
  body_draft?: unknown;
  body_html?: unknown;
  body_lake?: unknown;
  body_draft_lake?: unknown;
  body_sheet?: unknown;
  body_table?: unknown;
  exporter_markdown?: unknown;
}

export interface ResolvedContent {
  status: 'ready' | 'empty' | 'unsupported';
  content: string;
  extension: string;
  source: string;
  warnings: string[];
}

type ContentField = 'body' | 'body_draft' | 'body_html' | 'body_lake' |
'body_draft_lake' | 'body_sheet' | 'body_table' | 'exporter_markdown';

const ordinaryTypes = new Set([ '', 'doc', 'html', 'htmldoc' ]);
const ordinaryFormats = new Set([ '', 'markdown', 'md', 'lake', 'html', 'htmldoc' ]);

/** Select one complete representation; never merge snapshots or strip rich text. */
export function resolveContent(detail: ContentDetail | null | undefined): ResolvedContent {
  if (!detail) return unavailable('Document detail is missing.');

  const type = normalize(detail.type);
  const format = normalize(detail.format);
  const fields = textFields(detail);
  if (type && !ordinaryTypes.has(type) && type !== 'sheet' && type !== 'table') {
    return unsupportedRaw(detail, fields, `Unsupported document type "${detail.type}"; preserve the detail as a raw backup.`);
  }

  let structured: 'sheet' | 'table' | undefined;
  if (type === 'sheet' || type === 'table') {
    structured = type;
  } else if (format === 'lakesheet' || format === 'sheet') {
    structured = 'sheet';
  } else if (format === 'table') {
    structured = 'table';
  } else if (detail.body_sheet !== undefined && detail.body_sheet !== null) {
    structured = 'sheet';
  } else if (detail.body_table !== undefined && detail.body_table !== null) {
    structured = 'table';
  }
  if (structured) return resolveStructured(detail, structured, fields);

  if (!ordinaryFormats.has(format)) {
    return unsupportedRaw(detail, fields, `Unsupported document format "${detail.format}"; preserve the detail as a raw backup.`);
  }

  const invalidFields: ContentField[] = [];
  for (const field of fields) {
    const value = detail[field];
    if (!hasContent(value)) continue;
    if (typeof value !== 'string') {
      invalidFields.push(field);
      continue;
    }
    // A non-empty string can still hold nothing: "<p></p>" and a zero-width space
    // are what Yuque returns for an unwritten document. Keep looking for real content.
    if (isBlankMarkup(value)) continue;
    const warnings = invalidFields.map(source => `${source} is not a string; selected ${field} instead.`);
    if (detail.status !== 0 && (field === 'body_draft' || field === 'body_draft_lake')) {
      warnings.push(`Published content is unavailable; exported ${field} as a draft fallback.`);
    }
    return {
      status: 'ready',
      content: value,
      extension: textExtension(value, field, type, format),
      source: field,
      warnings,
    };
  }

  if (invalidFields.length) {
    return unsupportedRaw(detail, invalidFields, `${invalidFields[0]} is not a string; preserve the detail as a raw backup.`);
  }
  return noContent(detail);
}

function normalize(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null &&
    (typeof value !== 'string' || value.trim().length > 0);
}

// Yuque answers a document that was never written with markup that carries no
// text at all: "<p></p>", an empty Lake shell, or a lone zero-width space.
// Counting those as content exports blank files and inflates the report.
function isBlankMarkup(value: string): boolean {
  // Media and attachments are content even though they have no text.
  if (/<(?:img|video|audio|iframe|embed|object|canvas|svg|ne-(?:card|image|video|file|attachment))\b/i.test(value)) return false;
  if (/!\[[^\]]*\]\([^)]*\)/.test(value)) return false;
  const text = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
  return text.length === 0;
}

function textFields(detail: ContentDetail): ContentField[] {
  const html = [ normalize(detail.type), normalize(detail.format) ].some(value => value === 'html' || value === 'htmldoc');
  const native: ContentField[] = html ? [ 'body_html', 'body_lake' ] : [ 'body_lake', 'body_html' ];
  if (detail.status === 0) {
    return [ 'body_draft', 'body_draft_lake', 'body', ...native, 'exporter_markdown', 'body_sheet', 'body_table' ];
  }
  return [ ...(html ? [] : [ 'exporter_markdown' as const ]), 'body', ...native, 'body_draft', 'body_draft_lake', 'body_sheet', 'body_table' ];
}

function textExtension(content: string, source: ContentField, type: string, format: string): string {
  if (source === 'body_lake' || source === 'body_draft_lake') return '.lake';
  const text = content.trim().replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  // Yuque's compiled Lake document always opens with this prologue.
  if (/^<!doctype\s+lake\b|^<lake\b/i.test(text)) return '.lake';
  if (source === 'body_html') return '.html';
  // A complete HTML document is HTML even though Yuque writes "data-lake-*" and
  // "ne-*" attributes inside it; calling those files Lake produced documents no
  // editor could open. Bare Lake fragments still fall through to the markers.
  if (/^<!doctype\s+html\b|^<html\b/i.test(text)) return '.html';

  // Bare Lake fragments carry these markers without a document prologue. The
  // leading "<" keeps a Markdown document that merely shows a Lake example in a
  // fenced code block on the Markdown path.
  if (text.startsWith('<') && /<(?:lake|ne-[\w-]+)\b|\bdata-lake[\w-]*\s*=/i.test(text)) return '.lake';
  if (type === 'html' || type === 'htmldoc' || format === 'html' || format === 'htmldoc') return '.html';

  const htmlDocument = /^<!doctype\s+html\b|^<(?:html|head|body)\b/i.test(text);
  const htmlBlock = /^<(?:div|section|article|main|p|table|h[1-6]|ul|ol|pre|blockquote|details|figure|svg|script|style|iframe|span|strong|em|a|code|form|canvas|video|audio)\b/i.test(text) &&
    /<\/(?:div|section|article|main|p|table|h[1-6]|ul|ol|pre|blockquote|details|figure|svg|script|style|iframe|span|strong|em|a|code|form|canvas|video|audio)\s*>$/i.test(text);
  const htmlVoid = /^(?:<(?:img|hr|br|input|meta|link|source|embed|area|base|col|param|track|wbr)\b[^>]*\/?>\s*)+$/i.test(text);
  if (htmlDocument || htmlBlock || htmlVoid) return format === 'lake' ? '.lake' : '.html';
  return '.md';
}

function resolveStructured(detail: ContentDetail, kind: 'sheet' | 'table', fields: ContentField[]): ResolvedContent {
  const source: ContentField = kind === 'sheet' ? 'body_sheet' : 'body_table';
  if (hasContent(detail[source])) return structuredJSON(detail[source], source, kind);
  if (hasContent(detail.body)) {
    const result = structuredJSON(detail.body, 'body', kind);
    result.warnings.push(`${source} is unavailable; used the body field without merging representations.`);
    return result;
  }
  const raw = fields.filter(field => field !== source);
  if (raw.some(field => hasContent(detail[field]))) {
    return unsupportedRaw(detail, raw, `${source} is unavailable; alternate content requires a raw backup rather than a ${kind} conversion.`);
  }
  if (detail[source] === undefined || detail[source] === null) {
    return unavailable(`${source} is missing or null; ${kind} content cannot be verified.`, source);
  }
  return noContent(detail);
}

function structuredJSON(value: unknown, source: ContentField, kind: 'sheet' | 'table'): ResolvedContent {
  const content = rawString(value);
  try {
    if (typeof value === 'string') {
      JSON.parse(value);
    } else if (typeof value !== 'object' || value === null || !content) {
      throw new Error('Expected an object or a JSON string');
    } else {
      JSON.parse(content);
    }
    return { status: 'ready', content, extension: `.${kind}.json`, source, warnings: [] };
  } catch {
    return {
      status: 'unsupported',
      content,
      extension: '',
      source,
      warnings: [ `${source} is not valid JSON ${kind} content; retain the original detail and content as a raw backup.` ],
    };
  }
}

function rawString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) || '';
  } catch {
    // Non-JSON JavaScript values cannot come from a parsed API/cache response.
    return '';
  }
}

function unsupportedRaw(detail: ContentDetail, fields: ContentField[], warning: string): ResolvedContent {
  const source = fields.find(field => hasContent(detail[field])) || '';
  return {
    status: 'unsupported',
    content: source ? rawString(detail[source]) : '',
    extension: '',
    source,
    warnings: [ warning ],
  };
}

function noContent(detail: ContentDetail): ResolvedContent {
  if (typeof detail.word_count === 'number' && detail.word_count > 0) {
    return unavailable(`word_count is ${detail.word_count}, but no usable non-empty content field was returned.`, 'body');
  }
  if (typeof detail.body !== 'string') {
    return unavailable('body is missing or null and no usable alternate content field was returned.', 'body');
  }
  return { status: 'empty', content: '', extension: '', source: 'body', warnings: [] };
}

function unavailable(warning: string, source = ''): ResolvedContent {
  return { status: 'unsupported', content: '', extension: '', source, warnings: [ warning ] };
}
