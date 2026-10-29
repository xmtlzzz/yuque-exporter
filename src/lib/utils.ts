import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import yaml from 'yaml';
import { Readable } from 'stream';
import { createTransport, drain } from './http.js';
import consola from 'consola';
import { config } from '../config.js';

export const logger = consola;

export function errorMessage(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  if (config.token) message = message.split(config.token).join('[redacted]');
  return message.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]');
}

export async function readJSON(p: string, isYAML = false) {
  const content = await fs.readFile(p, 'utf-8');
  return isYAML ? yaml.parse(content) : JSON.parse(content);
}

export async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function mkdir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

// Commit only complete files. A failed write leaves the previous export intact.
export async function writeFile(filePath: string, content: unknown) {
  const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2);
  if (data === undefined) throw new Error('Cannot write undefined content');
  await mkdir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, 'utf-8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}

export async function getRedirectLink(url: string, host: string) {
  const transport = createTransport();
  try {
    const response = await transport.request(new URL(url), {
      method: 'HEAD',
      timeout: config.timeout,
      // The Location header is the whole point of this call.
      followRedirects: false,
    });
    await drain(response);
    const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
    return location ? new URL(location, host).href : url;
  } finally {
    await transport.close();
  }
}

interface DownloadOptions {
  headers?: Record<string, string>;
  image?: boolean;
}

export async function download(url: string, filePath: string, opts: DownloadOptions = {}) {
  const transport = createTransport();
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(filePath));
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      try {
        const response = await transport.request(new URL(url), {
          headers: { 'User-Agent': config.userAgent, ...opts.headers },
          timeout: config.timeout,
        });
        if (response.statusCode !== 200) {
          await drain(response);
          if ([ 429, 502, 503, 504 ].includes(response.statusCode) && attempt < config.retries) {
            const delay = retryDelay(response.headers['retry-after'], attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          return url;
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (opts.image && /^(text\/|application\/json)/.test(contentType)) {
          await drain(response);
          return url;
        }
        await pipeline(Readable.from(response.stream()), createWriteStream(temporary));
        if ((await fs.stat(temporary)).size === 0) return url;
        await fs.rename(temporary, filePath);
        return filePath;
      } catch (error) {
        await fs.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
        if (attempt === config.retries) throw error;
        await new Promise(resolve => setTimeout(resolve, config.retryDelay * (2 ** attempt)));
      }
    }
    return url;
  } finally {
    await fs.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
    await transport.close();
  }
}

function retryDelay(value: string | string[] | undefined, attempt: number) {
  const header = Array.isArray(value) ? value[0] : value;
  const seconds = Number(header);
  const supplied = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 0;
  return Math.min(30000, Math.max(0, Number.isFinite(supplied) ? supplied : 0, config.retryDelay * (2 ** attempt)));
}
