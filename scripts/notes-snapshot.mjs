#!/usr/bin/env node
/**
 * notes-snapshot.mjs — an example non-git producer: a folder of markdown notes
 * as a Snapshot JSON on stdout, for `npm run analyze -- --snapshot <file>`.
 * Mass = lines, sections = top-level headings, links = [[wikilinks]], and one
 * "edited" event per note at its mtime (no history, so each note lands as a
 * single slab). See DESIGN.md "Adapters".
 *
 *   node scripts/notes-snapshot.mjs ~/notes > /tmp/notes.snapshot.json
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const items = [{ id: '', parent: null, key: '', name: path.basename(root), kind: 'folder', mass: 0 }];
const notes = []; // { id, mtime, lines, wikis }

walk(root, '');

// [[target]] / [[target|label]] resolve by normalized basename, first match wins — as git.ts does.
const wikiNorm = (s) => s.toLowerCase().replace(/\s+/g, '-');
const byName = new Map();
for (const n of notes) {
  const base = wikiNorm(path.basename(n.id, '.md'));
  if (!byName.has(base)) byName.set(base, n.id);
}
const counts = new Map(); // "from\0to" -> n
for (const n of notes) {
  for (const name of n.wikis) {
    const to = byName.get(wikiNorm(name));
    if (!to || to === n.id) continue;
    const k = `${n.id}\0${to}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
}
const links = [...counts].map(([k, n]) => {
  const [from, to] = k.split('\0');
  return { from, to, n };
});

// Newest first, as the contract requires: the validator rejects any other order.
const events = notes
  .slice()
  .sort((a, b) => b.mtime - a.mtime)
  .map((n, i) => ({
    id: `edit-${i}`, ts: n.mtime, actor: 'notes', subject: `edited ${path.basename(n.id)}`,
    rework: false, touches: [{ item: n.id, adds: n.lines, dels: 0 }],
  }));

process.stdout.write(JSON.stringify({
  source: { name: path.basename(root), url: null },
  items, events, asOf: Math.floor(Date.now() / 1000), links, inflight: [],
}));

function walk(dir, id) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const childId = id ? `${id}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const at = items.length;
      items.push({ id: childId, parent: id, key: ent.name, name: ent.name, kind: 'folder', mass: 0 });
      walk(abs, childId);
      if (items.length === at + 1) items.pop(); // no notes inside: no empty plot
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split('\n').length;
      const { sections, wikis } = parse(text, lines);
      items.push({ id: childId, parent: id, key: ent.name, name: ent.name, kind: 'file', mass: lines, sections });
      notes.push({ id: childId, mtime: Math.floor(fs.statSync(abs).mtimeMs / 1000), lines, wikis });
    }
  }
}

/** Top-level headings (the shallowest depth present), each spanning to the next one, and [[wikilink]] names; fenced code skipped. */
function parse(text, total) {
  const heads = [];
  const wikis = [];
  let fence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ depth: m[1].length, name: m[2].slice(0, 300), line: i + 1 });
    for (const w of l.matchAll(/\[\[([^\]|#]+)/g)) if (w[1].trim()) wikis.push(w[1].trim());
  });
  const top = Math.min(...heads.map((h) => h.depth));
  const tops = heads.filter((h) => h.depth === top);
  const sections = tops.map((h, i) => {
    const end = (tops[i + 1]?.line ?? total + 1) - 1;
    return { name: h.name, kind: 'section', loc: Math.max(end - h.line + 1, 1), line: h.line, exported: true };
  });
  return { sections, wikis };
}
