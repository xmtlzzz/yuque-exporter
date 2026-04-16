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
  target: TargetConfig;
  get metaDir(): string;
}

export const config: Config = {
  host: 'https://www.yuque.com',
  token: process.env.YUQUE_TOKEN,
  userAgent: 'yuque-exporter',
  outputDir: './storage',
  clean: false,
  target: { repos: [] },
  get metaDir() {
    return path.join(config.outputDir, '.meta');
  },
};

export async function loadConfig(configPath?: string) {
  const defaultPath = path.resolve(process.cwd(), 'config.toml');
  const filePath = configPath || defaultPath;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const tomlConfig = toml.parse(content);
    
    if (tomlConfig.yuque) {
      const { host, token, outputDir, clean, target } = tomlConfig.yuque;
      if (host) config.host = host;
      if (token) config.token = token;
      if (outputDir) config.outputDir = outputDir;
      if (typeof clean === 'boolean') config.clean = clean;
      if (target) config.target = target;
    }
    
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

