#!/usr/bin/env node
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const outfile = 'dist/pox5.cjs';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'info',
});

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
