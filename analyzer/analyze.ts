#!/usr/bin/env node
/**
 * analyze.ts — the analyzer CLI: run an adapter, compile its Snapshot, write
 * viewer/public/data.json (see DESIGN.md "Adapters" for the pipeline).
 */
import fs from 'node:fs';
import path from 'node:path';
import { compile } from './compile.js';
import { collectGit, type GitOptions } from './git.js';

const MAX_JSON_BYTES = 25 * 1024 * 1024;

interface Options extends GitOptions {
  out: string;
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

async function main(): Promise<void> {
  const started = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const { snapshot, summary } = await collectGit(opts);
  const data = compile(snapshot);

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const total = data.commits.length;
  let json = JSON.stringify(data);
  // Budget guard: trim the oldest commits until the payload fits.
  while (json.length > MAX_JSON_BYTES && data.commits.length > 1) {
    data.commits = data.commits.slice(0, Math.floor(data.commits.length * 0.8));
    json = JSON.stringify(data);
  }
  const droppedCommits = total - data.commits.length;
  fs.writeFileSync(outPath, json);

  const last = data.commits[data.commits.length - 1];
  const oldest = last ? last.ts : null;
  console.log(
    `files: ${data.files.length}\nedges: ${data.edges.length}\nprs: ${data.prs.length}\n` +
    `commits: ${data.commits.length}${droppedCommits ? ` (dropped ${droppedCommits} oldest for size)` : ''}` +
    `${oldest ? ` back to ${new Date(oldest * 1000).toISOString().slice(0, 10)}` : ''}\n` +
    summary.map((line) => line + '\n').join('') +
    `out: ${outPath} (${(json.length / 1e6).toFixed(2)} MB)\nelapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  const diff = data.diff;
  if (diff) {
    let v = 0, r = 0, n = 0;
    for (const f of diff.files) { v += f.verbatim; r += f.reshaped; n += f.new; }
    const adds = Math.max(v + r + n, 1);
    const pct = (x: number) => `${Math.round((100 * x) / adds)}%`;
    console.log(
      `diff scope: ${diff.files.length} files ${diff.base.slice(0, 7)}..${diff.head.slice(0, 7)}\n` +
      `  provenance +${adds} — verbatim ${v} (${pct(v)}) · reshaped ${r} (${pct(r)}) · new ${n} (${pct(n)})`
    );
  }
}

function parseArgs(argv: string[]): Options {
  let repoPath: string | null = null;
  let roots: string[] | null = null;
  let out = 'viewer/public/data.json';
  let prs = true;
  let quick = false;
  let diff: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--roots') roots = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--diff') {
      diff = argv[++i] ?? '';
      if (!diff || diff.startsWith('--')) throw new Error('--diff needs a range: --diff <base>..<head>');
    }
    else if (a === '--no-prs') prs = false;
    else if (a === '--quick') quick = true;
    else if (!a.startsWith('--')) repoPath = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!repoPath) repoPath = '.';
  // Default: the whole repo. A narrower scope is an explicit --roots choice —
  // a "helpful" packages/ heuristic silently hid sibling dirs like src/.
  if (!roots) roots = ['.'];
  return { repoPath, roots, out, prs, quick, diff };
}
