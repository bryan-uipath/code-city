#!/usr/bin/env node
/**
 * duped-layer.mjs — the first layer producer: runs `duped report --json` (a
 * sibling tool that finds duplicated functions/types and identical files) and
 * writes a layer for `npm run analyze -- <repo> --layer <file>`.
 * Per file: v = duplicate findings it is part of; per pair: one edge, landing on
 * the first matched declaration's lines. `--base <ref>` keeps only pairs touching
 * the change (duped's own rule), for PR review. See DESIGN.md "Layers".
 *
 *   node scripts/duped-layer.mjs ~/code/repo [--base origin/main] > /tmp/duped.layer.json
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const base = flag('--base');
const repo = path.resolve(args[0] ?? '.');

// `--root repo` pins duped's path base to the analyzer's, so ids match the city's paths.
const report = JSON.parse(execFileSync('duped', [
  'report', repo, '--root', repo, '--json', '--top', '100000', ...(base ? ['--base', base] : []),
], { encoding: 'utf8', maxBuffer: 1 << 28 }));
const version = execFileSync('duped', ['--version'], { encoding: 'utf8' }).trim();
const rev = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const files = new Map(); // path -> { v, pairs, removable, partner }
const edges = [];
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
for (const g of report.groups ?? []) {
  const n = (g.findings ?? []).length;
  if (!n || g.a === g.b) continue;
  for (const [self, other] of [[g.a, g.b], [g.b, g.a]]) {
    const f = files.get(self) ?? { v: 0, pairs: 0, removable: 0, partner: other };
    f.v += n;
    f.pairs += 1;
    f.removable += g.removableLines ?? 0;
    files.set(self, f);
  }
  // The pair lands on its first finding that names lines on both sides (functions, types).
  const at = g.findings.find((x) => x.a?.line && x.b?.line);
  const top = g.findings[0];
  edges.push({
    a: g.a, b: g.b, v: n,
    ...(at ? { aLine: at.a.line, bLine: at.b.line } : {}),
    note: clip(`${g.detectors.join('+')}${g.tag ? ` (${g.tag})` : ''} · ${top.evidence}`, 400),
  });
}

const items = [...files].map(([id, f]) => ({
  id, v: f.v,
  note: clip(`${f.pairs} pair${f.pairs === 1 ? '' : 's'}${f.removable ? ` · ~${f.removable} removable lines` : ''} · e.g. with ${path.basename(f.partner)}`, 400),
}));
const failed = Object.entries(report.detectors ?? {}).filter(([, d]) => d.status === 'failed').map(([k]) => k);
if (failed.length) console.error(`warn: duped detectors failed: ${failed.join(', ')}`);
if (report.truncated) console.error('warn: duped truncated its report');

process.stdout.write(JSON.stringify({
  id: 'duped', label: base ? 'Duplication · diff' : 'Duplication', unit: 'findings',
  absent: base ? 'no duplicate touching the diff' : 'no duplicate found',
  source: { tool: version, rev }, items, edges,
}, null, 1) + '\n');
console.error(`duped layer: ${items.length} files, ${edges.length} pairs`);
