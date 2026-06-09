#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = join(root, 'node_modules', '@stacks');

if (!existsSync(scope)) process.exit(0);

let patched = 0;
for (const pkg of readdirSync(scope)) {
  const pkgDir = join(scope, pkg);
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    continue;
  }
  if (manifest.type === 'module') continue;

  const importTarget =
    manifest.exports?.['.']?.import ?? (typeof manifest.module === 'string' ? manifest.module : undefined);
  if (typeof importTarget !== 'string') continue;
  const m = importTarget.match(/^\.\/(.*\/esm)\//);
  if (!m) continue;

  const esmDir = join(pkgDir, m[1]);
  if (!existsSync(esmDir)) continue;
  const markerPath = join(esmDir, 'package.json');
  if (existsSync(markerPath)) continue;

  mkdirSync(esmDir, { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ type: 'module' }, null, 2) + '\n');
  patched += 1;
  process.stdout.write(`fix-esm-marker: marked @stacks/${pkg}/${m[1]} as ESM\n`);
}

if (patched === 0) process.stdout.write('fix-esm-marker: nothing to patch\n');
