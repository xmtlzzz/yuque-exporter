#!/usr/bin/env node

// Marks this process as CLI-driven so importing main.js does not auto-start an
// export (the guard in main.ts would otherwise fire when bundled).
process.env.YUQUE_EXPORTER_CLI = '1';

import { parseArgs } from 'util';
import { start } from '../main.js';
import { errorMessage, logger } from '../lib/utils.js';
import { HELP_TEXT } from './help.js';
import { VERSION } from './version.js';

try {
  const argv = parseArgs({
    options: {
      token: { type: 'string' },
      host: { type: 'string' },
      outputDir: { type: 'string' },
      config: { type: 'string' },
      concurrency: { type: 'string' },
      retries: { type: 'string' },
      timeout: { type: 'string' },
      clean: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (argv.values.help) {
    console.log(HELP_TEXT);
  } else if (argv.values.version) {
    console.log(VERSION);
  } else {
    const { config: configPath, help, version, concurrency, retries, timeout, ...values } = argv.values;
    const [ command, ...remaining ] = argv.positionals;
    const mode = command === 'crawl' || command === 'build' ? command : 'export';
    const repos = mode === 'export' ? argv.positionals : remaining;
    await start({
      configPath,
      repos,
      mode,
      options: {
        ...values,
        ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
        ...(retries !== undefined ? { retries: Number(retries) } : {}),
        ...(timeout !== undefined ? { timeout: Number(timeout) } : {}),
      },
    });
  }
} catch (error) {
  logger.error(errorMessage(error));
  process.exitCode = 1;
}
