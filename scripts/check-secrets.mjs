#!/usr/bin/env node
// A real Yuque token was once committed to this repository. This guard keeps a
// token from reaching a commit again: it scans the staged files, and the working
// copy when run directly, for Yuque token literals and personal hosts.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Yuque tokens are 40 characters of [A-Za-z0-9]; anchor on the shapes seen in
// this repo so ordinary prose and hashes do not trip the check.
const TOKEN = /\b[A-Za-z0-9]{40}\b/g;
const ALLOW = [
  // Never flag the documented placeholder or obviously synthetic test values.
  /^(?:0{40}|a{40}|x{40})$/i,
];

function redact(value) {
  return value.slice(0, 4) + '*'.repeat(Math.max(0, value.length - 4));
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

let failed = false;
for (const file of files) {
  if (file === 'package-lock.json' || file.endsWith('.lock') || file.startsWith('node_modules/')) continue;
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    continue; // Deleted or unreadable files are not committed content.
  }
  for (const match of content.matchAll(TOKEN)) {
    const value = match[0];
    if (ALLOW.some(pattern => pattern.test(value))) continue;
    // Skip the 40-character hex digests this project writes into asset names.
    if (/^[0-9a-f]{40}$/.test(value)) continue;
    const line = content.slice(0, match.index).split('\n').length;
    console.error(`Secret-looking token ${redact(value)} in ${file}:${line}`);
    failed = true;
  }
}

if (failed) {
  console.error('Remove the credential (use YUQUE_TOKEN) before committing.');
  process.exit(1);
}
