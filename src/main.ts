import { fileURLToPath } from 'url';

import { build } from './lib/builder.js';
import { crawl } from './lib/crawler.js';
import { config, loadConfig } from './config.js';

interface StartOptions {
  repos?: string[];
  options?: Partial<typeof config>;
}

export async function start({ repos, options }: StartOptions = {}) {
  const loaded = await loadConfig();
  
  if (options) {
    Object.assign(config, options);
  }
  
  const urlPaths = repos || config.target.repos;
  
  if (!urlPaths || urlPaths.length === 0) {
    console.log('No repos configured. Please add repos to config.toml or pass via CLI.');
    console.log('Example config.toml:');
    console.log(`
[target]
repos = ["atian25/blog", "your-name/other-repo"]
    `);
    return;
  }

  await crawl(urlPaths);
  await build();
}

if (import.meta.url.startsWith('file:')) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    await start();
  }
}
