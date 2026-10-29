// Default entry point: run an export with the configured settings.
import path from 'path';
import { fileURLToPath } from 'url';

import { start } from './main.js';
import { errorMessage, logger } from './lib/utils.js';

try {
  await start();
} catch (error) {
  logger.error(errorMessage(error));
  process.exitCode = 1;
}

export { };
