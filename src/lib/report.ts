import { config } from '../config.js';
import { writeFile } from './utils.js';
import path from 'path';

export type ExportStatus = 'exported' | 'empty' | 'uncreated' | 'unsupported' | 'failed';

export interface ExportItem {
  namespace: string;
  slug?: string;
  title?: string;
  status: ExportStatus;
  files: string[];
  source?: string;
  warnings: string[];
  message?: string;
  preserved?: boolean;
}

export interface CrawlFailure {
  namespace: string;
  slug?: string;
  title?: string;
  message: string;
}

export interface CrawlResult {
  repos: string[];
  downloaded: number;
  cached: number;
  failures: CrawlFailure[];
}

export interface ExportReport {
  schemaVersion: 1;
  createdAt: string;
  outputDir: string;
  summary: Record<ExportStatus | 'warnings', number>;
  documents: ExportItem[];
  crawl?: CrawlResult;
}

export function createReport(): ExportReport {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    outputDir: config.outputDir,
    summary: { exported: 0, empty: 0, uncreated: 0, unsupported: 0, failed: 0, warnings: 0 },
    documents: [],
  };
}

export async function saveReport(report: ExportReport) {
  report.documents.sort((a, b) => `${a.namespace}/${a.slug || a.title || ''}`.localeCompare(`${b.namespace}/${b.slug || b.title || ''}`));
  for (const key of Object.keys(report.summary)) report.summary[key] = 0;
  for (const item of report.documents) {
    report.summary[item.status]++;
    report.summary.warnings += item.warnings.length;
  }
  await writeFile(path.join(config.outputDir, 'export-report.json'), report);
  return report;
}

export class IncompleteExportError extends Error {
  constructor(public report: ExportReport) {
    super(`Export incomplete: ${report.summary.failed} failed, ${report.summary.unsupported} unsupported. See export-report.json`);
    this.name = 'IncompleteExportError';
  }
}
