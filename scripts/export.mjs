#!/usr/bin/env node
// Static export: vite-build the viewer with the current data.json baked in.
// See DESIGN.md "Analyzer cache & static export".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(REPO, 'viewer/public/data.json');
const DIST = path.join(REPO, 'viewer/dist');

main();

function main() {
  if (!fs.existsSync(DATA)) {
    console.error('export: no viewer/public/data.json — run analyze first');
    process.exit(1);
  }

  execFileSync('npx', ['vite', 'build', 'viewer'], { cwd: REPO, stdio: 'inherit' });

  // vite copies public/ into the bundle; verify rather than assume.
  const index = path.join(DIST, 'index.html');
  const data = path.join(DIST, 'data.json');
  for (const required of [index, data]) {
    if (!fs.existsSync(required)) {
      console.error(`export: expected ${path.relative(REPO, required)} in the bundle`);
      process.exit(1);
    }
  }

  const { size } = fs.statSync(data);
  console.log(
    `\nexport: ${path.relative(REPO, DIST)} (data.json ${(size / 1e6).toFixed(2)} MB)\n` +
    'serve it (npx serve viewer/dist) or drop the folder on any static host — ' +
    'the source/diff panes hide themselves without the dev API.'
  );
}
