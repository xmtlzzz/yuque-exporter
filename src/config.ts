import path from 'path';
import fs from 'fs/promises';
import toml from 'toml';

export interface TargetConfig {
  repos?: string[];
}

export interface Config {
  host: string;
  token: string | undefined;
  userAgent: string;
  outputDir: string;
  clean: boolean;
  concurrency: number;
  retries: number;
  retryDelay: number;
  timeout: number;
  preferYfm: boolean;
  target: TargetConfig;
  readonly metaDir: string;
}

const defaults = () => ({
  host: 'https://www.yuque.com',
  token: process.env.YUQUE_TOKEN,
  userAgent: 'yuque-exporter',
  outputDir: path.resolve('storage'),
  clean: false,
  concurrency: 4,
  retries: 3,
  retryDelay: 500,
  timeout: 30000,
  preferYfm: true,
  target: { repos: [] },
});

export const config: Config = {
  ...defaults(),
  get metaDir() {
    return path.join(config.outputDir, '.meta');
  },
};

export function resetConfig() {
  Object.assign(config, defaults());
}

export async function loadConfig(configPath?: string) {
  const filePath = path.resolve(configPath || 'config.toml');
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT' && !configPath) return false;
    throw error;
  }
  const parsed = toml.parse(content);
  if (parsed.yuque) {
    const values = parsed.yuque;
    for (const key of [ 'host', 'userAgent', 'clean', 'concurrency', 'retries', 'retryDelay', 'timeout', 'preferYfm' ]) {
      if (values[key] !== undefined) config[key] = values[key];
    }
    config.token = process.env.YUQUE_TOKEN || values.token || config.token;
    if (values.outputDir) config.outputDir = path.resolve(path.dirname(filePath), values.outputDir);
    if (values.target) config.target = values.target;
  }
  return true;
}

export function validateConfig(requireToken = true) {
  const url = new URL(config.host);
  if (![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password) {
    throw new Error('host must be an HTTP(S) URL without credentials');
  }
  config.host = config.host.replace(/\/+$/, '');
  config.outputDir = path.resolve(config.outputDir);
  for (const key of [ 'concurrency', 'timeout' ] as const) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of [ 'retries', 'retryDelay' ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  }
  if (!config.target || !Array.isArray(config.target.repos) || config.target.repos.some(repo => typeof repo !== 'string')) {
    throw new Error('yuque.target.repos must be an array of strings');
  }
  if (requireToken && !config.token) throw new Error('Set YUQUE_TOKEN, --token, or yuque.token in config.toml');
}
