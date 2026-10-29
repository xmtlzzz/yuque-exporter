// Token persistence for the desktop app.
//
// The environment variable stays authoritative (it is what the CLI uses), but a
// desktop user should not have to edit environment variables to get started, so
// the UI can save a token to a file in the user's config directory. The file is
// created with owner-only permissions where the platform supports it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'yuque-exporter',
);
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

export async function readSavedToken(): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function saveToken(token: string): Promise<void> {
  const value = token.trim();
  if (!value) throw new Error('Token is empty');
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, value, { encoding: 'utf8', mode: 0o600 });
}

export async function clearSavedToken(): Promise<void> {
  await fs.unlink(TOKEN_FILE).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}
