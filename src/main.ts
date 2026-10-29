import { build } from './lib/builder.js';
import { crawl } from './lib/crawler.js';
import { config, loadConfig, resetConfig, validateConfig } from './config.js';
import { createReport, IncompleteExportError, saveReport } from './lib/report.js';
import { errorMessage, logger } from './lib/utils.js';

export interface StartOptions {
  repos?: string[];
  options?: Partial<Omit<typeof config, 'metaDir'>>;
  configPath?: string;
  mode?: 'export' | 'crawl' | 'build';
}

export async function start({ repos, options, configPath, mode = 'export' }: StartOptions = {}) {
  resetConfig();
  await loadConfig(configPath);
  if (options) {
    for (const [ key, value ] of Object.entries(options)) {
      if (value !== undefined && key !== 'metaDir') config[key] = value;
    }
  }
  validateConfig(mode !== 'build');
  const targets = repos?.length ? repos : config.target.repos;
  const crawlResult = mode === 'build' ? undefined : await crawl(targets);
  let report;
  if (mode === 'crawl') {
    report = createReport();
    report.crawl = crawlResult;
    report.documents = crawlResult.failures.map(failure => ({ ...failure, status: 'failed' as const, files: [], warnings: [] }));
    await saveReport(report);
    logger.info(`Fetched ${crawlResult.downloaded}, reused ${crawlResult.cached}, failed ${crawlResult.failures.length}`);
  } else {
    report = await build(crawlResult ? crawlResult.repos : (targets?.length ? targets : undefined), crawlResult);
    logger.info(`Exported ${report.summary.exported}, empty ${report.summary.empty}, uncreated ${report.summary.uncreated}, unsupported ${report.summary.unsupported}, failed ${report.summary.failed}`);
    if (report.summary.warnings) logger.warn(`${report.summary.warnings} warning(s); see export-report.json`);
  }
  if (report.summary.failed || report.summary.unsupported) throw new IncompleteExportError(report);
  return report;
}

// This module only exports start(). The CLI and the bundled executable own the
// entry point, so importing it never triggers an export as a side effect. That
// side effect used to fire inside a bun-compiled binary, where import.meta.url
// has no on-disk path and the "am I the main module" check misfired.
